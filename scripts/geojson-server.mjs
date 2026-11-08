import http from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCorrespondencesAndMerge,
  buildParcellesByYearFromFeatures,
} from "../src/domain/parcelles/fusion.js";
import {
  buildSoilGridsResponse,
  computeSoilIndicators,
  parseSoilGridsProperties,
} from "../src/services/soilgrids.js";
import { classifyParcelUpr } from "../src/services/uprClassification.js";
import { SoilGridsClient, SoilGridsError } from "./soilgrids/SoilGridsClient.mjs";
import { SoilGridsCacheRepository } from "./soilgrids/SoilGridsCacheRepository.mjs";
import { SoilGridsGridService } from "./soilgrids/SoilGridsGridService.mjs";
import { resolveParcelPoint } from "./soilgrids/geometry.mjs";
import { soilGridsPixelKey } from "./soilgrids/homolosine.mjs";
import { closeGeoPackageCache, queryGeoPackageByBbox } from "./geopackage-query.mjs";
import { closeRpgRomaniaCache, queryRpgRomaniaByBbox } from "./rpg-romania-query.mjs";
import {
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  buildAccessPolicy,
  getAccessDenial,
  isLoopbackAddress,
  prepareApiResponse,
  readBody,
  sendBodyError,
} from "./http-security.mjs";
import { ensureDatasetForBbox, ensureLayer } from "./layer-store.mjs";
import {
  applyLayerUpdates,
  getLayerUpdateReport,
  scheduleStartupCheck,
} from "./layer-updates.mjs";

const PORT = Number(process.env.PORT || 4174);
// Local par défaut. L'exposition réseau demande les deux options STUDIO_HOST et
// STUDIO_ALLOWED_ORIGINS (cf. README) : le serveur n'a pas d'authentification.
const HOST = process.env.STUDIO_HOST || DEFAULT_HOST;
const ACCESS_POLICY = buildAccessPolicy({ port: PORT, extraOrigins: process.env.STUDIO_ALLOWED_ORIGINS });
const MAX_BODY_BYTES = Number(process.env.STUDIO_MAX_BODY_BYTES) || DEFAULT_MAX_BODY_BYTES;
const DATA_DIR = path.resolve(process.cwd(), "data");
// Application compilée : servie par ce même serveur quand elle existe, pour que le
// lanceur n'ait qu'un seul processus à démarrer (pas de proxy /api à configurer).
const DIST_DIR = path.resolve(process.cwd(), "dist");
const DATA_FILE = path.join(DATA_DIR, "parcelles.geojson");
const SOIL_MAPPING_FILE = path.join(DATA_DIR, "soil-type-mappings.json");
const PUBLIC_DATA_DIR = path.resolve(process.cwd(), "public", "data");
const SOILMAP_DEP_DIR = path.join(PUBLIC_DATA_DIR, "soilmap_dep");
const TOPONYMIE_DIR = path.join(PUBLIC_DATA_DIR, "TOPONYMIE");
const RPG_ROMANIA_DIR = path.join(PUBLIC_DATA_DIR, "RPG Rom");
const POINT_STRATEGY = process.env.SOILGRIDS_POINT_STRATEGY || "centroid";
const CALC_VERSION = "v1.6.0-upr";
const WRB_CALC_VERSION = "wrb-v1";

const soilClient = new SoilGridsClient({ timeoutMs: 15_000, retries: 2 });
const soilCacheRepository = new SoilGridsCacheRepository({ dataDir: DATA_DIR, ttlDays: 30 });
// Cache léger dédié à la remontée WRB-seule (nom de classe par pixel), séparé du cache SoilGrids
// complet pour éviter toute collision par parcel_id entre les deux modes.
const wrbCacheRepository = new SoilGridsCacheRepository({ dataDir: DATA_DIR, ttlDays: 30, fileName: "parcel-wrb-cache.json" });
const soilGridService = new SoilGridsGridService({ dataDir: DATA_DIR });
const inflightSoilRequests = new Map();
const rateLimitWindow = [];

const emptyCollection = () => ({ type: "FeatureCollection", features: [] });
const log = (type, payload) => console.info(`[${type}]`, JSON.stringify(payload));

