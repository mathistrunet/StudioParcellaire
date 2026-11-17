/**
 * Client de la GéoPlateforme de l'IGN pour l'API v1 : grilles d'altitude (WMS) et objets
 * vectoriels (WFS). Aucun accès HTTP entrant ici, pour rester testable.
 *
 * - Toute réponse est validée avant d'être renvoyée ou mise en cache.
 * - Une même URL demandée deux fois en même temps n'est téléchargée qu'une fois.
 * - Au plus `maxParalleles` téléchargements à la fois : la GéoPlateforme répond 429 et
 *   bloque le poste quelques secondes quand on la sollicite trop (cf. rpg-wfs-client).
 */
const WMS_BASE = "https://data.geopf.fr/wms-r/wms";
const WFS_BASE = "https://data.geopf.fr/wfs/ows";

export class IgnIndisponible extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "IgnIndisponible";
    this.code = "IGN_INDISPONIBLE";
    this.status = status;
  }
}

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function creerFile(maxParalleles) {
  let actifs = 0;
  const attente = [];
  return async function executer(tache) {
    if (actifs >= maxParalleles) await new Promise((resolve) => attente.push(resolve));
    actifs += 1;
    try {
      return await tache();
    } finally {
      actifs -= 1;
      attente.shift()?.();
    }
  };
}

/** URL WMS GetMap d'une grille d'altitude. En WMS 1.3.0, EPSG:4326 s'écrit latitude d'abord. */
export function urlAltitudes({ couche, emprise, largeur, hauteur }) {
  const [ouest, sud, est, nord] = emprise;
  const params = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: couche,
    STYLES: "",
    CRS: "EPSG:4326",
    BBOX: [sud, ouest, nord, est].join(","),
    WIDTH: String(largeur),
    HEIGHT: String(hauteur),
    FORMAT: "image/x-bil;bits=32",
  });
  return `${WMS_BASE}?${params}`;
}

/**
 * URL WFS GetFeature. Le suffixe CRS:84 de bbox est indispensable : sans lui, le WFS
 * répond 200 avec une liste vide.
 */
export function urlObjets({ typeName, emprise, max }) {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: typeName,
    srsName: "CRS:84",
    bbox: [...emprise, "CRS:84"].join(","),
    outputFormat: "application/json",
    count: String(max),
  });
  return `${WFS_BASE}?${params}`;
}

/** Une grille BIL valide fait exactement 4 octets par point. Sinon c'est un message d'erreur. */
export function validerAltitudes(contenu, largeur, hauteur) {
  if (contenu.byteLength !== largeur * hauteur * 4) {
    throw new IgnIndisponible(`Grille d'altitude de taille inattendue (${contenu.byteLength} octets).`);
  }
  return contenu;
}

/** Une réponse WFS peut arriver en XML (ExceptionReport) malgré le format demandé. */
export function validerObjets(contenu) {
  let donnees;
  try {
    donnees = JSON.parse(Buffer.from(contenu).toString("utf-8"));
  } catch {
    throw new IgnIndisponible("Réponse du WFS illisible.");
  }
  if (!Array.isArray(donnees?.features)) throw new IgnIndisponible("Réponse du WFS sans liste d'objets.");
  const trouves = Number(donnees.numberMatched);
  return {
    type: "FeatureCollection",
    features: donnees.features,
    tronque: Number.isFinite(trouves) && trouves > donnees.features.length,
  };
}

export function creerClientGeoplateforme({
  cache = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  // Une tuile LiDAR de 1024 × 1024 a déjà demandé plus de 30 s.
  delaiMs = 45_000,
  reprises = 1,
  maxParalleles = 4,
  pauseMaxMs = 10_000,
  dormir = attendre,
} = {}) {
  const file = creerFile(maxParalleles);
  const enCours = new Map();

  async function essai(url) {
    let reponse;
    try {
      reponse = await fetchImpl(url, { signal: AbortSignal.timeout(delaiMs) });
    } catch (error) {
      const delai = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new IgnIndisponible(
        delai ? `Pas de réponse de la GéoPlateforme en ${delaiMs} ms.` : `GéoPlateforme injoignable (${error?.message || "erreur réseau"}).`
      );
    }
    if (!reponse.ok) {
      const erreur = new IgnIndisponible(`La GéoPlateforme a répondu HTTP ${reponse.status}.`, { status: reponse.status });
      if (reponse.status === 429) {
        const secondes = Number(reponse.headers?.get?.("retry-after"));
        erreur.pauseMs = Math.min(pauseMaxMs, Number.isFinite(secondes) && secondes > 0 ? secondes * 1000 : 5_000);
      }
      throw erreur;
    }
    return Buffer.from(await reponse.arrayBuffer());
  }

  async function telechargerSansCache(url, valider) {
    for (let tentative = 0; ; tentative += 1) {
      try {
        const contenu = await file(() => essai(url));
        return { contenu, valeur: valider(contenu) };
      } catch (error) {
        const reessayable = error.pauseMs !== undefined || error.status === null || error.status >= 500;
        if (tentative >= reprises || !reessayable) throw error;
        await dormir(error.pauseMs ?? 300);
      }
    }
  }

  /** Lit le cache, sinon télécharge, valide et met en cache. */
  async function obtenir(url, valider) {
    const enCache = await cache?.lire(url);
    if (enCache) {
      try {
        return valider(enCache);
      } catch {
        await cache.supprimer(url);
      }
    }
    if (!enCours.has(url)) {
      const promesse = telechargerSansCache(url, valider)
        .then(async ({ contenu, valeur }) => {
          await cache?.ecrire(url, contenu);
          return valeur;
        })
        .finally(() => enCours.delete(url));
      enCours.set(url, promesse);
    }
    return enCours.get(url);
  }

  return {
    /** @returns {Promise<Buffer>} float32 petit-boutiste, ligne par ligne du nord au sud */
    altitudes({ couche, emprise, largeur, hauteur }) {
      return obtenir(urlAltitudes({ couche, emprise, largeur, hauteur }), (contenu) =>
        validerAltitudes(contenu, largeur, hauteur)
      );
    },
    /** @returns {Promise<{type: "FeatureCollection", features: object[], tronque: boolean}>} */
    objets({ typeName, emprise, max }) {
      return obtenir(urlObjets({ typeName, emprise, max }), validerObjets);
    },
  };
}
