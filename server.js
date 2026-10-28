const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const deezer = require('./deezer');
const { Room } = require('./game');
const { BlindRoom } = require('./blindtest');
const { BridgeRoom } = require('./bridge');
const { QuizRoom } = require('./quiz');
const MODES = ['feat', 'blind', 'bridge', 'fans', 'timeline'];

if (process.env.DEEZER_MOCK) require('./mock-deezer').install(deezer);
// Mémoire des feats sauvegardée sur Upstash (si configuré sur Render) : rechargée au démarrage.
const persist = require('./persist');
if (!process.env.DEEZER_MOCK) persist.start(deezer);
// Feats ajoutés par les joueurs (base commune, sauvegardée à part sur Upstash).
const community = deezer.community;
community.start(deezer.norm, deezer.learnCommunity);

const app = express();
// Ancienne adresse : si REDIRECT_TO est défini (ex. https://raptor-games.onrender.com), tout est renvoyé vers la nouvelle,
// en gardant le chemin (un lien d'invitation /r/CODE reste valable).
if (process.env.REDIRECT_TO) {
  const to = process.env.REDIRECT_TO.replace(/\/+$/, '');
  app.use((req, res, next) => (req.path === '/health' ? next() : res.redirect(301, to + req.originalUrl)));
}
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const rooms = new Map();

// Tous les fichiers sont à la racine : on ne sert que ceux du navigateur (jamais le code serveur).
// Pas de cache navigateur : après une mise à jour, tout le monde reçoit la nouvelle version tout de suite.
const send = (f) => (_, res) => res.sendFile(path.join(__dirname, f), { maxAge: 0 });

// Version calculée automatiquement à partir des fichiers du jeu : elle change à chaque mise à jour,
// sans rien avoir à modifier à la main. Les navigateurs s'en servent pour se recharger tout seuls.
const CLIENT_FILES = ['index.html', 'app.js', 'styles.css', 'sw.js'];
const VERSION = crypto.createHash('sha1').update(CLIENT_FILES.map((f) => fs.readFileSync(path.join(__dirname, f))).join('\n')).digest('hex').slice(0, 7);
const UPDATED = new Date(Math.max(...CLIENT_FILES.map((f) => fs.statSync(path.join(__dirname, f)).mtimeMs)));
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  .replace(/\?v=[\w.]+/g, '?v=' + VERSION)
  .replace('<head>', `<head>\n  <meta name="app-version" content="${VERSION}" data-updated="${UPDATED.toISOString()}">`);
// Aperçu des liens (WhatsApp, iMessage, Discord…) : adresses complètes, et un lien d'invitation /r/CODE
// annonce qui invite et à quel jeu.
const MODE_LABEL = { feat: 'un Roland Gamos', blind: 'un blind test', bridge: 'une partie de Pont', fans: 'un Plus ou moins', timeline: 'une partie de Frise' };
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const sendIndex = (req, res) => {
  const base = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;
  let html = INDEX.replace('content="/og.jpg"', `content="${base}/og.jpg"`)
    .replace('<meta property="og:type"', `<meta property="og:url" content="${attr(base + req.originalUrl)}">\n  <meta property="og:type"`);
  const r = req.params.code && rooms.get(String(req.params.code).toUpperCase());
  if (r && r.players[0]) {
    const t = `${r.players[0].name} t’invite à ${MODE_LABEL[r.mode || 'feat'] || 'une partie'}`;
    html = html.replace('<meta property="og:title" content="Raptor Games">', `<meta property="og:title" content="${attr(t)}">`)
      .replace(/(<meta property="og:description" content=")[^"]*/, `$1Code ${r.code}. Touche le lien pour rejoindre la partie sur Raptor Games.`);
  }
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(html);
};
app.get('/', sendIndex);
app.get('/api/version', (_, res) => { res.set('Cache-Control', 'no-store'); res.json({ version: VERSION, memoire: persist.info(deezer), featsJoueurs: community.info(), genius: require('./genius').info() }); });

