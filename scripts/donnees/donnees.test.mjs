import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { creerCacheDisque } from "./cache-disque.mjs";
import { DonneesInvalides, lireEmprise } from "./couches.mjs";
import { creerClientGeoplateforme, urlAltitudes, urlObjets } from "./geoplateforme.mjs";
import { creerRoutesDonnees } from "./routes.mjs";
import { creerServiceParcelles } from "./fiche-parcelle.mjs";

const EMPRISE = [1.6, 48.2, 1.61, 48.21];
const BBOX = EMPRISE.join(",");

const grille = (n, valeur = 120.5) => {
  const buffer = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) buffer.writeFloatLE(valeur, i * 4);
  return buffer;
};
const reponse = (contenu, { status = 200, headers = {} } = {}) =>
  new Response(typeof contenu === "string" ? contenu : new Uint8Array(contenu), { status, headers });
const collection = (features, numberMatched = features.length) =>
  JSON.stringify({ type: "FeatureCollection", features, numberMatched });

let dossiers = [];
const dossierTemporaire = async () => {
  const dossier = await mkdtemp(path.join(tmpdir(), "donnees-"));
  dossiers.push(dossier);
  return dossier;
};
afterEach(async () => {
  await Promise.all(dossiers.map((dossier) => rm(dossier, { recursive: true, force: true })));
  dossiers = [];
});

describe("lireEmprise", () => {
  it("accepte ouest,sud,est,nord", () => {
    expect(lireEmprise(BBOX)).toEqual(EMPRISE);
  });
  it.each([
    [null, "manquant"],
    ["1,2,3", "quatre nombres"],
    ["1.61,48.2,1.6,48.21", "inversée"],
    ["181,48,182,49", "limites"],
    ["1,48,1.5,48.1", "trop grande"],
  ])("refuse %s", (brut, message) => {
    expect(() => lireEmprise(brut)).toThrow(DonneesInvalides);
    expect(() => lireEmprise(brut)).toThrow(message);
  });
});

describe("URL de la GéoPlateforme", () => {
  it("met la latitude d'abord en WMS 1.3.0", () => {
    const url = new URL(urlAltitudes({ couche: "C", emprise: EMPRISE, largeur: 2, hauteur: 3 }));
    expect(url.searchParams.get("BBOX")).toBe("48.2,1.6,48.21,1.61");
    expect(url.searchParams.get("FORMAT")).toBe("image/x-bil;bits=32");
  });
  it("ajoute CRS:84 à la bbox WFS", () => {
    const url = new URL(urlObjets({ typeName: "T", emprise: EMPRISE, max: 10 }));
    expect(url.searchParams.get("bbox")).toBe(`${BBOX},CRS:84`);
  });
});

describe("cache disque", () => {
  it("relit ce qui a été écrit, puis l'oublie après expiration", async () => {
    let maintenant = Date.now();
    const cache = creerCacheDisque({ dossier: await dossierTemporaire(), dureeJours: 1, maintenant: () => maintenant });
    expect(await cache.lire("a")).toBeNull();
    await cache.ecrire("a", Buffer.from("bonjour"));
    expect((await cache.lire("a")).toString()).toBe("bonjour");
    maintenant += 2 * 24 * 3600 * 1000;
    expect(await cache.lire("a")).toBeNull();
  });
});

