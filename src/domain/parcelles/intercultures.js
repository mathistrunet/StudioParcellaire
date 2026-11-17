// src/domain/parcelles/intercultures.js
//
// Intercultures (culture intermédiaire, dérobée, couvert), une par année de
// culture : N+1, N, N-1 … N-6, comme les colonnes de cultures.
//
// Une interculture occupe la même parcelle que la culture principale de la même
// campagne, avant ou après elle. Ce n'est donc pas une parcelle de plus mais une
// valeur de la parcelle, rangée à côté de la culture de son année.
//
// Pourquoi ce module : Geofolia exporte chaque culture d'une campagne comme une
// parcelle à part. Sa seconde culture (souvent « Ray-grass dérobée », parfois une
// prairie temporaire ou un colza implanté derrière une orge de printemps) arrive
// avec TYPE_PARC = « Parcelle secondaire » et exactement le même contour que la
// parcelle principale. Importées telles quelles, ces lignes posaient une parcelle
// sur une autre. On les replie donc sur leur parcelle principale à l'import.

// Le module ESM de polygon-clipping n'a qu'un export par défaut.
import polygonClipping from "polygon-clipping";
import { CULTURE_COLUMNS, getCultureColumn, readCultureValue } from "./cultureColumns";

const clipIntersection = polygonClipping.intersection;

// Clés d'une interculture selon le décalage d'années de sa colonne de culture.
// N garde `interculture` (et `INTERCULT` pour le shapefile) et lit aussi les
// champs Geofolia de culture intermédiaire principale / secondaire.
function keysForOffset(offset) {
  if (offset === 0) {
    return {
      writeKeys: ["interculture", "INTERCULT"],
      readKeys: [
        "interculture", "INTERCULT", "interculture_n", "culture_intermediaire",
        "CIP_CULTU", "cip_cultu", "CIS_CULTU", "cis_cultu",
      ],
    };
  }
  if (offset > 0) {
    return {
      writeKeys: [`interculture_n_plus${offset}`],
      readKeys: [`interculture_n_plus${offset}`, `interculture_nplus${offset}`],
    };
  }
  const k = -offset;
  return {
    writeKeys: [`interculture_n${k}`],
    readKeys: [`interculture_n${k}`, `interculture_n_${k}`, `INTERCULT${k}`],
  };
}

/**
 * Colonnes d'interculture, dans l'ordre des colonnes de cultures. `cultureId` est
 * l'identifiant de la colonne de culture de la même année (`current`, `prev1`…).
 */
export const INTERCULTURE_COLUMNS = CULTURE_COLUMNS.map((col) => ({
  id: col.id === "current" ? "interculture" : `interculture_${col.id}`,
  cultureId: col.id,
  offset: col.offset,
  label: col.label.replace(/^Culture/, "Interculture"),
  ...keysForOffset(col.offset),
}));

const BY_CULTURE_ID = new Map(INTERCULTURE_COLUMNS.map((col) => [col.cultureId, col]));
const BY_ID = new Map(INTERCULTURE_COLUMNS.map((col) => [col.id, col]));

/** Colonne d'interculture d'une colonne de culture (`current`, `prev1`…) ou par son propre id. */
export const getIntercultureColumn = (id = "current") => BY_CULTURE_ID.get(id) ?? BY_ID.get(id) ?? null;

const SEPARATEUR = " + ";

// Les .dbf complètent parfois un champ vide par des octets nuls.
const clean = (value) => (value == null ? "" : String(value).replaceAll("\u0000", "").trim());

/**
 * Interculture d'une année (`current` par défaut), `""` si aucune. Deux
 * intercultures lues sous des clés différentes sont jointes par « + ».
 */
export function readInterculture(props = {}, cultureId = "current") {
  const column = getIntercultureColumn(cultureId);
  if (!column) return "";
  const values = [];
  for (const key of column.readKeys) {
    const value = clean(props?.[key]);
    if (!value) continue;
    // Une clé écrite porte déjà la valeur complète : les autres n'en sont que des copies.
    if (column.writeKeys.includes(key)) return value;
    if (!values.includes(value)) values.push(value);
  }
  return values.join(SEPARATEUR);
}

/** Valeur brute telle que saisie (espace finale comprise), pour un champ de saisie. */
export function readIntercultureInput(props = {}, cultureId = "current") {
  const column = getIntercultureColumn(cultureId);
  const raw = column ? props?.[column.writeKeys[0]] : null;
  return raw != null ? String(raw) : readInterculture(props, cultureId);
}

/**
 * Écrit (ou efface, si vide) l'interculture d'une année. Retourne un nouvel objet
 * de propriétés. Le texte n'est pas rogné : la saisie au clavier doit pouvoir
 * finir par une espace.
 */
