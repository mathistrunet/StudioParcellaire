export async function fetchSoilGridsVisibleGrid({ bbox, limit = 5000, signal } = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error("bbox invalide");
  }

  const params = new URLSearchParams({
    bbox: bbox.map((value) => Number(value)).join(","),
    limit: String(limit),
  });
  const response = await fetch(`/api/soilgrids/grid?${params.toString()}`, { signal });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || "Grille SoilGrids indisponible");
  }
  return payload;
}
