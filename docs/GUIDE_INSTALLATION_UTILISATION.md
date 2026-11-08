# Guide d'installation et d'utilisation - Studio Parcellaire

## 1. Objet du document

Ce document decrit :

- l'installation locale de Studio Parcellaire
- le demarrage de l'application
- les principaux parcours utilisateurs actuellement disponibles
- les limites pratiques a connaitre pour l'usage courant

## 2. Pre-requis

- `Node.js` installe
- `npm` installe
- un poste capable d'executer le frontend Vite et le backend Node local

## 3. Installation locale

Depuis le repertoire du projet :

```powershell
npm install
```

## 4. Demarrage

### 4.1 Lancer le backend local

```powershell
npm run backend
```

Backend local attendu :

- `http://localhost:4174`

### 4.2 Lancer le frontend

Dans un second terminal :

```powershell
npm run dev
```

Frontend attendu :

- `http://localhost:5173`

### 4.3 Build de verification

```powershell
npm run build
```

## 5. Architecture d'usage

L'application propose deux modes principaux :

- `Editor` : edition, enrichissement, import, export, correspondances inter-annees
- `Viewer` : consultation filtree des parcelles et consultation SoilGrids

## 6. Parcours utilisateur

### 6.1 Importer des parcelles

1. Ouvrir le mode `Editor`.
2. Cliquer sur `Importer fichier`.
3. Selectionner un fichier `XML Telepac` ou `ZIP shapefile`.
4. Confirmer si besoin l'annee detectee et la colonne culture cible.
5. Verifier le chargement sur carte et dans le panneau parcelles.

### 6.2 Modifier les parcelles

1. Utiliser la barre de dessin pour creer ou modifier une geometrie.
2. Cliquer sur une parcelle sur la carte ou dans la liste.
3. Modifier les champs utiles : nom, ilot/parcelle, cultures, bio, type de sol.
### 6.3 Completer les cultures

1. Passer en vue tableau si une edition en masse est plus pratique.
2. Saisir un code culture ou un libelle culture.
3. Utiliser les boutons `Remplir` sur les colonnes pour recuperer les cultures depuis le RPG quand disponible.
4. Verifier les warnings eventuels sur les codes ou libelles inconnus.

### 6.4 Remplir les noms de parcelles

1. Dans la vue tableau, utiliser l'action de remplissage des noms.
2. L'application tente d'attribuer des noms a partir de la toponymie.
3. Relire les noms proposes avant export ou validation metier.

### 6.5 Comparer deux annees

1. Depuis l'onglet `Parcelles`, ouvrir `Associer les parcelles`.
2. Choisir l'annee de gauche et l'annee de droite.
3. Examiner les suggestions automatiques.
4. Ajuster les correspondances manuellement si necessaire.
5. Valider pour enregistrer les correspondances.

### 6.6 Consulter les sols avec SoilGrids

1. Basculer en mode `Viewer`.
2. Cliquer sur une parcelle.
3. Consulter le panneau `Sol - SoilGrids`.
4. Utiliser `Rafraichir SoilGrids` pour forcer une nouvelle recuperation si besoin.

Important :

- les indicateurs SoilGrids sont des estimations
- ils ne remplacent pas une expertise pedologique terrain

### 6.7 Utiliser le mapping des types de sols

1. En mode `Editor`, activer la couche `Carte des sols France`.
2. Ouvrir l'onglet `mapping-sols`.
3. Choisir une structure.
4. Recharger les sols detectes si necessaire.
5. Creer les types de sols cibles.
6. Associer chaque combinaison detectee a un type de sol de structure.
7. Enregistrer, puis appliquer le mapping aux parcelles.

### 6.8 Exporter les donnees

1. Cliquer sur `Faire un export`.
2. Choisir `XML Telepac` ou `CSV`.
3. Completer les parametres demandes.
4. Lancer l'export.

Notes :

- l'export XML permet de choisir la colonne culture a utiliser
- l'export CSV demande des informations de structure et d'exploitation
- un export shapefile existe dans le code mais n'est pas expose comme export principal dans le menu courant

## 7. Donnees et persistance

Persistance actuelle :

- stockage local temporaire via `localStorage`
- sauvegarde dans `%APPDATA%StudioParcellaireparcellaire.db`
- mappings de sols dans `data/soil-type-mappings.json`
- cache SoilGrids dans `data/parcel-soilgrids-cache.json`

## 8. Limites connues

- certains bundles frontend sont volumineux

## 9. Documents lies

- cahier des charges : [CAHIER_DES_CHARGES_Studio_Parcellaire.md](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/CAHIER_DES_CHARGES_Studio_Parcellaire.md)
- suivi des fonctionnalites : [SUIVI_FONCTIONNALITES.md](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/SUIVI_FONCTIONNALITES.md)
- fiches fonctionnelles : [fonctionnalites/README.md](C:/Users/Mathis%20Trunet/Documents/GitHub/StudioParcellaire/docs/fonctionnalites/README.md)
