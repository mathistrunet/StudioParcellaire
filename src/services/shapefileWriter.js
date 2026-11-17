// src/services/shapefileWriter.js
//
// Écriture d'un shapefile de polygones (.shp, .shx, .dbf, .prj, .cpg) dans un ZIP.
//
// Écrit à la main plutôt qu'avec @mapbox/shp-write et dbf, qui produisaient des
// fichiers refusés par les lecteurs stricts (Assolia, outils ESRI) :
//   - le .shp finissait par 4 octets nuls comptés dans la longueur du fichier :
//     un lecteur qui lit jusqu'à la longueur annoncée y cherchait un enregistrement ;
//   - les anneaux gardaient le sens GeoJSON (extérieur anti-horaire), alors qu'un
//     shapefile veut l'extérieur dans le sens horaire et les trous à l'inverse ;
//     un lecteur ESRI voyait chaque parcelle comme un trou ;
//   - chaque champ numérique du .dbf était déclaré avec 3 décimales, quelles que
//     soient la définition et la valeur écrite ;
//   - le .prj était un WKT OGC (TOWGS84, AXIS, AUTHORITY) que les outils ESRI lisent mal.
// Le modèle suivi est l'« Export spécifique (SHP) » de Geofolia, qu'Assolia relit.

import JSZip from "jszip";

/** Lambert-93 en WKT ESRI, tel qu'écrit par Geofolia. */
export const LAMBERT_93_PRJ =
  'PROJCS["RGF93_Lambert_93",GEOGCS["GCS_RGF93_geographiques_dms",DATUM["D_RGF_1993",' +
  'SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],' +
  'UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],' +
  'PARAMETER["False_Easting",700000.0],PARAMETER["False_Northing",6600000.0],' +
  'PARAMETER["Central_Meridian",3.0],PARAMETER["Standard_Parallel_1",44.0],' +
  'PARAMETER["Standard_Parallel_2",49.0],PARAMETER["Latitude_Of_Origin",46.5],UNIT["Meter",1.0]]';

const SHAPE_POLYGON = 5;
const SHP_HEADER = 100;
const DBF_LDID_ANSI = 0x03; // « Windows ANSI » (page 1252), comme Geofolia

// ─── Encodage Windows-1252 ───────────────────────────────────────────────────

const CP1252_OVERRIDES = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Octets Windows-1252 d'un texte ; un caractère hors page devient « ? ». */
export function encodeCp1252(input) {
  const text = input == null ? "" : String(input).replace(/\u00A0/g, " ").normalize("NFC");
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (CP1252_OVERRIDES.has(code)) bytes.push(CP1252_OVERRIDES.get(code));
    else bytes.push(0x3f);
  }
  return bytes;
}

// ─── Géométrie ───────────────────────────────────────────────────────────────

/** Aire signée (formule du lacet) : positive si l'anneau tourne dans le sens anti-horaire. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum / 2;
}

function cleanRing(ring) {
  const points = (ring || [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [Number(p[0]), Number(p[1])]);
  if (points.length < 3) return null;
  const [fx, fy] = points[0];
  const [lx, ly] = points[points.length - 1];
  if (fx !== lx || fy !== ly) points.push([fx, fy]);
  return points.length >= 4 ? points : null;
}

/** Oriente l'anneau : sens horaire pour un extérieur, anti-horaire pour un trou. */
function orientRing(ring, clockwise) {
  const isClockwise = signedArea(ring) < 0;
  return isClockwise === clockwise ? ring : [...ring].reverse();
}

/** Anneaux d'un Polygon ou MultiPolygon, orientés selon la norme shapefile. */
export function shapefileRings(geometry) {
  if (!geometry) return [];
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates]
      : geometry.type === "MultiPolygon" ? geometry.coordinates
        : [];
  const rings = [];
  for (const polygon of polygons || []) {
    const outer = cleanRing(polygon?.[0]);
    if (!outer) continue;
    rings.push(orientRing(outer, true));
    for (const hole of polygon.slice(1)) {
      const inner = cleanRing(hole);
      if (inner) rings.push(orientRing(inner, false));
    }
  }
  return rings;
}

