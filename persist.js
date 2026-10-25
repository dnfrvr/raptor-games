// Sauvegarde de la mémoire des feats sur Upstash Redis (offre gratuite), pour qu'elle survive aux redémarrages.
// Sur Render gratuit, le disque est effacé à chaque mise à jour, redémarrage ou mise en veille.
//
// Budget de l'offre gratuite (500 000 commandes / mois) : une lecture au démarrage, une écriture toutes les 10 min
// seulement s'il y a du nouveau, une à l'arrêt. Au pire ~4 500 commandes par mois.
// Sans les variables UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (ou si Upstash ne répond pas), le jeu marche
// exactement comme avant, avec une mémoire vide au démarrage.
const zlib = require('zlib');

const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'rg:memoire:v1';
const EVERY = 10 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024; // requêtes limitées à 10 Mo sur l'offre gratuite

const status = { enabled: !!(URL_ && TOKEN), loaded: false, pairsLoaded: 0, bytes: 0, lastSave: null, lastError: null };

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

async function load(deezer) {
  if (!status.enabled) return;
  try {
    const raw = await cmd(['GET', KEY]);
    if (raw) {
      const data = JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
      status.pairsLoaded = deezer.importMemory(data);
      status.bytes = raw.length;
    }
    status.loaded = true;
    console.log(`Mémoire des feats rechargée : ${status.pairsLoaded} paires`);
  } catch (e) {
    status.lastError = 'chargement : ' + e.message;
    console.error('persist load', e.message);
  }
}

let saving = null;
async function save(deezer, force = false) {
  if (!status.enabled || saving) return saving;
  // On n'écrase jamais la sauvegarde tant qu'elle n'a pas été relue (sinon un redémarrage raté l'effacerait).
  if (!status.loaded) return;
  if (!force && deezer.memoryStats().unsaved === 0) return;
  saving = (async () => {
    try {
      let limits = { maxPairs: 40000, maxNames: 8000, maxPartners: 60 };
      let b64;
      for (let i = 0; i < 4; i++) {
        b64 = zlib.gzipSync(JSON.stringify(deezer.exportMemory(limits)), { level: 9 }).toString('base64');
        if (b64.length <= MAX_BYTES) break;
        limits = { maxPairs: limits.maxPairs >> 1, maxNames: limits.maxNames >> 1, maxPartners: limits.maxPartners };
      }
      await cmd(['SET', KEY, b64]);
      status.bytes = b64.length;
      status.lastSave = new Date().toISOString();
      status.lastError = null;
    } catch (e) {
      status.lastError = 'sauvegarde : ' + e.message;
      console.error('persist save', e.message);
    } finally {
      saving = null;
    }
  })();
  return saving;
}

function start(deezer) {
  if (!status.enabled) return;
  load(deezer);
  setInterval(() => save(deezer), EVERY).unref();
  // Render prévient avant d'arrêter le service (mise à jour, mise en veille) : dernière sauvegarde puis sortie.
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.race([save(deezer), new Promise((r) => setTimeout(r, 8000))]);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const info = (deezer) => ({ ...status, memory: deezer.memoryStats() });

module.exports = { start, save, info };
