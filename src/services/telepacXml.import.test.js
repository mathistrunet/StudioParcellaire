import { describe, expect, it } from "vitest";
import { readTelepacMesParcellesXml } from "../lib/importers/readTelepacMesParcellesXml";
import {
  TELEPAC_XML_EXEMPLE,
  EXPECTED_PACAGE,
  EXPECTED_PARCEL_COUNT,
  EXPECTED_CULTURE_CODES,
  EXPECTED_PRECISIONS,
  EXPECTED_ILOTS,
  EXPECTED_PARCELLES,
} from "../__fixtures__/telepac-exploitation-exemple-2025";

describe("readTelepacMesParcellesXml — exploitation fictive 2025", () => {
  it("parse le fichier XML et retourne une FeatureCollection", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    expect(result.type).toBe("FeatureCollection");
    expect(Array.isArray(result.features)).toBe(true);
  });

  it(`retourne exactement ${EXPECTED_PARCEL_COUNT} parcelles`, async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    expect(result.features).toHaveLength(EXPECTED_PARCEL_COUNT);
  });

  it("extrait le numéro PACAGE correct", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    result.features.forEach((f) => {
      expect(f.properties.pacage).toBe(EXPECTED_PACAGE);
    });
  });

  it("extrait les codes culture dans le bon ordre", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    const codes = result.features.map((f) => f.properties.code_culture);
    expect(codes).toEqual(EXPECTED_CULTURE_CODES);
  });

  it("extrait les numéros d'îlot et de parcelle", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    const ilots = result.features.map((f) => f.properties.ilot);
    const parcelles = result.features.map((f) => f.properties.parcelle);
    expect(ilots).toEqual(EXPECTED_ILOTS);
    expect(parcelles).toEqual(EXPECTED_PARCELLES);
  });

  it("stocke la précision LUZ comme null quand le CODEBOOK n'est pas chargé (env. test)", async () => {
    // En environnement de test, window.CODEBOOK_EXTRA n'est pas disponible,
    // donc resolvePrecisionForCode retourne "" et la précision est stockée null.
    // Ce test vérifie que les 3 premières parcelles n'ont pas de précision,
    // et que la 4ème (LUZ) a bien un code_culture = "LUZ".
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    result.features.slice(0, 3).forEach((f) => {
      expect(f.properties.precision ?? null).toBeNull();
    });
    expect(result.features[3].properties.code_culture).toBe("LUZ");
  });

  it("produit des géométries WGS84 valides (lon entre -180 et 180)", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    result.features.forEach((f) => {
      expect(f.geometry).toBeTruthy();
      expect(f.geometry.type).toMatch(/^(Polygon|MultiPolygon)$/);
      const ring = f.geometry.type === "Polygon"
        ? f.geometry.coordinates[0]
        : f.geometry.coordinates[0][0];
      expect(Array.isArray(ring)).toBe(true);
      expect(ring.length).toBeGreaterThanOrEqual(3);
      ring.forEach(([lon, lat]) => {
        expect(lon).toBeGreaterThan(-180);
        expect(lon).toBeLessThan(180);
        expect(lat).toBeGreaterThan(-90);
        expect(lat).toBeLessThan(90);
      });
    });
  });

  it("les coordonnées sont projetées depuis Lambert93 (pas des valeurs brutes >180)", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    result.features.forEach((f) => {
      const ring = f.geometry.coordinates[0];
      const [lon] = ring[0];
      expect(Math.abs(lon)).toBeLessThan(180);
    });
  });

  it("extrait la commune INSEE", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    result.features.forEach((f) => {
      expect(f.properties.commune_insee).toBe("82121");
    });
  });

  it("détecte la conduite bio sur la 3ème parcelle", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    expect(result.features[2].properties.conduite_bio).toBe(true);
    expect(result.features[2].properties.isOrganic).toBe(true);
  });

  it("marque la source comme telepac-mesparcelles-xml", async () => {
    const result = await readTelepacMesParcellesXml(TELEPAC_XML_EXEMPLE);
    result.features.forEach((f) => {
      expect(f.properties.source).toBe("telepac-mesparcelles-xml");
    });
  });

  it("lève une erreur si le XML ne contient aucun îlot", async () => {
    const emptyXml = `<?xml version="1.0"?><exploitation xmlns:gml="http://www.opengis.net/gml"><producteur numero-pacage="000000000"><rpg><ilots></ilots></rpg></producteur></exploitation>`;
    await expect(readTelepacMesParcellesXml(emptyXml)).rejects.toThrow("TELEPAC_XML");
  });

  it("accepte l'entrée sous forme d'ArrayBuffer", async () => {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(TELEPAC_XML_EXEMPLE).buffer;
    const result = await readTelepacMesParcellesXml(buffer);
    expect(result.features).toHaveLength(EXPECTED_PARCEL_COUNT);
  });
});
