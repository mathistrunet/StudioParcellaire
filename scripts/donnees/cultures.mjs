/**
 * Libellés des codes culture PAC côté serveur, à partir des mêmes fichiers que
 * l'interface : public/codebook.js (PAC 2023, codes seuls) et public/codebookV2.js
 * (PAC 2024, codes et couples code|précision). Même ordre de recherche que
 * src/utils/cultureLabels.js : couple code|précision, puis code seul en V2, puis en V1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** Exécute un fichier « window.CODEBOOK_EXTRA = {...} » dans un bac à sable. */
function lireCodebook(fichier) {
  const bac = { window: {} };
  vm.runInNewContext(readFileSync(path.join(PUBLIC, fichier), "utf-8"), bac, { timeout: 1000 });
  const brut = bac.window.CODEBOOK_EXTRA ?? {};
  return new Map(Object.entries(brut).map(([cle, libelle]) => [String(cle).trim().toUpperCase(), String(libelle).trim()]));
}

/** Coupe « BTH|001 » en { code: "BTH", precision: "001" }. */
export function separerCode(valeur) {
  const [code = "", precision = ""] = String(valeur ?? "").trim().split("|");
  return { code: code.trim().toUpperCase(), precision: precision.trim() };
}

export function creerLibelles({ v1 = lireCodebook("codebook.js"), v2 = lireCodebook("codebookV2.js") } = {}) {
  return function libelleCulture(code, precision = "") {
    if (!code) return null;
    const separe = separerCode(code);
    const prec = String(precision || separe.precision || "").trim();
    if (prec) {
      const complet = v2.get(`${separe.code}|${prec.padStart(3, "0")}`);
      if (complet) return complet;
    }
    return v2.get(separe.code) ?? v1.get(separe.code) ?? null;
  };
}