const TOPONYMIE_FILES = {
  ARA: "TOPONYMIE_ARA.gpkg",
  BFC: "TOPONYMIE_BFC.gpkg",
  BRATAGNE: "TOPONYMIE_Bratagne.gpkg",
  CENTRE: "TOPONYMIE_Centre.gpkg",
  GEST: "TOPONYMIE_GEst.gpkg",
  HDF: "TOPONYMIE_HDF.gpkg",
  IDF: "TOPONYMIE_IDF.gpkg",
  NAQUITAINE: "TOPONYMIE_NAquitaine.gpkg",
  NORMANDIE: "TOPONYMIE_Normandie.gpkg",
  OCCITANIE: "TOPONYMIE_Occitanie.gpkg",
  PACA: "TOPONYMIE_PACA.gpkg",
  PDL: "TOPONYMIE_PDL.gpkg",
};

async function ensureDataFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(DATA_FILE, "utf-8");
  } catch {
    await writeFile(DATA_FILE, JSON.stringify(emptyCollection(), null, 2));
  }
}

async function ensureSoilMappingFile() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await readFile(SOIL_MAPPING_FILE, "utf-8");
  } catch {
    await writeFile(SOIL_MAPPING_FILE, JSON.stringify({ mappings: {} }, null, 2));
  }
}

function normalizeSoilMappingsPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  let rawMappings = source.mappings && typeof source.mappings === "object" ? source.mappings : {};

  // Backward compatibility: older frontend versions saved nested "mappings" wrappers.
  while (
    rawMappings &&
    typeof rawMappings === "object" &&
    !Array.isArray(rawMappings) &&
    Object.keys(rawMappings).length === 1 &&
    Object.prototype.hasOwnProperty.call(rawMappings, "mappings") &&
    rawMappings.mappings &&
    typeof rawMappings.mappings === "object" &&
    !Array.isArray(rawMappings.mappings)
  ) {
    rawMappings = rawMappings.mappings;
  }

  const mappings = {};
  Object.entries(rawMappings).forEach(([structure, entry]) => {
    const structureName = String(structure || "").trim();
    if (!structureName) return;

    const soilTypes = Array.isArray(entry?.soilTypes)
      ? entry.soilTypes.map((item) => String(item || "").trim()).filter(Boolean)
      : [];

    const combinationMap = {};
    if (entry?.combinationMap && typeof entry.combinationMap === "object") {
      Object.entries(entry.combinationMap).forEach(([key, value]) => {
        const mappingKey = String(key || "").trim();
        const mappingValue = String(value || "").trim();
        if (mappingKey && mappingValue) combinationMap[mappingKey] = mappingValue;
      });
    }

    mappings[structureName] = { soilTypes, combinationMap };
  });

  return { mappings };
}

async function readSoilMappings() {
  await ensureSoilMappingFile();
  const raw = await readFile(SOIL_MAPPING_FILE, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    return normalizeSoilMappingsPayload(parsed);
  } catch {
    // ignore
  }
  return { mappings: {} };
}

async function writeSoilMappings(payload) {
  await ensureSoilMappingFile();
  const normalized = normalizeSoilMappingsPayload(payload);
  await writeFile(SOIL_MAPPING_FILE, JSON.stringify(normalized, null, 2));
}

async function readCollection() {
  await ensureDataFile();
  const raw = await readFile(DATA_FILE, "utf-8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.type === "FeatureCollection") return parsed;
  } catch {
    // ignore
  }
  return emptyCollection();
}

async function writeCollection(collection) {
  await ensureDataFile();
  await writeFile(DATA_FILE, JSON.stringify(collection, null, 2));
}

const parseUrl = (requestUrl) => new URL(requestUrl, "http://localhost");

const rateLimited = () => {
  const now = Date.now();
  while (rateLimitWindow.length && now - rateLimitWindow[0] > 60_000) rateLimitWindow.shift();
  if (rateLimitWindow.length >= 60) return true;
  rateLimitWindow.push(now);
  return false;
};

const round4 = (value) => Number(value).toFixed(4);

function parseBboxParam(raw) {
  if (!raw) return null;
  const values = String(raw)
    .split(",")
    .map((part) => Number(part.trim()));
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [minX, minY, maxX, maxY] = values;
  if (minX >= maxX || minY >= maxY) return null;
  return [minX, minY, maxX, maxY];
}

