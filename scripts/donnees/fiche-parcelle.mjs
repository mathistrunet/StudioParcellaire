/**
 * Fiche parcelle de l'API v1 : une vue unique et stable d'une parcelle (nom, surface,
 * culture, bio, Télépac, historique des cultures), commune à ASSOLIA, au Studio et au jeu.
 *
 * Le parcellaire enregistré range une même information sous des clés différentes selon
 * sa provenance (Télépac XML, CSV Assolia, shapefile, saisie). Ce module LIT tous ces
 * alias et RENVOIE toujours les mêmes champs. Il n'écrit jamais dans le parcellaire.
 *
 * Historique : pour chaque année, la culture saisie dans le parcellaire (colonnes N, N-1…
 * N-6) fait foi. À défaut, on prend la culture déclarée au RPG pour la parcelle RPG qui
 * recouvre le mieux le contour. Quand les deux existent et diffèrent, l'écart est signalé.
 */
import { getCultureColumnByOffset, readCulturePrecision, readCultureValue } from "../../src/domain/parcelles/cultureColumns.js";
import { RPG_AVAILABLE_YEARS, getRpgTypeName, readRpgCultureCode } from "../../src/domain/rpg/rpgLayers.js";
import { featureAreaHa } from "../../src/utils/geometry.js";
import { matchRpgFeature } from "../enrich/parcel-matching.mjs";
import { DonneesInvalides, OBJETS_MAX } from "./couches.mjs";
import { separerCode } from "./cultures.mjs";

/** N et les six années précédentes : ce que portent les colonnes du parcellaire. */
export const HISTORIQUE_MAX = 7;
export const HISTORIQUE_DEFAUT = 5;
// Les parcelles d'une exploitation sont regroupées par carreaux de cette taille pour
// lire le RPG : une exploitation éclatée ne fait pas une seule requête démesurée.
const CARREAU_DEGRES = 0.2;

const rempli = (valeur) => valeur !== null && valeur !== undefined && String(valeur).trim() !== "";
const premier = (props, cles) => {
  for (const cle of cles) if (rempli(props[cle])) return props[cle];
  return null;
};
const texte = (valeur) => (rempli(valeur) ? String(valeur).trim() : null);
const arrondi = (valeur, decimales = 2) => Math.round(valeur * 10 ** decimales) / 10 ** decimales;

// Mêmes clés que l'export CSV Assolia (src/services/parcellesCsv.js).
const CLES_NOM = ["nom", "nom_affiche", "name", "nom_parcelle", "NOM_PARCEL"];
const CLES_SURFACE = ["surface_parcelle", "surface", "surface_ha"];
const CLES_BIO = ["parcelle_bio", "bio", "parcelleBio", "parcelle_bio_label", "conduite_bio", "isOrganic", "BIO"];
const CLES_TYPE_BIO = ["organicType", "type_conduite_bio"];

export function lireBio(valeur) {
  if (valeur === true || valeur === false) return valeur;
  const normalise = texte(valeur)?.toLowerCase();
  if (["1", "true", "oui", "yes", "y"].includes(normalise)) return true;
  if (["0", "false", "non", "no", "n"].includes(normalise)) return false;
  return null;
}

function lireSurface(props) {
  const brut = premier(props, CLES_SURFACE);
  const valeur = brut === null ? NaN : Number(String(brut).replace(",", "."));
  return Number.isFinite(valeur) && valeur > 0 ? valeur : null;
}

/** Une valeur de colonne culture : un code PAC (« BTH », « BTH|001 ») ou un texte libre. */
function lireCulture(valeur, precision, libelleCulture) {
  const brut = texte(valeur);
  if (!brut) return null;
  if (/^[A-Za-z0-9]{2,10}(\|\d{1,3})?$/.test(brut)) {
    const { code, precision: precisionCode } = separerCode(brut);
    const prec = texte(precision) ?? texte(precisionCode);
    return { code, precision: prec, libelle: libelleCulture(code, prec ?? "") };
  }
  return { code: null, precision: null, libelle: brut };
}

/**
 * Identifiant de la parcelle. L'interface (normalizeParcellesCollection) rend `__id` et
 * `feature.id` uniques mais garde l'`id` d'origine, qui peut être en double après un
 * import : on prend donc d'abord les identifiants normalisés.
 */
export const idParcelle = (feature) =>
  texte(feature?.properties?.__id) ?? texte(feature?.id) ?? texte(feature?.properties?.id);

export const anneeParcelle = (feature) => {
  const annee = Number(feature?.properties?.annee);
  return Number.isInteger(annee) ? annee : null;
};

