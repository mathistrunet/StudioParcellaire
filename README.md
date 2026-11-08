# Studio Parcellaire

Application locale de préparation de parcellaire agricole : on importe un
parcellaire existant, on corrige les contours sur une carte, on complète les
informations (nom, surface, conduite AB, cultures N à N-6, type de sol), puis on
exporte vers Assolia (CSV), Télépac (XML) ou un SIG (shapefile).

Le parcellaire reste enregistré sur le poste. Seuls des services en ligne sont
interrogés à la demande : fonds de carte, RPG, toponymie IGN et SoilGrids (qui
reçoit les coordonnées des parcelles lors du remplissage du type de sol).

## Démarrage rapide (Windows)

Double-cliquez sur **`StudioParcellaire.exe`** à la racine du projet. Le lanceur
installe les dépendances si nécessaire, construit l'interface, démarre le
serveur local et ouvre le navigateur sur <http://localhost:4174>. Fermer la
fenêtre du lanceur arrête le serveur.

Seul prérequis : [Node.js](https://nodejs.org/) 22.13 ou plus récent (version LTS).

Pour régénérer l'exécutable après modification du lanceur :

```bash
npm run build:exe
```

Le lanceur est compilé avec `csc.exe`, fourni avec Windows : aucune dépendance
supplémentaire n'est nécessaire.

## Démarrage manuel

```bash
npm install
npm start
```

`npm start` construit l'interface puis démarre le serveur sur
<http://localhost:4174>, qui sert à la fois l'application et l'API locale.

Pour développer avec rechargement à chaud, deux terminaux :

```bash
npm run backend   # API locale sur le port 4174
npm run dev       # interface sur http://localhost:5173
```

### Sécurité du serveur local

Le serveur n'a pas d'authentification. Il n'écoute donc que sur `127.0.0.1` et
refuse les requêtes venant d'une autre origine que l'application (ports 4174 et
5173) ou portant un en-tête `Host` non local. Ces réglages se changent par
variables d'environnement :

| Variable                 | Rôle                                                  | Défaut            |
| ------------------------ | ----------------------------------------------------- | ----------------- |
| `STUDIO_HOST`            | Adresse d'écoute                                      | `127.0.0.1`       |
| `STUDIO_ALLOWED_ORIGINS` | Origines ajoutées, séparées par des virgules          | aucune            |
| `STUDIO_MAX_BODY_BYTES`  | Taille maximale d'un corps PUT/POST (au-delà : `413`) | 100 Mo            |

Exposer le serveur sur le réseau demande les deux premières options. Tout poste
qui atteint alors le port peut lire et écraser le parcellaire : ne le faites
que sur un réseau de confiance.

```bash
STUDIO_HOST=0.0.0.0 STUDIO_ALLOWED_ORIGINS=http://192.168.1.10:4174 npm run backend
```

### API d'enrichissement

`POST /api/v1/enrich` enrichit une parcelle à partir d'un point ou d'un contour :
contour et surface RPG, nom, cultures par millésime, conduite bio. Rien n'est
conservé côté serveur. Le contrat est dans
[`docs/api/openapi-v1.json`](docs/api/openapi-v1.json).

```bash
curl -X POST http://localhost:4174/api/v1/enrich -H "Content-Type: application/json" -d '{"geometry":{"type":"Point","coordinates":[1.6,48.2]},"millesimes":[2025,2024]}'
```

## Fonctionnement de l'outil

Le bouton **Guide**, en haut à droite de l'application, ouvre une fenêtre qui
résume le fonctionnement. En résumé :

1. **Importer** un parcellaire — le format est détecté automatiquement.
2. **Corriger** les contours avec les outils de dessin (dessiner, découper,
   fusionner, supprimer, résoudre les chevauchements).
3. **Compléter** les informations dans le panneau de droite, en fiches ou en
   tableau.
4. **Exporter** en CSV Assolia, XML Télépac ou shapefile.

### Formats d'import acceptés

| Format | Extensions | Remarques |
| --- | --- | --- |
| XML Télépac | `.xml` | Export de déclaration PAC ; une fenêtre demande la colonne de culture visée. |
| Shapefile | `.zip` ou dossier | Le LPIS roumain (Stereo70) est reconnu et reprojeté automatiquement. |
| GeoJSON | `.geojson`, `.json` | WGS84, Lambert-93, Web Mercator ou Stereo70. |
| KML / KMZ | `.kml`, `.kmz` | Seuls les polygones deviennent des parcelles. |
| GeoPackage | `.gpkg` | Première couche géométrique du fichier. |
| CSV | `.csv` | Tableau avec colonne de géométrie. |

Les géométries non surfaciques (points, lignes) sont ignorées. Les imports
successifs s'ajoutent au parcellaire courant, y compris pour des millésimes
différents.

### Périmètre de cette version

Le type de sol se saisit manuellement ou se déduit automatiquement :

- **Remplir la colonne / Remplir WRB** (tableau) : interroge SoilGrids pour chaque
  parcelle ; une pastille indique la confiance et ℹ️ ouvre le détail.
- **Sols présentés** (onglet) : associe les sols détectés sur la carte des sols
  France aux types de sol d'une structure. La carte doit être affichée.
- **Grille SoilGrids** (onglet Calques) : affiche les pixels sur l'emprise visible.

L'application démarre sans parcellaire enregistré. Le travail en cours est
sauvegardé automatiquement sur le poste et rechargé à l'ouverture suivante ; le
bouton **Réinitialiser** de la barre d'outils efface tout, et une sauvegarde
permet de revenir en arrière tant que le parcellaire reste vide.

## Où sont les données

Le parcellaire, les associations de sols et les caches SoilGrids sont enregistrés
hors du dossier de l'application, dans `%APPDATA%StudioParcellaire` sous Windows
(base SQLite `parcellaire.db`). Arrêter le serveur, remplacer le dossier de
l'application ou la mettre à jour n'y touche pas. Rien n'est envoyé sur Internet,
hormis les coordonnées transmises aux services en ligne lorsqu'on les interroge.

Au premier démarrage, `data/parcelles.geojson` est repris dans la base s'il existe ;
ce fichier n'est ni modifié ni supprimé, mais il n'est plus lu ensuite. La variable
d'environnement `STUDIO_DATA_DIR` permet de choisir un autre dossier.

## Configuration optionnelle

Certaines couches IGN nécessitent une clé GeoPlateforme. Créez un fichier
`.env` à partir de `.env.example` et renseignez `VITE_GEO_PORTAIL_API_KEY`.
Sans clé, les couches ouvertes (OpenStreetMap, OpenTopoMap, satellite ESRI)
restent disponibles.

## Couches cartographiques

Les couches locales (carte des sols par département, toponymie par région,
parcellaire roumain) pèsent 3,4 Go au total. Elles ne sont **pas** versionnées :
elles sont publiées dans les Releases GitHub et téléchargées à la demande.

Concrètement, une installation neuve pèse quelques mégaoctets. La première fois
qu'un utilisateur affiche la carte des sols sur un département, le serveur local
récupère le fichier correspondant (~8 Mo) et le range dans `public/data/` ; les
fois suivantes, c'est instantané et hors ligne. Le parcellaire roumain est
filtré par emprise : seules les régions visibles à l'écran sont récupérées.

Le fichier `data-layers.json`, lui, est versionné : il décrit chaque couche
(URL, taille, emprise, date de publication) et sert d'annuaire au téléchargement.

### Mise à jour des cartes

Au démarrage, le serveur interroge les Releases et compare la date de
publication de chaque couche à celle du fichier présent sur le poste. Si une
carte a été republiée depuis, un encart apparaît dans l'onglet Calques — avec
une pastille sur l'onglet pour le signaler sans avoir à l'ouvrir.

« Mettre à jour » écarte simplement les copies périmées : la version à jour est
reprise au prochain affichage de la couche, ce qui évite d'imposer plusieurs
centaines de mégaoctets à l'ouverture de l'application.

La vérification est mise en cache 24 h (`data/layer-update-check.json`) pour
rester sous le quota de l'API GitHub anonyme, et reste silencieuse hors ligne :
sans réseau, l'application fonctionne avec ses couches actuelles.

Pour republier les couches après les avoir mises à jour :

```bash
npm run publish:layers            # envoie ce qui manque, puis régénère le manifeste
npm run publish:layers -- --dry-run
npm run publish:layers -- --dataset soilmap
```

La commande est idempotente et s'appuie sur la [CLI GitHub](https://cli.github.com/)
(`gh auth login` au préalable). Les couches déjà en ligne sont ignorées.

Une installation hors ligne reste possible : il suffit de copier à la main les
fichiers voulus dans `public/data/`, l'application les utilise tels quels sans
rien télécharger.

## Qualité

```bash
npm run lint
npm test
```