function ringsExtent(rings) {
  const ext = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < ext.xmin) ext.xmin = x;
      if (y < ext.ymin) ext.ymin = y;
      if (x > ext.xmax) ext.xmax = x;
      if (y > ext.ymax) ext.ymax = y;
    }
  }
  return ext;
}

function writeMainHeader(view, fileLengthBytes, extent) {
  view.setInt32(0, 9994, false);
  view.setInt32(24, fileLengthBytes / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, SHAPE_POLYGON, true);
  view.setFloat64(36, extent.xmin, true);
  view.setFloat64(44, extent.ymin, true);
  view.setFloat64(52, extent.xmax, true);
  view.setFloat64(60, extent.ymax, true);
  // Z et M : 0 (les octets 68 à 99 restent nuls).
}

/** Contenus .shp et .shx pour une liste de géométries déjà découpées en anneaux. */
function buildShpShx(ringsList) {
  const contentLengths = ringsList.map((rings) => {
    const points = rings.reduce((n, ring) => n + ring.length, 0);
    return 44 + 4 * rings.length + 16 * points;
  });
  const shpLength = SHP_HEADER + contentLengths.reduce((n, len) => n + 8 + len, 0);
  const shxLength = SHP_HEADER + 8 * ringsList.length;
  const shp = new DataView(new ArrayBuffer(shpLength));
  const shx = new DataView(new ArrayBuffer(shxLength));
  const extent = ringsExtent(ringsList.flat());
  writeMainHeader(shp, shpLength, extent);
  writeMainHeader(shx, shxLength, extent);

  let offset = SHP_HEADER;
  ringsList.forEach((rings, index) => {
    const contentLength = contentLengths[index];
    shx.setInt32(SHP_HEADER + index * 8, offset / 2, false);
    shx.setInt32(SHP_HEADER + index * 8 + 4, contentLength / 2, false);

    shp.setInt32(offset, index + 1, false);
    shp.setInt32(offset + 4, contentLength / 2, false);
    const c = offset + 8;
    const box = ringsExtent(rings);
    const points = rings.reduce((n, ring) => n + ring.length, 0);
    shp.setInt32(c, SHAPE_POLYGON, true);
    shp.setFloat64(c + 4, box.xmin, true);
    shp.setFloat64(c + 12, box.ymin, true);
    shp.setFloat64(c + 20, box.xmax, true);
    shp.setFloat64(c + 28, box.ymax, true);
    shp.setInt32(c + 36, rings.length, true);
    shp.setInt32(c + 40, points, true);
    let start = 0;
    rings.forEach((ring, r) => {
      shp.setInt32(c + 44 + r * 4, start, true);
      start += ring.length;
    });
    let p = c + 44 + rings.length * 4;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        shp.setFloat64(p, x, true);
        shp.setFloat64(p + 8, y, true);
        p += 16;
      }
    }
    offset += 8 + contentLength;
  });
  return { shp, shx };
}

// ─── DBF ─────────────────────────────────────────────────────────────────────

function fieldBytes(field, value) {
  const size = field.size;
  const out = new Array(size).fill(0x20);
  if (value == null || value === "") return out;
  switch (field.type) {
    case "N": {
      const number = Number(value);
      if (!Number.isFinite(number)) return out;
      const text = number.toFixed(field.decimal || 0);
      // Un nombre qui ne tient pas dans le champ est laissé vide plutôt que tronqué.
      if (text.length > size) return out;
      const start = size - text.length;
      for (let i = 0; i < text.length; i += 1) out[start + i] = text.charCodeAt(i);
      return out;
    }
    case "L":
      out[0] = value === true || /^(1|t|y|o|oui|true)$/i.test(String(value)) ? 0x54 : 0x46;
      return out;
    case "D": {
      const text = String(value).replace(/-/g, "").slice(0, 8);
      for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
      return out;
    }
    default: {
      const bytes = encodeCp1252(value).slice(0, size);
      bytes.forEach((b, i) => { out[i] = b; });
      return out;
    }
  }
}

