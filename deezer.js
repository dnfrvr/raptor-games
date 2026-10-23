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

  // 3) Dernier recours : les albums de l'artiste le plus "petit" (featurings hors top).
  try {
    const albums = await get(`/artist/${b.id}/albums?limit=25`);
    const ids = (albums.data || []).slice(0, 12).map((al) => al.id);
    const albs = await Promise.allSettled(ids.map((id) => get(`/album/${id}/tracks?limit=60`)));
    // On ne garde que les sons qui créditent A dans la partie feat du titre, ou qui ont un feat (à vérifier en détail).
    const strong = [], weak = [];
    for (const al of albs) {
      if (al.status !== 'fulfilled') continue;
      for (const t of al.value.data || []) {
        const credits = featCredits(t.title).map(norm);
        if (credits.includes(norm(a.name))) strong.push(t.id);
        else if (credits.length) weak.push(t.id);
      }
    }
    const det = await Promise.allSettled([...strong, ...weak].slice(0, 18).map((id) => getTrack(id)));
    for (const d of det) if (d.status === 'fulfilled' && ok(d.value)) return d.value;
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
  const out = new Map();
  for (const t of top.data || []) {
    const people = t.contributors && t.contributors.length ? t.contributors : [];
    if (!people.some((p) => matches(p, a))) continue;
    for (const p of people) {
      if (matches(p, a) || !p.id || out.has(p.id)) continue;
      out.set(p.id, { artist: artistOut(p), track: trackOut(t) });
    }
  }
  return [...out.values()];
}

module.exports = { searchArtists, getArtist, findFeat, findCollaborators, featCredits, proves, norm, setFetcher };
