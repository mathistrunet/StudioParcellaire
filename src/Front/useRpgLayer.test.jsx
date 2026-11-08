// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Le composant crée des popups MapLibre : on les remplace par une coquille qui
// retient l'élément DOM, ce qui permet de cliquer « Importer cette parcelle ».
let dernierePopup = null;
vi.mock("../services/maplibre", () => {
  class Popup {
    setLngLat() { return this; }
    setHTML() { return this; }
    setDOMContent(el) { this.el = el; dernierePopup = this; return this; }
    addTo() { return this; }
    remove() { return this; }
  }
  return { default: { Popup } };
});

vi.mock("../services/rpg", () => ({
  fetchRpgGeoJSON: vi.fn(async () => ({ type: "FeatureCollection", features: [] })),
  getCultureLabel: () => ({ label: "Blé tendre", code: "BTH" }),
  getMapBoundsCRS84: () => [1, 43, 2, 44],
}));

const { default: RpgFeature } = await import("./useRpgLayer");

/** Carte factice : retient les gestionnaires posés par couche et la visibilité. */
function makeMap() {
  const handlers = new Map();
  const sources = new Set();
  const layers = new Set();
  const visibility = {};
  return {
    handlers,
    visibility,
    getStyle: () => ({ layers: [] }),
    isStyleLoaded: () => true,
    getZoom: () => 13,
    getCanvas: () => ({ style: {} }),
    getSource: (id) => (sources.has(id) ? { setData() {} } : undefined),
    addSource: (id) => sources.add(id),
    getLayer: (id) => (layers.has(id) ? { id } : undefined),
    addLayer: (def) => layers.add(def.id),
    setLayoutProperty: (id, prop, value) => {
      if (prop === "visibility") visibility[id] = value;
    },
    on: (event, layerOrHandler, maybeHandler) => {
      const key = maybeHandler ? `${event}:${layerOrHandler}` : event;
      handlers.set(key, maybeHandler || layerOrHandler);
    },
    off: () => {},
    once: (event, handler) => handlers.set(`once:${event}`, handler),
  };
}

const rpgFeature = {
  geometry: { type: "Polygon", coordinates: [[[1, 43], [1.1, 43], [1.1, 43.1], [1, 43]]] },
  properties: { NUMERO: "42" },
};

function render({ onImported } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const map = makeMap();
  const draw = { add: vi.fn() };
  act(() => {
    root.render(
      <RpgFeature mapRef={{ current: map }} drawRef={{ current: draw }} onImported={onImported} />
    );
  });
  return { container, root, map, draw };
}

/** Active la couche, puis déclenche un clic sur une parcelle RPG. */
async function importerUneParcelle(vue) {
  const caseAcocher = vue.container.querySelector('input[type="checkbox"]');
  await act(async () => {
    caseAcocher.click();
  });
  const onClick = vue.map.handlers.get("click:rpg_fill");
  expect(onClick, "gestionnaire de clic posé sur la couche RPG").toBeTypeOf("function");
  act(() => {
    onClick({ features: [rpgFeature], lngLat: { lng: 1.05, lat: 43.05 } });
  });
  act(() => {
    dernierePopup.el.querySelector("#btn-import-rpg").click();
  });
}

describe("RpgFeature — import d'une parcelle", () => {
  let vue;

  beforeEach(() => {
    dernierePopup = null;
  });

  afterEach(() => {
    if (vue) {
      act(() => vue.root.unmount());
      vue.container.remove();
      vue = null;
    }
  });

  it("signale l'import pour que la liste se rafraîchisse", async () => {
    const onImported = vi.fn();
    vue = render({ onImported });
    await importerUneParcelle(vue);

    expect(vue.draw.add).toHaveBeenCalledTimes(1);
    // Sans ce signal, draw.add() n'émettant aucun évènement, la parcelle
    // n'apparaîtrait dans la liste qu'au prochain déplacement d'une autre.
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("retient le millésime sélectionné, pas celui du premier rendu", async () => {
    vue = render({});
    const select = vue.container.querySelector("select");
    await act(async () => {
      select.value = "2019";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await importerUneParcelle(vue);

    expect(vue.draw.add.mock.calls[0][0].properties.annee).toBe(2019);
  });

  it("masque la couche quand le panneau est quitté", async () => {
    vue = render({});
    const caseAcocher = vue.container.querySelector('input[type="checkbox"]');
    await act(async () => {
      caseAcocher.click();
    });
    expect(vue.map.visibility.rpg_fill).toBe("visible");

    act(() => vue.root.unmount());
    // Sinon les polygones RPG restaient affichés et cliquables sur la vue
    // Parcelles, au risque d'un import involontaire.
    expect(vue.map.visibility.rpg_fill).toBe("none");
    expect(vue.map.visibility.rpg_line).toBe("none");

    vue.container.remove();
    vue = null;
  });
});
