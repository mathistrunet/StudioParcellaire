# Cahier des charges - Studio Parcellaire

## 1. Identite du document

- Produit : `Studio Parcellaire`
- Depot : `C:\Users\Mathis Trunet\Documents\GitHub\StudioParcellaire`
- Version du document : `v1 - etat actuel du depot au 21/04/2026`
- Statut du document : `document de reference evolutif`
- Finalite :
  - decrire le produit tel qu'il est implemente aujourd'hui
  - servir de base pour cadrer les futures fonctionnalites
  - suivre l'avancement du developpement
  - faire office de guide d'utilisation des fonctions deja disponibles

## 2. Resume executif

Studio Parcellaire est une application web React de cartographie agricole centree sur la gestion de parcelles. L'outil permet aujourd'hui d'importer, visualiser, modifier, enrichir et exporter des parcelles agricoles.

L'application est deja exploitable sur plusieurs usages metier :

- import de parcelles depuis XML Telepac et ZIP shapefile
- edition cartographique de parcelles sur carte interactive
- export XML Telepac et CSV
- comparaison et validation de correspondances entre parcelles de plusieurs annees
- consultation de couches raster et couches sols
- consultation d'estimations pedologiques SoilGrids
- mapping de types de sols detectes vers des nomenclatures de structure
- nommage automatique de parcelles via toponymie
- remplissage des précédents culturaux au delà du N-2

Le produit reste en phase d'evolution.

### 2.1 Parcours actuellement couverts

Le produit couvre aujourd'hui les parcours suivants :

1. Charger un parcellaire existant.
2. Modifier les geometries et les proprietes des parcelles.
3. Completer ou corriger les cultures, les metadonnees et le nom des parcelles.
4. Comparer des millesimes de parcelles et valider les correspondances.
5. Visualiser des couches cartographiques et des couches de sols.
6. Recuperer des estimations SoilGrids sur une parcelle.
7. Mapper les types de sols detectes vers des types internes a une structure.
8. Exporter les parcelles vers XML Telepac ou CSV.


## 3. Fonctionnalites detaillees dans l'etat actuel

### 3.1 Gestion du parcellaire

Fonctions disponibles :

- affichage cartographique sur MapLibre
- mode `Editor` et mode `Viewer`
- dessin de nouvelles parcelles
- edition de geometries existantes
- suppression / reinitialisation du parcellaire
- selection d'une ou plusieurs parcelles
- filtrage par annee
- filtrage par groupe `layerType`
- stockage temporaire local via `localStorage`
- persistance backend dans une base SQLite (`%APPDATA%StudioParcellaireparcellaire.db`)

Comportements constates :

- l'application normalise les collections GeoJSON
- les parcelles sans annee sont automatiquement completees avec une annee de repli
- l'etat local et backend sont synchronises via `/api/parcelles`

### 3.2 Import de donnees

Formats actuellement pris en charge :

- `XML Telepac`
- `ZIP shapefile`

Comportements metier observes :

- detection de l'annee via metadata, nom de fichier ou fallback
- affectation de colonnes de cultures `cultureN`, `cultureN1`, etc.
- zoom automatique sur l'emprise importee
- resolution asynchrone des recouvrements en mode avertissement
- reprise des metadonnees d'exploitation lorsque possible

### 3.3 Edition des proprietes de parcelles

Champs et familles de champs deja manipules dans l'UI :

- nom de parcelle
- ilot / numero de parcelle
- type de sol
- exploitation, numero pacage, SIRET
- bio / conduite bio / type de conduite bio
- culture N a N-6
- culture N+1
- options avancees de type semences, fermiers, deshydratation, derogation, accident culture, culture secondaire, MAEC

Comportements utiles :

- saisie par code ou libelle culture
- autocompletion depuis le codebook
- warnings en cas de code ou libelle inconnu
- remplissage automatique depuis le RPG pour plusieurs colonnes de culture

### 3.4 Visualisation

Deux modes existent :

- `Editor` : edition et enrichissement
- `Viewer` : consultation filtree

Le mode `Viewer` permet aujourd'hui :

- filtrage par annee
- filtrage multi-selection par culture
- coloration des parcelles par culture
- consultation popup
- ouverture d'un panneau SoilGrids a la parcelle

### 3.5 Export

Formats actuellement disponibles :

- `XML Telepac`
- `CSV`
- un export shapefile existe au niveau composant/service mais n'est pas expose comme export principal dans le menu actuel

