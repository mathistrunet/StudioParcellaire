// Import unifié de parcellaire.
//
// Objectif : quel que soit le fichier fourni par l'utilisateur (export Télépac,
// shapefile, CSV, GeoJSON, KML/KMZ, GeoPackage), on aboutit à une liste de
// features polygonales en WGS84 prêtes à être injectées dans Mapbox Draw.
//
// Le format est déduit de l'extension puis, en dernier recours, du contenu :
// un utilisateur qui renomme son fichier ne doit pas se retrouver bloqué.

import proj4 from "proj4";
import JSZip from "jszip";

import { routeShapefileBufferToFeatures } from "./romaniaShapefileZip";
import { parseParcellesCsvToFeatures } from "./parcellesCsv";
import { parseGeoPackageBuffer } from "../utils/geopackage";
import { foldSecondaryParcels } from "../domain/parcelles/intercultures";

export const FORMAT_TELEPAC_XML = "telepac-xml";
export const FORMAT_SHAPEFILE_ZIP = "shapefile-zip";
export const FORMAT_CSV = "csv";
export const FORMAT_GEOJSON = "geojson";
export const FORMAT_KML = "kml";
export const FORMAT_KMZ = "kmz";
export const FORMAT_GEOPACKAGE = "gpkg";

/**
 * Formats proposés à l'utilisateur (guide, écran d'accueil, boîte d'import).
 *
 * Les descriptions énoncent aussi ce qui n'est PAS repris : une limite tue
 * moins de temps qu'un import qui aboutit à un parcellaire incomplet sans que
 * rien ne le signale.
 *
 * Règle commune à tous les formats : seules les surfaces sont conservées
 * (polygones et multipolygones), les points et lignes sont écartés.
 */
export const IMPORT_FORMATS = [
  {
    id: FORMAT_TELEPAC_XML,
    label: "XML Télépac",
    extensions: [".xml"],
    description: "Export de déclaration PAC (Télépac / MesParcelles).",
    limites: "Îlots et parcelles, avec leur culture déclarée.",
  },
  {
    id: FORMAT_SHAPEFILE_ZIP,
    label: "Shapefile",
    extensions: [".zip"],
    description: "Archive .zip contenant .shp, .dbf, .shx et .prj (ou dossier non zippé).",
    limites:
      "Lambert-93, Stéréo70 et Web Mercator sont reprojetés en WGS84 ; sans .prj, la projection est devinée d'après les coordonnées.",
  },
  {
    id: FORMAT_GEOJSON,
    label: "GeoJSON",
    extensions: [".geojson", ".json"],
    description: "FeatureCollection GeoJSON, en WGS84 ou en projection métrique.",
    limites: "Une Feature seule ou une géométrie nue sont également acceptées.",
  },
  {
    id: FORMAT_KML,
    label: "KML / KMZ",
    extensions: [".kml", ".kmz"],
    description: "Tracés Google Earth et exports d'outils de conseil.",
    limites:
      "Seuls les repères contenant un polygone sont repris ; les attributs viennent du nom et des ExtendedData.",
  },
  {
    id: FORMAT_GEOPACKAGE,
    label: "GeoPackage",
    extensions: [".gpkg"],
    description: "Base GeoPackage contenant une couche de parcelles.",
    limites: "Une seule couche est lue : la première table géométrique du fichier.",
  },
  {
    id: FORMAT_CSV,
    label: "CSV",
    extensions: [".csv"],
    description:
      "Tableau de parcelles avec une colonne de géométrie (Geometrie, geometry, geom, the_geom, wkt).",
    limites:
      "La cellule accepte « lon,lat lon,lat… », du WKT ou une géométrie GeoJSON. Seul le contour extérieur du premier polygone est repris.",
  },
];

/** Valeur de l'attribut `accept` du sélecteur de fichier. */
export const IMPORT_ACCEPT = IMPORT_FORMATS.flatMap((format) => format.extensions).join(",");

/** Libellé court listant les formats, pour les messages d'erreur. */
export const IMPORT_FORMATS_SUMMARY = IMPORT_FORMATS.map((format) => format.label).join(", ");

