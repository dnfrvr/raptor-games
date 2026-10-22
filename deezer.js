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

// Un titre prouve le feat si A et B y figurent tous les deux (contributeurs ou mention "feat." dans le titre).
function proves(track, a, b) {
  const people = track.contributors && track.contributors.length ? track.contributors : track.artist ? [track.artist] : [];
  const title = ' ' + norm(track.title) + ' ';
  const has = (x) => people.some((p) => matches(p, x)) || (norm(x.name).length > 2 && title.includes(' ' + norm(x.name) + ' '));
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
async function findFeat(a, b, songHint) {
  // 1) Tops des deux artistes : Deezer y inclut les contributeurs, donc 0 appel supplémentaire par titre.
  const tops = await Promise.allSettled([
    get(`/artist/${a.id}/top?limit=100`),
    get(`/artist/${b.id}/top?limit=100`),
  ]);
  for (const r of tops) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value.data || []) if (proves(t, a, b)) return trackOut(t);
  }

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
      if (proves(t, a, b)) return trackOut(t);
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
    if (d.status === 'fulfilled' && proves(d.value, a, b)) return trackOut(d.value);
  }

  // 3) Dernier recours : les albums de l'artiste le plus "petit" (featurings hors top).
  try {
    const albums = await get(`/artist/${b.id}/albums?limit=25`);
    const ids = (albums.data || []).slice(0, 12).map((al) => al.id);
    const albs = await Promise.allSettled(ids.map((id) => get(`/album/${id}/tracks?limit=60`)));
    const hits = [];
    for (const al of albs) {
      if (al.status !== 'fulfilled') continue;
      for (const t of al.value.data || []) {
        const title = norm(t.title);
        if (title.includes(norm(a.name))) return trackOut(await getTrack(t.id).catch(() => t));
        if (/feat|ft|avec|with/.test(title)) hits.push(t.id);
      }
    }
    const det = await Promise.allSettled(hits.slice(0, 15).map((id) => getTrack(id)));
    for (const d of det) if (d.status === 'fulfilled' && proves(d.value, a, b)) return trackOut(d.value);
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

module.exports = { searchArtists, getArtist, findFeat, findCollaborators, norm, setFetcher };
