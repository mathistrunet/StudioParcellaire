# Suivi des fonctionnalites - Studio Parcellaire

## 1. Objet du document

Ce document centralise le suivi de l'etat des fonctionnalites de Studio Parcellaire.

Statuts recommandes :

- `A cadrer`
- `En conception`
- `En cours`
- `Partiel`
- `Implante`
- `A consolider`
- `Non implemente`

Priorites recommandees :

- `P1`
- `P2`
- `P3`

## 2. Tableau de suivi

| ID | Fonctionnalite | Statut | Priorite | Commentaire | Fiche |
| --- | --- | --- | --- | --- | --- |
| FP-001 | Gestion du parcellaire | Implante | P1 | Coeur de l'application, edition et persistance presentes | [FP-001](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-001-gestion-du-parcellaire.md) |
| FP-002 | Import de donnees | Implante | P1 | Import XML Telepac, ZIP shapefile et CSV parcellaire | [FP-002](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-002-import-de-donnees.md) |
| FP-003 | Edition des proprietes et cultures | Implante | P1 | Edition riche, cultures jusqu'a N-6 et N+1 | [FP-003](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-003-edition-des-proprietes-et-cultures.md) |
| FP-004 | Visualisation Viewer | Implante | P1 | Consultation filtree par annee et culture | [FP-004](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-004-visualisation-viewer.md) |
| FP-005 | Export des donnees | Partiel | P1 | XML et CSV exposes, shapefile a clarifier | [FP-005](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-005-export-des-donnees.md) |
| FP-006 | Rapprochement inter-annees | Implante | P1 | Interface, fusion et propagation culture (cultureN1) corrigees et testees | [FP-006](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-006-rapprochement-inter-annees.md) |
| FP-007 | Couches cartographiques et donnees externes | Implante | P2 | Fonds, RPG, sols, toponymie | [FP-007](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-007-couches-cartographiques-et-donnees-externes.md) |
| FP-008 | Consultation SoilGrids par parcelle | Implante | P2 | Viewer + cache + resume + profil | [FP-008](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-008-consultation-soilgrids-par-parcelle.md) |
| FP-009 | Mapping des types de sols | Implante | P2 | Mapping par structure sauvegarde en backend | [FP-009](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-009-mapping-des-types-de-sols.md) |
| FP-010 | Nommage automatique par toponymie | Implante | P2 | Automatisation disponible, a consolider metierement | [FP-010](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-010-nommage-automatique-par-toponymie.md) |
| FP-011 | Backend local et API internes | Implante | P1 | Persistance et services d'acces locaux | [FP-011](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-011-backend-local-et-api-internes.md) |
| FP-012 | API v1 des donnees publiques | Implante | P2 | Relief, RPG, BD TOPO et parcellaire en lecture, cache disque | [FP-012](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/FP-012-api-v1-donnees-publiques.md) |

## 3. Points transverses a suivre

### 3.1 Stabilite

- fiabiliser l'execution des tests
- clarifier les ecarts entre environnement local et environnement sandbox

### 3.2 Performance

- reduire la taille des bundles
- simplifier les gros composants front

### 3.3 Documentation

- maintenir ce tableau a jour a chaque lot
- lier chaque evolution a la fiche fonctionnelle concernee

## 4. Regle de mise a jour

Pour toute evolution :

1. mettre a jour le statut dans ce tableau
2. completer la fiche fonctionnelle correspondante
3. ajouter les decisions, limites et impacts techniques dans la fiche
