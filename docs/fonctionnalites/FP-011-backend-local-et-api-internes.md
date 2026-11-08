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
- fichiers : `data/parcelles.geojson`, `data/soil-type-mappings.json`, `data/parcel-soilgrids-cache.json`

## Documentation utilisateur

- lancer `npm run backend` avant usage complet de l'application

## Limites / dette

- pas de concurrence multi-utilisateur

## Evolutions recommandees

- documenter formellement chaque endpoint
- preparer une transition eventuelle vers une persistence plus robuste
