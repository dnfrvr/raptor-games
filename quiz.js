// Deux jeux de survie en tour par tour, en manches comme le Roland Gamos (une erreur élimine de la manche,
// le dernier en jeu la gagne ; premier à X manches) :
// - « Plus ou moins » (fans) : un artiste est affiché avec ses fans Deezer ; le suivant a-t-il plus ou moins de fans ?
// - « La frise » (timeline) : placer un son au bon endroit sur une frise de dates de sortie qui s'allonge.
const deezer = require('./deezer');
const mb = process.env.DEEZER_MOCK ? { firstRelease: async () => null } : require('./musicbrainz');
const { Room, TURN_CHOICES, FR_RAPPERS } = require('./game');

// Artistes du « Plus ou moins » : rap français + quelques grands noms d'ailleurs, pour des écarts de fans variés.
const WORLD = [
  'Drake', 'Rihanna', 'Eminem', 'Kanye West', 'Travis Scott', 'Kendrick Lamar', 'Nicki Minaj', 'Cardi B', 'Post Malone',
  'The Weeknd', '50 Cent', 'Snoop Dogg', 'Jay-Z', 'Future', 'Lil Wayne', 'Burna Boy', 'Wizkid', 'Central Cee', 'Dave',
  'Stromae', 'Aya Nakamura', 'Angèle', 'Wejdene', 'Shay', 'Imen Es', 'Dadju', 'Tayc', 'Aya Nakamura', 'Vitaa',
];
const POOL_FANS = [...new Set([...FR_RAPPERS, ...WORLD])];
const POOL_TIME = [...new Set([...FR_RAPPERS, 'Eminem', 'Drake', 'Kanye West', '50 Cent', 'Snoop Dogg', 'Jay-Z', 'Stromae', 'Aya Nakamura'])];

const SHOW_MS = 2600; // réponse affichée avant le tour suivant
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

class QuizRoom extends Room {
  constructor(io, hostToken, hostName, solo = false, kind = 'fans') {
    super(io, hostToken, hostName, solo);
    this.mode = kind; // 'fans' | 'timeline'
    if (solo) this.dropBot();
    this.settings.turnSeconds = 15;
    this.queue = [];
    this.fill();
  }

  setSettings(token, s) {
    if (token !== this.hostToken || this.phase !== 'lobby') return;
    if (TURN_CHOICES.includes(Number(s.turnSeconds))) this.settings.turnSeconds = Number(s.turnSeconds);
    const t = Number(s.target);
    if (Number.isInteger(t) && t >= 1 && t <= 10) this.settings.target = t;
    this.broadcast();
  }

  // ---------- Questions préparées à l'avance (pour que chaque tour s'affiche sans attendre Deezer) ----------
  async makeItem() {
    if (this.mode === 'fans') {
      const name = rand(POOL_FANS);
      const a = (await deezer.searchArtists(name, 5)).find((x) => deezer.norm(x.name) === deezer.norm(name));
      return a && a.fans ? { key: 'a' + a.id, artist: a, fans: a.fans } : null;
    }
    const name = rand(POOL_TIME);
    const a = (await deezer.searchArtists(name, 5)).find((x) => deezer.norm(x.name) === deezer.norm(name));
    if (!a) return null;
    const top = (await deezer.artistTop(a, 40)).slice(0, 25);
    if (!top.length) return null;
    const t = await deezer.getTrack(rand(top).id);
    let date = t && (t.release_date || (t.album && t.album.release_date));
    if (!date || date.startsWith('0000')) return null;
    let prec = 'day';
    // Date d'origine (MusicBrainz) si elle est plus ancienne que celle de l'album Deezer (réédition, mise en ligne tardive).
    const orig = await mb.firstRelease(t.title_short || t.title, a.name);
    if (orig && orig.date < date) ({ date, prec } = orig);
    const out = deezer.trackOut(t);
    return { key: 't' + t.id, track: { ...out, artist: a.name, picture: a.picture }, date, prec, base: deezer.norm(out.title).replace(/\s*(feat|ft)\b.*$/, '') };
  }
  async fill() {
    if (this.filling) return;
    this.filling = true;
    try {
      let guard = 0;
      while (this.queue.length < 4 && guard++ < 12) {
        const it = await this.makeItem().catch(() => null);
        if (it && !this.queue.some((q) => q.key === it.key)) this.queue.push(it);
      }
    } finally { this.filling = false; }
  }
  async take(r) {
    const seen = new Set((r.items || []).map((x) => x.key));
    const seenTitles = new Set((r.items || []).map((x) => x.base).filter(Boolean));
    for (let k = 0; k < 20; k++) {
      const i = this.queue.findIndex((q) => !seen.has(q.key) && !(q.base && seenTitles.has(q.base))
        && !(this.mode === 'fans' && r.items.length && q.fans === r.items[r.items.length - 1].fans));
      if (i >= 0) { const it = this.queue.splice(i, 1)[0]; setTimeout(() => this.fill(), 0); return it; }
      const it = await this.makeItem().catch(() => null);
      if (it) this.queue.push(it);
    }
    return null;
  }

