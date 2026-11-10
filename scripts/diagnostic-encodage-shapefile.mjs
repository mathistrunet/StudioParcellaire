// Diagnostic d'encodage d'un shapefile, à lancer en local sur un fichier
// qu'on ne peut pas partager. N'affiche que des informations techniques
// (encodage déclaré, octets accentués) et les valeurs des colonnes de culture,
// jamais les autres attributs (noms, PACAGE, exploitant…).
//
//   node scripts/diagnostic-encodage-shapefile.mjs <fichier.zip | dossier | fichier.dbf>

import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { chooseDbfEncoding, decodeWithEncoding } from "../src/services/dbfEncoding.js";

const CULTURE_FIELD_RE = /^(cp_cultu|code_cultu|cult_prec2?|culture.*|code_culture|crop_.*|libelle.*)$/i;

async function collectDbfs(target) {
  const stat = fs.statSync(target);
  const out = [];
  const add = (name, dbf, cpg) => out.push({ name, dbf, cpg });
  if (stat.isDirectory()) {
    const walk = async (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.dbf$/i.test(entry.name)) {
          const cpgPath = fs.readdirSync(dir).find(
            (n) => n.toLowerCase() === entry.name.slice(0, -4).toLowerCase() + ".cpg"
          );
          add(full, fs.readFileSync(full), cpgPath ? fs.readFileSync(path.join(dir, cpgPath), "latin1") : null);
        } else if (/\.zip$/i.test(entry.name)) {
          out.push(...(await zipDbfs(full)));
        }
      }
    };
    await walk(target);
  } else if (/\.zip$/i.test(target)) {
    out.push(...(await zipDbfs(target)));
  } else if (/\.dbf$/i.test(target)) {
    const cpgPath = target.slice(0, -4) + ".cpg";
    add(target, fs.readFileSync(target), fs.existsSync(cpgPath) ? fs.readFileSync(cpgPath, "latin1") : null);
  }
  return out;
}

async function zipDbfs(zipPath) {
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const names = Object.keys(zip.files);
  const out = [];
  for (const name of names) {
    if (!/\.dbf$/i.test(name)) continue;
    const cpgName = names.find((n) => n.toLowerCase() === name.slice(0, -4).toLowerCase() + ".cpg");
    out.push({
      name: `${zipPath} :: ${name}`,
      dbf: Buffer.from(await zip.files[name].async("uint8array")),
      cpg: cpgName ? await zip.files[cpgName].async("binarystring") : null,
    });
  }
  return out;
}

function readDbf(buf) {
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const count = buf.readUInt32LE(4);
  const fields = [];
  let offset = 1;
  for (let p = 32; p < headerLen - 1 && buf[p] !== 0x0d; p += 32) {
    const name = buf.subarray(p, p + 11).toString("latin1").replace(/\0.*$/, "").trim();
    const len = buf[p + 16];
    fields.push({ name, offset, len });
    offset += len;
  }
  return { headerLen, recordLen, count, fields, ldid: buf[29] };
}

function describeBytes(bytes) {
  return Array.from(bytes)
    .map((b) => (b < 0x80 ? String.fromCharCode(b) : `[${b.toString(16).toUpperCase().padStart(2, "0")}]`))
    .join("");
}

const target = process.argv[2];
if (!target) {
  console.error("Usage : node scripts/diagnostic-encodage-shapefile.mjs <fichier.zip | dossier | fichier.dbf>");
  process.exit(1);
}

const dbfs = await collectDbfs(target);
if (!dbfs.length) {
  console.log("Aucun .dbf trouvé.");
  process.exit(1);
}

for (const { name, dbf, cpg } of dbfs) {
  const info = readDbf(dbf);
  const records = dbf.subarray(info.headerLen, info.headerLen + info.count * info.recordLen);
  const hasReplacementChar = records.includes(Buffer.from([0xef, 0xbf, 0xbd]));
  const choice = chooseDbfEncoding(new Uint8Array(dbf), cpg);

  console.log("\n=== " + name);
  console.log(".cpg               :", cpg == null ? "(absent)" : JSON.stringify(cpg));
  console.log("Octet LDID (29)    : 0x" + info.ldid.toString(16).padStart(2, "0"));
  console.log("Enregistrements    :", info.count);
  console.log("Champs             :", info.fields.map((f) => f.name).join(", "));
  console.log("Contient déjà « � » (EF BF BD) dans les données :", hasReplacementChar ? "OUI" : "non");
  console.log("Encodage retenu par l'appli :", choice ?? "utf-8 (par défaut)");

  const cultureFields = info.fields.filter((f) => CULTURE_FIELD_RE.test(f.name));
  for (const field of cultureFields) {
    const values = new Map();
    for (let i = 0; i < info.count; i += 1) {
      const start = i * info.recordLen + field.offset;
      const raw = records.subarray(start, start + field.len);
      const key = describeBytes(raw).trim();
      if (/\[/.test(key)) values.set(key, raw);
    }
    console.log(`\nValeurs accentuées de ${field.name} (octets non ASCII entre crochets) :`);
    if (!values.size) console.log("  (aucune)");
    for (const [key, raw] of values) {
      console.log("  " + key);
      console.log("      retenu (" + (choice ?? "utf-8") + ") : " + decodeWithEncoding(raw, choice).trim());
      for (const other of ["utf-8", "windows-1252", "cp850"]) {
        if (other === (choice ?? "utf-8")) continue;
        console.log("      si " + other.padEnd(12) + ": " + decodeWithEncoding(raw, other).trim());
      }
    }
  }
}
