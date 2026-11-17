# FP-005 - Export des donnees

- ID : `FP-005`
- Statut : `Implante`
- Priorite : `P1`

## Objectif utilisateur

Exporter les donnees du parcellaire dans des formats reutilisables en dehors de Studio
Parcellaire : CSV Assolia, XML Telepac, shapefile.

## Perimetre actuel

- export `CSV Assolia` : nom, surface, conduite AB, irrigabilite, type de sol, cultures N a N-4, contour
- export `XML Telepac` : declaration alimentee par une colonne de culture au choix
- export `Shapefile` (.zip) au format de l'« Export specifique (SHP) » de Geofolia

## CSV Assolia : cultures et structure cible

La boite d'export liste les cultures distinctes du parcellaire (tableau « Remplacer les
cultures »), les cultures non reconnues en tete et signalees en orange.

- **Sans structure cible** : chaque libelle peut etre remplace par un texte libre, comme
  les types de sol. Vide = libelle d'origine. Une culture est « reconnue » si elle se
  rattache a un code PAC du codebook.
- **Avec structure cible** : chaque culture est rapprochee automatiquement d'une culture
  de la structure (`data/assolia_cultures_export.csv`), dans cet ordre :
  1. nom identique a une culture de la structure, sans tenir compte de la casse, des
     accents ni de la ponctuation (« BLE TENDRE D'HIVER » = « Ble tendre d'hiver ») ;
  2. code PAC avec precision, puis code PAC seul. Le code vient de la valeur elle-meme
     (`BTH`) ou du libelle, compare de la meme facon au codebook PAC (un libelle Geofolia
     ecrit avec une apostrophe droite retrouve « Ble tendre d'hiver » du codebook) ;
  3. sinon « Autre assole » (le libelle de la structure s'il existe).
  Pour chaque culture, une liste deroulante propose toutes les cultures de la structure :
  le choix remplace la correspondance automatique dans toutes les cases (N a N-4).
- Les remplacements sont oublies quand la structure cible change.

Pourquoi : les libelles Geofolia ne portent pas de code PAC (`CP_CODCULT` contient un code
EDI, pas le code a 3 lettres). Sans structure, ils sortaient tels quels ; avec structure,
presque tout tombait en « Autre assole ». Le choix dans une liste fermee evite les fautes
de frappe et se fait une fois par culture, pas par parcelle.

## Shapefile

Archive `.zip` : `.shp`, `.shx`, `.dbf`, `.prj`, `.cpg`, en Lambert-93. Ecrit par
`src/services/shapefileWriter.js`, sans `@mapbox/shp-write` ni `dbf`, qui produisaient
des fichiers refuses par Assolia :

| Defaut corrige | Effet chez un lecteur strict |
| --- | --- |
| 4 octets nuls en fin de `.shp`, comptes dans la longueur annoncee | lecture d'un enregistrement fantome, fichier rejete |
| anneaux dans le sens GeoJSON (exterieur anti-horaire) | chaque parcelle lue comme un trou |
| champs numeriques du `.dbf` tous declares avec 3 decimales | surface et campagne mal lues |
| `.prj` en WKT OGC (TOWGS84, AXIS, AUTHORITY) | projection non reconnue par les outils ESRI |
| `CULT_PREC` rempli avec la culture N-2 | mauvais precedent |

Champs (noms et tailles repris de Geofolia) :

| Champ | Type | Contenu |
| --- | --- | --- |
| `CODE_EXPLO` | C20 | code exploitation |
| `RAIS_SOCIA` | C50 | raison sociale, en majuscules |
| `CAMPAGNE` | N4 | campagne |
| `GUID_PARC` | C36 | identifiant de la parcelle, cree s'il manque |
| `TYPE_PARC` | C30 | toujours « Parcelle principale » |
| `NOM_PARCEL` | C253 | nom |
| `SURFACE` | N17.7 | surface en ha |
| `CP_CULTU` | C100 | culture N (libelle) |
| `CULT_PREC` | C100 | culture N-1 |
| `CULT_PREC2` | C100 | culture N-2 |
| `CIP_CULTU` | C100 | interculture de la campagne N (les intercultures N-1 et plus anciennes ne sont pas exportees) |
| `TYPE_SOL` | C75 | type de sol |

Texte en Windows-1252 (octet LDID 0x03 et `.cpg` « 1252 »). Les libelles de culture
gardent 100 caracteres au lieu des 25 de Geofolia : un libelle tronque ne se rattache
plus a rien.

## Attendus fonctionnels

- le fichier exporte doit correspondre aux donnees visibles / editees
- les metadonnees d'exploitation doivent etre reprises quand necessaire
- un shapefile exporte doit etre relu par Assolia comme un export Geofolia

## Technique

- composant : `src/Front/ExportMenuButton.jsx`
- CSV : `src/services/parcellesCsv.js` (`buildParcellesCsv`, `describeExportCultures`)
- XML : `src/services/telepacXml.js`
- shapefile : `src/services/parcelleShapefile.js`, `src/services/shapefileWriter.js`
- tests : `src/services/parcellesCsv.test.js`, `src/services/shapefileWriter.test.js`

## Documentation utilisateur

- ouvrir `Exporter`
- choisir le format
- saisir les parametres demandes ; pour le CSV, verifier les cultures signalees en orange

## Limites / dette

- l'acceptation par Assolia du shapefile corrige reste a confirmer sur un vrai import
- N+1, N-5, N-6 et l'interculture n'existent pas dans le format CSV Assolia
- conduite AB et irrigabilite ne sont pas dans le shapefile
- les remplacements de cultures ne sont pas memorises d'un export a l'autre

## Evolutions recommandees

- memoriser les remplacements de cultures par structure
- produire un recapitulatif des champs non exportes

## Suivi

- 2026-11-17 : remplacement des cultures a l'export CSV, rapprochement par nom ; shapefile
  reecrit au format Geofolia (longueur, sens des anneaux, decimales, .prj ESRI, .cpg),
  CULT_PREC corrige, CULT_PREC2 et CIP_CULTU ajoutes
