// Accès à l'API publique Deezer (aucune clé requise) + vérification des featurings.
// Doc : https://developers.deezer.com/api

const API = 'https://api.deezer.com';
const TTL = 1000 * 60 * 60 * 6; // 6 h de cache : catalogue à jour sans marteler l'API
const cache = new Map();

// File d'attente simple : Deezer limite à ~50 requêtes / 5 s par IP.
let inFlight = 0;
const queue = [];
const MAX_CONCURRENT = 6;
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (inFlight < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    inFlight++;
    fn().then(resolve, reject).finally(() => { inFlight--; pump(); });
  }
}

let fetcher = (url) => fetch(url, { headers: { 'Accept-Language': 'fr' } });
function setFetcher(fn) { fetcher = fn; }

async function get(path) {
  const hit = cache.get(path);
  if (hit && hit.exp > Date.now()) return hit.data;
  const data = await schedule(async () => {
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
  });
  cache.set(path, { data, exp: Date.now() + TTL });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return data;
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

const RARE_RANK = 30; // un feat est « rare » si son son n'est dans les 30 plus écoutés d'aucun des deux artistes

/**
 * Cherche un son où a et b apparaissent ensemble.
 * Renvoie la piste (avec rare = feat peu connu, hinted = le titre donné par le joueur est le bon), ou null.
 * Si le joueur a donné un titre, on essaie de prouver le feat avec CE son-là.
 */
async function findFeat(a, b, songHint) {
  const hint = songHint && songHint.trim();
  // 1) Tops des deux artistes : Deezer y inclut les contributeurs, donc 0 appel supplémentaire par titre.
  const tops = await Promise.allSettled([
    get(`/artist/${a.id}/top?limit=100`),
    get(`/artist/${b.id}/top?limit=100`),
  ]);
  const rankIn = tops.map((r) => {
    const m = new Map();
    if (r.status === 'fulfilled') (r.value.data || []).forEach((t, i) => m.set(t.id, i));
    return m;
  });
  const isRare = (t) => rankIn.every((m) => !m.has(t.id) || m.get(t.id) >= RARE_RANK);
  const result = (t) => ({ ...trackOut(t), rare: isRare(t), hinted: !!hint && titleMatches(t, hint) });

  const provers = [];
  for (const r of tops) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value.data || []) if (proves(t, a, b) && !provers.some((x) => x.id === t.id)) provers.push(t);
  }
  if (provers.length) {
    const hinted = hint && provers.find((t) => titleMatches(t, hint));
    if (hinted || !hint) return result(hinted || provers[0]);
    // Titre donné mais pas parmi les gros sons : on cherche ce son précis avant de se rabattre sur le premier trouvé.
    const precise = await findFeatDeep(a, b, hint, (t) => titleMatches(t, hint));
    return result(precise || provers[0]);
  }
  const deep = await findFeatDeep(a, b, hint);
  return deep ? result(deep) : null;
}

// Étapes 2 et 3 : recherche plein texte puis albums. `want` (facultatif) impose une condition sur le son trouvé.
async function findFeatDeep(a, b, songHint, want = () => true) {
  const ok = (t) => proves(t, a, b) && want(t);
  // 2) Recherche plein texte, puis détail des titres candidats (contributeurs complets).
  const queries = [];
  if (songHint && songHint.trim()) {
    queries.push(`artist:"${a.name}" track:"${songHint.trim()}"`);
    queries.push(`artist:"${b.name}" track:"${songHint.trim()}"`);
    queries.push(`${songHint.trim()} ${a.name}`);
  }
  queries.push(`${a.name} ${b.name}`, `${b.name} ${a.name}`, `artist:"${a.name}" ${b.name}`, `artist:"${b.name}" ${a.name}`);

  const seen = new Set();
  const candidates = [];
  const results = await Promise.allSettled(queries.map((q) => get(`/search?q=${encodeURIComponent(q)}&limit=40`)));
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value.data || []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      // Preuve immédiate via "feat." dans le titre
      if (ok(t)) return t;
      const mainIsOne = matches(t.artist, a) || matches(t.artist, b);
      const title = norm(t.title);
      const mentionsOther = title.includes(norm(a.name)) || title.includes(norm(b.name));
      if (mainIsOne || mentionsOther) candidates.push({ t, score: (mainIsOne ? 1 : 0) + (mentionsOther ? 2 : 0) + (/feat|ft|with|avec|x /.test(title) ? 1 : 0) });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const toCheck = candidates.slice(0, 18).map((c) => c.t.id);
  const details = await Promise.allSettled(toCheck.map((id) => getTrack(id)));
  for (const d of details) {
    if (d.status === 'fulfilled' && ok(d.value)) return d.value;
  }

  // 3) Fouille profonde : albums, EP et singles récents des deux artistes, et leurs apparitions « feat. X » chez d'autres.
  //    On lit d'abord les titres (peu coûteux) ; on ne demande le détail que des sons qui ressemblent à des feats.
  try {
    const [ta, tb, ga, gb] = await Promise.all([albumTracks(a), albumTracks(b), guestTracks(a), guestTracks(b)]);
    const all = dedupe([...tb, ...ta, ...gb, ...ga]);
    // Feat écrit dans le titre : prouvé sans appel de plus.
    const direct = all.find((t) => ok(t));
    if (direct) return (await getTrack(direct.id).catch(() => null)) || direct;
    // Liste officielle des artistes des sons de leurs sorties. Deezer crédite souvent les invités comme artistes
    // à part entière sans rien écrire dans le titre (ex. « CAUCHEMAR » : Vadek, EDGE, Demas).
    // Le plus petit catalogue d'abord (c'est là que le son a le plus de chances d'être), arrêt dès que c'est prouvé.
    const ua = featFirst(uniqueByTitle(ta)), ub = featFirst(uniqueByTitle(tb));
    const lists = ua.length <= ub.length ? [ua, ub] : [ub, ua];
    for (const [k, list] of lists.entries()) {
      if (k === 1 && list.length > 80) break; // gros catalogue : déjà couvert par son top et la recherche
      const det = await detailInBatches(list, (got) => got.some(ok), 60);
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
async function albumTracks(a, max = DEEP_RELEASES) {
  try {
    const albums = await get(`/artist/${a.id}/albums?limit=100`);
    const recent = (albums.data || [])
      .slice()
      .sort((x, y) => String(y.release_date || '').localeCompare(String(x.release_date || '')))
      .slice(0, max);
    const lists = await Promise.allSettled(recent.map((al) => get(`/album/${al.id}/tracks?limit=100`)));
    return lists.flatMap((l) => (l.status === 'fulfilled' ? l.value.data || [] : []))
      .map((t) => ({ ...t, artist: t.artist || { id: a.id, name: a.name } }));
  } catch (_) { return []; }
}

// Apparitions de l'artiste chez les autres : sons dont le titre le crédite en feat.
async function guestTracks(a) {
  const qs = [`feat ${a.name}`, `ft ${a.name}`];
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
async function findCollaboratorsDeep(a, isUsed = () => false) {
  const top = (await findCollaborators(a, 100)).filter((o) => !isUsed(o.artist));
  if (top.length) return top;

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
  await Promise.all(list.slice(0, 5).map(async (o) => {
    if (o.artist.id) return;
    try {
      const hit = (await searchArtists(o.artist.name, 3)).find((x) => norm(x.name) === norm(o.artist.name));
      if (hit) o.artist = hit;
    } catch (_) { /* ignore */ }
  }));
  return list;
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

module.exports = { searchArtists, getArtist, findFeat, findCollaborators, findCollaboratorsDeep, trackArtists, featCredits, proves, norm, setFetcher };
