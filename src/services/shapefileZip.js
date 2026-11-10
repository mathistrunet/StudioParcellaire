import shp from "shpjs";
import JSZip from "jszip";
import { toWgs84 } from "../utils/proj";
import { chooseDbfEncoding, cpgForEncoding, createRecoder } from "./dbfEncoding.js";

// Voir dbfEncoding.js : chaque .dbf est relu dans son vrai encodage
// (sinon « RAY-GRASS DÉROBÉE » arrivait avec des « � »).
export { detectDbfEncoding, resolveCpgEncoding, chooseDbfEncoding } from "./dbfEncoding.js";

/**
 * Écrit dans le ZIP un .cpg que shpjs comprend pour chaque .dbf non UTF-8.
 * Renvoie le buffer à parser et, pour les pages DOS, les correcteurs à
 * appliquer aux chaînes décodées, indexés par chemin sans extension.
 */
async function fixDbfEncodingInZip(buffer) {
  const recoders = new Map();
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { buffer, recoders }; // pas un ZIP lisible : shpjs remontera l'erreur
  }
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.dbf$/i.test(name)) continue;
    const base = name.slice(0, -4);
    const cpgName = Object.keys(zip.files).find(
      (n) => n.toLowerCase() === `${base}.cpg`.toLowerCase()
    );
    const cpgText = cpgName ? await zip.files[cpgName].async("string") : null;
    const dbfBytes = await zip.files[name].async("uint8array");
    const encoding = chooseDbfEncoding(dbfBytes, cpgText);
    if (!encoding) continue;
    if (cpgName) zip.remove(cpgName);
    zip.file(`${base}.cpg`, cpgForEncoding(encoding));
    const recoder = createRecoder(encoding);
    if (recoder) recoders.set(base.toLowerCase(), recoder);
    changed = true;
  }
  return {
    buffer: changed ? await zip.generateAsync({ type: "arraybuffer" }) : buffer,
    recoders,
  };
}

function recodeProperties(properties, recoder) {
  if (!properties) return properties;
  const out = {};
  for (const [key, value] of Object.entries(properties)) {
    out[recoder(key)] = typeof value === "string" ? recoder(value) : value;
  }
  return out;
}

/** Applique les correcteurs DOS aux propriétés des couches concernées. */
function applyRecoders(result, recoders) {
  if (!recoders.size || !result) return result;
  const collections = Array.isArray(result) ? result : [result];
  const single = recoders.size === 1 && collections.length === 1;
  for (const collection of collections) {
    const key = String(collection?.fileName ?? "").toLowerCase();
    const recoder = recoders.get(key) ?? (single ? [...recoders.values()][0] : null);
    if (!recoder || !Array.isArray(collection?.features)) continue;
    for (const feature of collection.features) {
      feature.properties = recodeProperties(feature.properties, recoder);
    }
  }
  return result;
}

function firstCoordinate(geometry) {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  if (!coordinates) return null;
  if (type === "Polygon") {
    return coordinates?.[0]?.[0] ?? null;
  }
  if (type === "MultiPolygon") {
    return coordinates?.[0]?.[0]?.[0] ?? null;
  }
  if (type === "LineString") {
    return coordinates?.[0] ?? null;
  }
  if (type === "MultiLineString") {
    return coordinates?.[0]?.[0] ?? null;
  }
  return null;
}

function shouldProject(features) {
  for (const feature of features) {
    const coord = firstCoordinate(feature?.geometry);
    if (!coord) continue;
    const [x, y] = coord;
    if (Math.abs(x) > 180 || Math.abs(y) > 90) {
      return true;
    }
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
      return false;
    }
  }
  return false;
}

function projectCoord([x, y], project) {
  if (!project) return [x, y];
  const [lon, lat] = toWgs84([x, y]);
  return [lon, lat];
}

function projectRing(ring, project) {
  return ring.map((coord) => projectCoord(coord, project));
}

