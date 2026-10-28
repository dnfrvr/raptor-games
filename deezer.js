// Accès à l'API publique Deezer (aucune clé requise) + vérification des featurings.
// Doc : https://developers.deezer.com/api

const API = 'https://api.deezer.com';
const TTL = 1000 * 60 * 60 * 6; // 6 h de cache : catalogue à jour sans marteler l'API
const cache = new Map();

// File d'attente : Deezer limite à ~50 requêtes / 5 s par IP.
// Deux priorités : les vérifications d'un joueur qui attend passent toujours avant la préparation en tâche de fond,
// qui n'utilise jamais plus de 2 places à la fois.
let inFlight = 0, lowInFlight = 0;
const high = [], low = [];
const MAX_CONCURRENT = 6, MAX_LOW = 2;
function pump() {
  while (inFlight < MAX_CONCURRENT && (high.length || (low.length && lowInFlight < MAX_LOW))) {
    const job = high.length ? high.shift() : low.shift();
    inFlight++; if (job.isLow) lowInFlight++;
    job.started = true;
    job.fn().then(job.resolve, job.reject).finally(() => { inFlight--; if (job.isLow) lowInFlight--; pump(); });
  }
}

let fetcher = (url) => fetch(url, { headers: { 'Accept-Language': 'fr' } });
function setFetcher(fn) { fetcher = fn; }

// Appels identiques en cours : on attend le même résultat au lieu de relancer (sauf si une préparation en tâche
// de fond n'a pas encore démarré et qu'un joueur attend : là on passe devant).
const pending = new Map();
// opts.maxAge : n'accepte le cache que s'il a moins de maxAge ms (les liens d'extraits audio Deezer expirent vite).
function get(path, opts = {}) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now() && (opts.maxAge == null || Date.now() - hit.at < opts.maxAge)) return Promise.resolve(hit.data);
  const p = pending.get(path);
  if (p && (p.started() || opts.low)) return p.promise;
  let job;
  const promise = fetchPath(path, !!opts.low, (j) => (job = j)).finally(() => { if (pending.get(path) === entry) pending.delete(path); });
  const entry = { promise, started: () => !job || job.started };
  pending.set(path, entry);
  return promise;
}

// Passe par la file, met en cache, et apprend les feats contenus dans la réponse (« Mémoire des feats » plus bas).
async function fetchPath(path, isLow, onJob) {
  const data = await new Promise((resolve, reject) => {
    const job = { fn: () => callDeezer(path), resolve, reject, isLow };
    onJob(job);
    (isLow ? low : high).push(job);
    pump();
  });
  cache.set(path, { data, exp: Date.now() + TTL, at: Date.now() });
  if (cache.size > 8000) cache.delete(cache.keys().next().value);
  try { learnFrom(path, data); } catch (_) { /* jamais bloquant */ }
  return data;
}

async function callDeezer(path) {
  {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetcher(API + path);
      if (!res.ok) throw new Error(`Deezer HTTP ${res.status}`);
      const json = await res.json();
      // Code 4 = quota dépassé : on attend un peu et on réessaie.
      if (json && json.error && json.error.code === 4) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (json && json.error) throw new Error(`Deezer: ${json.error.message || 'erreur'}`);
      return json;
    }
    throw new Error('Deezer: quota dépassé');
  }
}

