// src/services/rpg.js
// Appel WFS GEOPF (RPG) + utilitaires libellé culture

import { labelFromCode } from "../utils/cultureLabels";

const WFS_BASE = "https://data.geopf.fr/wfs/ows";

// Le millésime 2025 n'est pas publié sous `RPG.2025` (HTTP 400) : l'IGN l'expose
// sous un espace de noms différent. `RPG.LATEST` est écarté car son contenu change
// à chaque publication, alors qu'une colonne vise une campagne précise.
const RPG_TYPE_NAME_BY_YEAR = {
  2025: "LANDUSE.AGRICULTURE2025:parcelles_graphiques",
};

export function getRpgTypeName(year) {
  return RPG_TYPE_NAME_BY_YEAR[year] ?? `RPG.${year}:parcelles_graphiques`;
}

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
  const url = `${WFS_BASE}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WFS HTTP ${res.status}`);
  return res.json();
}

// ——— DÉTECTION LIBELLÉ CULTURE ———
const DIRECT_LABEL_KEYS = [
  "LIB_CULTURE","LIB_CULTU","LIBELLE_CULTURE","NOM_CULTURE","LIB_LONG","LIBELLE",
  "CULTURE","culture","CULT_NOM","CULT_LIB","INTITULE","INTITULE_CULTURE"
];
const CODE_KEYS = [
  "code_cultu","CODE_CULTURE","CODE_CULTU","CULT_CODE","CODE","CODE_CULT","CODE_CULTUR",
  "CULTURE_CODE","CD_CULT","CULT","code_culture","code_cult"
];


export function getCultureLabel(props={}) {
  // 1) libellé direct
  for (const k of DIRECT_LABEL_KEYS) {
    const v = props[k];
    if (v != null && String(v).trim() !== "") return { label: String(v).trim(), code: null };
  }
  // 2) code détecté
  let code = null;
  for (const k of CODE_KEYS) {
    const v = props[k];
    if (v != null && String(v).trim() !== "") { code = String(v).trim(); break; }
  }
  if (!code) {
    // heuristique
    for (const [k,v] of Object.entries(props)) {
      if (v==null) continue;
      // `cat_cult_p` (TA, PP…) et `culture_d1/d2` (dérobées) ne sont pas la culture
      // principale, mais leur valeur ressemble à un code.
      if (/^cat_cult|^culture_d/i.test(k)) continue;
      if (/code.*cult|cult.*code|^code_.*cult/i.test(k) || /cult/i.test(k)) {
        const val = String(v).trim();
        if (/^[A-Z0-9]{2,6}$/.test(val)) { code = val; break; }
      }
    }
  }
  return { label: code ? (labelFromCode(code) || `Code : ${code}`) : "(culture inconnue)", code };
}

// Utilitaire simple
export function getMapBoundsCRS84(map) {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}
