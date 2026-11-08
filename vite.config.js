import { cp, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Recopie `public/` dans le build en laissant de côté `public/data`.
 *
 * Les couches locales (cartes des sols, toponymie, RPG Roumanie) pèsent plusieurs
 * gigaoctets et ne sont jamais téléchargées par le navigateur : le front les
 * interroge via l'API du serveur local, qui les lit directement dans
 * `public/data`. Les recopier dans `dist/` doublait l'espace disque et rendait
 * l'application impossible à partager.
 */
const copyPublicWithoutData = () => ({
  name: "copy-public-sans-donnees",
  apply: "build",
  async closeBundle() {
    const publicDir = path.join(projectRoot, "public");
    const outDir = path.join(projectRoot, "dist");
    let entries = [];
    try {
      entries = await readdir(publicDir, { withFileTypes: true });
    } catch {
      return; // pas de dossier public : rien à recopier
    }
    for (const entry of entries) {
      if (entry.name === "data") continue;
      await cp(path.join(publicDir, entry.name), path.join(outDir, entry.name), {
        recursive: true,
      });
    }
  },
});

const _require = createRequire(import.meta.url);
// Resolve polygon-clipping ESM via Node module resolution (works in worktrees where
// node_modules is hoisted to the repo root, not the worktree subdirectory).
const polygonClippingEsm = _require.resolve(
  "polygon-clipping/dist/polygon-clipping.esm.js",
);

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), copyPublicWithoutData()],
  // La recopie de `public/` est prise en charge par le plugin ci-dessus.
  build: { copyPublicDir: false },
  server: {
    proxy: {
      // Adresse explicite : le backend n'écoute que sur 127.0.0.1, alors que
      // « localhost » peut se résoudre d'abord en ::1 sous Windows.
      "/api": {
        target: "http://127.0.0.1:4174",
        changeOrigin: true,
      },
      // Référentiels et couches : le backend les télécharge à la demande.
      "/data": {
        target: "http://127.0.0.1:4174",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "polygon-clipping": polygonClippingEsm,
    },
  },
  optimizeDeps: {
    include: ["polygon-clipping"],
  },
  test: {
    // Les copies de travail des sessions Claude ne sont pas le projet à tester.
    exclude: [...configDefaults.exclude, ".claude/**"],
    resolve: {
      alias: {
        "polygon-clipping": polygonClippingEsm,
      },
    },
  },
});
