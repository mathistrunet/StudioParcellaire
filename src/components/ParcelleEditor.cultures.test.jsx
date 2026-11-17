// @vitest-environment jsdom
//
// Saisie et déplacement des colonnes de cultures.
//
// Ces scénarios rejouent les pertes de données constatées en usage : une culture
// importée sous un alias autre que la clé canonique passait pour absente, et
// « Déplacer cultures » effaçait alors la colonne destination « au nom » d'une
// source vide, puis la source elle-même.
import { describe, expect, it, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getCultureColumn, readCultureValue } from "../domain/parcelles/cultureColumns";
import { readInterculture } from "../domain/parcelles/intercultures";

if (typeof window.URL.createObjectURL !== "function") {
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
}

const { default: ParcelleEditor } = await import("./ParcelleEditor");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const feature = (id, properties = {}) => ({
  type: "Feature",
  id,
  properties: { nom_parcelle: id, ...properties },
  geometry: {
    type: "Polygon",
    coordinates: [[[1.35, 44.01], [1.36, 44.01], [1.36, 44.02], [1.35, 44.01]]],
  },
});

const colonne = (props, id) => readCultureValue(props, getCultureColumn(id)) || null;

function renderTable(initialFeatures, { filtreVisible = null } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const state = { features: initialFeatures };
  const setFeatures = vi.fn((updater) => {
    state.features = typeof updater === "function" ? updater(state.features) : updater;
    render();
  });

  function render() {
    const visibles = filtreVisible ? state.features.filter(filtreVisible) : undefined;
    act(() => {
      root.render(
        <ParcelleEditor
          features={state.features}
          visibleFeatures={visibles}
          setFeatures={setFeatures}
          selectedId={null}
          onSelect={() => {}}
          mapRef={{ current: null }}
        />
      );
    });
  }

  render();
  return { container, root, state };
}

