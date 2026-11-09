# FP-012 - API v1 des donnees publiques

- ID : `FP-012`
- Statut : `Implante`
- Priorite : `P2`

## Objectif utilisateur

Lire le relief, la vegetation, le RPG et la BD TOPO autour de son exploitation par le
serveur local, plutot que depuis le navigateur. Les donnees deja telechargees sont gardees
sur le poste : une deuxieme ouverture est rapide et ne sollicite plus l'IGN.

Premier client : le jeu de gestion de ferme (branche `Visuel3D`, dossier `jeu/`), qui ne
lit les donnees publiques qu'a travers cette API. La carte et les exports ASSOLIA pourront
s'en servir aussi.

## Perimetre actuel

| Route | Contenu | Source IGN |
| --- | --- | --- |
| `GET /api/v1/parcelles` | Parcellaire de l'utilisateur, en lecture seule | Base locale |
| `GET /api/v1/terrain` | Grille d'altitude ou de hauteur, binaire float32 | WMS GeoPlateforme |
| `GET /api/v1/rpg` | Parcelles du RPG d'une campagne (2015 a 2025) | WFS GeoPlateforme |
| `GET /api/v1/bdtopo` | Batiments, routes, plans d'eau, cours d'eau | WFS GeoPlateforme |

Contrat detaille (parametres, formats, erreurs) : `docs/api/openapi-v1.json`.

### Couches de terrain

| `couche` | Ce que c'est | Precision |
| --- | --- | --- |
| `mnt-lidar` | Relief du sol, LiDAR HD | 50 cm a 1 m, couverture nationale en cours |
| `mnh-lidar` | Hauteur des arbres et du bati au-dessus du sol, LiDAR HD | 50 cm a 1 m |
| `rge-alti` | Relief du sol, RGE ALTI | 1 a 5 m, toute la France |
| `srtm` | Relief mondial | environ 90 m, dernier recours |

Le client choisit la source et combine : par exemple LiDAR HD d'abord, puis RGE ALTI la ou
le LiDAR manque.

## Attendus fonctionnels

- seules les couches listees sont servies : l'API n'est pas un relais ouvert vers l'IGN
- un parametre faux est refuse (400) sans appel a l'IGN, avec un message en francais
- une panne de l'IGN rend 502 avec le code `IGN_INDISPONIBLE`, jamais une grille vide
- un message d'erreur de l'IGN servi en HTTP 200 n'est jamais mis en cache
- une meme demande faite deux fois en meme temps n'est telechargee qu'une fois

## Regles et limites de parametres

| Parametre | Regle | Pourquoi |
| --- | --- | --- |
| `bbox` | `ouest,sud,est,nord` en degres, au plus 0,25 deg de cote | Une ferme tient dans 20 km ; au-dela, des centaines de Mo |
| `largeur`, `hauteur` | 1 a 1024 points | Une reponse tient dans 4 Mo ; les grandes grilles se demandent par tuiles |
| `max` | 1 a 5000 objets, 5000 par defaut | `tronque: true` signale qu'il en existe davantage |
| `annee` | millesime publie (2015 a 2025) | 2014 n'est pas publie par le WFS |

## Donnees produites

- reponses JSON (GeoJSON en CRS:84) ou binaire (`application/octet-stream`)
- cache disque : `%APPDATA%\StudioParcellaire\cache\geoplateforme\`, un fichier par
  requete IGN, nomme par l'empreinte SHA-256 de l'URL, valable 30 jours. Le dossier peut
  etre supprime a tout moment.

## Technique

| Fichier | Role |
| --- | --- |
| `scripts/donnees/couches.mjs` | Catalogue des couches et controle des parametres |
| `scripts/donnees/geoplateforme.mjs` | Construction des URL WMS/WFS, telechargement, validation, reprises, 4 telechargements au plus en parallele |
| `scripts/donnees/cache-disque.mjs` | Cache fichier avec ecriture atomique et expiration |
| `scripts/donnees/routes.mjs` | Routes HTTP GET, codes d'erreur |
| `scripts/donnees/donnees.test.mjs` | Tests (26) |

Points techniques a connaitre :

- en WMS 1.3.0, `EPSG:4326` s'ecrit latitude d'abord : `BBOX=sud,ouest,nord,est`
- en WFS, la `bbox` doit finir par `,CRS:84`, sinon le service repond 200 avec une liste vide
- l'IGN signale l'absence de donnee par -9999 ou -99999 : la grille est renvoyee telle
  quelle et le client traite ces valeurs
- un 429 de l'IGN est respecte (`Retry-After`, plafonne a 10 s) puis la demande est
  retentee une fois ; une erreur 5xx ou reseau est retentee une fois ; une erreur 4xx ne
  l'est pas

## Limites / dette

- pas de limite de taille totale du cache : il grossit avec les emprises consultees
- pas encore de route `/api/v1/prix` (baremes publics) : prevue avec l'economie du jeu
- le RPG est lu tel que publie : pas de fusion avec le parcellaire de l'utilisateur

## Suivi

- 2026-11-09 : creation (relief, RPG, BD TOPO, parcellaire en lecture, cache disque)