function parseIntegerParam(raw, fallback, min = 1, max = 20_000) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// Construit la réponse normalisée propre à une parcelle à partir des payloads bruts ISRIC.
// Pur (aucun appel réseau) : permet de réutiliser un même pixel SoilGrids pour plusieurs
// parcelles tout en gardant une réponse spécifique à chaque parcelle.
function buildNormalizedForParcel({ parcelId, pointInfo, fetchedAt, depthProfile, raw, wrbClassName, probability }) {
  const profile = parseSoilGridsProperties(raw, { depths: depthProfile });
  const summary = computeSoilIndicators(profile, { wrbClass: wrbClassName });
  if (pointInfo.warning) summary.warnings.push(pointInfo.warning);
  const upr = classifyParcelUpr(profile, summary, wrbClassName);
  const wrb = { className: wrbClassName, probability: probability ?? null };
  return buildSoilGridsResponse({
    parcelId: String(parcelId),
    lat: pointInfo.lat,
    lon: pointInfo.lon,
    pointStrategy: pointInfo.pointStrategy,
    fetchedAt,
    calcVersion: CALC_VERSION,
    profile,
    summary,
    wrb,
    upr,
  });
}

async function persistParcelEntry({ parcelId, pointInfo, fetchedAt, cacheKey, raw, classificationRaw, normalized }) {
  await soilCacheRepository.upsert({
    parcel_id: String(parcelId),
    lat: pointInfo.lat,
    lon: pointInfo.lon,
    response_raw_json: raw,
    classification_raw_json: classificationRaw ?? null,
    normalized_json: normalized,
    fetched_at: fetchedAt,
    source: "SoilGrids v2",
    cache_key: cacheKey,
    calc_version: CALC_VERSION,
  });
}

async function loadSoilGridsForParcel({ parcelId, refresh, depthProfile }) {
  const collection = await readCollection();
  const feature = (collection.features || []).find(
    (item) => String(item?.id ?? item?.properties?.id ?? item?.properties?.parcelleNo) === String(parcelId)
  );
  if (!feature) throw new Error("[PARCEL_NOT_FOUND] Parcelle introuvable.");

  const pointInfo = resolveParcelPoint(feature, POINT_STRATEGY);
  const fetchedAt = new Date().toISOString();
  // Clé de cache = pixel natif SoilGrids (250 m) quand le point est dans le domaine validé,
  // afin que toutes les parcelles d'un même pixel partagent un seul appel ISRIC. Repli sur le
  // point arrondi (~11 m) sinon.
  const depthKey = (depthProfile || []).join("|");
  const pixelKey = soilGridsPixelKey(pointInfo.lon, pointInfo.lat);
  const cacheKey = `${pixelKey || `${round4(pointInfo.lat)}:${round4(pointInfo.lon)}`}:${depthKey}`;

  const isFresh = (entry) => entry && entry.calc_version === CALC_VERSION;

  if (!refresh) {
    // On ignore les entrées d'une version de calcul antérieure (ex. sans UPR) ou d'une autre
    // localisation (parcelle déplacée) pour forcer un recalcul plutôt que de resservir un obsolète.
    const parcelCache = await soilCacheRepository.getByParcel(String(parcelId));
    if (isFresh(parcelCache) && parcelCache.cache_key === cacheKey) {
      return { payload: parcelCache.normalized_json, cache: true };
    }
    const shared = await soilCacheRepository.getByCacheKey(cacheKey);
    if (isFresh(shared)) {
      // Même pixel déjà résolu par une autre parcelle : on réutilise les payloads bruts et on
      // reconstruit la réponse pour CETTE parcelle (n'engage aucun appel ISRIC).
      if (shared.response_raw_json) {
        const normalized = buildNormalizedForParcel({
          parcelId, pointInfo, fetchedAt, depthProfile,
          raw: shared.response_raw_json,
          wrbClassName: shared.classification_raw_json?.wrb_class_name ?? null,
          probability: shared.classification_raw_json?.wrb_class_probability ?? null,
        });
        await persistParcelEntry({
          parcelId, pointInfo, fetchedAt, cacheKey,
          raw: shared.response_raw_json, classificationRaw: shared.classification_raw_json, normalized,
        });
        return { payload: normalized, cache: true };
      }
      return { payload: shared.normalized_json, cache: true };
    }
  }

  // Cache miss : un seul appel ISRIC par pixel, mutualisé entre les parcelles concurrentes.
  // Le rate-limit (60 req/min) ne s'applique qu'ici, sur les vrais appels amont.
  let upstream;
  if (inflightSoilRequests.has(cacheKey)) {
    upstream = await inflightSoilRequests.get(cacheKey);
  } else {
    if (rateLimited()) {
      throw new SoilGridsError("Rate limit exceeded.", { statusCode: 429, code: "SOILGRIDS_RATE_LIMIT" });
    }
    const promise = (async () => {
      const [{ payload: raw, meta }, classification] = await Promise.all([
        soilClient.query({ lat: pointInfo.lat, lon: pointInfo.lon, depths: depthProfile }),
        soilClient.classify({ lat: pointInfo.lat, lon: pointInfo.lon }),
      ]);
      return { raw, meta, classification };
    })();
    inflightSoilRequests.set(cacheKey, promise);
    try {
      upstream = await promise;
    } finally {
      inflightSoilRequests.delete(cacheKey);
    }
    log("SOILGRIDS_FETCH", { parcelId, ...upstream.meta, cacheKey });
  }

  const normalized = buildNormalizedForParcel({
    parcelId, pointInfo, fetchedAt, depthProfile,
    raw: upstream.raw,
    wrbClassName: upstream.classification?.wrbClassName ?? null,
    probability: upstream.classification?.probability ?? null,
  });

  // Le point d'échantillonnage (lat/lon/stratégie/timestamp) est conservé dans le cache et dans
  // la réponse normalisée ; on ne réécrit donc plus parcelles.geojson à chaque fetch (évite de
  // muter le fichier de l'utilisateur et tout risque de concurrence lors d'un remplissage parallèle).
  await persistParcelEntry({
    parcelId, pointInfo, fetchedAt, cacheKey,
    raw: upstream.raw, classificationRaw: upstream.classification?.raw ?? null, normalized,
  });

  return { payload: normalized, cache: false };
}

