// src/services/parcellesCsv.js
import { parse } from "csv-parse/browser/esm/sync";
import { featureAreaHa } from "../utils/geometry";
import {
  codeFromLabel,
  labelFromCode,
  resolvePrecisionForCode,
  splitCultureKey,
} from "../utils/cultureLabels";
import { buildError, ERROR_CODES } from "../utils/errors";
import { withBasePath } from "../utils/publicBase";
import { getCultureColumn, readCultureValue } from "../domain/parcelles/cultureColumns";

const CSV_HEADERS = [
  "Secteur",
  "Exploitation",
  "Numero pacage",
  "Parcelles",
  "Surface parcelle",
  "Parcelle Bio",
  "Type de sol",
  "Irrigabilité",
  "CultureN",
  "CultureN1",
  "CultureN2",
  "CultureN3",
  "CultureN4",
  "Geometrie",
];

const ASSOLIA_CULTURES_PATH = withBasePath("/data/assolia_cultures_export.csv");

const PRECISION_KEYS_BY_INDEX = ["precision", "precision_n1", "precision_n2", "precision_n3", "precision_n4", "precision_n5", "precision_n6"];
let assoliaCulturesPromise;

function escapeCsvCell(value) {
  const str = value == null ? "" : String(value);
  if (/[";\t\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function normalizeHeaderKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function getFirstOuterRing(feature) {
  if (!feature?.geometry) return null;
  const { type, coordinates } = feature.geometry;
  if (type === "Polygon") return coordinates?.[0] || null;
  if (type === "MultiPolygon") return coordinates?.[0]?.[0] || null;
  return null;
}

function formatNumber(value, decimals = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.?0+$/, "");
}

function formatCoord(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  const fixed = value.toFixed(12);
  return fixed.replace(/\.?0+$/, "");
}

function formatCultureValue(raw) {
  if (raw == null) return "";
  const value = String(raw).trim();
  if (!value) return "";
  return labelFromCode(value) || value;
}

function normalizeStructureName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function getMetacodeFromValue(raw) {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const fromLabel = codeFromLabel(trimmed);
  if (fromLabel) {
    const split = splitCultureKey(fromLabel);
    return String(split.code || fromLabel).trim().toUpperCase();
  }
  const upper = trimmed.toUpperCase();
  if (labelFromCode(upper)) return upper;
  if (/^[A-Z0-9]{2,10}$/.test(upper)) return upper;
  return "";
}

/**
 * Emplacements essayés pour le référentiel des cultures Assolia.
 *
 * `withBasePath` produit une URL relative quand l'application est construite avec
 * `base: "./"` : elle se résout alors contre l'adresse de la page, ce qui échoue
 * dès que celle-ci porte un segment de chemin. On retente donc en absolu, puis
 * sur la copie versionnée du dépôt que le serveur local sait servir. Sans cela,
 * un seul emplacement manquant privait l'export CSV de toute la correspondance
 * de structures — et la liste des structures restait vide sans explication.
 */
const ASSOLIA_CULTURES_URLS = [
  ASSOLIA_CULTURES_PATH,
  "/data/assolia_cultures_export.csv",
  "data/assolia_cultures_export.csv",
];

const parseAssoliaCsv = (text) =>
  parse(text, {
    columns: true,
    delimiter: ";",
    relax_quotes: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

async function fetchAssoliaCulturesText() {
  const echecs = [];
  for (const url of ASSOLIA_CULTURES_URLS) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        echecs.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      // Une route inconnue peut retomber sur index.html : on refuse le HTML,
      // sinon l'analyse CSV réussirait sur une page web et rendrait zéro structure.
      if (/^\s*<(?:!doctype|html)/i.test(text)) {
        echecs.push(`${url} → page HTML au lieu du CSV`);
        continue;
      }
      return text;
    } catch (error) {
      echecs.push(`${url} → ${error?.message || "échec réseau"}`);
    }
  }
  throw new Error(
    `Chargement du référentiel cultures impossible (${echecs.join(" ; ")}).`
  );
}

async function loadAssoliaCulturesExport() {
  if (!assoliaCulturesPromise) {
    assoliaCulturesPromise = fetchAssoliaCulturesText()
      .then(parseAssoliaCsv)
      .catch((error) => {
        assoliaCulturesPromise = null; // permet une nouvelle tentative au prochain appel
        throw error;
      });
  }
  return assoliaCulturesPromise;
}

const AUTRE_ASSOLE = "Autre assolé";

/**
 * Nom de culture comparable d'une source à l'autre : sans casse, accent ni
 * ponctuation. « RAY-GRASS DÉROBÉE » (Geofolia) et « Ray-grass dérobée » se valent.
 */
function normalizeCultureName(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/œ/g, "oe")
    .replace(/[^a-z0-9>]+/g, " ")
    .trim();
}

