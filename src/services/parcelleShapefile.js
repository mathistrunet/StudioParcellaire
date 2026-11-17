import { ringAreaM2 } from "../utils/geometry";
import { toLambert93 } from "../utils/proj";
import { createShapefileZip } from "./shapefileWriter";
import { labelFromCode } from "../utils/cultureLabels";
import { getCultureColumn, readCultureValue } from "../domain/parcelles/cultureColumns";
import { readInterculture } from "../domain/parcelles/intercultures";

// Les parcelles exportées sont toutes principales : une interculture n'est pas une
// parcelle de plus mais une valeur de la parcelle (CIP_CULTU, comme chez Geofolia).
const TYPE_PARCELLE_LABEL = "Parcelle principale";

// Noms, types et tailles repris de l'« Export spécifique (SHP) » de Geofolia, relu
// par Assolia. Les libellés de culture gardent plus de place (100 au lieu de 25) :
// un libellé tronqué ne se rattache plus à rien.
const PARCEL_FIELD_SCHEMA = [
  { name: "CODE_EXPLO", type: "C", size: 20 },
  { name: "RAIS_SOCIA", type: "C", size: 50 },
  { name: "CAMPAGNE", type: "N", size: 4, decimal: 0 },
  { name: "GUID_PARC", type: "C", size: 36 },
  { name: "TYPE_PARC", type: "C", size: 30 },
  { name: "NOM_PARCEL", type: "C", size: 253 },
  { name: "SURFACE", type: "N", size: 17, decimal: 7 },
  { name: "CP_CULTU", type: "C", size: 100 },
  { name: "CULT_PREC", type: "C", size: 100 },
  { name: "CULT_PREC2", type: "C", size: 100 },
  { name: "CIP_CULTU", type: "C", size: 100 },
  { name: "TYPE_SOL", type: "C", size: 75 },
];

const CULTURE_LABEL_KEYS = [
  "LIB_CULTURE",
  "LIB_CULTU",
  "NOM_CULTURE",
  "LIBELLE_CULTURE",
  "CP_CULTU_LIB",
];

function randomCodeExploit() {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
}

function randomGuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function pickFirstValue(props, keys) {
  for (const key of keys) {
    const value = props[key];
    if (value != null) {
      const trimmed = String(value).trim();
      if (trimmed !== "") return trimmed;
    }
  }
  return "";
}

/** Libellé d'une culture : le libellé du codebook pour un code PAC, sinon la valeur telle quelle. */
function cultureLabel(raw) {
  const value = raw == null ? "" : String(raw).trim();
  if (!value) return "";
  return labelFromCode(value.toUpperCase()) || value;
}

function resolveCultureLabel(props, columnId) {
  if (columnId === "current") {
    const direct = pickFirstValue(props, CULTURE_LABEL_KEYS);
    if (direct) return direct;
  }
  return cultureLabel(readCultureValue(props, getCultureColumn(columnId)));
}

function computeSurfaceHa(feature) {
  const { geometry } = feature || {};
  if (!geometry) return 0;
  if (geometry.type === "Polygon") {
    const ring = geometry.coordinates?.[0] ?? [];
    return Math.abs(ringAreaM2(ring)) / 10000;
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.reduce((sum, polygon) => {
      const ring = polygon?.[0] ?? [];
      return sum + Math.abs(ringAreaM2(ring)) / 10000;
    }, 0);
  }
  return 0;
}

function ensureGuid(props = {}) {
  const existing = props.GUID_PARC || props.guid_parcelle || props.guid;
  if (existing) return existing;
  const guid = randomGuid();
  props.GUID_PARC = guid;
  props.guid_parcelle = guid;
  return guid;
}

function ensureCodeExploit(features, fallback) {
  for (const feature of features) {
    const props = feature?.properties || {};
    const code = props.CODE_EXPLO || props.code_exploitation || props.code_explo;
    if (code != null && String(code).trim() !== "") {
      return String(code).trim();
    }
  }
  return fallback ?? randomCodeExploit();
}