export function setInterculture(props = {}, value, cultureId = "current") {
  const next = { ...(props || {}) };
  const column = getIntercultureColumn(cultureId);
  if (!column) return next;
  column.readKeys.forEach((key) => { delete next[key]; });
  const text = value == null ? "" : String(value);
  if (text.trim()) column.writeKeys.forEach((key) => { next[key] = text; });
  return next;
}

const sansAccent = (text) =>
  clean(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Vrai si le libellé désigne une culture intermédiaire : dérobée, CIPAN, CIVE,
 * couvert, interculture, culture intermédiaire.
 */
export function isIntercultureLabel(label) {
  const text = sansAccent(label);
  if (!text) return false;
  return /\bderobee?s?\b|\bcipan\b|\bcive\b|\binterculture|culture intermediaire|\bcouverts?\b|engrais vert/.test(text);
}

/** Vrai pour une « Parcelle secondaire » de Geofolia (seconde culture de la campagne). */
export function isSecondaryParcel(props = {}) {
  const type = sansAccent(props?.TYPE_PARC ?? props?.type_parc ?? props?.type_parcelle);
  return type.includes("secondaire");
}

// ─── Repli des parcelles secondaires ─────────────────────────────────────────

function polygonsOf(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

// Aire plane dans l'unité des coordonnées : seuls des rapports d'aires sont
// calculés, la projection (degrés ou mètres) n'a donc pas d'importance.
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

function multiPolygonArea(polygons) {
  return polygons.reduce(
    (total, rings) =>
      total + (rings || []).reduce((acc, ring, i) => acc + (i === 0 ? 1 : -1) * ringArea(ring || []), 0),
    0
  );
}

function bbox(polygons) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  polygons.forEach((rings) => (rings?.[0] || []).forEach(([x, y]) => {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }));
  return box;
}

const boxesTouch = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

function shapeOf(feature) {
  const polygons = polygonsOf(feature?.geometry);
  return { polygons, area: multiPolygonArea(polygons), box: bbox(polygons) };
}

/** Part de chacune des deux surfaces couverte par l'autre, de 0 à 1. */
function mutualOverlap(a, b) {
  if (!clipIntersection || !a.area || !b.area || !boxesTouch(a.box, b.box)) return 0;
  let inter;
  try {
    inter = multiPolygonArea(clipIntersection(a.polygons, b.polygons));
  } catch {
    return 0;
  }
  return Math.min(inter / a.area, inter / b.area);
}

const cultureN = (props) => readCultureValue(props, getCultureColumn("current"));

/**
 * Replie chaque seconde culture d'une parcelle sur sa parcelle principale.
 *
 * Une parcelle est candidate si c'est une « Parcelle secondaire » (Geofolia) ou si
 * sa culture N est une interculture. Elle est repliée sur la parcelle non
 * candidate dont le contour se confond avec le sien (chacune couverte à
 * `seuil` au moins par l'autre) : sa culture devient l'interculture de cette
 * parcelle et elle disparaît de la liste. Sans parcelle hôte, elle reste telle
 * quelle : une dérobée seule est une parcelle comme une autre.
 *
 * @returns {{ features: Array, replies: number }}
 */
export function foldSecondaryParcels(features, { seuil = 0.9 } = {}) {
  const list = Array.isArray(features) ? features : [];
  const candidate = list.map((f) => {
    const props = f?.properties || {};
    return isSecondaryParcel(props) || isIntercultureLabel(cultureN(props));
  });
  if (!candidate.some(Boolean)) return { features: list, replies: 0 };

  const shapes = list.map(shapeOf);
  const hosts = list.map((_, i) => i).filter((i) => !candidate[i] && shapes[i].area > 0);
  const additions = new Map(); // indice de l'hôte -> intercultures à ajouter
  const removed = new Set();

  list.forEach((feature, i) => {
    if (!candidate[i]) return;
    const culture = cultureN(feature?.properties || {});
    if (!culture) return;
    let best = -1;
    let bestScore = seuil;
    for (const h of hosts) {
      const score = mutualOverlap(shapes[i], shapes[h]);
      if (score >= bestScore) {
        best = h;
        bestScore = score;
      }
    }
    if (best < 0) return;
    if (!additions.has(best)) additions.set(best, []);
    additions.get(best).push(culture);
    removed.add(i);
  });

  if (!removed.size) return { features: list, replies: 0 };

  const out = [];
  list.forEach((feature, i) => {
    if (removed.has(i)) return;
    const extra = additions.get(i);
    if (!extra) {
      out.push(feature);
      return;
    }
    const props = feature.properties || {};
    const values = readInterculture(props).split(SEPARATEUR).map(clean).filter(Boolean);
    extra.forEach((value) => { if (!values.includes(value)) values.push(value); });
    out.push({ ...feature, properties: setInterculture(props, values.join(SEPARATEUR)) });
  });
  return { features: out, replies: removed.size };
}