// ---------- Admin : feats ajoutés par les joueurs (valider, corriger, supprimer) ----------
// Protégé par le code ADMIN_CODE (variable d'environnement sur Render). Sans ce code : admin désactivée.
const ADMIN_CODE = process.env.ADMIN_CODE || '';
const adminOk = (req) => {
  const given = Buffer.from(String(req.get('x-admin-code') || ''));
  const want = Buffer.from(ADMIN_CODE);
  return ADMIN_CODE.length >= 6 && given.length === want.length && crypto.timingSafeEqual(given, want);
};
const admin = (fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_CODE) return res.status(503).json({ error: 'Admin désactivée : ajoute la variable ADMIN_CODE (6 caractères ou plus) sur Render.' });
  if (!adminOk(req)) { await new Promise((r) => setTimeout(r, 800)); return res.status(401).json({ error: 'Code incorrect.' }); }
  try { res.json(await fn(req)); } catch (e) { res.status(400).json({ error: e.message }); }
};
app.get('/admin', (_, res) => { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex'); res.sendFile(path.join(__dirname, 'admin.html')); });
app.use('/api/admin', express.json({ limit: '10kb' }));
// Testeur : le jeu reconnaît-il ce feat, et grâce à quelle source ?
app.get('/api/admin/check', admin(async (req) => {
  const res = await Promise.all([req.query.a, req.query.b].map(async (q) => {
    const name = String(q || '').trim().slice(0, 80);
    const list = name ? await deezer.searchArtists(name, 5) : [];
    return list.find((x) => deezer.norm(x.name) === deezer.norm(name)) || list[0] || null;
  }));
  if (!res[0] || !res[1]) throw new Error('Artiste introuvable sur Deezer.');
  const t0 = Date.now();
  const t = await deezer.verifyFeat(res[0], res[1], { song: String(req.query.title || '').slice(0, 100) });
  const SRC = { joueurs: 'ajouté par les joueurs', musicbrainz: 'MusicBrainz', genius: 'Genius' };
  const pair = `${res[0].name} × ${res[1].name}`;
  const rec = deezer.featStats().recent.find((x) => x.pair === pair);
  return { a: res[0].name, b: res[1].name, found: !!t, title: t ? t.title : null, source: t ? SRC[t.source] || 'Deezer' : null, stage: rec ? rec.stage : null, ms: Date.now() - t0, genius: require('./genius').info() };
}));
app.get('/api/admin/stats', admin(() => deezer.featStats()));
app.get('/api/admin/feats', admin(() => ({ feats: community.list(), info: community.info() })));
app.post('/api/admin/feats', admin((req) => {
  const e = community.add(String(req.body.a || '').trim(), String(req.body.b || '').trim(), String(req.body.title || ''));
  if (!e) throw new Error('Il faut deux artistes différents et le titre du son.');
  return { ok: true };
}));
app.patch('/api/admin/feats/:key', admin((req) => {
  if (!community.update(req.params.key, { title: req.body.title, status: req.body.status })) throw new Error('Feat introuvable.');
  return { ok: true };
}));
app.delete('/api/admin/feats/:key', admin((req) => {
  if (!community.remove(req.params.key)) throw new Error('Feat introuvable.');
  return { ok: true };
}));
// Service worker : garde le jeu sur le téléphone pour l'ouvrir même quand le serveur dort.
const SW = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8').replace(/__VERSION__/g, VERSION);
app.get('/sw.js', (_, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/javascript').send(SW); });
app.get('/app.js', send('app.js'));
app.get('/styles.css', send('styles.css'));
// Rex, la mascotte (3 humeurs), et le motif de fond.
for (const f of ['rex.webp', 'rex-win.webp', 'rex-sad.webp', 'jungle-bg.webp', 'og.jpg']) app.get('/' + f, (_, res) => res.sendFile(path.join(__dirname, f), { maxAge: '7d' }));
// Confettis de victoire (canvas-confetti 1.9.3, licence ISC), servis depuis le dépôt.
app.get('/confetti.js', (_, res) => res.sendFile(path.join(__dirname, 'confetti.js'), { maxAge: '30d' }));
// Icônes (onglet du navigateur, écran d'accueil iOS/Android) et fiche d'application installable.
for (const f of ['favicon-32.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) app.get('/' + f, (_, res) => res.sendFile(path.join(__dirname, f), { maxAge: '7d' }));
app.get('/favicon.ico', (_, res) => res.sendFile(path.join(__dirname, 'favicon-32.png'), { maxAge: '7d' }));
app.get('/manifest.webmanifest', (_, res) => res.type('application/manifest+json').sendFile(path.join(__dirname, 'manifest.webmanifest')));

// Autocomplétion des artistes (le navigateur ne peut pas appeler Deezer directement : pas de CORS).
app.get('/api/artists', async (req, res) => {
  try {
    res.json(await deezer.searchArtists(String(req.query.q || '').slice(0, 60), 8));
  } catch (e) {
    res.status(502).json({ error: 'Recherche indisponible' });
  }
});

// Infos publiques d'un salon, pour accueillir l'invité ("Dinos t'invite") ou signaler un lien mort.
app.get('/api/room/:code', (req, res) => {
  const r = rooms.get(String(req.params.code).toUpperCase());
  if (!r) return res.json({ exists: false });
  res.json({ exists: true, mode: r.mode || 'feat', host: r.players[0] ? r.players[0].name : null, full: r.solo || r.players.length >= 8, started: r.phase !== 'lobby', players: r.players.length, phase: r.phase });
});

app.get('/health', (_, res) => res.send('ok'));
app.get('/r/:code', sendIndex);

io.on('connection', (socket) => {
  socket.emit('version', VERSION);
  let room = null;
  let token = null;

  const fail = (msg) => socket.emit('oops', msg);

  socket.on('create', ({ token: t, name, solo, mode }) => {
    if (!t) return;
    token = String(t);
    const m = MODES.includes(mode) ? mode : 'feat';
    const nm = String(name || 'Joueur 1');
    room = m === 'blind' ? new BlindRoom(io, token, nm, !!solo)
      : m === 'bridge' ? new BridgeRoom(io, token, nm, !!solo)
      : m === 'fans' || m === 'timeline' ? new QuizRoom(io, token, nm, !!solo, m)
      : new Room(io, token, nm, !!solo);
    rooms.set(room.code, room);
    room.players[0].sockets.add(socket.id);
    room.broadcast();
  });

  socket.on('join', ({ token: t, name, code }) => {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return fail('Ce salon n’existe pas (ou a expiré).');
    if (!t) return;
    token = String(t);
    const p = r.addPlayer(token, name ? String(name) : null);
    if (!p) return fail(r.phase !== 'lobby' ? 'La partie a déjà commencé.' : 'Le salon est déjà complet.');
    room = r;
    p.sockets.add(socket.id);
    r.syncPresence();
    r.broadcast();
  });

  const act = (fn) => (data) => { if (room && token) Promise.resolve(fn(data || {})).catch((e) => console.error(e)); };
  socket.on('settings', act((d) => room.setSettings(token, d)));
  socket.on('start', act(() => room.start(token)));
  socket.on('next', act(() => room.next(token)));
  socket.on('stop', act(() => room.stop(token)));
  socket.on('answer', act((d) => room.answer(token, d)));
  socket.on('randomStart', act(() => room.randomStart(token)));
  socket.on('giveup', act(() => room.giveUp(token)));
  socket.on('appeal', act(() => room.appeal(token)));
  socket.on('judge', act((d) => room.judge(token, !!d.ok)));
  socket.on('grant', act(() => room.grant(token)));
  socket.on('joker', act(() => room.useJoker(token)));
  socket.on('react', act((d) => room.react(token, String(d.e || ''))));
  socket.on('koRelaunch', act(() => room.koRelaunch(token)));
  socket.on('koGiveUp', act(() => room.koGiveUp && room.koGiveUp(token)));
  // Blind test : choisir le son à faire deviner, ou revenir au choix de l'artiste.
  socket.on('bt:pick', act((d) => room.pick && room.pick(token, d.id)));
  socket.on('bt:back', act(() => room.back && room.back(token)));
  socket.on('retry', act(() => room.retry && room.retry(token)));
  socket.on('br:undo', act(() => room.undo && room.undo(token)));
  socket.on('bt:refresh', act(() => room.refreshExtract && room.refreshExtract()));
  socket.on('qz:answer', act((d) => room.quizAnswer && room.quizAnswer(token, d.v)));
  // Feat non crédité chez Deezer : l'ajouter avec le titre du son (solo, et Le pont).
  socket.on('addFeat', (d) => {
    if (!room || !token || !room.addFeat) return;
    const out = room.addFeat(token, String((d && d.song) || '').slice(0, 100));
    if (out && out.error) fail(out.error); else room.broadcast();
  });
  socket.on('bt:search', act((d) => room.searchTrack && room.searchTrack(token, d.q)));
  socket.on('leave', () => {
    if (!room || !token) return;
    // Solo : la partie contre le bot s'arrête. Sinon, quitter le salon libère la place (avant le lancement).
    if (room.solo || room.leave(token)) {
      room.dispose();
      rooms.delete(room.code);
    }
    room = null; token = null;
  });
  // Tests uniquement (faux Deezer) : donner des jokers à un joueur.
  if (process.env.DEEZER_MOCK) socket.on('debugJokers', act((d) => { const p = room.players[room.idx(token)]; if (p) { p.jokers = Number(d.n) || 0; room.broadcast(); } }));

  socket.on('disconnect', () => {
    if (!room) return;
    for (const p of room.players) p.sockets.delete(socket.id);
    room.syncPresence();
    room.broadcast();
  });
});

// Ménage : salons inactifs depuis 3 h.
setInterval(() => {
  const limit = Date.now() - 3 * 3600 * 1000;
  for (const [c, r] of rooms) if (r.lastActive < limit) { r.dispose(); rooms.delete(c); }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Raptor Games ${VERSION} prêt sur http://localhost:${PORT}`));
