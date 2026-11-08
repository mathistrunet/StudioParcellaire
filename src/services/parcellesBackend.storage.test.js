// @vitest-environment node
//
// La base locale est la seule référence : le navigateur ne garde plus de copie, et
// l'ancienne rejoint la base une fois, sans jamais écraser son contenu.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchParcellesGeojson, saveParcellesGeojson } from "./parcellesBackend";

const COPY_KEY = "studioparcellaire.parcelles-temp";
const LEGACY_KEY = "parcelles.geojson";
const VERSION_KEY = "studioparcellaire.parcelles-version";

const collection = (...ids) => ({
  type: "FeatureCollection",
  features: ids.map((id) => ({ type: "Feature", id, properties: {}, geometry: null })),
});

function stubLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: (key) => values.delete(key),
  };
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

function stubServer(serverCollection, { failWrites = false } = {}) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    if (init.method && failWrites) return new Response("{}", { status: 500 });
    if (!init.method) return new Response(JSON.stringify(serverCollection), { status: 200 });
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const writes = (fetchMock) => fetchMock.mock.calls.filter(([, init]) => init?.method);

describe("parcellesBackend — base locale", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("lit le serveur et n'écrit rien sans copie du navigateur", async () => {
    const storage = stubLocalStorage();
    const fetchMock = stubServer(collection("base"));

    const result = await fetchParcellesGeojson();

    expect(result.features.map((f) => f.id)).toEqual(["base"]);
    expect(writes(fetchMock)).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("n'utilise plus le navigateur comme solution de repli", async () => {
    stubLocalStorage({ [COPY_KEY]: JSON.stringify(collection("copie")), [VERSION_KEY]: "2" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));

    await expect(fetchParcellesGeojson()).rejects.toThrow("PARCELLES_FETCH_BACKEND_500");
  });

  it("reprend un travail récent quand la base est vide, puis retire la copie", async () => {
    const storage = stubLocalStorage({ [COPY_KEY]: JSON.stringify(collection("copie")), [VERSION_KEY]: "2" });
    const fetchMock = stubServer(collection());

    const result = await fetchParcellesGeojson();

    expect(result.features.map((f) => f.id)).toEqual(["copie"]);
    const [[url, init]] = writes(fetchMock);
    expect(url).toBe("/api/parcelles");
    expect(init.method).toBe("PUT");
    expect(storage.getItem(COPY_KEY)).toBeNull();
    expect(storage.getItem(VERSION_KEY)).toBeNull();
  });

  it("garde la base et sauvegarde une copie divergente", async () => {
    const storage = stubLocalStorage({ [COPY_KEY]: JSON.stringify(collection("copie")), [VERSION_KEY]: "2" });
    const fetchMock = stubServer(collection("base"));

    const result = await fetchParcellesGeojson();

    expect(result.features.map((f) => f.id)).toEqual(["base"]);
    const [[url, init]] = writes(fetchMock);
    expect(url).toBe("/api/parcelles/backups");
    expect(JSON.parse(init.body).reason).toBe("copie-navigateur");
    expect(storage.getItem(COPY_KEY)).toBeNull();
  });

  it("ne sauvegarde pas une copie identique à la base", async () => {
    const storage = stubLocalStorage({ [COPY_KEY]: JSON.stringify(collection("a")), [VERSION_KEY]: "2" });
    const fetchMock = stubServer(collection("a"));

    await fetchParcellesGeojson();

    expect(writes(fetchMock)).toEqual([]);
    expect(storage.getItem(COPY_KEY)).toBeNull();
  });

  it("ne remet pas en service une copie antérieure au marqueur de version", async () => {
    stubLocalStorage({ [LEGACY_KEY]: JSON.stringify(collection("ancienne")) });
    const fetchMock = stubServer(collection());

    const result = await fetchParcellesGeojson();

    expect(result.features).toEqual([]);
    expect(writes(fetchMock)[0][0]).toBe("/api/parcelles/backups");
  });

  it("conserve la copie si son envoi échoue, et charge quand même la base", async () => {
    const storage = stubLocalStorage({ [COPY_KEY]: JSON.stringify(collection("copie")), [VERSION_KEY]: "2" });
    stubServer(collection("base"), { failWrites: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await fetchParcellesGeojson();

    expect(result.features.map((f) => f.id)).toEqual(["base"]);
    expect(storage.getItem(COPY_KEY)).not.toBeNull();
  });

  it("n'écrit plus le parcellaire dans le navigateur à l'enregistrement", async () => {
    const storage = stubLocalStorage();
    stubServer(collection());

    await saveParcellesGeojson(collection("a").features);

    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("signale un enregistrement refusé par le serveur", async () => {
    stubLocalStorage();
    stubServer(collection(), { failWrites: true });

    await expect(saveParcellesGeojson(collection("a").features)).rejects.toThrow("PARCELLES_SAVE_BACKEND_500");
  });
});
