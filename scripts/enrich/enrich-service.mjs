/**
 * Enrichissement d'une parcelle à partir d'un point ou d'un contour.
 *
 * Sans état : rien n'est lu ni écrit dans le parcellaire, rien n'est mis en cache. Les
 * accès externes sont injectés, ce qui garde le service indépendant du serveur HTTP.
 * Le contrat public est décrit dans docs/api/openapi-v1.json.
 */
import { RPG_AVAILABLE_YEARS, readRpgCultureCode } from "../../src/domain/rpg/rpgLayers.js";
import { featureAreaHa, featureCentroid } from "../../src/utils/geometry.js";
import { matchRpgFeature } from "./parcel-matching.mjs";
import { formatToponymName } from "./toponym-lookup.mjs";
import { WFS_ERROR_CODES, WfsError } from "./rpg-wfs-client.mjs";

export const ENRICH_STATUTS = Object.freeze(["ok", "partiel", "aucune_correspondance"]);
export const CULTURE_STATUTS = Object.freeze([
  "trouve",
  "aucune_correspondance",
  "millesime_indisponible",
  "erreur_wfs",
]);

const MAX_MILLESIMES = 15;
// Une parcelle ne couvre pas 10 km : au-delà, c'est une erreur de saisie, et la requête
// remonterait des milliers de parcelles pour rien.
const MAX_SPAN_DEGREES = 0.1;
// Marge autour d'un point (environ 1 m), le test exact étant fait localement.
const POINT_MARGIN_DEGREES = 0.00001;

export class EnrichValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnrichValidationError";
    this.code = code;
  }
}

export class EnrichUpstreamError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "EnrichUpstreamError";
    this.code = code;
    this.status = status;
  }
}

const invalidGeometry = (message) => new EnrichValidationError("GEOMETRIE_INVALIDE", message);

function assertPosition(position) {
  const [lon, lat] = Array.isArray(position) ? position : [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw invalidGeometry("Coordonnée invalide : attendu [longitude, latitude] en degrés.");
  }
}

function assertPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    throw invalidGeometry("Polygone sans anneau.");
  }
  for (const ring of polygon) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw invalidGeometry("Un anneau doit compter au moins 4 positions.");
    }
    ring.forEach(assertPosition);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw invalidGeometry("Un anneau doit être fermé (première et dernière positions identiques).");
    }
  }
}

function assertGeometry(geometry) {
  switch (geometry?.type) {
    case "Point":
      assertPosition(geometry.coordinates);
      return;
    case "Polygon":
      assertPolygon(geometry.coordinates);
      break;
    case "MultiPolygon":
      if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
        throw invalidGeometry("MultiPolygon vide.");
      }
      geometry.coordinates.forEach(assertPolygon);
      break;
    default:
      throw invalidGeometry("`geometry` doit être un Point, un Polygon ou un MultiPolygon GeoJSON.");
  }
  if (!(featureAreaHa({ geometry }) > 0)) {
    throw invalidGeometry("Le contour a une surface nulle.");
  }
}

function queryBbox(geometry) {
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    return [
      lon - POINT_MARGIN_DEGREES,
      lat - POINT_MARGIN_DEGREES,
      lon + POINT_MARGIN_DEGREES,
      lat + POINT_MARGIN_DEGREES,
    ];
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const position of polygons.flat(2)) {
    minLon = Math.min(minLon, position[0]);
    minLat = Math.min(minLat, position[1]);
    maxLon = Math.max(maxLon, position[0]);
    maxLat = Math.max(maxLat, position[1]);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Contrôle le corps de la requête et le normalise. Lève EnrichValidationError. */
export function validateEnrichRequest(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new EnrichValidationError("CORPS_INVALIDE", "Le corps doit être un objet JSON.");
  }
  const { geometry, millesimes, inclure_nom: inclureNom = true } = payload;

  assertGeometry(geometry);
  const [minLon, minLat, maxLon, maxLat] = queryBbox(geometry);
  if (maxLon - minLon > MAX_SPAN_DEGREES || maxLat - minLat > MAX_SPAN_DEGREES) {
    throw new EnrichValidationError(
      "GEOMETRIE_TROP_ETENDUE",
      `Le contour dépasse ${MAX_SPAN_DEGREES}° de côté : une seule parcelle est attendue.`
    );
  }

  if (
    !Array.isArray(millesimes) ||
    millesimes.length === 0 ||
    millesimes.length > MAX_MILLESIMES ||
    !millesimes.every(Number.isInteger)
  ) {
    throw new EnrichValidationError(
      "MILLESIMES_INVALIDES",
      `\`millesimes\` doit lister de 1 à ${MAX_MILLESIMES} années entières.`
    );
  }
  if (typeof inclureNom !== "boolean") {
    throw new EnrichValidationError("CORPS_INVALIDE", "`inclure_nom` doit être un booléen.");
  }

  return {
    geometry,
    millesimes: [...new Set(millesimes)].sort((a, b) => b - a),
    inclureNom,
  };
}

const textOrNull = (value) => {
  const text = value == null ? "" : String(value).trim();
  return text || null;
};

