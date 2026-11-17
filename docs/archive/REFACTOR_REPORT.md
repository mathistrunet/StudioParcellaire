# Refactor Report

## Audit de l'existant

### Arborescence actuelle
```
src/
  App.jsx (≈500 lignes)
  App.css
  assets/
  components/
    ParcelleEditor.jsx
    RasterToggles.jsx
  config/
    rasterLayers.js
  services/
    rpg.js
    telepacXml.js
  utils/
    cultureLabels.js
    format.js
    format.test.js
    geometry.js
    proj.js
    ui.js
```

### Dépendances principales
- React + Vite
- maplibre-gl + MapboxDraw
- Utilitaires maison pour parsing Télépac et calculs géométriques

### Points de complexité / hot spots
- **`src/App.jsx`** concentre l'initialisation de la carte, la gestion des parcelles, le panneau latéral, les actions, les appels réseau (RPG WFS) et le layout → difficile à tester et maintenir.
- Absence de séparation claire entre logique (services/hooks) et UI.
- Config raster et logique mélangées dans `App.jsx`/`RasterToggles`.
- Peu de tests (1 seul sur un utilitaire), aucune sur la carte ou sur les services.
- Pas de structure "features" : composants et services dispersés.

## Architecture cible proposée
Organisation inspirée par une approche par fonctionnalités.
```
src/
  app/            # bootstrap: providers, router
  pages/          # pages (ex: MapPage)
  features/
    map/
      components/ # ex: MapContainer, RasterToggles
      hooks/      # ex: useMapInitialization, useRasterLayers, useRpgLayer
      services/   # mapService, wfsClient
      config/     # rasterLayers.ts
      types/
      tests/
    parcels/
      components/ # ParcelleEditor, controls
      hooks/      # useParcels, useTelepacImport
      services/   # telepacParser
    weather/     # (placeholder si couches météo)
  components/     # UI partagée (boutons, modales)
  hooks/          # hooks transverses
  services/       # appels réseau génériques
  utils/          # helpers purs
  assets/
```

### Principes
- `App.jsx` limité au routing/layout et assemblage de hooks/composants.
- Logique cartographique déplacée dans `features/map` (hooks + services).
- Logique parcellaire (import/export XML, édition) dans `features/parcels`.
- Configurations (raster layers, constantes) dans `config/` dédiés.
- Tests unitaires via Vitest par dossier `tests/` + smoke test MapLibre.

### Plan de refactorisation (patchs)
1. **Patch 1** : création de l'ossature des dossiers (`features/`, `services/`, `hooks/`, etc.) sans changer le runtime.
2. **Patch 2** : extraction de la logique carte depuis `App.jsx` vers `features/map` (hooks `useMapInitialization`, `useRasterLayers`).
3. **Patch 3** : factorisation des appels réseau et configuration RPG/raster (`services/wfsClient`, `features/map/config`).
4. **Patch 4** : ajout tests Vitest, scripts npm, ESLint/Prettier (déjà présent mais vérif), smoke test de montage carte.
5. **Patch 5** : nettoyage final, mise à jour imports, documentation (`README_RESTRUCTURE.md`).

### Risques / points de vigilance
- S'assurer qu'aucune régression n'est introduite dans la carte (couches, interactions MapboxDraw).
- Gestion des refs (`mapRef`, `drawRef`) lors de l'extraction en hooks.
- Maintenir les imports relatifs corrects après déplacement de fichiers.
- Manipulation des fichiers XML Télépac (encodage ISO-8859-1) à tester.