  // ---------- Manches ----------
  async newRound() {
    await super.newRound();
    const r = this.round;
    r.items = [];   // artistes révélés (fans) ou frise triée par date (timeline)
    r.next = null;  // la question en cours
    r.result = null;
    r.checking = { loading: true };
    this.pauseClock();
    this.broadcast();
    const first = await this.take(r);
    const next = first && await this.take({ items: [first] });
    if (this.round !== r) return;
    r.checking = false;
    if (!first || !next) { r.lastError = { artist: { name: 'Deezer' }, why: 'api' }; return this.broadcast(); }
    r.items.push(first);
    r.next = next;
    r.chain.push({ artist: { name: 'start' }, by: r.turn }); // la manche est lancée (pas d'artiste de départ à choisir)
    this.resetClock();
    this.broadcast();
  }
  randomStart() {}
  choosing() { return false; }
  usedArtist() { return false; }
  appeal() {} judge() {} grant() {} useJoker() {} koRelaunch() {} koGiveUp() {} checkKO() {}

  // Réponse : fans → 'more' / 'less' ; frise → position (0 = avant tout le reste).
  async quizAnswer(token, value) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || i !== r.turn || r.checking || !r.next || r.result) return;
    let ok;
    let slot = null;
    if (this.mode === 'fans') {
      const prev = r.items[r.items.length - 1];
      if (value !== 'more' && value !== 'less') return;
      ok = r.next.fans === prev.fans || (value === 'more' ? r.next.fans > prev.fans : r.next.fans < prev.fans);
    } else {
      slot = Number(value);
      if (!Number.isInteger(slot) || slot < 0 || slot > r.items.length) return;
      const d = r.next.date;
      const before = r.items[slot - 1], after = r.items[slot];
      ok = (!before || before.date <= d) && (!after || d <= after.date);
    }
    this.resolve(i, ok, value, slot);
  }

  resolve(i, ok, value, slot) {
    const r = this.round;
    clearTimeout(this.timer);
    clearTimeout(this.botTimer); this.botKey = '';
    r.deadline = null;
    const it = r.next;
    r.result = { who: i, ok, value, item: it, slot, id: (r.resultSeq = (r.resultSeq || 0) + 1) };
    // La réponse s'affiche un instant, puis la frise / la série continue.
    if (ok) {
      if (this.mode === 'fans') r.items.push(it);
      else { r.items.push(it); r.items.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)); }
      r.chain.push({ artist: { name: it.artist ? it.artist.name : it.track.title }, by: i });
      if (this.solo) this.players[i].score++; // en solo : total de bonnes réponses
    }
    this.broadcast();
    this.showTimer = setTimeout(async () => {
      if (this.round !== r || this.phase !== 'playing') return;
      r.result = null;
      if (!ok) return this.eliminate(i, 'wrong');
      r.next = null;
      r.checking = { loading: true };
      r.turn = this.nextAlive(i);
      this.broadcast();
      const next = await this.take(r);
      if (this.round !== r || this.phase !== 'playing') return;
      r.checking = false;
      r.next = next;
      this.resetClock();
      this.broadcast();
    }, SHOW_MS);
  }

  // Chrono écoulé : mauvaise réponse.
  timeout() {
    const r = this.round;
    if (this.phase !== 'playing' || !r || r.checking || r.result || !r.next) return;
    this.resolve(r.turn, false, null, null);
  }
  giveUp(token) {
    const i = this.idx(token);
    const r = this.round;
    if (this.phase !== 'playing' || !r || i !== r.turn || r.checking || r.result || !r.next) return;
    this.resolve(i, false, null, null);
  }

  eliminate(i, reason) {
    const r = this.round;
    // Solo : une vie de moins, et on continue (au Plus ou moins, l'artiste raté devient la nouvelle référence).
    if (this.solo) return this.loseLife(reason, () => {
      if (this.mode === 'fans' && r.next) r.items.push(r.next);
      r.next = null;
      r.checking = { loading: true };
      this.broadcast();
      this.take(r).then((next) => {
        if (this.round !== r || this.phase !== 'playing') return;
        r.checking = false; r.next = next; this.resetClock(); this.broadcast();
      });
    });
    r.lastOut = { who: i, reason, on: null };
    r.out.push(r.lastOut);
    const alive = this.alive();
    if (alive.length <= 1) return this.endRound(alive.length ? alive[0] : this.nextAlive(i), reason);
    // À trois et plus : le suivant reprend avec une nouvelle question.
    r.turn = this.nextAlive(i);
    r.next = null;
    r.checking = { loading: true };
    this.broadcast();
    this.take(r).then((next) => {
      if (this.round !== r || this.phase !== 'playing') return;
      r.checking = false; r.next = next; this.resetClock(); this.broadcast();
    });
  }

  endRound(winner, reason) {
    clearTimeout(this.timer); clearTimeout(this.showTimer); clearTimeout(this.botTimer); this.botKey = '';
    const r = this.round;
    r.winner = winner; r.reason = reason; r.deadline = null;
    this.players[winner].score++;
    this.history.push({ winner, streak: r.items.length - 1, answers: r.chain.slice(1).map((l) => l.by) });
    const done = this.players[winner].score >= this.settings.target;
    if (done) this.final = { stopped: false, winner, recap: this.recap() };
    this.phase = done ? 'finished' : 'roundEnd';
    this.broadcast();
  }

  recap() {
    const H = this.history;
    if (!H.length) return null;
    const best = Math.max(...H.map((h) => h.streak));
    return {
      quiz: true, rounds: H.length, best,
      players: this.players.map((p, i) => ({ good: H.reduce((s, h) => s + h.answers.filter((b) => b === i).length, 0), rounds: p.score })),
    };
  }

  view(forToken) {
    const v = super.view(forToken);
    v.mode = this.mode;
    const r = this.round;
    if (v.round && r) {
      // Les fans / la date de la question en cours restent secrets jusqu'à la réponse.
      // Réponse en cours : secret. Révélée après la réponse, et à la fin de la manche (la date qu'on n'a pas trouvée).
      const hideNext = r.next && !r.result && this.phase === 'playing';
      v.round.next = !r.next ? null : this.mode === 'fans'
        ? { artist: r.next.artist, fans: hideNext ? null : r.next.fans }
        : { track: r.next.track, date: hideNext ? null : r.next.date, prec: r.next.prec || 'day' };
      v.round.items = (r.items || []).map((x) => (this.mode === 'fans' ? { artist: x.artist, fans: x.fans } : { track: x.track, date: x.date, prec: x.prec || 'day' }));
      v.round.result = r.result ? { who: r.result.who, ok: r.result.ok, value: r.result.value, slot: r.result.slot, id: r.result.id } : null;
      v.round.chain = r.chain.map(() => ({})); v.round.solution = undefined;
    }
    return v;
  }

  // Pas de bot : en solo, on joue seul jusqu'à la première erreur.
  botTick() {}
}

module.exports = { QuizRoom };
