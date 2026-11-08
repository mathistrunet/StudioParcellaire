/**
 * Règles d'accès du serveur local : qui peut lui parler, et avec quel volume.
 *
 * Le parcellaire appartient aux exploitants et doit rester sur le poste. Le serveur
 * n'a pas d'authentification : ces contrôles empêchent un autre poste du réseau ou
 * un site ouvert dans le navigateur de le lire ou de l'écraser.
 */

export const DEFAULT_HOST = "127.0.0.1";
// Un parcellaire est réécrit en entier à chaque enregistrement : la limite doit rester
// large pour lui, tout en empêchant de saturer la mémoire du serveur.
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

const LOOPBACK_BIND_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const VITE_DEV_ORIGIN = "http://localhost:5173";

export const isLoopbackAddress = (host) => LOOPBACK_BIND_ADDRESSES.has(host);

/**
 * Construit la liste des origines et des noms d'hôte acceptés.
 * `extraOrigins` (STUDIO_ALLOWED_ORIGINS) est le seul moyen d'en ajouter : une valeur
 * qui n'est pas une origine, comme `*`, fait échouer le démarrage plutôt que d'ouvrir
 * le serveur par erreur.
 */
export function buildAccessPolicy({ port, extraOrigins = "" }) {
  const extras = String(extraOrigins)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value);
      } catch {
        throw new Error(`Origine autorisée invalide : "${value}" (attendu : http://hote:port).`);
      }
    });

  return {
    origins: new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      VITE_DEV_ORIGIN,
      ...extras.map((url) => url.origin),
    ]),
    hostnames: new Set([...LOCAL_HOSTNAMES, ...extras.map((url) => url.hostname)]),
  };
}

const hostnameOf = (hostHeader) =>
  String(hostHeader || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");

/**
 * Motif de refus d'une requête, ou null si elle est acceptée.
 *
 * - `Host` : un nom non local signale un rebinding DNS (evil.example pointant sur
 *   127.0.0.1). Le navigateur croit alors parler à evil.example et le CORS ne protège
 *   plus rien : c'est pourquoi ce contrôle couvre toutes les routes.
 * - `Origin` : refusée pour toute méthode, lecture comprise, car un GET peut déclencher
 *   un téléchargement ou un appel ISRIC. `Origin: null` (fichier local, iframe isolée)
 *   est refusée aussi. Son absence reste acceptée : un navigateur l'envoie toujours sur
 *   PUT/POST, donc seuls les clients hors navigateur s'en passent.
 */
export function getAccessDenial(req, policy) {
  if (!policy.hostnames.has(hostnameOf(req.headers.host))) {
    return "En-tête Host non autorisé.";
  }
  const { origin } = req.headers;
  if (origin !== undefined && !policy.origins.has(origin)) {
    return "Origine non autorisée.";
  }
  return null;
}

/**
 * En-têtes communs des routes /api. Renvoie true si la réponse est déjà terminée
 * (préflight ou méthode non prise en charge). L'origine a déjà été validée par
 * getAccessDenial : si elle est présente, on peut la renvoyer telle quelle.
 */
export function prepareApiResponse(req, res, methods) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Vary", "Origin");
  if (req.headers.origin) res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
  res.setHeader("Access-Control-Allow-Methods", [...methods, "OPTIONS"].join(","));
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return true;
  }
  if (!methods.includes(req.method)) {
    res.writeHead(405).end(JSON.stringify({ error: "Method not allowed." }));
    return true;
  }
  return false;
}

export class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Corps de requête trop volumineux (limite : ${maxBytes} octets).`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Lit le corps d'une requête sans jamais garder plus de `maxBytes` en mémoire.
 * Les morceaux sont assemblés en octets : un caractère accentué coupé entre deux
 * morceaux reste intact.
 */
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > maxBytes) {
      reject(new BodyTooLargeError(maxBytes));
      return;
    }
    let chunks = [];
    let received = 0;
    const onData = (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.off("data", onData);
        chunks = [];
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.once("error", reject);
    req.once("close", () => {
      if (!req.complete) reject(new Error("Requête interrompue."));
    });
  });
}

/** Répond 413 pour un corps trop gros, 400 pour tout autre échec de lecture ou d'analyse. */
export function sendBodyError(req, res, error) {
  const tooLarge = error instanceof BodyTooLargeError;
  res.writeHead(tooLarge ? 413 : 400);
  res.end(JSON.stringify({ error: error?.message || "Invalid JSON payload." }));
  // Le reste de l'envoi est jeté sans être stocké : fermer tout de suite empêcherait
  // le client, encore en train d'écrire, de lire le 413.
  if (tooLarge) req.resume();
}
