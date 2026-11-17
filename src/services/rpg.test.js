import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRpgGeoJSON, getCultureLabel, getRpgTypeName } from "./rpg";

// Propriétés réelles renvoyées par le WFS GEOPF, dans leur ordre d'origine : c'est
// `cat_cult_p`, placé avant `code_cultu`, qui faisait lire « TA » comme une culture.
const PROPS_2025 = {
  num_parcel: "5521130",
  num_ilot: "3043831",
  surf_parc: 1.2,
  cat_cult_p: "TA",
  code_cultu: "MIS",
  code_group: "2",
  culture_d1: null,
  culture_d2: null,
  precision: "001",
  gcp: true,
  pp: false,
  bio: false,
  iae: false,
};

const PROPS_2024 = {
  id_parcel: "1",
  surf_parc: 1.2,
  code_cultu: "BTH",
  code_group: "1",
  culture_d1: null,
  culture_d2: null,
  cat_cult_p: "TA",
};

describe("getRpgTypeName", () => {
  it("vise l'espace de noms propre au millésime 2025", () => {
    expect(getRpgTypeName(2025)).toBe("LANDUSE.AGRICULTURE2025:parcelles_graphiques");
  });

  it("conserve le nommage historique des millésimes antérieurs", () => {
    expect(getRpgTypeName(2024)).toBe("RPG.2024:parcelles_graphiques");
    expect(getRpgTypeName(2015)).toBe("RPG.2015:parcelles_graphiques");
  });
});

describe("fetchRpgGeoJSON", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("interroge la couche 2025 sur l'emprise demandée", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ type: "FeatureCollection", features: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRpgGeoJSON(2025, [1.3, 44, 1.4, 44.05]);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("typeNames")).toBe("LANDUSE.AGRICULTURE2025:parcelles_graphiques");
    expect(url.searchParams.get("bbox")).toBe("1.3,44,1.4,44.05,CRS:84");
  });
});

describe("getCultureLabel", () => {
  it("lit la culture principale d'une parcelle 2025, pas sa catégorie", () => {
    expect(getCultureLabel(PROPS_2025).code).toBe("MIS");
  });

  it("lit toujours la culture d'une parcelle 2024", () => {
    expect(getCultureLabel(PROPS_2024).code).toBe("BTH");
  });

  it("ne prend ni la catégorie ni une dérobée pour la culture si le code manque", () => {
    const { code, label } = getCultureLabel({
      ...PROPS_2025,
      code_cultu: null,
      culture_d1: "JAC",
    });
    expect(code).toBeNull();
    expect(label).toBe("(culture inconnue)");
  });
});