/** Années présentes dans le parcellaire, la plus récente d'abord. */
export function anneesDisponibles(features) {
  return [...new Set(features.map(anneeParcelle).filter((annee) => annee !== null))].sort((a, b) => b - a);
}

/** Fiche sans l'historique RPG : uniquement ce que dit le parcellaire. */
export function ficheDepuisParcellaire(feature, { annee, historique, libelleCulture }) {
  const props = feature.properties || {};
  const surfaceSaisie = lireSurface(props);
  const surfaceCalculee = feature.geometry ? featureAreaHa(feature) : null;
  const bio = lireBio(premier(props, CLES_BIO));
  const historiqueParcellaire = [];
  for (let decalage = 0; decalage > -historique; decalage -= 1) {
    const colonne = getCultureColumnByOffset(decalage);
    const culture = lireCulture(readCultureValue(props, colonne), readCulturePrecision(props, colonne), libelleCulture);
    historiqueParcellaire.push({
      annee: annee + decalage,
      ...(culture ?? { code: null, precision: null, libelle: null }),
      source: culture ? "parcellaire" : "inconnue",
    });
  }
  return {
    id: idParcelle(feature),
    annee,
    nom: texte(premier(props, CLES_NOM)),
    surface_ha: surfaceSaisie ?? (surfaceCalculee === null ? null : arrondi(surfaceCalculee, 4)),
    surface_source: surfaceSaisie !== null ? "saisie" : surfaceCalculee !== null ? "calculee" : null,
    culture: historiqueParcellaire[0].source === "parcellaire"
      ? { code: historiqueParcellaire[0].code, precision: historiqueParcellaire[0].precision, libelle: historiqueParcellaire[0].libelle }
      : null,
    bio,
    type_bio: bio ? texte(premier(props, CLES_TYPE_BIO)) : null,
    bio_source: bio === null ? null : "parcellaire",
    telepac: {
      pacage: texte(props.pacage),
      ilot: texte(props.ilot_numero ?? props.ilot),
      numero: texte(props.numero ?? props.parcelle),
      commune_insee: texte(props.commune_insee),
    },
    historique: historiqueParcellaire,
    avertissements: [],
  };
}

function emprise(features) {
  let [ouest, sud, est, nord] = [180, 90, -180, -90];
  const visiter = (coordonnees) => {
    if (typeof coordonnees?.[0] === "number") {
      [ouest, sud, est, nord] = [
        Math.min(ouest, coordonnees[0]), Math.min(sud, coordonnees[1]),
        Math.max(est, coordonnees[0]), Math.max(nord, coordonnees[1]),
      ];
    } else if (Array.isArray(coordonnees)) coordonnees.forEach(visiter);
  };
  features.forEach((feature) => visiter(feature.geometry?.coordinates));
  return ouest <= est ? [ouest, sud, est, nord] : null;
}

