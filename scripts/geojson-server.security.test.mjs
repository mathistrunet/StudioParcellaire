import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAccessPolicy, getAccessDenial } from "./http-security.mjs";

// Le vrai serveur tourne dans un dossier temporaire : DATA_DIR suit le répertoire de
// travail, le parcellaire du poste n'est donc jamais touché par ces tests.
const SERVER_SCRIPT = fileURLToPath(new URL("./geojson-server.mjs", import.meta.url));
const MAX_BODY_BYTES = 2048;

let sandbox;
let serverProcess;
let port;

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });

/** Passe par node:http : fetch ne laisse pas choisir les en-têtes Host et Origin. */
function send({ method = "GET", url = "/api/parcelles", headers = {}, body, chunks, host = "127.0.0.1" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method, path: url, headers }, (res) => {
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf-8") })
      );
    });
    req.on("error", reject);
    for (const chunk of chunks || []) req.write(chunk);
    req.end(body);
  });
}

const collectionWith = (id) => JSON.stringify({ type: "FeatureCollection", features: [{ id }] });
const storedParcelles = async () => JSON.parse(await readFile(path.join(sandbox, "data", "parcelles.geojson"), "utf-8"));
const EVIL_ORIGIN = "https://evil.example";

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await send({});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Le serveur de test n'a pas démarré.");
}

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "studio-securite-"));
  port = await freePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: sandbox,
    env: {
      ...process.env,
      PORT: String(port),
      STUDIO_MAX_BODY_BYTES: String(MAX_BODY_BYTES),
      STUDIO_HOST: "",
      STUDIO_ALLOWED_ORIGINS: "",
    },
    stdio: "ignore",
  });
  await waitForServer();
  await send({ method: "PUT", body: collectionWith("initiale") });
}, 20_000);

