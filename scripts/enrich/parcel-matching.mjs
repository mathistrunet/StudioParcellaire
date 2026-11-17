/**
 * Choix de la parcelle RPG correspondant à un point ou à un contour.
 *
 * Un contour n'est jamais réduit à son centroïde : celui d'une parcelle concave peut
 * tomber chez le voisin. On retient la parcelle RPG de plus grande intersection de
 * surface.
 */
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import polygonClipping from "polygon-clipping";
import { featureAreaM2, polygonAreaM2 } from "../../src/utils/geometry.js";

/**
 * Part minimale de recouvrement pour retenir une parcelle, rapportée à la plus petite
 * des deux surfaces. Elle écarte le voisin effleuré par un contour imprécis quand la
 * parcelle n'est pas au RPG, sans rejeter un petit contour dans une grande parcelle RPG,
 * ni un grand contour qui contient une petite parcelle RPG.
 */
export const MIN_OVERLAP_RATIO = 0.2;

const toMultiPolygon = (geometry) => {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
};

const isSurface = (geometry) => geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";

function matchPoint(point, features) {
  const feature = features.find(
    (candidate) => isSurface(candidate?.geometry) && booleanPointInPolygon(point, candidate)
  );
  return { feature: feature ?? null, recouvrement: null, calculsEchoues: 0 };
}

function matchContour(geometry, features) {
  const contour = toMultiPolygon(geometry);
  const contourArea = featureAreaM2({ geometry });
  let best = null;
  let bestArea = 0;
  let calculsEchoues = 0;

  for (const candidate of features) {
    if (!isSurface(candidate?.geometry)) continue;
    let overlap;
    try {
      overlap = polygonClipping
        .intersection(contour, toMultiPolygon(candidate.geometry))
        .reduce((sum, polygon) => sum + polygonAreaM2(polygon), 0);
    } catch {
      // Géométrie que le découpage ne sait pas traiter : on le signale sans bloquer les autres.
      calculsEchoues += 1;
      continue;
    }
    if (overlap > bestArea) {
      best = candidate;
      bestArea = overlap;
    }
  }

  if (!best) return { feature: null, recouvrement: null, calculsEchoues };
  const smallest = Math.min(contourArea, featureAreaM2(best));
  if (!(smallest > 0) || bestArea / smallest < MIN_OVERLAP_RATIO) {
    return { feature: null, recouvrement: null, calculsEchoues };
  }
  return {
    feature: best,
    recouvrement: Math.min(1, Math.round((bestArea / contourArea) * 1000) / 1000),
    calculsEchoues,
  };
}

/**
 * @returns {{feature: object|null, recouvrement: number|null, calculsEchoues: number}}
 *   `recouvrement` : part du contour fourni couverte par la parcelle (null pour un point).
 */
export function matchRpgFeature(geometry, features) {
  return geometry.type === "Point"
    ? matchPoint(geometry.coordinates, features)
    : matchContour(geometry, features);
}