const readBio = (value) => {
  if (value === true || value === false) return value;
  const text = textOrNull(value)?.toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return null;
};

const readSurfaceHa = (feature) => {
  const declared = Number(feature.properties?.surf_parc);
  if (feature.properties?.surf_parc != null && Number.isFinite(declared)) return declared;
  const computed = featureAreaHa(feature);
  return computed == null ? null : Math.round(computed * 100) / 100;
};

async function resolveMillesime(year, geometry, bbox, fetchRpgFeatures) {
  if (!RPG_AVAILABLE_YEARS.includes(year)) {
    return { year, culture: { statut: "millesime_indisponible" }, avertissements: [] };
  }

  let result;
  try {
    result = await fetchRpgFeatures(year, bbox);
  } catch (error) {
    if (!(error instanceof WfsError)) throw error;
    return { year, culture: { statut: "erreur_wfs", erreur: error.code }, errorCode: error.code, avertissements: [] };
  }

  const avertissements = [];
  if (result.tronque) {
    avertissements.push({
      code: "RPG_TRONQUE",
      message: `RPG ${year} : réponse limitée par le WFS, la meilleure parcelle peut manquer.`,
    });
  }
  const { feature, recouvrement, calculsEchoues } = matchRpgFeature(geometry, result.features);
  if (calculsEchoues > 0) {
    avertissements.push({
      code: "INTERSECTION_PARTIELLE",
      message: `RPG ${year} : ${calculsEchoues} parcelle(s) n'ont pas pu être comparées au contour.`,
    });
  }
  if (!feature) return { year, culture: { statut: "aucune_correspondance" }, avertissements };

  const props = feature.properties || {};
  return {
    year,
    feature,
    avertissements,
    culture: {
      statut: "trouve",
      code: readRpgCultureCode(props),
      groupe: textOrNull(props.code_group),
      precision: textOrNull(props.precision),
      surface_ha: readSurfaceHa(feature),
      id_parcelle: textOrNull(props.id_parcel ?? props.num_parcel),
      recouvrement,
    },
  };
}

function resolveStatut(results) {
  const found = results.filter((result) => result.feature).length;
  const errors = results.filter((result) => result.errorCode);
  const queried = results.filter((result) => result.culture.statut !== "millesime_indisponible").length;

  // Aucun millésime n'a pu être lu : on ne sait rien, ce n'est pas une absence de parcelle.
  if (errors.length > 0 && errors.length === queried) {
    const allTimeouts = errors.every((result) => result.errorCode === WFS_ERROR_CODES.TIMEOUT);
    throw new EnrichUpstreamError(
      allTimeouts ? WFS_ERROR_CODES.TIMEOUT : "WFS_INDISPONIBLE",
      allTimeouts ? "Le WFS RPG n'a pas répondu à temps." : "Le WFS RPG est indisponible.",
      allTimeouts ? 504 : 502
    );
  }
  if (found === results.length) return "ok";
  if (found > 0 || errors.length > 0) return "partiel";
  return "aucune_correspondance";
}

async function resolveNom(geometry, surfaceHa, lookupToponym, avertissements) {
  const point = featureCentroid({ geometry });
  if (!point) return null;
  try {
    const baseName = await lookupToponym(point);
    if (!baseName) return null;
    return formatToponymName(baseName, surfaceHa ?? featureAreaHa({ geometry }));
  } catch (error) {
    avertissements.push({
      code: "TOPONYMIE_INDISPONIBLE",
      message: error?.message || "Toponymie indisponible.",
    });
    return null;
  }
}

/**
 * @param request Résultat de validateEnrichRequest.
 * @param deps.fetchRpgFeatures (année, emprise) => {features, tronque} ; lève WfsError.
 * @param deps.lookupToponym ([lon, lat]) => nom de base ou null.
 */
export async function enrichParcelle({ geometry, millesimes, inclureNom }, { fetchRpgFeatures, lookupToponym }) {
  const bbox = queryBbox(geometry);
  const results = await Promise.all(
    millesimes.map((year) => resolveMillesime(year, geometry, bbox, fetchRpgFeatures))
  );
  const statut = resolveStatut(results);

  const avertissements = results.flatMap((result) => result.avertissements);
  const cultures = Object.fromEntries(results.map((result) => [String(result.year), result.culture]));
  // `results` suit l'ordre décroissant des millésimes : le premier trouvé est le plus récent.
  const latest = results.find((result) => result.feature);
  const surfaceHa = latest ? latest.culture.surface_ha : null;
  // `bio` n'existe que dans certains schémas (2025 à ce jour) : ailleurs, c'est « inconnu ».
  const bio =
    results
      .filter((result) => result.feature)
      .map((result) => readBio(result.feature.properties?.bio))
      .find((value) => value !== null) ?? null;

  return {
    statut,
    contour: latest ? latest.feature.geometry : null,
    contour_millesime: latest ? latest.year : null,
    surface_ha: surfaceHa,
    nom: inclureNom ? await resolveNom(geometry, surfaceHa, lookupToponym, avertissements) : null,
    cultures,
    bio,
    irrigable: null,
    type_sol: null,
    avertissements,
  };
}
