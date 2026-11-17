import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import centroid from "@turf/centroid";
import { describe, expect, it, vi } from "vitest";
import {
  EnrichUpstreamError,
  enrichParcelle,
  validateEnrichRequest,
} from "./enrich-service.mjs";
import { WFS_ERROR_CODES, WfsError } from "./rpg-wfs-client.mjs";

const square = (lon, lat, size = 0.002) => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
});

const rpg = (geometry, properties = {}) => ({
  type: "Feature",
  geometry,
  properties: { id_parcel: "1", surf_parc: 4.2, code_cultu: "BTH", code_group: "1", ...properties },
});

// Parcelle en U : son centroïde tombe dans l'échancrure, occupée par une autre parcelle.
const U_SHAPE = {
  type: "Polygon",
  coordinates: [[
    [1.6, 48.2], [1.606, 48.2], [1.606, 48.206], [1.604, 48.206], [1.604, 48.202],
    [1.602, 48.202], [1.602, 48.206], [1.6, 48.206], [1.6, 48.2],
  ]],
};
const NOTCH = {
  type: "Polygon",
  coordinates: [[[1.6021, 48.2021], [1.6039, 48.2021], [1.6039, 48.206], [1.6021, 48.206], [1.6021, 48.2021]]],
};

const POINT = { type: "Point", coordinates: [1.601, 48.201] };

function run(body, { byYear = {}, nom = "Les Grands Champs" } = {}) {
  const fetchRpgFeatures = vi.fn(async (year) => {
    const value = byYear[year] ?? [];
    if (value instanceof Error) throw value;
    return Array.isArray(value) ? { features: value, tronque: false } : value;
  });
  const lookupToponym = vi.fn(async () => {
    if (nom instanceof Error) throw nom;
    return nom;
  });
  return {
    fetchRpgFeatures,
    lookupToponym,
    result: enrichParcelle(validateEnrichRequest(body), { fetchRpgFeatures, lookupToponym }),
  };
}

describe("enrichParcelle : point", () => {
  it("retient la parcelle qui contient le point et remplit la réponse", async () => {
    const parcelle = rpg(square(1.6, 48.2), {
      num_parcel: "2959765",
      id_parcel: undefined,
      code_cultu: "MIS",
      code_group: "2",
      precision: "001",
      bio: true,
    });
    const voisine = rpg(square(1.61, 48.21), { code_cultu: "ORP" });
    const { result, fetchRpgFeatures } = run(
      { geometry: POINT, millesimes: [2025] },
      { byYear: { 2025: [voisine, parcelle] } }
    );

    expect(await result).toEqual({
      statut: "ok",
      contour: parcelle.geometry,
      contour_millesime: 2025,
      surface_ha: 4.2,
      nom: "Les Grands Champs",
      cultures: {
        2025: {
          statut: "trouve",
          code: "MIS",
          groupe: "2",
          precision: "001",
          surface_ha: 4.2,
          id_parcelle: "2959765",
          recouvrement: null,
        },
      },
      bio: true,
      irrigable: null,
      type_sol: null,
      avertissements: [],
    });
    const [, bbox] = fetchRpgFeatures.mock.calls[0];
    expect(bbox[0]).toBeLessThan(1.601);
    expect(bbox[2]).toBeGreaterThan(1.601);
    expect(bbox[1]).toBeLessThan(48.201);
    expect(bbox[3]).toBeGreaterThan(48.201);
  });

  it("signale explicitement l'absence de parcelle, le nom restant disponible", async () => {
    const { result } = run(
      { geometry: POINT, millesimes: [2025, 2024] },
      { byYear: { 2025: [rpg(square(1.61, 48.21))] } }
    );
    expect(await result).toMatchObject({
      statut: "aucune_correspondance",
      contour: null,
      contour_millesime: null,
      surface_ha: null,
      bio: null,
      nom: "Les Grands Champs",
      cultures: {
        2025: { statut: "aucune_correspondance" },
        2024: { statut: "aucune_correspondance" },
      },
    });
  });
});

