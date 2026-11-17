// src/domain/toponymie/nearestToponym.js
// Choix du toponyme d'une parcelle, partagé entre le navigateur et le serveur.

import departementsMeta from "../../data/departements_meta.json" with { type: "json" };

const META_ENTRIES = Object.entries(departementsMeta || {});
const GRAPHIE_FIELDS = [
  "graphie",
  "GRAPHIE",
  "Graphie",
  "toponyme",
  "TOPONYME",
  "libelle",
  "LIBELLE",
  "nom",
  "NOM",
];

export function findDepartmentForPoint([lon, lat]) {
  for (const [code, meta] of META_ENTRIES) {
    const bbox = meta?.bbox;
    if (!bbox || bbox.length !== 4) continue;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
      return code;
    }
  }
  return null;
}

export function extractGraphie(properties) {
  if (!properties) return null;
  for (const field of GRAPHIE_FIELDS) {
    const raw = properties[field];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value) return value;
  }
  return null;
}

function approximateDistance2Meters(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const rad = Math.PI / 180;
  const avgLatRad = ((lat1 + lat2) / 2) * rad;
  const x = (lon2 - lon1) * Math.cos(avgLatRad) * 111320;
  const y = (lat2 - lat1) * 110540;
  return x * x + y * y;
}

export function findNearestToponym(points, target) {
  if (!Array.isArray(points) || !points.length) return null;
  let best = null;
  let bestDistance = Infinity;
  points.forEach((point) => {
    const coords = point?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const distance = approximateDistance2Meters(coords, target);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  });
  return best;
}
