// Garde le jeu sur le téléphone : l'accueil s'ouvre tout de suite, même quand le serveur gratuit dort.
// __VERSION__ est remplacé par le serveur : chaque mise à jour du jeu crée un nouveau cache.
const CACHE = 'rg-__VERSION__';
const SHELL = ['/', '/app.js?v=__VERSION__', '/styles.css?v=__VERSION__', '/socket.io/socket.io.js', '/confetti.js', '/rex.webp', '/rex-win.webp', '/rex-sad.webp', '/jungle-bg.webp', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png'];
const NAV_TIMEOUT = 2500; // au-delà, on affiche la version gardée en attendant le réveil du serveur

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rg-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Polices Google : version gardée, rafraîchie en arrière-plan.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // Données en direct (parties, Deezer) : jamais depuis le cache.
  if (url.pathname.startsWith('/api/') || (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js') || url.pathname === '/sw.js') return;

  // Pages (accueil et liens d'invitation) : le réseau d'abord, la version gardée si le serveur tarde.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const net = fetch(req).then((r) => { if (r.ok) c.put('/', r.clone()); return r; });
      const timeout = new Promise((res) => setTimeout(res, NAV_TIMEOUT));
      const first = await Promise.race([net.catch(() => null), timeout]);
      if (first) return first;
      return (await c.match('/')) || net;
    })());
    return;
  }

  // Fichiers du jeu : la version gardée d'abord (ils changent de nom à chaque mise à jour).
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) caches.open(CACHE).then((c) => c.put(req, r.clone()));
    return r;
  })));
});
