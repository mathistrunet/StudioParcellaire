import { useCallback, useState } from "react";
import { featureAreaHa, featureCentroid } from "../utils/geometry";
import { getToponymiePoints } from "../services/toponymie";
import { DEPARTMENT_TO_TOPONYMIE_REGION } from "../config/toponymie";
import { resolveToponymNames } from "./toponymieNameFormatting";
import { extractGraphie, findDepartmentForPoint, findNearestToponym } from "../domain/toponymie/nearestToponym.js";

const TELEPAC_NUMBER_REGEX = /^[0-9]+(?:[.-][0-9]+)*$/;
function isMeaningfulName(props) {
  if (!props) return false;
  const rawValue = props.nom ?? props.NOM ?? props.name ?? props.NAME;
  const name = (rawValue ?? "").toString().trim();
  if (!name) return false;
  const nomAffiche = (props.nom_affiche ?? "").toString().trim();
  if (nomAffiche && name === nomAffiche) return false;
  if (TELEPAC_NUMBER_REGEX.test(name.replace(/\s+/g, ""))) return false;
  return true;
}

function collectAssignments(features) {
  const pending = [];
  features.forEach((feature, index) => {
    if (!feature || isMeaningfulName(feature.properties)) return;
    const centroid = featureCentroid(feature);
    if (!centroid) return;
    const department = findDepartmentForPoint(centroid);
    if (!department) return;
    const region = DEPARTMENT_TO_TOPONYMIE_REGION[department];
    if (!region) return;
    pending.push({
      key: feature.id ?? `idx:${index}`,
      centroid,
      region,
      areaHa: featureAreaHa(feature),
    });
  });
  return pending;
}

function buildRegionBbox(items, paddingDegrees = 0.02) {
  if (!Array.isArray(items) || !items.length) return null;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  items.forEach((item) => {
    const [lng, lat] = item.centroid || [];
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  });

  if (!Number.isFinite(minLng)) return null;
  return [
    minLng - paddingDegrees,
    minLat - paddingDegrees,
    maxLng + paddingDegrees,
    maxLat + paddingDegrees,
  ];
}

export function useToponymieAutoNaming(setFeatures) {
  const [isNaming, setIsNaming] = useState(false);

  const fillToponymieNames = useCallback(async (features) => {
    if (isNaming) return;
    if (!Array.isArray(features)) return;
    if (typeof setFeatures !== "function") return;
    const pending = collectAssignments(features);
    if (!pending.length) return;

    setIsNaming(true);
    try {
      const regionData = new Map();
      const pendingByRegion = new Map();
      pending.forEach((item) => {
        if (!pendingByRegion.has(item.region)) {
          pendingByRegion.set(item.region, []);
        }
        pendingByRegion.get(item.region).push(item);
      });

      await Promise.all(
        Array.from(pendingByRegion.entries()).map(async ([region, items]) => {
          const bbox = buildRegionBbox(items);
          if (!bbox) return;
          try {
            const points = await getToponymiePoints(region, bbox);
            regionData.set(region, points);
          } catch (error) {
            console.error(`Toponymie: echec du chargement ${region}`, error);
          }
        })
      );

      const assignments = [];
      pending.forEach((item) => {
        const points = regionData.get(item.region);
        if (!points || !points.length) return;
        const nearest = findNearestToponym(points, item.centroid);
        if (!nearest) return;
        const baseName = extractGraphie(nearest.properties);
        if (!baseName) return;
        assignments.push({
          key: item.key,
          baseName,
          areaHa: item.areaHa,
        });
      });
      if (!assignments.length) return;

      const finalMap = resolveToponymNames(assignments);
      if (!finalMap.size) return;

      setFeatures((prev) => {
        if (!Array.isArray(prev)) return prev;
        let changed = false;
        const next = prev.map((feature, index) => {
          const key = feature?.id ?? `idx:${index}`;
          const name = finalMap.get(key);
          if (!name) return feature;
          const props = { ...(feature?.properties || {}) };
          props.nom = name;
          props.nom_parcelle = name;
          props.NOM_PARCEL = name;
          props.nom_affiche = name;
          changed = true;
          return { ...feature, properties: props };
        });
        return changed ? next : prev;
      });
    } catch (error) {
      console.error("Toponymie: attribution automatique impossible", error);
    } finally {
      setIsNaming(false);
    }
  }, [isNaming, setFeatures]);

  return { fillToponymieNames, isNaming };
}
