// Crédits Genius : les invités d'un son tels que la communauté Genius les note (« Stromae (Ft. GIMS & OrelSan) »).
// Très complet pour le rap français, y compris quand Deezer ne crédite que l'artiste principal (ex. « AVF »).
// Nécessite un jeton gratuit (https://genius.com/api-clients → « Generate Access Token ») dans GENIUS_TOKEN.
// Sans jeton, cette source est simplement ignorée.
const TOKEN = process.env.GENIUS_TOKEN || '';
const API = 'https://api.genius.com/search';
const cache = new Map();

// { title, credit } d'un son où a et b sont crédités ensemble, ou null. normName : la normalisation des noms du jeu.
async function findTogether(aName, bName, hint, normName) {
  if (!TOKEN) return null;
  const key = [normName(aName), normName(bName)].sort().join('|') + '|' + normName(hint || '');
  if (cache.has(key)) return cache.get(key);
  const words = (x) => ` ${normName(x)} `;
  const A = words(aName), B = words(bName);
  const queries = hint ? [`${hint} ${aName}`, `${hint} ${bName}`] : [`${aName} ${bName}`];
  let found = null;
  try {
    const res = await Promise.allSettled(queries.map((q) => fetch(`${API}?q=${encodeURIComponent(q)}&per_page=20`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
    }).then((r) => (r.ok ? r.json() : null))));
    const hits = res.flatMap((r) => (r.status === 'fulfilled' && r.value && r.value.response ? r.value.response.hits || [] : []));
    for (const h of hits) {
      const s = h && h.result;
      if (!s || h.type !== 'song') continue;
      // Tous les artistes crédités : principal(aux), invités, et la ligne complète « X (Ft. Y & Z) ».
      const names = [s.artist_names, s.primary_artist && s.primary_artist.name,
        ...(s.primary_artists || []).map((x) => x.name), ...(s.featured_artists || []).map((x) => x.name)].filter(Boolean);
      const all = words(names.join(' & '));
      if (!all.includes(A) || !all.includes(B)) continue;
      found = { title: s.title, credit: s.artist_names || '' };
      if (!hint || normName(s.title) === normName(hint)) break;
    }
  } catch (_) { return null; /* Genius indisponible */ }
  cache.set(key, found);
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return found;
}

module.exports = { findTogether, enabled: () => !!TOKEN };
