// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { parseParcellesCsvToFeatures, buildParcellesCsv } from "./parcellesCsv";
import {
  EXEMPLE_CSV_TEXT,
  EXEMPLE_CSV_EXPECTED_COUNT,
  EXEMPLE_CSV_EXPECTED_NAMES,
  EXEMPLE_CSV_EXPECTED_SURFACES,
} from "../__fixtures__/exploitation-exemple-2025.csv.js";

// parseParcellesCsvToFeatures uses FileReader — File is available in jsdom
function makeFile(text, name = "test.csv") {
  return new File([text], name, { type: "text/csv" });
}

describe("parseParcellesCsvToFeatures — fixture exploitation fictive 2025", () => {
  it(`parse exactement ${EXEMPLE_CSV_EXPECTED_COUNT} parcelles`, async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    expect(features).toHaveLength(EXEMPLE_CSV_EXPECTED_COUNT);
  });

  it("extrait les noms de parcelles", async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    const names = features.map((f) => f.properties.nom);
    expect(names).toEqual(EXEMPLE_CSV_EXPECTED_NAMES);
  });

  it("extrait les surfaces", async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    const surfaces = features.map((f) => f.properties.surface_parcelle);
    expect(surfaces).toEqual(EXEMPLE_CSV_EXPECTED_SURFACES);
  });

  it("produit des géométries Polygon WGS84 valides", async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    features.forEach((f) => {
      expect(f.type).toBe("Feature");
      expect(f.geometry.type).toBe("Polygon");
      const ring = f.geometry.coordinates[0];
      expect(ring.length).toBeGreaterThanOrEqual(4);
      ring.forEach(([lon, lat]) => {
        expect(lon).toBeGreaterThan(-180);
        expect(lon).toBeLessThan(180);
        expect(lat).toBeGreaterThan(-90);
        expect(lat).toBeLessThan(90);
      });
    });
  });

  it("ferme automatiquement les rings ouverts", async () => {
    const openRing = `Secteur;Exploitation;Numero pacage;Parcelles;Surface parcelle;Parcelle Bio;Type de sol;CultureN;CultureN1;CultureN2;CultureN3;CultureN4;Geometrie
Secteur A;Test;000;P1;1;Non;;BTH;;;;;1.35,44.01 1.36,44.01 1.36,44.02 1.35,44.02
`;
    const features = await parseParcellesCsvToFeatures(makeFile(openRing));
    expect(features).toHaveLength(1);
    const ring = features[0].geometry.coordinates[0];
    const first = ring[0];
    const last = ring[ring.length - 1];
    expect(first[0]).toBe(last[0]);
    expect(first[1]).toBe(last[1]);
  });

  it("ignore les lignes sans géométrie valide", async () => {
    const csv = `Secteur;Exploitation;Numero pacage;Parcelles;Surface parcelle;Parcelle Bio;Type de sol;CultureN;CultureN1;CultureN2;CultureN3;CultureN4;Geometrie
A;Test;000;P1;1;Non;;BTH;;;;;1.35,44.01 1.36,44.01 1.36,44.02 1.35,44.02 1.35,44.01
A;Test;000;P2;2;Non;;MIS;;;;;
A;Test;000;P3;3;Non;;TRN;;;;;invalide
`;
    const features = await parseParcellesCsvToFeatures(makeFile(csv));
    expect(features).toHaveLength(1);
    expect(features[0].properties.nom).toBe("P1");
  });

  it("extrait le code exploitation / numéro pacage", async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    features.forEach((f) => {
      expect(f.properties.code_exploitation).toBe("099999997");
    });
  });

  it("extrait les cultures N et N-1", async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    // Parcelle 1 : BTH + TRN (N-1)
    const p1 = features[0];
    expect(p1.properties.cultureN).toBeTruthy();
    // cultureN_1 doit être défini si N-1 est renseigné
    expect(p1.properties.cultureN_1).toBeTruthy();
  });

  it("marque la parcelle bio correctement (Oui/Non)", async () => {
    const features = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    expect(features[2].properties.parcelle_bio).toBe("Oui");
    expect(features[0].properties.parcelle_bio).toBe("Non");
  });

  it("gère les délimiteurs tabulation en plus du point-virgule", async () => {
    const tabCsv = `Secteur\tExploitation\tNumero pacage\tParcelles\tSurface parcelle\tParcelle Bio\tType de sol\tCultureN\tCultureN1\tCultureN2\tCultureN3\tCultureN4\tGeometrie
A\tTest\t000\tP1\t1.5\tNon\t\tBTH\t\t\t\t\t1.35,44.01 1.36,44.01 1.36,44.02 1.35,44.02 1.35,44.01
`;
    const features = await parseParcellesCsvToFeatures(makeFile(tabCsv));
    expect(features).toHaveLength(1);
    expect(features[0].properties.surface_parcelle).toBe(1.5);
  });
});

