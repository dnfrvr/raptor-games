# Raptor Games

Les jeux rap entre potes, en ligne, avec Rex le raptor. Tout est vérifié en direct sur l'API publique Deezer (aucune clé requise).

- **Roland Gamos** : chacun son tour cite un artiste qui a fait un son avec le précédent. Pas de répétition ; le premier qui sèche perd la manche.
- **Le pont** : relier deux rappeurs par une chaîne de feats.
- **Blind test** : chacun fait deviner un son au suivant ; l'artiste rapporte 1 point, le titre 1 de plus.
- **Plus ou moins** : qui a le plus de fans sur Deezer ?
- **La frise** : placer chaque son sur la frise des dates de sortie.

De 2 à 8 joueurs avec un lien ou un code d'invitation, ou en solo (contre le bot, ou seul avec des vies). Reconnexion automatique, mémoire des feats sauvegardée sur Upstash (facultatif).

## Lancer en local

```bash
npm install
npm start            # http://localhost:3000
npm run mock         # version hors-ligne avec un faux Deezer (pour tester l'interface)
```

Pour jouer à deux en local, ouvre le lien d'invitation dans un deuxième onglet en navigation privée.

## Mettre en ligne (gratuit)

L'app a besoin d'un serveur Node qui garde les WebSockets ouverts : Vercel/Netlify ne conviennent pas, Render oui.

**Render (le plus simple)**
1. Mets ce dossier sur un repo GitHub.
2. Sur [render.com](https://render.com) → *New* → *Blueprint* → choisis le repo (le fichier `render.yaml` configure tout).
3. Une fois déployé, ouvre l'URL `https://raptor-games.onrender.com` et crée un salon.

Alternatives qui marchent aussi telles quelles : Railway, Fly.io, Koyeb (commande de démarrage `npm start`, port lu depuis `PORT`).

> Sur l'offre gratuite de Render, le serveur s'endort après 15 min sans visite : la première ouverture prend ~30 s, et les salons en cours sont effacés au réveil.

## Comment marche la vérification

Pour un feat A × B, le serveur cherche dans l'ordre :
1. les 100 titres les plus écoutés de A et de B (Deezer y donne les contributeurs) ;
2. la recherche plein texte « A B », « B A » et le titre du son si le joueur l'a donné, puis le détail des titres candidats ;
3. les albums de B, à la recherche d'un « feat. A ».

Les réponses Deezer sont gardées 6 h en cache et la file d'appels respecte le quota de l'API (50 requêtes / 5 s). Donner le titre du son accélère et fiabilise la vérif pour les feats obscurs.

## Structure

Tous les fichiers sont à la racine (pratique pour un upload depuis un téléphone) :

```
server.js        Express + Socket.IO, salons, proxy d'autocomplétion
game.js          règles, tours, chrono, arbitrage
deezer.js        appels Deezer, cache, vérification des feats
index.html, app.js, styles.css   interface (sans build)
mock-deezer.js   faux Deezer pour tester hors-ligne (npm run mock)
```