Fonctions d'export observees :

- choix de la colonne culture pour l'export XML
- parametrage des champs CSV : secteur, exploitation, numero pacage, nom de structure
- generation locale du fichier cote navigateur

### 3.6 Rapprochement inter-annees

Le produit integre une vue dediee de correspondance entre annees :

- choix de deux annees a comparer
- affichage de deux cartes synchronisees
- suggestions automatiques de correspondance
- tableau de correspondances modifiable
- validation backend via `/api/parcelles/matching/validate`
- fusion logique et suppression de l'ancien millesime selon la strategie actuelle backend

Finalite actuelle :

- conserver la coherence des parcelles d'une annee a l'autre
- relier les historiques lorsqu'une parcelle change de forme, d'identifiant ou de decoupage

### 3.7 Couches cartographiques et donnees externes

Couches et sources actuellement exploitees :

- fonds raster via configuration `RASTER_LAYERS`
- OpenStreetMap / OpenTopoMap / couches IGN selon configuration
- RPG via WFS GeoPlateforme
- carte des sols France via donnees locales
- grille SoilGrids visible
- donnees departementales de sols via GeoPackage
- toponymie via GeoPackage regional

Capacites associees :

- activation / desactivation par couche
- reglage d'opacite
- gel de tuiles sols visibles
- interrogation ponctuelle de donnees contextuelles

### 3.8 Donnees de sols et pedologie

Deux usages distincts existent actuellement.

#### A. Consultation SoilGrids a la parcelle

Disponible dans le `Viewer` :

- interrogation backend par identifiant parcelle
- calcul d'un point de sonde
- cache backend
- resume pedologique
- profil par profondeur
- rafraichissement force

Indicateurs exposes :

- texture
- pH
- matiere organique
- azote
- CEC
- porosite
- reserve utile estimee
- drainage estime
- profondeur cible estimee

Important :

- ces resultats sont presentes comme des estimations heuristiques
- ils ne remplacent pas un diagnostic terrain

#### B. Mapping des types de sols

Disponible dans l'onglet `mapping-sols` :

- detection des combinaisons de sols presentes sur les parcelles
- regroupement par surface et nombre de parcelles
- choix d'une structure
- creation de types de sols cibles
- association d'une combinaison detectee a un type de sol de structure
- sauvegarde backend dans `data/soil-type-mappings.json`
- application du mapping aux parcelles

### 3.9 Nommage automatique par toponymie

Fonction disponible dans l'editeur :

- recherche des points toponymiques proches
- selection de graphies
- attribution automatique de noms de parcelles
- prise en compte d'une logique de resolution de noms

### 3.10 Backend local

Le backend Node actuel sert de couche de persistance et d'acces donnees.

API identifiees :

- `GET/PUT /api/parcelles`
- `POST /api/parcelles/matching/validate`
- `GET/PUT /api/soil-type-mappings`
- `GET /api/parcels/{parcelId}/soilgrids`
- `GET /api/soilgrids/grid`
- `GET /api/soil/department`
- `GET /api/toponymie/points`

Stockages fichiers identifies :

- `%APPDATA%StudioParcellaireparcellaire.db`
- `data/soil-type-mappings.json`
- `data/parcel-soilgrids-cache.json`

## 4. Exigences fonctionnelles

### 4.1 Exigences prioritaires deja couvertes

- importer un parcellaire Telepac ou shapefile
- afficher et modifier des parcelles sur carte
- enrichir les parcelles avec des donnees de culture
- exporter les donnees modifiees
- visualiser des informations de sols
- gerer des millesimes differents

### 4.2 Exigences a consolider

- clarifier la distinction entre donnees temporaires locales et donnees backend
- formaliser les regles de fusion inter-annees
- stabiliser les parcours d'erreur et les messages utilisateur
- uniformiser les formats et encodages utilises dans toute l'application
- standardiser le statut fonctionnel de l'export shapefile

## 5. Exigences non fonctionnelles

### 5.1 Technique

- application web front en React + Vite
- cartographie MapLibre
- backend Node local base sur serveur HTTP
- donnees geographiques en GeoJSON, GeoPackage, CSV, XML

### 5.2 Performance

Exigences souhaitees :

- chargement acceptable de grands parcellaires
- rendu fluide des couches cartographiques
- reponse exploitable pour les requetes soils et matching

Constat actuel :