async function persistWrbEntry({ parcelId, pointInfo, fetchedAt, cacheKey, wrbClassName, probability }) {
  await wrbCacheRepository.upsert({
    parcel_id: String(parcelId),
    lat: pointInfo.lat,
    lon: pointInfo.lon,
    wrb_class_name: wrbClassName ?? null,
    probability: probability ?? null,
    fetched_at: fetchedAt,
    cache_key: cacheKey,
    calc_version: WRB_CALC_VERSION,
  });
}

/**
 * Remontée allégée : uniquement le nom de classe WRB par parcelle, en gardant la déduplication
 * par pixel SoilGrids. N'appelle QUE `classification/query` (pas de `properties/query` ni de
 * calcul UPR) -> moitié moins de requêtes ISRIC. `soilClient.classify` est best-effort et ne lève
 * jamais : un échec amont renvoie `wrbClassName: null` (donc ni 504 ni 500 propagés).
 */
async function loadWrbForParcel({ parcelId, refresh }) {
  const collection = await readCollection();
  const feature = (collection.features || []).find(
    (item) => String(item?.id ?? item?.properties?.id ?? item?.properties?.parcelleNo) === String(parcelId)
  );
  if (!feature) throw new Error("[PARCEL_NOT_FOUND] Parcelle introuvable.");

  const pointInfo = resolveParcelPoint(feature, POINT_STRATEGY);
  const fetchedAt = new Date().toISOString();
  const pixelKey = soilGridsPixelKey(pointInfo.lon, pointInfo.lat);
  // Préfixe `wrb:` pour ne pas entrer en collision avec les clés du cache SoilGrids complet.
  const cacheKey = `wrb:${pixelKey || `${round4(pointInfo.lat)}:${round4(pointInfo.lon)}`}`;

  const buildPayload = (wrbClassName, probability, cache) => ({
    parcelId: String(parcelId),
    wrbClassName: wrbClassName ?? null,
    probability: probability ?? null,
    source: {
      name: "SoilGrids",
      endpoint: "classification/query",
      resolution: "250m",
      lat: pointInfo.lat,
      lon: pointInfo.lon,
      pointStrategy: pointInfo.pointStrategy,
      pixelKey: pixelKey || null,
      fetchedAt,
    },
    cacheHit: cache,
  });

  const isFresh = (entry) => entry && entry.calc_version === WRB_CALC_VERSION;

  if (!refresh) {
    const parcelCache = await wrbCacheRepository.getByParcel(String(parcelId));
    if (isFresh(parcelCache) && parcelCache.cache_key === cacheKey) {
      return buildPayload(parcelCache.wrb_class_name, parcelCache.probability, true);
    }
    const shared = await wrbCacheRepository.getByCacheKey(cacheKey);
    if (isFresh(shared)) {
      // Même pixel déjà résolu par une autre parcelle : on réutilise sans appel ISRIC.
      await persistWrbEntry({
        parcelId, pointInfo, fetchedAt, cacheKey,
        wrbClassName: shared.wrb_class_name, probability: shared.probability,
      });
      return buildPayload(shared.wrb_class_name, shared.probability, true);
    }
  }

  // Cache miss : un seul appel `classify` par pixel, mutualisé entre parcelles concurrentes.
  let classification;
  if (inflightSoilRequests.has(cacheKey)) {
    classification = await inflightSoilRequests.get(cacheKey);
  } else {
    if (rateLimited()) {
      throw new SoilGridsError("Rate limit exceeded.", { statusCode: 429, code: "SOILGRIDS_RATE_LIMIT" });
    }
    const promise = soilClient.classify({ lat: pointInfo.lat, lon: pointInfo.lon });
    inflightSoilRequests.set(cacheKey, promise);
    try {
      classification = await promise;
    } finally {
      inflightSoilRequests.delete(cacheKey);
    }
    log("WRB_FETCH", { parcelId, cacheKey, wrb: classification?.wrbClassName ?? null });
  }

  const wrbClassName = classification?.wrbClassName ?? null;
  const probability = classification?.probability ?? null;
  await persistWrbEntry({ parcelId, pointInfo, fetchedAt, cacheKey, wrbClassName, probability });
  return buildPayload(wrbClassName, probability, false);
}

