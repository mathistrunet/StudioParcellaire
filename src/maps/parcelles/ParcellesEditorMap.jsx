// src/maps/parcelles/ParcellesEditorMap.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import centroid from "@turf/centroid";

import AppTopBar from "../../components/AppTopBar";
import RasterToggles from "../../components/RasterToggles";
import ParcelleEditor from "../../components/ParcelleEditor";
import { useMapInitialization } from "../../features/map/useMapInitialization";
import { DEFAULT_FILL_OPACITY } from "../../config/soilsLocalConfig";
import { GEO_PORTAIL_SOIL_DEFAULT_OPACITY } from "../../config/soilGeoportal";
import { RASTER_LAYERS, DEFAULT_FEATURE_INFO_PARSER } from "../../config/rasterLayers";

import MapInfoPanel from "../../components/MapInfoPanel";

// ✅ composant RPG autonome (chemin conservé)
import RpgFeature from "../../Front/useRpgLayer";
// ✅ composant RPG Roumanie (GeoPackage local)
import RpgRomaniaFeature from "../../Front/useRpgRomaniaLayer";
// ✅ composant Dessin autonome (chemin conservé)
import DrawToolbar from "../../Front/DrawToolbar";
// Import multi-format / export multi-format
import ImportParcellaireButton from "../../Front/ImportParcellaireButton";
import ExportMenuButton from "../../Front/ExportMenuButton";
import ParcelleMatchView from "../../components/ParcelleMatchView";
import LayerUpdateNotice from "../../components/LayerUpdateNotice";
import SoilTypeMappingPanel from "../../components/SoilTypeMappingPanel";
import { IMPORT_FORMATS } from "../../services/parcellaireImport";

// ✅ NOUVEAU : hook d’affichage RRP local (depuis un fichier MBTiles placé dans /public/data)
import { useSoilLayerLocal } from "../../features/useSoilLayerLocal";
import { useToponymieAutoNaming } from "../../features/useToponymieAutoNaming";
import { useLayerUpdates } from "../../features/useLayerUpdates";
import { withBasePath } from "../../utils/publicBase";
import { ERROR_CODES } from "../../utils/errors";
import {
  applyCorrespondencesAndMerge,
  buildParcellesByYearFromFeatures,
  getFeatureId,
} from "../../domain/parcelles/fusion";
import { getFeatureKey } from "../../utils/parcelleMatching";
import { featureAreaM2 } from "../../utils/geometry";
import {
  loadSoilTypeLookupBySourceFile,
  loadSoilTypeLookupByUcsId,
  resolveFileUcs,
  resolveUcsId,
  buildSoilCombinationKey,
} from "../../services/soilTypeMapping";
import { fetchSoilGridsVisibleGrid } from "../../services/soilgridsGridBackend";
import { featureCollectionsEqual } from "../../utils/featureCollectionEquality";
import {
  clearParcellesGeojson,
  saveParcellesGeojson,
  validateParcellesMatching,
} from "../../services/parcellesBackend";
import { useParcelles } from "./useParcelles";

const EARTH_RADIUS = 6378137;
const DRAW_LAYER_IDS = [
  "draw-polygon-fill-overlap-warning",
  "draw-polygon-stroke-overlap-warning",
  "draw-polygon-fill-inactive",
  "draw-polygon-fill-import-mismatch",
  "draw-polygon-fill-active",
  "draw-polygon-stroke-inactive",
  "draw-polygon-stroke-import-mismatch",
  "draw-polygon-stroke-active",
  "draw-vertex-halo-active",
  "draw-vertex-active",
  "draw-vertex-midpoint",
  "draw-vertex-inactive",
  "draw-polygon-fill-static",
  "draw-polygon-stroke-static",
  "draw-line-static",
  "draw-line-inactive",
  "draw-line-active",
];
const INVALID_YEAR = -9999;
const DEFAULT_PARCELLE_YEAR = new Date().getFullYear();

const normalizeYearValue = (value) => {
  if (value == null) return null;
  const trimmed = typeof value === "string" ? value.trim() : value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const ensureFeaturesHaveYear = (inputFeatures) => {
  const featuresList = Array.isArray(inputFeatures) ? inputFeatures : [];
  const knownYears = featuresList
    .map((feature) => normalizeYearValue(feature?.properties?.annee))
    .filter((value) => value != null);

  const fallbackYear = knownYears.length > 0 ? Math.max(...knownYears) : DEFAULT_PARCELLE_YEAR;

  let changed = false;
  const nextFeatures = featuresList.map((feature) => {
    if (!feature || feature.type !== "Feature") return feature;
    const currentYear = normalizeYearValue(feature?.properties?.annee);
    if (currentYear != null) return feature;

    changed = true;
    return {
      ...feature,
      properties: {
        ...(feature.properties || {}),
        annee: fallbackYear,
      },
    };
  });

  return { changed, nextFeatures };
};
const DRAW_LAYER_VARIANTS = ["", ".cold", ".hot"];
const SOILGRIDS_GRID_SOURCE_ID = "soilgrids-grid-source";
const SOILGRIDS_GRID_LAYER_ID = "soilgrids-grid-layer";
const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };

// Panneau latéral redimensionnable : bornes et mémorisation de la largeur.
const SIDE_WIDTH_KEY = "studioparcellaire.largeur-panneau";
const SIDE_MIN = 360;
const SIDE_MAX_RATIO = 0.8;

function buildSoilProbePoints(feature) {
  const probes = [];
  const register = (coordinates) => {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return;
    const [lng, lat] = coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const key = `${lng.toFixed(7)}:${lat.toFixed(7)}`;
    if (!probes.some((probe) => probe.key === key)) {
      probes.push({ key, coordinates: [lng, lat] });
    }
  };

  register(centroid(feature).geometry?.coordinates);
  const polygonCoordinates =
    feature?.geometry?.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature?.geometry?.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [];

  polygonCoordinates.forEach((polygon) => {
    const firstRing = polygon?.[0] || [];
    if (!firstRing.length) return;
    const sampleIndexes = [0, Math.floor(firstRing.length / 3), Math.floor((firstRing.length * 2) / 3)];
    sampleIndexes.forEach((index) => {
      register(firstRing[index]);
    });
  });

  return probes;
}

function projectLngLatTo3857(lng, lat) {
  const rad = Math.PI / 180;
  const clampedLat = Math.max(Math.min(lat, 89.999999), -89.999999);
  const x = EARTH_RADIUS * lng * rad;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampedLat * rad) / 2));
  return [x, y];
}

function buildFeatureInfoUrl(def, map, point) {
  const info = def?.featureInfo;
  if (!info || !info.url || !info.layerName || !map || !point) {
    return null;
  }

  const version = info.version || "1.3.0";
  const isVersion130 = version === "1.3.0";

  const canvas = typeof map.getCanvas === "function" ? map.getCanvas() : null;
  const bounds = typeof map.getBounds === "function" ? map.getBounds() : null;
  if (!canvas || !bounds) {
    return null;
  }

  const sw = typeof bounds.getSouthWest === "function" ? bounds.getSouthWest() : bounds._sw;
  const ne = typeof bounds.getNorthEast === "function" ? bounds.getNorthEast() : bounds._ne;
  if (!sw || !ne) {
    return null;
  }

  const [minX, minY] = projectLngLatTo3857(sw.lng, sw.lat);
  const [maxX, maxY] = projectLngLatTo3857(ne.lng, ne.lat);
  const bbox = `${minX},${minY},${maxX},${maxY}`;

  const width = Math.round(canvas.width || canvas.clientWidth || 256);
  const height = Math.round(canvas.height || canvas.clientHeight || 256);
  const i = Math.round(point.x);
  const j = Math.round(point.y);

  let url;
  try {
    url = new URL(info.url);
  } catch {
    return null;
  }

  const params = url.searchParams;
  params.set("SERVICE", "WMS");
  params.set("REQUEST", "GetFeatureInfo");
  params.set("VERSION", version);
  params.set("LAYERS", info.layerName);
  params.set(
    "QUERY_LAYERS",
    Array.isArray(info.queryLayers) && info.queryLayers.length > 0
      ? info.queryLayers.join(",")
      : info.layerName,
  );
  params.set("STYLES", info.styles || "");
  params.set(isVersion130 ? "CRS" : "SRS", info.crs || "EPSG:3857");
  params.set("INFO_FORMAT", info.infoFormat || "application/json");
  params.set("I", String(i));
  params.set("J", String(j));
  params.set("WIDTH", String(width));
  params.set("HEIGHT", String(height));
  params.set("BBOX", bbox);

  if (info.extraParams && typeof info.extraParams === "object") {
    Object.entries(info.extraParams).forEach(([key, value]) => {
      if (value != null) {
        params.set(key, String(value));
      }
    });
  }

  return url.toString();
}

