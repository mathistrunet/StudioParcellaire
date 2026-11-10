/**
 * Routes GET de l'API v1 des données publiques. L'accès (Host, Origin) est contrôlé en
 * amont par le serveur ; ces routes ne font que lire. Contrat : docs/api/openapi-v1.json.
 *
 *   /api/v1/parcelles       fiches parcelles d'une année (GeoJSON) : nom, surface, culture,
 *                           bio, Télépac, historique des cultures
 *   /api/v1/parcelles/{id}  la fiche d'une parcelle
 *   /api/v1/terrain    grille d'altitude (float32), couche mnt-lidar | mnh-lidar | rge-alti | srtm
 *   /api/v1/rpg        parcelles du RPG d'une année (GeoJSON)
 *   /api/v1/bdtopo     objets BD TOPO (GeoJSON), couche batiments | routes | surfaces-eau | cours-eau
 */
import { prepareApiResponse } from "../http-security.mjs";
import {
  COUCHES_BDTOPO,
  COUCHES_TERRAIN,
  DonneesInvalides,
  OBJETS_MAX,
  TUILE_MAX,
  getRpgTypeName,
  lireAnneeRpg,
  lireCouche,
  lireEmprise,
  lireEntier,
} from "./couches.mjs";
import { HISTORIQUE_DEFAUT, HISTORIQUE_MAX } from "./fiche-parcelle.mjs";
import { IgnIndisponible } from "./geoplateforme.mjs";

export const ROUTES_DONNEES = ["/api/v1/parcelles", "/api/v1/terrain", "/api/v1/rpg", "/api/v1/bdtopo"];
const ROUTE_FICHE = /^\/api\/v1\/parcelles\/([^/]+)$/;

const envoyerJson = (res, status, contenu) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(contenu));
};

const lireMax = (params) =>
  lireEntier(params.get("max"), { nom: "max", min: 1, max: OBJETS_MAX, defaut: OBJETS_MAX });

class RessourceAbsente extends Error {}

/** annee (facultative : la plus récente), historique (1 à 7 ans), rpg=non pour s'en passer. */
function optionsFiches(params) {
  const rpg = params.get("rpg");
  if (rpg !== null && rpg !== "oui" && rpg !== "non") throw new DonneesInvalides("rpg vaut oui ou non.");
  return {
    annee: params.get("annee") === null ? null : lireEntier(params.get("annee"), { nom: "annee", min: 1990, max: 2100 }),
    historique: lireEntier(params.get("historique"), {
      nom: "historique", min: 1, max: HISTORIQUE_MAX, defaut: HISTORIQUE_DEFAUT,
    }),
    rpg: rpg !== "non",
  };
}

/**
 * @param client       client GéoPlateforme (creerClientGeoplateforme)
 * @param parcelles    service des fiches parcelles (creerServiceParcelles)
 * @returns (req, res, url) => Promise<boolean> : false si la route n'est pas la sienne
 */
export function creerRoutesDonnees({ client, parcelles, signalerErreur = () => {} }) {
  const routes = {
    async "/api/v1/parcelles"(params) {
      return { json: await parcelles.lister(optionsFiches(params)) };
    },
    async "/api/v1/terrain"(params) {
      const largeur = lireEntier(params.get("largeur"), { nom: "largeur", min: 1, max: TUILE_MAX });
      const hauteur = lireEntier(params.get("hauteur"), { nom: "hauteur", min: 1, max: TUILE_MAX });
      const couche = lireCouche(params.get("couche"), COUCHES_TERRAIN);
      const emprise = lireEmprise(params.get("bbox"));
      return { binaire: await client.altitudes({ couche, emprise, largeur, hauteur }) };
    },
    async "/api/v1/rpg"(params) {
      const typeName = getRpgTypeName(lireAnneeRpg(params.get("annee")));
      const emprise = lireEmprise(params.get("bbox"));
      return { json: await client.objets({ typeName, emprise, max: lireMax(params) }) };
    },
    async "/api/v1/bdtopo"(params) {
      const typeName = lireCouche(params.get("couche"), COUCHES_BDTOPO);
      const emprise = lireEmprise(params.get("bbox"));
      return { json: await client.objets({ typeName, emprise, max: lireMax(params) }) };
    },
  };

  return async function routerDonnees(req, res, url) {
    const fiche = url.pathname.match(ROUTE_FICHE);
    const route = fiche
      ? async (params) => {
        const id = decodeURIComponent(fiche[1]);
        const trouvee = await parcelles.lire(id, optionsFiches(params));
        if (!trouvee) throw new RessourceAbsente(`Parcelle ${id} introuvable pour cette année.`);
        return { json: trouvee };
      }
      : Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : null;
    if (!route) return false;
    if (prepareApiResponse(req, res, ["GET"])) return true;
    try {
      const resultat = await route(url.searchParams);
      if (resultat.binaire) {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": resultat.binaire.byteLength,
        });
        res.end(resultat.binaire);
      } else {
        envoyerJson(res, 200, resultat.json);
      }
    } catch (error) {
      if (error instanceof RessourceAbsente) {
        envoyerJson(res, 404, { error: error.message, code: "PARCELLE_INCONNUE" });
      } else if (error instanceof DonneesInvalides) {
        envoyerJson(res, 400, { error: error.message, code: error.code });
      } else if (error instanceof IgnIndisponible) {
        signalerErreur(error);
        envoyerJson(res, 502, { error: error.message, code: error.code });
      } else {
        signalerErreur(error);
        envoyerJson(res, 500, { error: "Erreur interne du serveur.", code: "ERREUR_INTERNE" });
      }
    }
    return true;
  };
}
