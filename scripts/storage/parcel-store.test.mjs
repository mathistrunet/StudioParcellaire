import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKUP_REASONS, openParcelStore, resolveAppDataDir } from "./parcel-store.mjs";

const collection = (...ids) => ({ type: "FeatureCollection", features: ids.map((id) => ({ type: "Feature", id })) });
const ids = (value) => value.features.map((feature) => feature.id);

describe("resolveAppDataDir", () => {
  it("utilise %APPDATA% sous Windows", () => {
    expect(resolveAppDataDir({ env: { APPDATA: "C:\\Profil\\Roaming" }, platform: "win32", home: "x" })).toBe(
      path.join("C:\\Profil\\Roaming", "StudioParcellaire")
    );
  });

  it("donne la priorité à STUDIO_DATA_DIR", () => {
    expect(resolveAppDataDir({ env: { STUDIO_DATA_DIR: "/tmp/ici", APPDATA: "a" }, platform: "win32" })).toBe(
      path.resolve("/tmp/ici")
    );
  });
});

describe("openParcelStore", () => {
  let root;
  let dataDir;
  let legacyDataDir;
  const stores = [];
  const open = (options = {}) => {
    const store = openParcelStore({ dataDir, legacyDataDir, ...options });
    stores.push(store);
    return store;
  };

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "studio-store-"));
    dataDir = path.join(root, "appdata");
    legacyDataDir = path.join(root, "data");
    mkdirSync(legacyDataDir);
  });

  afterEach(() => {
    stores.splice(0).forEach((store) => store.close());
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("reprend l'ancien fichier une seule fois, sans le modifier", () => {
    const legacyFile = path.join(legacyDataDir, "parcelles.geojson");
    const original = JSON.stringify(collection("ancienne"));
    writeFileSync(legacyFile, original);

    const store = open();
    expect(ids(store.readCollection())).toEqual(["ancienne"]);
    store.writeCollection(collection("nouvelle"));
    store.close();
    stores.length = 0;

    expect(readFileSync(legacyFile, "utf-8")).toBe(original);
    expect(ids(open().readCollection())).toEqual(["nouvelle"]);
  });

  it("démarre vide et avertit si l'ancien fichier est illisible, sans l'effacer", () => {
    const legacyFile = path.join(legacyDataDir, "parcelles.geojson");
    writeFileSync(legacyFile, "{ tronqué");
    const warnings = [];

    const store = open({ onWarning: (message) => warnings.push(message) });

    expect(store.readCollection().features).toEqual([]);
    expect(warnings[0]).toContain("illisible");
    expect(readFileSync(legacyFile, "utf-8")).toBe("{ tronqué");
  });

  it("conserve les données après une fermeture", () => {
    const store = open();
    store.writeCollection(collection("a", "b"));
    store.close();
    stores.length = 0;

    expect(ids(open().readCollection())).toEqual(["a", "b"]);
  });

  it("sauvegarde avant d'effacer, et permet de restaurer", () => {
    const store = open();
    store.writeCollection(collection("a", "b"));
    store.writeCollection(collection());

    expect(store.readCollection().features).toEqual([]);
    const [backup] = store.listBackups();
    expect(backup).toMatchObject({ reason: BACKUP_REASONS.BEFORE_CLEAR, featureCount: 2 });

    expect(ids(store.restoreBackup(backup.id))).toEqual(["a", "b"]);
    expect(ids(store.readCollection())).toEqual(["a", "b"]);
  });

  it("ne crée pas de sauvegarde en vidant une collection déjà vide", () => {
    const store = open();
    store.writeCollection(collection());
    expect(store.listBackups()).toEqual([]);
  });

  it("sauvegarde l'état courant avant une restauration", () => {
    const store = open();
    store.writeCollection(collection("a"));
    const id = store.createBackup(collection("ancienne"), BACKUP_REASONS.BROWSER_COPY);

    store.restoreBackup(id);

    expect(store.listBackups()[0]).toMatchObject({ reason: BACKUP_REASONS.BEFORE_RESTORE, featureCount: 1 });
  });

  it("répond null pour une sauvegarde inexistante, sans rien changer", () => {
    const store = open();
    store.writeCollection(collection("a"));
    expect(store.restoreBackup(999)).toBeNull();
    expect(ids(store.readCollection())).toEqual(["a"]);
  });

  it("limite le nombre de sauvegardes en gardant les plus récentes", () => {
    const store = open();
    let last;
    for (let index = 0; index < 25; index += 1) {
      last = store.createBackup(collection(String(index)), BACKUP_REASONS.BROWSER_COPY);
    }
    const backups = store.listBackups();
    expect(backups).toHaveLength(20);
    expect(backups[0].id).toBe(last);
  });

  it("refuse une collection invalide et conserve l'état précédent", () => {
    const store = open();
    store.writeCollection(collection("a"));
    expect(() => store.writeCollection({ type: "FeatureCollection" })).toThrow(TypeError);
    expect(ids(store.readCollection())).toEqual(["a"]);
  });

  it("reprend puis conserve les associations de sols", () => {
    writeFileSync(
      path.join(legacyDataDir, "soil-type-mappings.json"),
      JSON.stringify({ mappings: { Exemple: { soilTypes: ["Limon"] } } })
    );
    const store = open();
    expect(store.readSoilMappings().mappings.Exemple.soilTypes).toEqual(["Limon"]);
    store.writeSoilMappings({ mappings: {} });
    expect(store.readSoilMappings()).toEqual({ mappings: {} });
  });
});
