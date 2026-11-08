import { useCallback, useEffect, useRef, useState } from "react";
import type { GeoJsonProperties } from "geojson";
import type maplibregl from "maplibre-gl";

import type { LngLatBBox } from "../types/geo";
import { loadDepartmentGeoJSON } from "../services/soilmapLocal";
import departementsMeta from "../data/departements_meta.json";

import {
  FIELD_UCS,
  FIELD_LIB,
  DEFAULT_FILL,
  DEFAULT_OUTLINE,
  DEFAULT_FILL_OPACITY,
} from "../config/soilsLocalConfig";
import { applyGerNomColor, buildGerNomColorExpression } from "../config/soilColorbook";
import {
  buildSoilWmsUrl,
  GEO_PORTAIL_SOIL_DEFAULT_OPACITY,
} from "../config/soilGeoportal";

const WEB_MERCATOR_WORLD_WIDTH_METERS = 40075016.68557849;
const MAX_TILE_EDGE_METERS = 30_000;
const HALF_SQUARE_EDGE_METERS = MAX_TILE_EDGE_METERS / 2;
const EARTH_RADIUS = WEB_MERCATOR_WORLD_WIDTH_METERS / (2 * Math.PI);
const MAX_MERCATOR_LAT = 85.05112877980659;
const MAX_DEPARTMENTS = 3;
const UPDATE_DEBOUNCE_MS = 180;

const META = departementsMeta as Record<
  string,
  { bbox: [number, number, number, number]; centroid: [number, number] }
>;

type FrozenTile = {
  id: number;
  bounds: LngLatBBox;
  center: [number, number];
  features: GeoJSON.Feature[];
  capturedAt: number;
};

type CurrentTile = {
  bounds: LngLatBBox;
  center: [number, number];
  features: GeoJSON.Feature[];
};

export type TileSummary = {
  bounds: LngLatBBox;
  center: [number, number];
  featureCount: number;
};

type Options = {
  map: maplibregl.Map | null;
  sourceId?: string;
  fillLayerId?: string;
  lineLayerId?: string;
  labelLayerId?: string;
  zIndex?: number;
  visible?: boolean;
  fillOpacity?: number;
  freezeTiles?: boolean;
  geoportalOpacity?: number;
};