const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".gpkg": "application/geopackage+sqlite3",
  ".csv": "text/csv; charset=utf-8",
  ".mbtiles": "application/octet-stream",
};

/** Répond avec un fichier du disque, ou false s'il est absent. */
async function sendFile(filePath, res) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
  } catch {
    return false;
  }
  try {
    const body = await readFile(filePath);
    const type =
      STATIC_CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Lecture impossible: ${error?.message || "erreur inconnue"}`);
  }
  return true;
}

/** Empêche de sortir du dossier autorisé via des « .. » encodés. */
function resolveInside(rootDir, relativePath) {
  const candidate = path.join(rootDir, decodeURIComponent(relativePath));
  const relative = path.relative(rootDir, candidate);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return inside ? candidate : null;
}

/**
 * Sert les couches et référentiels depuis `public/data`.
 *
 * Ce dossier n'est volontairement pas recopié dans `dist/` (plusieurs gigaoctets)
 * mais le navigateur y accède quand même pour les petits fichiers, comme le
 * référentiel des cultures Assolia. Une route /data inconnue renvoie un 404 :
 * elle ne doit surtout pas retomber sur la page HTML, sinon l'application
 * essaierait d'analyser du HTML comme du CSV.
 */
async function servePublicData(requestUrl, res) {
  const relative = decodeURIComponent(requestUrl.pathname.replace(/^\/data\/?/, ""));
  if (!relative) return false;
  const filePath = resolveInside(PUBLIC_DATA_DIR, relative);
  if (!filePath) return false;
  if (await sendFile(filePath, res)) return true;

  // Repli sur les référentiels versionnés du dépôt (`data/`). Ils sont légers et
  // suivis par Git : sur un poste neuf, ou sans accès aux Releases GitHub, le
  // référentiel des cultures Assolia reste ainsi disponible et l'export CSV
  // conserve sa correspondance de structures.
  const versionne = resolveInside(DATA_DIR, relative);
  if (versionne && (await sendFile(versionne, res))) return true;

  // Absent du disque : la couche est peut-être publiée et téléchargeable.
  const parsed = path.parse(relative);
  try {
    const downloaded = await ensureLayer(parsed.dir || ".", parsed.base);
    return downloaded ? sendFile(downloaded, res) : false;
  } catch (error) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Téléchargement impossible: ${error?.message || "erreur réseau"}`);
    return true;
  }
}

/**
 * Sert un fichier de `dist/`. Toute route inconnue retombe sur index.html
 * (application monopage). Renvoie false si l'application n'est pas construite,
 * afin que le serveur puisse répondre 404 comme avant.
 */
async function serveStatic(requestUrl, res) {
  const indexPath = path.join(DIST_DIR, "index.html");
  try {
    if (!(await stat(indexPath)).isFile()) return false;
  } catch {
    return false;
  }

  const candidate = resolveInside(DIST_DIR, requestUrl.pathname);
  if (candidate && (await sendFile(candidate, res))) return true;
  // Fichier absent : on retombe sur index.html (routes de l'application).
  return sendFile(indexPath, res);
}

