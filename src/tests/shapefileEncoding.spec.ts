import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  detectDbfEncoding,
  parseShapefileZipToFeatures,
  resolveCpgEncoding,
} from "../services/shapefileZip";
import { chooseDbfEncoding, DOS_CODEPAGES } from "../services/dbfEncoding.js";

// Encode une chaîne en Windows-1252 (suffisant pour les caractères latins testés).
function cp1252(text: string): Uint8Array {
  return Uint8Array.from(Array.from(text, (c) => c.charCodeAt(0) & 0xff));
}

// Encode une chaîne en page DOS 850.
function cp850(text: string): Uint8Array {
  return Uint8Array.from(Array.from(text, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x80 ? code : 0x80 + DOS_CODEPAGES.cp850.indexOf(c);
  }));
}

describe("tables DOS", () => {
  it("comptent 128 caractères", () => {
    expect(DOS_CODEPAGES.cp850).toHaveLength(128);
    expect(DOS_CODEPAGES.cp437).toHaveLength(128);
    expect(DOS_CODEPAGES.cp850[0x90 - 0x80]).toBe("É");
    expect(DOS_CODEPAGES.cp850[0xd4 - 0x80]).toBe("È");
  });
  it("chooseDbfEncoding repère le CP850 face au Windows-1252", () => {
    const dbf = buildDbf(cp850("DÉROBÉE ÉTÉ"));
    expect(chooseDbfEncoding(dbf, null)).toBe("cp850");
    expect(chooseDbfEncoding(buildDbf(cp1252("DÉROBÉE ÉTÉ")), null)).toBe("windows-1252");
  });
});

// Shapefile minimal : un polygone carré en WGS84.
function buildShp(): ArrayBuffer {
  const pts = [
    [2, 48],
    [2, 48.001],
    [2.001, 48.001],
    [2.001, 48],
    [2, 48],
  ];
  const contentLen = 4 + 32 + 4 + 4 + 4 + pts.length * 16;
  const buf = new ArrayBuffer(100 + 8 + contentLen);
  const v = new DataView(buf);
  v.setInt32(0, 9994);
  v.setInt32(24, buf.byteLength / 2);
  v.setInt32(28, 1000, true);
  v.setInt32(32, 5, true);
  [2, 48, 2.001, 48.001].forEach((n, i) => v.setFloat64(36 + i * 8, n, true));
  v.setInt32(100, 1);
  v.setInt32(104, contentLen / 2);
  let o = 108;
  v.setInt32(o, 5, true);
  o += 4;
  [2, 48, 2.001, 48.001].forEach((n) => {
    v.setFloat64(o, n, true);
    o += 8;
  });
  v.setInt32(o, 1, true);
  v.setInt32(o + 4, pts.length, true);
  v.setInt32(o + 8, 0, true);
  o += 12;
  pts.forEach(([x, y]) => {
    v.setFloat64(o, x, true);
    v.setFloat64(o + 8, y, true);
    o += 16;
  });
  return buf;
}

// DBF minimal : un champ caractère CP_CULTU contenant `value` (octets bruts).
function buildDbf(value: Uint8Array): Uint8Array {
  const fieldLen = 30;
  const headerLen = 32 + 32 + 1;
  const recordLen = 1 + fieldLen;
  const out = new Uint8Array(headerLen + recordLen + 1);
  const v = new DataView(out.buffer);
  out[0] = 0x03;
  v.setUint32(4, 1, true);
  v.setUint16(8, headerLen, true);
  v.setUint16(10, recordLen, true);
  out.set(cp1252("CP_CULTU"), 32);
  out[32 + 11] = "C".charCodeAt(0);
  out[32 + 16] = fieldLen;
  out[64] = 0x0d;
  out.fill(0x20, headerLen, headerLen + recordLen);
  out.set(value, headerLen + 1);
  out[out.length - 1] = 0x1a;
  return out;
}

