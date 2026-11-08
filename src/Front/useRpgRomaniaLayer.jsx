// useRpgRomaniaLayer.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "../services/maplibre";
import { fetchRpgRomaniaGeoJSON, getRpgRomaniaId, RPG_RO_MAX_FEATURES } from "../services/rpgRomania";

/** Constantes */
export const RPG_RO_MIN_ZOOM   = 12;
export const RPG_RO_SOURCE_ID  = "rpg_ro_src";
export const RPG_RO_LAYER_FILL = "rpg_ro_fill";
export const RPG_RO_LAYER_LINE = "rpg_ro_line";

/** Vérifie si le style MapLibre est prêt */
function styleReady(map) {
  if (!map || typeof map.getStyle !== "function") return false;
  const style = map.getStyle();
  if (!style || !Array.isArray(style.layers)) return false;
  if (typeof map.isStyleLoaded === "function") {
    try { return map.isStyleLoaded(); } catch { return false; }
  }
  return true;
}

/**
 * Couche RPG Roumanie (GeoPackage local servi par le backend).
 *
 * Comme le RPG France : déclenchement au zoom ≥ minZoom, 1000 parcelles max sur
 * l'emprise visible, import d'une parcelle vers Mapbox-Draw. Différence : aucune
 * information parcellaire hormis l'identifiant (fbid), donc pas de couleur par
 * culture ni de recherche de précédents culturaux.
 *
 * Props :
 * - mapRef: React.RefObject<maplibregl.Map>
 * - drawRef: React.RefObject<MapboxDraw>
 * - minZoom?: number (défaut: 12)
 * - debounceMs?: number (défaut: 400)
 */