afterAll(async () => {
  serverProcess?.kill();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("écoute réseau", () => {
  it("n'écoute par défaut que sur la boucle locale", async () => {
    const lanAddress = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    expect((await send({})).status).toBe(200);
    await expect(send({ host: "::1" })).rejects.toThrow();
    if (lanAddress) await expect(send({ host: lanAddress })).rejects.toThrow();
  });
});

describe("origine refusée", () => {
  it("refuse un PUT sans modifier le parcellaire", async () => {
    const res = await send({ method: "PUT", headers: { Origin: EVIL_ORIGIN }, body: collectionWith("pirate") });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await storedParcelles()).features[0].id).toBe("initiale");
  });

  it("refuse le préflight d'une écriture", async () => {
    const res = await send({
      method: "OPTIONS",
      headers: { Origin: EVIL_ORIGIN, "Access-Control-Request-Method": "PUT" },
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("refuse aussi la lecture, et un POST de mise à jour des couches", async () => {
    expect((await send({ headers: { Origin: EVIL_ORIGIN } })).status).toBe(403);
    expect((await send({ method: "POST", url: "/api/layers/updates", headers: { Origin: EVIL_ORIGIN } })).status).toBe(403);
  });

  it("refuse Origin: null et une origine locale sur un autre port", async () => {
    for (const origin of ["null", "http://localhost:9999", `https://localhost:${port}`]) {
      const res = await send({ method: "PUT", headers: { Origin: origin }, body: collectionWith("pirate") });
      expect(res.status).toBe(403);
    }
    expect((await storedParcelles()).features[0].id).toBe("initiale");
  });
});

describe("origine autorisée", () => {
  const allowedOrigins = () => [`http://localhost:${port}`, `http://127.0.0.1:${port}`, "http://localhost:5173"];

  it("répond au préflight avec l'origine exacte, jamais *", async () => {
    for (const origin of allowedOrigins()) {
      const res = await send({
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "PUT" },
      });
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-methods"]).toBe("GET,PUT,POST,OPTIONS");
      expect(res.headers.vary).toBe("Origin");
    }
  });

  it("accepte l'écriture", async () => {
    const origin = "http://localhost:5173";
    const res = await send({ method: "PUT", headers: { Origin: origin }, body: collectionWith("depuis-vite") });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(origin);
    expect((await storedParcelles()).features[0].id).toBe("depuis-vite");
  });

  it("accepte une requête sans Origin et ne renvoie alors aucun en-tête CORS", async () => {
    const res = await send({});
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("conserve le 405 sur une méthode non prise en charge", async () => {
    expect((await send({ method: "DELETE" })).status).toBe(405);
    expect((await send({ method: "POST", url: "/api/soilgrids/grid" })).status).toBe(405);
  });
});

describe("en-tête Host (rebinding DNS)", () => {
  it.each(["evil.example", `evil.example:${port}`, "localhost.evil.example", "127.0.0.1.evil.example"])(
    "refuse %s sur l'API comme sur les autres routes",
    async (host) => {
      expect((await send({ headers: { Host: host } })).status).toBe(403);
      expect((await send({ url: "/data/parcelles.geojson", headers: { Host: host } })).status).toBe(403);
    }
  );

  it.each(["localhost", "127.0.0.1", "LOCALHOST", "[::1]"])("accepte %s", async (hostname) => {
    expect((await send({ headers: { Host: `${hostname}:${port}` } })).status).toBe(200);
  });
});

describe("corps trop grand", () => {
  const oversized = "x".repeat(MAX_BODY_BYTES + 1);

  it.each([
    ["PUT", "/api/parcelles"],
    ["POST", "/api/parcelles/matching/validate"],
    ["PUT", "/api/soil-type-mappings"],
  ])("répond 413 sur %s %s", async (method, url) => {
    const res = await send({ method, url, body: oversized });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toContain(String(MAX_BODY_BYTES));
    expect((await storedParcelles()).features[0].id).toBe("depuis-vite");
  });

  it("répond 413 sans Content-Length (envoi par morceaux)", async () => {
    const res = await send({ method: "PUT", chunks: ["x".repeat(1500), "x".repeat(1500)] });
    expect(res.status).toBe(413);
    expect((await storedParcelles()).features[0].id).toBe("depuis-vite");
  });

  it("reste disponible après un 413", async () => {
    await send({ method: "PUT", body: oversized });
    expect((await send({})).status).toBe(200);
  });

  it("répond 400 sur un JSON invalide de taille acceptable", async () => {
    expect((await send({ method: "PUT", body: "{pas du json" })).status).toBe(400);
  });

  it("garde intact un caractère accentué coupé entre deux morceaux", async () => {
    const encoded = Buffer.from(collectionWith("é"), "utf-8");
    const cut = encoded.indexOf(0xc3) + 1;
    const res = await send({ method: "PUT", chunks: [encoded.subarray(0, cut), encoded.subarray(cut)] });
    expect(res.status).toBe(200);
    expect((await storedParcelles()).features[0].id).toBe("é");
    await send({ method: "PUT", body: collectionWith("depuis-vite") });
  });
});

describe("robustesse", () => {
  it("survit à une URL mal encodée", async () => {
    expect((await send({ url: "/data/%E0%A4%A" })).status).toBe(400);
    expect((await send({})).status).toBe(200);
  });
});

describe("buildAccessPolicy", () => {
  const request = (headers) => ({ headers });

  it("autorise les trois origines locales du port par défaut", () => {
    const { origins } = buildAccessPolicy({ port: 4174 });
    expect([...origins]).toEqual(["http://localhost:4174", "http://127.0.0.1:4174", "http://localhost:5173"]);
  });

  it("n'ajoute une origine et son hôte que sur demande explicite", () => {
    const local = buildAccessPolicy({ port: 4174 });
    const headers = { host: "192.168.1.10:4174", origin: "http://192.168.1.10:4174" };
    expect(getAccessDenial(request(headers), local)).not.toBeNull();

    const exposed = buildAccessPolicy({ port: 4174, extraOrigins: "http://192.168.1.10:4174/" });
    expect(getAccessDenial(request(headers), exposed)).toBeNull();
  });

  it("refuse de démarrer avec * comme origine", () => {
    expect(() => buildAccessPolicy({ port: 4174, extraOrigins: "*" })).toThrow(/invalide/);
  });

  it("refuse une requête sans Host", () => {
    expect(getAccessDenial(request({}), buildAccessPolicy({ port: 4174 }))).not.toBeNull();
  });
});
