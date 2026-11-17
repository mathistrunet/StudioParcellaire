import { useMemo } from "react";

const panelStyle = {
  position: "absolute",
  top: 12,
  right: 12,
  width: 360,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  boxShadow: "0 10px 24px rgba(15,23,42,.15)",
  zIndex: 40,
  padding: 12,
  fontSize: 12,
};

const uprBadgeStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 28,
  height: 28,
  padding: "0 8px",
  borderRadius: 8,
  background: "#1d4ed8",
  color: "#fff",
  fontWeight: 700,
  fontSize: 14,
};

export default function ParcelSoilPanel({ parcel, soilState, onClose, onImport, onRefresh }) {
  const summary = soilState?.data?.summary;
  const profile = soilState?.data?.profile || [];
  const source = soilState?.data?.source;
  const upr = soilState?.data?.upr;
  const wrb = soilState?.data?.wrb;
  const badgeDate = useMemo(() => {
    if (!source?.fetchedAt) return "—";
    return new Date(source.fetchedAt).toLocaleString("fr-FR");
  }, [source?.fetchedAt]);

  if (!parcel) return null;

  return (
    <aside style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Sol — SoilGrids</strong>
        <button type="button" onClick={onClose}>Fermer</button>
      </div>

      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ background: "#e0f2fe", color: "#0369a1", padding: "2px 8px", borderRadius: 999 }}>SoilGrids (250m)</span>
        <span>Récupéré : {badgeDate}</span>
        {soilState?.cacheHit ? <span style={{ color: "#065f46" }}>Cache</span> : null}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button type="button" onClick={onImport}>Importer depuis SoilGrids</button>
        <button type="button" onClick={onRefresh}>Rafraîchir SoilGrids</button>
      </div>

      {soilState?.loading ? <p>Chargement SoilGrids…</p> : null}
      {soilState?.error ? <p style={{ color: "#b91c1c" }}>Données indisponibles : {soilState.error}</p> : null}

      {upr ? (
        <div style={{ marginTop: 12, padding: 10, border: "1px solid #c7d2fe", borderRadius: 10, background: "#eef2ff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={uprBadgeStyle}>{upr.code ?? "?"}</span>
            <strong>UPR — {upr.label ?? "Unité de potentiel"}</strong>
          </div>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            <li>Facteur limitant : {upr.limitingFactor ?? "—"}</li>
            <li>Classe WRB : {wrb?.className ?? "—"}</li>
            <li>
              RU calculée (wv) : {summary?.availableWater_wv_mm ?? "—"} mm
              {summary?.availableWater_wv_depth_cm ? ` (intégrée à ${summary.availableWater_wv_depth_cm} cm)` : ""}
              {upr.inputs?.ruSource === "heuristic" ? " (repli heuristique)" : ""}
            </li>
            <li>
              Entrées : argile {upr.inputs?.clay ?? "—"}% / limon {upr.inputs?.silt ?? "—"}% / sable {upr.inputs?.sand ?? "—"}% (0-30 cm),
              pH {upr.inputs?.ph ?? "—"} (0-30 cm), cailloux {upr.inputs?.cfvo ?? "—"}% (0-60 cm)
            </li>
          </ul>
        </div>
      ) : null}

      {summary ? (
        <>
          <h4>Résumé</h4>
          <ul>
            <li>Texture: {summary.textureClass} ({summary.texture?.clay_pct}% argile / {summary.texture?.silt_pct}% limon / {summary.texture?.sand_pct}% sable)</li>
            <li>pH: {summary.ph ?? "—"}</li>
            <li>MO: {summary.organicMatter_pct ?? "—"}%</li>
            <li>Azote total: {summary.nitrogen_pct ?? "—"}%</li>
            <li>CEC: {summary.cec_cmolkg ?? "—"} cmol/kg</li>
            <li>Porosité: {summary.porosity_pct ?? "—"}%</li>
            <li>RU estimée (heuristique texture): {summary.availableWater_mm ?? "—"} mm</li>
            <li>RU calculée (wv0033−wv1500): {summary.availableWater_wv_mm ?? "—"} mm</li>
            <li>Drainage: {summary.drainage}</li>
            <li>Profondeur cible estimée: {summary.depth_cm} cm ({summary.confidence})</li>
          </ul>
          {!!summary.warnings?.length && <p>Warnings: {summary.warnings.join(", ")}</p>}

          <h4>Profil profondeur</h4>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr><th>Prof.</th><th>Texture</th><th>pH</th><th>MO%</th><th>N%</th><th>CEC</th><th>BD</th></tr>
            </thead>
            <tbody>
              {profile.map((row) => (
                <tr key={row.depth}>
                  <td>{row.depth}</td>
                  <td>{row.clay_pct ?? "—"}/{row.silt_pct ?? "—"}/{row.sand_pct ?? "—"}</td>
                  <td>{row.ph ?? "—"}</td>
                  <td>{row.organicMatter_pct ?? "—"}</td>
                  <td>{row.nitrogen_pct ?? "—"}</td>
                  <td>{row.cec_cmolkg ?? "—"}</td>
                  <td>{row.bulkDensity_gcm3 ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Méthode & limites</h4>
          <p>Source: SoilGrids (résolution ~250m). Indicateurs RU/Drainage/Profondeur sont des estimations, pas un diagnostic pédologique terrain.</p>
          <p>Point GPS utilisé: {source?.lat?.toFixed?.(5)}, {source?.lon?.toFixed?.(5)} ({source?.pointStrategy}).</p>
        </>
      ) : null}
    </aside>
  );
}
