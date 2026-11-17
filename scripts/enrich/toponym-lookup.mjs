/** Nom de lieu le plus proche d'un point, lu dans les couches de toponymie locales. */
import { resolveToponymNames } from "../../src/features/toponymieNameFormatting.js";
import {
  extractGraphie,
  findDepartmentForPoint,
  findNearestToponym,
} from "../../src/domain/toponymie/nearestToponym.js";
import { DEPARTMENT_TO_TOPONYMIE_REGION, TOPONYMIE_FILES } from "../../src/domain/toponymie/regions.js";

const SEARCH_PADDING_DEGREES = 0.02;
const MAX_POINTS = 15_000;

/** Même règle de nommage que le remplissage de l'interface, pour une parcelle seule. */
export function formatToponymName(baseName, areaHa) {
  return resolveToponymNames([{ key: "parcelle", baseName, areaHa }]).get("parcelle") ?? null;
}

export function createToponymLookup({ ensureLayer, queryGeoPackageByBbox, timeoutMs = 20_000 }) {
  async function lookup([lon, lat]) {
    const department = findDepartmentForPoint([lon, lat]);
    const fileName = TOPONYMIE_FILES[DEPARTMENT_TO_TOPONYMIE_REGION[department]];
    if (!fileName) return null;

    const filePath = await ensureLayer("TOPONYMIE", fileName);
    if (!filePath) return null;

    const collection = await queryGeoPackageByBbox({
      filePath,
      bbox: [
        lon - SEARCH_PADDING_DEGREES,
        lat - SEARCH_PADDING_DEGREES,
        lon + SEARCH_PADDING_DEGREES,
        lat + SEARCH_PADDING_DEGREES,
      ],
      maxFeatures: MAX_POINTS,
      geometryTypes: new Set(["Point"]),
    });
    const points = collection.features.map((feature) => ({
      coordinates: feature.geometry?.coordinates,
      properties: feature.properties,
    }));
    return extractGraphie(findNearestToponym(points, [lon, lat])?.properties);
  }

  // La couche peut devoir être téléchargée au premier usage : le nom ne doit pas retenir
  // la réponse, le téléchargement se poursuit pour les appels suivants.
  return function lookupToponym(point) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Toponymie : délai dépassé.")), timeoutMs);
    });
    return Promise.race([lookup(point), timeout]).finally(() => clearTimeout(timer));
  };
}