describe("buildParcellesCsv — round-trip", () => {
  it("produit les en-têtes CSV attendus", async () => {
    const features = [
      {
        type: "Feature",
        properties: { nom: "P1", surface_parcelle: 2.5, cultureN: "BTH" },
        geometry: {
          type: "Polygon",
          coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.02], [1.35, 44.01]]],
        },
      },
    ];
    const csv = await buildParcellesCsv(features, "Secteur A", "Exploitation Test", "000111");
    const lines = csv.split(/\r?\n/);
    const headers = lines[0].split(";");
    expect(headers[0]).toBe("Secteur");
    expect(headers[3]).toBe("Parcelles");
    expect(headers[6]).toBe("Type de sol");
    expect(headers[7]).toBe("Irrigabilité");
    expect(headers[8]).toBe("CultureN");
    expect(headers[13]).toBe("Geometrie");
  });

  it("encode correctement les valeurs avec point-virgule", async () => {
    const features = [
      {
        type: "Feature",
        properties: { nom: "Parcelle; test", surface_parcelle: 1.0, cultureN: "BTH" },
        geometry: {
          type: "Polygon",
          coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
        },
      },
    ];
    const csv = await buildParcellesCsv(features, "", "", "");
    const dataLine = csv.split(/\r?\n/)[1];
    expect(dataLine).toContain('"Parcelle; test"');
  });

  it("exporte l'irrigabilité en Oui / Non", async () => {
    const geometry = {
      type: "Polygon",
      coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
    };
    const features = [
      { type: "Feature", properties: { nom: "Irriguée", irrigable: true }, geometry },
      { type: "Feature", properties: { nom: "Majuscules", IRRIGABLE: "oui" }, geometry },
      { type: "Feature", properties: { nom: "Non irriguée", irrigable: false }, geometry },
      { type: "Feature", properties: { nom: "Non renseignée" }, geometry },
    ];
    const csv = await buildParcellesCsv(features, "", "", "");
    const irrigabilite = csv
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(";")[7]);
    expect(irrigabilite).toEqual(["Oui", "Oui", "Non", "Non"]);
  });

  it("exporte la conduite bio quelle que soit sa provenance", async () => {
    const geometry = {
      type: "Polygon",
      coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
    };
    const features = [
      // Coché dans l'outil (vue Tableau)
      { type: "Feature", properties: { nom: "Case AB", conduite_bio: true, isOrganic: true }, geometry },
      // Relu d'un CSV Assolia
      { type: "Feature", properties: { nom: "Depuis CSV", parcelle_bio: "oui" }, geometry },
      // Import Télépac
      { type: "Feature", properties: { nom: "Telepac", isOrganic: true }, geometry },
      { type: "Feature", properties: { nom: "Non bio" }, geometry },
    ];
    const csv = await buildParcellesCsv(features, "", "", "");
    const colonneBio = csv
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(";")[5]);
    expect(colonneBio).toEqual(["Oui", "Oui", "Oui", "Non"]);
  });

  it("relit l'irrigabilité d'un CSV importé", async () => {
    const csv = `Secteur;Exploitation;Numero pacage;Parcelles;Surface parcelle;Parcelle Bio;Type de sol;Irrigabilité;CultureN;CultureN1;CultureN2;CultureN3;CultureN4;Geometrie
TEST;Expl;000111;P1;1.5;non;Limon;oui;Blé tendre;;;;;1.35,44.01 1.36,44.01 1.36,44.02 1.35,44.01`;
    const [feature] = await parseParcellesCsvToFeatures(makeFile(csv));
    expect(feature.properties.irrigable).toBe("oui");
    expect(feature.properties.IRRIGABLE).toBe("oui");
  });

  it("round-trip: parseParcellesCsvToFeatures ∘ buildParcellesCsv conserve les données", async () => {
    const originalFeatures = await parseParcellesCsvToFeatures(makeFile(EXEMPLE_CSV_TEXT));
    const csv = await buildParcellesCsv(originalFeatures, "", "", "");
    const reparsed = await parseParcellesCsvToFeatures(makeFile(csv));
    expect(reparsed).toHaveLength(originalFeatures.length);
    reparsed.forEach((f, i) => {
      expect(f.properties.nom).toBe(originalFeatures[i].properties.nom ?? originalFeatures[i].properties.nom_affiche);
    });
  });
});

