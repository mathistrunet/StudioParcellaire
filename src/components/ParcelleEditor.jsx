// src/components/ParcelleEditor.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import centroid from "@turf/centroid";
import {
  entriesCodebook,
  labelFromCode,
  codeFromLabel,
  splitCultureKey,
  resolvePrecisionForCode,
} from "../utils/cultureLabels";
import { featureAreaM2 } from "../utils/geometry";
import { fetchRpgGeoJSON, getCultureLabel, getMapBoundsCRS84 } from "../services/rpg";
import { fetchParcelSoilGrids, fetchParcelWrb } from "../services/soilgridsBackend";
import { saveParcellesGeojson } from "../services/parcellesBackend";
import ParcelSoilPanel from "./ParcelSoilPanel";
import { RPG_MIN_ZOOM } from "../Front/useRpgLayer";
import {
  CULTURE_COLUMNS,
  clearCulture,
  hasCultureValue,
  readCulturePrecision,
  readCultureValue,
  setCulture,
} from "../domain/parcelles/cultureColumns";



function parseBioFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "oui") return true;
    if (normalized === "false" || normalized === "0" || normalized === "non") return false;
  }
  return false;
}

// Conduite bio : la clé varie selon la provenance de la parcelle — `parcelle_bio`
// pour un CSV Assolia, `isOrganic` pour un import Télépac, `conduite_bio` pour une
// saisie dans l'outil. On lit donc toutes ces clés, et on les réécrit ensemble
// pour que la case cochée ici ressorte bien dans la colonne « Parcelle Bio ».
const BIO_KEYS = ["isOrganic", "conduite_bio", "bio", "BIO", "parcelle_bio"];

function readBioFlag(props = {}) {
  for (const key of BIO_KEYS) {
    const value = props[key];
    if (value != null && String(value).trim() !== "") return parseBioFlag(value);
  }
  return false;
}

function setBioProps(props, bio) {
  const next = { ...props };
  if (bio) {
    next.conduite_bio = true;
    next.isOrganic = true;
    next.parcelle_bio = "Oui";
    if (!next.organicType) next.organicType = "AB";
  } else {
    BIO_KEYS.forEach((key) => delete next[key]);
    delete next.organicType;
  }
  return next;
}

// Irrigabilité : exportée dans la colonne « Irrigabilité » du CSV Assolia.
// La valeur est stockée en doublon minuscules/majuscules pour rester lisible
// après un aller-retour par shapefile (attributs en majuscules).
const IRRIGABLE_KEYS = ["irrigable", "IRRIGABLE", "irrigabilite", "irrigation"];

function readIrrigableFlag(props = {}) {
  for (const key of IRRIGABLE_KEYS) {
    const value = props[key];
    if (value != null && String(value).trim() !== "") return parseBioFlag(value);
  }
  return false;
}

function setIrrigableProps(props, irrigable) {
  const next = { ...props };
  if (irrigable) {
    next.irrigable = true;
    next.IRRIGABLE = true;
  } else {
    IRRIGABLE_KEYS.forEach((key) => delete next[key]);
  }
  return next;
}

function formatIlotParcelle(props = {}) {
  const ilot = String(props.ilot_numero ?? "").trim();
  const numero = String(props.numero ?? "").trim();
  if (ilot && numero) return `${ilot}.${numero}`;
  return ilot || numero;
}

function splitIlotParcelle(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) return { ilot: "", numero: "" };
  const dotIndex = text.indexOf(".");
  if (dotIndex < 0) return { ilot: text, numero: "" };
  const ilot = text.slice(0, dotIndex).trim();
  const numero = text.slice(dotIndex + 1).trim();
  return { ilot, numero };
}

const ADVANCED_COLUMNS = [
  { id: "production_semences", label: "Production semences", type: "bool" },
  { id: "production_fermiers", label: "Production fermiers", type: "bool" },
  { id: "deshydratation", label: "Deshydratation", type: "bool" },
  { id: "derogation_ukraine", label: "Derogation Ukraine", type: "bool" },
  { id: "accident_culture", label: "Accident culture", type: "bool" },
  { id: "culture_secondaire", label: "Culture secondaire", type: "text" },
  { id: "maec_elevage_monogastrique", label: "MAEC monogastrique", type: "bool" },
];

const buildEmptyTypedState = () =>
  CULTURE_COLUMNS.reduce((acc, col) => {
    acc[col.id] = {};
    return acc;
  }, {});

const RPG_AVAILABLE_YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

/**
 * Année de campagne représentée par la colonne « Culture N ».
 *
 * Elle est lue sur les parcelles (`annee`) et non sur l'horloge : un parcellaire
 * 2024 ouvert en 2026 doit interroger le RPG 2024 pour sa colonne N. Sans cela,
 * le bouton « Remplir » des colonnes N et N-1 renvoyait systématiquement
 * « aucune donnée RPG » puisqu'il visait des millésimes non encore publiés.
 */
const resolveBaseYearForN = (features) => {
  let latest = null;
  (features || []).forEach((feature) => {
    const year = Number(feature?.properties?.annee);
    if (!Number.isFinite(year)) return;
    if (latest == null || year > latest) latest = year;
  });
  return latest ?? new Date().getFullYear();
};

const getRpgYearForColumn = (columnId, baseYear) => {
  const column = CULTURE_COLUMNS.find((col) => col.id === columnId);
  if (!column) return null;
  return baseYear + column.offset;
};

function pointInRing(point, ring) {
  if (!Array.isArray(point) || point.length < 2) return false;
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]?.[0];
    const yi = ring[i]?.[1];
    const xj = ring[j]?.[0];
    const yj = ring[j]?.[1];
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return false;
  if (!pointInRing(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (pointInRing(point, polygon[i])) return false;
  }
  return true;
}

function pointInGeometry(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry.coordinates);
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates?.some((poly) => pointInPolygon(point, poly));
  }
  return false;
}

