// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { buildDbf, buildShapefileParts, createShapefileZip, encodeCp1252, shapefileRings } from "./shapefileWriter.js";
import { buildParcelShapefileZip } from "./parcelleShapefile.js";
import { parseShapefileZipToFeatures } from "./shapefileZip.js";

// Carré en Lambert-93, dans le sens GeoJSON (extérieur anti-horaire).
const CARRE = [[600000, 6800000], [600100, 6800000], [600100, 6800100], [600000, 6800100], [600000, 6800000]];
const TROU = [[600020, 6800020], [600020, 6800040], [600040, 6800040], [600040, 6800020], [600020, 6800020]];

/** jsdom n'implémente pas Blob#arrayBuffer. */
const lireBlob = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(blob);
  });

const aireSignee = (ring) => {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i += 1) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
};

/** Lit les enregistrements d'un .shp en suivant la longueur annoncée par l'en-tête, comme un lecteur strict. */
function lireShp(buffer) {
  const view = new DataView(buffer);
  const longueur = view.getInt32(24, false) * 2;
  const records = [];
  let offset = 100;
  while (offset < longueur) {
    const contenu = view.getInt32(offset + 4, false) * 2;
    const c = offset + 8;
    expect(view.getInt32(c, true)).toBe(5);
    const nbParts = view.getInt32(c + 36, true);
    const nbPoints = view.getInt32(c + 40, true);
    const debuts = Array.from({ length: nbParts }, (_, i) => view.getInt32(c + 44 + 4 * i, true));
    const points = Array.from({ length: nbPoints }, (_, i) => {
      const p = c + 44 + 4 * nbParts + 16 * i;
      return [view.getFloat64(p, true), view.getFloat64(p + 8, true)];
    });
    const anneaux = debuts.map((d, i) => points.slice(d, debuts[i + 1] ?? nbPoints));
    records.push(anneaux);
    offset = c + contenu;
  }
  return { longueur, records, fin: offset };
}

describe("shapefileWriter — .shp et .shx", () => {
  it("annonce exactement la longueur du fichier, sans octets en trop", () => {
    const parts = buildShapefileParts({
      features: [
        { properties: {}, geometry: { type: "Polygon", coordinates: [CARRE] } },
        { properties: {}, geometry: { type: "MultiPolygon", coordinates: [[CARRE, TROU], [CARRE]] } },
      ],
      fields: [{ name: "NOM", type: "C", size: 10 }],
    });
    const { longueur, records, fin } = lireShp(parts.shp);
    expect(longueur).toBe(parts.shp.byteLength);
    expect(fin).toBe(parts.shp.byteLength);
    expect(records).toHaveLength(2);
    expect(records[1]).toHaveLength(3);
    const shx = new DataView(parts.shx);
    expect(shx.getInt32(24, false) * 2).toBe(parts.shx.byteLength);
    expect(shx.getInt32(108, false) * 2).toBe(100 + 8 + (44 + 4 + 16 * 5));
  });

  it("oriente l'extérieur dans le sens horaire et les trous à l'inverse", () => {
    expect(aireSignee(CARRE)).toBeGreaterThan(0); // entrée GeoJSON : anti-horaire
    const [exterieur, trou] = shapefileRings({ type: "Polygon", coordinates: [CARRE, [...TROU].reverse()] });
    expect(aireSignee(exterieur)).toBeLessThan(0);
    expect(aireSignee(trou)).toBeGreaterThan(0);
  });

  it("referme un anneau ouvert et écarte une géométrie sans surface", () => {
    const [anneau] = shapefileRings({ type: "Polygon", coordinates: [CARRE.slice(0, 4)] });
    expect(anneau[0]).toEqual(anneau[anneau.length - 1]);
    expect(shapefileRings({ type: "Polygon", coordinates: [[[0, 0], [1, 1]]] })).toEqual([]);
    expect(shapefileRings({ type: "LineString", coordinates: CARRE })).toEqual([]);
  });
});