async function buildZip(dbf: Uint8Array, cpg?: string) {
  const zip = new JSZip();
  zip.file("parcelles.shp", buildShp());
  zip.file("parcelles.dbf", dbf);
  if (cpg != null) zip.file("parcelles.cpg", cpg);
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("detectDbfEncoding", () => {
  it("bascule en Windows-1252 si les octets ne sont pas de l'UTF-8 et sans .cpg", () => {
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), null)).toBe("windows-1252");
  });
  it("corrige un .cpg UTF-8 démenti par les octets", () => {
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), "UTF-8\r\n")).toBe("windows-1252");
  });
  it("ne touche à rien si le contenu est de l'UTF-8 valide", () => {
    expect(detectDbfEncoding(new TextEncoder().encode("DÉROBÉE"), null)).toBeNull();
  });
  it("reconnaît de l'UTF-8 même si le .cpg annonce 1252", () => {
    expect(detectDbfEncoding(new TextEncoder().encode("DÉROBÉE"), "1252")).toBeNull();
  });
  it("respecte un .cpg explicite non UTF-8 sous son nom canonique", () => {
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), "1252")).toBe("windows-1252");
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), "ANSI 1252")).toBe("windows-1252");
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), "ISO 8859-1")).toBe("windows-1252");
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), "iso_8859_15")).toBe("iso-8859-15");
  });
  it("bascule en Windows-1252 si le .cpg est illisible", () => {
    expect(detectDbfEncoding(cp1252("DÉROBÉE"), "n'importe quoi")).toBe("windows-1252");
  });
});

describe("resolveCpgEncoding", () => {
  it("reconnaît les écritures courantes", () => {
    expect(resolveCpgEncoding("UTF-8\r\n")).toBe("utf-8");
    expect(resolveCpgEncoding("UTF8")).toBe("utf-8");
    expect(resolveCpgEncoding("Unicode")).toBe("utf-8");
    expect(resolveCpgEncoding("CP1252")).toBe("windows-1252");
    expect(resolveCpgEncoding("")).toBeNull();
  });
});

describe("parseShapefileZipToFeatures — accents", () => {
  it("lit un .dbf Windows-1252 sans .cpg", async () => {
    const buffer = await buildZip(buildDbf(cp1252("RAY-GRASS DÉROBÉE")));
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
  it("lit un .dbf Windows-1252 avec un .cpg erroné en UTF-8", async () => {
    const buffer = await buildZip(buildDbf(cp1252("RAY-GRASS DÉROBÉE")), "UTF-8");
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
  it("lit un .dbf dont le .cpg dit « ISO 8859-1 » (libellé que shpjs ignore)", async () => {
    const buffer = await buildZip(buildDbf(cp1252("RAY-GRASS DÉROBÉE")), "ISO 8859-1");
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
  it("lit un .dbf DOS CP850 sans .cpg ni octet LDID (détection par les octets)", async () => {
    const buffer = await buildZip(buildDbf(cp850("RAY-GRASS DÉROBÉE")));
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
  it("lit un .dbf DOS CP850 signalé par l'octet LDID", async () => {
    const dbf = buildDbf(cp850("blé tendre d'hiver"));
    dbf[29] = 0x02;
    const [feature] = await parseShapefileZipToFeatures(await buildZip(dbf));
    expect(feature.properties.code_culture).toBe("BLÉ TENDRE D'HIVER");
  });
  it("lit un .dbf DOS CP850 déclaré « 850 » dans le .cpg", async () => {
    const buffer = await buildZip(buildDbf(cp850("PRAIRIE TEMPORAIRE ÉTÉ")), "850");
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("PRAIRIE TEMPORAIRE ÉTÉ");
  });
  it("lit un .dbf Windows-1252 annoncé à tort en DOS 850 par l'octet LDID", async () => {
    const dbf = buildDbf(cp1252("RAY-GRASS DéROBéE"));
    dbf[29] = 0x02;
    const [feature] = await parseShapefileZipToFeatures(await buildZip(dbf));
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
  it("lit un .dbf Windows-1252 annoncé à tort « 850 » dans le .cpg", async () => {
    const buffer = await buildZip(buildDbf(cp1252("RAY-GRASS DéROBéE")), "850");
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
  it("lit toujours un .dbf UTF-8", async () => {
    const buffer = await buildZip(buildDbf(new TextEncoder().encode("RAY-GRASS DÉROBÉE")));
    const [feature] = await parseShapefileZipToFeatures(buffer);
    expect(feature.properties.code_culture).toBe("RAY-GRASS DÉROBÉE");
  });
});
