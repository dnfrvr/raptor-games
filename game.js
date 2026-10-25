// Logique d'une partie de Roland Gamos à deux joueurs.
const deezer = require('./deezer');

const TURN_CHOICES = [0, 10, 15, 20, 30, 45, 60];

// Rappeurs français proposés par le bouton « Au hasard » (photo et identifiant récupérés en direct sur Deezer).
const FR_RAPPERS = [
  'Ninho', 'Jul', 'SCH', 'Booba', 'Damso', 'PNL', 'Nekfeu', 'Orelsan', 'Niska', 'Gazo', 'Tiakola',
  'Werenoi', 'Hamza', 'Naps', 'Kaaris', 'Rohff', 'Lacrim', 'Alonzo', 'Soprano', 'Gims', 'Vald',
  'Leto', 'Koba LaD', 'Freeze Corleone', 'Laylow', 'Josman', 'Zola', 'Maes', 'Sofiane', 'Kalash Criminel',
  'Heuss L\'enfoiré', 'Dinos', 'Lomepal', 'Kekra', 'Sneazzy', 'Alpha Wann', 'Ziak', 'Soolking', 'Rim\'K',
  'Kery James', 'Gradur', 'MHD', 'Moha La Squale', 'Guy2Bezbar', 'Plk', 'Zkr', 'Jok\'air',
  'Lefa', 'Bigflo & Oli', 'Nemir', 'Mister V', 'Sadek', 'La Fouine', 'Sexion d\'Assaut', 'Médine', 'Youssoupha',
  'Disiz', 'Oxmo Puccino', 'IAM', 'Kenza Farah', 'Timal', 'Landy', 'Hornet La Frappe', 'Bosh', 'Green Montana',
  'Kofs', 'Djadja & Dinaz', 'RK', 'Zed', 'Favé', 'Gambi', 'Rsko', 'Jolagreen23', 'La Mano 1.9',
];

function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

// Bot du mode solo, par niveau : temps de réflexion (ms), nombre de sons qu'il « connaît » par artiste,
// et probabilité de sécher (de base, puis en plus à chaque maillon de la chaîne).
const BOT = {
  easy:   { think: [4000, 7000], depth: 25,  dry: 0.22, dryStep: 0.04 },
  normal: { think: [3000, 5500], depth: 60,  dry: 0.10, dryStep: 0.025 },
  hard:   { think: [2000, 4000], depth: 100, dry: 0.03, dryStep: 0.01 },
};
const BOT_TOKEN = '__bot__';
const MAX_PLAYERS = 8;
const MAX_TRIES = 3;
const REACTIONS = ['🔥', '😂', '💀', '😮', '👏'];
const KO_RELAUNCH_COST = 5;   // jokers pour relancer après un K.O.
const KO_DECIDE_MS = 15000;   // temps pour choisir de relancer
const KO_SHOW_MS = 4000;      // durée de l'écran K.O. avant élimination quand on ne peut pas relancer        // essais par tour
const AFTER_MISS_MS = 10000; // temps minimum laissé après une mauvaise réponse

class Room {
  constructor(io, hostToken, hostName, solo = false) {
    this.io = io;
    this.code = code();
    this.players = [];
    this.settings = { turnSeconds: 15, target: 3 }; // target 0 = manches illimitées
    this.final = null;
    this.phase = 'lobby'; // lobby | playing | roundEnd | finished
    this.round = null;
    this.roundNo = 0;
    this.history = [];
    this.timer = null;
    this.lastActive = Date.now();
    this.addPlayer(hostToken, hostName);
    this.hostToken = hostToken;
    this.solo = solo;
    if (solo) {
      this.settings.botLevel = 'normal';
      this.players.push({ token: BOT_TOKEN, name: 'Bot', score: 0, sockets: new Set(), bot: true });
    }
    this.botTimer = null;
    this.botKey = '';
    this.nextRandom = null;
    this.preloadRandom(); // dès le salon : le prochain rappeur « au hasard » est déjà tiré et préparé
  }

