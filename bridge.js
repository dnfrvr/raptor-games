// Le pont : le jeu tire deux rappeurs éloignés de 3 feats (sans raccourci connu).
// Tout le monde joue EN MÊME TEMPS, chacun sur sa propre chaîne : partir du rappeur de départ et atteindre
// celui d'arrivée de feat en feat (chaque feat vérifié sur Deezer). À la fin du chrono (ou quand tout le monde a fini),
// gagne celui qui est arrivé avec le MOINS de feats ; à égalité, le plus RAPIDE.
// On peut revenir en arrière (retirer son dernier maillon) ou abandonner le pont.
// Solo : chaque pont réussi rapporte 1 point, un pont raté coûte une vie.
const deezer = require('./deezer');
const { Room, FR_RAPPERS } = require('./game');

const same = (x, y) => !!x && !!y && ((x.id && x.id === y.id) || deezer.norm(x.name) === deezer.norm(y.name));
const rand = (arr, n = arr.length) => arr[Math.floor(Math.random() * Math.min(n, arr.length))];
const RACE_CHOICES = [0, 60, 120, 180, 300]; // durée d'un pont (0 = sans limite)
const SOLO_PAUSE_MS = 4000;

class BridgeRoom extends Room {
  constructor(io, hostToken, hostName, solo = false) {
    super(io, hostToken, hostName, solo);
    this.mode = 'bridge';
    if (solo) this.dropBot();
    this.settings.turnSeconds = 180; // ici : durée totale d'un pont
    this.nextBridge = null;
    this.prepareBridge(); // dès le salon, le premier pont est tiré et ses artistes préparés
  }

  setSettings(token, s) {
    if (token !== this.hostToken || this.phase !== 'lobby') return;
    if (RACE_CHOICES.includes(Number(s.turnSeconds))) this.settings.turnSeconds = Number(s.turnSeconds);
    const t = Number(s.target);
    if (Number.isInteger(t) && t >= 1 && t <= 10) this.settings.target = t;
    this.broadcast();
  }

