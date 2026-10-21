const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const deezer = require('./deezer');
const { Room } = require('./game');

if (process.env.DEEZER_MOCK) require('./mock-deezer').install(deezer);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const rooms = new Map();

// Tous les fichiers sont à la racine : on ne sert que ceux du navigateur (jamais le code serveur).
// Pas de cache navigateur : après une mise à jour, tout le monde reçoit la nouvelle version tout de suite.
const send = (f) => (_, res) => res.sendFile(path.join(__dirname, f), { maxAge: 0 });
app.get('/', send('index.html'));
app.get('/app.js', send('app.js'));
app.get('/styles.css', send('styles.css'));

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
  res.json({ exists: true, host: r.players[0] ? r.players[0].name : null, full: r.players.length >= 2, phase: r.phase });
});

app.get('/health', (_, res) => res.send('ok'));
app.get('/r/:code', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
  let room = null;
  let token = null;

  const fail = (msg) => socket.emit('oops', msg);

  socket.on('create', ({ token: t, name }) => {
    if (!t) return;
    token = String(t);
    room = new Room(io, token, String(name || 'Joueur 1'));
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
    if (!p) return fail('Le salon est déjà complet.');
    room = r;
    p.sockets.add(socket.id);
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

  socket.on('disconnect', () => {
    if (!room) return;
    for (const p of room.players) p.sockets.delete(socket.id);
    room.broadcast();
  });
});

// Ménage : salons inactifs depuis 3 h.
setInterval(() => {
  const limit = Date.now() - 3 * 3600 * 1000;
  for (const [c, r] of rooms) if (r.lastActive < limit) { clearTimeout(r.timer); rooms.delete(c); }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Roland Gamos prêt sur http://localhost:${PORT}`));