// Normalisation pour comparer des noms ("Gims" == "GIMS", "Beyoncé" == "beyonce")
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function artistOut(a) {
  return {
    id: a.id,
    name: a.name,
    // Sans photo, Deezer renvoie une silhouette grise (URL avec "/artist//") : on garde alors l'initiale.
    picture: (() => { const u = a.picture_medium || a.picture || null; return u && !/\/artist\/\//.test(u) ? u : null; })(),
    fans: a.nb_fan || 0,
  };
}

async function searchArtists(q, limit = 8) {
  if (!q || !q.trim()) return [];
  // On prend large (25 résultats) puis on classe par nombre de fans Deezer, les plus connus d'abord.
  // Exception : un artiste dont le nom correspond exactement à la saisie reste en tête.
  const data = await get(`/search/artist?q=${encodeURIComponent(q.trim())}&limit=25`);
  const typed = norm(q);
  return (data.data || [])
    .map(artistOut)
    .sort((x, y) => (norm(y.name) === typed) - (norm(x.name) === typed) || y.fans - x.fans)
    .slice(0, limit);
}

async function getArtist(id) {
  return artistOut(await get(`/artist/${Number(id)}`));
}

function trackOut(t) {
  return {
    id: t.id,
    title: t.title_short || t.title,
    fullTitle: t.title,
    preview: t.preview || null,
    link: t.link || `https://www.deezer.com/track/${t.id}`,
    cover: (t.album && (t.album.cover_medium || t.album.cover)) || null,
    album: t.album ? t.album.title : null,
    artists: (t.contributors || (t.artist ? [t.artist] : [])).map((c) => c.name),
  };
}

function matches(person, target) {
  return person && (person.id === target.id || (norm(person.name) && norm(person.name) === norm(target.name)));
}

/**
 * Noms crédités dans la partie « feat » d'un titre, et seulement là.
 * - entre parenthèses ou crochets qui commencent par feat / ft / featuring / with / avec / w/ ;
 * - hors parenthèses, après feat / ft / featuring (pas « avec » ni « with », trop courants dans les titres).
 * Chaque crédit est découpé en noms : « Francisco & DJ Abdel » → ["Francisco", "DJ Abdel"].
 * « Thugfeelings » ne contient aucun crédit : on ne cherche jamais un nom au milieu d'un mot.
 */
const FEAT_GROUP = /[([]\s*(?:feat\.?|ft\.?|featuring|with|avec|w\/)\s+([^)\]]+)[)\]]/gi;
const FEAT_TAIL = /(?:^|\s)(?:feat\.?|ft\.?|featuring)\s+([^([]+)/i;
function featCredits(title) {
  title = String(title || '');
  const parts = [];
  let m;
  FEAT_GROUP.lastIndex = 0;
  while ((m = FEAT_GROUP.exec(title))) parts.push(m[1]);
  const rest = title.replace(FEAT_GROUP, ' ');
  if ((m = rest.match(FEAT_TAIL))) parts.push(m[1]);
  return parts
    .flatMap((p) => p.split(/\s*(?:,|&|\+|\s(?:x|et|and|feat\.?|ft\.?)\s)\s*/i))
    .map((n) => n.trim())
    .filter(Boolean);
}

// Un son prouve le feat A × B si :
// - A et B y figurent tous les deux, soit comme artistes crédités par Deezer, soit comme crédit entier dans la partie feat du titre ;
// - et le son appartient à l'un des deux (artiste principal ou crédité), pour ne pas valider le son d'un inconnu qui les cite.
function proves(track, a, b) {
  const people = track.contributors && track.contributors.length ? track.contributors : track.artist ? [track.artist] : [];
  const credits = featCredits(track.title).map(norm);
  const has = (x) => people.some((p) => matches(p, x)) || credits.includes(norm(x.name));
  return has(a) && has(b) && people.some((p) => matches(p, a) || matches(p, b));
}

async function getTrack(id) {
  return get(`/track/${id}`);
}

/**
 * Cherche un son où les artistes a et b apparaissent ensemble.
 * a, b : { id, name } ; songHint : titre optionnel donné par le joueur.
 * Renvoie la piste trouvée ou null.
 */
// Le titre donné par le joueur correspond-il au son ? (sans tenir compte de la partie feat, des accents ni de la casse)
function baseTitle(title) {
  return norm(String(title || '').replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, ' '));
}
function titleMatches(t, hint) {
  const h = norm(hint);
  if (h.length < 2) return false;
  const base = baseTitle(t.title_short || t.title);
  return h === base || h === norm(t.title_short) || h === norm(t.title) || h === baseTitle(hint) && baseTitle(hint) === base;
}

const RARE_RANK = 30;
const SMALL_TOP = 50;
const DEEP_FANS = 1000000;   // artiste « moyen » (moins d'un million de fans) : on fouille aussi ses sorties
const FEAT_BUDGET_MS = 4000; // temps maximum d'une vérification qui n'aboutit pas (hors file d'attente Deezer)
 // top Deezer de moins de 50 sons = petit artiste : on fouille ses sorties // un feat est « rare » si son son n'est dans les 30 plus écoutés d'aucun des deux artistes

/**
 * Cherche un son où a et b apparaissent ensemble.
 * Renvoie la piste (avec rare = feat peu connu, hinted = le titre donné par le joueur est le bon), ou null.
 * Si le joueur a donné un titre, on essaie de prouver le feat avec CE son-là.
 */
async function findFeat(a, b, songHint, ctx = {}) {
  const hint = songHint && songHint.trim();
  const pk = pairKey(a.name, b.name);
  const stage = (st) => { ctx.stage = st; };

  // Feat ajouté par les joueurs (pas crédité chez Deezer) : validé d'office.
  const added = community.lookup(a, b);
  if (added) { stage('joueurs'); const t = await communityTrack(added, a, b); return { ...t, rare: false, hinted: !!hint && titleMatches(t, hint) }; }

  // 0) Déjà connu (vu dans une autre partie, pendant la préparation, etc.) : aucune recherche.
  //    Mauvaise réponse déjà tentée récemment (sans titre) : refus immédiat.
  const memo = knownFeat(a, b);
  const asRaw = (o) => ({ id: o.id, title: o.fullTitle || o.title, title_short: o.title });
  if (!memo && !hint && (noFeat.get(pk) || 0) > Date.now()) { stage('refus mémorisé'); return null; }
  if (memo && (!hint || titleMatches(asRaw(memo), hint))) {
    stage('mémoire');
    // Feat connu : seuls les tops servent encore (savoir s'il est « rare »), sans aucune recherche.
    const tops = await Promise.allSettled([get(`/artist/${a.id}/top?limit=100`), get(`/artist/${b.id}/top?limit=100`)]);
    const ranks = tops.map((r) => new Map((r.status === 'fulfilled' ? r.value.data || [] : []).map((t, i) => [t.id, i])));
    const rare = ranks.every((m) => !m.has(memo.id) || m.get(memo.id) >= RARE_RANK);
    const inTop = tops.flatMap((r) => (r.status === 'fulfilled' ? r.value.data || [] : [])).find((t) => t.id === memo.id);
    const track = inTop ? { ...memo, preview: inTop.preview || memo.preview } : await freshTrack(memo);
    const { at, ...clean } = track;
    return { ...clean, rare, hinted: !!hint };
  }

  // 1) Tout part en même temps : les tops des deux artistes (avec la liste des artistes de chaque son), les recherches
  //    « A B » et « B A » (et avec le titre s'il est donné), Genius (crédits des invités) et le nombre de fans
  //    (pour savoir s'il faut fouiller les sorties). On n'attend que les tops si le feat y est déjà.
  const settle = (p) => p.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
  const search = (q) => settle(get(`/search?q=${encodeURIComponent(q)}&limit=25`));
  const started = Date.now();
  const searchesP = Promise.all([
    search(`${a.name} ${b.name}`), search(`${b.name} ${a.name}`),
    ...(hint ? [search(`${hint} ${b.name}`), search(`${hint} ${a.name}`)] : []),
  ]);
  const tag = (p, st) => p.then((v) => (v ? { v, st } : null), () => null);
  const geniusP = tag(geniusFeat(a, b, hint), 'genius');
  let geniusNow = null; geniusP.then((x) => { geniusNow = x; });
  const fansP = Promise.all([a, b].map((x) => (x.fans != null ? x.fans : getArtist(x.id).then((y) => y.fans).catch(() => null))));
  const [topA, topB] = await Promise.all([settle(get(`/artist/${a.id}/top?limit=100`)), settle(get(`/artist/${b.id}/top?limit=100`))]);
  const data = (r) => (r.status === 'fulfilled' ? r.value.data || [] : []);
  const rankIn = [topA, topB].map((r) => new Map(data(r).map((t, i) => [t.id, i])));
  const isRare = (t) => rankIn.every((m) => !m.has(t.id) || m.get(t.id) >= RARE_RANK);
  const result = (t) => ({ ...trackOut(t), rare: isRare(t), hinted: !!hint && titleMatches(t, hint) });
  const done = (t, st) => { stage(st); noFeat.delete(pk); return result(t); };
  const credited = (x) => { stage(x.st); noFeat.delete(pk); return { ...x.v, rare: true, hinted: !!hint && titleMatches(x.v, hint) }; };

  const ok = (t) => proves(t, a, b);
  const provers = dedupe([...data(topA), ...data(topB)].filter(ok));
  const want = (t) => !hint || titleMatches(t, hint);
  const best = provers.find(want);
  if (best) return done(best, 'tops');
  const mbP = tag(mbFeat(a, b, hint), 'musicbrainz'); // une requête par seconde au plus : seulement si les tops n'ont rien

  // 2) Recherches : preuve directe par le titre ; sinon, si Genius a déjà répondu, on s'arrête là ;
  //    sinon détail (liste officielle des artistes) des 10 premiers résultats seulement.
  const searches = await searchesP;
  const searchHits = dedupe(searches.flatMap((r) => data(r).slice(0, 8)));
  const direct = searchHits.find((t) => ok(t) && want(t));
  if (direct) return done(direct, 'recherche');
  if (geniusNow && !hint) return credited(geniusNow);
  const firstOfEach = dedupe([0, 1, 2, 3, 4].flatMap((k) => searches.map((r) => data(r)[k]).filter(Boolean))).slice(0, 10);
  const det = await Promise.allSettled(firstOfEach.map((t) => getTrack(t.id)));
  const found = det.map((d) => (d.status === 'fulfilled' ? d.value : null)).filter((t) => t && ok(t));
  const pick = found.find(want) || provers[0] || found[0];
  if (pick && want(pick)) return done(pick, 'recherche');
  if (hint && (pick || memo)) {
    // Feat prouvé, mais pas avec le titre donné : on fouille encore pour ce son précis, sinon on garde le feat trouvé.
    const precise = await findFeatDeep(a, b, (t) => titleMatches(t, hint));
    if (precise) return done(precise, 'albums');
    if (pick) return done(pick, 'recherche');
    stage('mémoire');
    return { ...memo, rare: isRare(memo), hinted: false };
  }

  // 3) Fouille des sorties (albums, EP, singles, apparitions « feat. X ») des petits et moyens artistes, en course
  //    avec Genius et MusicBrainz : le premier qui prouve le feat gagne. Au-delà du temps maximum, on répond
  //    « non trouvé » sans le retenir comme faux (les recherches finissent en fond et le feat est appris).
  const fans = await fansP;
  const deepFor = [[a, topA, fans[0]], [b, topB, fans[1]]]
    .filter(([, t, f]) => data(t).length < SMALL_TOP || (f != null && f < DEEP_FANS)).map(([x]) => x);
  const deepP = tag(deepFor.length ? findFeatDeep(a, b, () => true, deepFor) : Promise.resolve(null), 'albums');
  const last = await firstHit([deepP, geniusP, mbP], Math.max(1000, FEAT_BUDGET_MS - (Date.now() - started)));
  if (last === TIMEOUT) { stage('temps dépassé'); return null; }
  if (last && last.st === 'albums') return done(last.v, 'albums');
  if (last) return credited(last);
  stage('introuvable');
  if (!hint) noFeat.set(pk, Date.now() + NO_FEAT_TTL);
  return null;
}

// Premier résultat non nul parmi des promesses (null si aucune ne trouve, TIMEOUT si le temps est écoulé).
const TIMEOUT = Symbol('timeout');
function firstHit(promises, ms) {
  return new Promise((resolve) => {
    let left = promises.length;
    const timer = setTimeout(() => resolve(TIMEOUT), ms);
    const end = (v) => { clearTimeout(timer); resolve(v); };
    if (!left) return end(null);
    for (const p of promises) {
      Promise.resolve(p).then((v) => { if (v) end(v); else if (--left === 0) end(null); }, () => { if (--left === 0) end(null); });
    }
  });
}

// Le son qui relie déjà l'artiste en jeu à la chaîne (le dernier maillon) contient-il aussi l'artiste proposé ?
// C'est alors la preuve, sans recherche (utile quand ce son appartient à un troisième artiste).
async function featFromTrack(track, b) {
  if (!track || !track.id) return null;
  const names = await trackArtists(track).catch(() => []);
  return names.some((n) => norm(n) === norm(b.name)) ? { ...track, rare: false, hinted: false } : null;
}

/**
 * Vérification d'un feat, la même dans tous les jeux (Roland Gamos, Le pont, arrivée automatique…).
 * Ordre : base des joueurs → son du dernier maillon → mémoire → Deezer (tops, recherches, sorties) → MusicBrainz et Genius.
 * opts.song : titre donné par le joueur ; opts.lastTrack : son qui relie déjà `a` à la chaîne.
 */
async function verifyFeat(a, b, { song = '', lastTrack = null } = {}) {
  const t0 = Date.now();
  const ctx = { stage: null };
  let t = null;
  try {
    if (!community.lookup(a, b) && lastTrack) {
      const viaLast = await featFromTrack(lastTrack, b);
      if (viaLast && (!song || titleMatches({ title: viaLast.title }, song))) { ctx.stage = 'dernier maillon'; t = viaLast; }
    }
    if (!t) t = await findFeat(a, b, song, ctx);
    return t;
  } finally {
    record(ctx.stage || (t ? 'autre' : 'introuvable'), Date.now() - t0, !!t, `${a.name} × ${b.name}`);
  }
}

// ---------- Mesure : temps de chaque vérification, et quelle étape a répondu (page admin) ----------
const stats = { since: Date.now(), byStage: new Map(), recent: [] };
function record(st, ms, ok, pair) {
  const s = stats.byStage.get(st) || { n: 0, total: 0, max: 0, times: [] };
  s.n++; s.total += ms; s.max = Math.max(s.max, ms);
  s.times.push(ms); if (s.times.length > 200) s.times.shift();
  stats.byStage.set(st, s);
  stats.recent.unshift({ at: Date.now(), pair, stage: st, ms, ok });
  if (stats.recent.length > 30) stats.recent.pop();
}
function featStats() {
  const p90 = (arr) => { const x = [...arr].sort((u, v) => u - v); return x.length ? x[Math.min(x.length - 1, Math.floor(x.length * 0.9))] : 0; };
  const rows = [...stats.byStage].map(([stage, s]) => ({ stage, n: s.n, avg: Math.round(s.total / s.n), p90: p90(s.times), max: s.max }))
    .sort((x, y) => y.n - x.n);
  const all = [...stats.byStage.values()].reduce((m, s) => ({ n: m.n + s.n, total: m.total + s.total }), { n: 0, total: 0 });
  return { since: stats.since, total: all.n, avg: all.n ? Math.round(all.total / all.n) : 0, rows, recent: stats.recent };
}

// Partenaires connus d'un artiste, vite : ses 100 sons les plus écoutés + ce que le jeu a déjà appris
// (autres parties, préparation, MusicBrainz, feats ajoutés par les joueurs). Même liste pour le bot, le K.O. et Le pont.
async function quickPartners(a, isUsed = () => false) {
  const top = (await findCollaborators(a, 100)).filter((o) => !isUsed(o.artist));
  const seen = new Set(top.map((o) => norm(o.artist.name)));
  return [...top, ...knownPartners(a, isUsed).filter((o) => !seen.has(norm(o.artist.name)) && !matches(o.artist, a))];
}

// Version Deezer d'un son dont on connaît le titre (extrait, pochette) : recherche « titre + artiste ».
async function trackByTitle(a, b, title) {
  try {
    const looks = await Promise.allSettled([a, b].map((x) => get(`/search?q=${encodeURIComponent(`${title} ${x.name}`)}&limit=10`)));
    const hits = looks.flatMap((r) => (r.status === 'fulfilled' ? r.value.data || [] : []));
    const t = hits.find((h) => titleMatches(h, title) && h.artist && (matches(h.artist, a) || matches(h.artist, b)));
    return t ? { ...trackOut(t), artists: [...new Set([...trackOut(t).artists, a.name, b.name])] } : null;
  } catch (_) { return null; }
}
const bareTrack = (a, b, title) => ({ id: null, title, fullTitle: title, preview: null, link: null, cover: null, album: null, artists: [a.name, b.name] });

// Feat confirmé par une source de crédits extérieure (MusicBrainz, Genius) : on va chercher le son chez Deezer
// (extrait, pochette), sinon on garde le titre seul. Le feat est ensuite retenu comme les autres : la prochaine fois,
// réponse immédiate.
let mb = null, genius = null;
async function fromCredits(a, b, rec, source) {
  // Réponse tout de suite avec le titre ; la version Deezer (extrait, pochette) est cherchée en fond et retenue.
  const out = { ...bareTrack(a, b, rec.title), source };
  const exp = Date.now() + MEMO_TTL;
  link(a, b, out, exp); link(b, a, out, exp);
  trackByTitle(a, b, rec.title).then((t) => {
    if (!t) return;
    const full = { ...t, source };
    featMemo.set(pairKey(a.name, b.name), { track: { ...full, at: Date.now() }, exp }); memoDirty++;
    for (const [x, y] of [[a, b], [b, a]]) { const m = partnerIdx.get(norm(x.name)); if (m) m.delete(norm(y.name)); link(x, y, full, exp); }
  }).catch(() => {});
  return out;
}
async function mbFeat(a, b, hint) {
  if (process.env.DEEZER_MOCK) return null; // tests hors-ligne
  if (!mb) mb = require('./musicbrainz');
  const rec = await mb.findTogether(a.name, b.name, hint, norm).catch(() => null);
  return rec ? fromCredits(a, b, rec, 'musicbrainz') : null;
}
async function geniusFeat(a, b, hint) {
  if (process.env.DEEZER_MOCK) return null;
  if (!genius) genius = require('./genius');
  const rec = await genius.findTogether(a.name, b.name, hint, norm).catch(() => null);
  return rec ? fromCredits(a, b, rec, 'genius') : null;
}

// ---------- Feats ajoutés par les joueurs (base commune, voir community.js) ----------
const community = require('./community');
const FOREVER = 8.64e15;
// Un feat validé entre dans la mémoire (partenaires connus : utile au bot, au K.O., aux ponts) ; supprimé, il en sort.
function learnCommunity(e, removed) {
  const a = { id: e.a.id, name: e.a.name }, b = { id: e.b.id, name: e.b.name };
  const ka = norm(a.name), kb = norm(b.name);
  if (removed || e.status !== 'ok') {
    for (const [x, y] of [[ka, kb], [kb, ka]]) { const m = partnerIdx.get(x); const o = m && m.get(y); if (o && o.track && o.track.source === 'joueurs') m.delete(y); }
    return;
  }
  noFeat.delete(pairKey(a.name, b.name));
  const t = { ...(e.track || bareTrack(a, b, e.title)), source: 'joueurs' };
  for (const [x, y] of [[ka, kb], [kb, ka]]) { const m = partnerIdx.get(x); if (m && m.has(y) && m.get(y).track.source === 'joueurs') m.delete(y); }
  link(a, b, t, FOREVER); link(b, a, t, FOREVER);
}
async function communityTrack(e, a, b) {
  if (e.track === undefined) e.track = await trackByTitle(a, b, e.title); // cherché une fois (null : pas sur Deezer)
  const t = e.track ? await freshTrack(e.track).catch(() => e.track) : bareTrack(a, b, e.title);
  return { ...t, title: e.track ? t.title : e.title, source: 'joueurs' };
}

// Étape 3 : sorties (albums, EP, singles) des deux artistes et apparitions « feat. X ».
// `want` (facultatif) impose une condition sur le son trouvé.
async function findFeatDeep(a, b, want = () => true, only = [a, b]) {
  const ok = (t) => proves(t, a, b) && want(t);
  const scan = (x) => only.some((o) => o.id === x.id);
  const none = Promise.resolve([]);
  try {
    const [ta, tb, ga, gb] = await Promise.all([
      scan(a) ? albumTracks(a) : none, scan(b) ? albumTracks(b) : none,
      scan(a) ? guestTracks(a) : none, scan(b) ? guestTracks(b) : none,
    ]);
    // Feat écrit dans le titre : prouvé sans appel de plus.
    const direct = dedupe([...tb, ...ta, ...gb, ...ga]).find(ok);
    if (direct) return (await getTrack(direct.id).catch(() => null)) || direct;
    // Liste officielle des artistes des sons de leurs sorties. Deezer crédite souvent les invités comme artistes
    // à part entière sans rien écrire dans le titre (ex. « CAUCHEMAR » : Vadek, EDGE, Demas).
    // Le plus petit catalogue d'abord (c'est là que le son a le plus de chances d'être), arrêt dès que c'est prouvé.
    const ua = featFirst(uniqueByTitle(ta)), ub = featFirst(uniqueByTitle(tb));
    const lists = (ua.length <= ub.length ? [ua, ub] : [ub, ua]).filter((l) => l.length);
    for (const [k, list] of lists.entries()) {
      if (k === 1 && list.length > 60) break; // gros catalogue : déjà couvert par son top et la recherche
      const det = await detailInBatches(list, (got) => got.some(ok), 40);
      const hit = det.find(ok);
      if (hit) return hit;
    }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Pour le bot du mode solo : liste des artistes ayant un son avec `a`, chacun avec le son qui le prouve.
 * Source : les titres les plus écoutés de l'artiste (Deezer y donne les contributeurs).
 * depth = nombre de titres regardés (le bot facile ne connaît que les gros sons).
 */
async function findCollaborators(a, depth = 100) {
  const top = await get(`/artist/${a.id}/top?limit=${depth}`);
  const out = new Map(); // nom normalisé → { artist, track }
  const add = (person, t) => {
    const k = norm(person.name);
    if (!k || matches(person, a) || out.has(k)) return;
    out.set(k, { artist: person.id ? artistOut(person) : { id: null, name: person.name, picture: null }, track: trackOut(t) });
  };
  for (const t of top.data || []) {
    const people = t.contributors && t.contributors.length ? t.contributors : t.artist ? [t.artist] : [];
    const credits = featCredits(t.title);
    const involved = people.some((p) => matches(p, a)) || credits.map(norm).includes(norm(a.name));
    if (!involved) continue;
    // Artistes crédités par Deezer, puis ceux écrits seulement dans le titre (« feat. Demas »).
    people.forEach((p) => p.id && add(p, t));
    credits.forEach((name) => add({ name }, t));
  }
  return [...out.values()];
}

// ---------- Fouille profonde (au-delà des 100 sons les plus écoutés) ----------
const DEEP_RELEASES = 25; // sorties les plus récentes regardées par artiste

function dedupe(tracks) {
  const seen = new Set();
  return tracks.filter((t) => t && !seen.has(t.id) && seen.add(t.id));
}

// Un même son apparaît souvent deux fois (single puis album) : on garde une seule version par titre.
function uniqueByTitle(tracks) {
  const seen = new Set();
  return tracks.filter((t) => { const k = norm(t.title_short || t.title); return k && !seen.has(k) && seen.add(k); });
}
// Les sons marqués « feat » d'abord, puis les autres (Deezer crédite souvent les invités sans rien écrire dans le titre).
const featFirst = (tracks) => [...tracks.filter((t) => featCredits(t.title).length), ...tracks.filter((t) => !featCredits(t.title).length)];
// Détail (liste officielle des artistes) des sons, par lots, en s'arrêtant dès que `enough(détails)` est vrai.
async function detailInBatches(tracks, enough, cap = 60, size = 12) {
  const out = [];
  for (let i = 0; i < Math.min(cap, tracks.length); i += size) {
    const det = await Promise.allSettled(tracks.slice(i, Math.min(i + size, cap)).map((t) => getTrack(t.id)));
    det.forEach((d) => d.status === 'fulfilled' && out.push(d.value));
    if (enough(out)) break;
  }
  return out;
}

// Titres des albums, EP et singles récents d'un artiste (une liste de titres par sortie, sans détail).
async function albumTracks(a, max = DEEP_RELEASES, isLow = false) {
  try {
    const albums = await get(`/artist/${a.id}/albums?limit=100`, { low: isLow });
    const recent = (albums.data || [])
      .filter((al) => al.record_type !== 'compile') // compilations : doublons de sons déjà sortis ailleurs
      .sort((x, y) => String(y.release_date || '').localeCompare(String(x.release_date || '')))
      .slice(0, max);
    const lists = await Promise.allSettled(recent.map((al) => get(`/album/${al.id}/tracks?limit=100`, { low: isLow })));
    return lists.flatMap((l) => (l.status === 'fulfilled' ? l.value.data || [] : []))
      .map((t) => ({ ...t, artist: t.artist || { id: a.id, name: a.name } }));
  } catch (_) { return []; }
}

// Apparitions de l'artiste chez les autres : sons dont le titre le crédite en feat.
async function guestTracks(a) {
  const qs = [`feat ${a.name}`];
  const res = await Promise.allSettled(qs.map((q) => get(`/search?q=${encodeURIComponent(q)}&limit=50`)));
  const n = norm(a.name);
  return dedupe(res.flatMap((r) => (r.status === 'fulfilled' ? r.value.data || [] : [])))
    .filter((t) => featCredits(t.title).map(norm).includes(n));
}

/**
 * Partenaires de `a` (artistes ayant un son avec lui), en excluant ceux pour qui isUsed(artiste) est vrai.
 * D'abord les 100 sons les plus écoutés ; s'ils ne donnent plus personne, fouille profonde.
 * Renvoie [{ artist: { id, name, picture }, track }] (les plus connus d'abord).
 */
// Partenaires lus seulement dans un titre (« feat. Emilie Sandre ») : Deezer ne les crédite pas sur le son, on n'a
// donc que leur nom. On retrouve leur fiche Deezer (un appel par nom) pour les premiers, quand on en a besoin.
async function withIds(list, max = 5, isUsed = () => false) {
  const missing = list.filter((o) => !o.artist.id).slice(0, max);
  await Promise.all(missing.map(async (o) => {
    try {
      const hit = (await searchArtists(o.artist.name, 3)).find((x) => norm(x.name) === norm(o.artist.name));
      if (hit && !isUsed(hit)) o.artist = hit;
    } catch (_) { /* ignore */ }
  }));
  return list;
}

// needId : le joker doit jouer un vrai artiste Deezer (photo, fiche, suite de la chaîne). Les noms lus dans un titre
// sont alors complétés avec leur fiche, et si aucun n'en a, on continue la fouille au lieu de s'arrêter là.
async function findCollaboratorsDeep(a, isUsed = () => false, { needId = false } = {}) {
  const top = (await findCollaborators(a, 100)).filter((o) => !isUsed(o.artist));
  // Partenaires déjà appris (préparation, autres parties, recherches précédentes) qui ne sont pas dans le top.
  const seenTop = new Set(top.map((o) => norm(o.artist.name)));
  const memo = knownPartners(a, isUsed).filter((o) => !seenTop.has(norm(o.artist.name)));
  const quick = [...top, ...memo];
  if (quick.length && !needId) return quick;
  if (quick.length) {
    await withIds(quick, 5, isUsed);
    if (quick.some((o) => o.artist.id)) return quick;
  }

  const [own, guest] = await Promise.all([albumTracks(a), guestTracks(a)]);
  const tracks = dedupe([...own, ...guest]);
  const found = new Map(); // nom normalisé → { artist, track }
  const add = (person, t) => {
    if (!person || !person.name || matches(person, a)) return;
    const k = norm(person.name);
    if (!k || found.has(k) || isUsed(person)) return;
    found.set(k, { artist: person.id ? artistOut(person) : { id: null, name: person.name, picture: null }, track: trackOut(t) });
  };
  // Feats lisibles dans le titre (aucun appel en plus).
  for (const t of tracks) {
    const credits = featCredits(t.title);
    const involved = matches(t.artist, a) || credits.map(norm).includes(norm(a.name));
    if (!involved) continue;
    add(t.artist, t);
    credits.forEach((name) => add({ name }, t));
  }
  // Apparitions chez d'autres (le « Featured On ») : la recherche du nom renvoie aussi les sons où l'artiste est invité.
  // On vérifie la liste des artistes des premiers résultats dont il n'est pas l'artiste principal.
  if (found.size < 3) {
    try {
      const res = (await get(`/search?q=${encodeURIComponent(a.name)}&limit=50`)).data || [];
      const others = res.filter((t) => !matches(t.artist, a)).slice(0, 24);
      const take = (t) => { if ((t.contributors || []).some((p) => matches(p, a))) (t.contributors || []).forEach((p) => add(p, t)); };
      await detailInBatches(others, (got) => { got.forEach(take); return found.size >= 5; }, 24);
    } catch (_) { /* ignore */ }
  }
  // Sinon : liste officielle des artistes de TOUS les sons de ses sorties (pas seulement ceux marqués « feat »),
  // car Deezer crédite souvent les invités sans rien écrire dans le titre. On s'arrête dès qu'on en a trouvé assez.
  if (found.size < 3) {
    const list = featFirst(uniqueByTitle(own));
    const take = (t) => {
      if (!(t.contributors || []).some((p) => matches(p, a))) return;
      (t.contributors || []).forEach((p) => add(p, t));
    };
    await detailInBatches(list, (got) => { got.forEach(take); return found.size >= 5; }, 60);
  }
  // Les noms lus seulement dans un titre n'ont pas d'identifiant Deezer : on le retrouve pour les premiers.
  const list = [...found.values()];
  await withIds(list, needId ? 8 : 5, isUsed);
  // Joker : rien trouvé de plus en fouillant, on garde au moins les partenaires du top (complétés plus haut).
  return list.length || !quick.length ? list : quick;
}

// Tous les artistes d'un son : liste officielle Deezer (détail du son) + noms écrits dans la partie feat du titre.
async function trackArtists(track) {
  const names = [...(track.artists || []), ...featCredits(track.fullTitle || track.title), ...featCredits(track.title)];
  if (track.id) {
    try {
      const t = await getTrack(track.id);
      (t.contributors || []).forEach((c) => names.push(c.name));
      if (t.artist) names.push(t.artist.name);
      featCredits(t.title).forEach((n) => names.push(n));
    } catch (_) { /* on garde ce qu'on a */ }
  }
  const seen = new Set();
  return names.filter((n) => n && !seen.has(norm(n)) && seen.add(norm(n)));
}

// ---------- Mémoire des feats (partagée entre toutes les parties) ----------
// Chaque son vu passer (tops, recherches, détails) est « appris » : pour chaque paire d'artistes du son, on retient
// le feat dans les deux sens. Une vérification déjà connue ne coûte alors plus aucun appel.
// Un feat ne disparaît pas : la mémoire garde les paires 30 jours (et survit aux redémarrages, voir persist.js).
// Seuls les extraits audio expirent côté Deezer : freshTrack() les renouvelle au moment de s'en servir.
const MEMO_TTL = 30 * 24 * 3600 * 1000;
let memoDirty = 0; // nouveautés depuis la dernière sauvegarde
const NO_FEAT_TTL = 30 * 60 * 1000; // une mauvaise réponse est retenue 30 min
const featMemo = new Map();          // "a|b" (noms normalisés, triés) → { track, exp }
const partnerIdx = new Map();        // nom normalisé → Map(nom partenaire → { artist, track, exp })
const noFeat = new Map();            // "a|b" → expiration
const pairKey = (x, y) => [norm(x), norm(y)].sort().join('|');

// Artistes d'un son : crédités par Deezer (officiels) + écrits dans la partie feat du titre.
function peopleOf(t) {
  const out = [];
  const seen = new Set();
  const push = (p, official) => { const k = norm(p.name); if (k && !seen.has(k)) { seen.add(k); out.push({ ...p, official }); } };
  (t.contributors && t.contributors.length ? t.contributors : t.artist ? [t.artist] : []).forEach((p) => push(p, true));
  featCredits(t.title).forEach((name) => push({ id: null, name }, false));
  return out;
}

function learnTrack(t) {
  if (!t || !t.id || !t.title) return;
  const ppl = peopleOf(t);
  if (ppl.length < 2) return;
  const out = { ...trackOut(t), at: Date.now() };
  const exp = Date.now() + MEMO_TTL;
  for (let i = 0; i < ppl.length; i++) {
    for (let j = i + 1; j < ppl.length; j++) {
      const x = ppl[i], y = ppl[j];
      if (!x.official && !y.official) continue; // comme proves() : au moins un des deux doit être crédité sur le son
      const k = pairKey(x.name, y.name);
      if (!featMemo.has(k)) { featMemo.set(k, { track: out, exp }); memoDirty++; }
      link(x, y, out, exp); link(y, x, out, exp);
    }
  }
  if (featMemo.size > 100000) featMemo.delete(featMemo.keys().next().value);
  if (partnerIdx.size > 30000) partnerIdx.delete(partnerIdx.keys().next().value);
}
function link(x, y, track, exp) {
  const k = norm(x.name);
  let m = partnerIdx.get(k);
  if (!m) { m = new Map(); partnerIdx.set(k, m); }
  const ky = norm(y.name);
  if (!m.has(ky) && m.size < 400) m.set(ky, { artist: y.id ? artistOut(y) : { id: null, name: y.name, picture: null }, track, exp });
}
function learnFrom(path, data) {
  if (path.startsWith('/track/')) return learnTrack(data);
  if (/^\/(artist\/\d+\/top|search\?|album\/\d+\/tracks)/.test(path)) (data.data || []).forEach(learnTrack);
}
function knownFeat(a, b) {
  const m = featMemo.get(pairKey(a.name, b.name));
  return m && m.exp > Date.now() ? m.track : null;
}
// Partenaires déjà appris d'un artiste (hors ceux pour qui isUsed est vrai).
function knownPartners(a, isUsed = () => false) {
  const m = partnerIdx.get(norm(a.name));
  if (!m) return [];
  const now = Date.now();
  return [...m.values()].filter((o) => o.exp > now && !isUsed(o.artist)).map(({ artist, track }) => ({ artist, track }));
}

// Extrait audio à jour : les liens d'extraits Deezer expirent ; un son sorti de la mémoire (appris il y a plus d'une
// heure, ou rechargé après un redémarrage) est relu chez Deezer (un appel, souvent déjà en cache).
// Lien d'extrait encore valable ? Deezer signe ses liens avec une date d'expiration (« exp=… » dans l'adresse).
function previewOk(url, marginS = 120) {
  if (!url) return false;
  const m = /exp=(\d{9,})/.exec(url);
  return !m || Number(m[1]) > Date.now() / 1000 + marginS;
}
async function freshTrack(track, force = false) {
  if (!track || !track.id) return track;
  if (!force && track.preview && previewOk(track.preview)) return track;
  try {
    const t = await get(`/track/${track.id}`, { maxAge: force ? 0 : 5 * 60 * 1000 });
    if (t && t.id) return { ...track, preview: t.preview || null, cover: (t.album && (t.album.cover_medium || t.album.cover)) || track.cover, at: Date.now() };
  } catch (_) { /* on garde le son sans extrait */ }
  return track;
}

// ---------- Sauvegarde de la mémoire (voir persist.js) ----------
// Format compact : sons dédoublonnés (sans extrait audio, qui expire), paires et partenaires pointant vers ces sons.
function exportMemory({ maxPairs = 40000, maxNames = 8000, maxPartners = 60 } = {}) {
  const now = Date.now();
  const tracks = [], tIdx = new Map();
  const ti = (o) => {
    if (!tIdx.has(o.id)) { tIdx.set(o.id, tracks.length); tracks.push([o.id, o.title, o.fullTitle, o.cover, o.album, o.artists]); }
    return tIdx.get(o.id);
  };
  const pairs = [];
  for (const [k, m] of [...featMemo].slice(-maxPairs)) if (m.exp > now) pairs.push([k, ti(m.track), m.exp]);
  const names = [];
  for (const [k, m] of [...partnerIdx].slice(-maxNames)) {
    const list = [];
    for (const [pk, o] of [...m].slice(0, maxPartners)) {
      // Feats des joueurs : sauvegardés à part (base commune) ; sons sans identifiant Deezer : pas sauvegardés ici.
      if (o.exp <= now || !o.track || !o.track.id || o.track.source === 'joueurs') continue;
      const a = o.artist.id ? [o.artist.id, o.artist.name, o.artist.picture, o.artist.fans || 0] : [null, o.artist.name];
      list.push([pk, a, ti(o.track), o.exp]);
    }
    if (list.length) names.push([k, list]);
  }
  memoDirty = 0;
  return { v: 1, tracks, pairs, names };
}
function importMemory(data) {
  if (!data || data.v !== 1) return 0;
  const now = Date.now();
  const tr = (data.tracks || []).map(([id, title, fullTitle, cover, album, artists]) => (
    { id, title, fullTitle, preview: null, link: `https://www.deezer.com/track/${id}`, cover, album, artists: artists || [], at: 0 }));
  let n = 0;
  for (const [k, i, exp] of data.pairs || []) if (exp > now && tr[i] && !featMemo.has(k)) { featMemo.set(k, { track: tr[i], exp }); n++; }
  for (const [k, list] of data.names || []) {
    let m = partnerIdx.get(k);
    if (!m) { m = new Map(); partnerIdx.set(k, m); }
    for (const [pk, a, i, exp] of list) {
      if (exp <= now || !tr[i] || m.has(pk) || m.size >= 400) continue;
      const artist = a[0] ? { id: a[0], name: a[1], picture: a[2] || null, fans: a[3] || 0 } : { id: null, name: a[1], picture: null };
      m.set(pk, { artist, track: tr[i], exp });
    }
  }
  return n;
}
const memoryStats = () => ({ pairs: featMemo.size, artists: partnerIdx.size, unsaved: memoDirty });

// Sons les plus écoutés d'un artiste (blind test) : seulement ceux qui ont un extrait audio.
// Pour les petits artistes, Deezer ne renvoie parfois que 1 ou 2 sons (voire aucun) dans le « top » :
// on complète alors avec la recherche de son nom et les sons de ses sorties (ceux qui ont un extrait).
async function artistTop(a, limit = 50) {
  // Récent (5 min) : les extraits doivent être jouables tout de suite.
  const top = await get(`/artist/${a.id}/top?limit=${limit}`, { maxAge: 5 * 60 * 1000 }).catch(() => ({ data: [] }));
  let list = (top.data || []).filter((t) => t.preview);
  if (list.length < 8) {
    const [search, own] = await Promise.all([
      get(`/search?q=${encodeURIComponent(a.name)}&limit=50`, { maxAge: 5 * 60 * 1000 }).catch(() => ({ data: [] })),
      list.length < 3 ? albumTracks(a, 8) : Promise.resolve([]),
    ]);
    const mine = (search.data || []).filter((t) => matches(t.artist, a));
    list = uniqueByTitle(dedupe([...list, ...mine, ...own])).filter((t) => t.preview);
  }
  return list.slice(0, limit);
}

// Recherche d'un son précis d'un artiste (blind test : le joueur tape le titre qu'il veut faire deviner).
async function searchArtistTracks(a, q, limit = 8) {
  const res = await get(`/search?q=${encodeURIComponent(`${a.name} ${q}`)}&limit=40`, { maxAge: 5 * 60 * 1000 });
  // Seulement les sons dont le titre contient tout ce qui a été tapé (Deezer renvoie aussi des sons approchants).
  const words = norm(q).split(' ').filter(Boolean);
  const hits = (res.data || []).filter((t) => t.preview && words.every((w) => norm(t.title).includes(w)));
  const credited = (t) => matches(t.artist, a) || featCredits(t.title).some((n) => norm(n) === norm(a.name))
    || (t.contributors || []).some((c) => matches(c, a));
  const out = hits.filter(credited);
  // Invité sans « feat » dans le titre : la liste des artistes du son le dit (quelques vérifications au plus).
  const unsure = hits.filter((t) => !credited(t)).slice(0, 6);
  const details = await Promise.all(unsure.map((t) => getTrack(t.id).catch(() => null)));
  details.forEach((d, k) => { if (d && (d.contributors || []).some((c) => matches(c, a))) out.push(unsure[k]); });
  return out.slice(0, limit);
}

// ---------- Préparation pendant que le joueur réfléchit ----------
// Dès qu'un artiste est en jeu, on charge ses partenaires en tâche de fond (basse priorité) : top, apparitions
// chez d'autres, et si besoin la liste des artistes des sons de ses sorties. La réponse du joueur, le contrôle du K.O.
// et le joker s'appuient ensuite sur la mémoire sans attendre Deezer.
const prepared = new Map(); // id artiste → date
async function prepare(a) {
  if (!a || !a.id) return;
  const last = prepared.get(a.id);
  if (last && Date.now() - last < 30 * 60 * 1000) return;
  prepared.set(a.id, Date.now());
  if (prepared.size > 5000) prepared.delete(prepared.keys().next().value);
  const lowGet = (p) => get(p, { low: true }).catch(() => null);
  try {
    // 1) Top (avec les artistes de chaque son) + recherche du nom (trouve aussi les sons où il est invité).
    const [, search] = await Promise.all([lowGet(`/artist/${a.id}/top?limit=100`), lowGet(`/search?q=${encodeURIComponent(a.name)}&limit=50`)]);
    // 2) Apparitions chez d'autres : détail des premiers résultats dont il n'est pas l'artiste principal.
    const others = ((search && search.data) || []).filter((t) => !matches(t.artist, a)).slice(0, 12);
    await Promise.all(others.map((t) => lowGet(`/track/${t.id}`)));
    if (knownPartners(a).length >= 8) return;
    // 3) Petit artiste ou peu de partenaires connus : artistes de tous les sons de ses sorties.
    const own = await albumTracks(a, DEEP_RELEASES, true);
    const list = featFirst(uniqueByTitle(own)).slice(0, 40);
    await Promise.all(list.map((t) => lowGet(`/track/${t.id}`)));
  } catch (_) { /* tâche de fond : jamais bloquant */ }
}

module.exports = { featStats, verifyFeat, quickPartners, learnCommunity, community, previewOk, getTrack, searchArtistTracks, artistTop, trackOut, artistOut, freshTrack, exportMemory, importMemory, memoryStats, withIds, prepare, knownFeat, knownPartners, searchArtists, getArtist, findFeat, findCollaborators, findCollaboratorsDeep, trackArtists, featCredits, proves, norm, setFetcher };
