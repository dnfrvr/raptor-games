// Logique d'une partie de Roland Gamos à deux joueurs.
const deezer = require('./deezer');

const TURN_CHOICES = [0, 10, 15, 20, 30, 45, 60];

function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

class Room {
  constructor(io, hostToken, hostName) {
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
  }

  addPlayer(token, name) {
    const existing = this.players.find((p) => p.token === token);
    if (existing) { existing.name = name || existing.name; return existing; }
    if (this.players.length >= 2) return null;
    const p = { token, name: (name || 'Joueur').slice(0, 20), score: 0, sockets: new Set() };
    this.players.push(p);
    return p;
  }

  idx(token) { return this.players.findIndex((p) => p.token === token); }

  setSettings(token, s) {
    if (token !== this.hostToken || this.phase !== 'lobby') return;
    if (TURN_CHOICES.includes(Number(s.turnSeconds))) this.settings.turnSeconds = Number(s.turnSeconds);
    const t = Number(s.target);
    if (Number.isInteger(t) && t >= 0 && t <= 10) this.settings.target = t;
    this.broadcast();
  }

  async start(token) {
    // Lancement : l'hôte. Revanche : n'importe lequel des deux (si l'hôte est parti, l'autre n'est pas bloqué).
    if (this.players.length < 2 || this.idx(token) < 0) return;
    if (this.phase === 'lobby' && token !== this.hostToken) return;
    if (this.phase !== 'lobby' && this.phase !== 'finished') return;
    this.players.forEach((p) => (p.score = 0));
    this.roundNo = 0;
    this.history = [];
    this.final = null;
    await this.newRound();
  }

  // Mode illimité : n'importe quel joueur peut arrêter la partie entre deux manches.
  stop(token) {
    if (this.phase !== 'roundEnd' || this.idx(token) < 0) return;
    const [a, b] = this.players.map((p) => p.score);
    this.final = { stopped: true, winner: a === b ? null : a > b ? 0 : 1, by: this.idx(token) };
    this.phase = 'finished';
    this.broadcast();
  }

  async next(token) {
    if (this.phase !== 'roundEnd' || this.idx(token) < 0) return;
    await this.newRound();
  }

  async newRound() {
    this.roundNo++;
    // Le premier joueur alterne à chaque manche ; c'est lui qui choisit l'artiste de départ.
    const first = (this.roundNo - 1) % 2;
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
      lastError: null,
      winner: null,
      reason: null,
    };
    this.phase = 'playing';
    this.broadcast();
  }

  choosing() { return this.round && this.round.chain.length === 0; }
  current() { const c = this.round.chain; return c.length ? c[c.length - 1].artist : null; }

  startClock() {
    clearTimeout(this.timer);
    if (!this.settings.turnSeconds) { this.round.deadline = null; return; }
    this.round.deadline = Date.now() + this.round.remaining;
    this.timer = setTimeout(() => this.timeout(), this.round.remaining + 150);
  }

  pauseClock() {
    clearTimeout(this.timer);
    if (this.round.deadline) this.round.remaining = Math.max(0, this.round.deadline - Date.now());
    this.round.deadline = null;
  }

  resetClock() {
    this.round.remaining = this.settings.turnSeconds * 1000;
    this.startClock();
  }

  timeout() {
    if (this.phase !== 'playing' || this.round.checking || this.round.appeal || this.choosing()) return;
    this.endRound(1 - this.round.turn, 'timeout');
  }

  giveUp(token) {
    const i = this.idx(token);
    if (this.phase !== 'playing' || i !== this.round.turn || this.round.checking || this.round.appeal || this.choosing()) return;
    this.endRound(1 - i, 'giveup');
  }

  endRound(winner, reason) {
    clearTimeout(this.timer);
    this.round.winner = winner;
    this.round.reason = reason;
    this.round.deadline = null;
    this.players[winner].score++;
    this.history.push({ start: this.round.start, links: this.round.chain.length - 1, winner });
    const done = this.settings.target > 0 && this.players[winner].score >= this.settings.target;
    if (done) this.final = { stopped: false, winner };
    this.phase = done ? 'finished' : 'roundEnd';
    this.broadcast();
  }

  usedArtist(a) {
    return this.round.chain.some((l) => l.artist.id === a.id || deezer.norm(l.artist.name) === deezer.norm(a.name));
  }

  async answer(token, { artist, song }) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || i !== r.turn || r.checking || r.appeal) return;
    if (!artist || !artist.id || !artist.name) return;
    const a = { id: Number(artist.id), name: String(artist.name).slice(0, 80), picture: artist.picture || null };

    // Premier coup de la manche : le joueur pose l'artiste de départ, rien à vérifier.
    if (this.choosing()) {
      r.start = a;
      r.chain.push({ artist: a, by: r.turn, track: null });
      r.turn = 1 - r.turn;
      this.resetClock();
      this.broadcast();
      return;
    }
    const cur = this.current();
    const attempt = { artist: a, song: song ? String(song).slice(0, 100) : '' };

    if (this.usedArtist(a)) {
      r.lastError = { ...attempt, why: 'used' };
      this.broadcast();
      return;
    }

    r.checking = attempt;
    r.lastError = null;
    this.pauseClock();
    this.broadcast();

    let track = null;
    let failed = false;
    try {
      track = await deezer.findFeat(cur, a, attempt.song);
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
      this.startClock();
      this.broadcast();
    }
  }

  accept(a, track, byAppeal) {
    const r = this.round;
    r.chain.push({ artist: a, by: r.turn, track, byAppeal });
    r.turn = 1 - r.turn;
    r.lastError = null;
    r.appeal = null;
    r.appealUsed = false;
    this.resetClock();
    this.broadcast();
    this.emitAll('link', { track, artist: a });
  }

  // Deezer ne trouve rien ? Le joueur peut demander à l'adversaire de valider à la main (une fois par tour).
  appeal(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || i !== r.turn || r.checking || r.appeal || r.appealUsed) return;
    if (!r.lastError || r.lastError.why === 'used') return;
    r.appeal = { artist: r.lastError.artist, song: r.lastError.song };
    r.appealUsed = true;
    this.pauseClock();
    this.broadcast();
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
      this.startClock();
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
      me,
      host: this.idx(this.hostToken),
      phase: this.phase,
      final: this.final,
      settings: this.settings,
      roundNo: this.roundNo,
      players: this.players.map((p) => ({ name: p.name, score: p.score, online: p.sockets.size > 0 })),
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
  }
}

module.exports = { Room, TURN_CHOICES };
