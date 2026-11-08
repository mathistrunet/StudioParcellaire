/**
 * Accès au WFS RPG de la GéoPlateforme, sans lien avec l'affichage de la carte.
 *
 * L'interrogation passe toujours par `bbox=lon,lat,lon,lat,CRS:84`. Sans le suffixe
 * CRS:84, ou avec les axes inversés, le WFS répond 200 avec une liste vide : une erreur
 * d'axes passerait pour une absence de parcelle. Le test géométrique fin est fait
 * ensuite localement (cf. parcel-matching.mjs).
 */
import { RPG_WFS_BASE, getRpgTypeName } from "../../src/domain/rpg/rpgLayers.js";

export const WFS_ERROR_CODES = Object.freeze({
  TIMEOUT: "WFS_TIMEOUT",
  HTTP: "WFS_HTTP",
  NETWORK: "WFS_RESEAU",
  INVALID_RESPONSE: "WFS_REPONSE_INVALIDE",
});

export class WfsError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = "WfsError";
    this.code = code;
    this.status = status;
  }
}

const isRetryable = (error) =>
  error.code === WFS_ERROR_CODES.TIMEOUT ||
  error.code === WFS_ERROR_CODES.NETWORK ||
  (error.code === WFS_ERROR_CODES.HTTP && error.status >= 500);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Le WFS répond 429 avec Retry-After au-delà d'environ 30 requêtes par seconde (mesuré),
 * et bloque alors toutes les requêtes du poste pendant quelques secondes. On reste donc
 * en dessous, et un 429 suspend tous les appels en cours, pas seulement celui refusé.
 * Cet état ne contient que des horaires, aucune donnée de parcelle.
 */
function createRateGate({ minIntervalMs, now, sleep }) {
  let nextSlot = 0;
  let pausedUntil = 0;

  return {
    async acquire() {
      for (;;) {
        const current = now();
        const slot = Math.max(current, nextSlot, pausedUntil);
        nextSlot = slot + minIntervalMs;
        if (slot > current) await sleep(slot - current);
        // Une pause a pu être décidée pendant l'attente : ce créneau n'est plus valable.
        if (pausedUntil <= now()) return;
      }
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, now() + ms);
    },
  };
}

function retryAfterMs(response, fallbackMs) {
  const seconds = Number(response.headers?.get?.("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

export function createRpgWfsClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  // Une réponse isolée a déjà été mesurée à 17 s : le délai doit la laisser aboutir.
  timeoutMs = 20_000,
  retries = 1,
  rateLimitRetries = 3,
  retryDelayMs = 300,
  rateLimitPauseMs = 5_000,
  maxRetryAfterMs = 30_000,
  minIntervalMs = 60,
  maxFeatures = 1000,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const gate = createRateGate({ minIntervalMs, now, sleep });

  async function attempt(url, year) {
    await gate.acquire();
    let response;
    let text;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      text = await response.text();
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new WfsError(WFS_ERROR_CODES.TIMEOUT, `RPG ${year} : pas de réponse du WFS en ${timeoutMs} ms.`);
      }
      throw new WfsError(WFS_ERROR_CODES.NETWORK, `RPG ${year} : WFS injoignable (${error?.message || "erreur réseau"}).`);
    }
    if (!response.ok) {
      const error = new WfsError(WFS_ERROR_CODES.HTTP, `RPG ${year} : le WFS a répondu HTTP ${response.status}.`, {
        status: response.status,
      });
      if (response.status === 429) error.retryAfterMs = retryAfterMs(response, rateLimitPauseMs);
      throw error;
    }
    // Une erreur de service peut arriver en XML (ExceptionReport) malgré le format demandé.
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new WfsError(WFS_ERROR_CODES.INVALID_RESPONSE, `RPG ${year} : réponse du WFS illisible.`);
    }
    if (!Array.isArray(payload?.features)) {
      throw new WfsError(WFS_ERROR_CODES.INVALID_RESPONSE, `RPG ${year} : réponse du WFS sans liste de parcelles.`);
    }
    return payload;
  }

  /** @returns {Promise<{features: object[], tronque: boolean}>} */
  return async function fetchRpgFeatures(year, bbox) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeNames: getRpgTypeName(year),
      srsName: "CRS:84",
      bbox: [...bbox, "CRS:84"].join(","),
      outputFormat: "application/json",
      count: String(maxFeatures),
    });
    const url = `${RPG_WFS_BASE}?${params.toString()}`;

    let tries = 0;
    let rateLimitTries = 0;
    for (;;) {
      try {
        const payload = await attempt(url, year);
        const matched = Number(payload.numberMatched);
        return {
          features: payload.features,
          tronque: Number.isFinite(matched) && matched > payload.features.length,
        };
      } catch (error) {
        if (error.retryAfterMs !== undefined) {
          gate.pause(Math.min(error.retryAfterMs, maxRetryAfterMs));
          rateLimitTries += 1;
          if (rateLimitTries > rateLimitRetries || error.retryAfterMs > maxRetryAfterMs) throw error;
          continue;
        }
        tries += 1;
        if (tries > retries || !isRetryable(error)) throw error;
        await sleep(retryDelayMs);
      }
    }
  };
}
