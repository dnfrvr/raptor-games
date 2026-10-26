// Blind test : chacun son tour, un joueur choisit un artiste et un de ses sons ; le joueur suivant écoute l'extrait
// et doit trouver l'artiste (+1 point), avec le titre en bonus (+1). Puis c'est lui qui propose au suivant.
// Premier à X points. Salon, joueurs, chrono, réactions et présence : repris du Roland Gamos (classe Room).
const deezer = require('./deezer');
const { Room, TURN_CHOICES, FR_RAPPERS, BOT_TOKEN, MAX_TRIES, AFTER_MISS_MS } = require('./game');

const REVEAL_MS = 7000;   // réponse affichée avant l'extrait suivant
const OPTIONS = 8;        // sons proposés au joueur qui choisit
// Écoute : par défaut, seulement les 10 premières secondes de l'extrait Deezer (qui en fait 30).
// Joker de rapidité (artiste trouvé dans le premier quart du chrono) : plus tard, il débloque la suite de l'extrait.
const FIRST_LISTEN_S = 10;
const FAST_NO_CLOCK_MS = 8000; // seuil « rapide » quand la partie se joue sans chrono
// Bot : temps de réflexion, chance de trouver l'artiste, puis le titre.
const BOT = {
  easy:   { think: [6000, 10000], artist: 0.45, title: 0.25 },
  normal: { think: [4500, 8000],  artist: 0.65, title: 0.45 },
  hard:   { think: [3000, 6000],  artist: 0.85, title: 0.7 },
};

// Titre « assez juste » : sans la partie (feat. …) ni la ponctuation, à une faute de frappe près.
const baseTitle = (t) => deezer.norm(String(t || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s[-–]\s.*$/, ' ').replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, ' '));
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
function titleOk(track, guess) {
  const g = baseTitle(guess) || deezer.norm(guess);
  if (g.length < 2) return false;
  const targets = [baseTitle(track.title), deezer.norm(track.title)].filter(Boolean);
  return targets.some((b) => g === b || (b.length >= 5 && lev(g, b) <= Math.max(1, Math.floor(b.length / 7))));
}

class BlindRoom extends Room {
  constructor(io, hostToken, hostName, solo = false) {
    super(io, hostToken, hostName, solo);
    this.mode = 'blind';
    this.settings.turnSeconds = 30;
    this.settings.target = 10; // un tour peut rapporter 2 points : 10 pour une vraie partie
    this.log = [];        // extraits déjà joués (révélés)
    this.usedTracks = new Set();
  }

  setSettings(token, s) {
    if (token !== this.hostToken || this.phase !== 'lobby') return;
    if (TURN_CHOICES.includes(Number(s.turnSeconds))) this.settings.turnSeconds = Number(s.turnSeconds);
    const t = Number(s.target);
    if (Number.isInteger(t) && t >= 1 && t <= 20) this.settings.target = t;
    if (this.solo && BOT[s.botLevel]) this.settings.botLevel = s.botLevel;
    this.broadcast();
  }

  async start(token) {
    if (this.players.length < 2 || this.idx(token) < 0) return;
    if (this.phase === 'lobby' && token !== this.hostToken) return;
    if (this.phase !== 'lobby' && this.phase !== 'finished') return;
    this.players.forEach((p) => { p.score = 0; p.jokers = 0; });
    this.log = [];
    this.usedTracks = new Set();
    this.final = null;
    this.roundNo = 0;
    this.phase = 'playing';
    // L'hôte propose en premier (en solo : le joueur), au joueur suivant.
    this.newExtract(0);
  }

  // Les manches n'existent pas ici : pas d'arrêt entre deux manches.
  stop() {}
  next() {}

  nextPlayer(i) { return (i + 1) % this.players.length; }
  // Pas de chrono pour choisir l'artiste et le son à faire deviner : seulement pour celui qui devine.
  startClock() {
    const r = this.round;
    if (r && (r.step === 'propose' || r.step === 'pick')) { clearTimeout(this.timer); r.deadline = null; return; }
    return super.startClock();
  }
  usedArtist() { return false; } // on peut reproposer un artiste (mais jamais le même son)
  // Rien de tout ça dans le blind test.
  appeal() {} judge() {} grant() {} koRelaunch() {} koGiveUp() {} checkKO() {}

