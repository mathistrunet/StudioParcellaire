const SOIL_TYPE_CSV_PATH = "/data/Soil_type_RRP.csv";
const SOIL_MAPPING_ENDPOINT = "/api/soil-type-mappings";
const NULL_MODALITY = "__NULL__";

export const SOIL_RULE_ATTRIBUTES = [
  "texture",
  "profondeur",
  "position_topo",
  "hydromorphie",
  "ph_classe",
  "cailloux",
];

let soilRowsPromise;

function parseSemicolonCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(";").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(";");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || "").trim();
    });
    return row;
  });
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ";" && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function toCsvValue(value) {
  const normalized = String(value ?? "");
  if (!/[;"\n]/.test(normalized)) return normalized;
  return `"${normalized.replace(/"/g, '""')}"`;
}

function norm(v) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s || /^na$/i.test(s)) return "";
  return s;
}

function normalizeRuleAttribute(attribute = {}) {
  return {
    include: Array.isArray(attribute.include)
      ? attribute.include.map((item) => norm(item)).filter(Boolean)
      : [],
    exclude: Array.isArray(attribute.exclude)
      ? attribute.exclude.map((item) => norm(item)).filter(Boolean)
      : [],
    nullMode:
      attribute.nullMode === "IS_NULL" || attribute.nullMode === "IS_NOT_NULL"
        ? attribute.nullMode
        : "ANY",
  };
}

function normalizeSoilTypeRule(rule = {}) {
  const attributes = {};
  SOIL_RULE_ATTRIBUTES.forEach((attributeName) => {
    attributes[attributeName] = normalizeRuleAttribute(rule.attributes?.[attributeName]);
  });
  return {
    id: rule.id || `soil-type-${Math.random().toString(36).slice(2, 8)}`,
    name: String(rule.name || "").trim(),
    residual: Boolean(rule.residual),
    color: String(rule.color || "#94a3b8").trim() || "#94a3b8",
    description: String(rule.description || "").trim(),
    combinationKeys: Array.isArray(rule.combinationKeys)
      ? rule.combinationKeys.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    attributes,
  };
}

export function normalizeSoilTypeConfiguration(configuration) {
  const soilTypes = Array.isArray(configuration?.soilTypes)
    ? configuration.soilTypes.map((rule) => normalizeSoilTypeRule(rule)).filter((rule) => rule.name)
    : [];
  return { soilTypes };
}

export function buildSoilCombinationLabel(row) {
  const texture = norm(row.texture);
  const profondeur = norm(row.profondeur);
  const cailloux = norm(row.cailloux);
  const hydromorphie = norm(row.hydromorphie);
  const positionTopo = norm(row.position_topo);
  const phClasse = norm(row.ph_classe);

  const firstParts = [texture, profondeur, cailloux].filter(Boolean);
  const first = firstParts.join(" ") || "Type de sol non renseigné";
  const hydro = hydromorphie ? `de ${hydromorphie}` : "";
  const topo = positionTopo ? `${hydro ? " " : ""}sur ${positionTopo}` : "";
  const ph = phClasse ? `${hydro || topo ? " " : ""}à tendance ${phClasse.toLowerCase()}` : "";
  return `${first}${hydro ? ` ${hydro}` : ""}${topo}${ph}`.replace(/\s+/g, " ").trim();
}

export function buildSoilCombinationKey(row) {
  return SOIL_RULE_ATTRIBUTES.map((attributeName) => {
    const value = norm(row?.[attributeName]);
    return value || "__NULL__";
  }).join("||");
}

export function buildDetectedSoilCombinations(parcels = []) {
  const byKey = new Map();
  parcels.forEach((parcel) => {
    const soilRow = parcel?.soilRow || {};
    const key = buildSoilCombinationKey(soilRow);
    const current = byKey.get(key) || {
      key,
      row: SOIL_RULE_ATTRIBUTES.reduce((acc, attributeName) => {
        acc[attributeName] = norm(soilRow?.[attributeName]);
        return acc;
      }, {}),
      parcels: 0,
      surfaceHa: 0,
    };
    current.parcels += 1;
    current.surfaceHa += Number(parcel?.surfaceHa || 0);
    byKey.set(key, current);
  });

  return [...byKey.values()]
    .map((item) => ({ ...item, label: buildSoilCombinationLabel(item.row) }))
    .sort((a, b) => b.surfaceHa - a.surfaceHa || b.parcels - a.parcels || a.label.localeCompare(b.label));
}