describe("buildParcellesCsv — structure et « Autre assolé »", () => {
  const ASSOLIA_CSV = `"culture_id";"culture_name";"structure_id";"structure_name";"metacode"
"1";"Blé Assolia";"4";"TestStruct";"BTH"
`;

  function makeFeature(cultures) {
    return {
      type: "Feature",
      properties: { nom: "P1", surface_parcelle: 1, ...cultures },
      geometry: {
        type: "Polygon",
        coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
      },
    };
  }

  // Colonnes CultureN..CultureN4 = indices 8 à 12 de la ligne de données.
  function cultureCells(csv) {
    return csv.split(/\r?\n/)[1].split(";").slice(8, 13);
  }

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => ASSOLIA_CSV }))
    );
  });

  it("sans structure : exporte les cultures telles quelles, sans correspondance", async () => {
    const csv = await buildParcellesCsv(
      [makeFeature({ cultureN: "BTH", cultureN1: "MIS" })],
      "", "", "",
      {}
    );
    const [n] = cultureCells(csv);
    expect(n).not.toBe("Autre assolé");
    expect(n).toBeTruthy();
  });

  it("structure définie : applique la correspondance quand elle existe", async () => {
    const csv = await buildParcellesCsv(
      [makeFeature({ cultureN: "BTH" })],
      "", "", "",
      { structureName: "TestStruct" }
    );
    expect(cultureCells(csv)[0]).toBe("Blé Assolia");
  });

  it("structure définie : « Autre assolé » quand aucune correspondance", async () => {
    const csv = await buildParcellesCsv(
      [makeFeature({ cultureN: "MIS" })],
      "", "", "",
      { structureName: "TestStruct" }
    );
    expect(cultureCells(csv)[0]).toBe("Autre assolé");
  });

  it("structure définie : une année vide reste vide (pas « Autre assolé »)", async () => {
    const csv = await buildParcellesCsv(
      [makeFeature({ cultureN: "BTH" })],
      "", "", "",
      { structureName: "TestStruct" }
    );
    const [, n1, n2, n3, n4] = cultureCells(csv);
    expect([n1, n2, n3, n4]).toEqual(["", "", "", ""]);
  });
});

describe("buildParcellesCsv — culture précédente stockée dans culture_prec", () => {
  // Colonnes CultureN..CultureN4 = indices 8 à 12 de la ligne de données.
  function cultureCells(csv) {
    return csv.split(/\r?\n/)[1].split(";").slice(8, 13);
  }

  // Reproduit « 01 le parc » : le précédent N-1 n'est que dans culture_prec/CULT_PREC
  // (import Télépac), et non dans cultureN1/cultureN_1.
  it("exporte la culture N-1 présente uniquement dans culture_prec", async () => {
    const feature = {
      type: "Feature",
      properties: {
        nom: "01 le parc",
        surface_parcelle: 2.9,
        cultureN: "BTH",
        culture_prec: "MAÏS FOURRAGE",
        CULT_PREC: "MAÏS FOURRAGE",
        cultureN_2: "BTH",
        cultureN2: "BTH",
      },
      geometry: {
        type: "Polygon",
        coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
      },
    };
    const csv = await buildParcellesCsv([feature], "", "", "", {});
    const [n, n1, n2] = cultureCells(csv);
    expect(n).toBeTruthy();
    expect(n1).toBe("MAÏS FOURRAGE");
    expect(n2).toBeTruthy();
  });
});

describe("buildParcellesCsv — offset d'année de culture", () => {
  it("décale les cultures avec cultureYearOffset=1", async () => {
    const csv = `Secteur;Exploitation;Numero pacage;Parcelles;Surface parcelle;Parcelle Bio;Type de sol;CultureN;CultureN1;CultureN2;CultureN3;CultureN4;Geometrie
A;Test;000;P1;1;Non;;BTH;MIS;;;;1.35,44.01 1.36,44.01 1.36,44.02 1.35,44.02 1.35,44.01
`;
    const features = await parseParcellesCsvToFeatures(makeFile(csv), { cultureYearOffset: 1 });
    // Avec offset=1, BTH devient cultureN_1 et MIS devient cultureN_2
    expect(features[0].properties.cultureN_1).toBeTruthy();
    expect(features[0].properties.cultureN_2).toBeTruthy();
    expect(features[0].properties.cultureN).toBeUndefined();
  });
});

