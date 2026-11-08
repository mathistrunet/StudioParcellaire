import { describe, expect, it, vi } from "vitest";
import { WFS_ERROR_CODES, createRpgWfsClient } from "./rpg-wfs-client.mjs";

const BBOX = [1.6, 48.2, 1.61, 48.21];
const collection = (features = [], extra = {}) => JSON.stringify({ type: "FeatureCollection", features, ...extra });
const answer = (body, status = 200, headers = {}) => new Response(body, { status, headers });

/** Horloge simulée : les attentes avancent le temps sans ralentir les tests. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps = [];
  return {
    now: () => time,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

const client = (fetchImpl, options = {}) => {
  const { now, sleep } = fakeClock();
  return createRpgWfsClient({ fetchImpl, now, sleep, minIntervalMs: 0, ...options });
};

describe("createRpgWfsClient", () => {
  it("interroge la couche du millésime par emprise explicite en CRS:84", async () => {
    const fetchImpl = vi.fn(async () => answer(collection([{ id: "a" }], { numberMatched: 1 })));

    const result = await client(fetchImpl)(2025, BBOX);

    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://data.geopf.fr/wfs/ows");
    expect(url.searchParams.get("typeNames")).toBe("LANDUSE.AGRICULTURE2025:parcelles_graphiques");
    expect(url.searchParams.get("bbox")).toBe("1.6,48.2,1.61,48.21,CRS:84");
    expect(url.searchParams.get("srsName")).toBe("CRS:84");
    expect(result).toEqual({ features: [{ id: "a" }], tronque: false });
  });

  it("garde le nommage historique des millésimes antérieurs", async () => {
    const fetchImpl = vi.fn(async () => answer(collection()));
    await client(fetchImpl)(2024, BBOX);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("typeNames")).toBe("RPG.2024:parcelles_graphiques");
  });

  it("signale une réponse tronquée", async () => {
    const fetchImpl = vi.fn(async () => answer(collection([{ id: "a" }], { numberMatched: 40 })));
    expect((await client(fetchImpl)(2025, BBOX)).tronque).toBe(true);
  });

  it("réessaie une fois après une erreur 5xx", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(answer("indisponible", 503))
      .mockResolvedValueOnce(answer(collection()));
    await expect(client(fetchImpl)(2025, BBOX)).resolves.toEqual({ features: [], tronque: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("espace les requêtes pour rester sous la limite de débit du WFS", async () => {
    // Horloge figée : chaque appel concurrent doit attendre un créneau plus éloigné.
    const sleeps = [];
    const sleep = async (ms) => {
      sleeps.push(ms);
    };
    const fetchImpl = vi.fn(async () => answer(collection()));
    const fetchRpg = client(fetchImpl, { now: () => 1_000, sleep, minIntervalMs: 60 });

    await Promise.all([fetchRpg(2025, BBOX), fetchRpg(2024, BBOX), fetchRpg(2023, BBOX)]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([60, 120]);
  });

  it("respecte Retry-After après un 429, puis aboutit", async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(answer("trop", 429, { "retry-after": "4" }))
      .mockResolvedValueOnce(answer(collection()));

    await expect(client(fetchImpl, clock)(2025, BBOX)).resolves.toEqual({ features: [], tronque: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleeps).toEqual([4000]);
  });

  it("un 429 suspend aussi les autres requêtes du processus", async () => {
    const clock = fakeClock();
    const times = [];
    const fetchImpl = vi.fn(async () => {
      times.push(clock.now());
      return times.length === 1 ? answer("trop", 429, { "retry-after": "5" }) : answer(collection());
    });
    const fetchRpg = client(fetchImpl, clock);

    await fetchRpg(2025, BBOX);
    await fetchRpg(2024, BBOX);

    expect(times[1] - times[0]).toBe(5000);
    expect(times[2] - times[0]).toBe(5000);
  });

  it("abandonne après plusieurs 429, ou si l'attente demandée est déraisonnable", async () => {
    const repeated = vi.fn(async () => answer("trop", 429, { "retry-after": "1" }));
    await expect(client(repeated)(2025, BBOX)).rejects.toMatchObject({ code: WFS_ERROR_CODES.HTTP, status: 429 });
    expect(repeated).toHaveBeenCalledTimes(4);

    const tooLong = vi.fn(async () => answer("trop", 429, { "retry-after": "3600" }));
    await expect(client(tooLong)(2025, BBOX)).rejects.toMatchObject({ status: 429 });
    expect(tooLong).toHaveBeenCalledTimes(1);
  });

  it("ne réessaie pas une erreur 400, qui se reproduirait à l'identique", async () => {
    const fetchImpl = vi.fn(async () => answer("<ows:ExceptionReport/>", 400));
    await expect(client(fetchImpl)(2025, BBOX)).rejects.toMatchObject({ code: WFS_ERROR_CODES.HTTP, status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuse une erreur XML livrée avec un statut 200", async () => {
    const fetchImpl = vi.fn(async () => answer("<ows:ExceptionReport/>"));
    await expect(client(fetchImpl)(2025, BBOX)).rejects.toMatchObject({ code: WFS_ERROR_CODES.INVALID_RESPONSE });
  });

  it("refuse un JSON sans liste de parcelles", async () => {
    const fetchImpl = vi.fn(async () => answer(JSON.stringify({ message: "?" })));
    await expect(client(fetchImpl)(2025, BBOX)).rejects.toMatchObject({ code: WFS_ERROR_CODES.INVALID_RESPONSE });
  });

  it("distingue une panne réseau d'un dépassement de délai", async () => {
    const reseau = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client(reseau, { retries: 0 })(2025, BBOX)).rejects.toMatchObject({ code: WFS_ERROR_CODES.NETWORK });

    const lent = vi.fn(
      (_url, { signal }) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
    );
    await expect(client(lent, { retries: 0, timeoutMs: 5 })(2025, BBOX)).rejects.toMatchObject({
      code: WFS_ERROR_CODES.TIMEOUT,
    });
  });
});
