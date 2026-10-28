// Base commune des feats ajoutés par les joueurs (sons que Deezer et MusicBrainz ne créditent pas :
// « AVF » de Stromae, Gims et Orelsan qui chantent sans être mentionnés, etc.).
//
// Un feat entre dans la base commune quand un humain l'a confirmé :
// - en multijoueur, l'adversaire valide le feat (avec le titre du son) : ajouté tout de suite ;
// - en solo, le joueur l'ajoute à sa partie : il reste « proposé » jusqu'à ce qu'un 2e joueur propose le même feat.
// Une page admin (/admin, protégée par ADMIN_CODE) permet de valider, corriger ou supprimer.
//
// Sauvegarde sur Upstash (clé à part de la mémoire automatique, jamais effacée ni réduite), quelques secondes
// après chaque changement.
const crypto = require('crypto');

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'rg:feats:v1';
const VOTES_NEEDED = 2;

const entries = new Map(); // clé de paire → { key, a, b, title, status, votes, src, at, updatedAt }
let norm = (s) => String(s || '').toLowerCase().trim();
let onChange = () => {};
const status = { enabled: !!(URL_ && TOKEN), loaded: false, lastSave: null, lastError: null };

const pairKey = (x, y) => [norm(x), norm(y)].sort().join('|');
const who = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12); // jamais le jeton lui-même
const person = (x) => ({ id: x.id || null, name: String(x.name).slice(0, 80) });

async function cmd(args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `Upstash HTTP ${res.status}`);
  return json.result;
}

let saveTimer = null;
function changed(e, removed = false) {
  onChange(e, removed);
  if (!status.enabled || !status.loaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 3000);
}
async function save() {
  try {
    await cmd(['SET', KEY, JSON.stringify([...entries.values()])]);
    status.lastSave = new Date().toISOString();
    status.lastError = null;
  } catch (e) {
    status.lastError = 'sauvegarde : ' + e.message;
    console.error('community save', e.message);
  }
}

// normName : la normalisation des noms du jeu ; learn(entry, removed) : prévenir la mémoire des feats.
async function start(normName, learn) {
  norm = normName;
  onChange = learn;
  if (!status.enabled) { status.loaded = true; return; }
  try {
    const raw = await cmd(['GET', KEY]);
    for (const e of raw ? JSON.parse(raw) : []) {
      if (!e || !e.a || !e.b || !e.title) continue;
      e.key = pairKey(e.a.name, e.b.name);
      entries.set(e.key, e);
      if (e.status === 'ok') onChange(e, false);
    }
    status.loaded = true;
    console.log(`Feats ajoutés par les joueurs : ${entries.size}`);
  } catch (e) {
    status.lastError = 'chargement : ' + e.message;
    console.error('community load', e.message);
  }
}

// Feat validé de la base commune (ou null).
function lookup(a, b) {
  const e = entries.get(pairKey(a.name, b.name));
  return e && e.status === 'ok' ? e : null;
}

// Validé par un humain (l'adversaire en multijoueur, ou l'admin) : commun tout de suite.
function confirm(a, b, title, src = 'adversaire') {
  const key = pairKey(a.name, b.name);
  const now = Date.now();
  const e = entries.get(key) || { key, a: person(a), b: person(b), votes: [], at: now };
  e.title = String(title).trim().slice(0, 100);
  e.status = 'ok';
  e.src = src;
  e.updatedAt = now;
  entries.set(key, e);
  changed(e);
  return e;
}

// Ajouté par un joueur seul : proposé, puis commun quand un 2e joueur (autre appareil) propose le même feat.
function propose(a, b, title, token) {
  const key = pairKey(a.name, b.name);
  const now = Date.now();
  let e = entries.get(key);
  if (e && e.status === 'ok') return e;
  if (!e) { e = { key, a: person(a), b: person(b), title: String(title).trim().slice(0, 100), status: 'pending', votes: [], src: 'joueurs', at: now }; entries.set(key, e); }
  const v = who(token);
  if (!e.votes.includes(v)) e.votes.push(v);
  if (e.votes.length >= VOTES_NEEDED) e.status = 'ok';
  e.updatedAt = now;
  changed(e);
  return e;
}

// ---------- Admin ----------
function list() {
  return [...entries.values()].sort((x, y) => (y.status === 'pending') - (x.status === 'pending') || (y.updatedAt || 0) - (x.updatedAt || 0))
    .map(({ key, a, b, title, status: st, votes, src, at, updatedAt }) => ({ key, a: a.name, b: b.name, title, status: st, votes: votes.length, src, at, updatedAt }));
}
function update(key, { title, status: st }) {
  const e = entries.get(key);
  if (!e) return null;
  if (typeof title === 'string' && title.trim().length >= 2) e.title = title.trim().slice(0, 100);
  if (st === 'ok' || st === 'pending') e.status = st;
  e.track = undefined; // titre changé : on recherchera la version Deezer à nouveau
  e.updatedAt = Date.now();
  changed(e, e.status !== 'ok');
  return e;
}
function remove(key) {
  const e = entries.get(key);
  if (!e) return false;
  entries.delete(key);
  changed(e, true);
  return true;
}
function add(aName, bName, title) {
  if (!aName || !bName || !title || title.trim().length < 2 || norm(aName) === norm(bName)) return null;
  return confirm({ name: aName }, { name: bName }, title, 'admin');
}

const info = () => ({ ...status, total: entries.size, ok: [...entries.values()].filter((e) => e.status === 'ok').length });

module.exports = { start, lookup, confirm, propose, list, update, remove, add, info, pairKey };
