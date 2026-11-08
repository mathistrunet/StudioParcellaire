// Grille native SoilGrids 2.0 — projection Interrupted Goode Homolosine (EPSG:152160).
//
// SoilGrids échantillonne ses valeurs sur une grille régulière de 250 m DANS la projection
// Homolosine, pas en lon/lat. Deux points tombant dans le même pixel renvoient donc des
// données identiques. Ce module mappe (lon, lat) -> (col, row) du pixel SoilGrids afin de
// dédupliquer les requêtes : toutes les parcelles d'un même pixel partagent un seul appel ISRIC.
//
// Domaine d'application : France + Roumanie (hémisphère nord, latitude > 40.74° -> demi-zone
// Mollweide de la homolosine, lobe est-eurasien de méridien central 30°). Hors de ce domaine,
// soilGridsPixel() renvoie null et l'appelant retombe sur une clé arrondie classique.
//
// Constantes calées et VALIDÉES empiriquement contre l'API ISRIC (rest.isric.org) en cherchant
// les bords de pixels réels (changements de valeur) par bissection, aux latitudes 43/44.5/46/
// 47.5/49 et longitudes 2.5→25. À lam0 = 30° (valeur standard de Goode), le résidu de phase est
// constant à −0.340 pixel avec une dispersion de seulement ±0.003 pixel (~0.8 m) sur tous les
// points testés ; cette phase est absorbée par COL_PHASE/ROW_PHASE. proj4 n'implémente pas `igh`,
// d'où cette implémentation Mollweide directe.

const R = 6378137; // rayon de la sphère igh (= demi-grand axe WGS84)
const KX = (2 * Math.SQRT2) / Math.PI; // facteur d'échelle X de Mollweide
const PX = 250; // taille de pixel SoilGrids (m)
const MINX = -19949750; // origine X de la grille (WCS DescribeCoverage)
const MAXY = 8361000; // origine Y de la grille (WCS DescribeCoverage)
const LAM0 = 30; // méridien central du lobe nord-est (°)
const PHI_BOUNDARY = 40 + 44 / 60 + 11.8 / 3600; // 40.7366° : bascule sinusoïdale/Mollweide
const COL_PHASE = 0.3394; // phase X de la grille (constante, scatter ±0.8 m ; calage ISRIC)
const ROW_PHASE = 0.1568; // offset Homolosine Yc ramené modulo pixel (calage ISRIC)
const D2R = Math.PI / 180;

// Domaine validé (France + Roumanie avec marge). Hors domaine -> grille non garantie.
const inDomain = (lon, lat) => lat >= PHI_BOUNDARY && lat <= 60 && lon >= -20 && lon <= 45;

// Angle auxiliaire de Mollweide : résout 2θ + sin2θ = π·sin(φ) par Newton.
const mollweideAux = (phiRad) => {
  if (Math.abs(phiRad) >= Math.PI / 2 - 1e-9) return Math.sign(phiRad) * (Math.PI / 2);
  let t = phiRad;
  for (let i = 0; i < 60; i += 1) {
    const delta = (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(phiRad)) / (2 + 2 * Math.cos(2 * t));
    t -= delta;
    if (Math.abs(delta) < 1e-13) break;
  }
  return t;
};

/**
 * Pixel SoilGrids (col, row) contenant (lon, lat), ou null hors du domaine validé.
 * Les bords de pixels coïncident avec ceux d'ISRIC à quelques mètres près.
 */
export function soilGridsPixel(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inDomain(lon, lat)) return null;
  const t = mollweideAux(lat * D2R);
  const x = R * KX * ((lon - LAM0) * D2R) * Math.cos(t);
  const y = R * Math.SQRT2 * Math.sin(t);
  const col = Math.floor((x - MINX) / PX + COL_PHASE);
  const row = Math.floor((MAXY - y) / PX + ROW_PHASE);
  return { col, row };
}

/**
 * Clé de déduplication par pixel SoilGrids, ou null hors domaine (repli amont sur clé arrondie).
 */
