// @vitest-environment jsdom
//
// Bouton « Remplir » des colonnes de cultures : il passe par POST /api/v1/enrich et
// ne dépend plus de la carte (ni de son emprise, ni de son zoom).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getCultureColumn, readCultureValue } from "../domain/parcelles/cultureColumns";

if (typeof window.URL.createObjectURL !== "function") {
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
}

const { default: ParcelleEditor } = await import("./ParcelleEditor");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const YEAR = 2024;
const geometry = (lon) => ({
  type: "Polygon",
  coordinates: [[[lon, 48.2], [lon + 0.002, 48.2], [lon + 0.002, 48.202], [lon, 48.2]]],
});
const feature = (id, lon) => ({
  type: "Feature",
  id,
  properties: { nom_parcelle: id, annee: YEAR },
  geometry: geometry(lon),
});
const culture = (props) => readCultureValue(props, getCultureColumn("current")) || null;

const enrichBody = (entry) =>
  JSON.stringify({ statut: "ok", cultures: { [YEAR]: entry } });

function stubEnrich(byLon) {
  const fetchMock = vi.fn(async (_url, init) => {
    const lon = JSON.parse(init.body).geometry.coordinates[0][0][0];
    const answer = byLon[lon];
    if (answer?.status) return new Response(JSON.stringify({ error: "panne" }), { status: answer.status });
    return new Response(enrichBody(answer), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderTable(features, { filtreVisible = null } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const state = { features };
  const setFeatures = vi.fn((updater) => {
    state.features = typeof updater === "function" ? updater(state.features) : updater;
    render();
  });
  function render() {
    act(() => {
      root.render(
        <ParcelleEditor
          features={state.features}
          visibleFeatures={filtreVisible ? state.features.filter(filtreVisible) : undefined}
          setFeatures={setFeatures}
          selectedId={null}
          onSelect={() => {}}
        />
      );
    });
  }
  render();
  return { container, root, state };
}

/** Clique sur le « Remplir » de l'en-tête « Culture N » et attend la fin du remplissage. */
async function fillCurrentColumn(container) {
  const header = [...container.querySelectorAll("th")].find((th) => th.textContent.includes("Culture N") && !/N[-+]/.test(th.textContent));
  const button = [...header.querySelectorAll("button")].find((node) => node.textContent.trim() === "Remplir");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("remplissage des cultures depuis le RPG", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("remplit sans carte, à partir du contour de chaque parcelle", async () => {
    const fetchMock = stubEnrich({
      1.6: { statut: "trouve", code: "MIS" },
      1.61: { statut: "aucune_correspondance" },
    });
    vi.stubGlobal("alert", vi.fn());
    const { container, state } = renderTable([feature("a", 1.6), feature("b", 1.61)]);

    await fillCurrentColumn(container);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/enrich");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      geometry: geometry(1.6),
      millesimes: [YEAR],
      inclure_nom: false,
    });
    expect(culture(state.features[0].properties)).toBe("MIS");
    expect(culture(state.features[1].properties)).toBeNull();
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("ne touche pas une parcelle masquée par un filtre", async () => {
    const fetchMock = stubEnrich({ 1.6: { statut: "trouve", code: "MIS" } });
    vi.stubGlobal("alert", vi.fn());
    const { container, state } = renderTable([feature("a", 1.6), feature("b", 1.61)], {
      filtreVisible: (item) => item.id === "a",
    });

    await fillCurrentColumn(container);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(culture(state.features[1].properties)).toBeNull();
  });

  it("garde les résultats obtenus et annonce les parcelles en erreur", async () => {
    stubEnrich({ 1.6: { statut: "trouve", code: "MIS" }, 1.61: { status: 502 } });
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { container, state } = renderTable([feature("a", 1.6), feature("b", 1.61)]);

    await fillCurrentColumn(container);

    expect(culture(state.features[0].properties)).toBe("MIS");
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("1 en erreur"));
  });

  it("annonce un service indisponible sans modifier le parcellaire", async () => {
    stubEnrich({ 1.6: { status: 504 } });
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const initial = [feature("a", 1.6)];
    const { container, state } = renderTable(initial);

    await fillCurrentColumn(container);

    expect(state.features).toBe(initial);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("indisponible"));
  });

  it("annonce l'absence totale de correspondance", async () => {
    stubEnrich({ 1.6: { statut: "aucune_correspondance" } });
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { container } = renderTable([feature("a", 1.6)]);

    await fillCurrentColumn(container);

    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("Aucune parcelle RPG"));
  });
});