describe("client GéoPlateforme", () => {
  it("valide la grille, la met en cache et ne la retélécharge pas", async () => {
    const fetchImpl = vi.fn(async () => reponse(grille(6)));
    const cache = creerCacheDisque({ dossier: await dossierTemporaire() });
    const client = creerClientGeoplateforme({ cache, fetchImpl });
    const demande = { couche: "C", emprise: EMPRISE, largeur: 2, hauteur: 3 };
    expect((await client.altitudes(demande)).byteLength).toBe(24);
    expect((await client.altitudes(demande)).readFloatLE(0)).toBeCloseTo(120.5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ne met jamais en cache un message d'erreur servi en 200", async () => {
    const fetchImpl = vi.fn(async () => reponse("<ServiceException>Couche inconnue</ServiceException>"));
    const cache = creerCacheDisque({ dossier: await dossierTemporaire() });
    const client = creerClientGeoplateforme({ cache, fetchImpl, reprises: 0 });
    const demande = { couche: "C", emprise: EMPRISE, largeur: 2, hauteur: 3 };
    await expect(client.altitudes(demande)).rejects.toThrow("taille inattendue");
    expect(await cache.lire(urlAltitudes(demande))).toBeNull();
  });

  it("ne télécharge qu'une fois deux demandes simultanées", async () => {
    const fetchImpl = vi.fn(async () => reponse(collection([{ type: "Feature" }])));
    const client = creerClientGeoplateforme({ fetchImpl });
    const demande = { typeName: "T", emprise: EMPRISE, max: 10 };
    const [a, b] = await Promise.all([client.objets(demande), client.objets(demande)]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("signale une liste tronquée", async () => {
    const client = creerClientGeoplateforme({ fetchImpl: async () => reponse(collection([{ type: "Feature" }], 12)) });
    expect(await client.objets({ typeName: "T", emprise: EMPRISE, max: 1 })).toMatchObject({ tronque: true });
  });

  it("attend puis réessaie après un 429", async () => {
    const dormir = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reponse("", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(reponse(collection([])));
    const client = creerClientGeoplateforme({ fetchImpl, dormir });
    await client.objets({ typeName: "T", emprise: EMPRISE, max: 1 });
    expect(dormir).toHaveBeenCalledWith(2000);
  });

  it("ne réessaie pas une requête refusée (400)", async () => {
    const fetchImpl = vi.fn(async () => reponse("", { status: 400 }));
    const client = creerClientGeoplateforme({ fetchImpl, dormir: async () => {} });
    await expect(client.objets({ typeName: "T", emprise: EMPRISE, max: 1 })).rejects.toThrow("HTTP 400");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("limite le nombre de téléchargements simultanés", async () => {
    let actifs = 0;
    let pic = 0;
    const fetchImpl = async () => {
      actifs += 1;
      pic = Math.max(pic, actifs);
      await new Promise((resolve) => setTimeout(resolve, 5));
      actifs -= 1;
      return reponse(collection([]));
    };
    const client = creerClientGeoplateforme({ fetchImpl, maxParalleles: 2 });
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.objets({ typeName: `T${i}`, emprise: EMPRISE, max: 1 }))
    );
    expect(pic).toBe(2);
  });
});

describe("routes /api/v1", () => {
  const fetchImpl = vi.fn();
  const signalerErreur = vi.fn();
  let serveur;
  let base;

  beforeAll(async () => {
    const router = creerRoutesDonnees({
      client: creerClientGeoplateforme({ fetchImpl, reprises: 0 }),
      parcelles: {
        lister: async (options) => ({ type: "FeatureCollection", features: [{ id: "p1" }], options }),
        lire: async (id) => (id === "p1" ? { type: "Feature", id } : null),
      },
      signalerErreur,
    });
    serveur = http.createServer(async (req, res) => {
      const traite = await router(req, res, new URL(req.url, "http://localhost"));
      if (!traite) res.writeHead(404).end();
    });
    await new Promise((resolve) => serveur.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${serveur.address().port}`;
  });
  afterAll(() => new Promise((resolve) => serveur.close(resolve)));
  afterEach(() => fetchImpl.mockReset());

  it("sert les fiches parcelles avec leurs options", async () => {
    const res = await fetch(`${base}/api/v1/parcelles?annee=2025&historique=7&rpg=non`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ features: [{ id: "p1" }], options: { annee: 2025, historique: 7, rpg: false } });
    const defaut = await (await fetch(`${base}/api/v1/parcelles`)).json();
    expect(defaut.options).toEqual({ annee: null, historique: 5, rpg: true });
  });

  it("sert une fiche par identifiant, 404 si elle est inconnue", async () => {
    expect((await fetch(`${base}/api/v1/parcelles/p1`)).status).toBe(200);
    const absente = await fetch(`${base}/api/v1/parcelles/p9`);
    expect(absente.status).toBe(404);
    expect(await absente.json()).toMatchObject({ code: "PARCELLE_INCONNUE" });
  });

  it("sert une grille d'altitude en binaire", async () => {
    fetchImpl.mockResolvedValueOnce(reponse(grille(4, 87)));
    const res = await fetch(`${base}/api/v1/terrain?couche=mnt-lidar&bbox=${BBOX}&largeur=2&hauteur=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const valeurs = new Float32Array(await res.arrayBuffer());
    expect([...valeurs]).toEqual([87, 87, 87, 87]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("IGNF_LIDAR-HD_MNT");
  });

  it("sert le RPG d'une année et les objets BD TOPO", async () => {
    fetchImpl.mockImplementation(async () => reponse(collection([{ type: "Feature" }])));
    const rpg = await fetch(`${base}/api/v1/rpg?annee=2025&bbox=${BBOX}`);
    expect((await rpg.json()).features).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("LANDUSE.AGRICULTURE2025");
    const bati = await fetch(`${base}/api/v1/bdtopo?couche=batiments&bbox=${BBOX}`);
    expect(bati.status).toBe(200);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("BDTOPO_V3%3Abatiment");
  });

  it.each([
    [`/api/v1/terrain?couche=inconnue&bbox=${BBOX}&largeur=2&hauteur=2`, "couche inconnue"],
    [`/api/v1/terrain?couche=srtm&bbox=${BBOX}&largeur=5000&hauteur=2`, "largeur"],
    [`/api/v1/rpg?annee=2014&bbox=${BBOX}`, "millésime"],
    [`/api/v1/bdtopo?couche=__proto__&bbox=${BBOX}`, "couche inconnue"],
    ["/api/v1/bdtopo?couche=routes", "bbox"],
    ["/api/v1/parcelles?historique=9", "historique"],
    ["/api/v1/parcelles?rpg=peut-etre", "rpg"],
  ])("refuse %s en 400 sans appeler l'IGN", async (chemin, message) => {
    const res = await fetch(`${base}${chemin}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("répond 502 quand la GéoPlateforme échoue", async () => {
    fetchImpl.mockResolvedValueOnce(reponse("", { status: 503 }));
    const res = await fetch(`${base}/api/v1/bdtopo?couche=routes&bbox=${BBOX}`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "IGN_INDISPONIBLE" });
    expect(signalerErreur).toHaveBeenCalled();
  });

  it("refuse les autres méthodes et laisse passer les autres routes", async () => {
    expect((await fetch(`${base}/api/v1/parcelles`, { method: "PUT" })).status).toBe(405);
    expect((await fetch(`${base}/api/v1/enrich`)).status).toBe(404);
  });
});


describe("fiche parcelle", () => {
  // Carré d'environ 1,1 ha près de Foix ; le RPG de test a une parcelle identique.
  const carre = (x = 1.9) => ({
    type: "Polygon",
    coordinates: [[[x, 43], [x + 0.001, 43], [x + 0.001, 43.001], [x, 43.001], [x, 43]]],
  });
  const parcelle = (properties, geometry = carre()) => ({ type: "Feature", geometry, properties });
  const libelleCulture = (code) => ({ BTH: "Blé tendre d'hiver", MIS: "Maïs", PTR: "Prairie temporaire" })[code] ?? null;
  const rpgParAnnee = { 2025: "PTR", 2024: "MIS", 2023: "BTH", 2022: "MIS" };
  const clientRpg = (options = {}) => ({
    objets: vi.fn(async ({ typeName }) => {
      const annee = Number(typeName.match(/(\d{4})/)[1]);
      if (options.panne === annee) throw new Error("HTTP 503");
      const code = rpgParAnnee[annee];
      return {
        features: code ? [{ type: "Feature", geometry: carre(), properties: { code_cultu: code, ...(annee === 2025 ? { bio: "true" } : {}) } }] : [],
        tronque: false,
      };
    }),
  });
  const service = (features, client = clientRpg()) =>
    creerServiceParcelles({ lireParcellaire: async () => ({ type: "FeatureCollection", features }), client, libelleCulture });

  it("lit les alias du parcellaire et rend toujours les mêmes champs", async () => {
    const telepac = parcelle({
      id: "a", annee: 2025, nom_affiche: "1-1", code_culture: "PTR", isOrganic: true, organicType: "AB",
      pacage: "009009507", ilot_numero: 1, numero: 1, commune_insee: "09161", cultureN1: "MIS",
    });
    const resultat = await service([telepac]).lister({ historique: 2, rpg: false });
    expect(resultat).toMatchObject({ annee: 2025, annees_disponibles: [2025] });
    expect(resultat.features[0].properties).toMatchObject({
      id: "a", nom: "1-1", surface_source: "calculee", bio: true, type_bio: "AB", bio_source: "parcellaire",
      culture: { code: "PTR", libelle: "Prairie temporaire" },
      telepac: { pacage: "009009507", ilot: "1", numero: "1", commune_insee: "09161" },
      historique: [
        { annee: 2025, code: "PTR", source: "parcellaire" },
        { annee: 2024, code: "MIS", libelle: "Maïs", source: "parcellaire" },
      ],
    });
    expect(resultat.features[0].properties.surface_ha).toBeGreaterThan(0.8);
  });

  it("préfère la surface saisie et comprend un CSV Assolia", async () => {
    const csv = parcelle({ id: "b", annee: 2025, nom: "Les Grissets", surface_parcelle: "4,25", parcelle_bio: "Non", cultureN: "BTH|001" });
    const { properties } = (await service([csv]).lister({ historique: 1, rpg: false })).features[0];
    expect(properties).toMatchObject({ nom: "Les Grissets", surface_ha: 4.25, surface_source: "saisie", bio: false });
    expect(properties.culture).toEqual({ code: "BTH", precision: "001", libelle: "Blé tendre d'hiver" });
  });

  it("complète l'historique par le RPG et signale les écarts avec la saisie", async () => {
    const saisie = parcelle({ id: "c", annee: 2025, code_culture: "PTR", cultureN_1: "BTH" });
    const { properties } = (await service([saisie]).lister({ historique: 5 })).features[0];
    expect(properties.historique.map(({ annee, code, source }) => [annee, code, source])).toEqual([
      [2025, "PTR", "parcellaire"],
      [2024, "BTH", "parcellaire"],
      [2023, "BTH", "rpg"],
      [2022, "MIS", "rpg"],
      [2021, null, "inconnue"],
    ]);
    expect(properties.historique[1].ecart_rpg).toEqual({ code: "MIS", libelle: "Maïs" });
    expect(properties).toMatchObject({ bio: true, bio_source: "rpg" });
  });

  it("garde la fiche quand une année RPG est indisponible", async () => {
    const saisie = parcelle({ id: "d", annee: 2025, code_culture: "PTR" });
    const { properties } = (await service([saisie], clientRpg({ panne: 2024 })).lister({ historique: 3 })).features[0];
    expect(properties.historique[1]).toMatchObject({ annee: 2024, source: "inconnue" });
    expect(properties.historique[2]).toMatchObject({ annee: 2023, source: "rpg" });
    expect(properties.avertissements).toEqual([{ code: "RPG_INDISPONIBLE", message: "RPG 2024 non lu : HTTP 503." }]);
  });

  it("lit le RPG une fois par année pour des parcelles voisines", async () => {
    const client = clientRpg();
    const voisines = [1.9, 1.902, 1.904].map((x, i) => parcelle({ id: `v${i}`, annee: 2025 }, carre(x)));
    await service(voisines, client).lister({ historique: 3 });
    expect(client.objets).toHaveBeenCalledTimes(3);
  });

  it("choisit l'année la plus récente, filtre par année et par identifiant", async () => {
    const features = [parcelle({ id: "x", annee: 2024 }), parcelle({ id: "y", annee: 2025 }), parcelle({ id: "z", annee: 2025 })];
    const parcelles = service(features);
    expect((await parcelles.lister({ rpg: false })).features.map((f) => f.id)).toEqual(["y", "z"]);
    expect((await parcelles.lister({ annee: 2024, rpg: false })).features.map((f) => f.id)).toEqual(["x"]);
    expect((await parcelles.lire("z", { rpg: false })).id).toBe("z");
    expect(await parcelles.lire("x", { rpg: false })).toBeNull();
    await expect(parcelles.lister({ annee: 2019 })).rejects.toThrow("Années disponibles : 2025, 2024");
  });
});
