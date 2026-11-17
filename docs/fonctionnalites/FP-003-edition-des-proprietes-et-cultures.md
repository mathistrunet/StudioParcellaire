# FP-003 - Edition des proprietes et cultures

- ID : `FP-003`
- Statut : `Implante`
- Priorite : `P1`

## Objectif utilisateur

Permettre la saisie, la correction et l'enrichissement des informations metier attachees a chaque parcelle.

## Perimetre actuel

- nom de parcelle
- ilot / numero
- exploitation, pacage, SIRET
- type de sol
- bio / conduite bio
- cultures de `N+1` a `N-6`
- intercultures par annee, de `N+1` a `N-6` (colonnes « Interculture N », « Interculture N-1 »…) : derobee, CIPAN, couvert semes sur la meme parcelle que la culture de la meme campagne. Cles : `interculture` pour N, `interculture_n1`… pour N-1…, `interculture_n_plus1` pour N+1 (`src/domain/parcelles/intercultures.js`). N, N-1 et N-2 sont affichees par defaut. « Deplacer cultures » deplace l'interculture avec la culture de son annee. Seule l'interculture N est exportee (`CIP_CULTU` du shapefile) ; le CSV Assolia n'en a pas
- options avancees de culture
- autocompletion codes/libelles
- remplissage via RPG
- deplacement / copie / suppression en masse de cultures entre colonnes (vue tableau)

## Attendus fonctionnels

- les champs doivent etre modifiables sans perte de donnees
- les cultures doivent accepter code et libelle
- les incoherences de saisie doivent etre visibles

## Donnees d'entree

- saisie utilisateur
- referentiel cultures
- donnees RPG

## Donnees produites

- proprietes de parcelles enrichies
- historiques culturaux exploitables a l'export

## Technique

- composant principal : `src/components/ParcelleEditor.jsx`
- services : `src/services/rpg.js`
- referentiels : codebook / colorbook / cultures Assolia

## Documentation utilisateur

- edition en vue cartes ou tableau
- boutons `Remplir` pour les cultures et nom de parcelle
- bouton `Deplacer cultures` (vue tableau) : ouvre une fenetre permettant de deplacer ou copier les cultures d'une colonne a une autre sur l'ensemble des parcelles
  - **Colonne source** : colonne dont les donnees seront deplacees ou copiees
  - **Colonne destination** : colonne d'arrivee (optionnelle — si aucune, les donnees source sont simplement supprimees)
  - **Conserver les donnees source** : si coche, la colonne source n'est pas effacee apres le deplacement
  - **Ecraser / Completer** : si "ecraser", toutes les cellules destination sont mises a jour ; si "completer", seules les cellules destination vides sont remplies

## Limites / dette

## Evolutions recommandees

- normaliser strictement les proprietes de culture
- mieux encadrer les precedents culturaux au-dela du `N-2`