export function useSoilLayerLocal({
  map,
  sourceId = "soils-rrp",
  fillLayerId = "soils-rrp-fill",
  lineLayerId = "soils-rrp-outline",
  labelLayerId = "soils-rrp-label",
  zIndex = 10,
  visible = true,
  fillOpacity = DEFAULT_FILL_OPACITY,
  freezeTiles = false,
  geoportalOpacity = GEO_PORTAIL_SOIL_DEFAULT_OPACITY,
}: Options) {
  const [polygonsShown, setPolygonsShown] = useState(false);
  const [loadingTiles, setLoadingTiles] = useState(false);
  const [frozenTiles, setFrozenTiles] = useState<FrozenTile[]>([]);
  const [currentTileSummary, setCurrentTileSummary] = useState<TileSummary | null>(null);

  const freezeRef = useRef(freezeTiles);
  const updateRef = useRef<(() => void) | null>(null);
  const requestIdRef = useRef(0);
  const frozenTilesRef = useRef<FrozenTile[]>([]);
  const currentTileRef = useRef<CurrentTile | null>(null);
  const nextFrozenIdRef = useRef(1);
  const updateTimerRef = useRef<number | null>(null);

  useEffect(() => {
    frozenTilesRef.current = frozenTiles;
  }, [frozenTiles]);

  useEffect(() => {
    freezeRef.current = freezeTiles;
    if (freezeTiles) {
      setLoadingTiles(false);
    } else {
      updateRef.current?.();
    }
  }, [freezeTiles]);

  useEffect(() => {
    if (!map) return;

    if (!visible) {
      if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
      if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
      if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      currentTileRef.current = null;
      setCurrentTileSummary(null);
      setPolygonsShown(false);
      setLoadingTiles(false);
      return;
    }

    let aborted = false;

    const applyCombinedFeatures = (dynamicFeatures: GeoJSON.Feature[]): GeoJSON.FeatureCollection => {
      const allFeatures = [
        ...frozenTilesRef.current.flatMap((tile) => tile.features),
        ...dynamicFeatures,
      ];
      allFeatures.forEach((feature) => {
        if (feature.properties) {
          applyGerNomColor(feature.properties as GeoJsonProperties);
        }
      });
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData({ type: "FeatureCollection", features: allFeatures });
      }
      setPolygonsShown(allFeatures.length > 0);
      return { type: "FeatureCollection", features: allFeatures };
    };

    const runUpdate = async () => {
      if (aborted || freezeRef.current) return;
      const center = map.getCenter();
      const codes = pickNearestDepartments(center.lng, center.lat, MAX_DEPARTMENTS);
      const squareBounds = getSquareBounds(center.lng, center.lat);
      if (!codes.length) {
        currentTileRef.current = null;
        setCurrentTileSummary(null);
        applyCombinedFeatures([]);
        setLoadingTiles(false);
        return;
      }

      setLoadingTiles(true);
      const reqId = ++requestIdRef.current;
      const abortController = new AbortController();
      try {
        const departmentResponses = await Promise.all(
          codes.map((code) => loadDepartmentGeoJSON(code, squareBounds, abortController.signal))
        );
        if (aborted || reqId !== requestIdRef.current) return;

        const features = departmentResponses.flatMap((item) => item.features);
        currentTileRef.current = {
          bounds: squareBounds,
          center: [center.lng, center.lat],
          features,
        };
        setCurrentTileSummary({
          bounds: squareBounds,
          center: [center.lng, center.lat],
          featureCount: features.length,
        });
        applyCombinedFeatures(features);
      } catch (error) {
        if (!aborted) {
          const code =
            error && typeof error === "object" && "code" in error
              ? (error as { code?: string }).code
              : undefined;
          const prefix = code ? `[${code}] ` : "";
          console.error(`${prefix}Failed to load soil department`, error);
        }
      } finally {
        abortController.abort();
        if (!aborted) setLoadingTiles(false);
      }
    };

    const scheduleUpdate = () => {
      if (updateTimerRef.current != null) {
        window.clearTimeout(updateTimerRef.current);
      }
      updateTimerRef.current = window.setTimeout(() => {
        updateTimerRef.current = null;
        void runUpdate();
      }, UPDATE_DEBOUNCE_MS);
    };

    function add() {
      try {
        if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
        if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
        if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);

        map.addSource(sourceId, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          promoteId: "id",
        });

        map.addLayer(
          {
            id: fillLayerId,
            type: "fill",
            source: sourceId,
            paint: {
              "fill-color": buildGerNomColorExpression(DEFAULT_FILL),
              "fill-opacity": fillOpacity,
            },
          },
          getLayerIdBelow(map, zIndex) || undefined
        );

        map.addLayer(
          {
            id: lineLayerId,
            type: "line",
            source: sourceId,
            paint: {
              "line-color": DEFAULT_OUTLINE,
              "line-width": 0.6,
              "line-opacity": 0.9,
            },
          },
          getLayerIdBelow(map, zIndex + 1) || undefined
        );

        const labelExpr: any = [
          "coalesce",
          ["to-string", ["get", FIELD_UCS[0]]],
          ["to-string", ["get", FIELD_LIB[0] ?? FIELD_UCS[0]]],
        ];

        const canRenderLabels = Boolean(map.getStyle()?.glyphs);
        if (canRenderLabels) {
          map.addLayer(
            {
              id: labelLayerId,
              type: "symbol",
              source: sourceId,
              layout: {
                "text-field": labelExpr,
                "text-size": 10,
                "text-allow-overlap": false,
              },
              paint: {
                "text-color": "#222",
                "text-halo-color": "#ffffff",
                "text-halo-width": 1.2,
              },
            },
            getLayerIdBelow(map, zIndex + 2) || undefined
          );
        }

        updateRef.current = scheduleUpdate;
        scheduleUpdate();
        map.on("moveend", scheduleUpdate);
        map.on("zoomend", scheduleUpdate);
      } catch (err) {
        console.error("RRP GeoPackage error:", err);
        setLoadingTiles(false);
      }
    }

    const start = () => {
      if (aborted) return;
      add();
    };

    if (!map.isStyleLoaded()) {
      map.once("load", start);
    } else {
      start();
    }

    return () => {
      aborted = true;
      map.off("load", start);
      map.off("moveend", scheduleUpdate);
      map.off("zoomend", scheduleUpdate);
      if (updateTimerRef.current != null) {
        window.clearTimeout(updateTimerRef.current);
        updateTimerRef.current = null;
      }
      // Au départ du mode Édition, la carte est déjà détruite (map.style absent) :
      // l'interroger ferait planter toute l'application.
      if (map.style) {
        if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
        if (map.getLayer(lineLayerId)) map.removeLayer(lineLayerId);
        if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
      currentTileRef.current = null;
      setCurrentTileSummary(null);
      updateRef.current = null;
      requestIdRef.current += 1;
      setPolygonsShown(false);
      setLoadingTiles(false);
    };
  }, [
    map,
    visible,
    sourceId,
    fillLayerId,
    lineLayerId,
    labelLayerId,
    zIndex,
    fillOpacity,
  ]);

  useEffect(() => {
    if (!map) return;
    if (map.getLayer(fillLayerId)) {
      map.setPaintProperty(fillLayerId, "fill-opacity", fillOpacity);
    }
  }, [map, fillLayerId, fillOpacity]);

  useEffect(() => {
    if (!map || !visible) return;
    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    const dynamicFeatures = currentTileRef.current?.features ?? [];
    const allFeatures = [
      ...frozenTiles.map((tile) => tile.features).flat(),
      ...dynamicFeatures,
    ];
    allFeatures.forEach((feature) => {
      if (feature.properties) {
        applyGerNomColor(feature.properties as GeoJsonProperties);
      }
    });
    source.setData({ type: "FeatureCollection", features: allFeatures });
    setPolygonsShown(allFeatures.length > 0);
  }, [map, visible, sourceId, frozenTiles]);

  useEffect(() => {
    if (!visible) {
      setCurrentTileSummary(null);
    }
  }, [visible]);

  useGeoportalOverlays({
    map,
    visible,
    sourceId,
    lineLayerId,
    overlayOpacity: geoportalOpacity,
    currentTileSummary,
    frozenTiles,
  });

  const freezeCurrentTile = useCallback(() => {
    const current = currentTileRef.current;
    if (!current || current.features.length === 0) return null;
    const tile: FrozenTile = {
      id: nextFrozenIdRef.current++,
      bounds: current.bounds,
      center: current.center,
      features: current.features.map((feature) => deepCloneFeature(feature)),
      capturedAt: Date.now(),
    };
    setFrozenTiles((prev) => [...prev, tile]);
    return tile;
  }, []);

  const removeFrozenTile = useCallback((tileId: number) => {
    setFrozenTiles((prev) => prev.filter((tile) => tile.id !== tileId));
  }, []);

  const clearFrozenTiles = useCallback(() => {
    setFrozenTiles([]);
  }, []);

  return {
    polygonsShown,
    loadingTiles,
    freezeCurrentTile,
    frozenTiles,
    removeFrozenTile,
    clearFrozenTiles,
    currentTileSummary,
  };
}

