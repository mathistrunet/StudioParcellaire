import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SoilGridsGridService, parseEpsg } from "./SoilGridsGridService.mjs";
import { ighForward } from "./homolosine.mjs";

const CAPABILITIES = `<?xml version="1.0"?>
<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0"><wcs:Contents>
  <wcs:CoverageSummary><wcs:CoverageId>clay_0-5cm_Q0.05</wcs:CoverageId></wcs:CoverageSummary>
</wcs:Contents></wcs:Capabilities>`;

// Réponse réelle de maps.isric.org (map=/map/clay.map), réduite aux éléments lus.
const DESCRIBE_COVERAGE = `<?xml version="1.0" encoding="UTF-8"?>
<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">
  <wcs:CoverageDescription gml:id="clay_0-5cm_Q0.05">
    <gml:boundedBy>
      <gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/152160" axisLabels="x y" uomLabels="m m" srsDimension="2">
        <gml:lowerCorner>-19949750 -6147500</gml:lowerCorner>
        <gml:upperCorner>19861750 8361000</gml:upperCorner>
      </gml:Envelope>
    </gml:boundedBy>
    <gml:domainSet><gml:RectifiedGrid dimension="2"><gml:limits><gml:GridEnvelope>
      <gml:low>0 0</gml:low>
      <gml:high>159245 58033</gml:high>
    </gml:GridEnvelope></gml:limits></gml:RectifiedGrid></gml:domainSet>
  </wcs:CoverageDescription>
</wcs:CoverageDescriptions>`;

const MAPSERVER_HTML = `<HTML><HEAD><TITLE>MapServer Message</TITLE></HEAD><BODY>
<!-- MapServer version 8 -->
msLoadMap(): Unable to access file. (/map/soilgrids.map)
</BODY></HTML>`;

const xmlResponse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
const htmlResponse = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