export default function ParcellesEditorMap({ mapMode, onMapModeChange, onOpenGuide }) {
  const {
    mapRef,
    drawRef,
    features,
    setFeatures,
    selectedId,
    selectFeatureOnMap,
    selectFeaturesOnMap,
    setDrawFeatures,
    mapInitError,
  } = useMapInitialization();
  const {
    parcellesCollection,
    setFeatureCollection,
    reset: resetParcellesStore,
    loading: parcellesLoading,
  } = useParcelles();

  const { fillToponymieNames, isNaming: isToponymieNaming } = useToponymieAutoNaming(setFeatures);
  // Vérifie au démarrage si les cartes hébergées ont été republiées depuis leur
  // téléchargement sur ce poste.
  const layerUpdates = useLayerUpdates();

  // Onglets + panneau latéral repliable
  const [sideOpen, setSideOpen] = useState(true);          // panneau latéral ouvert/fermé
  // Largeur du panneau, ajustable à la souris et mémorisée d'une session à
  // l'autre : le tableau des parcelles compte beaucoup de colonnes.
  const [sideWidth, setSideWidth] = useState(() => {
    const enregistre = Number(window.localStorage.getItem(SIDE_WIDTH_KEY));
    return Number.isFinite(enregistre) && enregistre >= SIDE_MIN ? enregistre : 460;
  });
  const resizingRef = useRef(false);
  const [activeTab, setActiveTab] = useState("parcelles"); // "parcelles" | "calques" | "mapping-sols"
  const [soilMappingParcelCandidates, setSoilMappingParcelCandidates] = useState([]);
  const [soilMappingRefreshTick, setSoilMappingRefreshTick] = useState(0);
  const [soilMappingLoading, setSoilMappingLoading] = useState(false);
  const soilMappingDebugLoggedRef = useRef(false);
  const [soilGridsGridVisible, setSoilGridsGridVisible] = useState(false);
  const [soilGridsGridMeta, setSoilGridsGridMeta] = useState(null);
  const [soilGridsGridError, setSoilGridsGridError] = useState(null);
  const soilGridsGridAbortRef = useRef(null);
  const soilGridsGridRequestRef = useRef(0);
  const soilGridsGridPopupRef = useRef(null);
  // Le message d'accueil n'est qu'une aide au démarrage : on peut le fermer et
  // travailler sur la carte sans avoir chargé de parcellaire.
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [compact, setCompact] = useState(false);
  const [rrpVisible, setRrpVisible] = useState(false);
  const [rrpOpacity, setRrpOpacity] = useState(DEFAULT_FILL_OPACITY);
  const [geoportalOpacity, setGeoportalOpacity] = useState(
    GEO_PORTAIL_SOIL_DEFAULT_OPACITY
  );
  const [freezeTiles, setFreezeTiles] = useState(false);
  const [layerState, setLayerState] = useState(() => {
    const initial = {};
    RASTER_LAYERS.forEach((def) => {
      initial[def.id] = {
        visible: def.defaultVisible ?? false,
        opacity: def.defaultOpacity ?? 1,
      };
    });
    return initial;
  });
  const [mapClickInfo, setMapClickInfo] = useState(null);
  const [appWarnings, setAppWarnings] = useState([]);
  const defaultCsvCode = useMemo(
    () => String(Math.floor(Math.random() * 99999) + 1).padStart(5, "0"),
    []
  );
  const [csvValues, setCsvValues] = useState({
    secteur: "TEST",
    exploitation: "Exploitation 1",
    codeExploitation: defaultCsvCode,
  });
  const [parcelleYearFilter, setParcelleYearFilter] = useState("all");
  const [parcelleGroupFilter, setParcelleGroupFilter] = useState("all");
  const [matchViewOpen, setMatchViewOpen] = useState(false);
  const [matchYears, setMatchYears] = useState({ left: null, right: null });
  const [validatedMatches, setValidatedMatches] = useState([]);
  const [validatedMatchesAt, setValidatedMatchesAt] = useState(null);
  const drawLayerFiltersRef = useRef(new Map());
  const drawLayerAppliedFiltersRef = useRef(new Map());
  const toolbarScrollRef = useRef(null);
  const [backendReady, setBackendReady] = useState(false);
  // Dernières collections poussées vers le backend et vers le store. Comparées
  // structurellement (`featureCollectionsEqual`) et non par sérialisation : deux
  // collections identiques produites par des codes différents ne donnent pas la
  // même chaîne JSON, et la garde ne retenait alors jamais rien.
  const lastSavedPayloadRef = useRef(null);
  const lastSyncedPayloadRef = useRef(null);
  const hasHydratedRef = useRef(false);
  const isUnmountingRef = useRef(false);
  const drawSyncRef = useRef(false);
  const drawSyncEventRef = useRef(null);
  const emptyParcellesCollection = useMemo(
    () => ({ type: "FeatureCollection", features: [] }),
    []
  );
  const buildCollectionFromFeatures = useCallback((inputFeatures) => ({
    type: "FeatureCollection",
    features: (inputFeatures || []).map((feature) => ({
      type: "Feature",
      id: feature.id,
      geometry: feature.geometry,
      properties: feature.properties || {},
    })),
  }), []);
  const yearOptions = useMemo(() => {
    const years = new Set();
    let hasUnknown = false;
    features.forEach((feature) => {
      const parsedYear = normalizeYearValue(feature?.properties?.annee);
      if (parsedYear != null) {
        years.add(parsedYear);
      } else {
        hasUnknown = true;
      }
    });
    return {
      years: Array.from(years).sort((a, b) => b - a),
      hasUnknown,
    };
  }, [features]);

  const groupOptions = useMemo(() => {
    const groups = new Set();
    let hasUngrouped = false;
    features.forEach((feature) => {
      const value = feature?.properties?.layerType;
      if (value == null || String(value).trim() === "") {
        hasUngrouped = true;
        return;
      }
      groups.add(String(value).trim());
    });
    return {
      groups: Array.from(groups).sort((a, b) => a.localeCompare(b)),
      hasUngrouped,
    };
  }, [features]);

  useEffect(() => {
    const { changed, nextFeatures } = ensureFeaturesHaveYear(features);
    if (!changed) return;
    setFeatures(nextFeatures);
  }, [features, setFeatures]);

  useEffect(() => {
    if (parcelleYearFilter === "all" || parcelleYearFilter === "unknown") {
      return;
    }
    if (!yearOptions.years.includes(Number(parcelleYearFilter))) {
      setParcelleYearFilter("all");
    }
  }, [parcelleYearFilter, yearOptions.years]);

  useEffect(() => {
    if (parcelleGroupFilter === "all" || parcelleGroupFilter === "ungrouped") {
      return;
    }
    if (!groupOptions.groups.includes(parcelleGroupFilter)) {
      setParcelleGroupFilter("all");
    }
  }, [parcelleGroupFilter, groupOptions.groups]);

  // La carte occupe désormais une cellule de grille : quand le panneau latéral
  // s'ouvre, se ferme ou s'élargit, MapLibre doit recalculer sa taille de canvas.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const timeout = setTimeout(() => {
      try {
        map.resize();
      } catch {
        /* la carte peut avoir été détruite entre-temps */
      }
    }, 60);
    return () => clearTimeout(timeout);
  }, [mapRef, sideOpen, sideWidth, matchViewOpen, compact]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const applyFilter = () => {
      const filterValue = parcelleYearFilter;
      let yearFilter = null;
      const yearExpr = ["to-number", ["get", "annee"], INVALID_YEAR];
      if (filterValue === "unknown") {
        yearFilter = ["==", yearExpr, INVALID_YEAR];
      } else if (filterValue !== "all") {
        const parsed = normalizeYearValue(filterValue);
        if (parsed != null) {
          yearFilter = ["==", yearExpr, parsed];
        }
      }

      let groupFilter = null;
      if (parcelleGroupFilter === "ungrouped") {
        groupFilter = [
          "any",
          ["!", ["has", "layerType"]],
          ["==", ["get", "layerType"], ""],
        ];
      } else if (parcelleGroupFilter !== "all") {
        groupFilter = ["==", ["get", "layerType"], parcelleGroupFilter];
      }

      const layerIds = DRAW_LAYER_IDS.flatMap((layerId) =>
        DRAW_LAYER_VARIANTS.map((suffix) => `${layerId}${suffix}`)
      );
      layerIds.forEach((layerId) => {
        if (!map.getLayer(layerId)) return;
        const stored = drawLayerFiltersRef.current.get(layerId);
        const baseFilter = stored ?? map.getFilter(layerId) ?? null;
        if (!stored) {
          drawLayerFiltersRef.current.set(layerId, baseFilter);
        }
        const filters = [baseFilter, yearFilter, groupFilter].filter(Boolean);
        const nextFilter = filters.length
          ? filters.length === 1
            ? filters[0]
            : ["all", ...filters]
          : null;
        const previousApplied = drawLayerAppliedFiltersRef.current.get(layerId);
        const previousSerialized =
          previousApplied == null ? "__NULL__" : JSON.stringify(previousApplied);
        const nextSerialized = nextFilter == null ? "__NULL__" : JSON.stringify(nextFilter);
        if (previousSerialized === nextSerialized) return;
        map.setFilter(layerId, nextFilter);
        drawLayerAppliedFiltersRef.current.set(layerId, nextFilter);
      });
    };

    applyFilter();
  }, [mapRef, parcelleYearFilter, parcelleGroupFilter]);

  const visibleFeatures = useMemo(() => {
    const yearFilter = parcelleYearFilter;
    const groupFilter = parcelleGroupFilter;
    return features.filter((feature) => {
      const yearValue = normalizeYearValue(feature?.properties?.annee);
      if (yearFilter === "unknown") {
        if (yearValue != null) return false;
      } else if (yearFilter !== "all") {
        const parsed = normalizeYearValue(yearFilter);
        if (parsed != null && yearValue !== parsed) return false;
      }

      const groupValue = String(feature?.properties?.layerType ?? "").trim();
      if (groupFilter === "ungrouped") {
        if (groupValue) return false;
      } else if (groupFilter !== "all") {
        if (groupValue !== groupFilter) return false;
      }
      return true;
    });
  }, [features, parcelleYearFilter, parcelleGroupFilter]);

  // ✅ expose maplibregl pour les popups utilisés par le hook local
  useEffect(() => {
    (window).maplibregl = maplibregl;
  }, []);

  useEffect(() => {
    const warnings = [];
    if (
      typeof window !== "undefined" &&
      (window.CODEBOOK_EXTRA == null || typeof window.CODEBOOK_EXTRA !== "object")
    ) {
      warnings.push({
        code: ERROR_CODES.CODEBOOK_MISSING,
        message: "codebookV2.js est absent ou invalide (labels cultures indisponibles).",
      });
    }
    if (
      typeof window !== "undefined" &&
      (window.CULTURE_COLORS == null || typeof window.CULTURE_COLORS !== "object")
    ) {
      warnings.push({
        code: ERROR_CODES.COLORBOOK_MISSING,
        message: "colorbook.js est absent ou invalide (couleurs cultures indisponibles).",
      });
    }
    if (warnings.length) {
      setAppWarnings(warnings);
      warnings.forEach((warning) =>
        console.warn(`[${warning.code}] ${warning.message}`)
      );
    }
  }, []);

  /**
   * Hydratation initiale du draw depuis le parcellaire stocké.
   *
   * Elle n'a lieu QU'UNE FOIS. Auparavant l'effet se redéclenchait à chaque
   * changement du store, et le store était lui-même alimenté par l'effet
   * inverse (`features` → store, plus bas) : les deux se réécrivaient sans fin.
   * La garde censée arrêter le cycle comparait deux chaînes JSON construites par
   * des codes différents — ordre des clés distinct, et propriétés ajoutées au
   * passage par `normalizeParcellesCollection` (`__id`, `culture`, `precedent`…) —
   * donc jamais égales. D'où une parcelle supprimée qui réapparaissait, un
   * compteur de parcelles qui oscillait et les filtres qui clignotaient.
   *
   * Les remises à zéro et les imports poussent explicitement dans le draw
   * (`setDrawFeatures`), ils n'ont pas besoin de cet effet.
   */
  useEffect(() => {
    if (parcellesLoading) return;
    if (hasHydratedRef.current) return;
    const nextCollection = parcellesCollection || emptyParcellesCollection;
    setDrawFeatures(nextCollection);
    lastSavedPayloadRef.current = nextCollection;
    lastSyncedPayloadRef.current = nextCollection;
    hasHydratedRef.current = true;
    setBackendReady(true);
  }, [
    parcellesCollection,
    parcellesLoading,
    emptyParcellesCollection,
    setDrawFeatures,
  ]);

  /**
   * Suite d'un import depuis une couche RPG.
   *
   * Mapbox Draw n'émet aucun évènement sur `draw.add()` : la liste des parcelles
   * restait donc figée jusqu'au prochain déplacement d'une parcelle. On relit
   * l'état du draw, puis on enchaîne le nommage par toponymie IGN — la parcelle
   * arrivant du RPG sans nom exploitable.
   */
  const handleRpgImported = useCallback(() => {
    const draw = drawRef.current;
    if (!draw || typeof draw.getAll !== "function") return;
    const polygones = (draw.getAll()?.features ?? []).filter(
      (feature) =>
        feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon"
    );
    setFeatures(polygones);
    void fillToponymieNames(polygones);
  }, [drawRef, setFeatures, fillToponymieNames]);

  const handleResetParcelles = useCallback(async () => {
    setDrawFeatures(emptyParcellesCollection);
    lastSavedPayloadRef.current = emptyParcellesCollection;
    lastSyncedPayloadRef.current = emptyParcellesCollection;
    resetParcellesStore();
    try {
      await clearParcellesGeojson();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      console.warn(`[PARCELLES_RESET_FAILED] Réinitialisation backend impossible: ${message}`);
    }
  }, [
    emptyParcellesCollection,
    resetParcellesStore,
    setDrawFeatures,
  ]);

  useEffect(() => {
    if (!backendReady) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      const payload = buildCollectionFromFeatures(features);
      // Comparaison structurelle et non textuelle : deux collections identiques
      // sérialisées par des codes différents ne donnent pas la même chaîne, et
      // l'enregistrement repartait alors à chaque rendu.
      if (featureCollectionsEqual(payload, lastSavedPayloadRef.current)) return;
      saveParcellesGeojson(features, controller.signal)
        .then((collection) => {
          lastSavedPayloadRef.current = collection;
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Erreur inconnue";
          console.warn(`[PARCELLES_SAVE_FAILED] Enregistrement impossible: ${message}`);
        });
    }, 500);

    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [backendReady, buildCollectionFromFeatures, features]);

  /**
   * Report des parcelles vers le store. Sens unique : le store n'est jamais
   * relu pour réalimenter le draw (voir l'effet d'hydratation plus haut), ce qui
   * garantit qu'aucun cycle ne peut se former.
   */
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    if (isUnmountingRef.current) return;
    const payload = buildCollectionFromFeatures(features);
    if (featureCollectionsEqual(payload, lastSyncedPayloadRef.current)) return;
    const hasFeatures = payload.features.length > 0;
    const storeHasFeatures = (parcellesCollection?.features?.length ?? 0) > 0;
    const isFromDraw = drawSyncRef.current;
    const lastDrawEvent = drawSyncEventRef.current;
    drawSyncRef.current = false;
    drawSyncEventRef.current = null;
    // Un passage à zéro parcelle qui ne vient ni du draw ni d'une suppression
    // est un artefact de montage, pas une intention : on ne vide pas le store.
    if (!hasFeatures && storeHasFeatures && !isFromDraw && lastDrawEvent !== "draw.delete") {
      return;
    }
    lastSyncedPayloadRef.current = payload;
    setFeatureCollection(payload);
  }, [
    buildCollectionFromFeatures,
    features,
    parcellesCollection,
    setFeatureCollection,
  ]);

  useEffect(() => () => {
    isUnmountingRef.current = true;
    const draw = drawRef.current;
    if (!draw || typeof draw.getAll !== "function") return;
    let data = null;
    try {
      data = draw.getAll();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur inconnue";
      console.warn(`[DRAW_SNAPSHOT_FAILED] Lecture Mapbox Draw impossible: ${message}`);
      return;
    }
    if (!data) return;
    const payload = buildCollectionFromFeatures(data?.features || []);
    lastSyncedPayloadRef.current = payload;
    setFeatureCollection(payload);
  }, [buildCollectionFromFeatures, drawRef, setFeatureCollection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markDrawSync = (event) => {
      drawSyncRef.current = true;
      drawSyncEventRef.current = event?.type || "draw.update";
    };
    map.on("draw.create", markDrawSync);
    map.on("draw.update", markDrawSync);
    map.on("draw.delete", markDrawSync);
    return () => {
      map.off("draw.create", markDrawSync);
      map.off("draw.update", markDrawSync);
      map.off("draw.delete", markDrawSync);
    };
  }, [mapRef]);

  // ✅ Charge la couche RRP France depuis un fichier MBTiles local (placer le fichier dans /public/data/)
  //    Exemple : public/data/rrp_france_wgs84_shp.mbtiles
  const {
    polygonsShown,
    loadingTiles,
    freezeCurrentTile,
    frozenTiles,
    removeFrozenTile,
    clearFrozenTiles,
    currentTileSummary,
  } = useSoilLayerLocal({
    map: mapRef.current,
    dataPath: withBasePath("/data/soilmap_dep"),
    sourceId: "soils-rrp",
    fillLayerId: "soils-rrp-fill",
    lineLayerId: "soils-rrp-outline",
    labelLayerId: "soils-rrp-label",
    zIndex: 10,
    visible: rrpVisible,
    fillOpacity: rrpOpacity,
    freezeTiles,
    geoportalOpacity,
  });

  const mapInstance = mapRef.current;
  const infoAbortControllers = useRef([]);
  const lastInfoRequestRef = useRef(0);
  const infoEnabledDefs = useMemo(
    () => RASTER_LAYERS.filter((def) => def.featureInfo),
    [],
  );

  const ensureSoilGridsGridLayer = useCallback(() => {
    if (!mapInstance || !mapInstance.isStyleLoaded()) return false;

    if (!mapInstance.getSource(SOILGRIDS_GRID_SOURCE_ID)) {
      mapInstance.addSource(SOILGRIDS_GRID_SOURCE_ID, {
        type: "geojson",
        data: EMPTY_COLLECTION,
      });
    }

    if (!mapInstance.getLayer(SOILGRIDS_GRID_LAYER_ID)) {
      mapInstance.addLayer({
        id: SOILGRIDS_GRID_LAYER_ID,
        type: "line",
        source: SOILGRIDS_GRID_SOURCE_ID,
        paint: {
          "line-color": "#ef4444",
          "line-opacity": 0.6,
          "line-width": 1,
        },
        layout: {
          visibility: soilGridsGridVisible ? "visible" : "none",
        },
      });
    }

    return true;
  }, [mapInstance, soilGridsGridVisible]);

  const refreshSoilGridsGrid = useCallback(() => {
    if (!mapInstance || !soilGridsGridVisible) return;
    if (!ensureSoilGridsGridLayer()) return;

    const bounds = mapInstance.getBounds?.();
    if (!bounds) return;

    const bbox = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ];

    if (soilGridsGridAbortRef.current) {
      soilGridsGridAbortRef.current.abort();
    }
    const controller = new AbortController();
    soilGridsGridAbortRef.current = controller;

    const requestId = soilGridsGridRequestRef.current + 1;
    soilGridsGridRequestRef.current = requestId;
    setSoilGridsGridError(null);

    fetchSoilGridsVisibleGrid({ bbox, limit: 6000, signal: controller.signal })
      .then((payload) => {
        if (requestId !== soilGridsGridRequestRef.current) return;
        const source = mapInstance.getSource(SOILGRIDS_GRID_SOURCE_ID);
        if (source?.setData) {
          source.setData(payload?.collection || EMPTY_COLLECTION);
        }
        setSoilGridsGridMeta({
          featureCount: payload?.featureCount ?? 0,
          truncated: !!payload?.truncated,
          coverageId: payload?.metadata?.coverageId || null,
          crs: payload?.metadata?.crs || "EPSG:4326",
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (requestId !== soilGridsGridRequestRef.current) return;
        const source = mapInstance.getSource(SOILGRIDS_GRID_SOURCE_ID);
        if (source?.setData) {
          source.setData(EMPTY_COLLECTION);
        }
        setSoilGridsGridMeta(null);
        setSoilGridsGridError(error?.message || "Erreur de chargement de la grille SoilGrids");
      });
  }, [mapInstance, soilGridsGridVisible, ensureSoilGridsGridLayer]);

  useEffect(() => {
    if (!mapInstance) return;

    if (!mapInstance.isStyleLoaded()) {
      const onLoad = () => {
        ensureSoilGridsGridLayer();
      };
      mapInstance.once("load", onLoad);
      return () => mapInstance.off("load", onLoad);
    }

    ensureSoilGridsGridLayer();
  }, [mapInstance, ensureSoilGridsGridLayer]);

  useEffect(() => {
    if (!mapInstance || !mapInstance.getLayer(SOILGRIDS_GRID_LAYER_ID)) return;

    mapInstance.setLayoutProperty(
      SOILGRIDS_GRID_LAYER_ID,
      "visibility",
      soilGridsGridVisible ? "visible" : "none",
    );

    if (!soilGridsGridVisible) {
      if (soilGridsGridAbortRef.current) {
        soilGridsGridAbortRef.current.abort();
      }
      const source = mapInstance.getSource(SOILGRIDS_GRID_SOURCE_ID);
      if (source?.setData) source.setData(EMPTY_COLLECTION);
      setSoilGridsGridMeta(null);
      setSoilGridsGridError(null);
      if (soilGridsGridPopupRef.current) {
        soilGridsGridPopupRef.current.remove();
        soilGridsGridPopupRef.current = null;
      }
      return;
    }

    refreshSoilGridsGrid();
  }, [mapInstance, soilGridsGridVisible, refreshSoilGridsGrid]);

  useEffect(() => {
    if (!mapInstance || !soilGridsGridVisible) return;
    let timer = null;

    const handleMoveEnd = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        refreshSoilGridsGrid();
      }, 120);
    };

    mapInstance.on("moveend", handleMoveEnd);
    return () => {
      mapInstance.off("moveend", handleMoveEnd);
      clearTimeout(timer);
    };
  }, [mapInstance, soilGridsGridVisible, refreshSoilGridsGrid]);

  useEffect(() => {
    if (!mapInstance) return;

    const parseBboxValue = (value) => {
      if (Array.isArray(value) && value.length === 4) return value.map((item) => Number(item));
      if (typeof value !== "string") return null;
      const values = value.split(",").map((item) => Number(item.trim()));
      if (values.length !== 4 || values.some((item) => !Number.isFinite(item))) return null;
      return values;
    };

    const handleGridClick = (event) => {
      const feature = event?.features?.[0];
      if (!feature) return;
      const props = feature.properties || {};
      const centerLon = Number(props?.centerLon);
      const centerLat = Number(props?.centerLat);
      const center = Number.isFinite(centerLon) && Number.isFinite(centerLat) ? [centerLon, centerLat] : null;
      const bbox = parseBboxValue(props?.bboxWgs84);

      const html = [
        `<strong>${props.pixelId || "Pixel SoilGrids"}</strong>`,
        `Ligne / colonne : ${props.row ?? "?"} / ${props.col ?? "?"}`,
        center ? `Centre : ${Number(center[1]).toFixed(6)}, ${Number(center[0]).toFixed(6)}` : null,
        Array.isArray(bbox)
          ? `BBox : ${bbox.map((v) => Number(v).toFixed(6)).join(", ")}`
          : null,
      ]
        .filter(Boolean)
        .join("<br />");

      if (soilGridsGridPopupRef.current) {
        soilGridsGridPopupRef.current.remove();
      }
      soilGridsGridPopupRef.current = new maplibregl.Popup({ closeButton: true })
        .setLngLat(event.lngLat)
        .setHTML(`<div style="font-size:12px;">${html}</div>`)
        .addTo(mapInstance);
    };

    const handleMouseEnter = () => {
      mapInstance.getCanvas().style.cursor = "pointer";
    };
    const handleMouseLeave = () => {
      mapInstance.getCanvas().style.cursor = "";
    };

    const bindLayerEvents = () => {
      if (!mapInstance.getLayer(SOILGRIDS_GRID_LAYER_ID)) return false;
      mapInstance.on("click", SOILGRIDS_GRID_LAYER_ID, handleGridClick);
      mapInstance.on("mouseenter", SOILGRIDS_GRID_LAYER_ID, handleMouseEnter);
      mapInstance.on("mouseleave", SOILGRIDS_GRID_LAYER_ID, handleMouseLeave);
      return true;
    };

    let bound = bindLayerEvents();
    const handleStyleData = () => {
      if (!bound) {
        bound = bindLayerEvents();
      }
    };
    if (!bound) {
      mapInstance.on("styledata", handleStyleData);
    }

    return () => {
      if (bound) {
        mapInstance.off("click", SOILGRIDS_GRID_LAYER_ID, handleGridClick);
        mapInstance.off("mouseenter", SOILGRIDS_GRID_LAYER_ID, handleMouseEnter);
        mapInstance.off("mouseleave", SOILGRIDS_GRID_LAYER_ID, handleMouseLeave);
      }
      mapInstance.off("styledata", handleStyleData);
      if (soilGridsGridPopupRef.current) {
        soilGridsGridPopupRef.current.remove();
        soilGridsGridPopupRef.current = null;
      }
    };
  }, [mapInstance]);

  useEffect(() => () => {
    infoAbortControllers.current.forEach((controller) => controller.abort());
    infoAbortControllers.current = [];
    if (soilGridsGridAbortRef.current) {
      soilGridsGridAbortRef.current.abort();
      soilGridsGridAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!mapInstance) return;

    const handleClick = (event) => {
      const visibleInfoDefs = infoEnabledDefs.filter(
        (def) => layerState[def.id]?.visible,
      );
      const querySoils = rrpVisible;

      if (!querySoils && visibleInfoDefs.length === 0) {
        setMapClickInfo(null);
        return;
      }

      infoAbortControllers.current.forEach((controller) => controller.abort());
      infoAbortControllers.current = [];

      const requestId = lastInfoRequestRef.current + 1;
      lastInfoRequestRef.current = requestId;

      const lngLat =
        event.lngLat && typeof event.lngLat.wrap === "function"
          ? event.lngLat.wrap()
          : event.lngLat;

      setMapClickInfo({
        requestId,
        lngLat,
        soils: querySoils ? { loading: true, features: [] } : null,
        layers: [
          ...visibleInfoDefs.map((def) => ({
            id: def.id,
            label: def.label,
            loading: true,
            error: null,
            data: null,
          })),
        ],
      });

      if (querySoils) {
        const soilFeatures = mapInstance.queryRenderedFeatures(event.point, {
          layers: ["soils-rrp-fill"],
        });
        const items = soilFeatures.map((feature, idx) => ({
          id:
            feature.id ??
            feature.properties?.id ??
            feature.properties?.ID ??
            `${feature.source}-${feature.sourceLayer ?? ""}-${idx}`,
          properties: { ...(feature.properties ?? {}) },
        }));

        setMapClickInfo((prev) => {
          if (!prev || prev.requestId !== requestId) return prev;
          return {
            ...prev,
            soils: { loading: false, features: items },
          };
        });
      }

      visibleInfoDefs.forEach((def) => {
        const requestUrl = buildFeatureInfoUrl(def, mapInstance, event.point);
        if (!requestUrl) {
          setMapClickInfo((prev) => {
            if (!prev || prev.requestId !== requestId) return prev;
            return {
              ...prev,
              layers: (prev.layers || []).map((layer) =>
                layer.id === def.id
                  ? {
                      ...layer,
                      loading: false,
                      error: "URL non valide",
                    }
                  : layer,
              ),
            };
          });
          return;
        }

        const controller = new AbortController();
        infoAbortControllers.current.push(controller);

        fetch(requestUrl, { signal: controller.signal })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const contentType = response.headers.get("content-type") || "";
            if (contentType.includes("application/json")) {
              return response.json();
            }
            return response.text().then((text) => ({ text }));
          })
          .then((payload) => {
            const parser = def.featureInfo?.parser || DEFAULT_FEATURE_INFO_PARSER;
            const parsed =
              typeof parser === "function" ? parser(payload, { layer: def }) : payload;

            setMapClickInfo((prev) => {
              if (!prev || prev.requestId !== requestId) return prev;
              return {
                ...prev,
                layers: (prev.layers || []).map((layer) =>
                  layer.id === def.id
                    ? {
                        ...layer,
                        loading: false,
                        error: null,
                        data: parsed,
                      }
                    : layer,
                ),
              };
            });
          })
          .catch((error) => {
            if (controller.signal.aborted) {
              return;
            }
            setMapClickInfo((prev) => {
              if (!prev || prev.requestId !== requestId) return prev;
              return {
                ...prev,
                layers: (prev.layers || []).map((layer) =>
                  layer.id === def.id
                    ? {
                        ...layer,
                        loading: false,
                        error: error.message || "Erreur inconnue",
                      }
                    : layer,
                ),
              };
            });
          })
          .finally(() => {
            infoAbortControllers.current = infoAbortControllers.current.filter(
              (ctrl) => ctrl !== controller,
            );
          });
      });
    };

    mapInstance.on("click", handleClick);

    return () => {
      mapInstance.off("click", handleClick);
    };
  }, [
    mapInstance,
    infoEnabledDefs,
    layerState,
    rrpVisible,
  ]);

  useEffect(() => {
    setMapClickInfo((prev) => {
      if (!prev) return prev;

      const visibleInfoIds = new Set(
        infoEnabledDefs
          .filter((def) => layerState[def.id]?.visible)
          .map((def) => def.id),
      );
      const layers = (prev.layers || []).filter(
        (layer) => visibleInfoIds.has(layer.id),
      );
      const soils = rrpVisible ? prev.soils : null;

      if (layers.length === (prev.layers || []).length && soils === prev.soils) {
        return prev;
      }

      if (!soils && layers.length === 0) {
        return null;
      }

      return { ...prev, layers, soils };
    });
  }, [layerState, rrpVisible, infoEnabledDefs]);

  const totalFrozenFeatures = useMemo(
    () => frozenTiles.reduce((acc, tile) => acc + tile.features.length, 0),
    [frozenTiles]
  );

  const totalVisibleFeatures =
    totalFrozenFeatures + (currentTileSummary?.featureCount ?? 0);

  const soilStatusLabel = (() => {
    if (!rrpVisible) return "couche désactivée";
    if (loadingTiles) return "chargement des tuiles…";
    if (freezeTiles && totalVisibleFeatures === 0)
      return "rechargement en pause – aucune tuile visible";
    if (freezeTiles) return "rechargement en pause";
    if (totalVisibleFeatures === 0) return "aucune tuile visible";
    if (frozenTiles.length > 0) {
      return `tuiles figées (${frozenTiles.length}) + tuile active`;
    }
    return polygonsShown ? "tuile active affichée" : "aucune tuile visible";
  })();

  const canFreezeCurrentTile = Boolean(currentTileSummary?.featureCount);

  const handleCloseInfoPanel = () => {
    infoAbortControllers.current.forEach((controller) => controller.abort());
    infoAbortControllers.current = [];
    setMapClickInfo(null);
  };

  const handleLayerToggle = (id, visible) => {
    setLayerState((prev) => ({
      ...prev,
      [id]: {
        ...(prev?.[id] || {}),
        visible,
      },
    }));
  };

  const handleLayerOpacityChange = (id, value) => {
    setLayerState((prev) => ({
      ...prev,
      [id]: {
        ...(prev?.[id] || {}),
        opacity: value,
      },
    }));
  };

  const handleOpenParcelleMatch = () => {
    if (yearOptions.years.length < 2) {
      alert("Il faut au moins deux années pour comparer les parcelles.");
      return;
    }
    setMatchYears((prev) => ({
      left: prev.left ?? yearOptions.years[0],
      right: prev.right ?? yearOptions.years[1],
    }));
    setMatchViewOpen(true);
  };

  const handleValidateParcelleMatch = async (payload) => {
    const rows = Array.isArray(payload) ? payload : payload?.rows ?? [];
    const leftYear = Array.isArray(payload) ? null : payload?.leftYear ?? null;
    const rightYear = Array.isArray(payload) ? null : payload?.rightYear ?? null;

    const leftYearValue = normalizeYearValue(leftYear);
    const rightYearValue = normalizeYearValue(rightYear);
    if (!rows.length || leftYearValue == null || rightYearValue == null) return false;
    if (leftYearValue === rightYearValue) return false;

    // Gauche = conservée (newYear), Droite = disparaissant (oldYear)
    const keptYear = leftYearValue;
    const disappearingYear = rightYearValue;

    // Ce qui n'est associé à rien est supprimé sans être fusionné : on l'annonce
    // avant, l'opération n'ayant pas de retour arrière.
    const matchedKeys = new Set(
      rows.map((row) => String(row?.disappearingKey || "")).filter(Boolean)
    );
    const disappearingFeatures =
      buildParcellesByYearFromFeatures(features || [])[disappearingYear]?.features || [];
    const orphanCount = disappearingFeatures.filter(
      (feature, index) => !matchedKeys.has(String(getFeatureKey(feature, index)))
    ).length;
    if (orphanCount > 0) {
      const suite = orphanCount > 1 ? "s" : "";
      const confirme = window.confirm(
        `${orphanCount} parcelle${suite} de ${disappearingYear} n'${orphanCount > 1 ? "ont" : "a"} aucune correspondance : ` +
          `elle${suite} ser${orphanCount > 1 ? "ont" : "a"} supprimée${suite} sans que ses cultures soient reportées.\n\n` +
          "Continuer ?"
      );
      if (!confirme) return false;
    }

    const correspondancesValidated = {};
    const matchesPayload = rows.flatMap((row) => {
      if (!row?.disappearingKey || !row?.keptKey) return [];
      // disappearingKey = droite (disparaît) = oldKey ; keptKey = gauche (conservée) = newKey
      correspondancesValidated[String(row.disappearingKey)] = String(row.keptKey);
      return [
        {
          oldId: String(row.disappearingKey),
          newId: String(row.keptKey),
          previousValue: row?.previousValue ?? null,
        },
      ];
    });

    const applyLocalMerge = () => {
      setFeatures((prev) => {
        const next = Array.isArray(prev) ? prev : [];
        if (!next.length) return next;
        const parcellesByYear = buildParcellesByYearFromFeatures(next);
        const {
          parcellesByYear: mergedParcellesByYear,
          removedOldKeys,
          updatedNewByKey,
          error,
        } =
          applyCorrespondencesAndMerge({
            parcellesByYear,
            oldYear: disappearingYear,
            newYear: keptYear,
            correspondancesValidated,
            dropOldYear: true,
          });

        if (error) return next;

        // Les clés de correspondance sont calculées sur l'index au sein de
        // l'année, pas de la liste complète : pour une parcelle sans `id`, un
        // index global donnerait une clé qui ne correspondrait à rien.
        const keyByFeature = new Map();
        Object.values(parcellesByYear).forEach((collection) => {
          (collection?.features || []).forEach((feature, index) => {
            keyByFeature.set(feature, getFeatureKey(feature, index));
          });
        });

        const mergedById = new Map();
        const removedOldKeySet = removedOldKeys ?? new Set();
        Object.values(mergedParcellesByYear || {}).forEach((collection) => {
          (collection?.features || []).forEach((feature) => {
            const id = getFeatureId(feature);
            if (id != null) {
              mergedById.set(String(id), feature);
            }
          });
        });

        return next
          .map((feature, index) => {
            const featureKey = keyByFeature.get(feature) ?? getFeatureKey(feature, index);
            if (removedOldKeySet.has(String(featureKey))) {
              return null;
            }
            const id = getFeatureId(feature);
            if (id == null) {
              return updatedNewByKey?.get(String(featureKey)) ?? feature;
            }
            if (mergedById.has(String(id))) {
              return mergedById.get(String(id));
            }
            return updatedNewByKey?.get(String(featureKey)) ?? feature;
          })
          .filter(Boolean)
          .filter((feature) => Number(feature?.properties?.annee) !== disappearingYear);
      });
    };

    // Toujours appliquer le merge local en premier : il utilise les features
    // en mémoire (plus récentes que le fichier backend qui peut avoir 500ms de retard).
    applyLocalMerge();
    setValidatedMatches(rows);
    setValidatedMatchesAt(new Date());
    setMatchViewOpen(false);

    // Appel backend uniquement pour la persistance (fire and forget).
    validateParcellesMatching({
      oldYear: disappearingYear,
      newYear: keptYear,
      matches: matchesPayload,
    }).catch((error) => {
      console.warn(
        "Persistance backend indisponible, les correspondances sont appliquées localement.",
        error,
      );
    });

    return true;
  };

  const resolveParcelsWithSoilRows = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !rrpVisible || !map.getLayer("soils-rrp-fill")) {
      throw new Error("Active la couche Carte des sols France avant de visualiser les sols.");
    }
    if (loadingTiles || !polygonsShown) {
      throw new Error("Données sols en cours de chargement.");
    }

    const [lookupBySourceFile, lookupByUcsId] = await Promise.all([
      loadSoilTypeLookupBySourceFile(),
      loadSoilTypeLookupByUcsId(),
    ]);

    return features.map((feature, index) => {
      const areaM2 = featureAreaM2(feature) ?? 0;
      const surfaceHa = areaM2 / 10000;
      const probePoints = buildSoilProbePoints(feature);
      if (!probePoints.length) {
        return { index, feature, soilRow: null, surfaceHa };
      }

      let detectedSoilRow = null;
      for (const probe of probePoints) {
        const point = map.project([probe.coordinates[0], probe.coordinates[1]]);
        const rendered = map.queryRenderedFeatures(point, { layers: ["soils-rrp-fill"] }) || [];
        if (!soilMappingDebugLoggedRef.current && rendered.length) {
          const sample = rendered[0];
          const sampleProps = sample?.properties || {};
          const sampleFileUcs = resolveFileUcs(sampleProps);
          const sampleUcsId = resolveUcsId(sampleProps);
          console.info("[SOIL_DEBUG] sample RRP feature properties", {
            id: sample.id,
            keys: Object.keys(sampleProps),
            fileUcs: sampleFileUcs,
            ucsId: sampleUcsId,
            sampleProps,
          });
          soilMappingDebugLoggedRef.current = true;
        }
        for (const candidate of rendered) {
          const soilProps = candidate?.properties || {};
          const fileUcs = resolveFileUcs(soilProps);
          const ucsId = resolveUcsId(soilProps);
          const row =
            (fileUcs && lookupBySourceFile.get(fileUcs.toLowerCase())) ||
            (ucsId && lookupByUcsId.get(ucsId)) ||
            null;
          if (row) {
            detectedSoilRow = row;
            break;
          }
        }
        if (detectedSoilRow) break;
      }

      return { index, feature, soilRow: detectedSoilRow, surfaceHa };
    });
  }, [features, mapRef, rrpVisible, loadingTiles, polygonsShown]);

  useEffect(() => {
    if (!rrpVisible) {
      setSoilMappingParcelCandidates([]);
      return undefined;
    }
    if (loadingTiles || !polygonsShown) {
      return undefined;
    }
    let cancelled = false;
    // Debounce 300ms : évite N×probes queryRenderedFeatures à chaque frappe/édition
    const timeoutId = setTimeout(() => {
      setSoilMappingLoading(true);
      resolveParcelsWithSoilRows()
        .then((candidates) => {
          if (!cancelled) setSoilMappingParcelCandidates(candidates);
        })
        .catch(() => {
          if (!cancelled) setSoilMappingParcelCandidates([]);
        })
        .finally(() => {
          if (!cancelled) setSoilMappingLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [resolveParcelsWithSoilRows, rrpVisible, loadingTiles, polygonsShown, soilMappingRefreshTick]);

  const refreshSoilMapping = useCallback(() => {
    soilMappingDebugLoggedRef.current = false;
    setSoilMappingRefreshTick((prev) => prev + 1);
  }, []);

  const applySoilMappingToParcels = useCallback((structureName, mapping) => {
    if (!structureName || !mapping) return;
    const combinationMap = mapping?.combinationMap || {};
    const hasMapping = Object.keys(combinationMap).length > 0;
    if (!hasMapping) {
      alert("Aucun mapping defini pour cette structure.");
      return;
    }

    const candidatesByIndex = new Map();
    soilMappingParcelCandidates.forEach((candidate) => {
      if (candidate && Number.isFinite(candidate.index)) {
        candidatesByIndex.set(candidate.index, candidate);
      }
    });

    const nextFeatures = features.map((feature, index) => {
      const candidate = candidatesByIndex.get(index);
      if (!candidate?.soilRow) return feature;
      const key = buildSoilCombinationKey(candidate.soilRow);
      const mappedName = combinationMap[key];
      if (!mappedName) return feature;
      const props = { ...(feature.properties || {}) };
      props.type_sol = mappedName;
      props.TYPE_SOL = mappedName;
      return { ...feature, properties: props };
    });

    setFeatures(nextFeatures);
  }, [features, soilMappingParcelCandidates, setFeatures]);

  // ---- Barre d'outils basse : elle occupe sa propre ligne sous la carte plutôt
  //      que de flotter au-dessus, ce qui évite de masquer les parcelles du bas.
  const toolbarStyle = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: compact ? "6px 10px" : "9px 12px",
    background: "var(--c-surface)",
    borderTop: "1px solid var(--c-border)",
    flex: "0 0 auto",
  };
  const toolbarScrollWrap = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  };
  const toolbarScrollArea = {
    display: "flex",
    alignItems: "center",
    gap: 14,
    overflowX: "auto",
    paddingBottom: 4,
    marginBottom: -4,
    scrollbarWidth: "thin",
  };
  const navButtonStyle = {
    padding: "6px 8px",
    borderRadius: "var(--r-sm)",
    border: "1px solid var(--c-border-strong)",
    background: "var(--c-surface)",
    cursor: "pointer",
    fontSize: 13,
    lineHeight: 1,
  };
  // Chaque groupe d'outils porte son intitulé : un nouvel utilisateur comprend à
  // quoi sert chaque bloc sans avoir à survoler les boutons un par un.
  const toolGroupStyle = {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    paddingRight: 14,
    borderRight: "1px solid var(--c-border)",
  };

  const IconChevron = ({ up = false }) => (
    <svg
      viewBox="0 0 24 24"
      style={{ width: 16, height: 16, display: "inline-block", verticalAlign: "-3px" }}
      aria-hidden="true"
    >
      <path d={up ? "M7 14l5-5 5 5" : "M7 10l5 5 5-5"} fill="currentColor" />
    </svg>
  );

  const scrollToolbar = (direction) => {
    const el = toolbarScrollRef.current;
    if (!el) return;
    const delta = Math.round(el.clientWidth * 0.7) * direction;
    el.scrollBy({ left: delta, behavior: "smooth" });
  };

  /**
   * Redimensionnement du panneau à la souris.
   *
   * Le pointeur est capturé sur la poignée : le glissement continue même si le
   * curseur passe au-dessus du canvas de la carte, qui avalerait sinon les
   * évènements.
   */
  const rememberSideWidth = useCallback((largeur) => {
    try {
      window.localStorage.setItem(SIDE_WIDTH_KEY, String(largeur));
    } catch {
      /* sans stockage, la largeur vaut pour la session */
    }
  }, []);

  const startSideResize = useCallback((event) => {
    event.preventDefault();
    resizingRef.current = true;
    try {
      // La capture évite que le canvas de la carte n'avale le glissement. Elle
      // échoue sur un pointeur déjà relâché : le redimensionnement doit
      // fonctionner malgré tout, on ne laisse donc pas l'exception remonter.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture indisponible : le suivi sur window suffit */
    }

    const onMove = (moveEvent) => {
      if (!resizingRef.current) return;
      const largeur = window.innerWidth - moveEvent.clientX;
      const max = window.innerWidth * SIDE_MAX_RATIO;
      setSideWidth(Math.round(Math.min(Math.max(largeur, SIDE_MIN), max)));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setSideWidth((largeur) => {
        rememberSideWidth(largeur);
        return largeur;
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [rememberSideWidth]);

  // Bouton de comparaison inter-millésimes, rendu par l'éditeur au sein de sa
  // barre d'actions, à côté du déplacement de cultures.
  const millesimeAction = (
    <button
      type="button"
      className="fp-btn fp-btn--sm"
      onClick={handleOpenParcelleMatch}
      disabled={yearOptions.years.length < 2}
      title={
        yearOptions.years.length < 2
          ? "Importez au moins deux années de parcellaire pour comparer des millésimes"
          : [
              "Associer les parcelles d'une année à celles d'une autre",
              validatedMatches.length > 0 && validatedMatchesAt
                ? `Dernière validation : ${validatedMatches.length} correspondance(s) à ${validatedMatchesAt.toLocaleTimeString("fr-FR")}`
                : null,
            ]
              .filter(Boolean)
              .join(" — ")
      }
    >
      Comparer deux millésimes
      {yearOptions.years.length >= 2 ? ` (${yearOptions.years.length})` : ""}
    </button>
  );

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--c-bg)",
      }}
    >
      <AppTopBar
        mode={mapMode}
        onModeChange={onMapModeChange}
        onOpenGuide={onOpenGuide}
        parcelCount={features.length}
      >
        <ImportParcellaireButton
          variant="primary"
          mapRef={mapRef}
          drawRef={drawRef}
          setFeatures={setFeatures}
          selectFeatureOnMap={selectFeatureOnMap}
          onImportMeta={(meta) => {
            if (!meta?.pacage) return;
            setCsvValues((prev) => ({ ...prev, codeExploitation: meta.pacage }));
          }}
        />
        <ExportMenuButton
          features={features}
          setFeatures={setFeatures}
          csvValues={csvValues}
          onCsvValuesChange={setCsvValues}
        />
        <button
          type="button"
          className={`fp-btn ${sideOpen ? "fp-btn--active" : ""}`}
          onClick={() => setSideOpen((open) => !open)}
          title={sideOpen ? "Masquer la liste des parcelles" : "Afficher la liste des parcelles"}
          aria-pressed={sideOpen}
        >
          Liste des parcelles
        </button>
      </AppTopBar>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns:
            sideOpen && !matchViewOpen ? `1fr 6px ${sideWidth}px` : "1fr",
        }}
      >
        {/* Colonne carte : la carte occupe la place restante, la barre d'outils
            reste toujours visible en dessous. */}
        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <div
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
              opacity: matchViewOpen ? 0 : 1,
              pointerEvents: matchViewOpen ? "none" : "auto",
            }}
          >
            <div id="map" style={{ position: "absolute", inset: 0 }} />

            <MapInfoPanel info={mapClickInfo} onClose={handleCloseInfoPanel} />

            {/* Écran d'accueil : première chose que voit un utilisateur qui ouvre
                l'outil sans parcellaire. */}
            {!matchViewOpen && features.length === 0 && !parcellesLoading && !welcomeDismissed && (
              <div className="fp-empty">
                <div className="fp-empty__card">
                  <button
                    type="button"
                    className="fp-modal__close"
                    style={{ position: "absolute", top: 8, right: 10, marginLeft: 0 }}
                    onClick={() => setWelcomeDismissed(true)}
                    title="Fermer — vous pouvez aussi commencer par explorer la carte"
                    aria-label="Fermer"
                  >
                    ×
                  </button>
                  <h2 className="fp-empty__title">Aucun parcellaire chargé</h2>
                  <p className="fp-hint">
                    Commencez par importer votre parcellaire, ou dessinez directement vos
                    parcelles sur la carte. Le format est détecté automatiquement et votre
                    fichier est lu sur votre poste, sans être envoyé nulle part. Les fonds
                    de carte, le RPG, la toponymie IGN et le type de sol, eux, interrogent
                    des services en ligne.
                  </p>

                  <div className="fp-format-list">
                    {IMPORT_FORMATS.map((format) => (
                      <span
                        key={format.id}
                        className="fp-badge"
                        title={[format.description, format.limites].filter(Boolean).join("\n")}
                      >
                        {format.label}
                      </span>
                    ))}
                  </div>

                  <div className="fp-empty__actions">
                    <ImportParcellaireButton
                      variant="primary"
                      className="fp-btn--lg"
                      label="Importer un parcellaire"
                      mapRef={mapRef}
                      drawRef={drawRef}
                      setFeatures={setFeatures}
                      selectFeatureOnMap={selectFeatureOnMap}
                      onImportMeta={(meta) => {
                        if (!meta?.pacage) return;
                        setCsvValues((prev) => ({ ...prev, codeExploitation: meta.pacage }));
                      }}
                    />
                    <button
                      type="button"
                      className="fp-btn fp-btn--lg"
                      onClick={() => drawRef.current?.changeMode?.("draw_polygon")}
                    >
                      Dessiner une parcelle
                    </button>
                  </div>

                  <button
                    type="button"
                    className="fp-btn fp-btn--ghost fp-btn--sm"
                    style={{ marginTop: 12 }}
                    onClick={onOpenGuide}
                  >
                    Découvrir le fonctionnement de l'outil
                  </button>
                </div>
              </div>
            )}

            {mapInitError && (
              <div
                className="fp-card"
                style={{
                  position: "absolute",
                  top: 12,
                  left: 12,
                  right: 12,
                  zIndex: 30,
                  maxWidth: 520,
                  borderColor: "#f0b8b1",
                  background: "var(--c-danger-soft)",
                }}
              >
                <h2 style={{ margin: 0, fontSize: "var(--fs-lg)", color: "var(--c-danger)" }}>
                  La carte n'a pas pu démarrer ({mapInitError.code || ERROR_CODES.MAP_INIT_FAILED})
                </h2>
                <p className="fp-hint" style={{ marginTop: 8, color: "#7f1d1d" }}>
                  {mapInitError.message ||
                    "Impossible d'initialiser la carte. Vérifiez que votre navigateur accepte WebGL."}
                </p>
              </div>
            )}

            {appWarnings.length > 0 && (
              <div
                className="fp-card"
                style={{
                  position: "absolute",
                  left: 12,
                  bottom: 12,
                  zIndex: 25,
                  maxWidth: 360,
                  padding: 12,
                  background: "var(--c-warn-soft)",
                  borderColor: "var(--c-warn-border)",
                  color: "var(--c-warn)",
                }}
              >
                <strong style={{ fontSize: "var(--fs-md)" }}>Alertes de configuration</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: "var(--fs-sm)" }}>
                  {appWarnings.map((warning) => (
                    <li key={warning.code}>{warning.message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Barre d'outils de dessin */}
          {!matchViewOpen && (
            <div style={toolbarStyle}>
              <div style={toolbarScrollWrap}>
                {compact && (
                  <button
                    type="button"
                    onClick={() => scrollToolbar(-1)}
                    style={navButtonStyle}
                    title="Faire défiler les outils vers la gauche"
                  >
                    ◀
                  </button>
                )}
                <div style={toolbarScrollArea} ref={toolbarScrollRef}>
                  <div style={{ ...toolGroupStyle, borderRight: "none", paddingRight: 0 }}>
                    {!compact && <span className="fp-section-title">Dessin et édition</span>}
                    <DrawToolbar
                      mapRef={mapRef}
                      drawRef={drawRef}
                      features={features}
                      setFeatures={setFeatures}
                      selectFeatureOnMap={selectFeatureOnMap}
                      onReset={handleResetParcelles}
                      compact={compact}
                    />
                  </div>
                </div>
                {compact && (
                  <button
                    type="button"
                    onClick={() => scrollToolbar(1)}
                    style={navButtonStyle}
                    title="Faire défiler les outils vers la droite"
                  >
                    ▶
                  </button>
                )}
              </div>

              <button
                type="button"
                className="fp-btn fp-btn--sm"
                onClick={() => setCompact((value) => !value)}
                title={compact ? "Afficher les libellés des outils" : "Réduire la barre d'outils"}
              >
                <IconChevron up={compact} />
                {compact ? "Agrandir" : "Réduire"}
              </button>
            </div>
          )}
        </div>

        {/* Panneau latéral : liste des parcelles et calques */}
        {sideOpen && !matchViewOpen && (
          <>
            {/* Poignée de redimensionnement du panneau */}
            <div
              onPointerDown={startSideResize}
              onDoubleClick={() => { setSideWidth(460); rememberSideWidth(460); }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Ajuster la largeur du panneau (double-clic pour réinitialiser)"
              title="Glisser pour élargir le tableau — double-clic pour revenir à la largeur d'origine"
              style={{
                cursor: "col-resize",
                background: "var(--c-border)",
                touchAction: "none",
              }}
            />
            <aside
            style={{
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              borderLeft: "1px solid var(--c-border)",
              background: "var(--c-surface)",
            }}
          >
            <div style={{ padding: "12px 16px 0", flex: "0 0 auto" }}>
              <div className="fp-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className="fp-tab"
                  aria-selected={activeTab === "parcelles"}
                  onClick={() => setActiveTab("parcelles")}
                >
                  Parcelles ({features.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  className="fp-tab"
                  aria-selected={activeTab === "calques"}
                  onClick={() => setActiveTab("calques")}
                  title={
                    layerUpdates.pending > 0
                      ? "Une mise à jour des cartes est disponible"
                      : undefined
                  }
                >
                  Calques
                  {layerUpdates.pending > 0 ? (
                    <span
                      aria-label="mise à jour disponible"
                      style={{
                        display: "inline-block",
                        width: 7,
                        height: 7,
                        marginLeft: 6,
                        borderRadius: 999,
                        background: "var(--c-warn)",
                        verticalAlign: "middle",
                      }}
                    />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="tab"
                  className="fp-tab"
                  aria-selected={activeTab === "mapping-sols"}
                  onClick={() => setActiveTab("mapping-sols")}
                >
                  Sols présentés
                </button>
              </div>

              {activeTab === "parcelles" && features.length === 0 ? (
                <p className="fp-hint" style={{ padding: "10px 0 0" }}>
                  Aucune parcelle pour le moment. Utilisez <strong>Importer</strong> dans la
                  barre du haut, ou l&apos;outil <strong>Dessin</strong> en bas de la carte.
                </p>
              ) : null}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px 20px" }}>
              {activeTab === "parcelles" && (
                <>
                  {/* Filtres d'affichage : ils commandent la carte et le tableau
                      ensemble, et donc la portée des actions en série — décaler
                      les cultures d'un millésime ne doit pas toucher les autres.
                      La barre reste en place dès qu'il y a une parcelle : la faire
                      dépendre du nombre d'années la faisait apparaître et
                      disparaître au gré des états transitoires. */}
                  {features.length > 0 && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                        Année
                        <select
                          value={parcelleYearFilter}
                          onChange={(event) => setParcelleYearFilter(event.target.value)}
                          style={{ padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12 }}
                        >
                          <option value="all">Toutes ({features.length})</option>
                          {yearOptions.years.map((year) => (
                            <option key={year} value={String(year)}>{year}</option>
                          ))}
                          {yearOptions.hasUnknown ? <option value="unknown">Sans année</option> : null}
                        </select>
                      </label>
                      {groupOptions.groups.length > 0 && (
                        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                          Groupe
                          <select
                            value={parcelleGroupFilter}
                            onChange={(event) => setParcelleGroupFilter(event.target.value)}
                            style={{ padding: "4px 6px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12 }}
                          >
                            <option value="all">Tous</option>
                            {groupOptions.groups.map((group) => (
                              <option key={group} value={group}>{group}</option>
                            ))}
                            {groupOptions.hasUngrouped ? <option value="ungrouped">Sans groupe</option> : null}
                          </select>
                        </label>
                      )}
                      {visibleFeatures.length !== features.length ? (
                        <span style={{ fontSize: 12, color: "#b45309" }}>
                          {visibleFeatures.length} / {features.length} parcelles affichées
                        </span>
                      ) : null}
                    </div>
                  )}

                  <ParcelleEditor
                    features={features}
                    visibleFeatures={visibleFeatures}
                    setFeatures={setFeatures}
                    onFillNames={() => fillToponymieNames(features)}
                    isFillingNames={isToponymieNaming}
                    selectedId={selectedId}
                    onSelect={(id) => selectFeatureOnMap(id, true)}
                    drawRef={drawRef}
                    mapRef={mapRef}
                    csvValues={csvValues}
                    onCsvValuesChange={setCsvValues}
                    millesimeAction={millesimeAction}
                  />

                  <p className="fp-hint" style={{ marginTop: 12 }}>
                    Astuce : cliquez une parcelle dans la liste pour la surligner sur la carte,
                    et inversement.
                  </p>
                </>
              )}

              {activeTab === "mapping-sols" && (
                <SoilTypeMappingPanel
                  parcelCandidates={soilMappingParcelCandidates}
                  parcelCount={features.length}
                  rrpVisible={rrpVisible}
                  loading={soilMappingLoading || loadingTiles}
                  onRefresh={refreshSoilMapping}
                  onApplyMapping={applySoilMappingToParcels}
                  onSelectParcels={(ids) => selectFeaturesOnMap(ids, true)}
                />
              )}

              {activeTab === "calques" && (
                <div style={{ display: "grid", gap: 14 }}>
                  <LayerUpdateNotice
                    report={layerUpdates.report}
                    pending={layerUpdates.pending}
                    applying={layerUpdates.applying}
                    appliedCount={layerUpdates.appliedCount}
                    onApply={layerUpdates.apply}
                  />

                  <div>
                    <h3 className="fp-section-title">Fonds de carte et couches</h3>
                    <p className="fp-hint" style={{ margin: "6px 0 10px" }}>
                      Activez un fond pour vous repérer. Les couches marquées comme
                      interrogeables affichent leurs informations au clic sur la carte.
                    </p>
                    <RasterToggles
                      mapRef={mapRef}
                      layerState={layerState}
                      onLayerToggle={handleLayerToggle}
                      onLayerOpacityChange={handleLayerOpacityChange}
                    />
                  </div>

                  <div>
                    <h3 className="fp-section-title">Parcellaires de référence</h3>
                    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                      <RpgFeature
                        mapRef={mapRef}
                        drawRef={drawRef}
                        onImported={handleRpgImported}
                      />
                      <RpgRomaniaFeature
                        mapRef={mapRef}
                        drawRef={drawRef}
                        onImported={handleRpgImported}
                      />
                    </div>
                  </div>

                  <div className="fp-card fp-card--muted">
                    <h3 className="fp-section-title">Grille SoilGrids</h3>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                      <input
                        type="checkbox"
                        checked={soilGridsGridVisible}
                        onChange={(event) => setSoilGridsGridVisible(event.target.checked)}
                      />
                      <span>Afficher la grille</span>
                    </label>
                    <p className="fp-hint" style={{ margin: "6px 0 0" }}>
                      Découpage réel des pixels SoilGrids (WCS) sur l&apos;emprise visible.
                    </p>
                    {soilGridsGridMeta ? (
                      <p className="fp-hint" style={{ margin: "6px 0 0" }}>
                        {soilGridsGridMeta.featureCount} pixel{soilGridsGridMeta.featureCount > 1 ? "s" : ""} affiché
                        {soilGridsGridMeta.featureCount > 1 ? "s" : ""}
                        {soilGridsGridMeta.truncated ? " (limite atteinte)" : ""}
                        {soilGridsGridMeta.coverageId ? ` - ${soilGridsGridMeta.coverageId}` : ""}
                        {soilGridsGridMeta.crs ? ` (${soilGridsGridMeta.crs})` : ""}
                      </p>
                    ) : null}
                    {soilGridsGridError ? (
                      <p style={{ margin: "6px 0 0", fontSize: 11, color: "#b91c1c" }}>{soilGridsGridError}</p>
                    ) : null}
                  </div>

                  <div className="fp-card fp-card--muted">
                    <h3 className="fp-section-title">Carte des sols France</h3>
                    <p className="fp-hint" style={{ margin: "8px 0" }}>
                      Couche pédologique locale (RRP). Elle nécessite les fichiers
                      départementaux, téléchargés à la demande dans{" "}
                      <code>public/data/soilmap_dep</code>. L&apos;onglet « Sols présentés » s&apos;appuie
                      sur cette couche : elle doit être affichée pour détecter les sols des parcelles.
                    </p>

                    <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={rrpVisible}
                        onChange={(event) => setRrpVisible(event.target.checked)}
                      />
                      <span>Afficher la carte des sols</span>
                    </label>

                    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                      <label style={{ display: "grid", gap: 4, fontSize: "var(--fs-sm)" }}>
                        Opacité des polygones
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={rrpOpacity}
                          onInput={(event) => {
                            const value = parseFloat(event.currentTarget.value);
                            setRrpOpacity(value);
                            const map = mapRef.current;
                            if (map && map.getLayer("soils-rrp-fill")) {
                              map.setPaintProperty("soils-rrp-fill", "fill-opacity", value);
                            }
                          }}
                        />
                      </label>
                      <label style={{ display: "grid", gap: 4, fontSize: "var(--fs-sm)" }}>
                        Opacité des couleurs Géoportail
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={geoportalOpacity}
                          onInput={(event) =>
                            setGeoportalOpacity(parseFloat(event.currentTarget.value))
                          }
                        />
                      </label>
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: "var(--fs-sm)",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={freezeTiles}
                          onChange={(event) => setFreezeTiles(event.target.checked)}
                          disabled={!rrpVisible}
                        />
                        <span>Mettre en pause le rechargement automatique</span>
                      </label>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gap: 3,
                        fontSize: "var(--fs-sm)",
                        color: "var(--c-text-soft)",
                        marginTop: 10,
                      }}
                    >
                      <div>Statut : {soilStatusLabel}</div>
                      <div>
                        Tuile visible :{" "}
                        {currentTileSummary
                          ? `${currentTileSummary.featureCount} polygone${
                              currentTileSummary.featureCount > 1 ? "s" : ""
                            }`
                          : "—"}
                      </div>
                      <div>
                        Tuiles figées : {frozenTiles.length} ({totalFrozenFeatures} polygone
                        {totalFrozenFeatures > 1 ? "s" : ""})
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="fp-btn fp-btn--sm"
                        onClick={() => freezeCurrentTile()}
                        disabled={!rrpVisible || !canFreezeCurrentTile}
                        title="Conserver à l'écran la tuile de sols actuellement chargée"
                      >
                        Figer la tuile visible
                      </button>
                      <button
                        type="button"
                        className="fp-btn fp-btn--sm"
                        onClick={() => clearFrozenTiles()}
                        disabled={!frozenTiles.length}
                      >
                        Vider les tuiles figées
                      </button>
                    </div>

                    {frozenTiles.length > 0 && (
                      <ul
                        style={{
                          listStyle: "none",
                          padding: 0,
                          margin: "10px 0 0",
                          display: "grid",
                          gap: 6,
                          fontSize: "var(--fs-sm)",
                        }}
                      >
                        {frozenTiles.map((tile, index) => (
                          <li
                            key={tile.id}
                            style={{
                              border: "1px solid var(--c-border)",
                              borderRadius: "var(--r-md)",
                              padding: 8,
                              background: "var(--c-surface)",
                            }}
                          >
                            <div style={{ fontWeight: 600 }}>
                              #{index + 1} — {tile.features.length} polygone
                              {tile.features.length > 1 ? "s" : ""}
                            </div>
                            <div style={{ color: "var(--c-text-soft)" }}>
                              Centre : {tile.center[1].toFixed(4)}°, {tile.center[0].toFixed(4)}°
                            </div>
                            <button
                              type="button"
                              className="fp-btn fp-btn--sm"
                              style={{ marginTop: 6 }}
                              onClick={() => removeFrozenTile(tile.id)}
                            >
                              Retirer cette tuile
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          </aside>
          </>
        )}
      </div>

      <ParcelleMatchView
        open={matchViewOpen}
        features={features}
        yearOptions={yearOptions.years}
        initialYears={matchYears}
        onClose={() => setMatchViewOpen(false)}
        onValidate={handleValidateParcelleMatch}
      />
    </div>
  );
}