  // Joker : écouter la suite de l'extrait (de 10 s à 30 s). Un seul par extrait.
  useJoker(token) {
    const i = this.idx(token);
    const r = this.round;
    const p = this.players[i];
    if (this.phase !== 'playing' || !r || r.step !== 'guess' || i !== r.guesser || r.extended || !p || !(p.jokers > 0)) return;
    p.jokers--;
    r.extended = true;
    this.broadcast();
    this.emitAll('extractMore', { id: r.id, preview: r.track.preview, from: FIRST_LISTEN_S });
  }

  fastLimit() { return this.settings.turnSeconds ? (this.settings.turnSeconds * 1000) / 4 : FAST_NO_CLOCK_MS; }
  choosing() { return false; }

  newExtract(proposer) {
    clearTimeout(this.revealTimer);
    this.roundNo++;
    this.roundSeq = (this.roundSeq || 0) + 1;
    this.round = {
      id: this.roundSeq,
      step: 'propose',       // propose → pick → guess → reveal
      proposer,
      guesser: this.nextPlayer(proposer),
      turn: proposer,        // celui qui doit agir (le chrono le suit)
      artist: null,
      options: [],
      track: null,
      tries: 0,
      maxTries: MAX_TRIES,
      lastError: null,
      checking: false,
      result: null,
      remaining: this.settings.turnSeconds * 1000,
      deadline: null,
      out: [],
    };
    this.resetClock();
    this.broadcast();
  }

  // Le joueur qui propose a choisi un artiste : on charge ses sons les plus écoutés (avec extrait).
  async propose(i, a) {
    const r = this.round;
    r.checking = { artist: a };
    this.pauseClock();
    this.broadcast();
    let options = [];
    let found = 0;
    try {
      const top = await deezer.artistTop(a, 50);
      found = top.length;
      options = top.filter((t) => !this.usedTracks.has(t.id)).slice(0, OPTIONS).map(deezer.trackOut);
    } catch (e) { console.error('blind top', e.message); }
    if (this.round !== r || r.step !== 'propose') return;
    r.checking = false;
    if (!options.length) {
      r.lastError = { artist: a, why: found ? 'allused' : 'nopreview' };
      this.startClock();
      return this.broadcast();
    }
    r.artist = a;
    r.options = options;
    r.topOptions = options;
    r.query = '';
    r.step = 'pick';
    r.lastError = null;
    this.startClock();
    this.broadcast();
  }

