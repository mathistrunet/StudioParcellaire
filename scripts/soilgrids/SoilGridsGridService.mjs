import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { ighForward, ighInverse } from "./homolosine.mjs";

// ISRIC a retiré la carte globale soilgrids.map : seules les cartes par propriété répondent.
// La grille 250 m est la même pour toutes ; l'argile en décrit donc le découpage.
const DEFAULT_WCS_URL = "https://maps.isric.org/mapserv?map=/map/clay.map";
const METADATA_FILE_NAME = "soilgrids-grid-metadata.json";
const METADATA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WCS_TIMEOUT_MS = 90_000; // par requête ; ISRIC met jusqu'à 53 s mesurées sur GetCapabilities
const EPSG_4326 = "EPSG:4326";
const EPSG_IGH = "EPSG:152160"; // Interrupted Goode Homolosine, CRS natif de SoilGrids
const SUPPORTED_CRS = new Set([EPSG_4326, EPSG_IGH]);
const DEFAULT_LIMIT = 5000;
const BBOX_SAMPLE_STEPS = 16;

function byLocalName(node, localName) {
  if (!node?.getElementsByTagName) return [];
  const all = node.getElementsByTagName("*");
  const result = [];
  for (let i = 0; i < all.length; i += 1) {
    const child = all[i];
    const candidate = (child.localName || child.nodeName || "").split(":").pop();
    if (candidate === localName) result.push(child);
  }
  return result;
}

function textContent(node) {
  return node?.textContent?.trim() || "";
}

function parseNumberPair(raw) {
  const values = String(raw || "")
    .trim()
    .split(/\s+/)
    .map((value) => Number(value));
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  return [values[0], values[1]];
}

// Accepte EPSG:4326, urn:ogc:def:crs:EPSG::4326 et http://www.opengis.net/def/crs/EPSG/0/4326.
// Le segment facultatif est le numéro de version de ces deux dernières formes, pas le code.
export function parseEpsg(raw) {
  const match = String(raw || "").match(/EPSG(?:[/:]|%3A|%2F)*(?:\d+(?:\.\d+)*(?:[/:]|%3A|%2F)+)?(\d+)/i);
  return match ? `EPSG:${match[1]}` : null;
}

function normalizeAxisOrder(coords, axisLabels) {
  if (!Array.isArray(coords) || coords.length < 2) return coords;
  if (!Array.isArray(axisLabels) || axisLabels.length < 2) return coords;
  const first = String(axisLabels[0] || "").toLowerCase();
  const second = String(axisLabels[1] || "").toLowerCase();
  if (first.startsWith("lat") && second.startsWith("lon")) {
    return [coords[1], coords[0]];
  }
  return coords;
}

function buildCapabilitiesUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("SERVICE", "WCS");
  url.searchParams.set("VERSION", "2.0.1");
  url.searchParams.set("REQUEST", "GetCapabilities");
  return url.toString();
}

function buildDescribeCoverageUrl(baseUrl, coverageId) {
  const url = new URL(baseUrl);
  url.searchParams.set("SERVICE", "WCS");
  url.searchParams.set("VERSION", "2.0.1");
  url.searchParams.set("REQUEST", "DescribeCoverage");
  url.searchParams.set("COVERAGEID", coverageId);
  return url.toString();
}

function parseCoverageIds(capabilitiesXml) {
  const doc = new DOMParser().parseFromString(capabilitiesXml, "application/xml");
  return byLocalName(doc, "CoverageId")
    .map((node) => textContent(node))
    .filter(Boolean);
}

