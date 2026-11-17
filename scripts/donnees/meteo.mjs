/**
 * Météo journalière d'un point pour l'API v1 : températures minimale et maximale, pluie.
 *
 * Source : Open-Meteo, API « historical weather » (réanalyses ERA5 et ERA5-Land de
 * Copernicus, complétées pour les derniers jours par les modèles de prévision). Gratuite,
 * sans clé, pour un usage non commercial ; données sous licence CC BY 4.0
 * (« Weather data by Open-Meteo.com »).
 *
 * - Le point est ramené à une maille de 0,1° (environ 11 km × 8 km en France, la
 *   résolution d'ERA5-Land) : toutes les parcelles d'une ferme partagent la même série,
 *   et une seule requête sert toute la maille.
 * - Un jour sans mesure (futur, ou pas encore publié) prend la normale du jour : moyenne
 *   des années NORMALES, lissée sur 15 jours. Chaque jour dit d'où vient sa valeur.
 * - Les réponses validées sont gardées en cache disque. L'URL des observations contient
 *   la date de la veille : elle change chaque jour, la série se complète donc d'elle-même.
 */
import { DonneesInvalides } from "./couches.mjs";

const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
export const MAILLE_DEGRES = 0.1;
export const NORMALES = Object.freeze({ debut: 2015, fin: 2024 });
export const DUREE_MAX_JOURS = 800;
export const PREMIERE_DATE = "1950-01-01";
const LISSAGE_JOURS = 7; // ± 7 jours autour du jour : moyenne glissante sur 15 jours
const JOUR_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VARIABLES = "temperature_2m_min,temperature_2m_max,precipitation_sum";

export class MeteoIndisponible extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "MeteoIndisponible";
    this.code = "METEO_INDISPONIBLE";
    this.status = status;
  }
}

const versMs = (date) => Date.parse(`${date}T00:00:00Z`);
const versDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const ajouterJours = (date, jours) => versDate(versMs(date) + jours * JOUR_MS);
export const arrondirMaille = (valeur) => Math.round(valeur / MAILLE_DEGRES) * MAILLE_DEGRES;
const fixe = (valeur) => Number(valeur.toFixed(4));

function lireDate(brut, nom) {
  if (!brut || !DATE.test(brut) || Number.isNaN(versMs(brut))) {
    throw new DonneesInvalides(`${nom} doit être une date AAAA-MM-JJ.`);
  }
  return brut;
}

function lireNombre(brut, nom, min, max) {
  const valeur = brut === null || brut === "" ? NaN : Number(brut);
  if (!Number.isFinite(valeur) || valeur < min || valeur > max) {
    throw new DonneesInvalides(`${nom} doit être un nombre entre ${min} et ${max}.`);
  }
  return valeur;
}

/** lat, lon (degrés WGS 84), debut, fin (AAAA-MM-JJ, inclus). */
export function lireDemandeMeteo(params, { aujourdhui }) {
  const lat = lireNombre(params.get("lat"), "lat", -90, 90);
  const lon = lireNombre(params.get("lon"), "lon", -180, 180);
  const debut = lireDate(params.get("debut"), "debut");
  const fin = lireDate(params.get("fin"), "fin");
  if (fin < debut) throw new DonneesInvalides("fin doit suivre debut.");
  if (debut < PREMIERE_DATE) throw new DonneesInvalides(`debut doit être postérieur au ${PREMIERE_DATE}.`);
  if ((versMs(fin) - versMs(debut)) / JOUR_MS + 1 > DUREE_MAX_JOURS) {
    throw new DonneesInvalides(`Au plus ${DUREE_MAX_JOURS} jours par demande.`);
  }
  if (fin > ajouterJours(aujourdhui, 366)) throw new DonneesInvalides("fin doit être à moins d'un an d'aujourd'hui.");
  return { lat, lon, debut, fin };
}

export function urlArchive({ lat, lon, debut, fin }) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(1),
    longitude: lon.toFixed(1),
    start_date: debut,
    end_date: fin,
    daily: VARIABLES,
    // Jours civils du lieu : un « jour » de la série est un jour de la ferme.
    timezone: "auto",
  });
  return `${ARCHIVE}?${params}`;
}

/** Réponse Open-Meteo : listes de même longueur, températures nombre ou null. */
export function validerArchive(contenu) {
  let json;
  try {
    json = JSON.parse(Buffer.isBuffer(contenu) ? contenu.toString("utf8") : contenu);
  } catch {
    throw new MeteoIndisponible("Réponse météo illisible.");
  }
  const jours = json?.daily;
  const listes = ["time", "temperature_2m_min", "temperature_2m_max", "precipitation_sum"].map((cle) => jours?.[cle]);
  if (json?.error || listes.some((liste) => !Array.isArray(liste) || liste.length !== listes[0].length)) {
    throw new MeteoIndisponible(`Réponse météo invalide${json?.reason ? ` : ${json.reason}` : ""}.`);
  }
  return {
    altitude: Number.isFinite(json.elevation) ? json.elevation : null,
    jours: listes[0].map((date, i) => ({
      date,
      tmin: listes[1][i],
      tmax: listes[2][i],
      pluie: listes[3][i],
    })),
  };
}

/**
 * Normale de chaque jour de l'année (« MM-JJ ») : moyenne des années de la série, puis
 * moyenne glissante sur 15 jours pour effacer le bruit d'une dizaine d'années seulement.
 * Le 29 février prend la normale du 28.
 */