function computeGeometryBbox(geometry) {
  if (!geometry) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const register = (coord) => {
    if (!Array.isArray(coord) || coord.length < 2) return;
    const x = coord[0];
    const y = coord[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  const walkRing = (ring) => {
    if (!Array.isArray(ring)) return;
    ring.forEach(register);
  };

  const walkPolygon = (polygon) => {
    if (!Array.isArray(polygon)) return;
    polygon.forEach(walkRing);
  };

  if (geometry.type === "Polygon") {
    walkPolygon(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    geometry.coordinates?.forEach(walkPolygon);
  }

  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function buildRpgIndex(features) {
  if (!Array.isArray(features)) return [];
  return features
    .map((feature) => ({ feature, bbox: computeGeometryBbox(feature?.geometry) }))
    .filter((item) => Array.isArray(item.bbox));
}

/**
 * Cellule de tableau portant une case à cocher (Bio, Irrigable…).
 *
 * Le clic est arrêté au niveau de la cellule entière, pas seulement de la case :
 * la ligne du tableau déclenche la sélection de la parcelle sur la carte
 * (recadrage + changement de mode Draw). Sans cette barrière, un clic qui tombe
 * à côté de la case de 13 px — sur le libellé ou la marge — cochait la case tout
 * en relançant la sélection, ce qui faisait clignoter la case.
 */
function FlagCell({ cellStyle, checked, onToggle, label, title }) {
  return (
    <td style={cellStyle} onClick={(event) => event.stopPropagation()}>
      <label
        title={title}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 13,
          cursor: "pointer",
          padding: "2px 0",
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span>{label}</span>
      </label>
    </td>
  );
}

// ---------------------------------------------------------------------------
// Modèle de colonnes du tableau
//
// Une seule description sert à la fois à l'en-tête, aux cellules et au filtre
// d'affichage : ajouter une colonne ou la masquer ne demande de toucher qu'ici.
// Les largeurs sont des minimums — le tableau défile horizontalement plutôt que
// de comprimer les champs jusqu'à les rendre illisibles.
// ---------------------------------------------------------------------------
const FIXED_COLUMNS = [
  { id: "ilot", label: "Ilot.Parcelle", width: 120 },
  { id: "nom", label: "Nom", width: 190 },
  { id: "surface", label: "Surface (ha)", width: 95 },
  { id: "bio", label: "Bio", width: 70 },
  { id: "irrigable", label: "Irrigable", width: 85 },
];

// Indice de confiance (probabilité de la classe WRB, en %) renvoyé par SoilGrids.
// Format ISRIC : [["Cambisols", 30]] -> 30. Renvoie null si indisponible.
function extractSoilConfidence(probability) {
  if (Array.isArray(probability) && probability.length && Array.isArray(probability[0])) {
    const pct = Number(probability[0][1]);
    return Number.isFinite(pct) ? pct : null;
  }
  if (typeof probability === "number" && Number.isFinite(probability)) return probability;
  return null;
}

// Petit badge en lecture seule affiché à côté du type de sol issu de SoilGrids.
const confidenceBadgeStyle = {
  flex: "0 0 auto",
  border: "1px solid #d1d5db",
  background: "#f3f4f6",
  color: "#374151",
  borderRadius: 6,
  fontSize: 11,
  lineHeight: 1,
  padding: "2px 5px",
  whiteSpace: "nowrap",
};

const SOIL_COLUMN = { id: "type_sol", label: "Type de sol", width: 160 };

/** Toutes les colonnes proposées au filtre, dans l'ordre d'affichage. */
const ALL_COLUMNS = [
  ...FIXED_COLUMNS,
  ...CULTURE_COLUMNS.map((col) => ({ id: col.id, label: col.label, width: 150 })),
  SOIL_COLUMN,
  ...ADVANCED_COLUMNS.map((col) => ({ id: col.id, label: col.label, width: 150 })),
];

// Colonnes masquées au premier affichage : les options avancées et les
// millésimes les plus anciens, rarement renseignés, encombrent la saisie.
const DEFAULT_HIDDEN_COLUMNS = [
  ...ADVANCED_COLUMNS.map((col) => col.id),
  "prev5",
  "prev6",
];

const HIDDEN_COLUMNS_KEY = "studioparcellaire.colonnes-masquees";

const COLUMN_HINTS = {
  bio: "Conduite en agriculture biologique",
  irrigable: "Parcelle irrigable — colonne « Irrigabilité » du CSV Assolia",
  prev5: "Conservée dans l'outil, non exportée vers le CSV Assolia",
  prev6: "Conservée dans l'outil, non exportée vers le CSV Assolia",
};

// ---------------------------------------------------------------------------
// Memoized table row — re-renders only when its own feature or typed values change
// ---------------------------------------------------------------------------
const TableRow = React.memo(function TableRow({
  feature,
  idKey,
  isSelected,
  rowParity,
  visibleColumns,
  typedNext1,
  typedCurrent,
  typedPrev1,
  typedPrev2,
  typedPrev3,
  typedPrev4,
  typedPrev5,
  typedPrev6,
  soilUpr,
  onOpenSoilDetail,
  onSelect,
  onUpdateField,
  onUpdateCulture,
  onRegisterRef,
}) {
  const ref = useCallback((el) => onRegisterRef(idKey, el), [onRegisterRef, idKey]);

  const props = feature.properties || {};
  const featureArea = featureAreaM2(feature);
  const surfaceHa = typeof featureArea === "number" ? featureArea / 10000 : null;
  const isBio = readBioFlag(props);
  const isIrrigable = readIrrigableFlag(props);
  const affiche = (id) => visibleColumns.has(id);

  const typedByColId = {
    next1: typedNext1,
    current: typedCurrent,
    prev1: typedPrev1,
    prev2: typedPrev2,
    prev3: typedPrev3,
    prev4: typedPrev4,
    prev5: typedPrev5,
    prev6: typedPrev6,
  };

  const rowStyle = {
    background: isSelected ? "#eef2ff" : rowParity === 0 ? "#fff" : "#f9fafb",
    cursor: "pointer",
  };

  const cellStyle = { padding: "6px", borderBottom: "1px solid #e5e7eb" };
  const inputStyle = { width: "100%", padding: "4px", border: "1px solid #d1d5db", borderRadius: 4 };

  return (
    <tr ref={ref} onClick={() => onSelect?.(feature.id ?? idKey)} style={rowStyle}>
      {affiche("ilot") && (
        <td style={cellStyle}>
          <input
            value={formatIlotParcelle(props)}
            onChange={(e) => {
              const next = splitIlotParcelle(e.target.value);
              onUpdateField(idKey, (p) => ({ ...p, ilot_numero: next.ilot, numero: next.numero }));
            }}
            onClick={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </td>
      )}
      {affiche("nom") && (
        <td style={cellStyle}>
          <input
            value={props.nom_parcelle ?? props.NOM_PARCEL ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              onUpdateField(idKey, (p) => ({
                ...p,
                nom_parcelle: val,
                NOM_PARCEL: val,
                nom_affiche: val || p.nom_affiche,
              }));
            }}
            onClick={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </td>
      )}
      {affiche("surface") && (
        <td style={{ ...cellStyle, fontSize: 13 }}>
          {surfaceHa != null && !Number.isNaN(surfaceHa) ? surfaceHa.toFixed(2) : "-"}
        </td>
      )}
      {affiche("bio") && (
        <FlagCell
          cellStyle={cellStyle}
          checked={isBio}
          label="AB"
          title="Parcelle conduite en agriculture biologique"
          onToggle={(next) => onUpdateField(idKey, (p) => setBioProps(p, next))}
        />
      )}
      {affiche("irrigable") && (
        <FlagCell
          cellStyle={cellStyle}
          checked={isIrrigable}
          label="Irr."
          title="Parcelle irrigable — colonne « Irrigabilité » du CSV Assolia"
          onToggle={(next) => onUpdateField(idKey, (p) => setIrrigableProps(p, next))}
        />
      )}
      {CULTURE_COLUMNS.filter((col) => affiche(col.id)).map((col) => (
        <td key={col.id} style={cellStyle}>
          <input
            list={`cultures-col-${col.id}`}
            value={typedByColId[col.id] ?? ""}
            onChange={(e) => onUpdateCulture(col.id, idKey, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={inputStyle}
          />
        </td>
      ))}
      {affiche("type_sol") && (
        <td style={cellStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              value={props.type_sol ?? props.TYPE_SOL ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                // Une saisie manuelle invalide l'indice de confiance SoilGrids.
                onUpdateField(idKey, (p) => {
                  const next = { ...p, type_sol: val, TYPE_SOL: val };
                  delete next.type_sol_confidence;
                  return next;
                });
              }}
              onClick={(e) => e.stopPropagation()}
              style={inputStyle}
            />
            {props.type_sol_confidence != null ? (
              <span
                title="Indice de confiance SoilGrids (probabilité de la classe WRB). Disparaît si le type de sol est modifié."
                style={confidenceBadgeStyle}
              >
                {props.type_sol_confidence}%
              </span>
            ) : null}
            {soilUpr ? (
              <button
                type="button"
                title="Voir les données SoilGrids ayant servi à déduire l'UPR"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSoilDetail?.(idKey);
                }}
                style={{
                  flex: "0 0 auto",
                  border: "1px solid #c7d2fe",
                  background: "#eef2ff",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  lineHeight: 1,
                  padding: "2px 5px",
                }}
              >
                ℹ️
              </button>
            ) : null}
          </div>
        </td>
      )}
      {ADVANCED_COLUMNS.filter((col) => affiche(col.id)).map((col) => (
        <td key={col.id} style={cellStyle}>
          {col.type === "bool" ? (
            <input
              type="checkbox"
              checked={parseBioFlag(props[col.id])}
              onChange={(e) => {
                onUpdateField(idKey, (p) => ({ ...p, [col.id]: e.target.checked }));
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <input
              value={props[col.id] ?? ""}
              onChange={(e) => {
                onUpdateField(idKey, (p) => ({ ...p, [col.id]: e.target.value }));
              }}
              onClick={(e) => e.stopPropagation()}
              style={inputStyle}
            />
          )}
        </td>
      ))}
    </tr>
  );
});



// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ParcelleEditor({
  features,
  visibleFeatures = null,
  setFeatures,
  selectedId,
  onSelect,
  mapRef,
  onFillNames,
  isFillingNames = false,
  millesimeAction = null,
}) {
  const options = useMemo(() => entriesCodebook(), []);
  const rowsRef = useRef(new Map());
  const [typed, setTyped] = useState(buildEmptyTypedState);
  const [isFillingRpg, setIsFillingRpg] = useState(false);
  // Remplissage UPR depuis SoilGrids
  const [isFillingSoil, setIsFillingSoil] = useState(false);
  const [soilFillProgress, setSoilFillProgress] = useState(null); // { done, total }
  // Remplissage WRB-seul (nom de classe par parcelle) — plus léger, pour la Roumanie
  const [isFillingWrb, setIsFillingWrb] = useState(false);
  const [wrbFillProgress, setWrbFillProgress] = useState(null); // { done, total }
  // Données SoilGrids/UPR conservées le temps de la session (idKey -> payload normalisé)
  const [soilUprByIdKey, setSoilUprByIdKey] = useState({});
  // Panneau latéral de consultation (idKey ouvert)
  const [soilDetailIdKey, setSoilDetailIdKey] = useState(null);
  // Colonnes masquées, mémorisées d'une session à l'autre : chacun règle une
  // fois l'affichage qui lui convient.
  const [hiddenColumns, setHiddenColumns] = useState(() => {
    try {
      const brut = window.localStorage.getItem(HIDDEN_COLUMNS_KEY);
      if (brut) return JSON.parse(brut);
    } catch {
      /* stockage indisponible : on repart des colonnes par défaut */
    }
    return DEFAULT_HIDDEN_COLUMNS;
  });
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(hiddenColumns));
    } catch {
      /* sans stockage, le réglage vaut pour la session */
    }
  }, [hiddenColumns]);

  const visibleColumns = useMemo(() => {
    const caches = new Set(hiddenColumns);
    return new Set(ALL_COLUMNS.map((col) => col.id).filter((id) => !caches.has(id)));
  }, [hiddenColumns]);

  const visibleColumnList = useMemo(
    () => ALL_COLUMNS.filter((col) => visibleColumns.has(col.id)),
    [visibleColumns]
  );

  const tableMinWidth = useMemo(
    () => visibleColumnList.reduce((total, col) => total + col.width, 0),
    [visibleColumnList]
  );

  const toggleColumn = useCallback((id) => {
    setHiddenColumns((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }, []);
  const [generalInfo, setGeneralInfo] = useState({ exploitation: "", pacage: "", siret: "" });
  const [showMoveCulturesDialog, setShowMoveCulturesDialog] = useState(false);
  const [moveSrcCol, setMoveSrcCol] = useState(CULTURE_COLUMNS[0].id);
  const [moveDestCol, setMoveDestCol] = useState("");
  const [moveKeepSource, setMoveKeepSource] = useState(false);
  const [moveOverwriteDest, setMoveOverwriteDest] = useState(true);

  /**
   * Lignes affichées, avec leur identifiant de ligne.
   *
   * L'identifiant reste calculé sur la liste complète : il sert de clé de cache
   * pour `typed` et de cible de sélection, il ne doit donc pas bouger quand un
   * filtre réduit l'affichage. Les filtres de la carte (millésime, groupe)
   * s'appliquent ici aussi — sans quoi le tableau montrait tous les millésimes
   * à la fois et les actions en série portaient sur des parcelles hors écran.
   */
  const rows = useMemo(() => {
    const all = (features || []).map((feature, index) => ({
      feature,
      idKey: String(feature?.id ?? index),
    }));
    if (!Array.isArray(visibleFeatures)) return all;
    const visibles = new Set(visibleFeatures);
    return all.filter((row) => visibles.has(row.feature));
  }, [features, visibleFeatures]);

  const visibleIdKeys = useMemo(() => new Set(rows.map((row) => row.idKey)), [rows]);

  const cultureOptions = useMemo(() => {
    const list = [];
    options.forEach(([key, label]) => {
      const split = splitCultureKey(key);
      if (!split.code) return;
      const display = label || split.code;
      list.push({ display, code: split.code, precision: split.precision });
    });
    return list;
  }, [options]);

  const displayLookup = useMemo(() => {
    const map = new Map();
    cultureOptions.forEach((entry) => {
      map.set(entry.display.toLowerCase(), entry);
    });
    return map;
  }, [cultureOptions]);

  const resolveCultureDisplay = useCallback((props, column) => {
    const textValue = readCultureValue(props, column);
    if (!textValue) return "";
    const lookup = displayLookup.get(textValue.toLowerCase());
    if (lookup) {
      return lookup.display;
    }
    const fromLabel = codeFromLabel(textValue);
    const splitFromLabel = splitCultureKey(fromLabel || "");
    const splitFromValue = splitCultureKey(textValue);
    const codeFromValue = /^[A-Z0-9]{2,10}$/.test(splitFromValue.code) ? splitFromValue.code : "";
    const code = codeFromValue || splitFromLabel.code;
    if (code) {
      const candidate =
        splitFromValue.precision || splitFromLabel.precision || readCulturePrecision(props, column);
      const precision = resolvePrecisionForCode(code, candidate);
      const label = labelFromCode(code, precision) || labelFromCode(code);
      return label || code;
    }
    return textValue;
  }, [displayLookup]);

  useEffect(() => {
    if (!features.length) return;
    const props = features[0]?.properties || {};
    setGeneralInfo((prev) => {
      const next = {
        exploitation: prev.exploitation || props.exploitation || props.nom_exploitation || "",
        pacage: prev.pacage || props.code_exploitation || props.pacage || props.numero_pacage || "",
        siret: prev.siret || props.siret || props.SIRET || "",
      };
      if (
        prev.exploitation === next.exploitation &&
        prev.pacage === next.pacage &&
        prev.siret === next.siret
      ) {
        return prev;
      }
      return next;
    });
  }, [features]);

  // Stable ref registration — never changes identity
  const onRegisterRef = useCallback((idKey, el) => {
    if (el) rowsRef.current.set(idKey, el);
    else rowsRef.current.delete(idKey);
  }, []);

  useEffect(() => {
    if (selectedId == null) return;
    const el = rowsRef.current.get(String(selectedId));
    if (el?.scrollIntoView) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("row-selected");
      setTimeout(() => el.classList.remove("row-selected"), 700);
    }
  }, [selectedId]);

  // Only rebuild typed when ids change or values are missing — not on every feature property edit
  useEffect(() => {
    setTyped((prev) => {
      const ids = features.map((f, idx) => String(f.id ?? idx));

      const firstColPrev = prev[CULTURE_COLUMNS[0].id] || {};
      const prevIds = Object.keys(firstColPrev);
      const idSet = new Set(ids);
      const prevIdSet = new Set(prevIds);

      const hasRemovedIds = prevIds.some((id) => !idSet.has(id));
      const hasNewIds = ids.some((id) => !prevIdSet.has(id));
      const hasMissingValues =
        hasNewIds ||
        CULTURE_COLUMNS.some((col) => ids.some((id) => prev[col.id]?.[id] == null));

      if (!hasMissingValues && !hasRemovedIds) return prev;

      const next = buildEmptyTypedState();
      features.forEach((f, idx) => {
        const idKey = ids[idx];
        const props = f.properties || {};
        CULTURE_COLUMNS.forEach((col) => {
          next[col.id][idKey] = resolveCultureDisplay(props, col);
        });
      });
      return next;
    });
  }, [features, resolveCultureDisplay]);

  const parseCultureInput = useCallback((rawValue) => {
    const value = rawValue ?? "";
    const trimmed = value.trim();
    if (!trimmed) return { display: "", code: "", precision: "" };
    const lookup = displayLookup.get(trimmed.toLowerCase());
    if (lookup) {
      const resolvedPrecision = resolvePrecisionForCode(lookup.code, lookup.precision);
      const display = labelFromCode(lookup.code, resolvedPrecision) || lookup.display;
      return { display, code: lookup.code, precision: resolvedPrecision };
    }
    const fromLabel = codeFromLabel(trimmed);
    if (fromLabel) {
      const split = splitCultureKey(fromLabel);
      const resolvedPrecision = resolvePrecisionForCode(split.code, split.precision);
      const display = labelFromCode(split.code, resolvedPrecision) || labelFromCode(split.code) || split.code;
      return { display, code: split.code, precision: resolvedPrecision };
    }
    if (/^[A-Za-z0-9]{2,10}(\|[0-9]{1,3})?$/.test(trimmed)) {
      const split = splitCultureKey(trimmed);
      const resolvedPrecision = resolvePrecisionForCode(split.code, split.precision);
      const display = labelFromCode(split.code, resolvedPrecision) || labelFromCode(split.code) || split.code;
      return { display, code: split.code, precision: resolvedPrecision };
    }
    return { display: trimmed, code: "", precision: "" };
  }, [displayLookup]);

  // Immutable feature update — finds feature by idKey and replaces only that entry
  const updateFeatureByIdKey = useCallback((idKey, propsUpdater) => {
    setFeatures((prev) => {
      const idx = prev.findIndex((f, i) => String(f.id ?? i) === idKey);
      if (idx === -1) return prev;
      const feature = prev[idx];
      const newProps = propsUpdater(feature.properties || {});
      if (newProps === feature.properties) return prev;
      const next = [...prev];
      next[idx] = { ...feature, properties: newProps };
      return next;
    });
  }, [setFeatures]);

  /**
   * Saisie d'une cellule de culture.
   *
   * Toute frappe est écrite dans la parcelle, y compris un libellé libre absent
   * du codebook. Auparavant seuls un code reconnu ou une suite de 2 à 10
   * caractères alphanumériques étaient enregistrés : la cellule affichait
   * « Luzerne porte-graine » alors que la parcelle restait vide, et la colonne
   * ressortait vide à l'export. Le pire cas venait des états intermédiaires —
   * taper « Blé » écrivait « BL » au deuxième caractère, puis plus rien, laissant
   * ce résidu dans la parcelle.
   */
  const updateCultureField = useCallback((colId, idKey, rawValue) => {
    const column = CULTURE_COLUMNS.find((col) => col.id === colId);
    if (!column) return;
    const trimmed = (rawValue ?? "").trim();
    let display = rawValue ?? "";

    if (trimmed === "") {
      updateFeatureByIdKey(idKey, (props) => clearCulture(props, column));
      display = "";
    } else {
      const parsed = parseCultureInput(trimmed);
      if (parsed.code) {
        const precision = parsed.precision || resolvePrecisionForCode(parsed.code, "");
        updateFeatureByIdKey(idKey, (props) => setCulture(props, column, parsed.code, precision));
        display = parsed.display;
      } else if (/^[A-Za-z0-9]{2,10}$/.test(trimmed)) {
        const upper = trimmed.toUpperCase();
        updateFeatureByIdKey(idKey, (props) => setCulture(props, column, upper));
        display = upper;
      } else {
        // Libellé libre : conservé tel quel plutôt que perdu.
        updateFeatureByIdKey(idKey, (props) => setCulture(props, column, trimmed));
        display = rawValue ?? "";
      }
    }

    setTyped((prev) => ({
      ...prev,
      [colId]: { ...(prev[colId] || {}), [idKey]: display },
    }));
  }, [updateFeatureByIdKey, parseCultureInput]);

  const fillCultureFromRpg = async (column) => {
    const targetYear = getRpgYearForColumn(column.id, resolveBaseYearForN(features));
    if (!targetYear) {
      alert("Annee RPG inconnue pour cette colonne.");
      return;
    }
    if (!RPG_AVAILABLE_YEARS.includes(targetYear)) {
      alert(
        `Aucune donnee RPG ${targetYear} n'est disponible. Annees disponibles : ${RPG_AVAILABLE_YEARS.join(", ")}.`
      );
      return;
    }

    const map = mapRef?.current;
    if (!map) {
      alert("Carte indisponible pour consulter le RPG.");
      return;
    }
    if (typeof map.getZoom === "function" && map.getZoom() < RPG_MIN_ZOOM) {
      alert(`Zoome jusqu'a ${RPG_MIN_ZOOM} pour interroger le RPG.`);
      return;
    }

    setIsFillingRpg(true);
    try {
      const bbox = getMapBoundsCRS84(map);
      const gj = await fetchRpgGeoJSON(targetYear, bbox, 5000);
      const rpgFeatures = Array.isArray(gj?.features) ? gj.features : [];
      if (!rpgFeatures.length) {
        alert(`Aucune parcelle RPG ${targetYear} n'a ete trouvee dans la zone affichee.`);
        return;
      }

      const rpgIndex = buildRpgIndex(rpgFeatures);
      const nextFeatures = features.map((feature, index) => {
        if (!feature?.geometry) return feature;
        // Le remplissage suit l'affichage : une parcelle masquée par un filtre
        // ne doit pas être modifiée à l'insu de l'utilisateur.
        if (!visibleIdKeys.has(String(feature.id ?? index))) return feature;
        const center = centroid(feature)?.geometry?.coordinates;
        if (!center || !Array.isArray(center)) return feature;

        const hitEntry = rpgIndex.find((entry) => {
          const bboxEntry = entry.bbox;
          if (!bboxEntry) return false;
          const [minX, minY, maxX, maxY] = bboxEntry;
          if (center[0] < minX || center[0] > maxX || center[1] < minY || center[1] > maxY) {
            return false;
          }
          return pointInGeometry(center, entry.feature?.geometry);
        });

        if (!hitEntry) return feature;
        const { label, code } = getCultureLabel(hitEntry.feature?.properties || {});
        const resolvedKey = code || codeFromLabel(label) || label;
        const split = splitCultureKey(resolvedKey);
        const resolvedCode = split.code || resolvedKey;
        if (!resolvedCode) return feature;

        const resolvedPrecision = resolvePrecisionForCode(resolvedCode, split.precision);
        return {
          ...feature,
          properties: setCulture(feature.properties, column, resolvedCode, resolvedPrecision),
        };
      });

      setFeatures(nextFeatures);

      setTyped((prev) => {
        const next = { ...prev, [column.id]: { ...(prev[column.id] || {}) } };
        nextFeatures.forEach((feature, idx) => {
          const idKey = String(feature.id ?? idx);
          const props = feature.properties || {};
          if (!hasCultureValue(props, column)) return;
          next[column.id][idKey] = resolveCultureDisplay(props, column);
        });
        return next;
      });
    } catch (error) {
      console.error("[RPG] Remplissage automatique echoue:", error);
      alert("Erreur lors du chargement RPG. Consulte la console pour le detail.");
    } finally {
      setIsFillingRpg(false);
    }
  };

  const updateGeneralInfo = useCallback((field, value) => {
    const next = { ...generalInfo, [field]: value };
    setGeneralInfo(next);
    setFeatures((prev) =>
      (prev || []).map((feature) => {
        const props = { ...(feature?.properties || {}) };
        if (field === "exploitation") {
          props.exploitation = value;
          props.nom_exploitation = value;
        }
        if (field === "pacage") {
          props.code_exploitation = value;
          props.pacage = value;
          props.numero_pacage = value;
        }
        if (field === "siret") {
          props.siret = value;
          props.SIRET = value;
        }
        return { ...feature, properties: props };
      })
    );
  }, [generalInfo, setFeatures]);

  /**
   * Applique le déplacement/la suppression d'une colonne de cultures à une
   * parcelle. Fonction pure, testable et partagée avec le compteur du dialogue.
   *
   * Deux règles pour ne jamais détruire une donnée qui n'était pas visée :
   *  - la source est lue sous tous ses alias, sinon une culture importée sous
   *    `cultureN1` ou `culture_prec` passait pour absente et la colonne
   *    destination était vidée « au nom » d'une source vide ;
   *  - une source vide laisse la destination intacte. Effacer reste possible,
   *    mais seulement en le demandant explicitement (destination « Aucune »).
   */
  const moveCulturesOnProps = useCallback((props, srcDef, destDef) => {
    const srcValue = readCultureValue(props, srcDef);
    let next = props;

    if (destDef && srcValue) {
      const destOccupied = hasCultureValue(next, destDef);
      if (moveOverwriteDest || !destOccupied) {
        next = setCulture(next, destDef, srcValue, readCulturePrecision(props, srcDef));
      }
    }

    if (!moveKeepSource) {
      next = clearCulture(next, srcDef);
    }

    return next;
  }, [moveKeepSource, moveOverwriteDest]);

  /** Nombre de parcelles affichées que l'opération modifierait réellement. */
  const moveCulturesImpact = useMemo(() => {
    const srcDef = CULTURE_COLUMNS.find((c) => c.id === moveSrcCol);
    if (!srcDef) return { total: rows.length, touched: 0 };
    const destDef = moveDestCol ? CULTURE_COLUMNS.find((c) => c.id === moveDestCol) : null;
    let touched = 0;
    rows.forEach(({ feature }) => {
      const props = feature?.properties || {};
      const next = moveCulturesOnProps(props, srcDef, destDef);
      const changed = CULTURE_COLUMNS.some(
        (col) => readCultureValue(props, col) !== readCultureValue(next, col)
      );
      if (changed) touched += 1;
    });
    return { total: rows.length, touched };
  }, [rows, moveSrcCol, moveDestCol, moveCulturesOnProps]);

  const applyMoveCultures = () => {
    const srcDef = CULTURE_COLUMNS.find((c) => c.id === moveSrcCol);
    const destDef = moveDestCol ? CULTURE_COLUMNS.find((c) => c.id === moveDestCol) : null;
    if (!srcDef) return;

    setFeatures((prev) =>
      prev.map((feature, index) => {
        // L'opération porte sur les lignes affichées : avec un filtre de
        // millésime actif, décaler 2025 ne doit pas décaler aussi 2024.
        if (!visibleIdKeys.has(String(feature?.id ?? index))) return feature;
        const props = feature?.properties || {};
        const nextProps = moveCulturesOnProps(props, srcDef, destDef);
        if (nextProps === props) return feature;
        return { ...feature, properties: nextProps };
      })
    );

    // Le cache d'affichage des colonnes touchées est invalidé, l'effet de
    // reconstruction le recalcule depuis les propriétés à jour.
    setTyped((prev) => {
      const next = { ...prev };
      if (!moveKeepSource) next[srcDef.id] = {};
      if (destDef) next[destDef.id] = {};
      return next;
    });

    setShowMoveCulturesDialog(false);
  };

  const renderMoveCulturesDialog = () => {
    if (!showMoveCulturesDialog) return null;
    const overlayStyle = {
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
      zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center",
    };
    const dialogStyle = {
      background: "#fff", borderRadius: 10, padding: 24, width: 400,
      boxShadow: "0 8px 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", gap: 14,
    };
    const labelStyle = { fontSize: 13, fontWeight: 500, display: "flex", flexDirection: "column", gap: 4 };
    const selectStyle = { padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 };
    const rowStyle = { display: "flex", alignItems: "center", gap: 8, fontSize: 13 };

    const srcIsValid = !!moveSrcCol;
    const destIsDifferent = !moveDestCol || moveDestCol !== moveSrcCol;
    const canApply = srcIsValid && destIsDifferent;

    return (
      <div style={overlayStyle} onClick={() => setShowMoveCulturesDialog(false)}>
        <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Déplacer / supprimer cultures</div>

          <label style={labelStyle}>
            Colonne source (données à déplacer)
            <select value={moveSrcCol} onChange={(e) => setMoveSrcCol(e.target.value)} style={selectStyle}>
              {CULTURE_COLUMNS.map((col) => (
                <option key={col.id} value={col.id}>{col.label}</option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Colonne destination <span style={{ fontWeight: 400, color: "#666" }}>(laisser vide pour supprimer sans déplacer)</span>
            <select value={moveDestCol} onChange={(e) => setMoveDestCol(e.target.value)} style={selectStyle}>
              <option value="">— Aucune destination (suppression) —</option>
              {CULTURE_COLUMNS.filter((c) => c.id !== moveSrcCol).map((col) => (
                <option key={col.id} value={col.id}>{col.label}</option>
              ))}
            </select>
          </label>

          <label style={rowStyle}>
            <input type="checkbox" checked={moveKeepSource} onChange={(e) => setMoveKeepSource(e.target.checked)} />
            Conserver les données dans la colonne source
          </label>

          {moveDestCol && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: "#374151" }}>Données destination :</div>
              <label style={rowStyle}>
                <input type="radio" name="overwrite" checked={moveOverwriteDest} onChange={() => setMoveOverwriteDest(true)} />
                Écraser les données existantes
              </label>
              <label style={{ ...rowStyle, marginTop: 4 }}>
                <input type="radio" name="overwrite" checked={!moveOverwriteDest} onChange={() => setMoveOverwriteDest(false)} />
                Compléter seulement les cellules vides
              </label>
            </div>
          )}

          {!destIsDifferent && (
            <div style={{ fontSize: 12, color: "#dc2626" }}>La colonne source et destination doivent être différentes.</div>
          )}

          {/* Portée annoncée avant d'agir : l'opération est en série et sans
              retour arrière, l'utilisateur doit voir ce qu'elle touche. */}
          <div style={{ fontSize: 12, color: "#374151", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "8px 10px" }}>
            {moveCulturesImpact.touched} parcelle{moveCulturesImpact.touched > 1 ? "s" : ""} modifiée
            {moveCulturesImpact.touched > 1 ? "s" : ""} sur les {moveCulturesImpact.total} affichée
            {moveCulturesImpact.total > 1 ? "s" : ""}.
            {moveDestCol ? (
              <div style={{ marginTop: 4, color: "#6b7280" }}>
                Les parcelles sans valeur en « {CULTURE_COLUMNS.find((c) => c.id === moveSrcCol)?.label} »
                gardent leur colonne destination inchangée.
              </div>
            ) : null}
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setShowMoveCulturesDialog(false)}
              style={{ padding: "7px 16px", borderRadius: 6, border: "1px solid #d1d5db", background: "#f9fafb", cursor: "pointer", fontSize: 13 }}
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={applyMoveCultures}
              disabled={!canApply}
              style={{
                padding: "7px 16px", borderRadius: 6, border: "none",
                background: canApply ? "#2563eb" : "#93c5fd", color: "#fff",
                cursor: canApply ? "pointer" : "not-allowed", fontSize: 13, fontWeight: 600,
              }}
            >
              {moveDestCol ? "Déplacer" : "Supprimer"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderTableView = () => {
    const headerStyle = {
      padding: "8px 6px",
      borderBottom: "1px solid #e5e7eb",
      background: "#f3f4f6",
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: "0.02em",
      textAlign: "left",
      color: "#374151",
    };

    const headerButtonStyle = {
      marginTop: 4,
      padding: "2px 6px",
      borderRadius: 4,
      border: "1px solid #d1d5db",
      background: "#fff",
      fontSize: 11,
      cursor: "pointer",
    };

    return (
      <div style={{ marginTop: 8, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => {
              setMoveSrcCol(CULTURE_COLUMNS[0].id);
              setMoveDestCol("");
              setMoveKeepSource(false);
              setMoveOverwriteDest(true);
              setShowMoveCulturesDialog(true);
            }}
            style={{
              padding: "7px 14px", borderRadius: 6, border: "1px solid #6366f1",
              background: "#eef2ff", color: "#4338ca", cursor: "pointer", fontSize: 13, fontWeight: 600,
            }}
          >
            Déplacer cultures
          </button>

          {/* Comparaison inter-millésimes : même famille d'actions que le
              déplacement de cultures, donc au même endroit. */}
          {millesimeAction}

          <div style={{ position: "relative", marginLeft: "auto" }}>
            <button
              type="button"
              className="fp-btn fp-btn--sm"
              onClick={() => setShowColumnPicker((prev) => !prev)}
              aria-expanded={showColumnPicker}
              title="Choisir les colonnes affichées"
            >
              Colonnes ({visibleColumnList.length}/{ALL_COLUMNS.length})
            </button>

            {showColumnPicker && (
              <>
                {/* Voile transparent : un clic à côté referme le menu. */}
                <div
                  onClick={() => setShowColumnPicker(false)}
                  style={{ position: "fixed", inset: 0, zIndex: 40 }}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 4px)",
                    zIndex: 41,
                    width: 250,
                    maxHeight: 320,
                    overflowY: "auto",
                    background: "var(--c-surface)",
                    border: "1px solid var(--c-border)",
                    borderRadius: "var(--r-md)",
                    boxShadow: "var(--shadow-md)",
                    padding: 10,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <button
                      type="button"
                      className="fp-btn fp-btn--sm"
                      onClick={() => setHiddenColumns([])}
                    >
                      Tout afficher
                    </button>
                    <button
                      type="button"
                      className="fp-btn fp-btn--sm"
                      onClick={() => setHiddenColumns(DEFAULT_HIDDEN_COLUMNS)}
                    >
                      Par défaut
                    </button>
                  </div>
                  {ALL_COLUMNS.map((col) => (
                    <label
                      key={col.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "3px 0",
                        fontSize: "var(--fs-md)",
                        cursor: "pointer",
                      }}
                      title={COLUMN_HINTS[col.id]}
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.has(col.id)}
                        onChange={() => toggleColumn(col.id)}
                      />
                      <span>{col.label}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Informations exploitation</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
            <label style={{ fontSize: 12 }}>
              Exploitation
              <input
                value={generalInfo.exploitation}
                onChange={(e) => updateGeneralInfo("exploitation", e.target.value)}
                style={{ width: "100%", padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 4, marginTop: 2 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              Numero pacage
              <input
                value={generalInfo.pacage}
                onChange={(e) => updateGeneralInfo("pacage", e.target.value)}
                style={{ width: "100%", padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 4, marginTop: 2 }}
              />
            </label>
            <label style={{ fontSize: 12 }}>
              SIRET
              <input
                value={generalInfo.siret}
                onChange={(e) => updateGeneralInfo("siret", e.target.value)}
                style={{ width: "100%", padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 4, marginTop: 2 }}
              />
            </label>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          {/* Shared datalists — one per culture column, not one per row */}
          {CULTURE_COLUMNS.map((col) => (
            <datalist key={col.id} id={`cultures-col-${col.id}`}>
              {cultureOptions.map((opt) => (
                <option key={`${opt.code}-${opt.precision || ""}-${opt.display}`} value={opt.display}>
                  {opt.code}
                </option>
              ))}
            </datalist>
          ))}
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: tableMinWidth }}>
            <colgroup>
              {visibleColumnList.map((col) => (
                <col key={col.id} style={{ minWidth: col.width, width: col.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {visibleColumnList.map((col) => {
                  const cultureCol = CULTURE_COLUMNS.find((item) => item.id === col.id);
                  return (
                    <th key={col.id} style={headerStyle} title={COLUMN_HINTS[col.id]}>
                      <div style={{ fontWeight: 600 }}>{col.label}</div>

                      {col.id === "nom" && onFillNames ? (
                        <button
                          type="button"
                          onClick={() => onFillNames()}
                          disabled={isFillingNames}
                          style={{
                            ...headerButtonStyle,
                            opacity: isFillingNames ? 0.6 : 1,
                            cursor: isFillingNames ? "not-allowed" : "pointer",
                          }}
                        >
                          {isFillingNames ? "Remplissage..." : "Remplir"}
                        </button>
                      ) : null}

                      {cultureCol ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            fillCultureFromRpg(cultureCol);
                          }}
                          disabled={isFillingRpg}
                          style={{
                            ...headerButtonStyle,
                            opacity: isFillingRpg ? 0.6 : 1,
                            cursor: isFillingRpg ? "not-allowed" : "pointer",
                          }}
                        >
                          {isFillingRpg ? "Remplissage..." : "Remplir"}
                        </button>
                      ) : null}

                      {col.id === "type_sol" ? (
                        <>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          fillSoilTypeColumn();
                        }}
                        disabled={isFillingSoil}
                        title="Déduire l'UPR de chaque parcelle depuis SoilGrids (texture, RU, WRB)"
                        style={{
                          ...headerButtonStyle,
                          opacity: isFillingSoil ? 0.6 : 1,
                          cursor: isFillingSoil ? "not-allowed" : "pointer",
                        }}
                      >
                        {isFillingSoil
                          ? soilFillProgress
                            ? `Remplissage ${soilFillProgress.done}/${soilFillProgress.total}`
                            : "Remplissage..."
                          : "Remplir la colonne"}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          fillWrbClassColumn();
                        }}
                        disabled={isFillingWrb || isFillingSoil}
                        title="Remonter uniquement le nom de classe WRB par parcelle (plus léger, dédup par pixel)"
                        style={{
                          ...headerButtonStyle,
                          marginTop: 4,
                          opacity: isFillingWrb || isFillingSoil ? 0.6 : 1,
                          cursor: isFillingWrb || isFillingSoil ? "not-allowed" : "pointer",
                        }}
                      >
                        {isFillingWrb
                          ? wrbFillProgress
                            ? `WRB ${wrbFillProgress.done}/${wrbFillProgress.total}`
                            : "Remplissage..."
                          : "Remplir WRB"}
                      </button>
                        </>
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {rows.map(({ feature: f, idKey }, idx) => {
                return (
                  <TableRow
                    key={idKey}
                    feature={f}
                    idKey={idKey}
                    isSelected={String(selectedId) === idKey}
                    rowParity={idx % 2}
                    visibleColumns={visibleColumns}
                    typedNext1={typed.next1?.[idKey] ?? ""}
                    typedCurrent={typed.current?.[idKey] ?? ""}
                    typedPrev1={typed.prev1?.[idKey] ?? ""}
                    typedPrev2={typed.prev2?.[idKey] ?? ""}
                    typedPrev3={typed.prev3?.[idKey] ?? ""}
                    typedPrev4={typed.prev4?.[idKey] ?? ""}
                    typedPrev5={typed.prev5?.[idKey] ?? ""}
                    typedPrev6={typed.prev6?.[idKey] ?? ""}
                    soilUpr={soilUprByIdKey[idKey]}
                    onOpenSoilDetail={setSoilDetailIdKey}
                    onSelect={onSelect}
                    onUpdateField={updateFeatureByIdKey}
                    onUpdateCulture={updateCultureField}
                    onRegisterRef={onRegisterRef}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const resolveParcelId = (feature) =>
    String(feature?.id ?? feature?.properties?.id ?? feature?.properties?.parcelleNo ?? "");

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Récupère l'UPR d'une parcelle avec relance sur rate-limit serveur. Le 429 est désormais
  // attendu (requêtes parallèles) : on relance avec un backoff court et jitté pour étaler les
  // reprises plutôt que de les faire converger en troupeau.
  const fetchUprWithRetry = async (parcelId, attempt = 0) => {
    try {
      return await fetchParcelSoilGrids(parcelId);
    } catch (error) {
      if (attempt < 8 && /rate limit/i.test(error?.message || "")) {
        await delay(1500 + Math.random() * 1500);
        return fetchUprWithRetry(parcelId, attempt + 1);
      }
      throw error;
    }
  };

  // Nombre de remontées SoilGrids menées en parallèle. Le serveur mutualise les requêtes d'un
  // même pixel 250 m et ne compte que les vrais appels ISRIC dans son rate-limit (60/min), donc
  // une concurrence modérée sature le débit utile sans déclencher de 429 sur les exploitations
  // groupées (cas courant), tout en restant correcte pour les parcelles dispersées.
  const SOIL_FILL_CONCURRENCY = 6;

  const fillSoilTypeColumn = async () => {
    if (!Array.isArray(features) || features.length === 0) {
      alert("Aucune parcelle à analyser.");
      return;
    }
    setIsFillingSoil(true);
    setSoilFillProgress({ done: 0, total: features.length });
    try {
      // 1) Persister les parcelles côté serveur : l'endpoint SoilGrids les retrouve par id.
      await saveParcellesGeojson(features);

      let filled = 0;
      let done = 0;
      const errors = [];

      // Traitement par un pool de workers concurrents : chacun pioche la parcelle suivante dans
      // la file tant qu'il en reste. La déduplication par pixel est gérée côté serveur.
      let nextIndex = 0;
      const processOne = async (i) => {
        const feature = features[i];
        const idKey = String(feature.id ?? i);
        const parcelId = resolveParcelId(feature);
        if (parcelId) {
          try {
            const payload = await fetchUprWithRetry(parcelId);
            const code = payload?.upr?.code;
            const label = payload?.upr?.label;
            if (code) {
              const display = label ? `${code} — ${label}` : code;
              const confidence = extractSoilConfidence(payload?.wrb?.probability);
              // Remplissage progressif : la cellule et son ℹ️ apparaissent dès le calcul.
              setSoilUprByIdKey((prev) => ({ ...prev, [idKey]: payload }));
              setFeatures((prev) =>
                (prev || []).map((feat, fi) => {
                  if (String(feat.id ?? fi) !== idKey) return feat;
                  const nextProps = { ...(feat.properties || {}), type_sol: display, TYPE_SOL: display };
                  if (confidence != null) nextProps.type_sol_confidence = confidence;
                  else delete nextProps.type_sol_confidence;
                  return { ...feat, properties: nextProps };
                })
              );
              filled += 1;
            } else {
              errors.push(parcelId);
            }
          } catch (error) {
            console.warn(`[SOIL_FILL] Parcelle ${parcelId} échouée:`, error?.message || error);
            errors.push(parcelId);
          }
        }
        done += 1;
        setSoilFillProgress({ done, total: features.length });
      };

      const worker = async () => {
        while (nextIndex < features.length) {
          const i = nextIndex;
          nextIndex += 1;
          await processOne(i);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SOIL_FILL_CONCURRENCY, features.length) }, () => worker())
      );

      if (errors.length) {
        alert(`${filled} parcelle(s) remplie(s). ${errors.length} sans donnée SoilGrids exploitable (point hors couverture ou identifiant manquant).`);
      }
    } catch (error) {
      console.error("[SOIL_FILL] Échec global:", error);
      alert("Erreur lors du remplissage des types de sol. Voir la console pour le détail.");
    } finally {
      setIsFillingSoil(false);
      setSoilFillProgress(null);
    }
  };

  const fetchWrbWithRetry = async (parcelId, attempt = 0) => {
    try {
      return await fetchParcelWrb(parcelId);
    } catch (error) {
      if (attempt < 8 && /rate limit/i.test(error?.message || "")) {
        await delay(1500 + Math.random() * 1500);
        return fetchWrbWithRetry(parcelId, attempt + 1);
      }
      throw error;
    }
  };

  // Remontée WRB-seule : remplit la colonne « Type de sol » avec le nom de classe WRB de chaque
  // parcelle. Beaucoup plus léger que l'UPR (un seul appel ISRIC par pixel, pas de profil ni de
  // calcul) ; suffisant pour les rendez-vous en Roumanie. La classification est best-effort côté
  // serveur (ne renvoie jamais d'erreur d'indisponibilité), donc pas de 504/500 en rafale ici.
  const fillWrbClassColumn = async () => {
    if (!Array.isArray(features) || features.length === 0) {
      alert("Aucune parcelle à analyser.");
      return;
    }
    setIsFillingWrb(true);
    setWrbFillProgress({ done: 0, total: features.length });
    try {
      await saveParcellesGeojson(features);

      let filled = 0;
      let done = 0;
      const noData = []; // réponse OK mais aucune classe WRB (hors couverture / domaine)
      const failed = []; // échec réseau réel
      let consecutiveFailures = 0;
      let aborted = false;
      const FAILURE_ABORT_THRESHOLD = 10;

      let nextIndex = 0;
      const processOne = async (i) => {
        const feature = features[i];
        const idKey = String(feature.id ?? i);
        const parcelId = resolveParcelId(feature);
        if (parcelId) {
          try {
            const payload = await fetchWrbWithRetry(parcelId);
            consecutiveFailures = 0;
            const wrb = payload?.wrbClassName;
            if (wrb) {
              const confidence = extractSoilConfidence(payload?.probability);
              setFeatures((prev) =>
                (prev || []).map((feat, fi) => {
                  if (String(feat.id ?? fi) !== idKey) return feat;
                  const nextProps = {
                    ...(feat.properties || {}),
                    type_sol: wrb,
                    TYPE_SOL: wrb,
                    wrb_class: wrb,
                    WRB_CLASS: wrb,
                  };
                  if (confidence != null) nextProps.type_sol_confidence = confidence;
                  else delete nextProps.type_sol_confidence;
                  return { ...feat, properties: nextProps };
                })
              );
              filled += 1;
            } else {
              noData.push(parcelId);
            }
          } catch (error) {
            console.warn(`[WRB_FILL] Parcelle ${parcelId} échouée:`, error?.message || error);
            failed.push(parcelId);
            consecutiveFailures += 1;
            if (consecutiveFailures >= FAILURE_ABORT_THRESHOLD) aborted = true;
          }
        }
        done += 1;
        setWrbFillProgress({ done, total: features.length });
      };

      const worker = async () => {
        while (nextIndex < features.length && !aborted) {
          const i = nextIndex;
          nextIndex += 1;
          await processOne(i);
        }
      };
      // Concurrence modérée : la classification ISRIC est lente (~8 s) ; on évite de la saturer.
      const WRB_FILL_CONCURRENCY = 4;
      await Promise.all(
        Array.from({ length: Math.min(WRB_FILL_CONCURRENCY, features.length) }, () => worker())
      );

      if (aborted) {
        const remaining = features.length - done;
        alert(
          `Remontée WRB interrompue : SoilGrids ne répond pas (${failed.length} échecs consécutifs). ` +
            `${filled} parcelle(s) remplie(s), ${remaining} non traitée(s). Réessaie plus tard.`
        );
      } else if (noData.length || failed.length) {
        const parts = [];
        if (noData.length) parts.push(`${noData.length} sans classe WRB (hors couverture)`);
        if (failed.length) parts.push(`${failed.length} en échec`);
        alert(`${filled} parcelle(s) remplie(s). ${parts.join(", ")}.`);
      }
    } catch (error) {
      console.error("[WRB_FILL] Échec global:", error);
      alert("Erreur lors de la remontée WRB. Voir la console pour le détail.");
    } finally {
      setIsFillingWrb(false);
      setWrbFillProgress(null);
    }
  };

  const soilDetailFeature = useMemo(() => {
    if (soilDetailIdKey == null) return null;
    const list = features || [];
    for (let i = 0; i < list.length; i += 1) {
      if (String(list[i].id ?? i) === String(soilDetailIdKey)) return list[i];
    }
    return null;
  }, [soilDetailIdKey, features]);
  const soilDetailPayload = soilDetailIdKey != null ? soilUprByIdKey[soilDetailIdKey] : null;

  return (
    <div style={{ marginTop: 12 }}>
      {renderTableView()}
      {renderMoveCulturesDialog()}
      {soilDetailFeature && soilDetailPayload ? (
        <ParcelSoilPanel
          parcel={soilDetailFeature}
          soilState={{ data: soilDetailPayload, loading: false, error: null, cacheHit: false }}
          onClose={() => setSoilDetailIdKey(null)}
          onRefresh={async () => {
            const parcelId = resolveParcelId(soilDetailFeature);
            if (!parcelId) return;
            try {
              const payload = await fetchParcelSoilGrids(parcelId, { refresh: true });
              setSoilUprByIdKey((prev) => ({ ...prev, [soilDetailIdKey]: payload }));
            } catch (error) {
              console.warn("[SOIL_DETAIL] Rafraîchissement échoué:", error?.message || error);
            }
          }}
        />
      ) : null}
    </div>
  );
}