function parseDescribeCoverage(xml, coverageId, sourceUrl = DEFAULT_WCS_URL) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  const envelope = byLocalName(doc, "Envelope")[0];
  const lower = parseNumberPair(textContent(byLocalName(envelope, "lowerCorner")[0]));
  const upper = parseNumberPair(textContent(byLocalName(envelope, "upperCorner")[0]));
  const axisLabels = String(envelope?.getAttribute("axisLabels") || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const lowerXY = normalizeAxisOrder(lower, axisLabels);
  const upperXY = normalizeAxisOrder(upper, axisLabels);
  if (!lowerXY || !upperXY) {
    throw new Error("DescribeCoverage incomplet: corners absents.");
  }

  const low = parseNumberPair(textContent(byLocalName(doc, "low")[0]));
  const high = parseNumberPair(textContent(byLocalName(doc, "high")[0]));
  if (!low || !high) {
    throw new Error("DescribeCoverage incomplet: dimensions absentes.");
  }

  const width = Math.round(high[0] - low[0] + 1);
  const height = Math.round(high[1] - low[1] + 1);
  if (width <= 0 || height <= 0) {
    throw new Error("DescribeCoverage invalide: dimensions non positives.");
  }

  const minX = Math.min(lowerXY[0], upperXY[0]);
  const maxX = Math.max(lowerXY[0], upperXY[0]);
  const minY = Math.min(lowerXY[1], upperXY[1]);
  const maxY = Math.max(lowerXY[1], upperXY[1]);
  const pixelWidth = (maxX - minX) / width;
  const pixelHeight = (maxY - minY) / height;
  if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight) || pixelWidth <= 0 || pixelHeight <= 0) {
    throw new Error("DescribeCoverage invalide: resolution non exploitable.");
  }

  const srsName = envelope?.getAttribute("srsName");
  const crs = parseEpsg(srsName);
  if (!SUPPORTED_CRS.has(crs)) {
    throw new Error(`Projection SoilGrids non prise en charge : ${srsName || "non renseignée"}.`);
  }
  return {
    source: "WCS DescribeCoverage",
    sourceUrl,
    coverageId,
    fetchedAt: new Date().toISOString(),
    crs,
    origin: { x: minX, y: maxY },
    extent: { minX, minY, maxX, maxY },
    pixelSize: { x: pixelWidth, y: pixelHeight },
    dimensions: { width, height },
    axisLabels,
    gridEnvelope: {
      low: { col: low[0], row: low[1] },
      high: { col: high[0], row: high[1] },
    },
  };
}