  // Tire deux rappeurs A et B à 3 feats l'un de l'autre (A–X, X–Y, Y–B), sans chemin plus court connu :
  // B n'a fait de son ni avec A, ni avec aucun partenaire de A. Si aucun pont à 3 n'est trouvé, on se rabat sur 2.
  async makeBridge() {
    const n = (x) => deezer.norm(x.name);
    const collab = async (x) => (await deezer.findCollaborators(x, 100)).filter((o) => o.artist.id && !same(o.artist, x));
    let fallback = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const name = rand(FR_RAPPERS);
        const A = (await deezer.searchArtists(name, 5)).find((x) => n(x) === deezer.norm(name));
        if (!A) continue;
        const c1 = await collab(A);
        if (c1.length < 2) continue;
        const near1 = new Set(c1.map((o) => n(o.artist)));
        // Partenaires des partenaires de A (pour écarter les arrivées à 2 feats).
        const lists = await Promise.allSettled(c1.slice(0, 15).map((o) => collab(o.artist)));
        const near2 = new Set();
        lists.forEach((r) => r.status === 'fulfilled' && r.value.forEach((o) => near2.add(n(o.artist))));
        const xs = c1.slice(0, 15).sort(() => Math.random() - 0.5).slice(0, 4);
        for (const X of xs) {
          const cx = (await collab(X.artist)).filter((o) => !same(o.artist, A) && !near1.has(n(o.artist)));
          if (!cx.length) continue;
          if (!fallback) { const B2 = rand(cx, 12); fallback = { A, path: [A, X.artist, B2.artist], tracks: [X.track, B2.track] }; }
          for (const Y of cx.sort(() => Math.random() - 0.5).slice(0, 3)) {
            const cy = (await collab(Y.artist)).filter((o) => !same(o.artist, A) && !same(o.artist, X.artist)
              && !near1.has(n(o.artist)) && !near2.has(n(o.artist)));
            if (!cy.length) continue;
            const B = rand(cy, 12);
            if (deezer.knownFeat(A, B.artist)) continue;
            return this.finishBridge({ A, path: [A, X.artist, Y.artist, B.artist], tracks: [X.track, Y.track, B.track] });
          }
        }
      } catch (e) { console.error('bridge', e.message); }
    }
    return fallback ? this.finishBridge(fallback) : null;
  }
  async finishBridge({ A, path, tracks }) {
    const last = path[path.length - 1];
    const B = (await deezer.searchArtists(last.name, 5)).find((x) => x.id === last.id) || last;
    path[path.length - 1] = B;
    deezer.prepare(A); deezer.prepare(B);
    return { A, B, via: path[1], path, tracks, dist: await this.distances(B) };
  }
  // Distances jusqu'à l'arrivée (d'après les feats connus sur Deezer) : qui a fait un son avec elle (1 feat),
  // et qui a fait un son avec l'un d'eux (2 feats). Au-delà : « au moins 3 ».
  async distances(B) {
    const n = (x) => deezer.norm(x.name);
    const t1 = new Map(); // nom → artiste
    const t2 = new Map(); // nom → intermédiaire (vers l'arrivée)
    try {
      const c1 = await deezer.findCollaborators(B, 100);
      c1.forEach((o) => { if (!same(o.artist, B)) t1.set(n(o.artist), o.artist); });
      deezer.knownPartners(B).forEach((o) => { if (!t1.has(n(o.artist))) t1.set(n(o.artist), o.artist); });
      const firsts = [...t1.values()].filter((x) => x.id).slice(0, 20);
      const lists = await Promise.allSettled(firsts.map((x) => deezer.findCollaborators(x, 100)));
      lists.forEach((res, k) => {
        if (res.status !== 'fulfilled') return;
        for (const o of res.value) {
          const key = n(o.artist);
          if (!t1.has(key) && !t2.has(key) && !same(o.artist, B)) t2.set(key, firsts[k]);
        }
      });
    } catch (e) { console.error('bridge dist', e.message); }
    return { t1, t2 };
  }
  // Nombre minimum de feats restants depuis cet artiste (3 = « au moins 3 »).
  left(r, a) {
    if (same(a, r.target)) return 0;
    if (!r.dist) return null;
    const k = deezer.norm(a.name);
    return r.dist.t1.has(k) ? 1 : r.dist.t2.has(k) ? 2 : 3;
  }

  async prepareBridge() {
    if (this.loadingBridge || this.nextBridge) return;
    this.loadingBridge = true;
    try { this.nextBridge = await this.makeBridge(); } finally { this.loadingBridge = false; }
  }

  // ---------- Une manche = un pont ----------
  async newRound() {
    clearTimeout(this.timer); clearTimeout(this.soloTimer);
    this.roundNo++;
    this.roundSeq = (this.roundSeq || 0) + 1;
    const r = this.round = {
      id: this.roundSeq, start: null, target: null, solution: null,
      lanes: this.players.map(() => ({ chain: [], done: false, doneAt: null, gaveUp: false, checking: false, lastError: null })),
      startedAt: null, deadline: null, loading: true, winner: null, reason: null, results: null, out: [],
    };
    this.phase = 'playing';
    this.broadcast();
    let b = this.nextBridge;
    this.nextBridge = null;
    for (let k = 0; k < 2 && !b && this.round === r; k++) b = await this.makeBridge();
    if (this.round !== r) return;
    setTimeout(() => this.prepareBridge(), 0); // le pont de la manche suivante
    r.loading = false;
    if (!b) { r.error = 'bridge'; return this.broadcast(); }
    r.start = b.A; r.target = b.B;
    r.solution = { via: b.via, path: b.path.map((x) => ({ id: x.id, name: x.name })), tracks: b.tracks };
    r.dist = b.dist;
    // Le plus court chemin : celui du jeu (3 feats en général), sauf si un raccourci est connu.
    const known = this.left(r, b.A);
    r.shortest = known != null && known < 3 ? Math.min(known, b.path.length - 1) : b.path.length - 1;
    r.lanes.forEach((l) => l.chain.push({ artist: b.A, track: null }));
    r.startedAt = Date.now();
    if (this.settings.turnSeconds) {
      r.deadline = Date.now() + this.settings.turnSeconds * 1000;
      this.timer = setTimeout(() => this.finishRound('time'), this.settings.turnSeconds * 1000 + 200);
    }
    this.broadcast();
  }

  lane(token) {
    const i = this.idx(token);
    const r = this.round;
    if (i < 0 || this.phase !== 'playing' || !r || r.loading || r.results || !r.lanes[i]) return null;
    const l = r.lanes[i];
    return l.done || l.gaveUp ? null : { i, l, r };
  }

  async answer(token, { artist, song }) {
    const ctx = this.lane(token);
    if (!ctx || ctx.l.checking || !artist || !artist.id || !artist.name) return;
    const { i, l, r } = ctx;
    const a = { id: Number(artist.id), name: String(artist.name).slice(0, 80), picture: artist.picture || null };
    const cur = l.chain[l.chain.length - 1].artist;
    if (l.chain.some((x) => same(x.artist, a))) { l.lastError = { artist: a, why: 'used' }; return this.broadcast(); }
    l.checking = { artist: a, song: song ? String(song).slice(0, 100) : '' };
    l.lastError = null;
    this.broadcast();
    let track = null;
    try { track = await deezer.findFeat(cur, a, song ? String(song).slice(0, 100) : ''); } catch (e) { l.lastError = { artist: a, why: 'api' }; }
    if (this.round !== r || l.done || l.gaveUp || r.results) return;
    l.checking = false;
    if (!track) { if (!l.lastError) l.lastError = { artist: a, why: 'notfound' }; return this.broadcast(); }
    l.chain.push({ artist: a, track });
    l.left = this.left(r, a);
    deezer.prepare(a);
    if (same(a, r.target)) {
      l.done = true;
      l.doneAt = Date.now() - r.startedAt;
      if (this.solo || r.lanes.every((x) => x.done || x.gaveUp)) return this.finishRound('all');
    }
    this.broadcast();
  }

  // Retirer son dernier maillon (on s'est engagé sur une mauvaise piste).
  undo(token) {
    const ctx = this.lane(token);
    if (!ctx || ctx.l.checking || ctx.l.chain.length < 2) return;
    ctx.l.chain.pop();
    ctx.l.left = this.left(ctx.r, ctx.l.chain[ctx.l.chain.length - 1].artist);
    ctx.l.lastError = null;
    this.broadcast();
  }

  // Abandonner ce pont.
  giveUp(token) {
    const ctx = this.lane(token);
    if (!ctx) return;
    ctx.l.gaveUp = true;
    ctx.l.checking = false;
    if (this.solo || ctx.r.lanes.every((x) => x.done || x.gaveUp)) return this.finishRound('all');
    this.broadcast();
  }

  // Fin du pont : classement (moins de feats, puis le plus rapide).
  finishRound(reason) {
    const r = this.round;
    if (!r || r.results || this.phase !== 'playing') return;
    clearTimeout(this.timer);
    r.deadline = null;
    const ranking = r.lanes.map((l, i) => ({ i, links: l.chain.length - 1, time: l.doneAt, done: l.done, gaveUp: l.gaveUp }))
      .sort((x, y) => (y.done - x.done) || (x.done ? x.links - y.links || x.time - y.time : 0));
    r.results = ranking;
    r.reason = reason;
    const best = ranking[0] && ranking[0].done ? ranking[0] : null;
    r.winner = best ? best.i : null;

    if (this.solo) {
      // Solo : pont réussi = +1, raté = une vie de moins ; puis le pont suivant.
      if (best) {
        this.players[0].score++;
        this.broadcast();
        this.soloTimer = setTimeout(() => { if (this.round === r && this.phase === 'playing') this.newRound(); }, SOLO_PAUSE_MS);
        return;
      }
      return this.loseLife(reason === 'time' ? 'timeout' : 'giveup', () => {
        this.broadcast();
        this.soloTimer = setTimeout(() => { if (this.round === r && this.phase === 'playing') this.newRound(); }, SOLO_PAUSE_MS);
      });
    }

    if (best) this.players[best.i].score++;
    this.history.push({ winner: r.winner, links: best ? best.links : null, time: best ? best.time : null, start: r.start, target: r.target });
    const done = best && this.players[best.i].score >= this.settings.target;
    if (done) this.final = { stopped: false, winner: best.i, recap: this.recap() };
    this.phase = done ? 'finished' : 'roundEnd';
    this.broadcast();
  }

  timeout() { this.finishRound('time'); }
  next(token) {
    if (this.phase !== 'roundEnd' || this.idx(token) < 0) return;
    this.newRound();
  }
  recap() {
    const H = this.history.filter((h) => h.winner != null);
    if (!H.length) return null;
    const shortest = H.reduce((m, h) => (!m || h.links < m.links ? h : m), null);
    return { bridge: true, rounds: this.history.length, shortest: { links: shortest.links, who: shortest.winner, start: shortest.start.name, target: shortest.target.name } };
  }

  // Rien de tout ça dans le pont (pas de tour par tour).
  usedArtist() { return false; } preloadRandom() {}
  randomStart() {} appeal() {} judge() {} grant() {} useJoker() {} koRelaunch() {} koGiveUp() {} checkKO() {} botTick() {}
  startClock() {} pauseClock() {} resetClock() {} syncPresence() {}

  view(forToken) {
    const v = super.view(forToken);
    v.mode = 'bridge';
    const r = this.round;
    if (!r) return v;
    const me = this.idx(forToken);
    const over = !!r.results || this.phase !== 'playing';
    const mine = r.lanes[me];
    v.round = {
      id: r.id, start: r.start, target: r.target, loading: r.loading, error: r.error || null,
      winner: r.winner, reason: r.reason, results: r.results,
      solution: over ? r.solution : null,
      msLeft: r.deadline ? Math.max(0, r.deadline - Date.now()) : null,
      paused: !r.deadline, out: [],
      // Ma chaîne (complète) ; celle des autres reste cachée pendant la course (seulement leur avancée).
      chain: mine ? mine.chain : [],
      me: mine ? { done: mine.done, doneAt: mine.doneAt, gaveUp: mine.gaveUp, checking: mine.checking, lastError: mine.lastError, left: mine.left ?? r.shortest ?? null } : null,
      shortest: r.shortest ?? null,
      checking: mine ? mine.checking : false,
      lanes: r.lanes.map((l, i) => ({
        links: l.chain.length - 1, done: l.done, doneAt: l.doneAt, gaveUp: l.gaveUp,
        chain: over || i === me ? l.chain.map((x) => ({ artist: x.artist, track: x.track })) : null,
      })),
    };
    return v;
  }
}

module.exports = { BridgeRoom, RACE_CHOICES };
