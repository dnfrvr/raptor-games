// Le pont : le jeu tire deux rappeurs qui n'ont jamais fait de son ensemble, à 2 feats l'un de l'autre.
// On joue comme au Roland Gamos (chacun son tour, un feat vérifié sur Deezer à partir du dernier artiste),
// et celui qui cite le rappeur d'arrivée gagne la manche. Sécher ou dépasser le chrono élimine, comme d'habitude.
const deezer = require('./deezer');
const { Room, FR_RAPPERS } = require('./game');

const same = (x, y) => !!x && !!y && ((x.id && x.id === y.id) || deezer.norm(x.name) === deezer.norm(y.name));
const rand = (arr, n = arr.length) => arr[Math.floor(Math.random() * Math.min(n, arr.length))];

class BridgeRoom extends Room {
  constructor(io, hostToken, hostName, solo = false) {
    super(io, hostToken, hostName, solo);
    this.mode = 'bridge';
    if (solo) this.dropBot();
    this.settings.turnSeconds = 30; // trouver un chemin demande un peu plus de réflexion
    this.nextBridge = null;
    this.prepareBridge(); // dès le salon, le premier pont est tiré et ses artistes préparés
  }

  // Tire deux rappeurs A et B reliés par un intermédiaire X (A–X et X–B ont un son ensemble), sans son A–B direct.
  async makeBridge() {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const name = rand(FR_RAPPERS);
        const A = (await deezer.searchArtists(name, 5)).find((x) => deezer.norm(x.name) === deezer.norm(name));
        if (!A) continue;
        const c1 = (await deezer.findCollaborators(A, 100)).filter((o) => o.artist.id && !same(o.artist, A));
        if (c1.length < 2) continue;
        const direct = new Set(c1.map((o) => deezer.norm(o.artist.name)));
        // Plusieurs intermédiaires possibles : on en essaie quelques-uns parmi ses feats les plus connus.
        const vias = c1.slice(0, 15).sort(() => Math.random() - 0.5).slice(0, 4);
        for (const X of vias) {
          const c2 = (await deezer.findCollaborators(X.artist, 100))
            .filter((o) => o.artist.id && !same(o.artist, A) && !same(o.artist, X.artist) && !direct.has(deezer.norm(o.artist.name)));
          if (!c2.length) continue;
          const B = rand(c2, 12);
          if (deezer.knownFeat(A, B.artist)) continue; // ils ont un son ensemble finalement : pas de pont à construire
          // Fiche complète de l'arrivée (photo, fans), et préparation des deux bouts en tâche de fond.
          const full = (await deezer.searchArtists(B.artist.name, 5)).find((x) => x.id === B.artist.id) || B.artist;
          deezer.prepare(A); deezer.prepare(full);
          return { A, B: full, via: X.artist, tracks: [X.track, B.track] };
        }
      } catch (e) { console.error('bridge', e.message); }
    }
    return null;
  }
  async prepareBridge() {
    if (this.loadingBridge || this.nextBridge) return;
    this.loadingBridge = true;
    try { this.nextBridge = await this.makeBridge(); } finally { this.loadingBridge = false; }
  }

  async newRound() {
    await super.newRound();
    const r = this.round;
    r.checking = { artist: { name: 'pont' }, bridge: true };
    this.pauseClock();
    this.broadcast();
    let b = this.nextBridge;
    this.nextBridge = null;
    for (let k = 0; k < 2 && !b && this.round === r; k++) b = await this.makeBridge();
    if (this.round !== r) return;
    setTimeout(() => this.prepareBridge(), 0); // le pont de la manche suivante
    r.checking = false;
    if (!b) { r.lastError = { artist: { name: 'Pont' }, why: 'bridge' }; return this.broadcast(); }
    r.start = b.A;
    r.target = b.B;
    r.solution = { via: b.via, tracks: b.tracks };
    r.chain.push({ artist: b.A, by: r.turn, track: null, random: true, bridge: true });
    this.resetClock();
    this.broadcast();
  }

  // Pendant l'annonce (pont réussi / raté en solo), plus aucune action jusqu'au pont suivant.
  paused() { const r = this.round; return !!(r && (r.solved || r.failed)); }
  answer(token, d) { if (!this.paused()) return super.answer(token, d); }
  giveUp(token) { if (!this.paused()) return super.giveUp(token); }
  useJoker(token) { if (!this.paused()) return super.useJoker(token); }
  timeout() { if (!this.paused()) return super.timeout(); }

  // Le départ est tiré par le jeu : pas de choix d'artiste de départ.
  randomStart() {}

  // Citer le rappeur d'arrivée (avec un vrai feat) : manche gagnée.
  accept(a, track, byAppeal) {
    const r = this.round;
    if (r.target && same(a, r.target)) {
      r.chain.push({ artist: a, by: r.turn, track, byAppeal, rare: !byAppeal && !track.joker && !!track.rare, joker: !!track.joker });
      this.emitAll('link', { track, artist: a });
      if (this.solo) {
        // Solo : un pont de plus au compteur, puis le suivant.
        this.players[0].score++;
        clearTimeout(this.timer); r.deadline = null;
        r.solved = { links: r.chain.length - 1 };
        this.broadcast();
        this.soloTimer = setTimeout(() => { if (this.round === r && this.phase === 'playing') this.newRound(); }, 3500);
        return;
      }
      return this.endRound(r.turn, 'bridge');
    }
    return super.accept(a, track, byAppeal);
  }

  view(forToken) {
    const v = super.view(forToken);
    v.mode = 'bridge';
    // Le chemin trouvé par le jeu n'est montré qu'une fois la manche finie.
    if (v.round && this.phase === 'playing' && !this.round.failed) v.round.solution = undefined;
    return v;
  }

  // Pas de bot : en solo, on cherche seul le chemin ; sécher ou le chrono = partie perdue.
  botTick() {}
  eliminate(i, reason) {
    // Solo : une vie de moins ; on montre le chemin prévu, puis un nouveau pont.
    if (this.solo) {
      const r = this.round;
      clearTimeout(this.timer); clearTimeout(this.koTimer); r.deadline = null;
      return this.loseLife(reason, () => {
        r.failed = { reason };
        this.broadcast();
        this.soloTimer = setTimeout(() => { if (this.round === r && this.phase === 'playing') this.newRound(); }, 3500);
      });
    }
    return super.eliminate(i, reason);
  }
  // Seul, personne pour valider un feat à la main.
  appeal(token) { if (!this.solo) return super.appeal(token); }
}

module.exports = { BridgeRoom };