// Index « libellé normalisé → code PAC » du codebook, refait seulement si le
// codebook chargé change. Il rattache un libellé saisi ou importé (« BLÉ TENDRE
// D'HIVER » de Geofolia) au libellé officiel (« Blé tendre d’hiver ») malgré la
// casse, les accents et l'apostrophe typographique.
let pacNameIndexCache = { source: undefined, index: new Map() };
function pacNameIndex() {
  const source = typeof window !== "undefined" ? window.CODEBOOK_EXTRA : null;
  if (pacNameIndexCache.source !== source) {
    // Tout le codebook, codes sans précision d'abord : entriesCodebook() écarte le
    // code nu (« BTH ») dès qu'il a des précisions, or c'est son libellé qu'on cherche.
    const entries = Object.entries(source && typeof source === "object" ? source : {})
      .map(([key, label]) => [String(key).trim().toUpperCase(), String(label)])
      .sort(([x], [y]) => Number(x.includes("|")) - Number(y.includes("|")));
    const index = new Map();
    for (const [key, label] of entries) {
      const name = normalizeCultureName(label);
      if (name && !index.has(name)) index.set(name, key);
    }
    pacNameIndexCache = { source, index };
  }
  return pacNameIndexCache.index;
}

/** Code PAC (et précision) d'un libellé, par comparaison normalisée ; `null` sinon. */
function pacKeyFromName(raw) {
  const key = codeFromLabel(String(raw || "").trim()) || pacNameIndex().get(normalizeCultureName(raw));
  return key ? splitCultureKey(key) : null;
}

async function getStructureCultureLookup(structureName) {
  const normalizedStructure = normalizeStructureName(structureName);
  if (!normalizedStructure) return null;
  const entries = await loadAssoliaCulturesExport();
  const byMetacode = {};
  const byCultureName = {};
  const byName = {};
  const names = [];
  let fallbackName = "";
  entries.forEach((entry) => {
    const structure = normalizeStructureName(entry.structure_name);
    if (structure !== normalizedStructure) return;
    const metacode = String(entry.metacode || "").trim().toUpperCase();
    const name = String(entry.culture_name || "").trim();
    if (!name) return;
    const normalizedName = normalizeStructureName(name);
    if (metacode && normalizedName && !byCultureName[normalizedName]) {
      byCultureName[normalizedName] = metacode;
    }
    const comparable = normalizeCultureName(name);
    if (comparable && !byName[comparable]) {
      byName[comparable] = name;
      names.push(name);
    }
    if (metacode) {
      byMetacode[metacode] = name;
    } else if (!fallbackName && comparable === "autre assole") {
      fallbackName = name;
    }
  });
  if (!names.length) return null;
  names.sort((x, y) => x.localeCompare(y, "fr"));
  return { byMetacode, byCultureName, byName, names, fallbackName: fallbackName || AUTRE_ASSOLE };
}

/**
 * Culture de la structure cible pour une valeur du parcellaire.
 *
 * Dans l'ordre : le nom exact d'une culture de la structure (un libellé Geofolia
 * comme « Blé tendre d'hiver » n'a pas de code PAC mais existe souvent tel quel),
 * puis le code PAC avec sa précision (blé bio ≠ blé standard), puis le code seul.
 * Sans correspondance : « Autre assolé ». Une case vide reste vide.
 */
