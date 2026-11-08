import { describe, expect, it, vi } from "vitest";
import { createToponymLookup, formatToponymName } from "./toponym-lookup.mjs";

const point = (coordinates, graphie) => ({
  geometry: { type: "Point", coordinates },
  properties: { graphie },
});

describe("createToponymLookup", () => {
  it("renvoie le toponyme le plus proche du point", async () => {
    const ensureLayer = vi.fn(async () => "/couches/toponymie.gpkg");
    const queryGeoPackageByBbox = vi.fn(async () => ({
      features: [point([1.7, 48.3], "Loin"), point([1.601, 48.201], "Proche")],
    }));
    const lookup = createToponymLookup({ ensureLayer, queryGeoPackageByBbox });

    await expect(lookup([1.6, 48.2])).resolves.toBe("Proche");
    expect(ensureLayer.mock.calls[0][0]).toBe("TOPONYMIE");
    expect(queryGeoPackageByBbox.mock.calls[0][0].filePath).toBe("/couches/toponymie.gpkg");
  });

  it("renvoie null hors de la couverture sans lire de couche", async () => {
    const ensureLayer = vi.fn();
    const lookup = createToponymLookup({ ensureLayer, queryGeoPackageByBbox: vi.fn() });
    await expect(lookup([-60, 10])).resolves.toBeNull();
    expect(ensureLayer).not.toHaveBeenCalled();
  });

  it("renvoie null si la couche n'existe pas", async () => {
    const lookup = createToponymLookup({ ensureLayer: async () => null, queryGeoPackageByBbox: vi.fn() });
    await expect(lookup([1.6, 48.2])).resolves.toBeNull();
  });

  it("n'attend pas indéfiniment une couche en cours de téléchargement", async () => {
    const lookup = createToponymLookup({
      ensureLayer: () => new Promise(() => {}),
      queryGeoPackageByBbox: vi.fn(),
      timeoutMs: 5,
    });
    await expect(lookup([1.6, 48.2])).rejects.toThrow("délai");
  });
});

describe("formatToponymName", () => {
  it("garde le nom d'une parcelle ordinaire et qualifie une petite parcelle", () => {
    expect(formatToponymName("La Plaine", 4)).toBe("La Plaine");
    expect(formatToponymName("La Plaine", 0.1)).toBe("La Plaine bordure");
  });
});