function clickButton(container, label) {
  const node = [...container.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === label
  );
  if (!node) throw new Error(`Bouton introuvable : ${label}`);
  act(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** Pilote un <select> ou un <input> React sans passer par les events synthétiques. */
function setValue(element, value) {
  const prototype =
    element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}

function selectOption(select, label) {
  const option = [...select.options].find((item) => item.textContent.trim() === label);
  if (!option) throw new Error(`Option introuvable : ${label}`);
  setValue(select, option.value);
}

/** Ouvre le dialogue « Déplacer cultures » et applique le déplacement demandé. */
function deplacerCultures(container, { de, vers = null, conserverSource = false }) {
  clickButton(container, "Déplacer cultures");
  const dialogSelects = () => [...container.querySelectorAll("select")].slice(-2);
  selectOption(dialogSelects()[0], de);
  if (vers) selectOption(dialogSelects()[1], vers);
  if (conserverSource) {
    const label = [...container.querySelectorAll("label")].find((node) =>
      node.textContent.includes("Conserver les données dans la colonne source")
    );
    const box = label?.querySelector("input[type=checkbox]");
    if (!box) throw new Error("Case « Conserver les données » introuvable");
    act(() => box.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }
  clickButton(container, vers ? "Déplacer" : "Supprimer");
}

/** Cellules de culture d'une ligne, dans l'ordre des colonnes affichées. */
const cellules = (container) =>
  [...container.querySelectorAll("tbody input[list]")].map((input) => input.value);

describe("ParcelleEditor — déplacement des colonnes de cultures", () => {
  let cleanup = null;

  afterEach(() => {
    if (cleanup) {
      act(() => cleanup.root.unmount());
      cleanup.container.remove();
      cleanup = null;
    }
  });

  it("déplace une culture importée sous l'alias Télépac (cultureN1)", () => {
    cleanup = renderTable([
      feature("p1", { cultureN: "BTH", cultureN1: "MIS", cultureN2: "ORH" }),
    ]);

    deplacerCultures(cleanup.container, { de: "Culture N-1", vers: "Culture N-2" });

    const props = cleanup.state.features[0].properties;
    expect(colonne(props, "current")).toBe("BTH");
    expect(colonne(props, "prev1")).toBeNull();
    expect(colonne(props, "prev2")).toBe("MIS");
  });

  it("déplace une culture importée sous l'alias shapefile (code_culture)", () => {
    cleanup = renderTable([
      feature("p1", { code_culture: "BTH", CP_CULTU: "BTH", culture_prec: "MIS" }),
    ]);

    deplacerCultures(cleanup.container, { de: "Culture N", vers: "Culture N-1" });

    const props = cleanup.state.features[0].properties;
    expect(colonne(props, "current")).toBeNull();
    expect(colonne(props, "prev1")).toBe("BTH");
  });

  it("laisse la destination intacte quand la source est vide", () => {
    cleanup = renderTable([
      feature("p1", { cultureN_1: "MIS", cultureN_2: "ORH" }),
      feature("p2", { cultureN_2: "TRN" }),
    ]);

    deplacerCultures(cleanup.container, { de: "Culture N-1", vers: "Culture N-2" });

    expect(colonne(cleanup.state.features[0].properties, "prev2")).toBe("MIS");
    expect(colonne(cleanup.state.features[1].properties, "prev2")).toBe("TRN");
  });

  it("supprime une colonne quand aucune destination n'est choisie", () => {
    cleanup = renderTable([feature("p1", { cultureN1: "MIS", cultureN: "BTH" })]);

    deplacerCultures(cleanup.container, { de: "Culture N-1" });

    const props = cleanup.state.features[0].properties;
    expect(colonne(props, "prev1")).toBeNull();
    expect(colonne(props, "current")).toBe("BTH");
  });

  it("conserve la source quand la case est cochée", () => {
    cleanup = renderTable([feature("p1", { cultureN1: "MIS" })]);

    deplacerCultures(cleanup.container, {
      de: "Culture N-1",
      vers: "Culture N-2",
      conserverSource: true,
    });

    const props = cleanup.state.features[0].properties;
    expect(colonne(props, "prev1")).toBe("MIS");
    expect(colonne(props, "prev2")).toBe("MIS");
  });

  it("ne touche pas aux parcelles masquées par un filtre", () => {
    cleanup = renderTable(
      [
        feature("p2025", { annee: 2025, cultureN1: "MIS" }),
        feature("p2024", { annee: 2024, cultureN1: "ORH" }),
      ],
      { filtreVisible: (f) => f.properties.annee === 2025 }
    );

    deplacerCultures(cleanup.container, { de: "Culture N-1", vers: "Culture N-2" });

    expect(colonne(cleanup.state.features[0].properties, "prev2")).toBe("MIS");
    // La parcelle 2024 n'était pas affichée : son historique est inchangé.
    expect(colonne(cleanup.state.features[1].properties, "prev1")).toBe("ORH");
    expect(colonne(cleanup.state.features[1].properties, "prev2")).toBeNull();
  });

  it("emporte l'interculture avec la culture de son année", () => {
    cleanup = renderTable([
      feature("p1", { cultureN: "MIS", interculture: "Ray-grass dérobée", cultureN_1: "BTH" }),
    ]);

    deplacerCultures(cleanup.container, { de: "Culture N-1", vers: "Culture N-2" });
    deplacerCultures(cleanup.container, { de: "Culture N", vers: "Culture N-1" });

    const props = cleanup.state.features[0].properties;
    expect(colonne(props, "prev1")).toBe("MIS");
    expect(readInterculture(props, "prev1")).toBe("Ray-grass dérobée");
    expect(readInterculture(props, "current")).toBe("");
    expect(colonne(props, "prev2")).toBe("BTH");
    expect(readInterculture(props, "prev2")).toBe("");
  });

  it("rafraîchit l'affichage du tableau après le déplacement", () => {
    cleanup = renderTable([feature("p1", { cultureN1: "MIS" })]);
    const avant = cellules(cleanup.container).filter(Boolean);
    expect(avant).toHaveLength(1);

    deplacerCultures(cleanup.container, { de: "Culture N-1", vers: "Culture N-2" });

    expect(cellules(cleanup.container).filter(Boolean)).toEqual(avant);
  });
});

describe("ParcelleEditor — saisie d'une culture", () => {
  let cleanup = null;

  afterEach(() => {
    if (cleanup) {
      act(() => cleanup.root.unmount());
      cleanup.container.remove();
      cleanup = null;
    }
  });

  it("enregistre un libellé libre absent du codebook", () => {
    cleanup = renderTable([feature("p1")]);
    const cellule = cleanup.container.querySelector("tbody input[list]");

    setValue(cellule, "Luzerne porte-graine");

    const props = cleanup.state.features[0].properties;
    expect(colonne(props, "next1")).toBe("Luzerne porte-graine");
  });

  it("ne laisse pas de résidu quand la saisie se poursuit", () => {
    cleanup = renderTable([feature("p1")]);
    const cellule = cleanup.container.querySelector("tbody input[list]");

    // « Bl » ressemble à un code et était écrit tel quel ; la suite de la frappe
    // ne le remplaçait pas, la parcelle gardait « BL ».
    setValue(cellule, "Bl");
    setValue(cellule, "Blé de printemps maison");

    expect(colonne(cleanup.state.features[0].properties, "next1")).toBe(
      "Blé de printemps maison"
    );
  });

  it("vide la colonne quand la cellule est effacée", () => {
    cleanup = renderTable([feature("p1", { cultureN_plus1: "MIS" })]);
    const cellule = cleanup.container.querySelector("tbody input[list]");

    setValue(cellule, "");

    expect(colonne(cleanup.state.features[0].properties, "next1")).toBeNull();
  });
});