  // Son choisi (ou au hasard parmi les propositions) : l'extrait part pour le joueur suivant.
  pick(token, trackId) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.step !== 'pick' || i !== r.proposer) return;
    const pool = r.options.length ? r.options : r.topOptions || [];
    const t = (trackId && pool.find((o) => o.id === Number(trackId))) || pool[Math.floor(Math.random() * pool.length)];
    if (!t) return;
    r.track = t;
    this.usedTracks.add(t.id);
    r.step = 'guess';
    r.guessAt = Date.now();
    r.extended = false;
    r.turn = r.guesser;
    r.tries = 0;
    r.lastError = null;
    this.resetClock();
    this.broadcast();
    this.emitAll('extract', { id: r.id, preview: t.preview });
  }

  // Le joueur qui propose tape un titre : on cherche ce son chez l'artiste choisi (vide = retour aux plus écoutés).
  async searchTrack(token, q) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.step !== 'pick' || i !== r.proposer) return;
    q = String(q || '').trim().slice(0, 80);
    r.query = q;
    if (q.length < 2) { r.options = r.topOptions || []; return this.broadcast(); }
    let found = [];
    try { found = (await deezer.searchArtistTracks(r.artist, q, OPTIONS)).filter((t) => !this.usedTracks.has(t.id)).map(deezer.trackOut); } catch (e) { console.error('blind search', e.message); }
    if (this.round !== r || r.step !== 'pick' || r.query !== q) return; // une recherche plus récente a pris le relais
    r.options = found;
    this.broadcast();
  }

  back(token) {
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.step !== 'pick' || this.idx(token) !== r.proposer) return;
    r.step = 'propose'; r.artist = null; r.options = [];
    this.broadcast();
  }

  // « Au hasard » pour celui qui propose : un rappeur français tiré au sort, puis un de ses sons.
  async randomStart(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.step !== 'propose' || i !== r.proposer || r.checking) return;
    return this.proposeRandom(i, true);
  }

  async proposeRandom(i, autoPick) {
    const r = this.round;
    let a = this.takeRandom(() => true);
    for (let k = 0; k < 6 && !a; k++) {
      const name = FR_RAPPERS[Math.floor(Math.random() * FR_RAPPERS.length)];
      const res = await deezer.searchArtists(name, 5).catch(() => []);
      a = res.find((x) => deezer.norm(x.name) === deezer.norm(name)) || res[0] || null;
    }
    if (this.round !== r || !a) return;
    await this.propose(i, a);
    if (autoPick && this.round === r && r.step === 'pick') {
      // Parmi les 4 sons les plus connus : un extrait reconnaissable.
      const t = r.options[Math.floor(Math.random() * Math.min(4, r.options.length))];
      this.pick(this.players[i].token, t.id);
    }
  }

  // Réutilise l'événement « answer » du jeu : proposer un artiste, ou deviner celui de l'extrait.
  async answer(token, { artist, song }) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || i !== r.turn || r.checking) return;
    if (!artist || !artist.id || !artist.name) return;
    const a = { id: Number(artist.id), name: String(artist.name).slice(0, 80), picture: artist.picture || null };
    if (r.step === 'propose' && i === r.proposer) return this.propose(i, a);
    if (r.step !== 'guess' || i !== r.guesser) return;
    if (r.tries >= MAX_TRIES) return;

    const t = r.track;
    const okArtist = a.id === r.artist.id || deezer.norm(a.name) === deezer.norm(r.artist.name)
      || (t.artists || []).some((n) => deezer.norm(n) === deezer.norm(a.name));
    if (!okArtist) {
      r.tries++;
      r.lastError = { artist: a, song: song ? String(song).slice(0, 100) : '', why: 'wrong' };
      if (r.tries >= MAX_TRIES) return this.reveal(null);
      this.missClock();
      return this.broadcast();
    }
    const title = !!song && titleOk(t, String(song));
    this.reveal({ artist: true, title, guess: a.name, song: song ? String(song).slice(0, 100) : '' });
  }

  // « Je passe » (ou chrono écoulé) : on révèle sans point.
  giveUp(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.checking) return;
    if (r.step === 'guess' && i === r.guesser) return this.reveal(null, 'pass');
  }

  timeout() {
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.checking) return;
    if (r.step === 'guess') return this.reveal(null, 'timeout');
    // Celui qui propose n'a pas choisi à temps : le jeu choisit pour lui.
    if (r.step === 'pick') return this.pick(this.players[r.proposer].token, null);
    if (r.step === 'propose') this.proposeRandom(r.proposer, true);
  }

  reveal(found, why) {
    const r = this.round;
    clearTimeout(this.timer);
    clearTimeout(this.botTimer); this.botKey = '';
    r.deadline = null;
    const points = found ? 1 + (found.title ? 1 : 0) : 0;
    const g = this.players[r.guesser];
    g.score += points;
    // Joker de rapidité : artiste trouvé dans le premier quart du chrono (pas pour le bot).
    const ms = Date.now() - (r.guessAt || Date.now());
    const fast = !!found && !g.bot && ms <= this.fastLimit();
    if (fast) g.jokers = (g.jokers || 0) + 1;
    r.step = 'reveal';
    r.turn = -1;
    r.result = { points, artist: !!found, title: !!(found && found.title), why: found ? 'found' : why || 'tries', song: found ? found.song : '', fast, ms: found ? ms : null };
    this.log.push({ proposer: r.proposer, guesser: r.guesser, artist: r.artist, track: r.track, points, title: r.result.title, fast, extended: !!r.extended, ms: found ? ms : null });
    const t = this.settings.target;
    if (g.score >= t) {
      this.phase = 'finished';
      this.final = { stopped: false, winner: r.guesser, recap: this.recap() };
      return this.broadcast();
    }
    this.broadcast();
    this.revealTimer = setTimeout(() => {
      if (this.round === r && this.phase === 'playing') this.newExtract(r.guesser);
    }, REVEAL_MS);
  }

  recap() {
    const L = this.log;
    if (!L.length) return null;
    const players = this.players.map((p, i) => {
      const mine = L.filter((x) => x.guesser === i);
      return {
        heard: mine.length,
        found: mine.filter((x) => x.points > 0).length,
        titles: mine.filter((x) => x.title).length,
        fast: mine.filter((x) => x.fast).length,
        jokers: mine.filter((x) => x.extended).length,
        best: mine.filter((x) => x.ms != null).reduce((m, x) => (m == null || x.ms < m ? x.ms : m), null),
        stumped: L.filter((x) => x.proposer === i && x.points === 0).length,
      };
    });
    return { blind: true, extracts: L.length, players };
  }

  view(forToken) {
    const me = this.idx(forToken);
    const r = this.round;
    const secret = r && r.step !== 'reveal' && me !== r.proposer;
    return {
      mode: 'blind',
      code: this.code,
      solo: this.solo,
      maxPlayers: this.solo ? 2 : 8,
      jokers: this.players[me] ? this.players[me].jokers || 0 : 0,
      fastSeconds: Math.round(this.fastLimit() / 1000),
      listenSeconds: FIRST_LISTEN_S,
      me,
      host: this.idx(this.hostToken),
      phase: this.phase,
      final: this.final,
      settings: this.settings,
      roundNo: this.roundNo,
      players: this.players.map((p) => ({ name: p.name, score: p.score, jokers: p.jokers || 0, online: !!p.bot || p.sockets.size > 0, bot: !!p.bot })),
      round: r && {
        id: r.id, step: r.step, proposer: r.proposer, guesser: r.guesser, turn: r.turn,
        tries: r.tries, maxTries: r.maxTries, lastError: r.lastError, checking: secret && r.checking ? { hidden: true } : r.checking,
        result: r.result, out: [], extended: !!r.extended,
        artist: secret ? null : r.artist,
        options: me === r.proposer && r.step === 'pick' ? r.options : [],
        query: me === r.proposer ? r.query || '' : '',
        // Pendant l'écoute : seulement l'extrait audio, rien qui donne la réponse.
        track: !r.track ? null : secret ? { preview: r.track.preview } : r.track,
        remaining: r.remaining,
        msLeft: r.deadline ? Math.max(0, r.deadline - Date.now()) : null,
        paused: !r.deadline,
      },
      log: this.log.slice(-30),
      serverNow: Date.now(),
    };
  }

  // ---------- Bot (solo) ----------
  botTick() {
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.checking) return;
    const b = this.players.findIndex((p) => p.bot);
    if (r.turn !== b) return;
    const lvl = BOT[this.settings.botLevel] || BOT.normal;
    if (r.step === 'propose') return this.botLater(`bt-prop-${r.id}`, 1500, () => this.proposeRandom(b, true));
    if (r.step === 'guess') {
      const wait = lvl.think[0] + Math.random() * (lvl.think[1] - lvl.think[0]);
      this.botLater(`bt-guess-${r.id}`, wait, () => this.botGuess(lvl));
    }
  }

  botGuess(lvl) {
    const r = this.round;
    const b = this.players.findIndex((p) => p.bot);
    if (this.phase !== 'playing' || r.step !== 'guess' || r.turn !== b) return;
    if (Math.random() > lvl.artist) return this.reveal(null, 'pass');
    const title = Math.random() < lvl.title;
    this.reveal({ artist: true, title, guess: r.artist.name, song: title ? r.track.title : '' });
  }
}

module.exports = { BlindRoom, titleOk };