  // Tire à l'avance le prochain rappeur « au hasard » (départ de manche ou relance après K.O.) et prépare ses feats
  // en tâche de fond : le bouton « Au hasard » répond alors tout de suite, et le premier coup est déjà en mémoire.
  async preloadRandom() {
    if (this.loadingRandom) return;
    this.loadingRandom = true;
    try {
      const starts = new Set(this.history.map((h) => h.start && deezer.norm(h.start.name)));
      const pool = [...new Set(FR_RAPPERS)].filter((n) => !starts.has(deezer.norm(n)));
      for (let tries = 0; tries < 5; tries++) {
        const name = pool[Math.floor(Math.random() * pool.length)] || 'Ninho';
        const res = await deezer.searchArtists(name, 5).catch(() => []);
        const a = res.find((x) => deezer.norm(x.name) === deezer.norm(name)) || res[0];
        if (a && !(this.round && this.usedArtist(a))) { this.nextRandom = a; deezer.prepare(a); break; }
      }
    } finally {
      this.loadingRandom = false;
    }
  }
  takeRandom(okFn) {
    const a = this.nextRandom;
    this.nextRandom = null;
    setTimeout(() => this.preloadRandom(), 0);
    return a && okFn(a) ? a : null;
  }

  addPlayer(token, name) {
    const existing = this.players.find((p) => p.token === token);
    if (existing) { existing.name = name || existing.name; return existing; }
    // Nouveaux joueurs seulement dans le salon (un joueur déjà inscrit peut toujours revenir).
    if (this.phase !== 'lobby' || this.players.length >= (this.solo ? 2 : MAX_PLAYERS)) return null;
    const p = { token, name: (name || 'Joueur').slice(0, 20), score: 0, jokers: 0, sockets: new Set() };
    this.players.push(p);
    return p;
  }

  idx(token) { return this.players.findIndex((p) => p.token === token); }

  // Quitter le salon avant le lancement : la place se libère ; si l'hôte part, le suivant devient hôte.
  // Renvoie true si le salon est désormais vide (le serveur le supprime).
  leave(token) {
    const i = this.idx(token);
    if (i < 0 || this.phase !== 'lobby') return false;
    this.players.splice(i, 1);
    const humans = this.players.filter((p) => !p.bot);
    if (!humans.length) return true;
    if (token === this.hostToken) this.hostToken = humans[0].token;
    this.broadcast();
    return false;
  }

  setSettings(token, s) {
    if (token !== this.hostToken || this.phase !== 'lobby') return;
    if (TURN_CHOICES.includes(Number(s.turnSeconds))) this.settings.turnSeconds = Number(s.turnSeconds);
    const t = Number(s.target);
    if (Number.isInteger(t) && t >= 0 && t <= 10) this.settings.target = t;
    if (this.solo && BOT[s.botLevel]) this.settings.botLevel = s.botLevel;
    this.broadcast();
  }

  async start(token) {
    // Lancement : l'hôte. Revanche : n'importe quel joueur (si l'hôte est parti, les autres ne sont pas bloqués).
    if (this.players.length < 2 || this.idx(token) < 0) return;
    if (this.phase === 'lobby' && token !== this.hostToken) return;
    if (this.phase !== 'lobby' && this.phase !== 'finished') return;
    this.players.forEach((p) => { p.score = 0; p.jokers = 0; });
    this.roundNo = 0;
    this.history = [];
    this.final = null;
    await this.newRound();
  }

  // Mode illimité : n'importe quel joueur peut arrêter la partie entre deux manches.
  stop(token) {
    if (this.phase !== 'roundEnd' || this.idx(token) < 0) return;
    const best = Math.max(...this.players.map((p) => p.score));
    const top = this.players.map((p, i) => (p.score === best ? i : -1)).filter((i) => i >= 0);
    this.final = { stopped: true, winner: top.length === 1 ? top[0] : null, by: this.idx(token), recap: this.recap() };
    this.phase = 'finished';
    this.broadcast();
  }