function stubIsric() {
  const fetchMock = vi.fn(async (url) =>
    xmlResponse(String(url).includes("GetCapabilities") ? CAPABILITIES : DESCRIBE_COVERAGE),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("parseEpsg", () => {
  it.each([
    ["http://www.opengis.net/def/crs/EPSG/0/152160", "EPSG:152160"],
    ["http://www.opengis.net/def/crs/EPSG/6.9/4326", "EPSG:4326"],
    ["urn:ogc:def:crs:EPSG::4326", "EPSG:4326"],
    ["urn:ogc:def:crs:EPSG:6.9:2154", "EPSG:2154"],
    ["EPSG:152160", "EPSG:152160"],
    ["epsg:4326", "EPSG:4326"],
    ["EPSG%3A4326", "EPSG:4326"],
  ])("lit %s", (raw, expected) => {
    expect(parseEpsg(raw)).toBe(expected);
  });

  it.each([[""], [null], ["CRS:84"]])("renvoie null pour %s", (raw) => {
    expect(parseEpsg(raw)).toBeNull();
  });
});

describe("SoilGridsGridService", () => {
  let dataDir;
  const cacheFile = () => path.join(dataDir, "soilgrids-grid-metadata.json");

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "soilgrids-grid-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("métadonnées", () => {
    it("lit la carte par propriété et le vrai CRS du service", async () => {
      const fetchMock = stubIsric();
      const metadata = await new SoilGridsGridService({ dataDir }).getMetadata();
      expect(String(fetchMock.mock.calls[0][0])).toContain("map=%2Fmap%2Fclay.map");
      expect(metadata).toMatchObject({
        crs: "EPSG:152160",
        coverageId: "clay_0-5cm_Q0.05",
        pixelSize: { x: 250, y: 250 },
        dimensions: { width: 159246, height: 58034 },
      });
    });

    it("explique qu'ISRIC a renvoyé du HTML, même en HTTP 200", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(MAPSERVER_HTML)));
      const service = new SoilGridsGridService({ dataDir });
      await expect(service.queryVisibleGrid({ bboxWgs84: [1.6, 48.2, 1.61, 48.21] })).rejects.toThrow(
        /page HTML.*msLoadMap\(\): Unable to access file/s,
      );
      await expect(readFile(cacheFile(), "utf-8")).rejects.toThrow();
    });

    it("repère aussi le HTML servi sans le bon type de contenu", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(MAPSERVER_HTML)));
      await expect(new SoilGridsGridService({ dataDir }).getMetadata()).rejects.toThrow(/page HTML/);
    });

    it("signale un service injoignable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
      await expect(new SoilGridsGridService({ dataDir }).getMetadata()).rejects.toThrow(/injoignable/);
    });

    it("refuse une projection inconnue plutôt que de tracer une grille fausse", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url) =>
        xmlResponse(
          String(url).includes("GetCapabilities")
            ? CAPABILITIES
            : DESCRIBE_COVERAGE.replaceAll("EPSG/0/152160", "EPSG/0/2154"),
        ),
      ));
      await expect(new SoilGridsGridService({ dataDir }).getMetadata()).rejects.toThrow(/non prise en charge/);
    });

    it("invalide un cache contenant EPSG:0 et le remplace", async () => {
      await writeFile(cacheFile(), JSON.stringify({
        crs: "EPSG:0",
        extent: { minX: -19949750, minY: -6147500, maxX: 19861750, maxY: 8361000 },
        pixelSize: { x: 250, y: 250 },
        dimensions: { width: 159246, height: 58034 },
      }));
      const fetchMock = stubIsric();
      const metadata = await new SoilGridsGridService({ dataDir }).getMetadata();
      expect(fetchMock).toHaveBeenCalled();
      expect(metadata.crs).toBe("EPSG:152160");
      expect(JSON.parse(await readFile(cacheFile(), "utf-8")).crs).toBe("EPSG:152160");
    });

    it("ne se rabat pas sur un cache EPSG:0 quand le service est en panne", async () => {
      await writeFile(cacheFile(), JSON.stringify({ crs: "EPSG:0" }));
      vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(MAPSERVER_HTML)));
      await expect(new SoilGridsGridService({ dataDir }).getMetadata()).rejects.toThrow(/page HTML/);
    });

    it("réutilise un cache valide sans interroger ISRIC", async () => {
      stubIsric();
      await new SoilGridsGridService({ dataDir }).getMetadata();
      const fetchMock = stubIsric();
      const metadata = await new SoilGridsGridService({ dataDir }).getMetadata();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(metadata.crs).toBe("EPSG:152160");
    });
  });

  describe("grille sur une emprise française", () => {
    const BBOX = [1.6, 48.2, 1.615, 48.21]; // Beauce : environ 1,1 km sur 1,1 km
    let result;

    beforeEach(async () => {
      stubIsric();
      result = await new SoilGridsGridService({ dataDir }).queryVisibleGrid({ bboxWgs84: BBOX, limit: 5000 });
    });

    it("trace des cellules dont les indices et bords sont ceux de la grille du service", () => {
      expect(result.truncated).toBe(false);
      expect(result.featureCount).toBeGreaterThan(9);
      expect(result.featureCount).toBeLessThan(80);
      for (const { properties } of result.collection.features) {
        const [minX, minY, maxX, maxY] = properties.bboxRaster;
        expect(maxX - minX).toBe(250);
        expect(maxY - minY).toBe(250);
        expect(minX).toBe(-19949750 + properties.col * 250);
        expect(maxY).toBe(8361000 - properties.row * 250);
      }
    });

    it("pose des polygones terrestres fermés, de l'ordre de 250 m de côté", () => {
      for (const { geometry, properties } of result.collection.features) {
        const ring = geometry.coordinates[0];
        expect(ring).toHaveLength(5);
        expect(ring[4]).toEqual(ring[0]);
        const [[lon0, lat0], [lon1]] = ring;
        expect(lon0).toBeGreaterThan(1.59);
        expect(lon0).toBeLessThan(1.63);
        expect(lat0).toBeGreaterThan(48.19);
        expect(lat0).toBeLessThan(48.22);
        const widthM = (lon1 - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180);
        expect(widthM).toBeGreaterThan(200);
        expect(widthM).toBeLessThan(320);
        // Le centre calculé retombe dans sa propre cellule après aller-retour.
        const [x, y] = ighForward(properties.centerLon, properties.centerLat);
        expect(Math.floor((x + 19949750) / 250)).toBe(properties.col);
        expect(Math.floor((8361000 - y) / 250)).toBe(properties.row);
      }
    });

    it("couvre toute l'emprise demandée", () => {
      const present = new Set(result.collection.features.map(({ properties: p }) => `${p.row}:${p.col}`));
      for (let i = 0; i <= 10; i += 1) {
        for (let j = 0; j <= 10; j += 1) {
          const [x, y] = ighForward(
            BBOX[0] + ((BBOX[2] - BBOX[0]) * i) / 10,
            BBOX[1] + ((BBOX[3] - BBOX[1]) * j) / 10,
          );
          expect(present.has(`${Math.floor((8361000 - y) / 250)}:${Math.floor((x + 19949750) / 250)}`)).toBe(true);
        }
      }
    });
  });

  it("n'émet aucune géométrie invalide sur une interruption de la carte", async () => {
    stubIsric();
    const service = new SoilGridsGridService({ dataDir });
    const { collection } = await service.queryVisibleGrid({ bboxWgs84: [-40.02, 50, -39.98, 50.02], limit: 5000 });
    expect(collection.features.length).toBeGreaterThan(0);
    for (const feature of collection.features) {
      for (const [lon, lat] of feature.geometry.coordinates[0]) {
        expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
      }
    }
  });

  it("accepte une emprise débordant du monde affiché par la carte", async () => {
    stubIsric();
    const service = new SoilGridsGridService({ dataDir });
    const { collection, truncated } = await service.queryVisibleGrid({ bboxWgs84: [-200, -85, 200, 85], limit: 50 });
    expect(truncated).toBe(true);
    expect(collection.features).toHaveLength(50);
  });
});
