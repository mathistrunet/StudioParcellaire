// src/services/enrich.js
// Client de POST /api/v1/enrich (contrat : docs/api/openapi-v1.json).

const ENRICH_ENDPOINT = "/api/v1/enrich";
// Une requête par parcelle, chacune relayée au WFS public : on reste modéré.
const DEFAULT_CONCURRENCY = 4;

export async function enrichParcelle({ geometry, millesimes, inclureNom = true }, { signal } = {}) {
  const response = await fetch(ENRICH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ geometry, millesimes, inclure_nom: inclureNom }),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || `Enrichissement impossible (HTTP ${response.status}).`);
    error.code = payload?.code ?? null;
    throw error;
  }
  return payload;
}

/**
 * Enrichit plusieurs géométries avec un parallélisme borné. L'échec d'une parcelle
 * n'interrompt pas les autres : chaque entrée vaut `{ result }` ou `{ error }`, dans
 * l'ordre des géométries reçues.
 */
export async function enrichParcelles(geometries, { millesimes, inclureNom = true, signal, concurrency = DEFAULT_CONCURRENCY }) {
  const outcomes = new Array(geometries.length);
  let next = 0;
  const worker = async () => {
    while (next < geometries.length) {
      const index = next;
      next += 1;
      try {
        const result = await enrichParcelle({ geometry: geometries[index], millesimes, inclureNom }, { signal });
        outcomes[index] = { result };
      } catch (error) {
        outcomes[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, geometries.length) }, worker));
  return outcomes;
}