type GeoportalOverlayOptions = {
  map: maplibregl.Map | null;
  visible: boolean;
  sourceId: string;
  lineLayerId: string;
  overlayOpacity: number;
  currentTileSummary: TileSummary | null;
  frozenTiles: FrozenTile[];
};

function useGeoportalOverlays({
  map,
  visible,
  sourceId,
  lineLayerId,
  overlayOpacity,
  currentTileSummary,
  frozenTiles,
}: GeoportalOverlayOptions) {
  const overlayStateRef = useRef(new Map<string, LngLatBBox>());

  useEffect(() => {
    if (!map) return;
    const overlayState = overlayStateRef.current;

    const removeOverlay = (key: string) => {
      const { sourceId: overlaySourceId, layerId } = getOverlayIdentifiers(sourceId, key);
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
      if (map.getSource(overlaySourceId)) {
        map.removeSource(overlaySourceId);
      }
      overlayState.delete(key);
    };

    if (!visible) {
      overlayState.forEach((_, key) => removeOverlay(key));
      overlayState.clear();
      return;
    }

    const desired = new Map<string, LngLatBBox>();
    if (currentTileSummary && currentTileSummary.featureCount > 0) {
      desired.set("current", currentTileSummary.bounds);
    }
    frozenTiles.forEach((tile) => {
      if (tile.features.length > 0) {
        desired.set(`frozen-${tile.id}`, tile.bounds);
      }
    });

    overlayState.forEach((_, key) => {
      if (!desired.has(key)) {
        removeOverlay(key);
      }
    });

    desired.forEach((bounds, key) => {
      const { sourceId: overlaySourceId, layerId } = getOverlayIdentifiers(sourceId, key);
      const previous = overlayState.get(key);

      if (previous && boundsEqual(previous, bounds) && map.getLayer(layerId)) {
        map.setPaintProperty(layerId, "raster-opacity", overlayOpacity);
        return;
      }

      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
      if (map.getSource(overlaySourceId)) {
        map.removeSource(overlaySourceId);
      }

      const coordinates: [number, number][] = [
        [bounds[0], bounds[3]],
        [bounds[2], bounds[3]],
        [bounds[2], bounds[1]],
        [bounds[0], bounds[1]],
      ];

      map.addSource(overlaySourceId, {
        type: "image",
        url: buildSoilWmsUrl(bounds),
        coordinates,
      });

      map.addLayer(
        {
          id: layerId,
          type: "raster",
          source: overlaySourceId,
          paint: { "raster-opacity": overlayOpacity },
        },
        map.getLayer(lineLayerId) ? lineLayerId : undefined
      );

      overlayState.set(key, bounds.slice() as LngLatBBox);
    });
  }, [
    map,
    visible,
    sourceId,
    lineLayerId,
    overlayOpacity,
    currentTileSummary,
    frozenTiles,
  ]);

  useEffect(() => {
    return () => {
      if (!map) return;
      const overlayState = overlayStateRef.current;
      overlayState.forEach((_, key) => {
        if (!map.style) return; // carte déjà détruite : ses couches ont disparu avec elle
        const { sourceId: overlaySourceId, layerId } = getOverlayIdentifiers(sourceId, key);
        if (map.getLayer(layerId)) {
          map.removeLayer(layerId);
        }
        if (map.getSource(overlaySourceId)) {
          map.removeSource(overlaySourceId);
        }
      });
      overlayState.clear();
    };
  }, [map, sourceId]);
}