export function calculerNormales(jours) {
  // Index 0 à 364 sur une année non bissextile.
  const somme = Array.from({ length: 365 }, () => ({ tmin: 0, tmax: 0, pluie: 0, n: 0, np: 0 }));
  const indexDe = (date) => {
    const mmjj = date.slice(5) === "02-29" ? "02-28" : date.slice(5);
    return (versMs(`2001-${mmjj}`) - versMs("2001-01-01")) / JOUR_MS;
  };
  for (const jour of jours) {
    if (jour.tmin == null || jour.tmax == null) continue;
    const case_ = somme[indexDe(jour.date)];
    case_.tmin += jour.tmin;
    case_.tmax += jour.tmax;
    case_.n += 1;
    if (jour.pluie != null) {
      case_.pluie += jour.pluie;
      case_.np += 1;
    }
  }
  if (somme.some((case_) => case_.n === 0)) throw new MeteoIndisponible("Série trop courte pour calculer les normales.");
  const normales = new Map();
  for (let i = 0; i < 365; i += 1) {
    let tmin = 0;
    let tmax = 0;
    let pluie = 0;
    for (let d = -LISSAGE_JOURS; d <= LISSAGE_JOURS; d += 1) {
      const case_ = somme[(i + d + 365) % 365];
      tmin += case_.tmin / case_.n;
      tmax += case_.tmax / case_.n;
      pluie += case_.np ? case_.pluie / case_.np : 0;
    }
    const largeur = 2 * LISSAGE_JOURS + 1;
    normales.set(versDate(versMs("2001-01-01") + i * JOUR_MS).slice(5), {
      tmin: Math.round((tmin / largeur) * 10) / 10,
      tmax: Math.round((tmax / largeur) * 10) / 10,
      pluie: Math.round((pluie / largeur) * 10) / 10,
    });
  }
  return normales;
}

const normaleDu = (normales, date) => normales.get(date.slice(5) === "02-29" ? "02-28" : date.slice(5));

/**
 * @param cache       cache disque (creerCacheDisque) ; facultatif
 * @param aujourdhui  () => "AAAA-MM-JJ" : la veille est le dernier jour demandé en observation
 */
export function creerClientMeteo({
  cache = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  delaiMs = 30_000,
  aujourdhui = () => new Date().toISOString().slice(0, 10),
} = {}) {
  const enCours = new Map();

  async function telecharger(url) {
    let reponse;
    try {
      reponse = await fetchImpl(url, { signal: AbortSignal.timeout(delaiMs) });
    } catch (error) {
      throw new MeteoIndisponible(`Service météo injoignable (${error?.message || "erreur réseau"}).`);
    }
    if (!reponse.ok) {
      const raison = (await reponse.json().catch(() => null))?.reason;
      throw new MeteoIndisponible(
        `Le service météo a répondu HTTP ${reponse.status}${raison ? ` : ${raison}` : ""}.`,
        { status: reponse.status }
      );
    }
    return Buffer.from(await reponse.arrayBuffer());
  }

  /** Cache, sinon téléchargement validé puis mis en cache. Une même URL n'est téléchargée qu'une fois à la fois. */
  async function obtenir(url) {
    const enCache = await cache?.lire(url);
    if (enCache) {
      try {
        return validerArchive(enCache);
      } catch {
        await cache.supprimer(url);
      }
    }
    if (!enCours.has(url)) {
      const promesse = telecharger(url)
        .then(async (contenu) => {
          const valeur = validerArchive(contenu);
          await cache?.ecrire(url, contenu);
          return valeur;
        })
        .finally(() => enCours.delete(url));
      enCours.set(url, promesse);
    }
    return enCours.get(url);
  }

  async function normales(maille) {
    const { jours } = await obtenir(
      urlArchive({ ...maille, debut: `${NORMALES.debut}-01-01`, fin: `${NORMALES.fin}-12-31` })
    );
    return calculerNormales(jours);
  }

  return {
    /**
     * Série journalière complète de debut à fin (inclus) sur la maille du point.
     * @returns {{ maille, altitude, fournisseur, licence, normales, jours: {date, tmin, tmax, pluie, source}[] }}
     */
    async serie({ lat, lon, debut, fin }) {
      const maille = { lat: fixe(arrondirMaille(lat)), lon: fixe(arrondirMaille(lon)) };
      const hier = ajouterJours(aujourdhui(), -1);
      const finMesures = fin < hier ? fin : hier;
      const mesures = debut <= finMesures ? await obtenir(urlArchive({ ...maille, debut, fin: finMesures })) : null;
      const parDate = new Map((mesures?.jours ?? []).map((jour) => [jour.date, jour]));

      const jours = [];
      let manque = false;
      for (let date = debut; date <= fin; date = ajouterJours(date, 1)) {
        const mesure = parDate.get(date);
        if (mesure && mesure.tmin != null && mesure.tmax != null) {
          jours.push({ date, tmin: mesure.tmin, tmax: mesure.tmax, pluie: mesure.pluie ?? 0, source: "observee" });
        } else {
          manque = true;
          jours.push({ date, tmin: null, tmax: null, pluie: null, source: "normale" });
        }
      }
      if (manque) {
        const table = await normales(maille);
        for (const jour of jours) {
          if (jour.source !== "normale") continue;
          Object.assign(jour, normaleDu(table, jour.date));
        }
      }
      return {
        maille,
        altitude: mesures?.altitude ?? null,
        fournisseur: "Open-Meteo, réanalyses ERA5 / ERA5-Land (Copernicus)",
        licence: "CC BY 4.0 — Weather data by Open-Meteo.com",
        normales: `${NORMALES.debut}-${NORMALES.fin}, lissées sur ${2 * LISSAGE_JOURS + 1} jours`,
        jours,
      };
    },
  };
}
