import { featureCollectionsEqual } from "../utils/featureCollectionEquality";

const PARCELLES_ENDPOINT = "/api/parcelles";
const MATCH_VALIDATE_ENDPOINT = "/api/parcelles/matching/validate";
const BACKUPS_ENDPOINT = "/api/parcelles/backups";

// Anciens emplacements du parcellaire dans le navigateur, lus une dernière fois puis retirés.
const BROWSER_COPY_KEY = "studioparcellaire.parcelles-temp";
const LEGACY_BROWSER_COPY_KEY = "parcelles.geojson";
const BROWSER_COPY_VERSION_KEY = "studioparcellaire.parcelles-version";
// Seule une copie posée par la version qui posait ce marqueur est un travail récent.
const CURRENT_BROWSER_COPY_VERSION = "2";

const normalizeFeature = (feature) => {
  if (!feature || typeof feature !== "object") return null;
  if (feature.type !== "Feature") return null;
  return {
    ...feature,
    properties: feature.properties || {},
  };
};

const normalizeFeatureCollection = (payload) => {
  const resolveCollection = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;
    if (candidate.type !== "FeatureCollection") return null;
    if (!Array.isArray(candidate.features)) return null;
    return candidate;
  };

  let collection = resolveCollection(payload);
  if (!collection && payload && typeof payload === "object") {
    collection =
      resolveCollection(payload.data) ||
      resolveCollection(payload.geojson) ||
      resolveCollection(payload.collection);
  }
  if (!collection && Array.isArray(payload?.features)) {
    collection = { type: "FeatureCollection", features: payload.features };
  }
  if (!collection && Array.isArray(payload)) {
    collection = { type: "FeatureCollection", features: payload };
  }

  if (!collection) {
    return { type: "FeatureCollection", features: [] };
  }

  return {
    ...collection,
    features: collection.features.map(normalizeFeature).filter(Boolean),
  };
};

function readBrowserCopy() {
  try {
    const storage = window.localStorage;
    const raw = storage.getItem(BROWSER_COPY_KEY) ?? storage.getItem(LEGACY_BROWSER_COPY_KEY);
    return {
      collection: raw ? normalizeFeatureCollection(JSON.parse(raw)) : null,
      isCurrent: storage.getItem(BROWSER_COPY_VERSION_KEY) === CURRENT_BROWSER_COPY_VERSION,
    };
  } catch (error) {
    console.warn("[PARCELLES_BROWSER_COPY_UNREADABLE] Ancienne copie du navigateur illisible.", error);
    return { collection: null, isCurrent: false };
  }
}

function removeBrowserCopy() {
  try {
    window.localStorage.removeItem(BROWSER_COPY_KEY);
    window.localStorage.removeItem(LEGACY_BROWSER_COPY_KEY);
    window.localStorage.removeItem(BROWSER_COPY_VERSION_KEY);
  } catch {
    // Sans accès au stockage du navigateur, la copie restera simplement inutilisée.
  }
}

async function sendCollection(collection, signal) {
  const response = await fetch(PARCELLES_ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collection),
    signal,
  });
  if (!response.ok) {
    throw new Error(`[PARCELLES_SAVE_BACKEND_${response.status}] Enregistrement refusé.`);
  }
}

async function sendBrowserCopyBackup(collection, signal) {
  const response = await fetch(BACKUPS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "copie-navigateur", collection }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`[PARCELLES_BACKUP_BACKEND_${response.status}] Sauvegarde refusée.`);
  }
}

/**
 * Le navigateur gardait une copie du parcellaire : elle rejoint une fois la base locale.
 * Si la base est vide, un travail récent y est repris ; sinon la base fait foi et la
 * copie divergente devient une sauvegarde. Elle n'est retirée qu'après réussite.
 */
async function adoptBrowserCopy(serverCollection, signal) {
  if (typeof window === "undefined") return serverCollection;
  const { collection: copy, isCurrent } = readBrowserCopy();
  if (!copy) return serverCollection;

  let result = serverCollection;
  if (copy.features.length > 0 && !featureCollectionsEqual(copy, serverCollection)) {
    if (serverCollection.features.length === 0 && isCurrent) {
      await sendCollection(copy, signal);
      result = copy;
    } else {
      await sendBrowserCopyBackup(copy, signal);
    }
  }
  removeBrowserCopy();
  return result;
}

export async function fetchParcellesGeojson(signal) {
  const response = await fetch(PARCELLES_ENDPOINT, { signal });
  if (!response.ok) {
    throw new Error(`[PARCELLES_FETCH_BACKEND_${response.status}] Chargement impossible.`);
  }
  const collection = normalizeFeatureCollection(await response.json());
  try {
    return await adoptBrowserCopy(collection, signal);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // La copie reste en place et sera reprise au prochain chargement.
    console.warn("[PARCELLES_BROWSER_COPY_NOT_ADOPTED]", error);
    return collection;
  }
}

export async function clearParcellesGeojson(signal) {
  const collection = normalizeFeatureCollection({
    type: "FeatureCollection",
    features: [],
  });
  const response = await fetch(PARCELLES_ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(collection),
    signal,
  });

  if (!response.ok) {
    throw new Error(`[PARCELLES_CLEAR_BACKEND_${response.status}] Réinitialisation refusée.`);
  }

  return collection;
}

export async function saveParcellesGeojson(features, signal) {
  const collection = {
    type: "FeatureCollection",
    features: (features || []).map((feature) => ({
      type: "Feature",
      id: feature.id,
      geometry: feature.geometry,
      properties: feature.properties || {},
    })),
  };

  await sendCollection(collection, signal);
  return collection;
}

/** Sauvegarde la plus récente faite avant un effacement, ou null. */
export async function fetchLatestClearedBackup(signal) {
  const response = await fetch(BACKUPS_ENDPOINT, { signal });
  if (!response.ok) {
    throw new Error(`[PARCELLES_BACKUPS_BACKEND_${response.status}] Sauvegardes inaccessibles.`);
  }
  const { backups } = await response.json();
  return (backups || []).find((backup) => backup.reason === "avant-effacement") ?? null;
}

export async function restoreParcellesBackup(id, signal) {
  const response = await fetch(`${BACKUPS_ENDPOINT}/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`[PARCELLES_RESTORE_BACKEND_${response.status}] Restauration impossible.`);
  }
  return normalizeFeatureCollection(await response.json());
}

export async function validateParcellesMatching(
  { oldYear, newYear, matches },
  signal
) {
  const response = await fetch(MATCH_VALIDATE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      oldYear,
      newYear,
      matches: Array.isArray(matches) ? matches : [],
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`[PARCELLES_MATCH_VALIDATE_BACKEND_${response.status}] Validation refusée.`);
  }

  return response.json();
}
