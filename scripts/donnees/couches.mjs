/**
 * Catalogue des couches publiques servies par l'API v1, et contrôle des paramètres.
 *
 * Seules les couches listées ici peuvent être demandées : l'API n'est pas un relais
 * ouvert vers la GéoPlateforme. Ajouter une couche = ajouter une ligne ici, un test et
 * une ligne dans docs/fonctionnalites/FP-012.
 */
import { RPG_AVAILABLE_YEARS, getRpgTypeName } from "../../src/domain/rpg/rpgLayers.js";

/** Grilles d'altitude (WMS, réponse image/x-bil;bits=32, une valeur float32 par point). */
export const COUCHES_TERRAIN = Object.freeze({
  // Relief au sol, LiDAR HD, 50 cm à 1 m. Couverture nationale en cours.
  "mnt-lidar": "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G",
  // Hauteur de la végétation et des bâtiments au-dessus du sol, LiDAR HD.
  "mnh-lidar": "IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G",
  // Relief RGE ALTI, 1 à 5 m, toute la France.
  "rge-alti": "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
  // Relief SRTM, environ 90 m, couverture mondiale : dernier recours.
  srtm: "ELEVATION.ELEVATIONGRIDCOVERAGE.SRTM3",
});

/** Objets de la BD TOPO (WFS, GeoJSON). */
export const COUCHES_BDTOPO = Object.freeze({
  batiments: "BDTOPO_V3:batiment",
  routes: "BDTOPO_V3:troncon_de_route",
  "surfaces-eau": "BDTOPO_V3:surface_hydrographique",
  "cours-eau": "BDTOPO_V3:troncon_hydrographique",
});

export const RPG_ANNEES = RPG_AVAILABLE_YEARS;
export { getRpgTypeName };

// Une emprise plus grande qu'environ 20 km de côté n'a pas de sens pour une ferme, et
// ferait télécharger des centaines de mégaoctets.
export const EMPRISE_MAX_DEGRES = 0.25;
// Une requête WMS de la GéoPlateforme est limitée à 2048 × 2048 ; on reste à 1024 pour
// que chaque réponse tienne en 4 Mo. Les grandes grilles se demandent par tuiles.
export const TUILE_MAX = 1024;
export const OBJETS_MAX = 5000;

export class DonneesInvalides extends Error {
  constructor(message) {
    super(message);
    this.name = "DonneesInvalides";
    this.code = "PARAMETRE_INVALIDE";
  }
}

/** `ouest,sud,est,nord` en degrés (WGS 84, longitude d'abord). */
export function lireEmprise(brut) {
  if (!brut) throw new DonneesInvalides("Paramètre bbox manquant (ouest,sud,est,nord en degrés).");
  const valeurs = String(brut).split(",").map((partie) => Number(partie.trim()));
  if (valeurs.length !== 4 || valeurs.some((valeur) => !Number.isFinite(valeur))) {
    throw new DonneesInvalides("bbox doit contenir quatre nombres : ouest,sud,est,nord.");
  }
  const [ouest, sud, est, nord] = valeurs;
  if (ouest < -180 || est > 180 || sud < -90 || nord > 90) {
    throw new DonneesInvalides("bbox hors des limites de longitude et de latitude.");
  }
  if (ouest >= est || sud >= nord) {
    throw new DonneesInvalides("bbox inversée : ouest doit être inférieur à est, et sud à nord.");
  }
  if (est - ouest > EMPRISE_MAX_DEGRES || nord - sud > EMPRISE_MAX_DEGRES) {
    throw new DonneesInvalides(`bbox trop grande (au plus ${EMPRISE_MAX_DEGRES}° de côté).`);
  }
  return [ouest, sud, est, nord];
}

export function lireEntier(brut, { nom, min, max, defaut }) {
  if (brut === null || brut === undefined || brut === "") {
    if (defaut !== undefined) return defaut;
    throw new DonneesInvalides(`Paramètre ${nom} manquant.`);
  }
  const valeur = Number(brut);
  if (!Number.isInteger(valeur) || valeur < min || valeur > max) {
    throw new DonneesInvalides(`${nom} doit être un entier entre ${min} et ${max}.`);
  }
  return valeur;
}

export function lireCouche(brut, catalogue) {
  if (!brut || !Object.hasOwn(catalogue, brut)) {
    throw new DonneesInvalides(`couche inconnue. Valeurs possibles : ${Object.keys(catalogue).join(", ")}.`);
  }
  return catalogue[brut];
}

export function lireAnneeRpg(brut) {
  const annee = Number(brut);
  if (!RPG_ANNEES.includes(annee)) {
    throw new DonneesInvalides(`annee doit être un millésime RPG publié : ${RPG_ANNEES.join(", ")}.`);
  }
  return annee;
}
