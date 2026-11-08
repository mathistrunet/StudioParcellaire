export async function fetchSoilGridsVisibleGrid({ bbox, limit = 5000, signal } = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error("bbox invalide");
  }

  const params = new URLSearchParams({
    bbox: bbox.map((value) => Number(value)).join(","),
    limit: String(limit),
  });
  const response = await fetch(`/api/soilgrids/grid?${params.toString()}`, { signal });
  // Une réponse non JSON (serveur local arrêté derrière le proxy) ne doit pas masquer l'erreur.
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || "Grille SoilGrids indisponible");
  }
  return payload;
}
