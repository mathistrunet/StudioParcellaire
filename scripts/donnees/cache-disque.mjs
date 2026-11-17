/**
 * Cache disque des réponses de la GéoPlateforme.
 *
 * Une réponse n'est écrite qu'après avoir été validée par l'appelant : un message
 * d'erreur du service ne doit jamais prendre la place des données. Chaque entrée est un
 * fichier nommé par l'empreinte SHA-256 de l'URL demandée ; sa date de modification fait
 * foi pour l'expiration. Le dossier peut être supprimé à tout moment sans perte.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const JOUR_MS = 24 * 60 * 60 * 1000;

export function creerCacheDisque({ dossier, dureeJours = 30, maintenant = () => Date.now() }) {
  const cheminDe = (cle) => {
    const empreinte = createHash("sha256").update(cle).digest("hex");
    return path.join(dossier, empreinte.slice(0, 2), empreinte);
  };

  return {
    dossier,

    /** Contenu en cache, ou null s'il est absent, expiré ou illisible. */
    async lire(cle) {
      const chemin = cheminDe(cle);
      try {
        const infos = await stat(chemin);
        if (maintenant() - infos.mtimeMs > dureeJours * JOUR_MS) return null;
        return await readFile(chemin);
      } catch {
        return null;
      }
    },

    /** Écriture atomique : un fichier à moitié écrit n'est jamais lu. Un échec est ignoré. */
    async ecrire(cle, contenu) {
      const chemin = cheminDe(cle);
      const temporaire = `${chemin}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(chemin), { recursive: true });
        await writeFile(temporaire, contenu);
        await rename(temporaire, chemin);
      } catch {
        await rm(temporaire, { force: true }).catch(() => {});
      }
    },

    async supprimer(cle) {
      await rm(cheminDe(cle), { force: true }).catch(() => {});
    },
  };
}
