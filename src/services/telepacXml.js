// src/services/telepacXml.js
import { toLambert93, toWgs84 } from "../utils/proj";
import { resolvePrecisionForCode, splitCultureKey } from "../utils/cultureLabels";
import { ringToGml, ringAreaM2 } from "../utils/geometry";
import { telepacMesParcellesImporter } from "../lib/importers";

function normalizeNumero(value) {
  return value == null ? "" : String(value).trim();
}

function normalizeDigits(value) {
  return normalizeNumero(value).replace(/\D/g, "");
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isTruthyBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "oui";
  }
  return false;
}

function normalizeBooleanAttribute(value, fallback = false) {
  const resolved = isTruthyBoolean(value);
  if (resolved) return "true";
  if (value === false || value === 0 || value === "false" || value === "0") return "false";
  return fallback ? "true" : "false";
}

function getBooleanProp(props, keys, fallback = false) {
  for (const key of keys) {
    const value = props?.[key];
    if (value == null) continue;
    return normalizeBooleanAttribute(value, fallback);
  }
  return fallback ? "true" : "false";
}

function firstProperty(props, keys) {
  for (const key of keys) {
    const value = props?.[key];
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function inferProducerMeta(features) {
  const firstProps = features?.[0]?.properties || {};
  const pacage =
    normalizeDigits(
      firstProperty(firstProps, [
        "code_exploitation",
        "pacage",
        "numero_pacage",
        "numero-pacage",
      ])
    ) || "000000000";
  return {
    pacage,
    siret: firstProperty(firstProps, ["siret", "SIRET"]),
    exploitation: firstProperty(firstProps, ["exploitation", "nom_exploitation"]),
    email: firstProperty(firstProps, ["courriel", "email", "mail"]),
    communeSiege: normalizeDigits(
      firstProperty(firstProps, ["code_insee", "commune", "insee", "codeCommune"])
    ),
  };
}

function normalizeIlotReference(raw, pacage, ilotNumero) {
  const digits = normalizeDigits(raw);
  if (digits.length >= 12) return digits.slice(0, 12);
  const pac = normalizeDigits(pacage).padEnd(9, "0").slice(0, 9);
  const suffix = String(ilotNumero ?? "1").replace(/\D/g, "").padStart(3, "0").slice(-3);
  return `${pac}${suffix}`.padEnd(12, "0").slice(0, 12);
}

function readCultureCodeFromProperty(props, cultureColumn) {
  if (cultureColumn) {
    const value = props?.[cultureColumn];
    if (value != null && String(value).trim()) {
      return normalizeNumero(value).toUpperCase();
    }
  }
  const fallback = firstProperty(props, [
    "culture",
    "cultureN",
    "code_culture",
    "code",
    "CODE_CULTURE",
  ]);
  return normalizeNumero(fallback).toUpperCase();
}

function resolvePrecisionKeyForCultureColumn(cultureColumn) {
  const normalized = normalizeNumero(cultureColumn).toLowerCase();
  if (!normalized) return "precision";

  if (normalized.includes("plus1") || normalized.includes("+1")) {
    return "precision_n_plus1";
  }

  const precMatch = normalized.match(/prec(?:_|-)?(\d+)/);
  if (precMatch) {
    return `precision_n${precMatch[1]}`;
  }

  const nMatch = normalized.match(/n(?:_|-)?(\d+)/);
  if (nMatch) {
    return `precision_n${nMatch[1]}`;
  }

  if (
    normalized === "culture" ||
    normalized === "culturen" ||
    normalized === "culturen0" ||
    normalized === "culturen_0" ||
    normalized === "code" ||
    normalized === "code_culture"
  ) {
    return "precision";
  }

  return "precision";
}

function getFirstOuterRing(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  if (geom.type === "Polygon") return geom.coordinates?.[0] || null;
  if (geom.type === "MultiPolygon") return geom.coordinates?.[0]?.[0] || null;
  return null;
}

function getAllOuterRings(feature) {
  const geom = feature?.geometry;
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates?.[0] ? [geom.coordinates[0]] : [];
  if (geom.type === "MultiPolygon") {
    return (geom.coordinates || []).map((poly) => poly?.[0]).filter(Boolean);
  }
  return [];
}

export function buildTelepacXML(features, options = {}) {
  const NS = "urn:x-telepac:fr.gouv.agriculture.telepac:echange-producteur";
  const GML = "http://www.opengis.net/gml";
  const esc = (s) => xmlEscape(s);
  const cultureColumn = normalizeNumero(options.cultureColumn);

  const safeFeatures = Array.isArray(features) ? features : [];
  const meta = inferProducerMeta(safeFeatures);

  if (!safeFeatures.length) {
    return `<?xml version="1.0" encoding="ISO-8859-1"?>
` +
      `<producteurs xmlns="${NS}" xmlns:gml="${GML}">` +
      `<producteur numero-pacage="${esc(meta.pacage)}" campagne="Courante" fichier-xsd="Echanges-producteur-export-2025-V1">` +
      `<demandeur certificat-environnemental="false" dossier-sans-demande-aides="false"></demandeur>` +
      `<rpg></rpg>` +
      `</producteur></producteurs>`;
  }

  const globalCommune =
    normalizeDigits(
      firstProperty(safeFeatures[0]?.properties || {}, [
        "code_insee",
        "commune",
        "insee",
        "codeCommune",
      ])
    ) ||
    meta.communeSiege ||
    "00000";

  const ilotsByNumero = new Map();
  let autoNumero = 1;
  safeFeatures.forEach((feature, index) => {
    const props = feature?.properties || {};
    const ilotNumero = normalizeNumero(props.ilot_numero || props.ilot || "1") || "1";
    const rawNumero = normalizeNumero(props.numero || props.parcelle || "");
    const numero = rawNumero !== "" ? rawNumero : String(autoNumero++);
    const list = ilotsByNumero.get(ilotNumero) || [];
    list.push({ feature, index, numero });
    ilotsByNumero.set(ilotNumero, list);
  });

  const orderedIlots = Array.from(ilotsByNumero.entries())
    .map(([numero, parcelles]) => ({ numero, parcelles }))
    .sort((a, b) => Number(a.numero) - Number(b.numero));

  let xml = `<?xml version="1.0" encoding="ISO-8859-1"?>
`;
  xml += `<producteurs xmlns="${NS}" xmlns:gml="${GML}">`;
  xml += `<producteur numero-pacage="${esc(meta.pacage)}" campagne="Courante" fichier-xsd="Echanges-producteur-export-2025-V1">`;
  xml += `<demandeur certificat-environnemental="false" dossier-sans-demande-aides="false">`;
  if (meta.exploitation) {
    xml += `<identification-societe><exploitation>${esc(meta.exploitation)}</exploitation></identification-societe>`;
  }
  if (meta.siret) {
    xml += `<siret>${esc(meta.siret)}</siret>`;
  }
  if (meta.email) {
    xml += `<courriel>${esc(meta.email)}</courriel>`;
  }
  xml += `</demandeur>`;
  xml += `<rpg>`;

  const ilotPad = 5; // meters

  orderedIlots.forEach((ilot) => {
    if (!ilot.parcelles.length) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasCoords = false;

    ilot.parcelles.forEach(({ feature }) => {
      const rings = getAllOuterRings(feature);
      rings.forEach((ring) => {
        ring.forEach(([lon, lat]) => {
          if (typeof lon !== "number" || typeof lat !== "number") return;
          const [x, y] = toLambert93([lon, lat]);
          hasCoords = true;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        });
      });
    });

    let ilotCoords = "";
    if (hasCoords) {
      ilotCoords = [
        [minX - ilotPad, minY - ilotPad],
        [maxX + ilotPad, minY - ilotPad],
        [maxX + ilotPad, maxY + ilotPad],
        [minX - ilotPad, maxY + ilotPad],
        [minX - ilotPad, minY - ilotPad],
      ]
        .map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`)
        .join(" ");
    }

    const rawIlotReference = firstProperty(ilot.parcelles[0]?.feature?.properties || {}, [
      "numero_ilot_reference",
      "numero-ilot-reference",
      "ilot_reference",
    ]);
    const ilotReference = normalizeIlotReference(rawIlotReference, meta.pacage, ilot.numero);
    const codeCommune = (globalCommune || "00000").slice(0, 5);

    xml += `<ilot numero-ilot-reference="${esc(ilotReference)}" numero-ilot="${esc(ilot.numero)}">`;
    xml += `<commune>${esc(codeCommune)}</commune>`;
    xml += `<geometrie><gml:Polygon><gml:outerBoundaryIs><gml:LinearRing><gml:coordinates>${ilotCoords}</gml:coordinates></gml:LinearRing></gml:outerBoundaryIs></gml:Polygon></geometrie>`;
    xml += `<parcelles>`;

    ilot.parcelles
      .sort((a, b) => a.index - b.index)
      .forEach(({ feature, numero }) => {
        const props = feature?.properties || {};
        const cultureKey = readCultureCodeFromProperty(props, cultureColumn) || normalizeNumero(props.code) || "JAC";
        const split = splitCultureKey(cultureKey);
        const code = split.code || normalizeNumero(cultureKey) || "JAC";
        const ring = getFirstOuterRing(feature);
        const gmlCoords = ring ? ringToGml(ring) : "";
        const ares = ring ? Math.round(ringAreaM2(ring) / 100) : 0;
        const precisionKey = resolvePrecisionKeyForCultureColumn(cultureColumn);
        const precisionKeys = precisionKey === "precision"
          ? ["precision", "precision_n", "precision_n0", "precision_n_0"]
          : [precisionKey];
        const precisionRaw = firstProperty(props, precisionKeys) || split.precision;
        const precision = resolvePrecisionForCode(code, precisionRaw);
        const cultureSecondaire = firstProperty(props, ["culture_secondaire", "culture-secondaire"]) || "A00";
        const productionSemences = getBooleanProp(props, ["production_semences", "production-semences"]);
        const productionFermiers = getBooleanProp(props, ["production_fermiers", "production-fermiers"]);
        const deshydratation = getBooleanProp(props, ["deshydratation"]);
        const derogationUkraine = getBooleanProp(props, ["derogation_ukraine", "derogation-ukraine"]);
        const accidentCulture = getBooleanProp(props, ["accident_culture", "accident-culture"]);
        const maecElevage = getBooleanProp(props, ["maec_elevage_monogastrique", "elevage_monogastrique"]);
        // Une coche venue du seul RPG public ne dit ni AB ni conversion : l'écrire ici
        // ferait déclarer à Télépac un type de conduite que personne n'a confirmé.
        const isOrganic =
          props.bio_source !== "RPG" &&
          isTruthyBoolean(firstProperty(props, ["isOrganic", "conduite_bio", "conduite-bio"]));
        const organicType = isOrganic
          ? (firstProperty(props, ["organicType", "type_conduite_bio", "type-conduite-bio"]) || "AB")
          : null;
        const conduiteMaraichage = getBooleanProp(props, ["conduite_maraichage", "conduite-maraichage"]);

        xml += `<parcelle>`;
        xml += `<descriptif-parcelle numero-parcelle="${esc(numero)}">`;
        xml += `<culture-principale production-semences="${productionSemences}" production-fermiers="${productionFermiers}" deshydratation="${deshydratation}" derogation-ukraine="${derogationUkraine}" culture-secondaire="${esc(cultureSecondaire)}" accident-culture="${accidentCulture}">`;
        xml += `<code-culture>${esc(code)}</code-culture>`;
        if (precision) {
          xml += `<precision>${esc(precision)}</precision>`;
        }
        xml += `</culture-principale>`;
        if (isOrganic) {
          xml += `<agri-bio conduite-bio="true" type-conduite-bio="${esc(organicType)}" conduite-maraichage="${conduiteMaraichage}" />`;
        }
        xml += `<engagements-maec elevage-monogastrique="${maecElevage}"/>`;
        xml += `</descriptif-parcelle>`;
        xml += `<geometrie><gml:Polygon><gml:outerBoundaryIs><gml:LinearRing><gml:coordinates>${gmlCoords}</gml:coordinates></gml:LinearRing></gml:outerBoundaryIs></gml:Polygon></geometrie>`;
        xml += `<surface-admissible>${ares}</surface-admissible>`;
        xml += `</parcelle>`;
      });

    xml += `</parcelles>`;
    xml += `</ilot>`;
  });

  xml += `</rpg>`;
  xml += `</producteur>`;
  xml += `</producteurs>`;
  return xml;
}

function normalisePropertiesFromMesParcelles(feature) {
  const properties = { ...(feature?.properties || {}) };
  const ilotNumero = properties.ilot ?? properties.ilot_numero ?? null;
  const parcelleNumero = properties.parcelle ?? properties.numero ?? null;
  const code = properties.code ?? properties.code_culture ?? null;

  if (properties.source == null) {
    properties.source = "telepac-mesparcelles-xml";
  }
  if (ilotNumero != null && properties.ilot_numero == null) {
    properties.ilot_numero = ilotNumero;
  }
  if (parcelleNumero != null && properties.numero == null) {
    properties.numero = parcelleNumero;
  }
  if (code != null && properties.code == null) {
    properties.code = code;
  }

  if (properties.conduite_bio != null && properties.isOrganic == null) {
    properties.isOrganic = properties.conduite_bio;
  }
  if (properties.organicType == null && properties.type_conduite_bio != null) {
    properties.organicType = properties.type_conduite_bio;
  }

  if (ilotNumero != null || parcelleNumero != null) {
    const label =
      ilotNumero != null && parcelleNumero != null
        ? `${ilotNumero}-${parcelleNumero}`
        : `${parcelleNumero ?? ilotNumero}`;
    if (label) {
      properties.nom_affiche = label;
    }
  }

  return properties;
}

function normaliseMesParcellesFeatures(collection) {
  const out = [];
  if (!collection?.features) return out;

  for (const feature of collection.features) {
    if (!feature || !feature.geometry) continue;

    const baseProps = normalisePropertiesFromMesParcelles(feature);
    if (feature.geometry.type === "Polygon") {
      out.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: feature.geometry.coordinates,
        },
        properties: baseProps,
      });
      continue;
    }

    if (feature.geometry.type === "MultiPolygon") {
      feature.geometry.coordinates.forEach((coords, index) => {
        out.push({
          type: "Feature",
          geometry: { type: "Polygon", coordinates: coords },
          properties: { ...baseProps, _multipolygon_index: index },
        });
      });
      continue;
    }

    console.warn(
      "TELEPAC_XML: Unsupported geometry from Mes Parcelles importer",
      feature.geometry?.type
    );
  }

  return out;
}

function parseLegacyTelepacXml(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "application/xml");
  const isError = xml.getElementsByTagName("parsererror").length > 0;
  if (isError) throw new Error("XML invalide");
  const NS = "urn:x-telepac:fr.gouv.agriculture.telepac:echange-producteur";
  const GML = "http://www.opengis.net/gml";

  const parcelles = xml.getElementsByTagNameNS
    ? xml.getElementsByTagNameNS(NS, "parcelle")
    : xml.querySelectorAll("parcelle");
  const producteurs = xml.getElementsByTagNameNS
    ? xml.getElementsByTagNameNS(NS, "producteur")
    : xml.getElementsByTagName("producteur");
  const producteurNode = producteurs?.[0] || null;
  const pacage =
    (producteurNode &&
      producteurNode.getAttribute &&
      producteurNode.getAttribute("numero-pacage")) ||
    "";

  const features = [];
  for (let i = 0; i < parcelles.length; i++) {
    const p = parcelles[i];

    const parcellesNode = p.parentNode;
    const ilotNode = parcellesNode && parcellesNode.parentNode;
    const ilot_numero =
      (ilotNode &&
        ilotNode.getAttribute &&
        ilotNode.getAttribute("numero-ilot")) ||
      "";

    let numero = "";
    let code = "";
    let conduiteBio;
    let hasConduiteBio = false;
    let organicType = null;
    let propsMaecMonog;
    let propsPrecision = null;
    let propsProductionSemences;
    let propsProductionFermiers;
    let propsDeshydratation;
    let propsDerogationUkraine;
    let propsAccidentCulture;
    let propsCultureSecondaire = null;

    const desc = p.getElementsByTagName("descriptif-parcelle")[0];
    if (desc) {
      const numAttr = desc.getAttribute("numero-parcelle");
      if (numAttr) numero = numAttr.trim();
      const cp = desc.getElementsByTagName("culture-principale")[0];
      if (cp) {
        const codeNode = cp.getElementsByTagName("code-culture")[0];
        if (codeNode) code = codeNode.textContent.trim().toUpperCase();
        const precisionNode = cp.getElementsByTagName("precision")[0];
        if (precisionNode && precisionNode.textContent) {
          propsPrecision = precisionNode.textContent.trim();
        }
        if (code) {
          const resolvedPrecision = resolvePrecisionForCode(code, propsPrecision);
          if (resolvedPrecision) propsPrecision = resolvedPrecision;
        }
        const prodSem = cp.getAttribute("production-semences");
        const prodFerm = cp.getAttribute("production-fermiers");
        const deshyd = cp.getAttribute("deshydratation");
        const derogUkraine = cp.getAttribute("derogation-ukraine");
        const accident = cp.getAttribute("accident-culture");
        const cultSec = cp.getAttribute("culture-secondaire");
        if (prodSem != null) propsProductionSemences = isTruthyBoolean(prodSem);
        if (prodFerm != null) propsProductionFermiers = isTruthyBoolean(prodFerm);
        if (deshyd != null) propsDeshydratation = isTruthyBoolean(deshyd);
        if (derogUkraine != null) propsDerogationUkraine = isTruthyBoolean(derogUkraine);
        if (accident != null) propsAccidentCulture = isTruthyBoolean(accident);
        if (cultSec) propsCultureSecondaire = cultSec.trim();
      }

      const engagementsMaecNode = desc.getElementsByTagName("engagements-maec")[0];
      if (engagementsMaecNode) {
        const elevage = engagementsMaecNode.getAttribute("elevage-monogastrique");
        if (elevage != null) propsMaecMonog = isTruthyBoolean(elevage);
      }

      const agriBioNode = desc.getElementsByTagName("agri-bio")[0];
      if (agriBioNode) {
        const conduiteAttr = agriBioNode.getAttribute("conduite-bio");
        if (conduiteAttr != null) {
          hasConduiteBio = true;
          conduiteBio = isTruthyBoolean(conduiteAttr);
        }
        const typeAttr = agriBioNode.getAttribute("type-conduite-bio");
        if (typeAttr) {
          organicType = typeAttr.trim();
        }
      }
    }

    const cultureProps = code ? { culture: code, cultureN: code } : {};

    let surfaceA;
    const surfNode = p.getElementsByTagName("surface-admissible")[0];
    if (surfNode) {
      const val = parseFloat(surfNode.textContent);
      if (!isNaN(val)) surfaceA = val;
    }

    const ringWgs = [];
    const coordNode = p.getElementsByTagNameNS
      ? p.getElementsByTagNameNS(GML, "coordinates")[0]
      : p.getElementsByTagName("coordinates")[0];
    if (coordNode && coordNode.textContent) {
      const pairs = coordNode.textContent.trim().split(/\s+/);
      for (const pair of pairs) {
        const [xStr, yStr] = pair.split(",");
        if (xStr && yStr) {
          const [lon, lat] = toWgs84([parseFloat(xStr), parseFloat(yStr)]);
          ringWgs.push([lon, lat]);
        }
      }
    }

    const nom_affiche =
      ilot_numero && numero ? `${ilot_numero}-${numero}` : numero;

    const feature = {
      type: "Feature",
      properties: {
        numero,
        ilot_numero,
        nom_affiche,
        ...cultureProps,
        ...(pacage ? { code_exploitation: pacage } : {}),
        ...(surfaceA !== undefined ? { surface_admissible: surfaceA } : {}),
        ...(hasConduiteBio ? { conduite_bio: conduiteBio, isOrganic: conduiteBio } : {}),
        ...(organicType ? { organicType } : {}),
        ...(propsPrecision ? { precision: propsPrecision } : {}),
        ...(propsProductionSemences != null ? { production_semences: propsProductionSemences } : {}),
        ...(propsProductionFermiers != null ? { production_fermiers: propsProductionFermiers } : {}),
        ...(propsDeshydratation != null ? { deshydratation: propsDeshydratation } : {}),
        ...(propsDerogationUkraine != null ? { derogation_ukraine: propsDerogationUkraine } : {}),
        ...(propsAccidentCulture != null ? { accident_culture: propsAccidentCulture } : {}),
        ...(propsCultureSecondaire ? { culture_secondaire: propsCultureSecondaire } : {}),
        ...(propsMaecMonog != null ? { maec_elevage_monogastrique: propsMaecMonog } : {}),
      },
      geometry: { type: "Polygon", coordinates: [ringWgs] },
    };

    features.push(feature);
  }

  return features;
}

export async function parseTelepacXmlToFeatures(file) {
  let arrayBuffer;
  if (file?.arrayBuffer) {
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (err) {
      console.warn("TELEPAC_XML: Failed to read arrayBuffer, falling back to FileReader", err);
    }
  }

  if (!arrayBuffer) {
    arrayBuffer = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(file);
    });
  }

  try {
    const mesParcelles = await telepacMesParcellesImporter.read(arrayBuffer);
    const mesParcellesFeatures = normaliseMesParcellesFeatures(mesParcelles);
    if (mesParcellesFeatures.length > 0) {
      return mesParcellesFeatures;
    }
  } catch (err) {
    console.warn("TELEPAC_XML: Mes Parcelles importer failed, falling back to legacy parser", err);
  }

  let text;
  try {
    text = new TextDecoder("iso-8859-1").decode(arrayBuffer);
  } catch (err) {
    console.warn("TELEPAC_XML: ISO-8859-1 TextDecoder unavailable, using FileReader", err);
    text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsText(file, "ISO-8859-1");
    });
  }

  const legacyFeatures = parseLegacyTelepacXml(text);
  if (!legacyFeatures.length) {
    throw new Error("TELEPAC_XML: structure invalide (aucun ilot/parcelle)");
  }
  return legacyFeatures;
}





