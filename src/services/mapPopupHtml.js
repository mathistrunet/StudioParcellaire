/**
 * HTML des popups de la carte.
 *
 * `Popup.setHTML` et `innerHTML` interprètent ce qu'on leur donne, sans aucun filtre.
 * Or les valeurs affichées viennent de fichiers importés ou de services externes :
 * un nom de parcelle comme `<img src=x onerror=...>` s'exécuterait dans la page, avec
 * accès au parcellaire. Toute valeur passe donc par `escapeHtml` ici, et les composants
 * n'assemblent plus de HTML eux-mêmes.
 */

const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);

/** Fiche d'une parcelle : une ligne de texte par valeur renseignée. */
export const parcellePopupHtml = (lines) =>
  `<div style="font-size:12px;">${lines.filter(Boolean).map(escapeHtml).join("<br />")}</div>`;

/** Libellé affiché au survol d'une couche RPG. */
export const rpgHoverPopupHtml = (label) =>
  `<div style="font:12px/1.3 system-ui"><strong>${escapeHtml(label)}</strong></div>`;

/** Contenu du clic sur une parcelle RPG. `buttonId` est une constante du code appelant. */
export const rpgImportPopupHtml = (title, buttonId) => `
  <div style="font:12px/1.35 system-ui">
    <div style="font-weight:600; margin-bottom:6px">${escapeHtml(title)}</div>
    <button id="${buttonId}" style="
      padding:6px 10px;border:1px solid #ddd;border-radius:8px;
      background:#fff;cursor:pointer
    ">
      Importer cette parcelle
    </button>
  </div>
`;

/** Fiche d'un pixel de la grille SoilGrids. `center` et `bbox` sont déjà numériques. */
export const soilGridsPixelPopupHtml = ({ pixelId, row, col, center, bbox }) => {
  const lines = [
    `<strong>${escapeHtml(pixelId || "Pixel SoilGrids")}</strong>`,
    `Ligne / colonne : ${escapeHtml(row ?? "?")} / ${escapeHtml(col ?? "?")}`,
    center ? `Centre : ${Number(center[1]).toFixed(6)}, ${Number(center[0]).toFixed(6)}` : null,
    Array.isArray(bbox) ? `BBox : ${bbox.map((v) => Number(v).toFixed(6)).join(", ")}` : null,
  ];
  return `<div style="font-size:12px;">${lines.filter(Boolean).join("<br />")}</div>`;
};
