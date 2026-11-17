import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchParcellesGeojson } from "../../services/parcellesBackend";
import { normalizeParcellesCollection } from "./parcellesData";
import { featureCollectionsEqual } from "../../utils/featureCollectionEquality";

import { ParcellesContext } from "./ParcellesContext";
const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };

export function ParcellesProvider({ children, initialCollection }) {
  const [parcellesCollection, setParcellesCollectionState] = useState(() =>
    normalizeParcellesCollection(initialCollection || EMPTY_COLLECTION)
  );
  const [historyPast, setHistoryPast] = useState([]);
  const [historyFuture, setHistoryFuture] = useState([]);
  const [loading, setLoading] = useState(!initialCollection);
  const [error, setError] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [isDirty, setIsDirty] = useState(false);

  const setCollectionState = useCallback((next, { dirty = true, trackHistory = true } = {}) => {
    setParcellesCollectionState((prev) => {
      // prev is always normalized (all write paths go through normalizeParcellesCollection)
      const safePrev = prev || EMPTY_COLLECTION;
      const safeNext = normalizeParcellesCollection(
        typeof next === "function" ? next(safePrev) : next
      );
      if (featureCollectionsEqual(safePrev, safeNext)) {
        return safePrev;
      }
      if (trackHistory) {
        setHistoryPast((current) => [...current, safePrev].slice(-50));
        setHistoryFuture([]);
      }
      return safeNext;
    });
    setLastUpdatedAt(Date.now());
    if (dirty) {
      setIsDirty(true);
    }
  }, []);

  const setParcellesCollection = useCallback((next) => {
    setCollectionState(next);
  }, [setCollectionState]);

  const setFeatureCollection = useCallback((next, { dirty = true } = {}) => {
    setCollectionState(next, { dirty, trackHistory: dirty });
  }, [setCollectionState]);

  const refreshParcelles = useCallback(async (signal) => {
    setLoading(true);
    try {
      const collection = await fetchParcellesGeojson(signal);
      setParcellesCollectionState(normalizeParcellesCollection(collection));
      setHistoryPast([]);
      setHistoryFuture([]);
      setError(null);
      setLastUpdatedAt(Date.now());
      setIsDirty(false);
    } catch (err) {
      // Une requête annulée (démontage, double effet en mode strict) n'est pas un échec,
      // et celle qui la remplace est encore en cours : le chargement n'est pas terminé.
      if (signal?.aborted) return;
      setError(err);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialCollection) return undefined;
    const controller = new AbortController();
    refreshParcelles(controller.signal);
    return () => controller.abort();
  }, [initialCollection, refreshParcelles]);

  const setFromTelepac = useCallback((next) => {
    setFeatureCollection(next);
  }, [setFeatureCollection]);

  const upsertFeature = useCallback((feature) => {
    if (!feature) return;
    setCollectionState((prev) => {
      const safePrev = normalizeParcellesCollection(prev || EMPTY_COLLECTION);
      const filtered = safePrev.features.filter((item) => item.id !== feature.id);
      return normalizeParcellesCollection({
        type: "FeatureCollection",
        features: [...filtered, feature],
      });
    });
  }, [setCollectionState]);

  const updateFeatureProps = useCallback((id, partialProps) => {
    if (!id || !partialProps) return;
    setCollectionState((prev) => {
      const safePrev = normalizeParcellesCollection(prev || EMPTY_COLLECTION);
      const nextFeatures = safePrev.features.map((feature) => {
        if (feature.id !== id) return feature;
        return {
          ...feature,
          properties: {
            ...(feature.properties || {}),
            ...partialProps,
          },
        };
      });
      return normalizeParcellesCollection({
        type: "FeatureCollection",
        features: nextFeatures,
      });
    });
  }, [setCollectionState]);

  const updateFeatureGeometry = useCallback((id, geometry) => {
    if (!id || !geometry) return;
    setCollectionState((prev) => {
      const safePrev = normalizeParcellesCollection(prev || EMPTY_COLLECTION);
      const nextFeatures = safePrev.features.map((feature) => {
        if (feature.id !== id) return feature;
        return { ...feature, geometry };
      });
      return normalizeParcellesCollection({
        type: "FeatureCollection",
        features: nextFeatures,
      });
    });
  }, [setCollectionState]);

  const reset = useCallback(() => {
    setCollectionState(EMPTY_COLLECTION);
  }, [setCollectionState]);

  const undo = useCallback(() => {
    if (!historyPast.length) return;
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast((current) => current.slice(0, -1));
    setHistoryFuture((current) => [normalizeParcellesCollection(parcellesCollection), ...current].slice(0, 50));
    setParcellesCollectionState(normalizeParcellesCollection(previous));
    setLastUpdatedAt(Date.now());
    setIsDirty(true);
  }, [historyPast, parcellesCollection]);

  const redo = useCallback(() => {
    if (!historyFuture.length) return;
    const [next, ...rest] = historyFuture;
    setHistoryFuture(rest);
    setHistoryPast((current) => [...current, normalizeParcellesCollection(parcellesCollection)].slice(-50));
    setParcellesCollectionState(normalizeParcellesCollection(next));
    setLastUpdatedAt(Date.now());
    setIsDirty(true);
  }, [historyFuture, parcellesCollection]);

  const canUndo = historyPast.length > 0;
  const canRedo = historyFuture.length > 0;

  const value = useMemo(
    () => ({
      parcellesCollection,
      setParcellesCollection,
      setFeatureCollection,
      setFromTelepac,
      upsertFeature,
      updateFeatureProps,
      updateFeatureGeometry,
      reset,
      undo,
      redo,
      canUndo,
      canRedo,
      loading,
      error,
      refreshParcelles,
      lastUpdatedAt,
      isDirty,
    }),
    [
      parcellesCollection,
      setParcellesCollection,
      setFeatureCollection,
      setFromTelepac,
      upsertFeature,
      updateFeatureProps,
      updateFeatureGeometry,
      reset,
      undo,
      redo,
      canUndo,
      canRedo,
      loading,
      error,
      refreshParcelles,
      lastUpdatedAt,
      isDirty
    ]
  );

  return <ParcellesContext.Provider value={value}>{children}</ParcellesContext.Provider>;
}
