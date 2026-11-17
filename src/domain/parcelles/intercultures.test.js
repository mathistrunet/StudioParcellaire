// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  INTERCULTURE_COLUMNS,
  foldSecondaryParcels,
  isIntercultureLabel,
  isSecondaryParcel,
  readInterculture,
  setInterculture,
} from "./intercultures";
import { createShapefileZip } from "../../services/shapefileWriter.js";
import { parseParcellaireFileToFeatures } from "../../services/parcellaireImport.js";

const carre = (x, y, cote = 0.01) => ({
  type: "Polygon",
  coordinates: [[[x, y], [x + cote, y], [x + cote, y + cote], [x, y + cote], [x, y]]],
});

const parcelle = (properties, geometry) => ({ type: "Feature", properties, geometry });

describe("libellés et types", () => {
  it("reconnaît les intercultures courantes", () => {
    ["RAY-GRASS DÉROBÉE", "Ray-grass dérobée", "Moutarde CIPAN", "Seigle CIVE", "Couvert végétal", "Interculture"].forEach(
      (label) => expect(isIntercultureLabel(label), label).toBe(true)
    );
    ["Maïs fourrage", "Blé tendre d'hiver", "Prairie temporaire", "Bande enherbée", ""].forEach((label) =>
      expect(isIntercultureLabel(label), label).toBe(false)
    );
  });

  it("reconnaît la « Parcelle secondaire » de Geofolia", () => {
    expect(isSecondaryParcel({ TYPE_PARC: "Parcelle secondaire" })).toBe(true);
    expect(isSecondaryParcel({ TYPE_PARC: "Parcelle principale" })).toBe(false);
    expect(isSecondaryParcel({})).toBe(false);
  });

  it("lit l'interculture sous ses alias et l'efface quand la saisie est vide", () => {
    expect(readInterculture({ CIP_CULTU: "Moutarde", CIS_CULTU: "Phacélie" })).toBe("Moutarde + Phacélie");
    expect(readInterculture({ CIP_CULTU: "\u0000\u0000" })).toBe("");
    const avec = setInterculture({ CIP_CULTU: "Moutarde" }, "Ray-grass dérobée");
    expect(avec).toMatchObject({ interculture: "Ray-grass dérobée", INTERCULT: "Ray-grass dérobée" });
    expect(avec.CIP_CULTU).toBeUndefined();
    expect(setInterculture(avec, "  ")).toEqual({});
  });
});

describe("une interculture par année", () => {
  it("propose une colonne par colonne de culture, de N+1 à N-6", () => {
    expect(INTERCULTURE_COLUMNS.map((c) => c.label)).toEqual([
      "Interculture N+1", "Interculture N", "Interculture N-1", "Interculture N-2",
      "Interculture N-3", "Interculture N-4", "Interculture N-5", "Interculture N-6",
    ]);
  });

  it("range chaque année sous sa propre clé, sans toucher aux autres", () => {
    let props = setInterculture({}, "Moutarde", "current");
    props = setInterculture(props, "Ray-grass dérobée", "prev1");
    props = setInterculture(props, "Phacélie", "prev2");
    expect(props).toMatchObject({
      interculture: "Moutarde", interculture_n1: "Ray-grass dérobée", interculture_n2: "Phacélie",
    });
    expect(readInterculture(props, "prev1")).toBe("Ray-grass dérobée");
    props = setInterculture(props, "", "prev1");
    expect(readInterculture(props, "prev1")).toBe("");
    expect(readInterculture(props, "current")).toBe("Moutarde");
    expect(readInterculture(props, "prev2")).toBe("Phacélie");
  });
});