- le build passe
- les bundles de production sont volumineux
- certains chunks depassent largement les seuils d'alerte Vite

### 5.3 Fiabilite

Attendus :

- pas de perte de donnees en cas de refresh
- sauvegarde locale de secours
- degradation acceptable si le backend local n'est pas disponible

Etat constate :

- fallback localStorage present
- backend fichier simple, efficace pour usage local
- pas de mecanisme de concurrence multi-session

### 5.4 Maintenabilite

Points positifs :

- beaucoup de logique est isolee dans `services`, `utils`, `features`, `domain`
- presence de tests unitaires et fonctionnels sur plusieurs briques

Points de vigilance :

- certains gros composants concentrent beaucoup de responsabilites, notamment `ParcellesEditorMap.jsx` et `ParcelleEditor.jsx`
- documentation produit encore insuffisante jusqu'a ce document

## 6. Architecture fonctionnelle et technique

### 6.1 Frontend

Structure principale :

- `src/App.jsx` : bascule `Viewer` / `Editor`
- `src/maps/parcelles/ParcellesEditorMap.jsx` : ecran principal d'edition
- `src/maps/parcelles/ParcellesViewerMap.jsx` : ecran de consultation
- `src/components/*` et `src/Front/*` : composants metier et actions UI

### 6.2 Backend

- `scripts/geojson-server.mjs`

Role :

- lecture/ecriture des donnees locales
- mediation vers SoilGrids
- requetes GeoPackage
- validation des correspondances inter-annees

### 6.3 Donnees et referentiels

Referentiels identifies :

- cultures Assolia
- codebooks et colorbooks front
- donnees de sols RRP
- GeoPackages departementaux et regionaux
- fixtures de tests Telepac / CSV

## 7. Documentation associee

Les documents suivants completent ce cahier des charges :

- guide d'installation et d'utilisation : [GUIDE_INSTALLATION_UTILISATION.md](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/GUIDE_INSTALLATION_UTILISATION.md)
- suivi des fonctionnalites : [SUIVI_FONCTIONNALITES.md](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/SUIVI_FONCTIONNALITES.md)
- fiches detaillees par fonctionnalite : [fonctionnalites/README.md](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/README.md)

## 8. Risques, limites et dette technique constates

### 8.1 Risques fonctionnels

- forte dependance a des conventions de proprietes GeoJSON parfois heterogenes
- parcours d'import avec prompts navigateur peu industrialises
- absence de gestion multi-utilisateur et de verrouillage

### 8.2 Risques techniques

- taille importante des bundles front
- composants front tres volumineux
- dependance a des fichiers de donnees lourds en local
- dependance a des sources externes pour certaines donnees

### 8.3 Points constates pendant verification

- `npm run build` reussit
- `npm run test -- --run` a echoue dans cet environnement a cause d'une erreur `spawn EPERM` lors du chargement de la config Vite, ce qui ne permet pas ici de certifier l'execution de la suite de tests
- le build remonte aussi des avertissements sur :
  - la taille de certains chunks
  - des scripts `codebook.js`, `codebookV2.js`, `colorbook.js` references dans `index.html` hors bundling standard

## 9. Backlog fonctionnel recommande

### 9.1 Priorite 1

- stabiliser et documenter le cycle complet import > edition > export
- clarifier le modele de donnees parcelle et les champs attendus
- reduire la taille et la complexite des gros composants
- fiabiliser l'execution automatisee des tests
- formaliser l'usage de l'export shapefile

### 9.2 Priorite 2

- ajouter un tableau de bord de suivi d'avancement produit
- renforcer les messages d'erreur et notifications utilisateur
- proposer un mode d'import CSV parcellaire directement dans l'UI si besoin metier

## 10. Criteres d'acceptation globaux recommandes

Une fonctionnalite future devra etre consideree comme livree si :

- son comportement attendu est documente
- son parcours utilisateur est testable de bout en bout
- ses erreurs connues sont gerees
- son impact sur import/export et donnees parcelles est verifie
- son statut est mis a jour dans ce document

## 11. Recommandations de gouvernance du document

- mettre a jour ce document a chaque lot fonctionnel significatif
- conserver l'historique des versions
- ajouter un changelog produit synthetique
- distinguer dans chaque mise a jour :
  - ce qui est en production locale utilisable
  - ce qui est experimental
  - ce qui est seulement present dans le code mais non expose a l'utilisateur
