import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { creerCacheDisque } from "./cache-disque.mjs";
import { DonneesInvalides } from "./couches.mjs";
import {
  MeteoIndisponible,
  ajouterJours,
  calculerNormales,
  creerClientMeteo,
  lireDemandeMeteo,
  urlArchive,
} from "./meteo.mjs";
import { creerRoutesDonnees } from "./routes.mjs";

const AUJOURDHUI = "2026-11-10";

/** Réponse Open-Meteo de debut à fin ; `valeur(date)` donne { tmin, tmax, pluie } ou null. */
function archive(debut, fin, valeur) {
  const daily = { time: [], temperature_2m_min: [], temperature_2m_max: [], precipitation_sum: [] };
  for (let date = debut; date <= fin; date = ajouterJours(date, 1)) {
    const jour = valeur(date);
    daily.time.push(date);
    daily.temperature_2m_min.push(jour?.tmin ?? null);
    daily.temperature_2m_max.push(jour?.tmax ?? null);
    daily.precipitation_sum.push(jour?.pluie ?? null);
  }
  return JSON.stringify({ latitude: 48.2, longitude: 1.6, elevation: 134, daily });
}

/** Faux Open-Meteo : normales à 2/12 °C, mesures à 5/15 °C sauf les jours `trous`. */
function fauxOpenMeteo({ trous = [] } = {}) {
  const appels = [];
  const fetchImpl = async (url) => {
    appels.push(url);
    const params = new URL(url).searchParams;
    const debut = params.get("start_date");
    const fin = params.get("end_date");
    const normales = debut.startsWith("2015");
    return new Response(
      archive(debut, fin, (date) =>
        normales ? { tmin: 2, tmax: 12, pluie: 1 } : trous.includes(date) ? null : { tmin: 5, tmax: 15, pluie: 0 }
      )
    );
  };
  return { appels, fetchImpl };
}

let dossiers = [];
afterEach(async () => {
  await Promise.all(dossiers.map((dossier) => rm(dossier, { recursive: true, force: true })));
  dossiers = [];
});

describe("lireDemandeMeteo", () => {
  const demande = (texte) => lireDemandeMeteo(new URLSearchParams(texte), { aujourdhui: AUJOURDHUI });

  it("lit lat, lon, debut et fin", () => {
    expect(demande("lat=48.21&lon=1.63&debut=2025-07-01&fin=2026-11-30")).toEqual({
      lat: 48.21, lon: 1.63, debut: "2025-07-01", fin: "2026-11-30",
    });
  });

  it.each([
    ["lon=1&debut=2025-07-01&fin=2025-07-02", "lat"],
    ["lat=91&lon=1&debut=2025-07-01&fin=2025-07-02", "lat"],
    ["lat=48&lon=1&debut=2025-7-1&fin=2025-07-02", "debut"],
    ["lat=48&lon=1&debut=2025-07-02&fin=2025-07-01", "suivre"],
    ["lat=48&lon=1&debut=2020-01-01&fin=2026-01-01", "800"],
    ["lat=48&lon=1&debut=1940-01-01&fin=1940-01-02", "1950"],
    ["lat=48&lon=1&debut=2027-12-01&fin=2027-12-02", "an"],
  ])("refuse %s", (texte, message) => {
    expect(() => demande(texte)).toThrow(DonneesInvalides);
    expect(() => demande(texte)).toThrow(message);
  });
});

describe("urlArchive", () => {
  it("demande la maille au dixième de degré, en jours civils du lieu", () => {
    const url = new URL(urlArchive({ lat: 48.2, lon: 1.6, debut: "2025-07-01", fin: "2025-07-31" }));
    expect(url.origin).toBe("https://archive-api.open-meteo.com");
    expect(url.searchParams.get("latitude")).toBe("48.2");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("daily")).toContain("temperature_2m_min");
  });
});

describe("calculerNormales", () => {
  it("fait la moyenne des années et range le 29 février avec le 28", () => {
    const jours = [];
    for (let date = "2015-01-01"; date <= "2024-12-31"; date = ajouterJours(date, 1)) {
      jours.push({ date, tmin: 1, tmax: 11, pluie: 2 });
    }
    const normales = calculerNormales(jours);
    expect(normales.size).toBe(365);
    expect(normales.get("02-28")).toEqual({ tmin: 1, tmax: 11, pluie: 2 });
    expect(normales.has("02-29")).toBe(false);
  });

  it("refuse une série qui ne couvre pas toute l'année", () => {
    expect(() => calculerNormales([{ date: "2020-01-01", tmin: 1, tmax: 2, pluie: 0 }])).toThrow(MeteoIndisponible);
  });
});