describe("enrichParcelle : contour", () => {
  it("retient la plus grande intersection de surface, pas la première parcelle touchée", async () => {
    const petite = rpg(square(1.599, 48.2), { code_cultu: "ORP" });
    const grande = rpg(square(1.6005, 48.2), { code_cultu: "MIS" });
    const { result } = run(
      { geometry: square(1.6, 48.2), millesimes: [2024] },
      { byYear: { 2024: [petite, grande] } }
    );
    const response = await result;
    expect(response.cultures[2024].code).toBe("MIS");
    expect(response.cultures[2024].recouvrement).toBeCloseTo(0.75, 2);
  });

  it("parcelle concave : retient le U alors que son centroïde tombe chez le voisin", async () => {
    const pointCentral = centroid({ type: "Feature", geometry: U_SHAPE, properties: {} });
    expect(booleanPointInPolygon(pointCentral, U_SHAPE)).toBe(false);
    expect(booleanPointInPolygon(pointCentral, NOTCH)).toBe(true);

    const { result } = run(
      { geometry: U_SHAPE, millesimes: [2025] },
      { byYear: { 2025: [rpg(NOTCH, { code_cultu: "ORP" }), rpg(U_SHAPE, { code_cultu: "BTH" })] } }
    );
    const response = await result;
    expect(response.statut).toBe("ok");
    expect(response.cultures[2025].code).toBe("BTH");
    expect(response.contour).toEqual(U_SHAPE);
    expect(response.cultures[2025].recouvrement).toBe(1);
  });

  it("écarte un voisin seulement effleuré", async () => {
    const effleuree = rpg(square(1.60195, 48.2));
    const { result } = run(
      { geometry: square(1.6, 48.2), millesimes: [2025] },
      { byYear: { 2025: [effleuree] } }
    );
    const response = await result;
    expect(response.statut).toBe("aucune_correspondance");
    expect(response.contour).toBeNull();
  });

  it("accepte un petit contour dans une grande parcelle RPG, et l'inverse", async () => {
    const grand = square(1.6, 48.2, 0.01);
    const petit = square(1.604, 48.204, 0.001);

    const dedans = await run({ geometry: petit, millesimes: [2025] }, { byYear: { 2025: [rpg(grand)] } }).result;
    expect(dedans.statut).toBe("ok");
    expect(dedans.cultures[2025].recouvrement).toBe(1);

    const autour = await run({ geometry: grand, millesimes: [2025] }, { byYear: { 2025: [rpg(petit)] } }).result;
    expect(autour.statut).toBe("ok");
    expect(autour.cultures[2025].recouvrement).toBeCloseTo(0.01, 2);
  });

  it("calcule la surface sur le contour quand surf_parc manque", async () => {
    const { result } = run(
      { geometry: square(1.6, 48.2), millesimes: [2024] },
      { byYear: { 2024: [rpg(square(1.6, 48.2), { surf_parc: null })] } }
    );
    expect((await result).surface_ha).toBeGreaterThan(3);
  });

  it("n'emprunte que l'emprise du contour pour interroger le WFS", async () => {
    const { result, fetchRpgFeatures } = run({ geometry: U_SHAPE, millesimes: [2025] });
    await result;
    expect(fetchRpgFeatures.mock.calls[0][1]).toEqual([1.6, 48.2, 1.606, 48.206]);
  });
});