function normalizeParcelFeature(feature, meta, index) {
  if (!feature || !feature.geometry) return null;
  if (feature.geometry.type !== "Polygon" && feature.geometry.type !== "MultiPolygon") {
    return null;
  }

  const props = { ...(feature.properties || {}) };
  const guid = ensureGuid(props);
  const name = pickFirstValue(props, ["NOM_PARCEL", "nom_parcelle", "nom_affiche", "nom"])
    || `Parcelle ${index + 1}`;
  const typeSol = pickFirstValue(props, ["TYPE_SOL", "type_sol"]);
  const surfaceHa = computeSurfaceHa(feature);

  const campagneInt = Number.isFinite(meta.campagneInt)
    ? meta.campagneInt
    : Number.parseInt(meta.campagne, 10);
  const campagneValue = Number.isFinite(campagneInt)
    ? Math.trunc(campagneInt)
    : new Date().getFullYear();

  // Le texte est encodé en Windows-1252 par l'écrivain du .dbf.
  const shapeProps = {
    CODE_EXPLO: meta.codeExploit,
    RAIS_SOCIA: meta.raisSoc,
    CAMPAGNE: campagneValue,
    GUID_PARC: guid,
    TYPE_PARC: TYPE_PARCELLE_LABEL,
    NOM_PARCEL: name,
    SURFACE: surfaceHa,
    CP_CULTU: resolveCultureLabel(props, "current"),
    // CULT_PREC portait la culture N-2 : c'est le précédent, donc N-1.
    CULT_PREC: resolveCultureLabel(props, "prev1"),
    CULT_PREC2: resolveCultureLabel(props, "prev2"),
    CIP_CULTU: cultureLabel(readInterculture(props)),
    TYPE_SOL: typeSol,
  };

  return {
    feature: { ...feature, properties: props },
    shapefileFeature: {
      type: "Feature",
      geometry: feature.geometry,
      properties: shapeProps,
    },
  };
}

function projectRingToLambert(ring = []) {
  return ring.map((coord) => {
    const [lon, lat] = Array.isArray(coord) ? coord : [0, 0];
    const [x, y] = toLambert93([lon, lat]);
    return [x, y];
  });
}

function projectGeometryToLambert(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: (geometry.coordinates || []).map((ring) => projectRingToLambert(ring)),
    };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: (geometry.coordinates || []).map((polygon) =>
        (polygon || []).map((ring) => projectRingToLambert(ring))
      ),
    };
  }
  return null;
}

function projectFeaturesToLambert(features) {
  return features
    .map((feature) => {
      const geometry = projectGeometryToLambert(feature.geometry);
      if (!geometry) return null;
      return { ...feature, geometry };
    })
    .filter(Boolean);
}

export async function buildParcelShapefileZip(features, { raisSoc, campagne, codeExploit } = {}) {
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error("NO_PARCELS");
  }
  const rais = (raisSoc ?? "").trim().toUpperCase();
  if (!rais) {
    throw new Error("RAIS_SOCIA_REQUIRED");
  }
  const currentYear = new Date().getFullYear().toString();
  const campagneInput = (campagne ?? currentYear).toString().trim() || currentYear;
  const campagneValue = campagneInput;
  const campagneInt = Number.parseInt(campagneInput, 10);

  const codeValue = ensureCodeExploit(features, codeExploit);

  const normalized = [];
  const shapefileFeatures = [];

  features.forEach((feature, index) => {
    const normalizedEntry = normalizeParcelFeature(
      feature,
      {
        raisSoc: rais,
        campagne: campagneValue,
        campagneInt: Number.isFinite(campagneInt) ? campagneInt : undefined,
        codeExploit: codeValue,
      },
      index
    );
    if (!normalizedEntry) return;
    const { feature: nextFeature, shapefileFeature } = normalizedEntry;
    nextFeature.properties = {
      ...(nextFeature.properties || {}),
      CODE_EXPLO: codeValue,
      code_exploitation: codeValue,
      GUID_PARC: shapefileFeature.properties.GUID_PARC,
      guid_parcelle: shapefileFeature.properties.GUID_PARC,
    };
    normalized.push(nextFeature);
    shapefileFeatures.push(shapefileFeature);
  });

  if (!shapefileFeatures.length) {
    throw new Error("NO_POLYGONS");
  }

  const lambertFeatures = projectFeaturesToLambert(shapefileFeatures);
  const arrayBuffer = await createShapefileZip({
    features: lambertFeatures,
    baseName: rais,
    fields: PARCEL_FIELD_SCHEMA,
  });
  const blob = new Blob([arrayBuffer], { type: "application/zip" });

  return { blob, updatedFeatures: normalized };
}