function normalizeField(field) {
  const type = String(field.type || "C").toUpperCase();
  const size = type === "L" ? 1 : type === "D" ? 8 : Math.min(254, Math.max(1, field.size || 254));
  const decimal = type === "N" ? Math.max(0, Math.min(15, field.decimal || 0)) : 0;
  const name = String(field.name || "").slice(0, 10);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`DBF: nom de champ invalide « ${field.name} »`);
  return { name, type, size, decimal };
}

/** Table .dbf (dBase III, page Windows-1252) pour les lignes et champs donnés. */
export function buildDbf(rows, fieldDefs, date = new Date()) {
  const fields = fieldDefs.map(normalizeField);
  const headerLength = 32 + 32 * fields.length + 1;
  const recordLength = 1 + fields.reduce((n, f) => n + f.size, 0);
  const bytes = new Uint8Array(headerLength + recordLength * rows.length + 1);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, 0x03);
  view.setUint8(1, date.getFullYear() - 1900);
  view.setUint8(2, date.getMonth() + 1);
  view.setUint8(3, date.getDate());
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  view.setUint8(29, DBF_LDID_ANSI);
  fields.forEach((field, i) => {
    const base = 32 + i * 32;
    for (let c = 0; c < field.name.length; c += 1) bytes[base + c] = field.name.charCodeAt(c);
    bytes[base + 11] = field.type.charCodeAt(0);
    bytes[base + 16] = field.size;
    bytes[base + 17] = field.decimal;
  });
  bytes[headerLength - 1] = 0x0d;
  let offset = headerLength;
  for (const row of rows) {
    bytes[offset] = 0x20; // enregistrement non supprimé
    offset += 1;
    for (const field of fields) {
      bytes.set(fieldBytes(field, row?.[field.name]), offset);
      offset += field.size;
    }
  }
  bytes[offset] = 0x1a;
  return bytes;
}

// ─── Archive ─────────────────────────────────────────────────────────────────

function sanitizeBaseName(baseName) {
  const normalized = (baseName ?? "").toString().trim();
  if (!normalized) return "parcelles";
  const ascii = normalized
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^0-9A-Za-z _-]+/g, "")
    .replace(/\s+/g, "_");
  const safe = ascii.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "parcelles";
}

/**
 * Fichiers d'un shapefile de polygones. Les géométries sans anneau exploitable
 * sont écartées, avec leur ligne d'attributs.
 */
export function buildShapefileParts({ features, fields, prj = LAMBERT_93_PRJ }) {
  const kept = [];
  for (const feature of features || []) {
    const rings = shapefileRings(feature?.geometry);
    if (rings.length) kept.push({ rings, properties: feature.properties || {} });
  }
  if (!kept.length) throw new Error("SHAPE_ZIP: No polygon geometries to export");
  const { shp, shx } = buildShpShx(kept.map((k) => k.rings));
  const dbf = buildDbf(kept.map((k) => k.properties), fields);
  return { shp: shp.buffer, shx: shx.buffer, dbf: dbf.buffer, prj, cpg: "1252" };
}

export async function createShapefileZip({ features, baseName, fields, prj = LAMBERT_93_PRJ }) {
  if (!Array.isArray(features) || !features.length) {
    throw new Error("SHAPE_ZIP: No features to export");
  }
  const parts = buildShapefileParts({ features, fields, prj });
  const zip = new JSZip();
  const name = sanitizeBaseName(baseName);
  zip.file(`${name}.shp`, parts.shp, { binary: true });
  zip.file(`${name}.shx`, parts.shx, { binary: true });
  zip.file(`${name}.dbf`, parts.dbf, { binary: true });
  zip.file(`${name}.prj`, parts.prj);
  zip.file(`${name}.cpg`, parts.cpg);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

export function getSafeBaseName(input) {
  return sanitizeBaseName(input);
}
