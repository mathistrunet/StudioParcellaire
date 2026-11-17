import { describe, it, expect } from "vitest";
import { ighForward, ighInverse, soilGridsPixel, soilGridsPixelKey } from "./homolosine.mjs";

// Bords de pixels RÉELS relevés sur l'API ISRIC par bissection (changement de valeur), servant
// de vérité terrain. La grille du module doit voir son index changer en franchissant chaque bord.
const COL_EDGES = [
  [2.502412, 46.0],
  [2.501237, 43.0],
  [2.500537, 49.0],
  [2.502431, 44.5],
  [2.500819, 47.5],
  [25.000206, 45.0],
  [10.000106, 46.5],
];
const ROW_EDGES = [
  [2.5, 46.001512],
  [25.0, 46.001512],
  [10.0, 47.000029],
  [25.0, 45.000393],
];

const E = 0.0002; // ~15 m : marge couvrant l'écart résiduel (~1 m) entre modèle et ISRIC

describe("soilGridsPixel — alignement sur la grille native SoilGrids", () => {
  it("change de colonne en franchissant chaque bord vertical observé sur ISRIC", () => {
    for (const [lon, lat] of COL_EDGES) {
      const a = soilGridsPixel(lon - E, lat).col;
      const b = soilGridsPixel(lon + E, lat).col;
      expect(b - a, `bord colonne @(${lon},${lat})`).toBe(1);
    }
  });

  it("change de ligne en franchissant chaque bord horizontal observé sur ISRIC", () => {
    for (const [lon, lat] of ROW_EDGES) {
      const a = soilGridsPixel(lon, lat - E).row;
      const b = soilGridsPixel(lon, lat + E).row;
      // Y décroît quand la latitude augmente : l'index de ligne diminue de 1.
      expect(a - b, `bord ligne @(${lon},${lat})`).toBe(1);
    }
  });
});

describe("ighForward / ighInverse — projection EPSG:152160 complète", () => {
  const MINX = -19949750;
  const MAXY = 8361000;

  it("retrouve la valeur de référence de PROJ (builtins.gie, +a=6400000)", () => {
    const scale = 6378137 / 6400000;
    const [x, y] = ighForward(2, 1);
    expect(x).toBeCloseTo(223878.497456 * scale, 3);
    expect(y).toBeCloseTo(111701.072127 * scale, 3);
  });

  it("revient au point de départ sur la France, la Roumanie et tous les lobes", () => {
    const points = [
      [2.35, 48.85], [-1.55, 47.2], [7.75, 48.58], [5.37, 43.3], [-4.5, 48.4], [9.2, 41.9], // France
      [26.1, 44.43], [23.6, 46.77], [28.65, 44.17], // Roumanie
      [-100, 40.8], [-120, 60], [100, 70], [-70, 20], [100, 10], // lobes nord
      [-160, -60], [-60, -15], [20, -30], [140, -60], [-110, -50], [170, -10], // lobes sud
      [30, 40.7366], [30, 40.7367], [0, 0], [179.9, 85], [-179.9, -85],
    ];
    for (const [lon, lat] of points) {
      const [x, y] = ighForward(lon, lat);
      const back = ighInverse(x, y);
      expect(back[0], `lon (${lon}, ${lat})`).toBeCloseTo(lon, 8);
      expect(back[1], `lat (${lon}, ${lat})`).toBeCloseTo(lat, 8);
    }
  });

  it("reste continue à la bascule sinusoïdale/Mollweide", () => {
    const below = ighForward(10, 40.73661);
    const above = ighForward(10, 40.73662);
    expect(Math.hypot(above[0] - below[0], above[1] - below[1])).toBeLessThan(2);
  });

  it("renvoie null dans les interruptions de la carte et hors de la Terre", () => {
    expect(ighInverse(-40.5 * (Math.PI / 180) * 6378137, 7000000)).toBeNull(); // nord Atlantique
    expect(ighInverse(0, 9000000)).toBeNull();
    expect(ighInverse(NaN, 0)).toBeNull();
    expect(ighForward(181, 0)).toBeNull();
    expect(ighForward(0, 91)).toBeNull();
  });

  it("place les bords mesurés sur ISRIC sur des bords de la grille WCS", () => {
    // Écart toléré : 0.02 pixel, soit 5 m (imprécision de la bissection et de la mesure).
    const distanceToEdge = (value) => Math.abs(value - Math.round(value));
    for (const [lon, lat] of COL_EDGES) {
      const [x] = ighForward(lon, lat);
      expect(distanceToEdge((x - MINX) / 250), `colonne @(${lon},${lat})`).toBeLessThan(0.02);
    }
    for (const [lon, lat] of ROW_EDGES) {
      const [, y] = ighForward(lon, lat);
      expect(distanceToEdge((MAXY - y) / 250), `ligne @(${lon},${lat})`).toBeLessThan(0.02);
    }
  });
});

describe("soilGridsPixelKey — déduplication par pixel", () => {
  it("regroupe les points d'un même pixel ~250 m et sépare les pixels voisins", () => {
    const center = [2.5012, 46.0009];
    const sameKey = [
      [0, 0],
      [0.0004, 0],
      [-0.0004, 0],
      [0, 0.0003],
      [0, -0.0003],
    ].map(([dx, dy]) => soilGridsPixelKey(center[0] + dx, center[1] + dy));
    expect(new Set(sameKey).size).toBe(1);
    // Un point clairement dans le pixel voisin (~1 km à l'est) a une clé différente.
    expect(soilGridsPixelKey(center[0] + 0.013, center[1])).not.toBe(sameKey[0]);
  });

  it("renvoie null hors du domaine validé (repli amont sur clé arrondie)", () => {
    expect(soilGridsPixelKey(-47, -15)).toBeNull(); // Brésil (hémisphère sud)
    expect(soilGridsPixelKey(2.5, 39)).toBeNull(); // sous la bascule sinusoïdale/Mollweide
  });
});
