// Le pont : le jeu tire deux artistes connus et le chemin de feats le plus court entre eux (3 ou 4 feats).
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
// Seuil de notoriété du départ et de l'arrivée (fans Deezer).
const FAN_MIN = 250000;
// Départs et arrivées possibles : le rap français de la liste du jeu, plus quelques grands noms hors rap ou d'ailleurs
// (plus loin du rap français : de quoi faire des ponts difficiles). Tous filtrés par le seuil de fans.
const ENDPOINTS = [...new Set([...FR_RAPPERS, 'Stromae', 'Aya Nakamura', 'Angèle', 'Vitaa', 'Dadju', 'Tayc', 'Shay', 'Wejdene',
  'Imen Es', 'Slimane', 'Drake', 'Travis Scott', 'Kanye West', 'Future', 'Central Cee', 'Burna Boy', 'Wizkid', 'Snoop Dogg', '50 Cent'])];

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

  // Départ et arrivée : deux artistes connus (au-dessus d'un seuil de fans Deezer), pour qu'on sache qui c'est.
  // Puis le jeu cherche le chemin le plus court entre eux, des deux côtés à la fois (2 feats depuis le départ,
  // 2 feats depuis l'arrivée) : la longueur du pont est la vraie distance entre les deux, pas un nombre tiré.
  // Deux niveaux tirés au hasard : classique (3 feats) et difficile (4 feats). Jamais moins de 3.
  static randomLevel() { return Math.random() < 0.3 ? 'hard' : 'classic'; }

  async famousByName(name) {
    const a = (await deezer.searchArtists(name, 5)).find((x) => deezer.norm(x.name) === deezer.norm(name));
    return a && a.id && a.fans >= FAN_MIN ? a : null;
  }

  async makeBridge(level = BridgeRoom.randomLevel()) {
    const n = (x) => deezer.norm(x.name);
    const collab = async (x) => (await deezer.findCollaborators(x, 100)).filter((o) => o.artist.id && !same(o.artist, x));
    let fallback = null;
    // 3 départs essayés (les noms introuvables ou sous le seuil de fans ne comptent pas, dans la limite de 15).
    for (let attempt = 0, picks = 0; attempt < 3 && picks < 15; picks++) {
      try {
        const A = await this.famousByName(rand(ENDPOINTS));
        if (!A) continue;
        attempt++;
        const { n1, n2 } = await this.around(A);
        // Arrivées possibles : des artistes connus, dans un ordre au hasard, jamais un partenaire direct du départ.
        const names = ENDPOINTS.filter((x) => deezer.norm(x) !== n(A)).sort(() => Math.random() - 0.5);
        let lookups = 0, tried = 0; // au plus 8 arrivées étudiées (chacune coûte ~20 appels Deezer, gardés en cache)
        for (const name of names) {
          const key = deezer.norm(name);
          if (n1.has(key) || n2.has(key)) continue; // 1 ou 2 feats : trop court (3 au minimum)
          if (tried >= 8 || lookups++ >= 25) break;
          const B = await this.famousByName(name);
          if (!B || same(A, B)) continue;
          tried++;
          const dist = await this.distances(B);
          if (dist.t1.has(n(A)) || dist.t2.has(n(A))) continue; // vu depuis l'arrivée : 2 feats ou moins
          const path = this.meet(A, B, n1, n2, dist);
          if (!path || path.length - 1 < 3) continue;
          const len = path.length - 1;
          const b = { A, B, path: path.map((x) => x.artist), tracks: path.slice(1).map((x) => x.track || null), level: len >= 4 ? 'hard' : 'classic' };
          if (level === 'hard' ? len >= 4 : len === 3) return this.finishBridge(b, dist);
          if (!fallback || (level === 'hard' && len > fallback.b.path.length - 1)) fallback = { b, dist };
        }
      } catch (e) { console.error('bridge', e.message); }
    }
    if (fallback) return this.finishBridge(fallback.b, fallback.dist);
    return level === 'hard' ? this.makeBridge('classic') : null; // pas de pont difficile trouvé : un classique
  }

  // Voisinage d'un artiste : ses partenaires (1 feat) et les partenaires de ses 20 partenaires les plus écoutés (2 feats).
  async around(A) {
    const n = (x) => deezer.norm(x.name);
    const collab = async (x) => (await deezer.findCollaborators(x, 100)).filter((o) => o.artist.id && !same(o.artist, x));
    const n1 = new Map(); // nom → { artist, track, rank }
    (await collab(A)).forEach((o, k) => n1.has(n(o.artist)) || n1.set(n(o.artist), { ...o, rank: k }));
    deezer.knownPartners(A).forEach((o) => { if (o.artist.id && !n1.has(n(o.artist)) && !same(o.artist, A)) n1.set(n(o.artist), { ...o, rank: 100 + n1.size }); });
    const firsts = [...n1.values()].slice(0, 20);
    const n2 = new Map(); // nom → { artist, track, via, rank }
    const lists = await Promise.allSettled(firsts.map((o) => collab(o.artist)));
    lists.forEach((res, k) => {
      if (res.status !== 'fulfilled') return;
      res.value.forEach((o, j) => {
        const key = n(o.artist);
        if (key === n(A) || n1.has(key) || n2.has(key)) return;
        n2.set(key, { ...o, via: firsts[k], rank: firsts[k].rank + j });
      });
    });
    return { n1, n2 };
  }

  // Chemin le plus court trouvé entre A et B (2, 3 ou 4 feats), en préférant des intermédiaires connus
  // (bien placés dans les sons les plus écoutés). Renvoie [{ artist, track }…] de A à B, ou null.
  meet(A, B, n1, n2, { t1, t2 }) {
    const n = (x) => deezer.norm(x.name);
    const kB = n(B);
    const best = (list) => list.sort((x, y) => x.score - y.score)[0] || null;
    const node = (artist, track) => ({ artist, track });
    const toB = (o) => node(B, o.track); // dernier maillon : un partenaire de B (t1) → B
    // 2 feats : A — m — B
    const two = [];
    for (const [k, o] of n1) if (k !== kB && t1.has(k)) two.push({ score: o.rank + t1.get(k).rank, p: [node(A), node(o.artist, o.track), toB(t1.get(k))] });
    if (two.length) return best(two).p;
    // 3 feats : A — x — w — B (x partenaire de A, w partenaire de B)
    const three = [];
    for (const [k, o] of n1) {
      const w = t2.get(k); // x a fait un son avec w, partenaire de B
      if (w && k !== kB) three.push({ score: o.rank + w.rank, p: [node(A), node(o.artist, o.track), node(w.via.artist, w.track), toB(w.via)] });
    }
    for (const [k, o] of n2) {
      if (k !== kB && t1.has(k)) three.push({ score: o.rank + t1.get(k).rank, p: [node(A), node(o.via.artist, o.via.track), node(o.artist, o.track), toB(t1.get(k))] });
    }
    if (three.length) return best(three).p;
    // 4 feats : A — x — y — w — B
    const four = [];
    for (const [k, o] of n2) {
      const w = t2.get(k);
      if (w && k !== kB && !same(o.via.artist, w.via.artist)) four.push({ score: o.rank + w.rank, p: [node(A), node(o.via.artist, o.via.track), node(o.artist, o.track), node(w.via.artist, w.track), toB(w.via)] });
    }
    return four.length ? best(four).p : null;
  }
  async finishBridge({ A, B, path, tracks, level }, dist) {
    deezer.prepare(A); deezer.prepare(B);
    return { A, B, via: path[1], path, tracks, level, len: path.length - 1, dist: dist || await this.distances(B) };
  }
  // Distances jusqu'à l'arrivée (d'après les feats connus sur Deezer) : qui a fait un son avec elle (1 feat),
  // et qui a fait un son avec l'un d'eux (2 feats). Au-delà : « au moins 3 ».
  async distances(B) {
    const n = (x) => deezer.norm(x.name);
    const t1 = new Map(); // nom → { artist, track, rank } (a fait un son avec l'arrivée ; rang = place dans ses sons)
    const t2 = new Map(); // nom → { via: partenaire de l'arrivée, track, rank }
    try {
      const c1 = await deezer.findCollaborators(B, 100);
      c1.forEach((o, k) => { if (!same(o.artist, B) && !t1.has(n(o.artist))) t1.set(n(o.artist), { ...o, rank: k }); });
      deezer.knownPartners(B).forEach((o) => { if (!t1.has(n(o.artist))) t1.set(n(o.artist), { ...o, rank: 100 + t1.size }); });
      const firsts = [...t1.values()].filter((o) => o.artist.id).slice(0, 20);
      const lists = await Promise.allSettled(firsts.map((o) => deezer.findCollaborators(o.artist, 100)));
      lists.forEach((res, k) => {
        if (res.status !== 'fulfilled') return;
        res.value.forEach((o, j) => {
          const key = n(o.artist);
          if (!t1.has(key) && !t2.has(key) && !same(o.artist, B)) t2.set(key, { via: firsts[k], track: o.track, rank: firsts[k].rank + j });
        });
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
  // Feats restants depuis cet artiste, d'après le plus court chemin connu jusqu'à l'arrivée (jusqu'à 4 ; 5 = « au moins 5 »).
  // Gardé en mémoire pour la manche (même artiste = même réponse, pour tous les joueurs).
  async distanceTo(r, a) {
    const quick = this.left(r, a);
    if (quick == null || quick <= 2) return quick;
    r.leftCache = r.leftCache || new Map();
    const k = deezer.norm(a.name);
    if (!r.leftCache.has(k)) {
      r.leftCache.set(k, (async () => {
        const { n1, n2 } = await this.around(a);
        const path = this.meet(a, r.target, n1, n2, r.dist);
        return path ? Math.max(3, path.length - 1) : 5;
      })().catch(() => 3));
    }
    return r.leftCache.get(k);
  }
  // Met à jour le compteur de la voie après un ajout ou un retrait (calcul en tâche de fond si besoin).
  updateLeft(r, l) {
    const len = l.chain.length;
    const a = l.chain[len - 1].artist;
    const quick = this.left(r, a);
    l.left = quick != null && quick <= 2 ? quick : null; // null : calcul en cours
    if (l.left != null || quick == null) return;
    this.distanceTo(r, a).then((d) => {
      if (this.round !== r || l.chain.length !== len || l.done || l.gaveUp) return;
      l.left = d;
      this.broadcast();
    });
  }

  async prepareBridge() {
    if (this.loadingBridge || this.nextBridge || this.closed) return;
    this.loadingBridge = true;
    try {
      this.nextBridge = await this.makeBridge();
    } finally { this.loadingBridge = false; }
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
    // Chemin connu du jeu. Jusqu'à 3 feats, on sait que c'est le plus court (aucun raccourci connu) ;
    // au-delà, c'est le chemin du jeu, et un plus court peut exister : à vous de le trouver.
    const known = this.left(r, b.A); // 1, 2, ou 3 (= au moins 3)
    r.pathLen = b.path.length - 1;
    r.level = b.level || 'classic';
    r.shortest = known != null && known < 3 ? Math.min(known, r.pathLen) : r.pathLen <= 3 ? r.pathLen : null;
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
    if (!ctx || ctx.l.checking || ctx.l.arriving || !artist || !artist.id || !artist.name) return;
    const { i, l, r } = ctx;
    const a = { id: Number(artist.id), name: String(artist.name).slice(0, 80), picture: artist.picture || null };
    const cur = l.chain[l.chain.length - 1].artist;
    if (l.chain.some((x) => same(x.artist, a))) { l.lastError = { artist: a, why: 'used' }; return this.broadcast(); }
    l.checking = { artist: a, song: song ? String(song).slice(0, 100) : '' };
    l.lastError = null;
    this.broadcast();
    let track = null;
    const hint = song ? String(song).slice(0, 100) : '';
    try { track = await deezer.findFeat(cur, a, hint); } catch (e) { l.lastError = { artist: a, song: hint, why: 'api' }; }
    if (this.round !== r || l.done || l.gaveUp || r.results) return;
    l.checking = false;
    if (!track) { if (!l.lastError) l.lastError = { artist: a, song: hint, why: 'notfound' }; return this.broadcast(); }
    this.link(r, l, a, track);
  }
  // Ajoute un maillon à la chaîne du joueur, puis arrivée (directe ou automatique).
  link(r, l, a, track) {
    l.chain.push({ artist: a, track });
    this.updateLeft(r, l);
    deezer.prepare(a);
    if (same(a, r.target)) return this.arrive(r, l);
    this.broadcast();
    this.autoArrive(r, l, a);
  }

  arrive(r, l, auto = false, at = Date.now()) {
    l.done = true;
    l.auto = auto;
    l.doneAt = at - r.startedAt;
    l.arriving = false;
    if (this.solo || r.lanes.every((x) => x.done || x.gaveUp)) return this.finishRound('all');
    this.broadcast();
  }

  // Arrivée automatique : si le rappeur qu'on vient d'ajouter a un son avec l'arrivée, le pont se termine tout seul
  // (pas besoin de retaper l'arrivée). D'abord ce que le jeu sait déjà (partenaires connus de l'arrivée, mémoire des
  // feats) : immédiat. Sinon, vérification complète sur Deezer en tâche de fond (feats moins connus : recherche,
  // sorties, invités) ; le temps retenu est celui où le rappeur a été ajouté.
  async autoArrive(r, l, a) {
    const B = r.target;
    const at = Date.now();
    const len = l.chain.length;
    const still = () => this.round === r && !r.results && !l.done && !l.gaveUp && l.chain.length === len;
    const known = r.dist && r.dist.t1.get(deezer.norm(a.name));
    let track = known && known.track ? known.track : deezer.knownFeat(a, B);
    if (!track) {
      l.arriving = true;
      this.broadcast();
      try { track = await deezer.findFeat(a, B, ''); } catch (_) { track = null; }
      if (!still()) { if (l.chain.length === len) { l.arriving = false; this.broadcast(); } return; }
      l.arriving = false;
      if (!track) return this.broadcast();
    }
    if (!still()) return;
    l.chain.push({ artist: B, track, auto: true });
    l.left = 0;
    this.emitAll('link', { track, artist: B });
    this.arrive(r, l, true, at);
  }

  // Feat que Deezer ne connaît pas (invité non crédité) : le joueur l'ajoute avec le titre du son. Il compte pour lui,
  // il est signalé « ajouté » aux autres à la fin du pont, et devient commun quand un autre joueur l'ajoute aussi.
  addFeat(token, song) {
    const ctx = this.lane(token);
    if (!ctx || ctx.l.checking || ctx.l.arriving) return;
    const { l, r } = ctx;
    const e = l.lastError;
    if (!e || !['notfound', 'api'].includes(e.why) || l.chain.some((x) => same(x.artist, e.artist))) return;
    const title = String(song || e.song || '').trim().slice(0, 100);
    if (title.length < 2) return { error: 'Écris le titre du son pour ajouter ce feat.' };
    const cur = l.chain[l.chain.length - 1].artist;
    const st = deezer.community.propose(cur, e.artist, title, token);
    l.lastError = null;
    l.notice = { text: st.status === 'ok' ? `« ${title} » ajouté : ce feat est maintenant reconnu partout.` : `« ${title} » ajouté à ta partie. Il sera reconnu partout dès qu'un autre joueur l'ajoute aussi.`, id: Date.now() };
    this.link(r, l, e.artist, { id: null, title, artists: [cur.name, e.artist.name], preview: null, link: null, cover: null, added: true });
  }

  // Retirer son dernier maillon (on s'est engagé sur une mauvaise piste).
  // Deezer n'a pas répondu au tirage : on retente la même manche.
  retry(token) {
    const r = this.round;
    if (this.idx(token) < 0 || this.phase !== 'playing' || !r || !r.error) return;
    this.roundNo--;
    this.newRound();
  }
  undo(token) {
    const ctx = this.lane(token);
    if (!ctx || ctx.l.checking || ctx.l.arriving || ctx.l.chain.length < 2) return;
    ctx.l.chain.pop();
    this.updateLeft(ctx.r, ctx.l);
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
      me: mine ? { done: mine.done, auto: !!mine.auto, arriving: !!mine.arriving, doneAt: mine.doneAt, gaveUp: mine.gaveUp, checking: mine.checking, lastError: mine.lastError, notice: mine.notice || null, left: mine.chain.length > 1 ? mine.left ?? null : (r.start ? r.pathLen ?? this.left(r, r.start) : null) } : null,
      shortest: r.shortest ?? null,
      pathLen: r.pathLen ?? null,
      level: r.level || null,
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