// Emprise de chaque objet RPG, calculée une fois : le découpage de polygones est coûteux,
// on ne le fait que pour les parcelles RPG dont l'emprise touche celle de la parcelle.
const emprisesRpg = new WeakMap();
const empriseDe = (feature) => {
  if (!emprisesRpg.has(feature)) emprisesRpg.set(feature, emprise([feature]));
  return emprisesRpg.get(feature);
};
const seTouchent = (a, b) => a && b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** Regroupe les parcelles par carreau, pour lire le RPG par petites emprises. */
export function groupesParCarreau(features) {
  const groupes = new Map();
  for (const feature of features) {
    const zone = emprise([feature]);
    if (!zone) continue;
    const cle = `${Math.floor(zone[0] / CARREAU_DEGRES)}:${Math.floor(zone[1] / CARREAU_DEGRES)}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(feature);
  }
  return [...groupes.values()].map((membres) => ({ membres, emprise: emprise(membres) }));
}

/**
 * Complète les fiches avec le RPG : culture des années sans saisie, bio si le parcellaire
 * ne le dit pas, écarts entre saisie et déclaration. Une année RPG indisponible devient un
 * avertissement, jamais une erreur.
 */
async function completerAvecRpg(paires, { client, libelleCulture }) {
  const annees = [...new Set(paires.flatMap(({ fiche }) => fiche.historique.map((ligne) => ligne.annee)))]
    .filter((annee) => RPG_AVAILABLE_YEARS.includes(annee));
  const groupes = groupesParCarreau(paires.map(({ feature }) => feature).filter((feature) => feature.geometry));
  const ficheDe = new Map(paires.map(({ feature, fiche }) => [feature, fiche]));

  await Promise.all(groupes.flatMap(({ membres, emprise: zone }) => annees.map(async (annee) => {
    let rpg;
    try {
      rpg = await client.objets({ typeName: getRpgTypeName(annee), emprise: zone, max: OBJETS_MAX });
    } catch (error) {
      for (const feature of membres) {
        ficheDe.get(feature).avertissements.push({
          code: "RPG_INDISPONIBLE",
          message: `RPG ${annee} non lu : ${error?.message || "erreur"}.`,
        });
      }
      return;
    }
    for (const feature of membres) {
      const fiche = ficheDe.get(feature);
      if (rpg.tronque) {
        fiche.avertissements.push({ code: "RPG_TRONQUE", message: `RPG ${annee} : emprise trop dense, liste incomplète.` });
      }
      const zoneParcelle = empriseDe(feature);
      const candidates = rpg.features.filter((candidate) => seTouchent(zoneParcelle, empriseDe(candidate)));
      const { feature: trouvee } = matchRpgFeature(feature.geometry, candidates);
      if (!trouvee) continue;
      const props = trouvee.properties || {};
      const code = readRpgCultureCode(props);
      const ligne = fiche.historique.find((element) => element.annee === annee);
      if (code && ligne.source === "inconnue") {
        const precision = texte(props.precision);
        Object.assign(ligne, { code, precision, libelle: libelleCulture(code, precision ?? ""), source: "rpg" });
      } else if (code && ligne.code && ligne.code !== code) {
        ligne.ecart_rpg = { code, libelle: libelleCulture(code) };
      }
      const bioRpg = lireBio(props.bio);
      if (fiche.bio === null && bioRpg !== null && annee === fiche.annee) {
        Object.assign(fiche, { bio: bioRpg, bio_source: "rpg" });
      }
    }
  })));

  for (const { fiche } of paires) {
    // Un même avertissement peut venir de plusieurs carreaux ou années : on le garde une fois.
    const vus = new Set();
    fiche.avertissements = fiche.avertissements.filter(({ message }) => !vus.has(message) && vus.add(message));
  }
}

/**
 * @param lireParcellaire () => Promise<FeatureCollection> (toutes années)
 * @param client          client GéoPlateforme (pour le RPG)
 * @param libelleCulture  (code, precision) => libellé ou null
 */
export function creerServiceParcelles({ lireParcellaire, client, libelleCulture }) {
  async function fiches({ annee, historique = HISTORIQUE_DEFAUT, rpg = true, id = null }) {
    if (!Number.isInteger(historique) || historique < 1 || historique > HISTORIQUE_MAX) {
      throw new DonneesInvalides(`historique doit être un entier entre 1 et ${HISTORIQUE_MAX}.`);
    }
    const collection = await lireParcellaire();
    const toutes = Array.isArray(collection?.features) ? collection.features : [];
    const annees = anneesDisponibles(toutes);
    let anneeRetenue = annee ?? annees[0] ?? null;
    if (annee !== null && annee !== undefined && !annees.includes(annee)) {
      throw new DonneesInvalides(
        annees.length ? `Aucune parcelle en ${annee}. Années disponibles : ${annees.join(", ")}.` : "Le parcellaire ne contient aucune année."
      );
    }
    // Un parcellaire sans année (ancien import) est rendu tel quel, à l'année en cours.
    let retenues = anneeRetenue === null ? toutes : toutes.filter((feature) => anneeParcelle(feature) === anneeRetenue);
    if (anneeRetenue === null) anneeRetenue = new Date().getFullYear();
    if (id !== null) retenues = retenues.filter((feature) => idParcelle(feature) === id);

    const paires = retenues.map((feature) => ({
      feature,
      fiche: ficheDepuisParcellaire(feature, { annee: anneeRetenue, historique, libelleCulture }),
    }));
    if (rpg && paires.length) await completerAvecRpg(paires, { client, libelleCulture });
    return {
      annee: anneeRetenue,
      annees_disponibles: annees,
      features: paires.map(({ feature, fiche }) => ({ type: "Feature", id: fiche.id, geometry: feature.geometry ?? null, properties: fiche })),
    };
  }

  return {
    async lister(options) {
      const resultat = await fiches(options);
      return { type: "FeatureCollection", ...resultat };
    },
    /** @returns la fiche, ou null si l'identifiant est inconnu pour cette année */
    async lire(id, options) {
      const resultat = await fiches({ ...options, id });
      return resultat.features[0] ?? null;
    },
  };
}