// ─── Projections ─────────────────────────────────────────────────────────────
// proj4 connaît EPSG:4326 et EPSG:3857 nativement ; les autres sont déclarées ici.
// EPSG:2154 l'est déjà par utils/proj.js mais on la redéfinit pour ne pas dépendre
// de l'ordre d'import des modules.

proj4.defs(
  "EPSG:2154",
  "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 " +
    "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
);
// Stereo70 : projection officielle du parcellaire roumain (datum shift indispensable).
proj4.defs(
  "EPSG:31700",
  "+proj=sterea +lat_0=46 +lon_0=25 +k=0.99975 +x_0=500000 +y_0=500000 " +
    "+ellps=krass +towgs84=33.4,-146.6,-76.3,-0.359,-0.053,0.844,-0.84 +units=m +no_defs"
);

const SUPPORTED_EPSG = new Set(["EPSG:4326", "EPSG:3857", "EPSG:2154", "EPSG:31700"]);

/** Extrait un code EPSG d'une chaîne du type "urn:ogc:def:crs:EPSG::2154". */
export function normalizeEpsgCode(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? `EPSG:${raw}` : null;
  const text = String(raw).trim();
  if (!text) return null;
  if (/^CRS84$/i.test(text) || /CRS:?84/i.test(text)) return "EPSG:4326";
  const match = text.match(/(\d{4,6})\s*$/);
  if (!match) return null;
  return `EPSG:${Number.parseInt(match[1], 10)}`;
}

/**
 * Devine la projection à partir de l'ordre de grandeur des coordonnées.
 * Renvoie null si les coordonnées sont déjà des degrés WGS84.
 */
export function guessProjection(sampleCoordinates) {
  const points = sampleCoordinates.filter(
    (point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])
  );
  if (!points.length) return null;

  const looksLikeDegrees = points.every(
    ([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90
  );
  if (looksLikeDegrees) return null;

  const [x, y] = points[0];
  const ax = Math.abs(x);
  const ay = Math.abs(y);

  // Lambert-93 : x ≈ 0–1 300 000, y ≈ 6 000 000–7 200 000. Ce domaine recoupe
  // partiellement le Web Mercator au-dessus de la France ; le Lambert-93 étant
  // la projection quasi systématique des parcellaires français, il l'emporte.
  // Un CRS explicitement déclaré dans le fichier prime de toute façon sur cette
  // détection.
  if (ax < 1_400_000 && ay > 5_800_000 && ay < 7_400_000) return "EPSG:2154";
  // Stereo70 : les deux axes tournent autour de 200 000–800 000.
  if (ax > 100_000 && ax < 900_000 && ay > 100_000 && ay < 900_000) return "EPSG:31700";
  // Web Mercator : tout ce qui reste dans l'emprise mondiale projetée.
  if (ax <= 20_037_509 && ay <= 20_037_509) return "EPSG:3857";
  return null;
}

const projectPosition = (position, from) => {
  const [x, y, ...rest] = position;
  const [lon, lat] = proj4(from, "EPSG:4326", [Number(x), Number(y)]);
  return rest.length ? [lon, lat, ...rest] : [lon, lat];
};

const mapGeometryCoordinates = (geometry, project) => {
  if (!geometry) return geometry;
  const walk = (coords, depth) => {
    if (depth === 0) return project(coords);
    return coords.map((item) => walk(item, depth - 1));
  };
  const depthByType = {
    Point: 0,
    MultiPoint: 1,
    LineString: 1,
    MultiLineString: 2,
    Polygon: 2,
    MultiPolygon: 3,
  };
  if (geometry.type === "GeometryCollection") {
    return {
      ...geometry,
      geometries: (geometry.geometries || []).map((item) =>
        mapGeometryCoordinates(item, project)
      ),
    };
  }
  const depth = depthByType[geometry.type];
  if (depth == null || !Array.isArray(geometry.coordinates)) return geometry;
  return { ...geometry, coordinates: walk(geometry.coordinates, depth) };
};

/** Collecte quelques positions représentatives pour deviner la projection. */
function sampleGeometryPositions(features, max = 8) {
  const samples = [];
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (!geometry) continue;
    const stack = [geometry.coordinates];
    while (stack.length && samples.length < max) {
      const current = stack.pop();
      if (!Array.isArray(current)) continue;
      if (Number.isFinite(current[0]) && Number.isFinite(current[1])) {
        samples.push(current);
      } else {
        for (const item of current) stack.push(item);
      }
    }
    if (samples.length >= max) break;
  }
  return samples;
}