const handleRequest = async (req, res) => {
  if (!req.url) return void res.end();

  const denial = getAccessDenial(req, ACCESS_POLICY);
  if (denial) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: denial }));
    return;
  }

  const requestUrl = parseUrl(req.url);

  if (requestUrl.pathname.startsWith("/api/parcels/") && requestUrl.pathname.endsWith("/soilgrids")) {
    if (prepareApiResponse(req, res, ["GET"])) return;
    // Le rate-limit est appliqué plus bas, uniquement sur les vrais appels ISRIC : un cache-hit
    // ou une requête mutualisée par pixel ne consomme pas le budget (cf. loadSoilGridsForParcel).

    const match = requestUrl.pathname.match(/^\/api\/parcels\/([^/]+)\/soilgrids$/);
    const parcelId = match?.[1];
    const refresh = requestUrl.searchParams.get("refresh") === "true";
    const depthProfile = requestUrl.searchParams.get("depth_profile")?.split(",").filter(Boolean) || undefined;

    try {
      const result = await loadSoilGridsForParcel({ parcelId, refresh, depthProfile });
      res.writeHead(200);
      res.end(JSON.stringify({ ...result.payload, cacheHit: result.cache }));
    } catch (error) {
      const statusCode = error instanceof SoilGridsError ? error.statusCode : 500;
      log("SOILGRIDS_ERROR", {
        parcelId,
        statusCode,
        code: error?.code,
        message: error?.message || String(error),
      });
      res.writeHead(statusCode);
      res.end(JSON.stringify({ error: error?.message || "SoilGrids unavailable." }));
    }
    return;
  }

  // Remontée WRB-seule (nom de classe par parcelle), dédup par pixel, un seul appel ISRIC.
  if (requestUrl.pathname.startsWith("/api/parcels/") && requestUrl.pathname.endsWith("/wrb")) {
    if (prepareApiResponse(req, res, ["GET"])) return;

    const match = requestUrl.pathname.match(/^\/api\/parcels\/([^/]+)\/wrb$/);
    const parcelId = match?.[1];
    const refresh = requestUrl.searchParams.get("refresh") === "true";

    try {
      const payload = await loadWrbForParcel({ parcelId, refresh });
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (error) {
      const statusCode = error instanceof SoilGridsError ? error.statusCode : 500;
      log("WRB_ERROR", { parcelId, statusCode, code: error?.code, message: error?.message || String(error) });
      res.writeHead(statusCode);
      res.end(JSON.stringify({ error: error?.message || "WRB unavailable." }));
    }
    return;
  }

  // État des couches : y a-t-il une version plus récente publiée ?
  if (requestUrl.pathname === "/api/layers/updates") {
    if (prepareApiResponse(req, res, ["GET", "POST"])) return;

    try {
      if (req.method === "GET") {
        const force = requestUrl.searchParams.get("refresh") === "true";
        const report = await getLayerUpdateReport({ force });
        res.writeHead(200);
        res.end(JSON.stringify(report));
        return;
      }
      // POST : accepte la mise à jour, les couches périmées seront reprises au
      // prochain affichage.
      if (req.method === "POST") {
        const report = await getLayerUpdateReport({ force: true });
        const removed = await applyLayerUpdates(report);
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok", updated: removed }));
        return;
      }
    } catch (error) {
      log("LAYER_UPDATES_ERROR", { message: error?.message || String(error) });
      res.writeHead(200);
      // Une vérification impossible n'est pas une erreur pour l'utilisateur :
      // l'application continue de fonctionner avec ses couches actuelles.
      res.end(JSON.stringify({ checkedAt: null, outdated: [], added: [], offline: true }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/soilgrids/grid") {
    if (prepareApiResponse(req, res, ["GET"])) return;

    const bbox = parseBboxParam(requestUrl.searchParams.get("bbox"));
    const limit = parseIntegerParam(requestUrl.searchParams.get("limit"), 5000, 1, 20000);
    if (!bbox) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing or invalid bbox query parameter." }));
      return;
    }

    try {
      const payload = await soilGridService.queryVisibleGrid({ bboxWgs84: bbox, limit });
      res.writeHead(200);
      res.end(JSON.stringify(payload));
    } catch (error) {
      const message = error?.message || "SoilGrids grid query failed.";
      log("SOILGRIDS_GRID_ERROR", { message, bbox, limit });
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }
  if (requestUrl.pathname === "/api/soil/department") {
    if (prepareApiResponse(req, res, ["GET"])) return;

    const code = String(requestUrl.searchParams.get("code") || "")
      .trim()
      .toUpperCase();
    const bbox = parseBboxParam(requestUrl.searchParams.get("bbox"));
    const limit = parseIntegerParam(requestUrl.searchParams.get("limit"), 7000, 1, 20000);

    if (!code || !bbox) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing or invalid code/bbox query parameters." }));
      return;
    }

    // La couche du département est téléchargée au premier usage si elle manque.
    let filePath;
    try {
      filePath = await ensureLayer("soilmap_dep", `code_insee_${code}.gpkg`);
    } catch (error) {
      res.writeHead(503);
      res.end(
        JSON.stringify({
          error: `Téléchargement de la carte des sols du département ${code} impossible : ${error?.message || "erreur réseau"}`,
        })
      );
      return;
    }
    if (!filePath) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Aucune carte des sols pour le département ${code}.` }));
      return;
    }

    try {
      const collection = await queryGeoPackageByBbox({
        filePath,
        bbox,
        maxFeatures: limit,
      });
      res.writeHead(200);
      res.end(
        JSON.stringify({
          code,
          bounds: bbox,
          featureCount: collection.features.length,
          collection,
        })
      );
    } catch (error) {
      const message = error?.message || "Soil query failed.";
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/toponymie/points") {
    if (prepareApiResponse(req, res, ["GET"])) return;

    const region = String(requestUrl.searchParams.get("region") || "")
      .trim()
      .toUpperCase();
    const bbox = parseBboxParam(requestUrl.searchParams.get("bbox"));
    const limit = parseIntegerParam(requestUrl.searchParams.get("limit"), 8000, 1, 25000);
    const fileName = TOPONYMIE_FILES[region];
    if (!fileName || !bbox) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing or invalid region/bbox query parameters." }));
      return;
    }

    let filePath;
    try {
      filePath = await ensureLayer("TOPONYMIE", fileName);
    } catch (error) {
      res.writeHead(503);
      res.end(
        JSON.stringify({
          error: `Téléchargement de la toponymie ${region} impossible : ${error?.message || "erreur réseau"}`,
        })
      );
      return;
    }
    if (!filePath) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: `Aucune toponymie disponible pour la région ${region}.` }));
      return;
    }

    try {
      const collection = await queryGeoPackageByBbox({
        filePath,
        bbox,
        maxFeatures: limit,
        geometryTypes: new Set(["Point"]),
      });
      const points = collection.features.map((feature) => ({
        coordinates: feature.geometry?.coordinates || null,
        properties: feature.properties || {},
      }));
      res.writeHead(200);
      res.end(
        JSON.stringify({
          region,
          bounds: bbox,
          pointCount: points.length,
          points,
        })
      );
    } catch (error) {
      const message = error?.message || "Toponymy query failed.";
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/rpg-romania") {
    if (prepareApiResponse(req, res, ["GET"])) return;

    const bbox = parseBboxParam(requestUrl.searchParams.get("bbox"));
    const limit = parseIntegerParam(requestUrl.searchParams.get("limit"), 1000, 1, 1000);
    if (!bbox) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing or invalid bbox query parameter." }));
      return;
    }

    try {
      // Le parcellaire roumain est découpé par région : on ne récupère que les
      // régions qui croisent l'emprise affichée, pas les 2,3 Go du jeu complet.
      await ensureDatasetForBbox("rpg-romania", bbox);
      const collection = queryRpgRomaniaByBbox({
        dirPath: RPG_ROMANIA_DIR,
        bbox,
        maxFeatures: limit,
      });
      res.writeHead(200);
      res.end(
        JSON.stringify({
          bounds: bbox,
          featureCount: collection.features.length,
          collection,
        })
      );
    } catch (error) {
      const message = error?.message || "RPG Romania query failed.";
      log("RPG_ROMANIA_ERROR", { message, bbox, limit });
      res.writeHead(500);
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (requestUrl.pathname.startsWith("/api/parcelles")) {
    if (prepareApiResponse(req, res, ["GET", "PUT", "POST"])) return;
    if (req.method === "GET") return void res.writeHead(200).end(JSON.stringify(await readCollection()));

    if (requestUrl.pathname.startsWith("/api/parcelles/matching/validate") && req.method === "POST") {
      try {
        const payload = JSON.parse(await readBody(req, MAX_BODY_BYTES));
        const oldYear = Number(payload?.oldYear);
        const newYear = Number(payload?.newYear);
        if (!Number.isFinite(oldYear) || !Number.isFinite(newYear)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid year payload." }));
          return;
        }
        const matches = Array.isArray(payload?.matches) ? payload.matches : [];
        const correspondancesValidated = {};
        matches.forEach((match) => {
          const oldId = match?.oldId ?? match?.oldKey ?? match?.old;
          const newId = match?.newId ?? match?.newKey ?? match?.new;
          if (oldId != null && newId != null) correspondancesValidated[String(oldId)] = String(newId);
        });

        const collection = await readCollection();
        const parcellesByYear = buildParcellesByYearFromFeatures(
          Array.isArray(collection?.features) ? collection.features : []
        );
        const { parcellesByYear: mergedParcellesByYear } = applyCorrespondencesAndMerge({
          parcellesByYear,
          oldYear,
          newYear,
          correspondancesValidated,
          dropOldYear: true,
        });
        const oldCollection = mergedParcellesByYear?.[oldYear] || emptyCollection();
        const newCollection = mergedParcellesByYear?.[newYear] || emptyCollection();
        const otherFeatures = (collection?.features || []).filter((feature) => {
          const year = Number(feature?.properties?.annee);
          if (!Number.isFinite(year)) return true;
          return year !== oldYear && year !== newYear;
        });
        const mergedCollection = {
          type: "FeatureCollection",
          features: [...otherFeatures, ...(oldCollection.features || []), ...(newCollection.features || [])],
        };

        await writeCollection(mergedCollection);
        res.writeHead(200);
        res.end(
          JSON.stringify({
            status: "ok",
            collection: mergedCollection,
            parcellesOldYear: oldCollection,
            parcellesNewYear: newCollection,
          })
        );
      } catch (error) {
        sendBodyError(req, res, error);
      }
      return;
    }

    if (req.method === "PUT") {
      try {
        const parsed = JSON.parse(await readBody(req, MAX_BODY_BYTES));
        if (!parsed || parsed.type !== "FeatureCollection") {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid FeatureCollection payload." }));
          return;
        }
        await writeCollection(parsed);
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok" }));
      } catch (error) {
        sendBodyError(req, res, error);
      }
      return;
    }

    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/soil-type-mappings")) {
    if (prepareApiResponse(req, res, ["GET", "PUT"])) return;
    if (req.method === "GET") return void res.writeHead(200).end(JSON.stringify(await readSoilMappings()));
    try {
      await writeSoilMappings(JSON.parse(await readBody(req, MAX_BODY_BYTES)));
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
    } catch (error) {
      sendBodyError(req, res, error);
    }
    return;
  }

  if (!requestUrl.pathname.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) {
    // Couches et référentiels : servis depuis public/data, jamais depuis dist/.
    if (requestUrl.pathname.startsWith("/data/")) {
      if (await servePublicData(requestUrl, res)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Couche introuvable");
      return;
    }
    // Sinon : application compilée si elle est disponible. Une route /api
    // inconnue reste un 404 franc, elle ne doit pas renvoyer la page HTML.
    if (await serveStatic(requestUrl, res)) return;
  }

  res.writeHead(404);
  res.end();
};

// Sans ce filet, une URL mal encodée (/data/%E0%A4%A) arrêtait tout le serveur.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const malformed = error instanceof URIError || error?.code === "ERR_INVALID_URL";
    if (!malformed) log("REQUEST_ERROR", { url: req.url, message: error?.message || String(error) });
    if (res.headersSent) return void res.destroy();
    res.writeHead(malformed ? 400 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: malformed ? "URL invalide." : "Erreur interne du serveur." }));
  });
});

server.listen(PORT, HOST, () => {
  if (isLoopbackAddress(HOST)) {
    console.log(`GeoJSON backend listening on http://localhost:${PORT}`);
  } else {
    console.warn(
      `[SECURITE] Serveur exposé sur le réseau (${HOST}:${PORT}), sans authentification. ` +
        `Origines acceptées : ${[...ACCESS_POLICY.origins].join(", ")}`
    );
  }
  // Vérification des couches en tâche de fond : le résultat est prêt quand
  // l'interface le demande, et son échec n'empêche jamais le démarrage.
  scheduleStartupCheck();
});

process.on("exit", () => {
  closeGeoPackageCache();
  closeRpgRomaniaCache();
});