function resolveStructureCulture(lookup, raw, precision = "") {
  const value = raw == null ? "" : String(raw).trim();
  if (!value) return { value: "", matched: true };
  const label = labelFromCode(value.toUpperCase()) || value;
  const byName = lookup.byName[normalizeCultureName(label)] || lookup.byName[normalizeCultureName(value)];
  if (byName) return { value: byName, matched: true };
  const fromName = pacKeyFromName(value);
  const candidates = [
    { code: getMetacodeFromValue(value), precision },
    fromName ? { code: fromName.code, precision: precision || fromName.precision } : null,
  ];
  for (const candidate of candidates) {
    const metacode = candidate?.code;
    if (!metacode) continue;
    const precisionTrimmed = String(candidate.precision || "").trim();
    if (precisionTrimmed && lookup.byMetacode[`${metacode}|${precisionTrimmed}`]) {
      return { value: lookup.byMetacode[`${metacode}|${precisionTrimmed}`], matched: true };
    }
    if (lookup.byMetacode[metacode]) return { value: lookup.byMetacode[metacode], matched: true };
  }
  return { value: lookup.fallbackName, matched: false };
}

function buildCultureProps(cultureValues, offset) {
  const props = {};
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  cultureValues.forEach((entry, index) => {
    if (!entry?.value && !entry?.code) return;
    const targetIndex = index + safeOffset;
    const key = targetIndex === 0 ? "cultureN" : `cultureN_${targetIndex}`;
    if (entry.value) props[key] = entry.value;
    if (entry.code && targetIndex === 0) props.code = entry.code;
    const precisionKey = PRECISION_KEYS_BY_INDEX[targetIndex];
    if (precisionKey && entry.precision) props[precisionKey] = entry.precision;
  });
  return props;
}

function formatParcelleBioValue(raw) {
  if (raw == null || String(raw).trim() === "") {
    return "Non";
  }
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "oui", "yes", "y"].includes(normalized)) {
    return "Oui";
  }
  if (["0", "false", "non", "no", "n"].includes(normalized)) {
    return "Non";
  }
  return String(raw);
}

// Irrigabilité : même convention Oui/Non que la colonne bio. Une parcelle sans
// information est exportée « Non », valeur attendue par Assolia pour une
// parcelle non irrigable.
const formatIrrigabiliteValue = formatParcelleBioValue;

// Clés possibles pour l'irrigabilité selon la provenance de la parcelle
// (saisie dans l'outil, réimport CSV, shapefile en majuscules).
const IRRIGABLE_KEYS = ["irrigable", "IRRIGABLE", "irrigabilite", "irrigabilité", "irrigation"];

function parseCultureValue(raw, structureLookup = null) {
  const trimmed = raw == null ? "" : String(raw).trim();
  if (!trimmed) return { value: "", code: "", precision: "" };
  const structureCode = structureLookup?.byCultureName?.[normalizeStructureName(trimmed)];
  if (structureCode) {
    const split = splitCultureKey(structureCode);
    const resolvedPrecision = resolvePrecisionForCode(split.code, split.precision);
    return { value: split.code, code: split.code, precision: resolvedPrecision };
  }
  const fromLabel = codeFromLabel(trimmed);
  if (fromLabel) {
    const split = splitCultureKey(fromLabel);
    const resolvedPrecision = resolvePrecisionForCode(split.code, split.precision);
    return { value: split.code, code: split.code, precision: resolvedPrecision };
  }
  if (/^[A-Za-z0-9]{2,10}(\|[0-9]{1,3})?$/.test(trimmed)) {
    const split = splitCultureKey(trimmed);
    const resolvedPrecision = resolvePrecisionForCode(split.code, split.precision);
    return { value: split.code, code: split.code, precision: resolvedPrecision };
  }
  const upper = trimmed.toUpperCase();
  if (labelFromCode(upper)) return { value: upper, code: upper, precision: resolvePrecisionForCode(upper, "") };
  return { value: trimmed, code: "", precision: "" };
}

function parseSurfaceValue(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).trim().replace(",", ".");
  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Ferme l'anneau et écarte ce qui ne forme pas une surface. */
function finalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat) {
    ring.push([firstLon, firstLat]);
  }
  return ring;
}

/** Format Assolia natif : « lon,lat lon,lat … ». */
function parseRingFromPairs(text) {
  const ring = [];
  for (const pair of text.split(/\s+/)) {
    const [lonStr, latStr] = pair.split(",");
    if (!lonStr || !latStr) continue;
    const lon = parseFloat(lonStr);
    const lat = parseFloat(latStr);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    ring.push([lon, lat]);
  }
  return finalizeRing(ring);
}

