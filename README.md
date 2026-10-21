# Roland Gamos — en ligne, à deux

Le jeu de Rap Jeu : on part d'un artiste, chacun à son tour cite un artiste qui a fait un son avec le précédent. Pas de répétition, et le premier qui sèche (ou laisse filer le chrono) perd la manche.

- **Featurings vérifiés en direct** sur l'API publique Deezer (catalogue à jour, aucune clé requise), avec la pochette et l'extrait 30 s du son qui prouve le feat.
- **Lien d'invitation** : tu crées un salon, tu envoies le lien, ton pote arrive direct dans la partie.
- **Avec ou sans chrono** (10 à 60 s par tour, ou illimité), en 1, 3 ou 5 manches gagnantes.
- **Tous genres** : rap, pop, afro, latino, électro…
- **Arbitrage** : si Deezer ne trouve pas un feat qui existe vraiment, le joueur peut demander à l'adversaire de le valider (une fois par tour, chrono en pause).
- Reconnexion automatique si on recharge la page ou si le réseau saute.

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
3. Une fois déployé, ouvre l'URL `https://roland-gamos-xxxx.onrender.com` et crée un salon.

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