// MapServer signale une carte introuvable par une page HTML en HTTP 200 : le statut ne suffit pas.
async function fetchWcsXml(url, requestName) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(WCS_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Service SoilGrids (ISRIC) injoignable (${requestName}) : ${error?.message || error}.`);
  }
  if (!response.ok) {
    throw new Error(`Le service SoilGrids (ISRIC) a répondu HTTP ${response.status} (${requestName}).`);
  }
  const body = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (/html/i.test(contentType) || /^\s*<(!doctype\s+html|html)\b/i.test(body)) {
    const detail = body.match(/ms\w+\(\):[^<\n]*/)?.[0]?.trim();
    throw new Error(
      `Le service SoilGrids (ISRIC) a renvoyé une page HTML au lieu de données (${requestName}) : ` +
        `carte indisponible ou déplacée.${detail ? ` Détail : ${detail}` : ""}`,
    );
  }
  return body;
}

async function fetchWcsMetadata({ wcsBaseUrl = DEFAULT_WCS_URL }) {
  const capabilitiesXml = await fetchWcsXml(buildCapabilitiesUrl(wcsBaseUrl), "GetCapabilities");
  const coverageIds = parseCoverageIds(capabilitiesXml);
  if (!coverageIds.length) {
    throw new Error("Aucune couverture WCS SoilGrids detectee.");
  }

  const preferredCoverage =
    coverageIds.find((id) => /clay|soc|cec|nitrogen|bdod/i.test(id)) ||
    coverageIds[0];
  const describeXml = await fetchWcsXml(
    buildDescribeCoverageUrl(wcsBaseUrl, preferredCoverage),
    "DescribeCoverage",
  );
  return parseDescribeCoverage(describeXml, preferredCoverage, wcsBaseUrl);
}

function metadataCacheFile(dataDir) {
  return path.join(dataDir, METADATA_FILE_NAME);
}

// Écarte notamment les caches écrits avec le CRS erroné EPSG:0 par l'ancien parseEpsg.
function isUsableMetadata(metadata) {
  return (
    SUPPORTED_CRS.has(metadata?.crs) &&
    [
      metadata.extent?.minX,
      metadata.extent?.minY,
      metadata.extent?.maxX,
      metadata.extent?.maxY,
      metadata.pixelSize?.x,
      metadata.pixelSize?.y,
      metadata.dimensions?.width,
      metadata.dimensions?.height,
    ].every(Number.isFinite)
  );
}

async function readMetadataFromDisk(dataDir) {
  const filePath = metadataCacheFile(dataDir);
  try {
    const [raw, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    const parsed = JSON.parse(raw);
    if (!isUsableMetadata(parsed)) return null;
    return { parsed, mtimeMs: fileStat.mtimeMs };
  } catch {
    return null;
  }
}

async function writeMetadataToDisk(dataDir, metadata) {
  const filePath = metadataCacheFile(dataDir);
  await writeFile(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

export class SoilGridsGridService {
  constructor({ dataDir, wcsBaseUrl = DEFAULT_WCS_URL, metadataTtlMs = METADATA_TTL_MS } = {}) {
    this.dataDir = dataDir;
    this.wcsBaseUrl = wcsBaseUrl;
    this.metadataTtlMs = metadataTtlMs;
    this.inMemoryMetadata = null;
    this.inMemoryFetchedAt = 0;
  }

  async getMetadata() {
    const now = Date.now();
    if (this.inMemoryMetadata && now - this.inMemoryFetchedAt < this.metadataTtlMs) {
      return this.inMemoryMetadata;
    }

    const disk = await readMetadataFromDisk(this.dataDir);
    if (disk && now - disk.mtimeMs < this.metadataTtlMs) {
      this.inMemoryMetadata = disk.parsed;
      this.inMemoryFetchedAt = now;
      return disk.parsed;
    }

    try {
      const fetched = await fetchWcsMetadata({ wcsBaseUrl: this.wcsBaseUrl });
      this.inMemoryMetadata = fetched;
      this.inMemoryFetchedAt = now;
      await writeMetadataToDisk(this.dataDir, fetched);
      return fetched;
    } catch (error) {
      if (disk?.parsed) {
        this.inMemoryMetadata = disk.parsed;
        this.inMemoryFetchedAt = now;
        return disk.parsed;
      }
      throw error;
    }
  }

  transformPoint(point, fromCrs, toCrs) {
    if (!Array.isArray(point) || point.length < 2) return null;
    if (!fromCrs || !toCrs || fromCrs === toCrs) return [point[0], point[1]];
    if (fromCrs === EPSG_4326 && toCrs === EPSG_IGH) return ighForward(point[0], point[1]);
    if (fromCrs === EPSG_IGH && toCrs === EPSG_4326) return ighInverse(point[0], point[1]);
    throw new Error(`Reprojection SoilGrids non prise en charge : ${fromCrs} vers ${toCrs}.`);
  }

  // `steps` échantillonne l'emprise : l'Homolosine courbe les méridiens et coupe la carte en lobes,
  // ses seuls coins ne donnent donc pas l'étendue d'une grande emprise.
  transformBbox(bbox, fromCrs, toCrs, steps = 1) {
    if (!bbox || bbox.length !== 4) return null;
    if (!fromCrs || !toCrs || fromCrs === toCrs) return bbox.slice();
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        const point = this.transformPoint(
          [bbox[0] + ((bbox[2] - bbox[0]) * i) / steps, bbox[1] + ((bbox[3] - bbox[1]) * j) / steps],
          fromCrs,
          toCrs,
        );
        if (point) points.push(point);
      }
    }
    if (!points.length) return null;
    const xs = points.map((point) => point[0]);
    const ys = points.map((point) => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  buildPixelFeature({ row, col, metadata }) {
    const {
      extent: { minX, maxY },
      pixelSize,
      crs,
    } = metadata;
    const minCellX = minX + col * pixelSize.x;
    const maxCellX = minCellX + pixelSize.x;
    const maxCellY = maxY - row * pixelSize.y;
    const minCellY = maxCellY - pixelSize.y;

    const ringRaster = [
      [minCellX, minCellY],
      [maxCellX, minCellY],
      [maxCellX, maxCellY],
      [minCellX, maxCellY],
      [minCellX, minCellY],
    ];
    const ringWgs84 = ringRaster.map((point) => this.transformPoint(point, crs, EPSG_4326));
    // Une cellule à cheval sur une interruption de la carte n'a pas de géométrie terrestre.
    if (ringWgs84.some((point) => !point)) return null;
    const centerRaster = [(minCellX + maxCellX) / 2, (minCellY + maxCellY) / 2];
    const centerWgs84 = this.transformPoint(centerRaster, crs, EPSG_4326);
    const bboxWgs84 = this.transformBbox([minCellX, minCellY, maxCellX, maxCellY], crs, EPSG_4326);

    return {
      type: "Feature",
      properties: {
        pixelId: `${metadata.coverageId}:${row}:${col}`,
        coverageId: metadata.coverageId,
        row,
        col,
        centerLon: Number(centerWgs84?.[0] ?? NaN),
        centerLat: Number(centerWgs84?.[1] ?? NaN),
        bboxWgs84: Array.isArray(bboxWgs84) ? bboxWgs84.map((v) => Number(v)) : null,
        bboxRaster: [minCellX, minCellY, maxCellX, maxCellY],
      },
      geometry: {
        type: "Polygon",
        coordinates: [ringWgs84],
      },
    };
  }

  buildGridCollection({ bboxWgs84, limit = DEFAULT_LIMIT }) {
    const metadata = this.inMemoryMetadata;
    const cappedLimit = this.clamp(Number(limit) || DEFAULT_LIMIT, 1, 20000);
    // La carte peut afficher des copies du monde : on ramène l'emprise sur la Terre.
    const bboxOnEarth = [
      this.clamp(bboxWgs84[0], -180, 180),
      this.clamp(bboxWgs84[1], -90, 90),
      this.clamp(bboxWgs84[2], -180, 180),
      this.clamp(bboxWgs84[3], -90, 90),
    ];
    const bboxRaster = this.transformBbox(bboxOnEarth, EPSG_4326, metadata.crs, BBOX_SAMPLE_STEPS);
    if (!bboxRaster) {
      return { metadata, collection: { type: "FeatureCollection", features: [] }, featureCount: 0, truncated: false };
    }

    const extent = metadata.extent;
    const pixel = metadata.pixelSize;
    const width = metadata.dimensions.width;
    const height = metadata.dimensions.height;

    const ixMin = Math.max(bboxRaster[0], extent.minX);
    const iyMin = Math.max(bboxRaster[1], extent.minY);
    const ixMax = Math.min(bboxRaster[2], extent.maxX);
    const iyMax = Math.min(bboxRaster[3], extent.maxY);
    if (ixMin >= ixMax || iyMin >= iyMax) {
      return { metadata, collection: { type: "FeatureCollection", features: [] }, featureCount: 0, truncated: false };
    }

    const colStart = this.clamp(Math.floor((ixMin - extent.minX) / pixel.x), 0, width - 1);
    const colEnd = this.clamp(Math.ceil((ixMax - extent.minX) / pixel.x) - 1, 0, width - 1);
    const rowStart = this.clamp(Math.floor((extent.maxY - iyMax) / pixel.y), 0, height - 1);
    const rowEnd = this.clamp(Math.ceil((extent.maxY - iyMin) / pixel.y) - 1, 0, height - 1);

    const features = [];
    let truncated = false;
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const feature = this.buildPixelFeature({ row, col, metadata });
        if (feature) features.push(feature);
        if (features.length >= cappedLimit) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    return {
      metadata,
      truncated,
      featureCount: features.length,
      requestedBboxWgs84: bboxWgs84,
      requestedBboxRaster: bboxRaster,
      rowRange: [rowStart, rowEnd],
      colRange: [colStart, colEnd],
      collection: {
        type: "FeatureCollection",
        features,
      },
    };
  }

  async queryVisibleGrid({ bboxWgs84, limit = DEFAULT_LIMIT }) {
    const metadata = await this.getMetadata();
    this.inMemoryMetadata = metadata;
    return this.buildGridCollection({ bboxWgs84, limit });
  }
}


