// src/services/rpg.js
// Appel WFS GEOPF (RPG) + utilitaires libellé culture

import { labelFromCode } from "../utils/cultureLabels";
import { RPG_WFS_BASE, getRpgTypeName, readRpgCultureCode } from "../domain/rpg/rpgLayers.js";

export { getRpgTypeName };

export async function fetchRpgGeoJSON(year, bboxCRS84, count = 1000) {
  // bboxCRS84 = [minLon, minLat, maxLon, maxLat]
  const typeNames = getRpgTypeName(year);
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames,
    srsName: "CRS:84",
    bbox: [...bboxCRS84, "CRS:84"].join(","),
    outputFormat: "application/json",
    count: String(count),
  });
  const url = `${RPG_WFS_BASE}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WFS HTTP ${res.status}`);
  return res.json();
}

// ——— DÉTECTION LIBELLÉ CULTURE ———
const DIRECT_LABEL_KEYS = [
  "LIB_CULTURE","LIB_CULTU","LIBELLE_CULTURE","NOM_CULTURE","LIB_LONG","LIBELLE",
  "CULTURE","culture","CULT_NOM","CULT_LIB","INTITULE","INTITULE_CULTURE"
];
export function getCultureLabel(props={}) {
  // 1) libellé direct
  for (const k of DIRECT_LABEL_KEYS) {
    const v = props[k];
    if (v != null && String(v).trim() !== "") return { label: String(v).trim(), code: null };
  }
  // 2) code détecté
  const code = readRpgCultureCode(props);
  return { label: code ? (labelFromCode(code) || `Code : ${code}`) : "(culture inconnue)", code };
}

// Utilitaire simple
export function getMapBoundsCRS84(map) {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}