/**
 * Reprojette une liste de features vers WGS84.
 * `declaredCrs` (facultatif) prime sur la détection automatique.
 */
export function reprojectFeaturesToWgs84(features, declaredCrs = null) {
  const declared = normalizeEpsgCode(declaredCrs);
  const detected =
    declared && SUPPORTED_EPSG.has(declared)
      ? declared
      : guessProjection(sampleGeometryPositions(features));

  if (!detected || detected === "EPSG:4326") return features;

  return features.map((feature) => ({
    ...feature,
    geometry: mapGeometryCoordinates(feature.geometry, (position) =>
      projectPosition(position, detected)
    ),
  }));
}

// ─── Normalisation ───────────────────────────────────────────────────────────

const POLYGON_TYPES = new Set(["Polygon", "MultiPolygon"]);

/** Extrait une année (1990-2100) du nom de fichier, sinon null. */
export function yearFromFilename(name) {
  const matches = String(name || "").match(/(?:19|20)\d{2}/g);
  if (!matches?.length) return null;
  const year = Number.parseInt(matches[0], 10);
  return year >= 1990 && year <= 2100 ? year : null;
}

/**
 * Ne conserve que les polygones, garantit un objet `properties` et pose l'année
 * quand elle est déductible du nom de fichier. Les géométries non surfaciques
 * (points de repère, lignes) sont ignorées silencieusement : elles ne
 * constituent pas des parcelles.
 *
 * Une seconde culture exportée comme une parcelle à part (« Parcelle secondaire »
 * de Geofolia, dérobée) est repliée sur sa parcelle principale, dont elle devient
 * l'interculture : sinon deux parcelles se superposent.
 */
export function normalizeImportedFeatures(features, { sourceName = "", year = null } = {}) {
  const resolvedYear = year ?? yearFromFilename(sourceName);
  const polygons = (features || []).filter((feature) => POLYGON_TYPES.has(feature?.geometry?.type));
  return foldSecondaryParcels(polygons).features
    .map((feature) => {
      const properties = { ...(feature.properties || {}) };
      if (resolvedYear != null && properties.annee == null) {
        properties.annee = resolvedYear;
      }
      return { ...feature, type: "Feature", properties };
    });
}

// ─── GeoJSON ─────────────────────────────────────────────────────────────────

/** Accepte une FeatureCollection, une Feature seule ou une géométrie nue. */
export function geoJsonToFeatures(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (payload.type === "FeatureCollection") {
    return Array.isArray(payload.features) ? payload.features : [];
  }
  if (payload.type === "Feature") return [payload];
  if (payload.type === "GeometryCollection") {
    return (payload.geometries || []).map((geometry) => ({
      type: "Feature",
      geometry,
      properties: {},
    }));
  }
  if (typeof payload.type === "string" && payload.coordinates) {
    return [{ type: "Feature", geometry: payload, properties: {} }];
  }
  return [];
}

export function parseGeoJsonTextToFeatures(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("GEOJSON_INVALIDE");
  }
  const declaredCrs =
    payload?.crs?.properties?.name ?? payload?.crs?.properties?.href ?? null;
  const features = geoJsonToFeatures(payload);
  if (!features.length) throw new Error("GEOJSON_SANS_ENTITE");
  return reprojectFeaturesToWgs84(features, declaredCrs);
}

// ─── KML / KMZ ───────────────────────────────────────────────────────────────

const kmlText = (node, tag) => {
  const el = node?.getElementsByTagName?.(tag)?.[0];
  return el?.textContent?.trim() || "";
};

/** "lon,lat,alt lon,lat,alt …" → [[lon, lat], …] */
function parseKmlCoordinates(raw) {
  return String(raw || "")
    .trim()
    .split(/\s+/)
    .map((chunk) => {
      const [lon, lat] = chunk.split(",").map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    })
    .filter(Boolean);
}

