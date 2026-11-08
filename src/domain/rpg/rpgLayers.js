// src/domain/rpg/rpgLayers.js
//
// Connaissance du WFS RPG de la GéoPlateforme partagée entre le navigateur et le
// serveur : ce module ne doit dépendre ni de `window` ni du codebook des cultures.

export const RPG_WFS_BASE = "https://data.geopf.fr/wfs/ows";

// Millésimes réellement exposés par le WFS (vérifiés un par un ; 2014 répond HTTP 400).
export const RPG_AVAILABLE_YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015];

// Le millésime 2025 n'est pas publié sous `RPG.2025` (HTTP 400) : l'IGN l'expose
// sous un espace de noms différent. `RPG.LATEST` est écarté car son contenu change
// à chaque publication, alors qu'une colonne vise une campagne précise.
const RPG_TYPE_NAME_BY_YEAR = {
  2025: "LANDUSE.AGRICULTURE2025:parcelles_graphiques",
};

export function getRpgTypeName(year) {
  return RPG_TYPE_NAME_BY_YEAR[year] ?? `RPG.${year}:parcelles_graphiques`;
}

const CODE_KEYS = [
  "code_cultu","CODE_CULTURE","CODE_CULTU","CULT_CODE","CODE","CODE_CULT","CODE_CULTUR",
  "CULTURE_CODE","CD_CULT","CULT","code_culture","code_cult"
];

/** Code de la culture principale d'une parcelle RPG, ou null s'il est introuvable. */
export function readRpgCultureCode(props = {}) {
  for (const k of CODE_KEYS) {
    const v = props[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  // heuristique
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    // `cat_cult_p` (TA, PP…) et `culture_d1/d2` (dérobées) ne sont pas la culture
    // principale, mais leur valeur ressemble à un code.
    if (/^cat_cult|^culture_d/i.test(k)) continue;
    if (/code.*cult|cult.*code|^code_.*cult/i.test(k) || /cult/i.test(k)) {
      const val = String(v).trim();
      if (/^[A-Z0-9]{2,6}$/.test(val)) return val;
    }
  }
  return null;
}
