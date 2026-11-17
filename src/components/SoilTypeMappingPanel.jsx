import React, { useEffect, useMemo, useState } from "react";
import {
  buildDetectedSoilCombinations,
  buildSoilCombinationKey,
  SOIL_RULE_ATTRIBUTES,
  fetchSoilTypeMappings,
  normalizeStructureMappings,
  saveSoilTypeMappings,
} from "../services/soilTypeMapping";
import { loadAssoliaStructureNames } from "../services/parcellesCsv";

const ATTRIBUTE_LABELS = {
  texture: "Texture",
  profondeur: "Profondeur",
  position_topo: "Topo",
  hydromorphie: "Hydromorphie",
  ph_classe: "pH",
  cailloux: "Cailloux",
};

function formatHa(value) {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function valueLabel(value) {
  return value ? value : "Non renseigne";
}

function buildParcelLabel(parcel, fallbackIndex) {
  const properties = parcel?.feature?.properties || {};
  const name = String(properties.nom_parcelle || properties.NOM_PARCEL || properties.nom || "").trim();
  if (name) return name;
  const ilot = String(properties.ilot_numero || "").trim();
  const numero = String(properties.numero || "").trim();
  if (ilot || numero) return [ilot, numero].filter(Boolean).join(".");
  return `Parcelle ${fallbackIndex + 1}`;
}

export default function SoilTypeMappingPanel({
  parcelCandidates = [],
  parcelCount = 0,
  rrpVisible = false,
  loading = false,
  onRefresh,
  onApplyMapping,
  onSelectParcels,
}) {
  const [structures, setStructures] = useState([]);
  const [selectedStructure, setSelectedStructure] = useState("");
  const [mappingState, setMappingState] = useState({ mappings: {} });
  const [mappingLoading, setMappingLoading] = useState(false);
  const [mappingSaving, setMappingSaving] = useState(false);
  const [newSoilTypeName, setNewSoilTypeName] = useState("");
  const [mappingError, setMappingError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadAssoliaStructureNames()
      .then((names) => {
        if (!cancelled) setStructures(names || []);
      })
      .catch((error) => {
        console.warn("[SOIL_MAPPING] Chargement structures impossible", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMappingLoading(true);
    fetchSoilTypeMappings()
      .then((payload) => {
        if (cancelled) return;
        setMappingState(normalizeStructureMappings(payload));
      })
      .catch((error) => {
        console.warn("[SOIL_MAPPING] Chargement mappings impossible", error);
      })
      .finally(() => {
        if (!cancelled) setMappingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedStructure && structures.length > 0) {
      setSelectedStructure(structures[0]);
    }
  }, [selectedStructure, structures]);

  const detectedCombinations = useMemo(
    () => buildDetectedSoilCombinations(parcelCandidates),
    [parcelCandidates]
  );

  const parcelLabelsByCombination = useMemo(() => {
    const grouped = new Map();
    parcelCandidates.forEach((parcel, index) => {
      const key = buildSoilCombinationKey(parcel?.soilRow || {});
      const current = grouped.get(key) || [];
      current.push(buildParcelLabel(parcel, index));
      grouped.set(key, current);
    });
    return grouped;
  }, [parcelCandidates]);

  const parcelIdsByCombination = useMemo(() => {
    const grouped = new Map();
    parcelCandidates.forEach((parcel) => {
      const key = buildSoilCombinationKey(parcel?.soilRow || {});
      const current = grouped.get(key) || [];
      const id = parcel?.feature?.id ?? parcel?.feature?.properties?.id ?? null;
      if (id != null) current.push(id);
      grouped.set(key, current);
    });
    return grouped;
  }, [parcelCandidates]);
  const totalSurfaceHa = useMemo(
    () =>
      parcelCandidates.reduce(
        (sum, parcel) => sum + Number(parcel?.surfaceHa || 0),
        0
      ),
    [parcelCandidates]
  );

  const structureMapping = useMemo(() => {
    if (!selectedStructure) return { soilTypes: [], combinationMap: {} };
    return mappingState.mappings?.[selectedStructure] || { soilTypes: [], combinationMap: {} };
  }, [mappingState, selectedStructure]);

  const updateStructureMapping = (nextMapping) => {
    if (!selectedStructure) return;
    setMappingState((prev) => ({
      mappings: {
        ...(prev.mappings || {}),
        [selectedStructure]: nextMapping,
      },
    }));
  };

  const handleAddSoilType = () => {
    const name = String(newSoilTypeName || "").trim();
    if (!name) return;
    const existing = new Set(structureMapping.soilTypes.map((item) => item.toLowerCase()));
    if (existing.has(name.toLowerCase())) {
      setNewSoilTypeName("");
      return;
    }
    updateStructureMapping({
      ...structureMapping,
      soilTypes: [...structureMapping.soilTypes, name].sort((a, b) => a.localeCompare(b, "fr")),
    });
    setNewSoilTypeName("");
  };

  const handleRemoveSoilType = (name) => {
    const remaining = structureMapping.soilTypes.filter((item) => item !== name);
    const nextMap = { ...structureMapping.combinationMap };
    Object.keys(nextMap).forEach((key) => {
      if (nextMap[key] === name) delete nextMap[key];
    });
    updateStructureMapping({ soilTypes: remaining, combinationMap: nextMap });
  };

  const handleCombinationMappingChange = (key, value) => {
    const nextMap = { ...structureMapping.combinationMap };
    if (!value) {
      delete nextMap[key];
    } else {
      nextMap[key] = value;
    }
    updateStructureMapping({ ...structureMapping, combinationMap: nextMap });
  };

  const handleSaveMapping = async () => {
    if (!selectedStructure) return;
    setMappingSaving(true);
    setMappingError("");
    try {
      const payload = normalizeStructureMappings({ mappings: mappingState.mappings });
      await saveSoilTypeMappings(payload);
      setMappingState(payload);
    } catch (error) {
      console.warn("[SOIL_MAPPING] Enregistrement impossible", error);
      setMappingError("Enregistrement impossible. Verifie le backend.");
    } finally {
      setMappingSaving(false);
    }
  };

  const handleApplyMapping = () => {
    if (!onApplyMapping || !selectedStructure) return;
    onApplyMapping(selectedStructure, structureMapping);
  };

  if (!parcelCount) {
    return (
      <div style={{ paddingTop: 10 }}>
        <p style={{ marginTop: 0, color: "#555", fontSize: 13 }}>
          Importe d'abord des parcelles pour voir les types de sols detectes.
        </p>
      </div>
    );
  }

  if (!rrpVisible) {
    return (
      <div style={{ paddingTop: 10 }}>
        <p style={{ marginTop: 0, color: "#555", fontSize: 13 }}>
          Active la couche <strong>Carte des sols France</strong> dans l'onglet
          calques pour visualiser les types de sols presents sur les parcelles
          importees.
        </p>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 10, display: "grid", gap: 12 }}>
      <p style={{ marginTop: 0, color: "#555", fontSize: 13 }}>
        Associe les types de sols detectes aux noms utilises par tes structures.
        Les mappings sont stockes en backend.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 12, color: "#475569" }}>
          Structure
          <select
            value={selectedStructure}
            onChange={(e) => setSelectedStructure(e.target.value)}
            style={{
              marginLeft: 8,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              background: "#fff",
            }}
          >
            {structures.map((structure) => (
              <option key={structure} value={structure}>
                {structure}
              </option>
            ))}
          </select>
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => onRefresh?.()}
            disabled={loading}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #e2e8f0",
              background: loading ? "#e2e8f0" : "#f8fafc",
              color: "#0f172a",
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
            title="Recharger les types de sols depuis la couche RRP"
          >
            {loading ? "Rechargement..." : "Recharger les sols"}
          </button>
          <button
            type="button"
            onClick={handleSaveMapping}
            disabled={mappingSaving || mappingLoading}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #cbd5f5",
              background: mappingSaving ? "#e2e8f0" : "#eef2ff",
              color: "#1e1b4b",
              cursor: mappingSaving ? "not-allowed" : "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {mappingSaving ? "Enregistrement..." : "Enregistrer"}
          </button>
          <button
            type="button"
            onClick={handleApplyMapping}
            disabled={!structureMapping.soilTypes.length || !detectedCombinations.length}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #93c5fd",
              background: "#eff6ff",
              color: "#1e3a8a",
              cursor:
                structureMapping.soilTypes.length && detectedCombinations.length
                  ? "pointer"
                  : "not-allowed",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Appliquer aux parcelles
          </button>
        </div>
      </div>

      {mappingError ? (
        <div style={{ color: "#b91c1c", fontSize: 12 }}>{mappingError}</div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
          <div style={{ fontSize: 12, color: "#64748b" }}>Parcelles analysees</div>
          <strong>{parcelCandidates.length}</strong>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
          <div style={{ fontSize: 12, color: "#64748b" }}>Types detectes</div>
          <strong>{detectedCombinations.length}</strong>
        </div>
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
          <div style={{ fontSize: 12, color: "#64748b" }}>Surface totale</div>
          <strong>{formatHa(totalSurfaceHa)} ha</strong>
        </div>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, background: "#fff" }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Noms des types de sol (structure)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={newSoilTypeName}
            onChange={(e) => setNewSoilTypeName(e.target.value)}
            placeholder="Nouveau type de sol"
            style={{
              flex: "1 1 220px",
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
            }}
          />
          <button
            type="button"
            onClick={handleAddSoilType}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              background: "#fff",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Ajouter
          </button>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {structureMapping.soilTypes.length === 0 ? (
            <span style={{ fontSize: 12, color: "#64748b" }}>Aucun type defini.</span>
          ) : (
            structureMapping.soilTypes.map((soilType) => (
              <span
                key={soilType}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 999,
                  background: "#f1f5f9",
                  fontSize: 12,
                }}
              >
                {soilType}
                <button
                  type="button"
                  onClick={() => handleRemoveSoilType(soilType)}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "#dc2626",
                  }}
                  title="Supprimer"
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ maxHeight: 520, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, background: "#f8fafc", zIndex: 1 }}>
              <tr>
                <th style={{ textAlign: "left", padding: 8 }}>Type detecte</th>
                {SOIL_RULE_ATTRIBUTES.map((attributeName) => (
                  <th key={attributeName} style={{ textAlign: "left", padding: 8 }}>
                    {ATTRIBUTE_LABELS[attributeName]}
                  </th>
                ))}
                <th style={{ textAlign: "left", padding: 8 }}>Parcelles</th>
                <th style={{ textAlign: "left", padding: 8 }}>Surface</th>
                <th style={{ textAlign: "left", padding: 8 }}>Type structure</th>
              </tr>
            </thead>
            <tbody>
              {detectedCombinations.map((combination) => {
                const parcelLabels = parcelLabelsByCombination.get(combination.key) || [];
                const parcelIds = parcelIdsByCombination.get(combination.key) || [];
                const selectedType = structureMapping.combinationMap?.[combination.key] || "";
                return (
                  <tr key={combination.key} style={{ borderTop: "1px solid #f1f5f9" }}>
                    <td style={{ padding: 8, minWidth: 220 }}>
                      <div style={{ fontWeight: 600, color: "#0f172a" }}>{combination.label}</div>
                      <button
                        type="button"
                        onClick={() => onSelectParcels?.(parcelIds)}
                        disabled={!parcelIds.length}
                        style={{
                          marginTop: 6,
                          padding: "2px 6px",
                          borderRadius: 6,
                          border: "1px solid #d1d5db",
                          background: "#fff",
                          cursor: parcelIds.length ? "pointer" : "not-allowed",
                          fontSize: 11,
                        }}
                      >
                        Selectionner
                      </button>
                      <div style={{ marginTop: 6, color: "#64748b" }}>
                        {parcelLabels.slice(0, 5).join(", ")}
                        {parcelLabels.length > 5 ? ` +${parcelLabels.length - 5}` : ""}
                      </div>
                    </td>
                    {SOIL_RULE_ATTRIBUTES.map((attributeName) => (
                      <td key={attributeName} style={{ padding: 8 }}>
                        {valueLabel(combination.row[attributeName])}
                      </td>
                    ))}
                    <td style={{ padding: 8 }}>{combination.parcels}</td>
                    <td style={{ padding: 8 }}>{formatHa(combination.surfaceHa)} ha</td>
                    <td style={{ padding: 8, minWidth: 200 }}>
                      <select
                        value={selectedType}
                        onChange={(e) => handleCombinationMappingChange(combination.key, e.target.value)}
                        style={{
                          width: "100%",
                          padding: "4px 6px",
                          borderRadius: 6,
                          border: "1px solid #d1d5db",
                          background: "#fff",
                        }}
                      >
                        <option value="">-- Non mappe --</option>
                        {structureMapping.soilTypes.map((soilType) => (
                          <option key={soilType} value={soilType}>
                            {soilType}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}