describe("enrichParcelle : millésimes et bio", () => {
  const contour = square(1.6, 48.2);

  it("prend le contour et la surface du millésime le plus récent trouvé", async () => {
    const recent = rpg(square(1.6, 48.2), { surf_parc: 4.2 });
    const ancien = rpg(square(1.6, 48.2, 0.0019), { surf_parc: 3.9 });
    const { result } = run(
      { geometry: contour, millesimes: [2022, 2024, 2022] },
      { byYear: { 2024: [recent], 2022: [ancien] } }
    );
    const response = await result;
    expect(response.contour_millesime).toBe(2024);
    expect(response.surface_ha).toBe(4.2);
    expect(Object.keys(response.cultures).sort()).toEqual(["2022", "2024"]);
  });

  it("bio vaut null sans schéma qui le porte, false ou true sinon", async () => {
    const sansBio = await run({ geometry: contour, millesimes: [2024] }, { byYear: { 2024: [rpg(contour)] } }).result;
    expect(sansBio.bio).toBeNull();

    const nonBio = await run(
      { geometry: contour, millesimes: [2025, 2024] },
      { byYear: { 2025: [rpg(contour, { bio: false })], 2024: [rpg(contour)] } }
    ).result;
    expect(nonBio.bio).toBe(false);

    const bio = await run({ geometry: contour, millesimes: [2025] }, { byYear: { 2025: [rpg(contour, { bio: true })] } }).result;
    expect(bio.bio).toBe(true);
  });

  it("ne sollicite pas le WFS pour un millésime non publié", async () => {
    const { result, fetchRpgFeatures } = run(
      { geometry: contour, millesimes: [2014, 2025] },
      { byYear: { 2025: [rpg(contour)] } }
    );
    const response = await result;
    expect(response.statut).toBe("partiel");
    expect(response.cultures[2014]).toEqual({ statut: "millesime_indisponible" });
    expect(fetchRpgFeatures).toHaveBeenCalledTimes(1);
  });

  it("répercute une réponse tronquée dans les avertissements", async () => {
    const { result } = run(
      { geometry: contour, millesimes: [2025] },
      { byYear: { 2025: { features: [rpg(contour)], tronque: true } } }
    );
    expect((await result).avertissements[0].code).toBe("RPG_TRONQUE");
  });
});

describe("enrichParcelle : erreurs du WFS", () => {
  const contour = square(1.6, 48.2);
  const httpError = () => new WfsError(WFS_ERROR_CODES.HTTP, "HTTP 503", { status: 503 });
  const timeout = () => new WfsError(WFS_ERROR_CODES.TIMEOUT, "délai");

  it("répond partiellement si un millésime seulement échoue", async () => {
    const { result } = run(
      { geometry: contour, millesimes: [2025, 2024] },
      { byYear: { 2025: httpError(), 2024: [rpg(contour)] } }
    );
    const response = await result;
    expect(response.statut).toBe("partiel");
    expect(response.cultures[2025]).toEqual({ statut: "erreur_wfs", erreur: "WFS_HTTP" });
    expect(response.cultures[2024].statut).toBe("trouve");
  });

  it("reste partiel si un millésime échoue et que l'autre est vide : l'absence n'est pas établie", async () => {
    const { result } = run(
      { geometry: contour, millesimes: [2025, 2024] },
      { byYear: { 2025: httpError(), 2024: [] } }
    );
    expect((await result).statut).toBe("partiel");
  });

  it("lève une erreur 502 si tous les millésimes échouent", async () => {
    const { result } = run(
      { geometry: contour, millesimes: [2025, 2024] },
      { byYear: { 2025: httpError(), 2024: timeout() } }
    );
    await expect(result).rejects.toMatchObject({ status: 502, code: "WFS_INDISPONIBLE" });
    await expect(result).rejects.toBeInstanceOf(EnrichUpstreamError);
  });

  it("lève une erreur 504 si tous les millésimes dépassent le délai", async () => {
    const { result } = run({ geometry: contour, millesimes: [2025] }, { byYear: { 2025: timeout() } });
    await expect(result).rejects.toMatchObject({ status: 504, code: "WFS_TIMEOUT" });
  });

  it("ne maquille pas une erreur de programmation en erreur WFS", async () => {
    const { result } = run({ geometry: contour, millesimes: [2025] }, { byYear: { 2025: new TypeError("bug") } });
    await expect(result).rejects.toBeInstanceOf(TypeError);
  });
});