export async function loadSoilTypeRows() {
  if (!soilRowsPromise) {
    soilRowsPromise = fetch(SOIL_TYPE_CSV_PATH)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.text();
      })
      .then((text) => {
        const rows = parseSemicolonCsv(text);
        return rows.map((row) => ({
          ...row,
          source_file: norm(row.source_file),
          ucs_id: norm(row.ucs_id),
          combination_label: buildSoilCombinationLabel(row),
        }));
      })
      .catch((error) => {
        soilRowsPromise = null; // permet une nouvelle tentative au prochain appel
        throw error;
      });
  }
  return soilRowsPromise;
}

export async function loadSoilTypeLookupBySourceFile() {
  const rows = await loadSoilTypeRows();
  const lookup = new Map();
  rows.forEach((row) => {
    const key = norm(row.source_file).toLowerCase();
    if (!key || lookup.has(key)) return;
    lookup.set(key, row);
  });
  return lookup;
}

export async function loadSoilTypeLookupByUcsId() {
  const rows = await loadSoilTypeRows();
  const lookup = new Map();
  rows.forEach((row) => {
    const key = normalizeUcsId(row.ucs_id);
    if (!key || lookup.has(key)) return;
    lookup.set(key, row);
  });
  return lookup;
}

export function matchesSoilTypeRule(row, rule) {
  if (!row || !rule) return false;
  return SOIL_RULE_ATTRIBUTES.every((attributeName) => {
    const attributeRule = normalizeRuleAttribute(rule.attributes?.[attributeName]);
    const value = norm(row[attributeName]);

    if (attributeRule.nullMode === "IS_NULL" && value) return false;
    if (attributeRule.nullMode === "IS_NOT_NULL" && !value) return false;

    if (attributeRule.include.length > 0) {
      const includesValue = value
        ? attributeRule.include.includes(value)
        : attributeRule.include.includes(NULL_MODALITY);
      if (!includesValue) return false;
    }
    if (attributeRule.exclude.length > 0) {
      const excludesValue = value
        ? attributeRule.exclude.includes(value)
        : attributeRule.exclude.includes(NULL_MODALITY);
      if (excludesValue) return false;
    }

    return true;
  });
}

export function applySequentialSoilMapping(parcels, configuration) {
  const normalizedConfiguration = normalizeSoilTypeConfiguration(configuration);
  const assignments = [];
  const remainingIndices = new Set(parcels.map((_, index) => index));

  normalizedConfiguration.soilTypes.forEach((soilType, order) => {
    const matchedIndices = [];

    if (soilType.residual) {
      remainingIndices.forEach((index) => {
        matchedIndices.push(index);
      });
    } else if ((soilType.combinationKeys || []).length > 0) {
      const keySet = new Set(soilType.combinationKeys);
      remainingIndices.forEach((index) => {
        const key = buildSoilCombinationKey(parcels[index]?.soilRow || {});
        if (keySet.has(key)) matchedIndices.push(index);
      });
    } else {
      remainingIndices.forEach((index) => {
        if (matchesSoilTypeRule(parcels[index].soilRow, soilType)) matchedIndices.push(index);
      });
    }

    matchedIndices.forEach((index) => {
      remainingIndices.delete(index);
      assignments[index] = {
        soilTypeName: soilType.name,
        order,
        residual: soilType.residual,
      };
    });
  });

  return {
    assignments,
    remainingIndices,
    normalizedConfiguration,
  };
}

export function buildMappingCsv(configuration) {
  const normalized = normalizeSoilTypeConfiguration(configuration);
  const header = ["order", "soil_type", "residual", "color", "description", "combination_keys", ...SOIL_RULE_ATTRIBUTES.flatMap((name) => [
    `${name}_in`,
    `${name}_not_in`,
    `${name}_null`,
  ])];

  const lines = [header.join(";")];
  normalized.soilTypes.forEach((soilType, index) => {
    const row = [
      String(index + 1),
      soilType.name,
      soilType.residual ? "1" : "0",
      soilType.color || "",
      soilType.description || "",
      (soilType.combinationKeys || []).join("~~~"),
      ...SOIL_RULE_ATTRIBUTES.flatMap((attributeName) => {
        const attributeRule = soilType.attributes?.[attributeName] || {};
        return [
          (attributeRule.include || []).join("|"),
          (attributeRule.exclude || []).join("|"),
          attributeRule.nullMode || "ANY",
        ];
      }),
    ];
    lines.push(row.map((value) => toCsvValue(value)).join(";"));
  });

  return lines.join("\n");
}