export default function RpgRomaniaFeature({
  mapRef,
  drawRef,
  minZoom    = RPG_RO_MIN_ZOOM,
  debounceMs = 400,
  onImported,
}) {
  const [visible, setVisible] = useState(false);
  const [count, setCount]     = useState(null);
  const debounceRef           = useRef(null);
  const abortRef              = useRef(null);

  // Le gestionnaire de clic n'est posé qu'une fois : il capturerait sinon le
  // premier `onImported` reçu.
  const onImportedRef = useRef(onImported);
  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  // Le composant est démonté à chaque changement d'onglet alors que la carte, elle,
  // survit. Ses gestionnaires doivent partir avec lui : ils liraient sinon les refs
  // de l'instance disparue.
  const detachHandlersRef = useRef(null);
  useEffect(() => () => {
    detachHandlersRef.current?.();
    detachHandlersRef.current = null;
  }, []);

  /** Crée la source + les couches + les handlers (une fois par style chargé) */
  const ensureSourceAndLayers = useCallback(() => {
    const map = mapRef?.current;
    if (!map) return;

    const addAll = () => {
      if (!styleReady(map)) return;
      if (!map.getSource(RPG_RO_SOURCE_ID)) {
        map.addSource(RPG_RO_SOURCE_ID, {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });

        map.addLayer({
          id: RPG_RO_LAYER_FILL,
          type: "fill",
          source: RPG_RO_SOURCE_ID,
          paint: { "fill-color": "#0077b6", "fill-opacity": 0.18 },
        });

        map.addLayer({
          id: RPG_RO_LAYER_LINE,
          type: "line",
          source: RPG_RO_SOURCE_ID,
          paint: { "line-color": "#023e8a", "line-width": 1.4, "line-opacity": 0.9 },
        });
      }

      if (detachHandlersRef.current) return; // déjà posés par cette instance

      // Hover → popup identifiant
      const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      const onMove = (e) => {
        const f = e.features?.[0]; if (!f) return;
        const id = getRpgRomaniaId(f.properties) || "(sans ID)";
        hoverPopup
          .setLngLat([e.lngLat.lng, e.lngLat.lat])
          .setHTML(`<div style="font:12px/1.3 system-ui"><strong>RPG RO — ${id}</strong></div>`)
          .addTo(map);
        map.getCanvas().style.cursor = "pointer";
      };
      const onLeave = () => {
        hoverPopup.remove();
        map.getCanvas().style.cursor = "";
      };
      map.on("mousemove", RPG_RO_LAYER_FILL, onMove);
      map.on("mousemove", RPG_RO_LAYER_LINE, onMove);
      map.on("mouseleave", RPG_RO_LAYER_FILL, onLeave);
      map.on("mouseleave", RPG_RO_LAYER_LINE, onLeave);

      // Click → popup avec bouton "Importer cette parcelle"
      const onClick = (e) => {
        const draw = drawRef?.current;
        const f = e.features?.[0];
        if (!draw || !f) return;

        const id = getRpgRomaniaId(f.properties);

        const el = document.createElement("div");
        el.innerHTML = `
          <div style="font:12px/1.35 system-ui">
            <div style="font-weight:600; margin-bottom:6px">RPG Roumanie — ${id || "(sans ID)"}</div>
            <button id="btn-import-rpg-ro" style="
              padding:6px 10px;border:1px solid #ddd;border-radius:8px;
              background:#fff;cursor:pointer
            ">
              Importer cette parcelle
            </button>
          </div>
        `;
        const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true })
          .setLngLat([e.lngLat.lng, e.lngLat.lat])
          .setDOMContent(el)
          .addTo(map);

        el.querySelector("#btn-import-rpg-ro")?.addEventListener("click", () => {
          popup.remove();

          // Support Polygon / MultiPolygon
          const polys = [];
          if (f.geometry?.type === "Polygon") polys.push(f.geometry.coordinates);
          if (f.geometry?.type === "MultiPolygon")
            for (const poly of f.geometry.coordinates) polys.push(poly);

          let ajoutees = 0;
          polys.forEach((coords) => {
            const feature = {
              type: "Feature",
              properties: {
                source: "RPG_RO",
                numero: id || null,
              },
              geometry: { type: "Polygon", coordinates: coords },
            };
            try {
              draw.add(feature);
              ajoutees += 1;
            } catch (err) { console.error("Erreur ajout Draw:", err); }
          });

          // draw.add() n'émet aucun évènement : il faut signaler l'ajout pour
          // que la parcelle apparaisse aussitôt dans la liste.
          if (ajoutees) onImportedRef.current?.();
        });
      };
      map.on("click", RPG_RO_LAYER_FILL, onClick);
      map.on("click", RPG_RO_LAYER_LINE, onClick);

      detachHandlersRef.current = () => {
        hoverPopup.remove();
        for (const layer of [RPG_RO_LAYER_FILL, RPG_RO_LAYER_LINE]) {
          map.off("mousemove", layer, onMove);
          map.off("mouseleave", layer, onLeave);
          map.off("click", layer, onClick);
        }
      };
    };

    if (styleReady(map)) addAll();
    else map.once("load", addAll);
  }, [mapRef, drawRef]);

  /** Masque la couche (safe même si style pas prêt) */
  const hide = useCallback(() => {
    const map = mapRef?.current;
    if (!styleReady(map)) { setCount(null); return; }
    if (map.getLayer(RPG_RO_LAYER_FILL)) map.setLayoutProperty(RPG_RO_LAYER_FILL, "visibility", "none");
    if (map.getLayer(RPG_RO_LAYER_LINE)) map.setLayoutProperty(RPG_RO_LAYER_LINE, "visibility", "none");
    setCount(null);
  }, [mapRef]);

  /** Charge/rafraîchit la couche en fonction de la BBOX */
  const refresh = useCallback(async () => {
    const map = mapRef?.current;
    if (!map || !visible) return;

    if (!styleReady(map)) {
      map.once("load", () => refresh());
      return;
    }

    ensureSourceAndLayers();

    if (map.getZoom() < minZoom) {
      hide();
      return;
    }

    // Annule la requête précédente encore en vol
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const b = map.getBounds();
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      const gj = await fetchRpgRomaniaGeoJSON(bbox, { signal: controller.signal, limit: RPG_RO_MAX_FEATURES });
      setCount(Array.isArray(gj.features) ? gj.features.length : 0);

      const src = map.getSource(RPG_RO_SOURCE_ID);
      if (src) src.setData(gj);

      if (map.getLayer(RPG_RO_LAYER_FILL)) map.setLayoutProperty(RPG_RO_LAYER_FILL, "visibility", "visible");
      if (map.getLayer(RPG_RO_LAYER_LINE)) map.setLayoutProperty(RPG_RO_LAYER_LINE, "visibility", "visible");
    } catch (err) {
      if (err?.name !== "AbortError") console.error("[RPG RO] fetch error:", err);
    }
  }, [mapRef, visible, ensureSourceAndLayers, hide, minZoom]);

  /** Debounce des rechargements après pan/zoom */
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !visible) return;
    const handler = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => refresh(), debounceMs);
    };
    map.on("moveend", handler);
    return () => {
      map.off("moveend", handler);
      clearTimeout(debounceRef.current);
    };
  }, [mapRef, visible, refresh, debounceMs]);

  /** Réagir à visible */
  useEffect(() => {
    if (visible) refresh();
    else hide();
  }, [visible, refresh, hide]);

  // Le panneau Calques est démonté au changement d'onglet : on masque la couche
  // pour qu'elle ne reste pas affichée et cliquable sur la vue Parcelles.
  useEffect(() => () => hide(), [hide]);

  /** UI compacte intégrée */
  return (
    <div style={{ borderTop: "1px solid #eee", marginTop: 8, paddingTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontWeight: 600 }}>RPG Roumanie (local)</label>
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => setVisible(e.target.checked)}
          title="Afficher/Masquer"
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 6, marginTop: 6 }}>
        <button onClick={refresh} style={{ padding: "6px 10px" }} title="Recharger">Recharger</button>
        <button onClick={hide}    style={{ padding: "6px 10px" }} title="Masquer">Masquer</button>
      </div>

      <div style={{ color: "#666", fontSize: 12, marginTop: 6 }}>
        {visible ? (
          (mapRef?.current && typeof mapRef.current.getZoom === "function" && mapRef.current.getZoom() < minZoom) ? (
            <>Zoome <strong>≥ {minZoom}</strong> pour charger</>
          ) : (count != null ? <>{count} parcelle(s) — max {RPG_RO_MAX_FEATURES}</> : <>Prêt</>)
        ) : (<>Coche pour afficher</>)}
      </div>
    </div>
  );
}
