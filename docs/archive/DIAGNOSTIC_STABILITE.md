# Diagnostic de stabilité – Telepac Mapper

## Synthèse exécutive

L’application est **fonctionnelle** (build et tests unitaires passent), mais elle présente plusieurs risques de stabilité à moyen terme :

1. **Qualité statique dégradée** : `npm run lint` remonte 8 erreurs bloquantes et 12 warnings, dont des hooks React avec dépendances manquantes (risque de comportements non déterministes) et des variables inutilisées qui signalent du code mort.
2. **Risque de régression UI/performance** : le bundle de production contient des chunks JS très volumineux (>500 kB minifiés), augmentant la latence de chargement et la sensibilité aux environnements faibles.
3. **Gestion d’erreurs incomplète** : plusieurs `catch` silencieux absorbent des erreurs sans télémétrie, ce qui peut masquer des défauts en production.
4. **Dette dépendances/sécurité outillage** : `npm audit` signale 9 vulnérabilités (modérées/hautes), dont `vite` et la chaîne `eslint`.

## Vérifications exécutées

- `npm install`
- `npm run lint`
- `npm run test -- --run`
- `npm run build`
- `npm audit --json`

## Détails des constats

### 1) Lint en échec (stabilité logique)

Le lint échoue avec des points qui impactent la robustesse :

- Hooks React avec dépendances manquantes (`react-hooks/exhaustive-deps`) dans plusieurs composants complexes (matching, map initialization, editor map).
- Erreurs `no-unused-vars` (variables inutilisées dans du code de fusion/matching).
- Règle `react-refresh/only-export-components` non respectée dans des stores React.

**Risque stabilité** : effets React non recalculés quand l’état évolue, UI incohérente, comportements “fantômes” difficiles à reproduire.

### 2) Build OK mais signaux de fragilité runtime

Le build passe, mais Vite remonte :

- scripts non bundlés dans `index.html` faute de `type="module"` (`codebook.js`, `colorbook.js`) ;
- chunks JS très lourds (`ParcellesEditorMap` et `index`), avec warning explicite de Rollup/Vite.

**Risque stabilité** : lenteur au chargement, risque de timeouts réseau et de freeze perçu sur postes contraints.

### 3) Gestion d’erreurs partiellement silencieuse

Plusieurs zones du code absorbent les erreurs sans logging structuré :

- appels `localStorage` / JSON parse en fallback backend avec `catch { return null; }` ;
- suppressions/cleanup MapLibre dans des `try/catch` silencieux ;
- validation de matching qui ignore l’erreur côté UI (`catch (error) { /* parent handles */ }`) sans instrumentation locale.

**Risque stabilité** : incidents masqués, diagnostic terrain difficile, effets de bord non remontés.

### 4) Résilience déjà présente (point positif)

Le service backend des parcelles implémente un fallback local (localStorage) quand l’API échoue et normalise la structure GeoJSON, ce qui limite les crashs au chargement.

### 5) Vulnérabilités dépendances

`npm audit` remonte 9 vulnérabilités (dont 4 hautes), principalement dans la chaîne ESLint et Vite 7.1.x.

**Risque stabilité** : surtout supply-chain/tooling pour l’environnement dev/build, mais peut impacter l’exploitabilité en environnement de preview/dev server.

## Priorisation des actions

### Priorité haute (immédiat)

1. **Faire repasser lint à 0 erreur** (et idéalement 0 warning critique).
2. Corriger en premier les dépendances manquantes des hooks dans les modules map/matching.
3. Introduire un logging minimal pour les `catch` silencieux (même en `console.warn` encapsulé + feature flag dev/prod).

### Priorité moyenne

1. **Réduire la taille des bundles** : lazy-loading plus fin, `manualChunks`, découper la logique lourde map/editor.
2. Vérifier explicitement `index.html` pour convertir les scripts requis en modules si nécessaire (ou les injecter via Vite plugin).

### Priorité faible (mais recommandée)

1. Plan de mise à jour dépendances (`vite`, `eslint` stack) avec validation CI.
2. Ajouter des tests de non-régression sur flux matching + init map (les plus sensibles).

## Plan de stabilisation proposé (7 jours)

- **J1–J2** : campagne lint (erreurs + hooks).
- **J3** : instrumenter erreurs silencieuses (frontend logger central).
- **J4** : optimisation bundle (splits + mesures `dist` avant/après).
- **J5** : upgrade dépendances ciblées + vérif audit.
- **J6–J7** : tests manuels guidés (import XML, édition, matching, export) + tests auto.

## Critères de sortie

- `npm run lint` vert.
- `npm run test -- --run` vert.
- `npm run build` vert sans warning chunk >500 kB sur les routes principales (ou seuil documenté).
- Erreurs utilisateur critiques tracées (au moins console structurée + corrélation timestamp/module).