function pickNearestDepartments(lng: number, lat: number, limit: number): string[] {
  const scores = Object.entries(META).map(([code, info]) => {
    const [minX, minY, maxX, maxY] = info.bbox;
    const inside = lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
    const [cx, cy] = info.centroid;
    const dx = lng - cx;
    const dy = lat - cy;
    return { code, inside, dist2: dx * dx + dy * dy };
  });

  scores.sort((a, b) => {
    if (a.inside && !b.inside) return -1;
    if (!a.inside && b.inside) return 1;
    if (a.dist2 === b.dist2) return a.code.localeCompare(b.code);
    return a.dist2 - b.dist2;
  });

  return scores.slice(0, limit).map((entry) => entry.code);
}

function getOverlayIdentifiers(baseId: string, key: string) {
  const sanitizedBase = baseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const sourceId = `${sanitizedBase}-geoportal-${sanitizedKey}`;
  const layerId = `${sanitizedBase}-geoportal-layer-${sanitizedKey}`;
  return { sourceId, layerId };
}

function boundsEqual(a: LngLatBBox, b: LngLatBBox, epsilon = 1e-9) {
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(a[i] - b[i]) > epsilon) return false;
  }
  return true;
}

function getSquareBounds(lng: number, lat: number): LngLatBBox {
  const center = projectToMercator(lng, lat);
  const minX = center.x - HALF_SQUARE_EDGE_METERS;
  const maxX = center.x + HALF_SQUARE_EDGE_METERS;
  const minY = center.y - HALF_SQUARE_EDGE_METERS;
  const maxY = center.y + HALF_SQUARE_EDGE_METERS;
  const sw = mercatorToLngLat(minX, minY);
  const ne = mercatorToLngLat(maxX, maxY);
  return [sw.lng, sw.lat, ne.lng, ne.lat];
}

function projectToMercator(lng: number, lat: number) {
  const clampedLat = clampLatitude(lat);
  const lambda = (lng * Math.PI) / 180;
  const phi = (clampedLat * Math.PI) / 180;
  const x = EARTH_RADIUS * lambda;
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2));
  return { x, y };
}

function mercatorToLngLat(x: number, y: number) {
  const lng = (x / EARTH_RADIUS) * (180 / Math.PI);
  const lat = (Math.atan(Math.sinh(y / EARTH_RADIUS)) * 180) / Math.PI;
  return { lng, lat };
}

function clampLatitude(lat: number) {
  return Math.max(Math.min(lat, MAX_MERCATOR_LAT), -MAX_MERCATOR_LAT);
}

function deepCloneFeature(feature: GeoJSON.Feature): GeoJSON.Feature {
  if (typeof structuredClone === "function") {
    return structuredClone(feature) as GeoJSON.Feature;
  }
  return JSON.parse(JSON.stringify(feature)) as GeoJSON.Feature;
}

function getLayerIdBelow(map: maplibregl.Map, zIndex: number): string | null {
  const layers = map.getStyle()?.layers ?? [];
  if (!layers.length) return null;
  const idx = Math.min(zIndex, layers.length - 1);
  return layers[idx]?.id ?? null;
}