  // Récap de fin de partie : plus longue chaîne, et pour chaque joueur ses feats, ses rares, ses jokers et son meilleur coup.
  recap() {
    const H = this.history;
    if (!H.length) return null;
    let longest = null;
    H.forEach((h, k) => { if (!longest || h.links > longest.n) longest = { n: h.links, round: k + 1, start: h.start ? h.start.name : null }; });
    const players = this.players.map((p, i) => {
      const mine = H.flatMap((h) => h.feats.filter((f) => f.by === i));
      const found = mine.filter((f) => !f.joker && !f.relaunch);
      const score = (f) => (f.rare ? 2 : 0) + (f.hinted ? 1 : 0) - (f.appeal ? 3 : 0);
      const best = found.filter((f) => !f.appeal).sort((a, b) => score(b) - score(a))[0] || null;
      return {
        feats: found.length,
        rare: found.filter((f) => f.rare).length,
        titles: found.filter((f) => f.hinted).length,
        jokers: mine.filter((f) => f.joker).length,
        relaunches: mine.filter((f) => f.relaunch).length,
        kos: H.filter((h) => h.reason === 'ko' && h.lastBy === i).length,
        best: best && (best.rare || best.hinted) ? { artist: best.artist, title: best.title, rare: best.rare, hinted: best.hinted } : null,
      };
    });
    return { rounds: H.length, totalFeats: H.reduce((s, h) => s + h.links, 0), longest, players };
  }

  async next(token) {
    if (this.phase !== 'roundEnd' || this.idx(token) < 0) return;
    await this.newRound();
  }

  async newRound() {
    this.roundNo++;
    // Le premier joueur tourne à chaque manche ; c'est lui qui choisit l'artiste de départ.
    const first = (this.roundNo - 1) % this.players.length;
    this.roundSeq = (this.roundSeq || 0) + 1;
    this.round = {
      id: this.roundSeq,
      start: null,
      chain: [],
      turn: first,
      remaining: this.settings.turnSeconds * 1000,
      deadline: null,
      checking: false,
      appeal: null,
      appealUsed: false,
      tries: 0,
      maxTries: MAX_TRIES,
      lastError: null,
      winner: null,
      reason: null,
      out: [],      // joueurs éliminés de la manche : { who, reason, on }
      lastOut: null,
    };
    this.phase = 'playing';
    this.broadcast();
  }

