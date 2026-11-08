import { readFile } from "node:fs/promises";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEnrichHandler } from "./enrich-route.mjs";
import { CULTURE_STATUTS, ENRICH_STATUTS, enrichParcelle } from "./enrich-service.mjs";
import { WFS_ERROR_CODES, WfsError } from "./rpg-wfs-client.mjs";

const MAX_BODY_BYTES = 4096;
const CONTOUR = {
  type: "Polygon",
  coordinates: [[[1.6, 48.2], [1.602, 48.2], [1.602, 48.202], [1.6, 48.202], [1.6, 48.2]]],
};

const fetchRpgFeatures = vi.fn();
const onError = vi.fn();
let server;
let baseUrl;

const post = (body) =>
  fetch(`${baseUrl}/api/v1/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  const handle = createEnrichHandler({
    enrich: (request) => enrichParcelle(request, { fetchRpgFeatures, lookupToponym: async () => "La Plaine" }),
    maxBodyBytes: MAX_BODY_BYTES,
    onError,
  });
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

const found = () => ({
  features: [
    {
      type: "Feature",
      geometry: CONTOUR,
      properties: { num_parcel: "1", surf_parc: 4, code_cultu: "MIS", code_group: "2", precision: "001", bio: false },
    },
  ],
  tronque: false,
});

describe("POST /api/v1/enrich", () => {
  it("renvoie 200 et le résultat", async () => {
    fetchRpgFeatures.mockResolvedValueOnce(found());
    const response = await post({ geometry: CONTOUR, millesimes: [2025] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ statut: "ok", nom: "La Plaine", bio: false });
  });

  it("renvoie 200 avec un statut explicite quand rien ne correspond", async () => {
    fetchRpgFeatures.mockResolvedValueOnce({ features: [], tronque: false });
    const response = await post({ geometry: CONTOUR, millesimes: [2025] });
    expect(response.status).toBe(200);
    expect((await response.json()).statut).toBe("aucune_correspondance");
  });

  it("renvoie 400 avec un code stable pour un corps invalide", async () => {
    const invalid = await post("{pas du json");
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("JSON_INVALIDE");

    const noGeometry = await post({ millesimes: [2025] });
    expect(noGeometry.status).toBe(400);
    expect((await noGeometry.json()).code).toBe("GEOMETRIE_INVALIDE");
  });

  it("renvoie 413 au-delà de la limite de taille", async () => {
    const response = await post({ geometry: CONTOUR, millesimes: [2025], remplissage: "x".repeat(MAX_BODY_BYTES) });
    expect(response.status).toBe(413);
  });

  it("renvoie 405 pour une autre méthode et répond au préflight", async () => {
    expect((await fetch(`${baseUrl}/api/v1/enrich`)).status).toBe(405);
    expect((await fetch(`${baseUrl}/api/v1/enrich`, { method: "OPTIONS" })).status).toBe(204);
  });

  it("renvoie 502 ou 504 si le WFS ne permet aucune lecture", async () => {
    fetchRpgFeatures.mockRejectedValueOnce(new WfsError(WFS_ERROR_CODES.HTTP, "HTTP 500", { status: 500 }));
    const down = await post({ geometry: CONTOUR, millesimes: [2025] });
    expect(down.status).toBe(502);
    expect((await down.json()).code).toBe("WFS_INDISPONIBLE");

    fetchRpgFeatures.mockRejectedValueOnce(new WfsError(WFS_ERROR_CODES.TIMEOUT, "délai"));
    const slow = await post({ geometry: CONTOUR, millesimes: [2025] });
    expect(slow.status).toBe(504);
    expect((await slow.json()).code).toBe("WFS_TIMEOUT");
  });

  it("renvoie 500 sans détail interne pour une erreur imprévue", async () => {
    fetchRpgFeatures.mockRejectedValueOnce(new TypeError("détail interne"));
    const response = await post({ geometry: CONTOUR, millesimes: [2025] });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Erreur interne du serveur.", code: "ERREUR_INTERNE" });
    expect(onError).toHaveBeenCalled();
  });
});

describe("contrat OpenAPI", () => {
  let spec;
  beforeAll(async () => {
    spec = JSON.parse(await readFile(new URL("../../docs/api/openapi-v1.json", import.meta.url), "utf-8"));
  });

  /** Vérifie un objet contre un schéma plat : champs requis présents, aucun champ non documenté. */
  const expectMatchesSchema = (value, schema) => {
    for (const key of schema.required) expect(value, `champ requis ${key}`).toHaveProperty(key);
    for (const key of Object.keys(value)) expect(Object.keys(schema.properties), `champ ${key}`).toContain(key);
  };

  it("est versionné et décrit l'endpoint", () => {
    expect(spec.info.version).toMatch(/^1\./);
    const operation = spec.paths["/api/v1/enrich"].post;
    for (const status of ["200", "400", "413", "502", "504"]) expect(operation.responses).toHaveProperty(status);
  });

  it("annonce les mêmes statuts que le service", () => {
    const { EnrichResponse, CultureMillesime } = spec.components.schemas;
    expect(EnrichResponse.properties.statut.enum).toEqual([...ENRICH_STATUTS]);
    expect(CultureMillesime.properties.statut.enum).toEqual([...CULTURE_STATUTS]);
    expect(CultureMillesime.properties.erreur.enum.sort()).toEqual(Object.values(WFS_ERROR_CODES).sort());
  });

  it("décrit fidèlement une réponse réelle", async () => {
    fetchRpgFeatures
      .mockResolvedValueOnce(found())
      .mockRejectedValueOnce(new WfsError(WFS_ERROR_CODES.HTTP, "HTTP 500", { status: 500 }))
      .mockResolvedValueOnce({ features: [], tronque: true });
    const response = await post({ geometry: CONTOUR, millesimes: [2025, 2024, 2023, 2014] });
    const body = await response.json();
    const { EnrichResponse, CultureMillesime } = spec.components.schemas;

    expectMatchesSchema(body, EnrichResponse);
    Object.values(body.cultures).forEach((culture) => expectMatchesSchema(culture, CultureMillesime));
    expect(body.irrigable).toBeNull();
    expect(body.type_sol).toBeNull();
    expect(body.avertissements[0].code).toBe("RPG_TRONQUE");
  });

  it("annonce les champs d'entrée réellement lus", () => {
    const { properties, required } = spec.components.schemas.EnrichRequest;
    expect(Object.keys(properties).sort()).toEqual(["geometry", "inclure_nom", "millesimes"]);
    expect(required).toEqual(["geometry", "millesimes"]);
  });
});
