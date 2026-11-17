// @vitest-environment jsdom
//
// Bouton « Remplir » de la colonne Bio : statut à trois états lu au RPG, sans jamais
// écraser ce que l'utilisateur a saisi ni affirmer une certification.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { buildTelepacXML } from "../services/telepacXml";

if (typeof window.URL.createObjectURL !== "function") {
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
}

const { default: ParcelleEditor } = await import("./ParcelleEditor");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const geometry = (lon) => ({
  type: "Polygon",
  coordinates: [[[lon, 48.2], [lon + 0.002, 48.2], [lon + 0.002, 48.202], [lon, 48.2]]],
});
const feature = (id, lon, properties = {}) => ({
  type: "Feature",
  id,
  properties: { nom_parcelle: id, annee: 2025, code: "BTH", ilot_numero: "1", numero: id, ...properties },
  geometry: geometry(lon),
});

function stubEnrich(byLon) {
  const fetchMock = vi.fn(async (_url, init) => {
    const lon = JSON.parse(init.body).geometry.coordinates[0][0][0];
    const answer = byLon[lon];
    if (answer?.status) return new Response(JSON.stringify({ error: "panne" }), { status: answer.status });
    const { bio = null, statut = "trouve" } = answer || {};
    return new Response(JSON.stringify({ statut: "ok", bio, cultures: { 2025: { statut } } }), { status: 200 });
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
  return { container, state };
}

async function fillBio(container) {
  const header = [...container.querySelectorAll("th")].find((th) => th.textContent.startsWith("Bio"));
  const button = [...header.querySelectorAll("button")].find((node) => node.textContent.trim() === "Remplir");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("remplissage du bio depuis le RPG", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("distingue les trois états sans confondre inconnu et non bio", async () => {
    const fetchMock = stubEnrich({
      1.6: { bio: true },
      1.61: { bio: false },
      1.62: { bio: null, statut: "aucune_correspondance" },
    });
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { container, state } = renderTable([feature("a", 1.6), feature("b", 1.61), feature("c", 1.62)]);

    await fillBio(container);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).millesimes).toEqual([2025]);
    const [oui, non, inconnu] = state.features.map((item) => item.properties);
    expect(oui).toMatchObject({ bio_rpg: "oui", parcelle_bio: "Oui", isOrganic: true, bio_source: "RPG" });
    expect(oui.organicType).toBeUndefined();
    expect(non.bio_rpg).toBe("non");
    expect(non.isOrganic).toBeUndefined();
    expect(inconnu.bio_rpg).toBe("inconnu");
    expect(inconnu.isOrganic).toBeUndefined();
    expect(container.textContent).toContain("Déclarée bio (RPG 2025)");
    expect(container.textContent).toContain("Inconnu (RPG 2025)");
    expect(alertMock.mock.calls[0][0]).toContain("1 declaree(s) bio, 1 non declaree(s), 1 inconnue(s)");
  });

  it("conserve une case cochée à la main et signale le conflit", async () => {
    stubEnrich({ 1.6: { bio: false } });
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { container, state } = renderTable([
      feature("a", 1.6, { conduite_bio: true, isOrganic: true, organicType: "C1" }),
    ]);

    await fillBio(container);

    expect(state.features[0].properties).toMatchObject({ bio_rpg: "non", isOrganic: true, organicType: "C1" });
    expect(alertMock.mock.calls[0][0]).toContain("1 case(s) cochee(s) conservee(s)");
  });

  it("retire une coche venue du RPG quand le RPG ne la confirme plus", async () => {
    stubEnrich({ 1.6: { bio: false } });
    vi.stubGlobal("alert", vi.fn());
    const { container, state } = renderTable([
      feature("a", 1.6, { conduite_bio: true, isOrganic: true, parcelle_bio: "Oui", bio_source: "RPG" }),
    ]);

    await fillBio(container);

    const props = state.features[0].properties;
    expect(props.isOrganic).toBeUndefined();
    expect(props.parcelle_bio).toBeUndefined();
    expect(props.bio_source).toBeUndefined();
  });

  it("ne déclare pas à Télépac une conduite lue au seul RPG, jusqu'à confirmation", async () => {
    stubEnrich({ 1.6: { bio: true } });
    vi.stubGlobal("alert", vi.fn());
    const { container, state } = renderTable([feature("a", 1.6)]);

    await fillBio(container);
    expect(buildTelepacXML(state.features)).not.toContain("<agri-bio");

    const caseBio = container.querySelector('tbody label[title^="Conduite"] input');
    expect(caseBio.checked).toBe(true);
    await act(async () => caseBio.click()); // décoche
    await act(async () => caseBio.click()); // confirme à la main

    expect(state.features[0].properties.bio_source).toBeUndefined();
    expect(buildTelepacXML(state.features)).toContain('type-conduite-bio="AB"');
  });

  it("ne présente pas un contour refusé comme une panne à relancer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "trop grand", code: "GEOMETRIE_TROP_ETENDUE" }), { status: 400 })
      )
    );
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const { container, state } = renderTable([feature("a", 1.6)]);

    await fillBio(container);

    expect(state.features[0].properties.bio_rpg).toBeUndefined();
    const message = alertMock.mock.calls[0][0];
    expect(message).toContain("1 contour(s) trop etendu(s)");
    expect(message).not.toContain("a relancer");
  });

  it("ne modifie rien si le service est indisponible, ni une parcelle masquée", async () => {
    stubEnrich({ 1.6: { status: 504 } });
    const alertMock = vi.fn();
    vi.stubGlobal("alert", alertMock);
    const initial = [feature("a", 1.6), feature("b", 1.61)];
    const { container, state } = renderTable(initial, { filtreVisible: (item) => item.id === "a" });

    await fillBio(container);

    expect(state.features).toBe(initial);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("indisponible"));
  });
});