describe("shapefileWriter — .dbf", () => {
  const champ = (bytes, offset, taille) => String.fromCharCode(...bytes.slice(offset, offset + taille));

  it("déclare les décimales de chaque champ numérique et les respecte", () => {
    const bytes = buildDbf(
      [{ CAMPAGNE: 2026, SURFACE: 1.23456789 }],
      [
        { name: "CAMPAGNE", type: "N", size: 4, decimal: 0 },
        { name: "SURFACE", type: "N", size: 17, decimal: 7 },
      ]
    );
    expect(bytes[32 + 17]).toBe(0);
    expect(bytes[64 + 17]).toBe(7);
    const view = new DataView(bytes.buffer);
    const debut = view.getUint16(8, true);
    expect(view.getUint16(10, true)).toBe(1 + 4 + 17);
    expect(champ(bytes, debut + 1, 4)).toBe("2026");
    expect(champ(bytes, debut + 5, 17)).toBe("        1.2345679");
    expect(bytes[bytes.length - 1]).toBe(0x1a);
  });

  it("écrit le texte en Windows-1252, page déclarée dans l'en-tête", () => {
    const bytes = buildDbf([{ CP_CULTU: "Ray-grass dérobée œ" }], [{ name: "CP_CULTU", type: "C", size: 25 }]);
    expect(bytes[29]).toBe(0x03);
    const debut = new DataView(bytes.buffer).getUint16(8, true);
    const valeur = bytes.slice(debut + 1, debut + 1 + 19);
    expect(Array.from(valeur)).toEqual(encodeCp1252("Ray-grass dérobée œ"));
    expect(valeur[11]).toBe(0xe9); // é
    expect(valeur[18]).toBe(0x9c); // œ
  });

  it("tronque un texte trop long et laisse vide un nombre qui ne tient pas", () => {
    const bytes = buildDbf(
      [{ NOM: "abcdefghij", N: 123456 }],
      [{ name: "NOM", type: "C", size: 4 }, { name: "N", type: "N", size: 4, decimal: 0 }]
    );
    const debut = new DataView(bytes.buffer).getUint16(8, true);
    expect(champ(bytes, debut + 1, 4)).toBe("abcd");
    expect(champ(bytes, debut + 5, 4)).toBe("    ");
  });
});

describe("buildParcelShapefileZip — export au format Geofolia", () => {
  const anneauWgs84 = [[-1.5, 48.1], [-1.49, 48.1], [-1.49, 48.11], [-1.5, 48.11], [-1.5, 48.1]];
  const parcelle = {
    type: "Feature",
    properties: {
      nom_parcelle: "Grande pièce",
      cultureN: "Maïs fourrage",
      cultureN_1: "Blé tendre d'hiver",
      cultureN_2: "Colza",
      interculture: "Ray-grass dérobée",
      type_sol: "Limon",
    },
    geometry: { type: "Polygon", coordinates: [anneauWgs84] },
  };

  it("contient .shp, .shx, .dbf, .prj ESRI et .cpg", async () => {
    const { blob } = await buildParcelShapefileZip([parcelle], { raisSoc: "Earl Test", campagne: "2026" });
    const zip = await JSZip.loadAsync(await lireBlob(blob));
    const noms = Object.keys(zip.files).sort();
    expect(noms).toEqual(["EARL_TEST.cpg", "EARL_TEST.dbf", "EARL_TEST.prj", "EARL_TEST.shp", "EARL_TEST.shx"]);
    const prj = await zip.file("EARL_TEST.prj").async("string");
    expect(prj).toMatch(/^PROJCS\["RGF93_Lambert_93"/);
    expect(prj).not.toMatch(/TOWGS84|AUTHORITY|AXIS/);
    const shp = await zip.file("EARL_TEST.shp").async("arraybuffer");
    const { longueur, records } = lireShp(shp);
    expect(longueur).toBe(shp.byteLength);
    expect(aireSignee(records[0][0])).toBeLessThan(0);
  });

  it("met le précédent (N-1) dans CULT_PREC, N-2 dans CULT_PREC2 et l'interculture dans CIP_CULTU", async () => {
    const { blob } = await buildParcelShapefileZip([parcelle], { raisSoc: "Earl Test", campagne: "2026" });
    const [relue] = await parseShapefileZipToFeatures(await lireBlob(blob));
    const p = relue.properties;
    expect(p.CAMPAGNE).toBe(2026);
    expect(p.TYPE_PARC).toBe("Parcelle principale");
    expect(p.NOM_PARCEL).toBe("Grande pièce");
    expect(p.CULT_PREC).toBe("BLÉ TENDRE D'HIVER");
    expect(p.CULT_PREC2).toBe("COLZA");
    expect(p.CIP_CULTU).toBe("Ray-grass dérobée");
    expect(p.SURFACE).toBeGreaterThan(70);
    expect(p.SURFACE).toBeLessThan(90);
    expect(relue.geometry.coordinates[0][0][0]).toBeCloseTo(-1.5, 5);
  });

  it("reste lisible par l'import du Studio (aller-retour)", async () => {
    const buffer = await createShapefileZip({
      features: [{ properties: { NOM_PARCEL: "P1" }, geometry: { type: "Polygon", coordinates: [CARRE] } }],
      baseName: "p",
      fields: [{ name: "NOM_PARCEL", type: "C", size: 20 }],
    });
    const [relue] = await parseShapefileZipToFeatures(buffer);
    expect(relue.properties.NOM_PARCEL).toBe("P1");
  });
});