export function parseMappingCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return { soilTypes: [] };

  const headers = parseCsvLine(lines[0]);
  const indexByHeader = new Map(headers.map((header, index) => [header, index]));
  const soilTypes = lines.slice(1).map((line, rowIndex) => {
    const values = parseCsvLine(line);
    const attributes = {};

    SOIL_RULE_ATTRIBUTES.forEach((attributeName) => {
      const includeValue = values[indexByHeader.get(`${attributeName}_in`)] || "";
      const excludeValue = values[indexByHeader.get(`${attributeName}_not_in`)] || "";
      const nullModeRaw = values[indexByHeader.get(`${attributeName}_null`)] || "ANY";
      const nullMode = ["ANY", "IS_NULL", "IS_NOT_NULL"].includes(nullModeRaw) ? nullModeRaw : "ANY";

      attributes[attributeName] = {
        include: includeValue
          .split("|")
          .map((item) => norm(item))
          .filter(Boolean),
        exclude: excludeValue
          .split("|")
          .map((item) => norm(item))
          .filter(Boolean),
        nullMode,
      };
    });

    const name = values[indexByHeader.get("soil_type")] || "";
    const residualRaw = values[indexByHeader.get("residual")] || "0";
    const color = values[indexByHeader.get("color")] || "#94a3b8";
    const description = values[indexByHeader.get("description")] || "";
    const combinationKeysRaw = values[indexByHeader.get("combination_keys")] || "";

    return {
      id: `imported-soil-type-${rowIndex + 1}`,
      name: String(name).trim(),
      residual: residualRaw === "1" || /^true$/i.test(residualRaw),
      color,
      description,
      combinationKeys: combinationKeysRaw.split("~~~").map((item) => item.trim()).filter(Boolean),
      attributes,
    };
  }).filter((item) => item.name);

  return normalizeSoilTypeConfiguration({ soilTypes });
}

export async function fetchSoilTypeMappings(signal) {
  const response = await fetch(SOIL_MAPPING_ENDPOINT, { signal });
  if (!response.ok) {
    throw new Error(`[SOIL_MAPPING_FETCH_${response.status}] Impossible de charger les mappings.`);
  }
  return response.json();
}

export async function saveSoilTypeMappings(payload, signal) {
  const normalizedPayload = normalizeStructureMappings(
    payload?.mappings ? payload : { mappings: payload }
  );

  const response = await fetch(SOIL_MAPPING_ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(normalizedPayload),
    signal,
  });
  if (!response.ok) {
    throw new Error(`[SOIL_MAPPING_SAVE_${response.status}] Impossible d'enregistrer les mappings.`);
  }
  return response.json();
}

export function resolveFileUcs(properties) {
  if (!properties || typeof properties !== "object") return "";
  const keys = ["file_ucs", "FILE_UCS", "source_file", "SOURCE_FILE", "id_ucs_file"];
  for (const key of keys) {
    const value = properties[key];
    if (value == null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;

    const ucsId = normalizeUcsId(normalized);
    if (/^id_ucs_/i.test(normalized) && ucsId) {
      return `id_ucs_${ucsId}.txt`;
    }

    return normalized;
  }

  const ucsId = resolveUcsId(properties);
  if (ucsId) return `id_ucs_${ucsId}.txt`;

  return "";
}

export function resolveUcsId(properties) {
  if (!properties || typeof properties !== "object") return "";
  const keys = ["id_ucs", "ID_UCS", "ucs_id", "UCS_ID", "UCS", "Code_UCS", "code_ucs", "ucs"];
  for (const key of keys) {
    const normalized = normalizeUcsId(properties[key]);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeUcsId(value) {
  if (value == null) return "";
  const normalized = String(value).trim();
  if (!normalized) return "";
  const match = normalized.match(/(\d+)/);
  return match ? match[1] : "";
}


export function normalizeStructureMappings(payload) {
  let rawMappings = payload?.mappings && typeof payload.mappings === "object" ? payload.mappings : {};
  while (
    rawMappings &&
    typeof rawMappings === "object" &&
    !Array.isArray(rawMappings) &&
    Object.keys(rawMappings).length === 1 &&
    Object.prototype.hasOwnProperty.call(rawMappings, "mappings") &&
    rawMappings.mappings &&
    typeof rawMappings.mappings === "object" &&
    !Array.isArray(rawMappings.mappings)
  ) {
    rawMappings = rawMappings.mappings;
  }
  const mappings = {};
  Object.entries(rawMappings).forEach(([structure, entry]) => {
    const soilTypes = Array.isArray(entry?.soilTypes)
      ? entry.soilTypes.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const rawCombinationMap = entry?.combinationMap && typeof entry.combinationMap === "object"
      ? entry.combinationMap
      : {};
    const combinationMap = {};
    Object.entries(rawCombinationMap).forEach(([key, value]) => {
      const name = String(value || "").trim();
      if (name) combinationMap[String(key || "").trim()] = name;
    });
    mappings[String(structure || "").trim()] = { soilTypes, combinationMap };
  });
  return { mappings };
}

