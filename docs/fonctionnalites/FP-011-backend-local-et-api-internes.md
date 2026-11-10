# FP-011 - Backend local et API internes

- ID : `FP-011`
- Statut : `Implante`
- Priorite : `P1`

## Objectif utilisateur

Fournir une couche locale simple de persistance et de services pour supporter l'application sans infrastructure distante complexe.

## Perimetre actuel

- lecture/ecriture des parcelles
- validation des correspondances inter-annees
- mappings de sols
- acces SoilGrids
- acces grille SoilGrids
- lecture GeoPackage sols
- lecture GeoPackage toponymie
- enrichissement sans etat d'une parcelle : `POST /api/v1/enrich`, contrat dans `docs/api/openapi-v1.json`, service dans `scripts/enrich/`
- fiches parcelles (nom, surface, culture, bio, Telepac, historique) et donnees publiques (relief, RPG, BD TOPO) : `GET /api/v1/parcelles`, `/api/v1/parcelles/{id}`, `GET /api/v1/terrain`, `/api/v1/rpg`, `/api/v1/bdtopo`, service dans `scripts/donnees/` (voir FP-012)

## Attendus fonctionnels

- reponse locale rapide
- persistance fiable pour un usage mono-poste
- endpoints stables pour le frontend

## Donnees d'entree

- requetes frontend
- fichiers locaux
- services externes selon endpoint

## Donnees produites

- reponses JSON
- fichiers de persistance mis a jour

## Technique

- serveur : `scripts/geojson-server.mjs`
- regles d'acces (ecoute locale, origines, `Host`, taille des corps) : `scripts/http-security.mjs`, options dans le README
- base SQLite : `%APPDATA%\StudioParcellaire\parcellaire.db` (parcellaire, mappings de sols, sauvegardes), caches SoilGrids dans le meme dossier
- `data/parcelles.geojson` n'est lu qu'une fois, pour reprendre un ancien parcellaire

## Documentation utilisateur

- lancer `npm run backend` avant usage complet de l'application

## Limites / dette

- pas de concurrence multi-utilisateur
- `POST /api/v1/enrich` : environ 10 s par appel quand le nom est demande (lecture du GeoPackage de toponymie) ; l'interface s'en passe avec `inclure_nom: false`
- `POST /api/v1/enrich` : `bio` n'est connu que si 2025 figure dans les millesimes demandes, et le WFS limite le debit (requetes espacees et `Retry-After` respecte par `scripts/enrich/rpg-wfs-client.mjs`)

## Evolutions recommandees

- documenter formellement chaque endpoint
- proposer une liste complete des sauvegardes dans l'interface