describe("client météo", () => {
  it("prend les mesures jusqu'à la veille et complète par les normales", async () => {
    const { appels, fetchImpl } = fauxOpenMeteo({ trous: ["2026-11-08"] });
    const meteo = creerClientMeteo({ fetchImpl, aujourdhui: () => AUJOURDHUI });
    const serie = await meteo.serie({ lat: 48.23, lon: 1.58, debut: "2026-11-07", fin: "2026-11-12" });

    expect(serie.maille).toEqual({ lat: 48.2, lon: 1.6 });
    expect(serie.jours.map((jour) => [jour.date, jour.source, jour.tmin])).toEqual([
      ["2026-11-07", "observee", 5],
      ["2026-11-08", "normale", 2], // mesure absente
      ["2026-11-09", "observee", 5], // la veille : dernier jour mesuré
      ["2026-11-10", "normale", 2], // aujourd'hui n'est pas fini
      ["2026-11-11", "normale", 2],
      ["2026-11-12", "normale", 2],
    ]);
    const fins = appels.map((url) => new URL(url).searchParams.get("end_date"));
    expect(fins).toEqual(["2026-11-09", "2024-12-31"]);
  });

  it("ne demande pas les normales quand toutes les mesures sont là", async () => {
    const { appels, fetchImpl } = fauxOpenMeteo();
    const meteo = creerClientMeteo({ fetchImpl, aujourdhui: () => AUJOURDHUI });
    const serie = await meteo.serie({ lat: 48.2, lon: 1.6, debut: "2025-07-01", fin: "2025-07-10" });
    expect(serie.jours.every((jour) => jour.source === "observee")).toBe(true);
    expect(appels).toHaveLength(1);
  });

  it("garde les réponses en cache disque et partage la maille entre points voisins", async () => {
    const dossier = await mkdtemp(path.join(tmpdir(), "meteo-"));
    dossiers.push(dossier);
    const { appels, fetchImpl } = fauxOpenMeteo();
    const options = { fetchImpl, aujourdhui: () => AUJOURDHUI };
    const premier = creerClientMeteo({ ...options, cache: creerCacheDisque({ dossier }) });
    await premier.serie({ lat: 48.21, lon: 1.61, debut: "2025-07-01", fin: "2025-07-10" });
    const second = creerClientMeteo({ ...options, cache: creerCacheDisque({ dossier }) });
    await second.serie({ lat: 48.19, lon: 1.64, debut: "2025-07-01", fin: "2025-07-10" });
    expect(appels).toHaveLength(1);
  });

  it("signale un service injoignable ou une réponse invalide sans rien mettre en cache", async () => {
    const dossier = await mkdtemp(path.join(tmpdir(), "meteo-"));
    dossiers.push(dossier);
    const cache = creerCacheDisque({ dossier });
    const enPanne = creerClientMeteo({
      cache,
      aujourdhui: () => AUJOURDHUI,
      fetchImpl: async () => new Response(JSON.stringify({ error: true, reason: "quota" }), { status: 429 }),
    });
    await expect(enPanne.serie({ lat: 48, lon: 1, debut: "2025-07-01", fin: "2025-07-02" })).rejects.toThrow("429 : quota");
    const invalide = creerClientMeteo({ cache, aujourdhui: () => AUJOURDHUI, fetchImpl: async () => new Response("{}") });
    await expect(invalide.serie({ lat: 48, lon: 1, debut: "2025-07-01", fin: "2025-07-02" })).rejects.toThrow(MeteoIndisponible);
    expect(await cache.lire(urlArchive({ lat: 48, lon: 1, debut: "2025-07-01", fin: "2025-07-02" }))).toBeNull();
  });
});

describe("route /api/v1/meteo", () => {
  async function appeler(meteo, chemin) {
    const router = creerRoutesDonnees({ client: {}, parcelles: {}, meteo, aujourdhui: () => AUJOURDHUI });
    const serveur = http.createServer(async (req, res) => {
      if (!(await router(req, res, new URL(req.url, "http://localhost")))) res.writeHead(404).end();
    });
    await new Promise((resolve) => serveur.listen(0, "127.0.0.1", resolve));
    try {
      const reponse = await fetch(`http://127.0.0.1:${serveur.address().port}${chemin}`);
      return { statut: reponse.status, corps: await reponse.json() };
    } finally {
      await new Promise((resolve) => serveur.close(resolve));
    }
  }

  it("renvoie la série", async () => {
    const { fetchImpl } = fauxOpenMeteo();
    const meteo = creerClientMeteo({ fetchImpl, aujourdhui: () => AUJOURDHUI });
    const { statut, corps } = await appeler(meteo, "/api/v1/meteo?lat=48.2&lon=1.6&debut=2025-07-01&fin=2025-07-03");
    expect(statut).toBe(200);
    expect(corps.jours).toHaveLength(3);
    expect(corps.licence).toContain("Open-Meteo");
  });

  it("répond 400 sur un paramètre faux et 502 quand le service est en panne", async () => {
    const meteo = creerClientMeteo({ aujourdhui: () => AUJOURDHUI, fetchImpl: async () => { throw new Error("hors ligne"); } });
    expect((await appeler(meteo, "/api/v1/meteo?lat=48&lon=1")).statut).toBe(400);
    const panne = await appeler(meteo, "/api/v1/meteo?lat=48&lon=1&debut=2025-07-01&fin=2025-07-02");
    expect(panne.statut).toBe(502);
    expect(panne.corps.code).toBe("METEO_INDISPONIBLE");
  });
});
