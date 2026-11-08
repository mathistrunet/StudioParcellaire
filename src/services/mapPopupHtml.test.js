// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  parcellePopupHtml,
  rpgHoverPopupHtml,
  rpgImportPopupHtml,
  soilGridsPixelPopupHtml,
} from "./mapPopupHtml";

const PIEGE = `<img src=x onerror="alert(1)"><script>alert('2')</script>`;

/** Analyse le HTML comme le feront setHTML et innerHTML. */
const parse = (html) => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};

const expectInert = (el) => {
  expect(el.querySelector("img, script, [onerror]")).toBeNull();
  expect(el.textContent).toContain(PIEGE);
};

describe("escapeHtml", () => {
  it("neutralise les caractères actifs du HTML", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;"
    );
  });

  it("garde les accents et les valeurs ordinaires", () => {
    expect(escapeHtml("Blé tendre — N° 12")).toBe("Blé tendre — N° 12");
  });

  it("accepte les nombres et les valeurs absentes", () => {
    expect(escapeHtml(0)).toBe("0");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("parcellePopupHtml", () => {
  it("affiche une valeur piégée comme du texte", () => {
    expectInert(parse(parcellePopupHtml([PIEGE, `Culture : ${PIEGE}`])));
  });

  it("place une valeur par ligne et ignore les absentes", () => {
    const el = parse(parcellePopupHtml(["Parcelle A", null, "Culture : Blé"]));
    expect(el.querySelectorAll("br")).toHaveLength(1);
    expect(el.textContent).toBe("Parcelle ACulture : Blé");
  });
});

describe("popups RPG", () => {
  it("échappe le libellé de survol", () => {
    const el = parse(rpgHoverPopupHtml(PIEGE));
    expectInert(el);
    expect(el.querySelector("strong").textContent).toBe(PIEGE);
  });

  it("échappe le titre du clic et conserve le bouton d'import", () => {
    const el = parse(rpgImportPopupHtml(PIEGE, "btn-import-rpg"));
    expectInert(el);
    expect(el.querySelector("#btn-import-rpg").textContent).toContain("Importer cette parcelle");
  });
});

describe("soilGridsPixelPopupHtml", () => {
  it("échappe l'identifiant et la position du pixel", () => {
    expectInert(parse(soilGridsPixelPopupHtml({ pixelId: PIEGE, row: PIEGE, col: PIEGE })));
  });

  it("conserve le titre en gras et les coordonnées", () => {
    const el = parse(
      soilGridsPixelPopupHtml({ row: 0, col: 3, center: [1.5, 43.25], bbox: [1, 43, 2, 44] })
    );
    expect(el.querySelector("strong").textContent).toBe("Pixel SoilGrids");
    expect(el.textContent).toContain("Ligne / colonne : 0 / 3");
    expect(el.textContent).toContain("Centre : 43.250000, 1.500000");
    expect(el.textContent).toContain("BBox : 1.000000, 43.000000, 2.000000, 44.000000");
  });
});
