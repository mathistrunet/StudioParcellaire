# FP-012 - API v1 : fiches parcelles et donnees publiques

- ID : `FP-012`
- Statut : `Implante`
- Priorite : `P2`

## Objectif utilisateur

Disposer d'une fiche parcelle unique et stable (nom, surface, culture, bio, references
Telepac, historique des cultures sur 5 a 7 ans), quelle que soit la provenance du
parcellaire (Telepac XML, CSV Assolia, shapefile, saisie), pour ASSOLIA, le Studio et le jeu.

Lire aussi le relief, la vegetation, le RPG et la BD TOPO autour de son exploitation par le
serveur local, plutot que depuis le navigateur. Les donnees deja telechargees sont gardees
sur le poste : une deuxieme ouverture est rapide et ne sollicite plus l'IGN.

Premier client : le jeu de gestion de ferme (branche `Visuel3D`, dossier `jeu/`), qui ne
lit les donnees publiques qu'a travers cette API. La carte et les exports ASSOLIA pourront
s'en servir aussi.

## Perimetre actuel

| Route | Contenu | Source IGN |
| --- | --- | --- |
| `GET /api/v1/parcelles` | Fiches parcelles d'une campagne (voir ci-dessous) | Base locale, RPG pour l'historique |
| `GET /api/v1/parcelles/{id}` | Fiche d'une parcelle | Idem |
| `GET /api/v1/terrain` | Grille d'altitude ou de hauteur, binaire float32 | WMS GeoPlateforme |
| `GET /api/v1/rpg` | Parcelles du RPG d'une campagne (2015 a 2025) | WFS GeoPlateforme |
| `GET /api/v1/bdtopo` | Batiments, routes, plans d'eau, cours d'eau | WFS GeoPlateforme |

Contrat detaille (parametres, formats, erreurs) : `docs/api/openapi-v1.json`.

### Fiche parcelle

Parametres : `annee` (par defaut la plus recente du parcellaire), `historique` (1 a 7 ans,
5 par defaut, annee demandee comprise), `rpg=non` pour se passer du RPG.

| Champ | Contenu | D'ou il vient |
| --- | --- | --- |
| `nom` | Nom de la parcelle | `nom`, `nom_affiche`, `name`, `nom_parcelle`, `NOM_PARCEL` |
| `surface_ha`, `surface_source` | Surface en ha ; `saisie` ou `calculee` | `surface_parcelle`, `surface`, `surface_ha` ; sinon aire du contour |
| `culture` | Code PAC, precision et libelle de l'annee | Colonne culture N du parcellaire |
| `bio`, `type_bio`, `bio_source` | Conduite bio (vrai, faux ou inconnu), type (AB…), source | `parcelle_bio`, `bio`, `conduite_bio`, `isOrganic`… ; sinon champ `bio` du RPG de l'annee (publie depuis 2025) |
| `telepac` | PACAGE, ilot, numero, commune INSEE | Proprietes Telepac |
| `historique` | Une ligne par annee, de la plus recente a la plus ancienne | Colonnes N, N-1… N-6 du parcellaire, sinon RPG |
| `avertissements` | `RPG_INDISPONIBLE`, `RPG_TRONQUE` | |

Regles de l'historique, annee par annee :

1. la culture saisie dans le parcellaire fait foi (`source: parcellaire`) ;
2. a defaut, la culture declaree au RPG pour la parcelle RPG qui recouvre le mieux le
   contour (meme regle que `/api/v1/enrich` : plus grande intersection, au moins 20 % de la
   plus petite surface) (`source: rpg`) ;
3. sinon `source: inconnue` ;
4. si saisie et RPG different, la saisie est gardee et `ecart_rpg` donne la culture du RPG ;
5. une annee RPG illisible donne un avertissement, jamais une erreur.

Les libelles viennent des memes fichiers que l'interface : `public/codebookV2.js`
(couple code|precision puis code), puis `public/codebook.js`.

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
| `scripts/donnees/fiche-parcelle.mjs` | Fiche parcelle : lecture des alias, historique, rapprochement RPG |
| `scripts/donnees/cultures.mjs` | Libelles des codes culture, lus dans `public/codebook*.js` |
| `scripts/donnees/routes.mjs` | Routes HTTP GET, codes d'erreur |
| `scripts/donnees/donnees.test.mjs` | Tests (35) |

Points techniques a connaitre :

- en WMS 1.3.0, `EPSG:4326` s'ecrit latitude d'abord : `BBOX=sud,ouest,nord,est`
- en WFS, la `bbox` doit finir par `,CRS:84`, sinon le service repond 200 avec une liste vide
- l'IGN signale l'absence de donnee par -9999 ou -99999 : la grille est renvoyee telle
  quelle et le client traite ces valeurs
- un 429 de l'IGN est respecte (`Retry-After`, plafonne a 10 s) puis la demande est
  retentee une fois ; une erreur 5xx ou reseau est retentee une fois ; une erreur 4xx ne
  l'est pas

## Limites / dette

- fiches avec historique RPG : environ 2 s pour 30 parcelles sur 7 ans (calcul des
  intersections, le RPG lui-meme sort du cache) ; 0,2 s avec `rpg=non`
- l'historique ne lit que les colonnes N a N-6 de la parcelle : les parcellaires d'autres
  annees importes a part ne sont pas rapproches ici (c'est le role de FP-006)
- `irrigable` et `type_sol` ne sont pas encore dans la fiche

- pas de limite de taille totale du cache : il grossit avec les emprises consultees
- pas encore de route `/api/v1/prix` (baremes publics) : prevue avec l'economie du jeu
- le RPG est lu tel que publie : pas de fusion avec le parcellaire de l'utilisateur

## Suivi

- 2026-11-09 : creation (relief, RPG, BD TOPO, parcellaire en lecture, cache disque)
- 2026-11-10 : fiches parcelles (nom, surface, culture, bio, Telepac, historique 1 a 7 ans)
