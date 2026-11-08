// useRpgLayer.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "../services/maplibre";
import { fetchRpgGeoJSON, getCultureLabel, getMapBoundsCRS84 } from "../services/rpg";

/** Constantes (exportées si besoin ailleurs) */
export const RPG_MIN_ZOOM   = 12;
export const RPG_SOURCE_ID  = "rpg_src";
export const RPG_LAYER_FILL = "rpg_fill";
export const RPG_LAYER_LINE = "rpg_line";

/** Vérifie si le style MapLibre est prêt (évite “There is no style added to the map.”) */
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
 * Composant autonome d’affichage RPG (WFS Géoportail) + import vers Mapbox-Draw
 *
 * Props optionnelles :
 * - mapRef: React.RefObject<maplibregl.Map>
 * - drawRef: React.RefObject<MapboxDraw>
 * - minZoom?: number (défaut: 12)
 * - years?: number[] (défaut: [2024..2018])
 * - defaultYear?: number (défaut: 2023)
 * - debounceMs?: number (défaut: 400)
 * - colorMap?: Record<string,string> (override de window.CULTURE_COLORS)
 * - defaultColor?: string (override de window.DEFAULT_CULTURE_COLOR)
 */
export default function RpgFeature({
  mapRef,
  drawRef,
  minZoom     = RPG_MIN_ZOOM,
  // Millésimes réellement exposés par le WFS GEOPF (vérifiés un par un).
  years       = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015],
  defaultYear = 2023,
  debounceMs  = 400,
  colorMap,
  defaultColor,
  onImported,
}) {
  const [visible, setVisible] = useState(false);
  const [year, setYear]       = useState(defaultYear);
  const [count, setCount]     = useState(null);
  const debounceRef           = useRef(null);

  // Les gestionnaires de clic ne sont posés qu'une fois, à la création des
  // couches : ils captureraient sinon la première valeur de `year` et le
  // premier `onImported`. On passe donc par des refs tenues à jour.
  const yearRef       = useRef(year);
  const onImportedRef = useRef(onImported);
  useEffect(() => { yearRef.current = year; }, [year]);
  useEffect(() => { onImportedRef.current = onImported; }, [onImported]);

  /** Expression MapLibre pour colorer selon le code culture */
  const buildFillColorExpr = useCallback(() => {
    const COLOR_MAP     = colorMap || (typeof window !== "undefined" ? window.CULTURE_COLORS : {}) || {};
    const DEFAULT_COLOR = defaultColor || (typeof window !== "undefined" ? window.DEFAULT_CULTURE_COLOR : "#CCCCCC");

    // “code culture” pris sous plusieurs clés possibles, puis normalisé en UPPER
    const codeExpr = [
      "upcase",
      ["to-string",
        ["coalesce",
          ["get","code"],
          ["get","CODE_CULTURE"],
          ["get","CODE_CULTU"],
          ["get","CULT_CODE"],
          ["get","CODE"],
          ["get","CODE_CULT"],
          ["get","CODE_CULTUR"],
          ["get","CULTURE_CODE"],
          ["get","CD_CULT"],
          ["get","CULT"],
          ["get","code_culture"],
          ["get","code_cult"]
        ]
      ]
    ];

    const match = ["match", codeExpr];
    for (const [code, color] of Object.entries(COLOR_MAP)) match.push(code, color);
    match.push(DEFAULT_COLOR);
    return match;
  }, [colorMap, defaultColor]);

  /** Crée la source + les couches + les handlers (à faire une fois par style chargé) */
  const ensureRpgSourceAndLayers = useCallback(() => {
    const map = mapRef?.current;
    if (!map) return;

    const addAll = () => {
      if (!styleReady(map)) return;
      if (map.getSource(RPG_SOURCE_ID)) return; // déjà créé

      map.addSource(RPG_SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: RPG_LAYER_FILL,
        type: "fill",
        source: RPG_SOURCE_ID,
        paint: {
          "fill-color": (colorMap || (typeof window !== "undefined" && window.CULTURE_COLORS))
            ? buildFillColorExpr()
            : "#ff6b00",
          "fill-opacity": 0.18,
        },
      });

      map.addLayer({
        id: RPG_LAYER_LINE,
        type: "line",
        source: RPG_SOURCE_ID,
        paint: { "line-color": "#ff4d00", "line-width": 1.4, "line-opacity": 0.9 },
      });

      // Hover → popup libellé
      const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      const onMove = (e) => {
        const f = e.features?.[0]; if (!f) return;
        const { label } = getCultureLabel(f.properties);
        hoverPopup
          .setLngLat([e.lngLat.lng, e.lngLat.lat])
          .setHTML(`<div style="font:12px/1.3 system-ui"><strong>${label}</strong></div>`)
          .addTo(map);
        map.getCanvas().style.cursor = "pointer";
      };
      const onLeave = () => {
        hoverPopup.remove();
        map.getCanvas().style.cursor = "";
      };
      map.on("mousemove", RPG_LAYER_FILL, onMove);
      map.on("mousemove", RPG_LAYER_LINE, onMove);
      map.on("mouseleave", RPG_LAYER_FILL, onLeave);
      map.on("mouseleave", RPG_LAYER_LINE, onLeave);

      // Click → popup avec bouton “Importer cette parcelle” (ajout Draw)
      const onClick = (e) => {
        const draw = drawRef?.current;
        const f = e.features?.[0];
        if (!draw || !f) return;

        const { label, code } = getCultureLabel(f.properties);

        const el = document.createElement("div");
        el.innerHTML = `
          <div style="font:12px/1.35 system-ui">
            <div style="font-weight:600; margin-bottom:6px">${label}</div>
            <button id="btn-import-rpg" style="
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

        el.querySelector("#btn-import-rpg")?.addEventListener("click", () => {
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
                source: "RPG",
                annee:  yearRef.current,
                code:   code || null, // clé normalisée pour la couleur
                numero: f.properties?.NUMERO || f.properties?.ID_PARCELLE || null,
              },
              geometry: { type: "Polygon", coordinates: coords },
            };
            try {
              draw.add(feature);
              ajoutees += 1;
            } catch (err) { console.error("Erreur ajout Draw:", err); }
          });

          // draw.add() n'émet aucun évènement : sans ce signal, la parcelle
          // n'apparaîtrait dans la liste qu'au prochain déplacement d'une autre
          // parcelle. C'est aussi ici que le nommage par toponymie est déclenché.
          if (ajoutees) onImportedRef.current?.();
        });
      };
      map.on("click", RPG_LAYER_FILL, onClick);
      map.on("click", RPG_LAYER_LINE, onClick);
    };

    if (styleReady(map)) addAll();
    else map.once("load", addAll);
    // `year` n'est volontairement plus une dépendance : les couches ne sont
    // créées qu'une fois, et le millésime est lu via yearRef au moment du clic.
  }, [mapRef, drawRef, buildFillColorExpr, colorMap]);

  /** Masque la couche RPG (safe même si style pas prêt) */
  const hideRpg = useCallback(() => {
    const map = mapRef?.current;
    if (!styleReady(map)) { setCount(null); return; }
    if (map.getLayer(RPG_LAYER_FILL)) map.setLayoutProperty(RPG_LAYER_FILL, "visibility", "none");
    if (map.getLayer(RPG_LAYER_LINE)) map.setLayoutProperty(RPG_LAYER_LINE, "visibility", "none");
    setCount(null);
  }, [mapRef]);

  /** Charge/rafraîchit la couche RPG en fonction de la BBOX + année */
  const refreshRpg = useCallback(async () => {
    const map = mapRef?.current;
    if (!map || !visible) return;

    if (!styleReady(map)) {
      map.once("load", () => refreshRpg());
      return;
    }

    ensureRpgSourceAndLayers();

    if (map.getZoom() < minZoom) {
      hideRpg();
      return;
    }

    try {
      const bbox = getMapBoundsCRS84(map);
      const gj = await fetchRpgGeoJSON(year, bbox);
      setCount(Array.isArray(gj.features) ? gj.features.length : 0);

      const src = map.getSource(RPG_SOURCE_ID);
      if (src) src.setData(gj);

      if (map.getLayer(RPG_LAYER_FILL)) map.setLayoutProperty(RPG_LAYER_FILL, "visibility", "visible");
      if (map.getLayer(RPG_LAYER_LINE)) map.setLayoutProperty(RPG_LAYER_LINE, "visibility", "visible");
    } catch (err) {
      console.error("[RPG] WFS error:", err);
    }
  }, [mapRef, visible, year, ensureRpgSourceAndLayers, hideRpg, minZoom]);

  /** Debounce des rechargements après pan/zoom */
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !visible) return;
    const handler = () => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => refreshRpg(), debounceMs);
    };
    map.on("moveend", handler);
    return () => {
      map.off("moveend", handler);
      clearTimeout(debounceRef.current);
    };
  }, [mapRef, visible, refreshRpg, debounceMs]);

  /** Réagir à visible/année */
  useEffect(() => {
    if (visible) refreshRpg();
    else hideRpg();
  }, [visible, year, refreshRpg, hideRpg]);

  /**
   * Masque la couche quand le panneau Calques est quitté.
   *
   * Le contenu de l'onglet est démonté au changement d'onglet : sans ce
   * nettoyage, les polygones RPG restaient affichés et cliquables sur la vue
   * Parcelles — au risque d'importer une parcelle par inadvertance — et ne
   * disparaissaient qu'au retour dans Calques, le composant se remontant alors
   * avec `visible` à faux.
   */
  useEffect(() => () => hideRpg(), [hideRpg]);

  /** UI compacte intégrée */
  return (
    <div style={{ borderTop: "1px solid #eee", marginTop: 8, paddingTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontWeight: 600 }}>RPG (WFS GEOPF)</label>
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => setVisible(e.target.checked)}
          title="Afficher/Masquer"
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 6, marginTop: 6 }}>
        <select
          value={year}
          onChange={(e) => setYear(parseInt(e.target.value, 10))}
          title="Année RPG"
          style={{ padding: "6px", border: "1px solid #ccc", borderRadius: 6 }}
        >
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <button onClick={refreshRpg} style={{ padding: "6px 10px" }} title="Recharger">Recharger</button>
        <button onClick={hideRpg}    style={{ padding: "6px 10px" }} title="Masquer">Masquer</button>
      </div>

      <div style={{ color: "#666", fontSize: 12, marginTop: 6 }}>
        {visible ? (
          (mapRef?.current && typeof mapRef.current.getZoom === "function" && mapRef.current.getZoom() < minZoom) ? (
            <>Zoome <strong>≥ {minZoom}</strong> pour charger</>
          ) : (count != null ? <>{count} entité(s) chargée(s)</> : <>Prêt</>)
        ) : (<>Coche pour afficher</>)}
      </div>
    </div>
  );
}