function kmlPolygonToCoordinates(polygonNode) {
  const readRing = (containerTag) =>
    Array.from(polygonNode.getElementsByTagName(containerTag)).map((container) =>
      parseKmlCoordinates(kmlText(container, "coordinates"))
    );

  const outer = readRing("outerBoundaryIs").filter((ring) => ring.length >= 4);
  if (!outer.length) return null;
  const inner = readRing("innerBoundaryIs").filter((ring) => ring.length >= 4);
  return [outer[0], ...inner];
}

function kmlPlacemarkProperties(placemark) {
  const properties = {};
  const name = kmlText(placemark, "name");
  if (name) {
    properties.nom_parcelle = name;
    properties.nom_affiche = name;
  }
  const description = kmlText(placemark, "description");
  if (description) properties.description = description;

  Array.from(placemark.getElementsByTagName("SimpleData")).forEach((node) => {
    const key = node.getAttribute("name");
    if (key) properties[key] = node.textContent?.trim() ?? "";
  });
  Array.from(placemark.getElementsByTagName("Data")).forEach((node) => {
    const key = node.getAttribute("name");
    if (key) properties[key] = kmlText(node, "value");
  });

  return properties;
}

export function parseKmlTextToFeatures(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("KML_INVALIDE");

  const features = [];
  Array.from(doc.getElementsByTagName("Placemark")).forEach((placemark) => {
    const polygons = Array.from(placemark.getElementsByTagName("Polygon"))
      .map(kmlPolygonToCoordinates)
      .filter(Boolean);
    if (!polygons.length) return;

    const properties = kmlPlacemarkProperties(placemark);
    const geometry =
      polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };
    features.push({ type: "Feature", geometry, properties });
  });

  if (!features.length) throw new Error("KML_SANS_POLYGONE");
  return features;
}

export async function parseKmzToFeatures(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = Object.keys(zip.files).find(
    (name) => !zip.files[name].dir && name.toLowerCase().endsWith(".kml")
  );
  if (!entry) throw new Error("KMZ_SANS_KML");
  return parseKmlTextToFeatures(await zip.files[entry].async("string"));
}

// ─── GeoPackage ──────────────────────────────────────────────────────────────

export async function parseGeoPackageFileToFeatures(buffer) {
  const collection = await parseGeoPackageBuffer(buffer);
  const features = collection?.features || [];
  if (!features.length) throw new Error("GPKG_SANS_ENTITE");
  // utils/geopackage reprojette déjà depuis le SRS déclaré quand il le connaît ;
  // la passe ci-dessous rattrape les SRS qu'il laisse tels quels.
  return reprojectFeaturesToWgs84(features);
}

// ─── Détection de format ─────────────────────────────────────────────────────

const EXTENSION_TO_FORMAT = {
  ".xml": FORMAT_TELEPAC_XML,
  ".zip": FORMAT_SHAPEFILE_ZIP,
  ".csv": FORMAT_CSV,
  ".geojson": FORMAT_GEOJSON,
  ".json": FORMAT_GEOJSON,
  ".kml": FORMAT_KML,
  ".kmz": FORMAT_KMZ,
  ".gpkg": FORMAT_GEOPACKAGE,
};

export function detectParcellaireFormat(fileName) {
  const name = String(fileName || "").toLowerCase();
  const extension = Object.keys(EXTENSION_TO_FORMAT).find((ext) => name.endsWith(ext));
  return extension ? EXTENSION_TO_FORMAT[extension] : null;
}

/** Détection de secours par signature binaire, quand l'extension est absente/erronée. */
export function detectFormatFromBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const [b0, b1, b2, b3] = bytes;
  // "PK\x03\x04" : archive zip (shapefile zippé, KMZ, …)
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return FORMAT_SHAPEFILE_ZIP;
  // "SQLite format 3\0"
  const header = String.fromCharCode(...bytes.slice(0, 15));
  if (header === "SQLite format 3") return FORMAT_GEOPACKAGE;
  const start = String.fromCharCode(...bytes.slice(0, 200)).trimStart();
  if (start.startsWith("{")) return FORMAT_GEOJSON;
  if (/^<\?xml/i.test(start)) {
    return /<kml[\s>]/i.test(start) ? FORMAT_KML : FORMAT_TELEPAC_XML;
  }
  return null;
}

// ─── Point d'entrée ──────────────────────────────────────────────────────────

const readAsText = (file, encoding = "UTF-8") =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file, encoding);
  });

