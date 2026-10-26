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

const app = express();
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
const sendIndex = (_, res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.type('html').send(INDEX); };
app.get('/', sendIndex);
app.get('/api/version', (_, res) => { res.set('Cache-Control', 'no-store'); res.json({ version: VERSION, memoire: persist.info(deezer) }); });
// Service worker : garde le jeu sur le téléphone pour l'ouvrir même quand le serveur dort.
const SW = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8').replace(/__VERSION__/g, VERSION);
app.get('/sw.js', (_, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/javascript').send(SW); });
app.get('/app.js', send('app.js'));
app.get('/styles.css', send('styles.css'));
// Rex, la mascotte (3 humeurs).
for (const f of ['rex.webp', 'rex-win.webp', 'rex-sad.webp']) app.get('/' + f, (_, res) => res.sendFile(path.join(__dirname, f), { maxAge: '7d' }));
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
    res.status(502).json({ error: 'Deezer indisponible' });
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
  socket.on('qz:answer', act((d) => room.quizAnswer && room.quizAnswer(token, d.v)));
  socket.on('bt:search', act((d) => room.searchTrack && room.searchTrack(token, d.q)));
  socket.on('leave', () => {
    if (!room || !token) return;
    // Solo : la partie contre le bot s'arrête. Sinon, quitter le salon libère la place (avant le lancement).
    if (room.solo || room.leave(token)) {
      for (const t of ['timer', 'botTimer', 'koTimer', 'revealTimer']) clearTimeout(room[t]);
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
  for (const [c, r] of rooms) if (r.lastActive < limit) { clearTimeout(r.timer); rooms.delete(c); }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Raptor Games ${VERSION} prêt sur http://localhost:${PORT}`));