describe("enrichParcelle : nom", () => {
  const contour = square(1.6, 48.2);

  it("n'interroge pas la toponymie si le nom n'est pas demandé", async () => {
    const { result, lookupToponym } = run({ geometry: contour, millesimes: [2025], inclure_nom: false });
    expect((await result).nom).toBeNull();
    expect(lookupToponym).not.toHaveBeenCalled();
  });

  it("applique la règle de nommage des petites parcelles", async () => {
    const { result } = run(
      { geometry: contour, millesimes: [2025] },
      { byYear: { 2025: [rpg(contour, { surf_parc: 0.1 })] } }
    );
    expect((await result).nom).toBe("Les Grands Champs bordure");
  });

  it("une toponymie indisponible ne fait pas échouer la réponse", async () => {
    const { result } = run(
      { geometry: contour, millesimes: [2025] },
      { byYear: { 2025: [rpg(contour)] }, nom: new Error("couche absente") }
    );
    const response = await result;
    expect(response.statut).toBe("ok");
    expect(response.nom).toBeNull();
    expect(response.avertissements).toEqual([{ code: "TOPONYMIE_INDISPONIBLE", message: "couche absente" }]);
  });
});

describe("validateEnrichRequest", () => {
  const millesimes = [2025];
  const codeOf = (payload) => {
    try {
      validateEnrichRequest(payload);
    } catch (error) {
      return error.code;
    }
    return null;
  };

  it.each([
    ["corps non objet", [], "CORPS_INVALIDE"],
    ["géométrie absente", { millesimes }, "GEOMETRIE_INVALIDE"],
    ["type non pris en charge", { millesimes, geometry: { type: "LineString", coordinates: [] } }, "GEOMETRIE_INVALIDE"],
    ["latitude hors bornes", { millesimes, geometry: { type: "Point", coordinates: [1.6, 148] } }, "GEOMETRIE_INVALIDE"],
    ["coordonnée texte", { millesimes, geometry: { type: "Point", coordinates: ["1.6", 48] } }, "GEOMETRIE_INVALIDE"],
    [
      "anneau non fermé",
      { millesimes, geometry: { type: "Polygon", coordinates: [[[1, 48], [1.01, 48], [1.01, 48.01], [1, 48.01]]] } },
      "GEOMETRIE_INVALIDE",
    ],
    [
      "surface nulle",
      { millesimes, geometry: { type: "Polygon", coordinates: [[[1, 48], [1.01, 48], [1, 48], [1, 48]]] } },
      "GEOMETRIE_INVALIDE",
    ],
    ["emprise trop grande", { millesimes, geometry: square(1, 48, 0.5) }, "GEOMETRIE_TROP_ETENDUE"],
    ["millésimes absents", { geometry: POINT }, "MILLESIMES_INVALIDES"],
    ["millésimes vides", { geometry: POINT, millesimes: [] }, "MILLESIMES_INVALIDES"],
    ["millésime non entier", { geometry: POINT, millesimes: ["2025"] }, "MILLESIMES_INVALIDES"],
    ["trop de millésimes", { geometry: POINT, millesimes: Array.from({ length: 16 }, (_, i) => 2000 + i) }, "MILLESIMES_INVALIDES"],
    ["inclure_nom non booléen", { geometry: POINT, millesimes, inclure_nom: "non" }, "CORPS_INVALIDE"],
  ])("refuse : %s", (_label, payload, code) => {
    expect(codeOf(payload)).toBe(code);
  });

  it("accepte un MultiPolygon et trie les millésimes du plus récent au plus ancien", () => {
    const geometry = { type: "MultiPolygon", coordinates: [square(1.6, 48.2).coordinates] };
    expect(validateEnrichRequest({ geometry, millesimes: [2023, 2025, 2023] })).toEqual({
      geometry,
      millesimes: [2025, 2023],
      inclureNom: true,
    });
  });
});