/**
 * Lit un fichier de parcellaire et renvoie les features polygonales en WGS84.
 *
 * @param {File} file fichier choisi par l'utilisateur
 * @param {object} handlers
 * @param {(file: File) => Promise<Array|null>} handlers.onTelepacXml traitement
 *   du XML Télépac, délégué à l'appelant car il nécessite un dialogue
 *   (choix de la colonne de culture). Renvoyer null annule l'import.
 * @returns {Promise<Array|null>} features, ou null si l'utilisateur a annulé.
 */
export async function parseParcellaireFileToFeatures(file, { onTelepacXml } = {}) {
  if (!file) return null;

  let format = detectParcellaireFormat(file.name);
  if (!format) {
    const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
    format = detectFormatFromBytes(head);
  }
  if (!format) throw new Error("FORMAT_INVALIDE");

  // Un .zip peut aussi être un KMZ mal nommé : on lève le doute sur le contenu.
  if (format === FORMAT_SHAPEFILE_ZIP && file.name.toLowerCase().endsWith(".kmz")) {
    format = FORMAT_KMZ;
  }

  switch (format) {
    case FORMAT_TELEPAC_XML: {
      if (typeof onTelepacXml !== "function") throw new Error("FORMAT_INVALIDE");
      const features = await onTelepacXml(file);
      return features == null ? null : normalizeImportedFeatures(features);
    }
    case FORMAT_SHAPEFILE_ZIP: {
      const features = await routeShapefileBufferToFeatures(await file.arrayBuffer());
      return normalizeImportedFeatures(features, { sourceName: file.name });
    }
    case FORMAT_CSV: {
      const features = await parseParcellesCsvToFeatures(file);
      return normalizeImportedFeatures(features, { sourceName: file.name });
    }
    case FORMAT_GEOJSON: {
      const features = parseGeoJsonTextToFeatures(await readAsText(file));
      return normalizeImportedFeatures(features, { sourceName: file.name });
    }
    case FORMAT_KML: {
      const features = parseKmlTextToFeatures(await readAsText(file));
      return normalizeImportedFeatures(features, { sourceName: file.name });
    }
    case FORMAT_KMZ: {
      const features = await parseKmzToFeatures(await file.arrayBuffer());
      return normalizeImportedFeatures(features, { sourceName: file.name });
    }
    case FORMAT_GEOPACKAGE: {
      const features = await parseGeoPackageFileToFeatures(await file.arrayBuffer());
      return normalizeImportedFeatures(features, { sourceName: file.name });
    }
    default:
      throw new Error("FORMAT_INVALIDE");
  }
}

/** Message utilisateur associé à une erreur d'import. */
export function importErrorMessage(error) {
  switch (error?.message) {
    case "FORMAT_INVALIDE":
      return `Ce format de fichier n'est pas reconnu. Formats acceptés : ${IMPORT_FORMATS_SUMMARY}.`;
    case "IMPORT_VIDE":
      return "Le fichier a été lu mais ne contient aucune parcelle (aucun polygone exploitable).";
    case "CARTE_NON_PRETE":
      return (
        "La carte n'a pas fini de se charger : le parcellaire n'a pas pu être ajouté. " +
        "Attendez que le fond de carte s'affiche, puis relancez l'import."
      );
    case "GEOJSON_INVALIDE":
      return "Le fichier GeoJSON est illisible : le contenu n'est pas du JSON valide.";
    case "GEOJSON_SANS_ENTITE":
      return "Ce GeoJSON ne contient aucune entité.";
    case "KML_INVALIDE":
      return "Le fichier KML est illisible (XML invalide).";
    case "KML_SANS_POLYGONE":
      return "Ce KML ne contient aucun polygone : seules les surfaces peuvent devenir des parcelles.";
    case "KMZ_SANS_KML":
      return "Cette archive KMZ ne contient pas de fichier KML.";
    case "GPKG_SANS_ENTITE":
      return "Ce GeoPackage ne contient aucune entité dans sa couche géométrique.";
    default:
      return (
        "Impossible de lire ce fichier. " +
        `Vérifiez qu'il s'agit bien d'un parcellaire (${IMPORT_FORMATS_SUMMARY}).`
      );
  }
}