describe("foldSecondaryParcels", () => {
  it("replie la parcelle secondaire Geofolia sur la principale de même contour", () => {
    const { features, replies } = foldSecondaryParcels([
      parcelle({ TYPE_PARC: "Parcelle principale", CP_CULTU: "MAÏS FOURRAGE", NOM_PARCEL: "A" }, carre(0, 0)),
      parcelle({ TYPE_PARC: "Parcelle secondaire", CP_CULTU: "RAY-GRASS DÉROBÉE", NOM_PARCEL: "A" }, carre(0, 0)),
      parcelle({ TYPE_PARC: "Parcelle principale", CP_CULTU: "ORGE 2 RANGS DE PRINTEMPS" }, carre(1, 1)),
      parcelle({ TYPE_PARC: "Parcelle secondaire", CP_CULTU: "PRAIRIE TEMPORAIRE" }, carre(1, 1)),
    ]);
    expect(replies).toBe(2);
    expect(features).toHaveLength(2);
    expect(features[0].properties.CP_CULTU).toBe("MAÏS FOURRAGE");
    expect(features[0].properties.interculture).toBe("RAY-GRASS DÉROBÉE");
    expect(features[1].properties.interculture).toBe("PRAIRIE TEMPORAIRE");
  });

  it("replie une dérobée sans TYPE_PARC posée sur une parcelle", () => {
    const { features } = foldSecondaryParcels([
      parcelle({ cultureN: "Ray-grass dérobée" }, carre(0, 0)),
      parcelle({ cultureN: "Maïs fourrage" }, carre(0, 0)),
    ]);
    expect(features).toHaveLength(1);
    expect(features[0].properties).toMatchObject({ cultureN: "Maïs fourrage", interculture: "Ray-grass dérobée" });
  });

  it("garde une dérobée seule et une secondaire qui ne recouvre rien", () => {
    const entree = [
      parcelle({ cultureN: "Ray-grass dérobée" }, carre(0, 0)),
      parcelle({ cultureN: "Blé" }, carre(5, 5)),
      parcelle({ TYPE_PARC: "Parcelle secondaire", CP_CULTU: "COLZA" }, carre(0.005, 0.005)),
    ];
    const { features, replies } = foldSecondaryParcels(entree);
    expect(replies).toBe(0);
    expect(features).toBe(entree);
  });

  it("ne replie pas deux cultures principales voisines", () => {
    const { features } = foldSecondaryParcels([
      parcelle({ cultureN: "Blé" }, carre(0, 0)),
      parcelle({ cultureN: "Maïs" }, carre(0, 0)),
    ]);
    expect(features).toHaveLength(2);
  });
});

describe("import d'un export Geofolia", () => {
  const fichier = (buffer, nom) => {
    const file = new File([buffer], nom);
    file.arrayBuffer = async () => buffer;
    return file;
  };

  it("une parcelle par contour, l'interculture rangée sur la principale", async () => {
    const lambert = (x, y) => ({
      type: "Polygon",
      coordinates: [[[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100], [x, y]]],
    });
    const buffer = await createShapefileZip({
      baseName: "Export_Specifique",
      fields: [
        { name: "TYPE_PARC", type: "C", size: 30 },
        { name: "CP_CULTU", type: "C", size: 25 },
        { name: "NOM_PARCEL", type: "C", size: 50 },
      ],
      features: [
        parcelle({ TYPE_PARC: "Parcelle principale", CP_CULTU: "Maïs fourrage", NOM_PARCEL: "Les Noës" }, lambert(350000, 6790000)),
        parcelle({ TYPE_PARC: "Parcelle secondaire", CP_CULTU: "Ray-grass dérobée", NOM_PARCEL: "Les Noës" }, lambert(350000, 6790000)),
        parcelle({ TYPE_PARC: "Parcelle principale", CP_CULTU: "Bande enherbée", NOM_PARCEL: "Bord" }, lambert(350200, 6790000)),
      ],
    });
    const features = await parseParcellaireFileToFeatures(fichier(buffer, "Export_Specifique_2027.zip"));
    expect(features).toHaveLength(2);
    const noes = features.find((f) => f.properties.NOM_PARCEL === "Les Noës");
    expect(noes.properties.CP_CULTU).toBe("MAÏS FOURRAGE");
    expect(noes.properties.interculture).toBe("RAY-GRASS DÉROBÉE");
  });
});
