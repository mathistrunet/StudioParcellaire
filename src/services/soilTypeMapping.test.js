import { describe, expect, it } from "vitest";
import {
  applySequentialSoilMapping,
  buildDetectedSoilCombinations,
  buildMappingCsv,
  matchesSoilTypeRule,
  normalizeStructureMappings,
  parseMappingCsv,
  resolveFileUcs,
  resolveUcsId,
} from "./soilTypeMapping";

describe("soilTypeMapping sequential engine", () => {
  it("applique les combinaisons visuelles, puis les règles, puis le résiduel", () => {
    const parcels = [
      { soilRow: { profondeur: "profond", texture: "limoneux" }, surfaceHa: 1 },
      { soilRow: { profondeur: "profond", texture: "sableux" }, surfaceHa: 2 },
      { soilRow: { profondeur: "superficiel", texture: "argileux" }, surfaceHa: 3 },
    ];

    const configuration = {
      soilTypes: [
        {
          name: "Sol profond",
          residual: false,
          combinationKeys: ["limoneux||profond||__NULL__||__NULL__||__NULL__||__NULL__"],
          attributes: {},
        },
        {
          name: "Sol sableux",
          residual: false,
          attributes: {
            texture: { include: ["sableux"], exclude: [], nullMode: "ANY" },
          },
        },
        {
          name: "Autres sols",
          residual: true,
          attributes: {},
        },
      ],
    };

    const { assignments, remainingIndices } = applySequentialSoilMapping(parcels, configuration);

    expect(assignments[0]?.soilTypeName).toBe("Sol profond");
    expect(assignments[1]?.soilTypeName).toBe("Sol sableux");
    expect(assignments[2]?.soilTypeName).toBe("Autres sols");
    expect(remainingIndices.size).toBe(0);
  });

  it("détecte les combinaisons présentes triées par surface", () => {
    const combinations = buildDetectedSoilCombinations([
      { soilRow: { texture: "argileux", profondeur: "profond" }, surfaceHa: 4 },
      { soilRow: { texture: "limoneux", profondeur: "profond" }, surfaceHa: 1 },
      { soilRow: { texture: "argileux", profondeur: "profond" }, surfaceHa: 2 },
    ]);

    expect(combinations).toHaveLength(2);
    expect(combinations[0].row.texture).toBe("argileux");
    expect(combinations[0].surfaceHa).toBe(6);
    expect(combinations[1].row.texture).toBe("limoneux");
  });

  it("importe et exporte le CSV de configuration", () => {
    const configuration = {
      soilTypes: [
        {
          name: "Terrefort",
          residual: false,
          color: "#123456",
          description: "Sols argileux",
          combinationKeys: ["argileux||profond||__NULL__||__NULL__||__NULL__||__NULL__"],
          attributes: {
            texture: { include: ["argileux", "limono-argileux"], exclude: [], nullMode: "ANY" },
            ph_classe: { include: [], exclude: [], nullMode: "IS_NOT_NULL" },
          },
        },
      ],
    };

    const csv = buildMappingCsv(configuration);
    const parsed = parseMappingCsv(csv);

    expect(parsed.soilTypes).toHaveLength(1);
    expect(parsed.soilTypes[0].name).toBe("Terrefort");
    expect(parsed.soilTypes[0].color).toBe("#123456");
    expect(parsed.soilTypes[0].description).toBe("Sols argileux");
    expect(parsed.soilTypes[0].combinationKeys).toEqual([
      "argileux||profond||__NULL__||__NULL__||__NULL__||__NULL__",
    ]);
    expect(parsed.soilTypes[0].attributes.texture.include).toEqual(["argileux", "limono-argileux"]);
    expect(parsed.soilTypes[0].attributes.ph_classe.nullMode).toBe("IS_NOT_NULL");
  });

  it("résout file_ucs depuis id_ucs quand la carte ne fournit pas file_ucs", () => {
    expect(resolveUcsId({ id_ucs: 9984 })).toBe("9984");
    expect(resolveUcsId({ UCS: "09984" })).toBe("09984");
    expect(resolveUcsId({})).toBe("");

    expect(resolveFileUcs({ id_ucs: 9984 })).toBe("id_ucs_9984.txt");
    expect(resolveFileUcs({ file_ucs: "id_ucs_9984.txt" })).toBe("id_ucs_9984.txt");
    expect(resolveFileUcs({ file_ucs: "id_ucs_24318.pdf" })).toBe("id_ucs_24318.txt");
    expect(resolveFileUcs({ source_file: "  ID_UCS_24318.PDF " })).toBe("id_ucs_24318.txt");
  });

  it("gère une modalité NULL explicite dans les règles IN/NOT IN", () => {
    const rowWithNullTopo = { texture: "argileux", profondeur: "profond", position_topo: "" };

    expect(matchesSoilTypeRule(rowWithNullTopo, {
      attributes: {
        texture: { include: ["argileux"], exclude: [], nullMode: "ANY" },
        profondeur: { include: ["profond"], exclude: [], nullMode: "ANY" },
        position_topo: { include: ["plateau", "__NULL__"], exclude: [], nullMode: "ANY" },
      },
    })).toBe(true);

    expect(matchesSoilTypeRule(rowWithNullTopo, {
      attributes: {
        position_topo: { include: [], exclude: ["__NULL__"], nullMode: "ANY" },
      },
    })).toBe(false);
  });

  it("deplie les payloads imbriques mappings.mappings.*", () => {
    const normalized = normalizeStructureMappings({
      mappings: {
        mappings: {
          Arterris: {
            soilTypes: ["Sol profond", "Terrefort"],
            combinationMap: { "argileux||profond||__NULL__||__NULL__||__NULL__||__NULL__": "Terrefort" },
          },
        },
      },
    });

    expect(Object.keys(normalized.mappings)).toEqual(["Arterris"]);
    expect(normalized.mappings.Arterris.soilTypes).toEqual(["Sol profond", "Terrefort"]);
    expect(
      normalized.mappings.Arterris.combinationMap["argileux||profond||__NULL__||__NULL__||__NULL__||__NULL__"]
    ).toBe("Terrefort");
  });

});