describe("buildParcellesCsv — remplacement des cultures", () => {
  const ASSOLIA_CSV = `"culture_id";"culture_name";"structure_id";"structure_name";"metacode"
"1";"Blé tendre d'hiver";"4";"TestStruct";"BTH"
"2";"Maïs ensilage";"4";"TestStruct";"MIE"
"3";"Dérobée ray-grass";"4";"TestStruct";""
"4";"Autre Assolé";"4";"TestStruct";""
`;
  const geometry = {
    type: "Polygon",
    coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
  };
  const parcelle = (cultures) => ({ type: "Feature", properties: { nom: "P", ...cultures }, geometry });
  const cellules = (csv, ligne = 1) => csv.split(/\r?\n/)[ligne].split(";").slice(8, 13);

  // Le référentiel est mémorisé par le module : on repart d'un module neuf pour
  // ne pas hériter de celui des tests précédents.
  let buildParcellesCsv;
  let describeExportCultures;
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => ASSOLIA_CSV })));
    vi.resetModules();
    ({ buildParcellesCsv, describeExportCultures } = await import("./parcellesCsv"));
  });

  it("sans structure : remplace un libellé partout où il apparaît, vide = inchangé", async () => {
    const csv = await buildParcellesCsv(
      [
        parcelle({ cultureN: "MAÏS FOURRAGE", cultureN_1: "MAÏS FOURRAGE" }),
        parcelle({ cultureN: "PRAIRIE PERMANENTE" }),
      ],
      "", "", "",
      { cultureReplacements: { "MAÏS FOURRAGE": "Maïs ensilage", "PRAIRIE PERMANENTE": "  " } }
    );
    expect(cellules(csv, 1).slice(0, 2)).toEqual(["Maïs ensilage", "Maïs ensilage"]);
    expect(cellules(csv, 2)[0]).toBe("PRAIRIE PERMANENTE");
  });

  it("avec structure : rapproche un libellé Geofolia par son nom, sans code PAC", async () => {
    const csv = await buildParcellesCsv(
      [parcelle({ cultureN: "BLÉ TENDRE D'HIVER" })],
      "", "", "",
      { structureName: "TestStruct" }
    );
    expect(cellules(csv)[0]).toBe("Blé tendre d'hiver");
  });

  it("avec structure : la culture choisie dans la liste remplace « Autre assolé »", async () => {
    const options = { structureName: "TestStruct" };
    const sans = await buildParcellesCsv([parcelle({ cultureN: "MAÏS FOURRAGE" })], "", "", "", options);
    expect(cellules(sans)[0]).toBe("Autre Assolé");
    const avec = await buildParcellesCsv([parcelle({ cultureN: "MAÏS FOURRAGE" })], "", "", "", {
      ...options,
      cultureReplacements: { "MAÏS FOURRAGE": "Maïs ensilage" },
    });
    expect(cellules(avec)[0]).toBe("Maïs ensilage");
  });

  it("describeExportCultures liste les cultures, les non reconnues d'abord, avec la liste de la structure", async () => {
    const { cultures, structureCultures } = await describeExportCultures(
      [
        parcelle({ cultureN: "MAÏS FOURRAGE", cultureN_1: "BLÉ TENDRE D'HIVER" }),
        parcelle({ cultureN: "MAÏS FOURRAGE" }),
      ],
      "TestStruct"
    );
    expect(cultures.map((c) => [c.label, c.count, c.reconnue, c.auto])).toEqual([
      ["MAÏS FOURRAGE", 2, false, "Autre Assolé"],
      ["BLÉ TENDRE D'HIVER", 1, true, "Blé tendre d'hiver"],
    ]);
    expect(structureCultures).toEqual(["Autre Assolé", "Blé tendre d'hiver", "Dérobée ray-grass", "Maïs ensilage"]);
  });

  it("describeExportCultures sans structure : reconnue = code PAC connu", async () => {
    const { cultures, structureCultures } = await describeExportCultures([parcelle({ cultureN: "MAÏS FOURRAGE" })]);
    expect(cultures).toEqual([{ label: "MAÏS FOURRAGE", count: 1, code: "", auto: "MAÏS FOURRAGE", reconnue: false }]);
    expect(structureCultures).toEqual([]);
  });
});

describe("buildParcellesCsv — libellé importé rattaché au code PAC", () => {
  const ASSOLIA_CSV = `"culture_id";"culture_name";"structure_id";"structure_name";"metacode"
"1";"Blé tendre";"4";"TestStruct";"BTH"
`;
  const geometry = {
    type: "Polygon",
    coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
  };
  let mod;
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => ASSOLIA_CSV })));
    window.CODEBOOK_EXTRA = { "BTH|1": "Blé tendre d’hiver - semences", BTH: "Blé tendre d’hiver" };
    vi.resetModules();
    mod = await import("./parcellesCsv");
  });
  afterEach(() => {
    delete window.CODEBOOK_EXTRA;
  });

  it("« BLÉ TENDRE D'HIVER » (Geofolia) est reconnu comme BTH malgré casse et apostrophe", async () => {
    const features = [{ type: "Feature", properties: { nom: "P", cultureN: "BLÉ TENDRE D'HIVER" }, geometry }];
    const csv = await mod.buildParcellesCsv(features, "", "", "", { structureName: "TestStruct" });
    expect(csv.split(/\r?\n/)[1].split(";")[8]).toBe("Blé tendre");
    const { cultures } = await mod.describeExportCultures(features);
    expect(cultures[0]).toMatchObject({ code: "BTH", reconnue: true });
  });
});