function normalizeProperties(rawProps = {}) {
  const props = { ...rawProps };

  const codeExploit = rawProps.CODE_EXPLO ?? rawProps.code_explo ?? rawProps.code_exploitation;
  const nomParcelle = rawProps.NOM_PARCEL ?? rawProps.nom_parcel ?? rawProps.nom_parcelle;
  const cpCultu = rawProps.CP_CULTU ?? rawProps.cp_cultu ?? rawProps.code ?? rawProps.code_culture;
  const cultPrec = rawProps.CULT_PREC ?? rawProps.cult_prec ?? rawProps.culture_prec;
  const cultPrec2 = rawProps.CULT_PREC2 ?? rawProps.cult_prec2 ?? rawProps.culture_prec2;
  const typeSol = rawProps.TYPE_SOL ?? rawProps.type_sol;

  if (codeExploit != null) {
    props.code_exploitation = codeExploit;
  }
  if (nomParcelle != null) {
    props.nom_parcelle = nomParcelle;
    if (!props.nom_affiche) {
      props.nom_affiche = String(nomParcelle);
    }
  }

  if (cpCultu != null && cpCultu !== "") {
    const current = String(cpCultu).trim().toUpperCase();
    props.code = current;
    props.code_culture = current;
    props.CP_CULTU = current;
  }
  if (cultPrec != null && cultPrec !== "") {
    const prev = String(cultPrec).trim().toUpperCase();
    props.culture_prec = prev;
    props.CULT_PREC = prev;
  }
  if (cultPrec2 != null && cultPrec2 !== "") {
    const prev2 = String(cultPrec2).trim().toUpperCase();
    props.culture_prec2 = prev2;
    props.CULT_PREC2 = prev2;
  }
  if (typeSol != null) {
    props.type_sol = typeSol;
  }

  return props;
}

function toPolygonFeatures(feature, index, project) {
  if (!feature || !feature.geometry) return [];
  const props = normalizeProperties(feature.properties);

  const { geometry } = feature;
  if (geometry.type === "Polygon") {
    const coordinates = geometry.coordinates.map((ring) => projectRing(ring, project));
    return [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates },
        properties: props,
        id: feature.id ?? index,
      },
    ];
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygonCoords, polyIndex) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: polygonCoords.map((ring) => projectRing(ring, project)),
      },
      properties: { ...props, _multipolygon_index: polyIndex },
      id: feature.id != null ? `${feature.id}-${polyIndex}` : `${index}-${polyIndex}`,
    }));
  }

  return [];
}

export function normalizeShapefileGeoJSON(result) {
  if (!result) return [];

  const collections = [];
  if (Array.isArray(result)) {
    for (const entry of result) {
      if (entry?.type === "FeatureCollection") collections.push(entry);
    }
  } else if (result.type === "FeatureCollection") {
    collections.push(result);
  } else if (typeof result === "object") {
    for (const value of Object.values(result)) {
      if (value?.type === "FeatureCollection") collections.push(value);
    }
  }

  const features = [];
  const allFeatures = collections.flatMap((c) => c.features || []);
  const project = shouldProject(allFeatures);

  let counter = 0;
  collections.forEach((collection) => {
    (collection.features || []).forEach((feature) => {
      const polys = toPolygonFeatures(feature, counter, project);
      counter += 1;
      features.push(...polys);
    });
  });

  return features;
}

async function toArrayBuffer(input) {
  if (input == null) return null;
  if (input instanceof ArrayBuffer) return input;
  if (input.arrayBuffer) return input.arrayBuffer();
  if (input.buffer instanceof ArrayBuffer) return input.buffer;
  throw new Error("SHAPE_ZIP: Unsupported input type");
}

export async function parseShapefileZipToFeatures(fileOrBuffer) {
  const buffer = await toArrayBuffer(fileOrBuffer);
  if (!buffer) {
    throw new Error("SHAPE_ZIP: No data provided");
  }
  const fixed = await fixDbfEncodingInZip(buffer);
  const result = applyRecoders(await shp(fixed.buffer), fixed.recoders);
  const features = normalizeShapefileGeoJSON(result);
  if (!features.length) {
    throw new Error("SHAPE_ZIP: Aucune parcelle dans le shapefile");
  }
  return features;
}

export default parseShapefileZipToFeatures;
