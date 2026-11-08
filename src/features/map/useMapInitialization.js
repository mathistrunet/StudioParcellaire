import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "../../services/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import MultipleSelectionMode from "./multipleSelectionMode.js";

import { useRasterLayers } from "./useRasterLayers";
import { readPolygonsFromDraw } from "./drawFeatures";
import { buildError, ERROR_CODES } from "../../utils/errors";

if (typeof window !== "undefined") window.mapboxgl = maplibregl;

const SOIL_LAYER_ID = "soil-wmts";
const SOIL_TILES =
  "https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile" +
  "&LAYER=INRA.CARTE.SOLS&STYLE=normal&FORMAT=image/png" +
  "&TILEMATRIXSET=PM&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}";
const SOIL_WMS =
  "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap" +
  "&LAYERS=INRA.CARTE.SOLS&STYLES=&FORMAT=image/png&CRS=EPSG:3857" +
  "&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}";
const YEAR_COLOR_PALETTE = [
  "#2563eb",
  "#16a34a",
  "#f97316",
  "#7c3aed",
  "#dc2626",
  "#0ea5e9",
  "#84cc16",
  "#facc15",
];
const DEFAULT_POLYGON_FILL = "#18A0FB";
const DEFAULT_POLYGON_LINE = "#0066CC";


export function useMapInitialization() {
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const pendingFeaturesRef = useRef(null);
  const drawListenersRef = useRef(null);
  const [features, setFeaturesState] = useState([]);
  // Miroir synchrone de `features`. Il sert à calculer une mise à jour
  // fonctionnelle *hors* de l'updater React : `draw.set` est un effet de bord, et
  // un updater doit rester pur — React l'invoque deux fois en StrictMode, ce qui
  // poussait deux fois dans Mapbox Draw et laissait le drapeau de garde dans un
  // état incohérent. Le miroir permet aussi d'enchaîner plusieurs mises à jour
  // dans le même tick sans perdre la précédente.
  const featuresRef = useRef([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mapInitError, setMapInitError] = useState(null);
  const [drawReady, setDrawReady] = useState(false);
  const syncingDrawRef = useRef(false);
  const ensureRaster = useRasterLayers();

  const applyFeatures = useCallback((list) => {
    const safeList = Array.isArray(list) ? list : [];
    featuresRef.current = safeList;
    setFeaturesState(safeList);
  }, []);

  const syncFeaturesFromDraw = useCallback((drawInstance) => {
    const draw = drawInstance || drawRef.current;
    if (!draw || syncingDrawRef.current) return;
    syncingDrawRef.current = true;
    try {
      applyFeatures(readPolygonsFromDraw(draw));
    } finally {
      syncingDrawRef.current = false;
    }
  }, [applyFeatures]);

  const setFeatures = useCallback((nextValue) => {
    const previous = featuresRef.current;
    const next = typeof nextValue === "function" ? nextValue(previous) : nextValue;
    const safeNext = Array.isArray(next) ? next : [];

    const draw = drawRef.current;
    if (draw && !syncingDrawRef.current) {
      syncingDrawRef.current = true;
      try {
        draw.set({ type: "FeatureCollection", features: safeNext });
      } finally {
        syncingDrawRef.current = false;
      }
    }

    applyFeatures(safeNext);
  }, [applyFeatures]);

  const setDrawFeatures = useCallback(
    (collection) => {
      const safeCollection =
        collection && collection.type === "FeatureCollection"
          ? {
              type: "FeatureCollection",
              features: Array.isArray(collection.features)
                ? collection.features
                : [],
            }
          : { type: "FeatureCollection", features: [] };
      const draw = drawRef.current;
      if (!draw) {
        pendingFeaturesRef.current = safeCollection;
        return;
      }
      draw.set(safeCollection);
      syncFeaturesFromDraw(draw);
    },
    [syncFeaturesFromDraw]
  );

  const selectFeatureOnMap = useCallback((id, fit = false) => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw || !id) return;

    draw.changeMode("simple_select", { featureIds: [id] });
    setSelectedId(id);

    if (fit) {
      const all = draw.getAll();
      const found = (all && all.features ? all.features : []).find(
        (g) => g.id === id
      );
      if (found) {
        const ring = found.geometry.coordinates[0];
        const lons = ring.map((p) => p[0]);
        const lats = ring.map((p) => p[1]);
        map.fitBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 40, duration: 400 }
        );
      }
    }
  }, []);

  const selectFeaturesOnMap = useCallback((ids, fit = false) => {
    const map = mapRef.current;
    const draw = drawRef.current;
    if (!map || !draw || !Array.isArray(ids) || ids.length === 0) return;

    draw.changeMode("simple_select", { featureIds: ids });
    setSelectedId(ids[0]);

    if (fit) {
      const all = draw.getAll();
      const features = (all && all.features ? all.features : []).filter((g) => ids.includes(g.id));
      if (features.length === 0) return;

      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;

      features.forEach((feature) => {
        const coords = feature.geometry?.coordinates;
        const type = feature.geometry?.type;
        const rings = [];
        if (type === "Polygon") rings.push(coords?.[0] || []);
        if (type === "MultiPolygon") {
          (coords || []).forEach((poly) => rings.push(poly?.[0] || []));
        }
        rings.forEach((ring) => {
          ring.forEach((point) => {
            const lon = point?.[0];
            const lat = point?.[1];
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            minLon = Math.min(minLon, lon);
            minLat = Math.min(minLat, lat);
            maxLon = Math.max(maxLon, lon);
            maxLat = Math.max(maxLat, lat);
          });
        });
      });

      if (Number.isFinite(minLon) && Number.isFinite(minLat) && Number.isFinite(maxLon) && Number.isFinite(maxLat)) {
        map.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 40, duration: 400 }
        );
      }
    }
  }, []);