export function soilGridsPixelKey(lon, lat) {
  const pixel = soilGridsPixel(lon, lat);
  return pixel ? `igh:${pixel.col}:${pixel.row}` : null;
}

// --- Projection complète (aller et retour), pour tracer la grille ---
//
// Mêmes formules et mêmes lobes que `+proj=igh` de PROJ, sur toute la Terre. Contrairement à
// soilGridsPixel(), les coordonnées obtenues sont les vraies coordonnées EPSG:152160 du raster :
// aucun calage n'y entre. Les phases COL_PHASE/ROW_PHASE ci-dessus ne sont d'ailleurs que le reste,
// modulo un pixel, des décalages de lobe x0 et DY0 ci-dessous (0.3389 et 0.1525). soilGridsPixel()
// reste inchangée : ses index, décalés de ces mêmes valeurs, servent de clés de déduplication.

const NORTH_LOBES = [
  { lam0: -100, minLon: -180, maxLon: -40 },
  { lam0: 30, minLon: -40, maxLon: 180 },
];
const SOUTH_LOBES = [
  { lam0: -160, minLon: -180, maxLon: -100 },
  { lam0: -60, minLon: -100, maxLon: -20 },
  { lam0: 20, minLon: -20, maxLon: 80 },
  { lam0: 140, minLon: 80, maxLon: 180 },
];
const PHI_BOUNDARY_RAD = PHI_BOUNDARY * D2R;
// Décalage (sphère unité) qui raccorde le Mollweide des hautes latitudes au sinusoïdal.
const DY0 = PHI_BOUNDARY_RAD - Math.SQRT2 * Math.sin(mollweideAux(PHI_BOUNDARY_RAD));
const LON_EPS = 1e-9;

/** (lon, lat) en degrés -> (x, y) EPSG:152160 en mètres, ou null hors de la Terre. */
export function ighForward(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  const lobe = (lat >= 0 ? NORTH_LOBES : SOUTH_LOBES).find(({ maxLon }) => lon <= maxLon);
  const phi = lat * D2R;
  const lam = (lon - lobe.lam0) * D2R;
  const x0 = lobe.lam0 * D2R;
  if (Math.abs(lat) >= PHI_BOUNDARY) {
    const t = mollweideAux(phi);
    return [R * (x0 + KX * lam * Math.cos(t)), R * (Math.SQRT2 * Math.sin(t) + Math.sign(lat) * DY0)];
  }
  return [R * (x0 + lam * Math.cos(phi)), R * phi];
}

/** (x, y) EPSG:152160 en mètres -> (lon, lat) en degrés, ou null dans une interruption de la carte. */
export function ighInverse(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const xUnit = x / R;
  const yUnit = y / R;
  const lobes = yUnit >= 0 ? NORTH_LOBES : SOUTH_LOBES;
  const lobe = lobes.find(({ maxLon }) => xUnit <= maxLon * D2R) ?? lobes[lobes.length - 1];
  const dx = xUnit - lobe.lam0 * D2R;

  let phi;
  let lam;
  if (Math.abs(yUnit) >= PHI_BOUNDARY_RAD) {
    const sinT = (yUnit - Math.sign(yUnit) * DY0) / Math.SQRT2;
    if (Math.abs(sinT) > 1) return null;
    const t = Math.asin(sinT);
    phi = Math.asin((2 * t + Math.sin(2 * t)) / Math.PI);
    lam = Math.abs(Math.cos(t)) < 1e-12 ? 0 : dx / (KX * Math.cos(t));
  } else {
    phi = yUnit;
    lam = dx / Math.cos(phi);
  }

  const lon = lam / D2R + lobe.lam0;
  if (lon < lobe.minLon - LON_EPS || lon > lobe.maxLon + LON_EPS) return null;
  return [lon, phi / D2R];
}

export const __testing = { soilGridsPixel, R, PX, MINX, MAXY, LAM0 };
