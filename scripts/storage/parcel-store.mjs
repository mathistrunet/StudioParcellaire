/**
 * Stockage du parcellaire sur le poste, hors du dossier de l'application : une mise à
 * jour ou une réinstallation ne touche donc pas aux données.
 *
 * SQLite protège des coupures : une écriture interrompue (fermeture du lanceur, panne)
 * laisse l'état précédent intact, là où réécrire un fichier JSON pouvait le tronquer.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_FILE_NAME = "parcellaire.db";
const PARCELLES_KEY = "parcelles";
const SOIL_MAPPINGS_KEY = "soil-type-mappings";
const MAX_BACKUPS = 20;

export const BACKUP_REASONS = Object.freeze({
  BEFORE_CLEAR: "avant-effacement",
  BEFORE_RESTORE: "avant-restauration",
  BROWSER_COPY: "copie-navigateur",
});

const emptyCollection = () => ({ type: "FeatureCollection", features: [] });

export const isFeatureCollection = (value) =>
  value?.type === "FeatureCollection" && Array.isArray(value.features);

/** `STUDIO_DATA_DIR` prime ; sinon le dossier de données de l'utilisateur. */
export function resolveAppDataDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (env.STUDIO_DATA_DIR) return path.resolve(env.STUDIO_DATA_DIR);
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, "StudioParcellaire");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "StudioParcellaire");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "StudioParcellaire");
}

function readLegacyJson(filePath, onWarning) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (error) {
    onWarning?.(`${filePath} illisible, non repris : ${error?.message || error}`);
    return null;
  }
}

/**
 * @param dataDir Dossier de la base (créé au besoin).
 * @param legacyDataDir Ancien dossier `data/` : repris une seule fois et jamais modifié.
 */
export function openParcelStore({ dataDir, legacyDataDir = null, onWarning = null }) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, DB_FILE_NAME));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      key TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reason TEXT NOT NULL,
      feature_count INTEGER NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  const selectDocument = db.prepare("SELECT json FROM documents WHERE key = ?");
  const upsertDocument = db.prepare(`
    INSERT INTO documents (key, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `);
  const insertBackup = db.prepare(
    "INSERT INTO backups (reason, feature_count, json, created_at) VALUES (?, ?, ?, ?)"
  );
  const pruneBackups = db.prepare(
    "DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)"
  );
  const selectBackups = db.prepare(
    "SELECT id, reason, feature_count, created_at FROM backups ORDER BY id DESC"
  );
  const selectBackup = db.prepare("SELECT json FROM backups WHERE id = ?");

  const now = () => new Date().toISOString();

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const readDocument = (key) => {
    const row = selectDocument.get(key);
    return row ? JSON.parse(row.json) : null;
  };
  const writeDocument = (key, value) => upsertDocument.run(key, JSON.stringify(value), now());

  function addBackup(collection, reason) {
    const { lastInsertRowid } = insertBackup.run(
      reason,
      collection.features.length,
      JSON.stringify(collection),
      now()
    );
    pruneBackups.run(MAX_BACKUPS);
    return Number(lastInsertRowid);
  }

  // Reprise unique : dès que la base contient le document, l'ancien fichier est ignoré.
  if (legacyDataDir) {
    transaction(() => {
      if (!selectDocument.get(PARCELLES_KEY)) {
        const legacy = readLegacyJson(path.join(legacyDataDir, "parcelles.geojson"), onWarning);
        writeDocument(PARCELLES_KEY, isFeatureCollection(legacy) ? legacy : emptyCollection());
      }
      if (!selectDocument.get(SOIL_MAPPINGS_KEY)) {
        const legacy = readLegacyJson(path.join(legacyDataDir, "soil-type-mappings.json"), onWarning);
        writeDocument(SOIL_MAPPINGS_KEY, legacy ?? { mappings: {} });
      }
    });
  }

  return {
    dataDir,

    readCollection: () => readDocument(PARCELLES_KEY) ?? emptyCollection(),

    /** Une collection vidée ne doit jamais être irrécupérable : elle est d'abord sauvegardée. */
    writeCollection(collection) {
      if (!isFeatureCollection(collection)) throw new TypeError("FeatureCollection attendue.");
      transaction(() => {
        const current = readDocument(PARCELLES_KEY);
        if (collection.features.length === 0 && current?.features?.length > 0) {
          addBackup(current, BACKUP_REASONS.BEFORE_CLEAR);
        }
        writeDocument(PARCELLES_KEY, collection);
      });
    },

    readSoilMappings: () => readDocument(SOIL_MAPPINGS_KEY) ?? { mappings: {} },
    writeSoilMappings: (mappings) => void writeDocument(SOIL_MAPPINGS_KEY, mappings),

    createBackup(collection, reason) {
      if (!isFeatureCollection(collection)) throw new TypeError("FeatureCollection attendue.");
      return transaction(() => addBackup(collection, reason));
    },

    listBackups: () =>
      selectBackups.all().map((row) => ({
        id: row.id,
        reason: row.reason,
        featureCount: row.feature_count,
        createdAt: row.created_at,
      })),

    /** @returns La collection restaurée, ou null si la sauvegarde n'existe pas. */
    restoreBackup(id) {
      return transaction(() => {
        const row = selectBackup.get(id);
        if (!row) return null;
        const restored = JSON.parse(row.json);
        const current = readDocument(PARCELLES_KEY);
        if (current?.features?.length > 0) addBackup(current, BACKUP_REASONS.BEFORE_RESTORE);
        writeDocument(PARCELLES_KEY, restored);
        return restored;
      });
    },

    close: () => db.close(),
  };
}