useEffect(() => {
    const style = {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {},
      layers: [
        {
          id: "bg",
          type: "background",
          paint: { "background-color": "#dde8f3" },
        },
      ],
    };

    let map;
    try {
      map = new maplibregl.Map({
        container: "map",
        style,
        center: [2.2137, 46.2276],
        zoom: 5,
        pitchWithRotate: false,
        maxPitch: 0,
      });
    } catch (error) {
      // MapLibre 6 exige WebGL2 et le signale par cette erreur au lieu de maplibregl.supported().
      setMapInitError(
        error instanceof maplibregl.GPUInitializationError
          ? buildError(
              ERROR_CODES.MAPLIBRE_UNSUPPORTED,
              "Votre navigateur ne supporte pas WebGL2.",
              error
            )
          : buildError(
              ERROR_CODES.MAP_INIT_FAILED,
              "Impossible d'initialiser la carte.",
              error
            )
      );
      return;
    }
    mapRef.current = map;
    map.dragRotate.disable();
    map.addControl(new maplibregl.NavigationControl(), "top-left");

    let soilTilesTemplate = SOIL_TILES;
    let soilFallbackActivated = false;

    const ensureSoilLayer = (visibilityOverride) => {
      if (!map) return;

      const desiredVisibility =
        typeof visibilityOverride === "string"
          ? visibilityOverride
          : map.getLayer(SOIL_LAYER_ID)
          ? map.getLayoutProperty(SOIL_LAYER_ID, "visibility")
          : undefined;

      if (!map.getSource(SOIL_LAYER_ID)) {
        map.addSource(SOIL_LAYER_ID, {
          type: "raster",
          tiles: [soilTilesTemplate],
          tileSize: 256,
          attribution: "© IGN · © GisSol/INRAE",
        });
      }

      if (!map.getLayer(SOIL_LAYER_ID)) {
        map.addLayer({
          id: SOIL_LAYER_ID,
          type: "raster",
          source: SOIL_LAYER_ID,
          paint: { "raster-opacity": 0.85 },
        });
        map.setLayoutProperty(
          SOIL_LAYER_ID,
          "visibility",
          typeof desiredVisibility === "string" ? desiredVisibility : "none"
        );
      } else if (typeof desiredVisibility === "string") {
        map.setLayoutProperty(SOIL_LAYER_ID, "visibility", desiredVisibility);
      }
    };

    const fallbackToSoilWms = (failedUrl) => {
      if (soilFallbackActivated) return;
      soilFallbackActivated = true;
      soilTilesTemplate = SOIL_WMS;

      const currentVisibility = map.getLayer(SOIL_LAYER_ID)
        ? map.getLayoutProperty(SOIL_LAYER_ID, "visibility")
        : undefined;
      const currentOpacity = map.getLayer(SOIL_LAYER_ID)
        ? map.getPaintProperty(SOIL_LAYER_ID, "raster-opacity")
        : undefined;

      if (map.getLayer(SOIL_LAYER_ID)) {
        map.removeLayer(SOIL_LAYER_ID);
      }
      if (map.getSource(SOIL_LAYER_ID)) {
        map.removeSource(SOIL_LAYER_ID);
      }

      ensureSoilLayer(currentVisibility);
      if (typeof currentOpacity === "number") {
        map.setPaintProperty(SOIL_LAYER_ID, "raster-opacity", currentOpacity);
      }
      console.warn(
        `INRA.CARTE.SOLS WMTS tile failed (falling back to WMS). Last URL: ${failedUrl}`
      );
    };

    const hydrateRaster = () => {
      ensureRaster(map);
      ensureSoilLayer();
    };

    map.on("load", () => {
      hydrateRaster();

      const draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: "simple_select",
        boxSelect: true,

        modes: { ...MapboxDraw.modes, multiple_selection: MultipleSelectionMode },

        styles: [
          {
            id: "draw-polygon-fill-overlap-warning",
            type: "fill",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "overlap_warning", true],
            ],
            paint: { "fill-color": "#ef4444", "fill-opacity": 0.45 },
          },
          {
            id: "draw-polygon-stroke-overlap-warning",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "overlap_warning", true],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#b91c1c", "line-width": 3 },
          },
          {
            id: "draw-polygon-fill-inactive",
            type: "fill",
            filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
            paint: {
              "fill-color": [
                "case",
                ["has", "color"],
                ["get", "color"],
                DEFAULT_POLYGON_FILL,
              ],
              "fill-opacity": 0.2,
            },
          },
          {
            id: "draw-polygon-fill-static",
            type: "fill",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "mode", "static"]],
            paint: {
              "fill-color": [
                "case",
                ["has", "color"],
                ["get", "color"],
                DEFAULT_POLYGON_FILL,
              ],
              "fill-opacity": 0.2,
            },
          },
          {
            id: "draw-polygon-fill-import-mismatch",
            type: "fill",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "import_mismatch", true],
              ["!=", "overlap_warning", true],
            ],
            paint: { "fill-color": "#f59e0b", "fill-opacity": 0.35 },
          },
          {
            id: "draw-polygon-fill-active",
            type: "fill",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "true"]],
            paint: {
              "fill-color": [
                "case",
                ["has", "color"],
                ["get", "color"],
                DEFAULT_POLYGON_FILL,
              ],
              "fill-opacity": 0.3,
            },
          },
          {
            id: "draw-polygon-stroke-inactive",
            type: "line",
            filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": [
                "case",
                ["has", "outlineColor"],
                ["get", "outlineColor"],
                ["case", ["has", "color"], ["get", "color"], DEFAULT_POLYGON_LINE],
              ],
              "line-width": 2,
            },
          },
          {
            id: "draw-polygon-stroke-static",
            type: "line",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "mode", "static"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": [
                "case",
                ["has", "outlineColor"],
                ["get", "outlineColor"],
                ["case", ["has", "color"], ["get", "color"], DEFAULT_POLYGON_LINE],
              ],
              "line-width": 2,
            },
          },
          {
            id: "draw-line-split-preview-inactive",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "LineString"],
              ["==", "split_preview", true],
              ["==", "active", "false"],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#2563eb", "line-width": 4, "line-dasharray": [1, 1] },
          },
          {
            id: "draw-line-split-preview-active",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "LineString"],
              ["==", "split_preview", true],
              ["==", "active", "true"],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#1d4ed8", "line-width": 5 },
          },
          {
            id: "draw-line-static",
            type: "line",
            filter: ["all", ["==", "$type", "LineString"], ["==", "mode", "static"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#1f2937", "line-width": 2 },
          },
          {
            id: "draw-polygon-stroke-import-mismatch",
            type: "line",
            filter: [
              "all",
              ["==", "$type", "Polygon"],
              ["==", "import_mismatch", true],
              ["!=", "overlap_warning", true],
            ],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#b45309", "line-width": 3 },
          },
          {
            id: "draw-polygon-stroke-active",
            type: "line",
            filter: ["all", ["==", "$type", "Polygon"], ["==", "active", "true"]],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: {
              "line-color": [
                "case",
                ["has", "outlineColor"],
                ["get", "outlineColor"],
                ["case", ["has", "color"], ["get", "color"], "#003366"],
              ],
              "line-width": 2,
            },
          },
          {
            id: "draw-vertex-halo-active",
            type: "circle",
            filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"]],
            paint: { "circle-radius": 5, "circle-color": "#ffffff" },
          },
          {
            id: "draw-vertex-active",
            type: "circle",
            filter: ["all", ["==", "meta", "vertex"], ["==", "$type", "Point"]],
            paint: { "circle-radius": 3, "circle-color": "#1B73E8" },
          },
        ],
      });
      drawRef.current = draw;
      map.addControl(draw, "top-left");
      setDrawReady(true);

      const updateList = () => {
        if (syncingDrawRef.current) return;
        applyFeatures(readPolygonsFromDraw(draw));
      };

      if (pendingFeaturesRef.current) {
        draw.set(pendingFeaturesRef.current);
        pendingFeaturesRef.current = null;
        syncFeaturesFromDraw(draw);
      }

      const handleSelectionChange = (e) => {
        const ids = e?.features?.map((f) => f.id) || [];
        setSelectedId(ids[0] || null);
      };
      map.on("draw.selectionchange", handleSelectionChange);
      map.on("draw.create", updateList);
      map.on("draw.update", updateList);
      map.on("draw.delete", updateList);
      drawListenersRef.current = {
        updateList,
        handleSelectionChange,
      };
    });

    map.on("styledata", hydrateRaster);

    map.on("error", (e) => {
      const err = e && e.error;
      const failingUrl =
        (err && (err.url || err.resource?.url || err.resource?.getURL?.())) ||
        undefined;
      const status = err && (err.status || err.statusCode);
      const message = (err && typeof err.message === "string" && err.message) || "";
      if (
        !soilFallbackActivated &&
        failingUrl &&
        failingUrl.includes("INRA.CARTE.SOLS") &&
        (status === 400 || message.includes("400"))
      ) {
        fallbackToSoilWms(failingUrl);
        return;
      }

      console.error("[MAP_RUNTIME_ERROR] Erreur MapLibre.", err);
    });

    return () => {
      if (drawListenersRef.current) {
        const { updateList, handleSelectionChange } = drawListenersRef.current;
        map.off("draw.selectionchange", handleSelectionChange);
        map.off("draw.create", updateList);
        map.off("draw.update", updateList);
        map.off("draw.delete", updateList);
        drawListenersRef.current = null;
      }
      map.off("styledata", hydrateRaster);
      if (drawRef.current) {
        try {
          map.removeControl(drawRef.current);
        } catch {
          // ignore
        }
      }
      drawRef.current = null;
      setDrawReady(false);
      try {
        map.remove();
      } catch {
        // ignore
      }
    };
  }, [applyFeatures, ensureRaster, syncFeaturesFromDraw]);

  return {
    mapRef,
    drawRef,
    features,
    setFeatures,
    selectedId,
    setSelectedId,
    selectFeatureOnMap,
    selectFeaturesOnMap,
    setDrawFeatures,
    mapInitError,
    drawReady,
  };
}