/** POLYGON((x y, x y…)) et MULTIPOLYGON(((…))) — seul l'anneau extérieur est retenu. */
function parseRingFromWkt(text) {
  const upper = text.toUpperCase();
  if (!upper.startsWith("POLYGON") && !upper.startsWith("MULTIPOLYGON")) return null;
  const premier = text.slice(text.indexOf("(")).match(/\(\s*(-?\d[^()]*)\)/);
  if (!premier) return null;
  const ring = [];
  for (const couple of premier[1].split(",")) {
    const [lonStr, latStr] = couple.trim().split(/\s+/);
    const lon = parseFloat(lonStr);
    const lat = parseFloat(latStr);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    ring.push([lon, lat]);
  }
  return finalizeRing(ring);
}

/** Géométrie GeoJSON, ou Feature enveloppant une géométrie. */
function parseRingFromGeoJson(text) {
  if (!text.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const geometry = parsed?.type === "Feature" ? parsed.geometry : parsed;
  const coords = geometry?.coordinates;
  if (geometry?.type === "Polygon" && Array.isArray(coords?.[0])) {
    return finalizeRing([...coords[0]]);
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(coords?.[0]?.[0])) {
    return finalizeRing([...coords[0][0]]);
  }
  return null;
}

/**
 * Anneau extérieur d'une cellule de géométrie.
 *
 * Trois écritures acceptées : le format Assolia natif (« lon,lat lon,lat… »),
 * le WKT et la géométrie GeoJSON. L'écran d'accueil annonce WKT et GeoJSON
 * depuis toujours, mais seul le format Assolia était lu : un CSV produit par un
 * SIG s'importait sans lever d'erreur et sans créer la moindre parcelle.
 */
function parseGeometry(raw) {
  const text = raw == null ? "" : String(raw).trim();
  if (!text) return null;
  return (
    parseRingFromGeoJson(text) ??
    parseRingFromWkt(text) ??
    parseRingFromPairs(text)
  );
}

// Intitulés reconnus pour la colonne de géométrie, après normalisation
// (minuscules, sans accent ni séparateur).
const GEOMETRY_COLUMN_KEYS = [
  "geometrie",
  "geometry",
  "geom",
  "thegeom",
  "wkt",
  "geojson",
  "geometriewkt",
];

function readGeometryCell(map) {
  for (const key of GEOMETRY_COLUMN_KEYS) {
    const value = map.get(key);
    if (value != null && String(value).trim() !== "") return value;
  }
  return null;
}

function formatGeometry(feature) {
  const ring = getFirstOuterRing(feature);
  if (!Array.isArray(ring) || !ring.length) return "";
  return ring
    .map(([lon, lat]) => `${formatCoord(lon)},${formatCoord(lat)}`)
    .join(" ");
}

function normalizeRowMap(row) {
  const map = new Map();
  Object.entries(row).forEach(([key, value]) => {
    map.set(normalizeHeaderKey(key), value);
  });
  return map;
}

// Clés de repli pour les cultures précédentes N-1..N-4. Elles proviennent de la
// description unique des colonnes : les imports Télépac/shapefile rangent le
// précédent sous des alias variés (culture_prec, cultureN1, precedent…), et
// l'export doit voir exactement ce que le tableau affiche.
const CULTURE_PREV_KEYS = ["prev1", "prev2", "prev3", "prev4"].map(
  (id) => getCultureColumn(id).readKeys
);

// Retourne la première valeur non vide parmi une liste de clés de propriété.
function firstNonEmptyProp(props, keys) {
  for (const key of keys) {
    const v = props?.[key];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
}

// Lit la précision pour un indice d'année donné (0 = culture N, 1 = N-1, etc.)
function getPrecisionByYearIndex(props, yearIndex) {
  const keys =
    yearIndex === 0
      ? ["precision", "precision_n", "precision_n0", "precision_n_0"]
      : [`precision_n${yearIndex}`, `precision_n_${yearIndex}`];
  for (const key of keys) {
    const value = props[key];
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

/** Libellé affiché d'une culture : celui du codebook pour un code PAC, sinon la valeur. */
function cultureDisplayLabel(raw) {
  const value = raw == null ? "" : String(raw).trim();
  if (!value) return "";
  return labelFromCode(value.toUpperCase()) || value;
}

/** Cultures N à N-4 telles que l'export les lit, avec leur précision. */
function exportCultureEntries(props) {
  const current = readCultureValue(props, getCultureColumn("current"));
  return [current, ...CULTURE_PREV_KEYS.map((keys) => firstNonEmptyProp(props, keys))].map(
    (raw, index) => ({
      value: raw == null ? "" : String(raw).trim(),
      precision: getPrecisionByYearIndex(props, index),
    })
  );
}

/** Code PAC reconnu par le codebook, `""` sinon (un libellé libre n'en a pas). */
function getPacCode(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const fromName = pacKeyFromName(value);
  if (fromName) return fromName.code;
  const { code } = splitCultureKey(value);
  return labelFromCode(code) ? code : "";
}

/**
 * Cultures distinctes d'un export, pour la table de remplacement de la boîte
 * d'export : libellé, nombre de cases concernées, code PAC reconnu et, quand une
 * structure cible est donnée, la culture de la structure choisie automatiquement.
 *
 * Les cultures non reconnues viennent en premier : ce sont elles qui sortiraient
 * en « Autre assolé » (avec structure) ou sous un libellé libre (sans structure).
 *
 * @returns {Promise<{ cultures: Array<{label, count, code, auto, reconnue}>, structureCultures: string[] }>}
 */
export async function describeExportCultures(features, structureName = "") {
  const lookup = structureName ? await getStructureCultureLookup(structureName) : null;
  const byLabel = new Map();
  (features || []).forEach((feature) => {
    exportCultureEntries(feature?.properties || {}).forEach(({ value, precision }) => {
      if (!value) return;
      const label = cultureDisplayLabel(value);
      let entry = byLabel.get(label);
      if (!entry) {
        const code = getPacCode(value);
        const resolved = lookup ? resolveStructureCulture(lookup, value, precision) : null;
        entry = {
          label,
          count: 0,
          code,
          auto: resolved ? resolved.value : label,
          reconnue: resolved ? resolved.matched : Boolean(code),
        };
        byLabel.set(label, entry);
      }
      entry.count += 1;
    });
  });
  const cultures = [...byLabel.values()].sort(
    (a, b) => Number(a.reconnue) - Number(b.reconnue) || a.label.localeCompare(b.label, "fr")
  );
  return { cultures, structureCultures: lookup ? lookup.names : [] };
}

export async function buildParcellesCsv(
  features,
  secteur,
  exploitation,
  codeExploitation,
  options = {}
) {
  let structureLookup = null;
  if (options.structureName) {
    try {
      structureLookup = await getStructureCultureLookup(options.structureName);
    } catch (error) {
      console.warn(error);
    }
  }

  // Remplacements choisis dans la boîte d'export, par libellé affiché : ils
  // priment sur la correspondance automatique (vide = automatique).
  const replacements = options.cultureReplacements || {};
  const exportCulture = ({ value, precision }) => {
    if (!value) return "";
    const replacement = String(replacements[cultureDisplayLabel(value)] ?? "").trim();
    if (replacement) return replacement;
    if (structureLookup) return resolveStructureCulture(structureLookup, value, precision).value;
    return formatCultureValue(value);
  };

  const rows = (features || []).map((feature, idx) => {
    const props = feature?.properties || {};
    const parcelleName =
      props.nom ??
      props.nom_affiche ??
      props.name ??
      `Parcelle ${idx + 1}`;
    const surfaceValue =
      parseSurfaceValue(props.surface_parcelle) ??
      parseSurfaceValue(props.surface) ??
      featureAreaHa(feature);
    // La conduite bio est portée par des clés différentes selon la provenance :
    // `parcelle_bio` (CSV Assolia), `isOrganic` (Télépac), `conduite_bio`
    // (saisie dans l'outil). Les omettre faisait sortir « Non » pour une
    // parcelle pourtant cochée AB.
    const parcelleBio = firstNonEmptyProp(props, [
      "parcelle_bio",
      "bio",
      "parcelleBio",
      "parcelle_bio_label",
      "conduite_bio",
      "isOrganic",
      "BIO",
    ]);
    const typeSol =
      props.type_sol ?? props.typeSol ?? props.type_de_sol ?? props.sol ?? "";
    const irrigable = firstNonEmptyProp(props, IRRIGABLE_KEYS);
    const cultures = exportCultureEntries(props).map(exportCulture);

    return [
      secteur || props.secteur || "",
      exploitation || props.exploitation || props.exploitations || "",
      codeExploitation || props.code_exploitation || props.codeExploitation || "",
      parcelleName,
      formatNumber(surfaceValue),
      formatParcelleBioValue(parcelleBio),
      typeSol == null ? "" : String(typeSol),
      formatIrrigabiliteValue(irrigable),
      ...cultures,
      formatGeometry(feature),
    ];
  });

  return [CSV_HEADERS, ...rows]
    .map((row) => row.map(escapeCsvCell).join(";"))
    .join("\r\n");
}

export async function parseParcellesCsvToFeatures(file, options = {}) {
  const cultureYearOffset = Number.isFinite(options.cultureYearOffset)
    ? options.cultureYearOffset
    : 0;
  let structureLookup = null;
  if (options.structureName) {
    try {
      structureLookup = await getStructureCultureLookup(options.structureName);
    } catch (error) {
      console.warn(error);
    }
  }
  const text = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result);
    r.readAsText(file, "utf-8");
  });

  let rows = [];
  try {
    rows = parse(text, {
      columns: true,
      delimiter: [";", "\t"],
      relax_quotes: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
    });
  } catch (error) {
    throw buildError(
      ERROR_CODES.CSV_PARSE_FAILED,
      "Impossible d'analyser le fichier CSV.",
      error
    );
  }

  const features = [];
  for (const row of rows) {
    const map = normalizeRowMap(row);
    const secteur = map.get("secteur") ?? "";
    const exploitation =
      map.get("exploitations") ?? map.get("exploitation") ?? "";
    const codeExploitation =
      map.get("codeexploitation") ?? map.get("numeropacage") ?? "";
    const parcelles = map.get("parcelles") ?? "";
    const surfaceParcelle = parseSurfaceValue(map.get("surfaceparcelle"));
    const parcelleBio = map.get("parcellebio") ?? "";
    const typeSol = map.get("typedsol") ?? map.get("typedesol") ?? "";
    const irrigable = map.get("irrigabilite") ?? map.get("irrigable") ?? "";
    const cultureN = parseCultureValue(map.get("culturen"), structureLookup);
    const cultureN1 = parseCultureValue(map.get("culturen1"), structureLookup);
    const cultureN2 = parseCultureValue(map.get("culturen2"), structureLookup);
    const cultureN3 = parseCultureValue(map.get("culturen3"), structureLookup);
    const cultureN4 = parseCultureValue(map.get("culturen4"), structureLookup);
    const ring = parseGeometry(readGeometryCell(map));
    if (!ring) continue;

    const cultureProps = buildCultureProps(
      [cultureN, cultureN1, cultureN2, cultureN3, cultureN4],
      cultureYearOffset
    );

    const properties = {
      ...(secteur ? { secteur } : {}),
      ...(exploitation ? { exploitation } : {}),
      ...(codeExploitation ? { code_exploitation: codeExploitation } : {}),
      ...(parcelles ? { nom: parcelles, nom_affiche: parcelles, nom_parcelle: parcelles, NOM_PARCEL: parcelles } : {}),
      ...(surfaceParcelle != null ? { surface_parcelle: surfaceParcelle } : {}),
      ...(parcelleBio ? { parcelle_bio: parcelleBio } : {}),
      ...(typeSol ? { type_sol: typeSol } : {}),
      ...(irrigable ? { irrigable, IRRIGABLE: irrigable } : {}),
      ...cultureProps,
    };

    features.push({
      type: "Feature",
      properties,
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  return features;
}




export async function loadAssoliaStructureNames() {
  const entries = await loadAssoliaCulturesExport();
  const byNormalized = new Map();
  entries.forEach((entry) => {
    const rawName = String(entry.structure_name || "").trim();
    if (!rawName) return;
    const normalized = normalizeStructureName(rawName);
    if (!normalized || byNormalized.has(normalized)) return;
    byNormalized.set(normalized, rawName);
  });
  return Array.from(byNormalized.values()).sort((a, b) => a.localeCompare(b, "fr"));
}