  choosing() { return this.round && this.round.chain.length === 0; }
  isOut(i) { return this.round.out.some((o) => o.who === i); }
  alive() { return this.players.map((_, i) => i).filter((i) => !this.isOut(i)); }
  nextAlive(i) {
    const n = this.players.length;
    for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (!this.isOut(j)) return j; }
    return i;
  }

  // Le joueur i sèche : il est éliminé de la manche. S'il ne reste qu'un joueur, il gagne la manche ;
  // sinon la chaîne continue avec le joueur suivant.
  eliminate(i, reason) {
    const r = this.round;
    const cur = this.current();
    r.lastOut = { who: i, reason, on: cur ? cur.name : null, onArtist: cur ? { id: cur.id, name: cur.name } : null };
    r.out.push(r.lastOut);
    const alive = this.alive();
    if (alive.length <= 1) return this.endRound(alive.length ? alive[0] : this.nextAlive(i), reason);
    clearTimeout(this.timer);
    clearTimeout(this.botTimer); this.botKey = '';
    clearTimeout(this.koTimer);
    r.turn = this.nextAlive(i);
    r.tries = 0; r.lastError = null; r.appeal = null; r.checking = false;
    // Toujours la même impasse : le joueur suivant est K.O. à son tour.
    if (r.ko) return this.koVictim();
    this.resetClock();
    this.broadcast();
  }

  // ---------- K.O. ----------
  // Après chaque nouveau maillon : s'il n'existe plus aucun feat possible avec l'artiste en jeu
  // (aucun artiste de ses sons Deezer qui ne soit pas déjà cité), le joueur suivant est K.O.
  async checkKO() {
    const r = this.round;
    const len = r.chain.length;
    const cur = this.current();
    if (!cur || !cur.id || r.ko) return;
    const isUsed = (x) => this.usedArtist(x);
    const stale = () => this.round !== r || this.phase !== 'playing' || r.chain.length !== len;
    // D'abord le son qui vient d'être joué : il contient l'artiste en jeu. S'il a un autre artiste pas encore cité
    // (dans la liste officielle Deezer du son ou écrit dans le titre), il y a forcément une réponse possible.
    // Ce son peut appartenir à quelqu'un d'autre (invités) et donc n'apparaître ni dans le top ni dans les albums de l'artiste.
    const last = r.chain[len - 1];
    if (last && last.track) {
      const names = await deezer.trackArtists(last.track);
      if (stale()) return;
      if (names.some((n) => deezer.norm(n) !== deezer.norm(cur.name) && !isUsed({ name: n }))) return;
    }
    let top;
    try { top = (await deezer.findCollaborators(cur, 100)).filter((o) => !isUsed(o.artist)); } catch (e) { return; }
    if (stale() || top.length) return;
    // Partenaires déjà appris (préparation en tâche de fond, autres parties) : pas besoin de fouiller.
    if (deezer.knownPartners(cur, isUsed).length) return;
    // Rien dans les sons les plus écoutés : avant de déclarer le K.O., fouille profonde (albums, apparitions).
    // Chrono en pause pendant la vérification, pour ne pas pénaliser le joueur.
    r.checking = { verifying: true, artist: { name: cur.name } };
    this.pauseClock();
    this.broadcast();
    let deep = [];
    try { deep = await deezer.findCollaboratorsDeep(cur, isUsed); } catch (e) { deep = [{}]; } // Deezer en panne : pas de K.O. par erreur
    if (stale()) return;
    r.checking = false;
    if (deep.length) { this.startClock(); return this.broadcast(); }
    r.ko = { id: Date.now(), by: r.chain[len - 1].by, artist: { id: cur.id, name: cur.name } };
    this.koVictim();
  }

  koVictim() {
    const r = this.round;
    clearTimeout(this.timer);
    clearTimeout(this.botTimer); this.botKey = '';
    clearTimeout(this.koTimer);
    r.deadline = null;
    r.checking = false; r.appeal = null; r.lastError = null;
    const victim = r.turn;
    const p = this.players[victim];
    r.ko.victim = victim;
    r.ko.at = Date.now();
    r.ko.canRelaunch = !p.bot && (p.jokers || 0) >= KO_RELAUNCH_COST;
    r.ko.cost = KO_RELAUNCH_COST;
    r.ko.decideMs = r.ko.canRelaunch ? KO_DECIDE_MS : KO_SHOW_MS;
    this.koTimer = setTimeout(() => {
      if (this.round === r && this.phase === 'playing' && r.ko && r.ko.victim === victim) this.eliminate(victim, 'ko');
    }, r.ko.decideMs);
    this.broadcast();
  }

  // K.O. : le joueur abandonne tout de suite.
  koGiveUp(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || !r.ko || r.ko.victim !== i) return;
    clearTimeout(this.koTimer);
    this.eliminate(i, 'ko');
  }

  // K.O. : pour 5 jokers, un rappeur français tiré au hasard compte comme sa réponse, et la partie continue.
  async koRelaunch(token) {
    const i = this.idx(token);
    const r = this.round;
    const p = this.players[i];
    if (this.phase !== 'playing' || !r || !r.ko || r.ko.victim !== i || r.checking || !p || (p.jokers || 0) < KO_RELAUNCH_COST) return;
    clearTimeout(this.koTimer);
    p.jokers -= KO_RELAUNCH_COST;
    r.checking = { artist: { name: 'au hasard' }, random: true, relaunch: true };
    this.broadcast();
    const pool = [...new Set(FR_RAPPERS)];
    let found = this.takeRandom((a) => !this.usedArtist(a));
    for (let tries = 0; tries < 10 && !found; tries++) {
      const name = pool[Math.floor(Math.random() * pool.length)];
      try {
        const res = await deezer.searchArtists(name, 5);
        const a = res.find((x) => deezer.norm(x.name) === deezer.norm(name)) || res[0];
        if (a && !this.usedArtist(a)) found = a;
      } catch (e) { console.error('relaunch', e.message); }
    }
    if (this.round !== r || this.phase !== 'playing') return;
    r.checking = false;
    if (!found) { p.jokers += KO_RELAUNCH_COST; return this.koVictim(); } // Deezer en panne : jokers rendus, on peut réessayer
    r.ko = null;
    r.chain.push({ artist: found, by: i, track: null, relaunch: true });
    deezer.prepare(found);
    r.turn = this.nextAlive(i);
    r.tries = 0; r.lastError = null;
    this.resetClock();
    this.broadcast();
    this.checkKO();
  }
  current() { const c = this.round.chain; return c.length ? c[c.length - 1].artist : null; }

  startClock() {
    clearTimeout(this.timer);
    if (!this.settings.turnSeconds) { this.round.deadline = null; return; }
    // Joueur au tour déconnecté : le chrono attend son retour (voir syncPresence).
    if (this.turnAway()) { this.round.deadline = null; this.round.awayPause = true; return; }
    this.round.awayPause = false;
    this.round.deadline = Date.now() + this.round.remaining;
    this.timer = setTimeout(() => this.timeout(), this.round.remaining + 150);
  }

  pauseClock() {
    clearTimeout(this.timer);
    if (this.round.deadline) this.round.remaining = Math.max(0, this.round.deadline - Date.now());
    this.round.deadline = null;
  }

  turnAway() {
    const r = this.round;
    const p = this.phase === 'playing' && r && this.players[r.turn];
    return !!(p && !p.bot && p.sockets.size === 0);
  }

  // Appelé à chaque connexion / déconnexion : chrono figé tant que le joueur au tour est parti,
  // relancé à son retour avec au moins 10 s (le temps de se remettre dans la partie).
  syncPresence() {
    const r = this.round;
    if (this.phase !== 'playing' || !r || !this.settings.turnSeconds) return;
    const busy = r.checking || r.appeal || r.ko;
    if (this.turnAway()) {
      if (r.deadline && !busy) { this.pauseClock(); r.awayPause = true; }
    } else if (r.awayPause) {
      r.awayPause = false;
      if (!busy && !r.deadline) {
        r.remaining = Math.max(r.remaining || 0, Math.min(AFTER_MISS_MS, this.settings.turnSeconds * 1000));
        this.startClock();
      }
    }
  }

  resetClock() {
    this.round.remaining = this.settings.turnSeconds * 1000;
    this.startClock();
  }

  timeout() {
    if (this.phase !== 'playing' || this.round.checking || this.round.appeal || this.round.ko || this.choosing()) return;
    this.eliminate(this.round.turn, 'timeout');
  }

  giveUp(token) {
    const i = this.idx(token);
    if (this.phase !== 'playing' || i !== this.round.turn || this.round.checking || this.round.appeal || this.round.ko || this.choosing()) return;
    this.eliminate(i, 'giveup');
  }

  endRound(winner, reason) {
    clearTimeout(this.timer);
    clearTimeout(this.koTimer);
    clearTimeout(this.botTimer); this.botKey = '';
    this.round.winner = winner;
    this.round.reason = reason;
    this.round.deadline = null;
    this.players[winner].score++;
    const r = this.round;
    this.history.push({
      start: r.start, links: r.chain.length - 1, winner, reason,
      lastBy: r.chain.length ? r.chain[r.chain.length - 1].by : null,
      feats: r.chain.slice(1).map((l) => ({
        by: l.by, artist: l.artist.name, title: l.track ? l.track.title : null,
        rare: !!l.rare, joker: !!l.joker, appeal: !!l.byAppeal, relaunch: !!l.relaunch, hinted: !!(l.track && l.track.hinted && !l.joker),
      })),
    });
    const done = this.settings.target > 0 && this.players[winner].score >= this.settings.target;
    if (done) this.final = { stopped: false, winner, recap: this.recap() };
    this.phase = done ? 'finished' : 'roundEnd';
    this.broadcast();
    this.loadExamples();
  }

  // Fin de manche : 3 feats qu'on aurait pu citer sur l'artiste où le dernier joueur a séché
  // (les plus connus d'abord, sans les artistes déjà cités). Affichés seulement maintenant pour ne pas aider les autres.
  async loadExamples() {
    const r = this.round;
    const a = r.lastOut && r.lastOut.onArtist;
    if (!a || !a.id) return;
    try {
      const list = await deezer.findCollaboratorsDeep(a, (x) => this.usedArtist(x));
      const top3 = await Promise.all(list.slice(0, 3).map(async (o) => ({ ...o, track: await deezer.freshTrack(o.track) })));
      if (this.round !== r) return;
      r.examples = top3.map((o) => ({
        artist: { id: o.artist.id, name: o.artist.name },
        track: { title: o.track.title, preview: o.track.preview, link: o.track.link },
      }));
      if (r.examples.length) this.broadcast();
    } catch (e) { console.error('examples', e.message); }
  }

  usedArtist(a) {
    return this.round.chain.some((l) => (a.id && l.artist.id === a.id) || deezer.norm(l.artist.name) === deezer.norm(a.name));
  }

  setStart(a, random) {
    const r = this.round;
    r.start = a;
    r.chain.push({ artist: a, by: r.turn, track: null, random });
    r.turn = this.nextAlive(r.turn);
    this.resetClock();
    this.broadcast();
    deezer.prepare(a); // prépare ses partenaires pendant que le joueur réfléchit
  }

  // Le joueur qui commence laisse le jeu tirer un rappeur français au hasard.
  async randomStart(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || i !== r.turn || !this.choosing() || r.checking) return;
    r.checking = { artist: { name: 'au hasard' }, random: true };
    this.broadcast();
    const used = new Set(this.history.map((h) => h.start && deezer.norm(h.start.name)));
    const pool = [...new Set(FR_RAPPERS)].filter((n) => !used.has(deezer.norm(n)));
    let found = this.takeRandom((a) => !used.has(deezer.norm(a.name)));
    for (let tries = 0; tries < 8 && !found; tries++) {
      const name = pool[Math.floor(Math.random() * pool.length)] || 'Ninho';
      try {
        const res = await deezer.searchArtists(name, 5);
        found = res.find((x) => deezer.norm(x.name) === deezer.norm(name)) || res[0] || null;
      } catch (e) { console.error('random', e.message); }
    }
    if (this.round !== r || this.phase !== 'playing') return;
    r.checking = false;
    if (!found) { r.lastError = { artist: { name: 'Tirage' }, why: 'random' }; this.broadcast(); return; }
    this.setStart(found, true);
  }

  async answer(token, { artist, song }) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || i !== r.turn || r.checking || r.appeal || r.ko) return;
    if (!artist || !artist.id || !artist.name) return;
    const a = { id: Number(artist.id), name: String(artist.name).slice(0, 80), picture: artist.picture || null };

    // Premier coup de la manche : le joueur pose l'artiste de départ, rien à vérifier.
    if (this.choosing()) return this.setStart(a, false);
    const cur = this.current();
    const attempt = { artist: a, song: song ? String(song).slice(0, 100) : '' };

    if (r.tries >= MAX_TRIES) return;
    if (this.usedArtist(a)) {
      r.lastError = { ...attempt, why: 'used' };
      return this.miss();
    }

    r.checking = attempt;
    r.lastError = null;
    this.pauseClock();
    this.broadcast();

    let track = null;
    let failed = false;
    try {
      // Le son qui vient d'être joué contient l'artiste en jeu : s'il contient aussi l'artiste proposé, c'est la preuve
      // (utile quand ce son appartient à un troisième artiste, invisible côté des deux autres).
      const last = r.chain[r.chain.length - 1];
      if (last && last.track && last.track.id) {
        const names = await deezer.trackArtists(last.track);
        if (names.some((n) => deezer.norm(n) === deezer.norm(a.name))) track = { ...last.track, rare: false, hinted: false };
      }
      if (!track) track = await deezer.findFeat(cur, a, attempt.song);
    } catch (e) {
      console.error('findFeat', e.message);
      failed = true;
    }
    if (this.phase !== 'playing' || this.round !== r) return;
    r.checking = false;

    if (track) {
      this.accept(a, track, false);
    } else {
      r.lastError = { ...attempt, why: failed ? 'api' : 'notfound' };
      // Une panne de Deezer ne coûte pas d'essai au joueur.
      if (failed) { this.startClock(); return this.broadcast(); }
      this.miss();
    }
  }

  // Joker : le jeu trouve un rappeur à la place du joueur (un feat connu de l'artiste en jeu, pas encore cité).
  async useJoker(token) {
    const i = this.idx(token);
    const r = this.round;
    const p = this.players[i];
    if (this.phase !== 'playing' || i !== r.turn || r.checking || r.appeal || r.ko || this.choosing() || !p || !(p.jokers > 0)) return;
    r.checking = { artist: { name: 'Joker' }, joker: true };
    this.pauseClock();
    this.broadcast();
    let options = [];
    try {
      // Les sons les plus écoutés d'abord, puis la fouille profonde s'ils ne suffisent pas. On garde les artistes identifiés.
      // needId : les partenaires lus seulement dans un titre (« feat. X ») sont complétés avec leur fiche Deezer.
      options = (await deezer.findCollaboratorsDeep(this.current(), (x) => this.usedArtist(x), { needId: true }))
        .filter((o) => o.artist.id && !this.usedArtist(o.artist));
    } catch (e) { console.error('joker', e.message); }
    if (this.round !== r || this.phase !== 'playing' || r.turn !== i) return;
    if (!options.length) {
      r.checking = false;
      r.lastError = { artist: { name: 'Joker' }, why: 'joker' };
      this.startClock();
      return this.broadcast();
    }
    // Parmi les 5 feats les plus connus, pour que le joker reste crédible.
    const pick = options[Math.floor(Math.random() * Math.min(5, options.length))];
    const track = await deezer.freshTrack(pick.track); // extrait audio à jour si le son vient de la mémoire
    if (this.round !== r || this.phase !== 'playing' || r.turn !== i) return;
    r.checking = false;
    p.jokers--;
    this.accept(pick.artist, { ...track, joker: true, rare: false, hinted: false }, false);
  }

  // Réactions emoji : relayées à tous, une toutes les 2 s par joueur.
  react(token, e) {
    const i = this.idx(token);
    if (i < 0 || !REACTIONS.includes(e)) return;
    const p = this.players[i];
    const now = Date.now();
    if (p.lastReact && now - p.lastReact < 1900) return;
    p.lastReact = now;
    this.emitAll('reaction', { who: i, e });
  }

  // Mauvaise réponse : un essai de moins, et au moins 10 s au chrono.
  // Au 3e essai raté, la manche est perdue, sauf si le feat peut encore être validé à la main.
  miss() {
    const r = this.round;
    r.tries++;
    if (r.tries >= MAX_TRIES && r.lastError.why === 'used') return this.eliminate(r.turn, 'tries');
    this.missClock();
    this.broadcast();
  }

  // Après une mauvaise réponse, le joueur garde le temps qu'il lui restait,
  // mais jamais moins de 10 s (s'il lui en restait 20, il garde 20 ; s'il lui en restait 4, il repasse à 10).
  missClock() {
    if (!this.settings.turnSeconds) return;
    this.pauseClock(); // fige le temps restant (déjà figé pendant la vérification Deezer)
    const floor = Math.min(AFTER_MISS_MS, this.settings.turnSeconds * 1000);
    this.round.remaining = Math.max(this.round.remaining, floor);
    this.startClock();
  }

  accept(a, track, byAppeal) {
    const r = this.round;
    // Jokers : +1 pour un feat rare, +1 pour le bon titre du son (cumulables).
    // Pas pour un feat validé à la main, joué par un joker, ou trouvé par le bot.
    const p = this.players[r.turn];
    const bonus = { who: r.turn, rare: false, title: false, id: Date.now() };
    if (!byAppeal && !track.joker && !p.bot) {
      bonus.rare = !!track.rare;
      bonus.title = !!track.hinted;
      p.jokers = (p.jokers || 0) + (bonus.rare ? 1 : 0) + (bonus.title ? 1 : 0);
    }
    r.lastBonus = bonus.rare || bonus.title ? bonus : r.lastBonus || null;
    r.chain.push({ artist: a, by: r.turn, track, byAppeal, rare: !byAppeal && !track.joker && !!track.rare, joker: !!track.joker });
    r.turn = this.nextAlive(r.turn);
    r.lastError = null;
    r.appeal = null;
    r.appealUsed = false;
    r.tries = 0;
    this.resetClock();
    this.broadcast();
    this.emitAll('link', { track, artist: a });
    deezer.prepare(a); // prépare ses partenaires pendant que le joueur suivant réfléchit
    this.checkKO();
  }

  // Deezer ne trouve rien ? Le joueur peut demander à l'adversaire de valider à la main.
  appeal(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || i !== r.turn || r.checking || r.appeal) return;
    if (!r.lastError || !['notfound', 'api'].includes(r.lastError.why)) return;
    r.appeal = { artist: r.lastError.artist, song: r.lastError.song };
    this.pauseClock();
    this.broadcast();
  }

  // L'adversaire peut aussi valider de lui-même un feat que Deezer n'a pas trouvé, sans attendre qu'on le lui demande.
  grant(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || i === r.turn || r.checking || r.appeal) return;
    if (!r.lastError || !['notfound', 'api', 'refused'].includes(r.lastError.why)) return;
    const { artist, song } = r.lastError;
    if (this.usedArtist(artist)) return;
    this.accept(artist, { id: null, title: song || 'Validé par l’adversaire', artists: [this.current().name, artist.name], preview: null, link: null, cover: null }, true);
  }

  judge(token, ok) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r.appeal || i === r.turn) return;
    const { artist, song } = r.appeal;
    r.appeal = null;
    if (ok) {
      this.accept(artist, { id: null, title: song || 'Validé par l’adversaire', artists: [this.current().name, artist.name], preview: null, link: null, cover: null }, true);
    } else {
      r.lastError = { artist, song, why: 'refused' };
      // Refus du dernier essai : plus rien à tenter, la manche est perdue.
      if (r.tries >= MAX_TRIES) return this.eliminate(r.turn, 'tries');
      this.missClock();
      this.broadcast();
    }
  }

  emitAll(ev, data) {
    for (const p of this.players) for (const s of p.sockets) this.io.to(s).emit(ev, data);
  }

  view(forToken) {
    const me = this.idx(forToken);
    return {
      code: this.code,
      solo: this.solo,
      maxPlayers: this.solo ? 2 : MAX_PLAYERS,
      jokers: this.players[me] ? this.players[me].jokers || 0 : 0,
      me,
      host: this.idx(this.hostToken),
      phase: this.phase,
      final: this.final,
      settings: this.settings,
      roundNo: this.roundNo,
      players: this.players.map((p) => ({ name: p.name, score: p.score, jokers: p.jokers || 0, online: !!p.bot || p.sockets.size > 0, bot: !!p.bot })),
      round: this.round && {
        ...this.round,
        deadline: undefined,
        msLeft: this.round.deadline ? Math.max(0, this.round.deadline - Date.now()) : null,
        paused: !this.round.deadline,
      },
      serverNow: Date.now(),
    };
  }

  broadcast() {
    this.lastActive = Date.now();
    for (const p of this.players) for (const s of p.sockets) this.io.to(s).emit('state', this.view(p.token));
    if (this.solo) this.botTick();
  }

  // ---------- Bot (mode solo) ----------
  botTick() {
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.checking || r.ko) return;
    const b = this.players.findIndex((p) => p.bot);
    // Le joueur demande au bot de valider un feat introuvable : le bot lui fait confiance.
    if (r.appeal && r.turn !== b) return this.botLater('judge', 1500, () => this.judge(BOT_TOKEN, true));
    if (r.appeal || r.turn !== b) return;
    const lvl = BOT[this.settings.botLevel] || BOT.normal;
    const wait = lvl.think[0] + Math.random() * (lvl.think[1] - lvl.think[0]);
    this.botLater(`play-${r.id}-${r.chain.length}`, wait, () => this.botPlay(lvl));
  }

  botLater(key, ms, fn) {
    if (this.botKey === key) return; // déjà programmé
    clearTimeout(this.botTimer);
    this.botKey = key;
    this.botTimer = setTimeout(() => { this.botKey = ''; fn(); }, ms);
  }

  async botPlay(lvl) {
    const r = this.round;
    const b = this.players.findIndex((p) => p.bot);
    if (this.phase !== 'playing' || r.turn !== b || r.checking || r.appeal) return;
    if (this.choosing()) return this.randomStart(BOT_TOKEN);
    const n = r.chain.length;
    let options = [];
    try {
      options = (await deezer.findCollaborators(this.current(), lvl.depth)).filter((o) => o.artist.id && !this.usedArtist(o.artist));
    } catch (e) { console.error('bot', e.message); }
    if (this.round !== r || this.phase !== 'playing' || r.turn !== b) return;
    const dries = Math.random() < Math.min(0.9, lvl.dry + lvl.dryStep * n);
    if (!options.length || dries) return this.eliminate(b, 'giveup');
    // Préfère les feats les plus évidents (en haut du top) quand il est facile, pioche plus large sinon.
    const span = Math.max(1, Math.ceil(options.length * (lvl === BOT.easy ? 0.4 : 1)));
    const pick = options[Math.floor(Math.random() * span)];
    this.accept(pick.artist, pick.track, false);
  }
}

module.exports = { Room, TURN_CHOICES };
