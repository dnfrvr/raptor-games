// Vraie date de sortie d'un son, via MusicBrainz (base musicale ouverte, sans clé).
// Deezer donne la date de l'album présent dans son catalogue : une réédition, une compilation ou un album mis
// en ligne tardivement peut avoir une date bien plus récente que la sortie originale. MusicBrainz donne pour chaque
// enregistrement sa « première date de sortie » ; on garde la plus ancienne des deux.
//
// Règles de MusicBrainz : une requête par seconde au plus, et un User-Agent qui identifie l'application.
const UA = 'RaptorGames/1.0 ( https://github.com/dnfrvr/raptor-games )';
const API = 'https://musicbrainz.org/ws/2/recording/';

let last = 0;
let chain = Promise.resolve();
let waiting = 0; // requêtes en file (une par seconde) : au-delà de 4, on ne rajoute pas de vérification de feat
const cache = new Map(); // "titre|artiste" → { date, prec } | null

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');

function throttled(fn) {
  waiting++;
  const run = chain.finally(() => { waiting--; }).then(async () => {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

// { date: 'AAAA-MM-JJ' (complétée pour trier), prec: 'day' | 'month' | 'year' } ou null.
async function firstRelease(title, artist) {
  const t = norm(title), a = norm(artist);
  if (!t || !a) return null;
  const key = t + '|' + a;
  if (cache.has(key)) return cache.get(key);
  let best = null;
  try {
    const q = `recording:"${esc(title.replace(/\s*[([].*$/, '').trim())}" AND artist:"${esc(artist)}"`;
    const res = await throttled(() => fetch(`${API}?query=${encodeURIComponent(q)}&fmt=json&limit=15`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(7000),
    }));
    if (res.ok) {
      const data = await res.json();
      for (const rec of data.recordings || []) {
        if ((rec.score || 0) < 85 || norm(rec.title) !== t) continue;
        const credits = (rec['artist-credit'] || []).map((c) => norm(c.name || (c.artist && c.artist.name)));
        if (!credits.some((c) => c === a || c.includes(a) || a.includes(c))) continue;
        const d = rec['first-release-date'];
        if (!d || !/^\d{4}/.test(d)) continue;
        const prec = d.length >= 10 ? 'day' : d.length >= 7 ? 'month' : 'year';
        const full = prec === 'day' ? d.slice(0, 10) : prec === 'month' ? d.slice(0, 7) + '-15' : d.slice(0, 4) + '-07-01';
        if (!best || full < best.date) best = { date: full, prec };
      }
    }
  } catch (_) { /* MusicBrainz indisponible : on garde la date Deezer */ }
  cache.set(key, best);
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return best;
}

// Un son où a et b figurent ensemble, d'après les crédits MusicBrainz (« Caballero & JeanJass feat. Angèle »).
// Sert de seconde vérification quand Deezer ne trouve pas le feat (son hors des tops, invité non crédité chez Deezer).
// norm : la normalisation des noms du jeu. hint : titre donné par le joueur (facultatif).
// Renvoie { title, credit, date } ou null.
const pairCache = new Map();
async function findTogether(aName, bName, hint, normName) {
  const key = [normName(aName), normName(bName)].sort().join('|') + '|' + normName(hint || '');
  if (pairCache.has(key)) return pairCache.get(key);
  if (waiting >= 4) return null; // MusicBrainz déjà très sollicité : on ne fait pas attendre le joueur
  let found = null;
  try {
    let q = `artist:"${esc(aName)}" AND artist:"${esc(bName)}"`;
    if (hint) q += ` AND recording:"${esc(hint)}"`;
    const res = await throttled(() => fetch(`${API}?query=${encodeURIComponent(q)}&fmt=json&limit=25`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(7000),
    }));
    if (res.ok) {
      const data = await res.json();
      const words = (x) => ` ${normName(x)} `;
      const A = words(aName), B = words(bName);
      for (const rec of data.recordings || []) {
        const ac = rec['artist-credit'] || [];
        // Crédit complet (« Caballero & JeanJass feat. Angèle ») et chaque nom crédité.
        const full = words(ac.map((c) => (c.name || (c.artist && c.artist.name) || '') + (c.joinphrase || '')).join(''));
        const names = ac.map((c) => words(c.name || (c.artist && c.artist.name)));
        const has = (X) => full.includes(X) || names.some((n) => n === X);
        if (!has(A) || !has(B)) continue;
        found = { title: rec.title, credit: ac.map((c) => (c.name || '') + (c.joinphrase || '')).join('').trim(), date: rec['first-release-date'] || null };
        if (!hint || normName(rec.title) === normName(hint)) break;
      }
    }
  } catch (_) { return null; /* MusicBrainz indisponible : pas de réponse retenue */ }
  pairCache.set(key, found);
  if (pairCache.size > 3000) pairCache.delete(pairCache.keys().next().value);
  return found;
}

module.exports = { firstRelease, findTogether };
