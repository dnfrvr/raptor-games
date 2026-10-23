// Faux Deezer hors-ligne pour tester le jeu sans réseau : DEEZER_MOCK=1 npm start
const artists = [
  [1, 'Ninho'], [2, 'Jul'], [3, 'SCH'], [4, 'Booba'], [5, 'Damso'], [6, 'Gims'], [7, 'Niska'],
  [8, 'Aya Nakamura'], [9, 'Naps'], [10, 'Drake'], [11, 'Rihanna'], [12, 'Kanye West'], [13, 'Tiakola'], [14, 'Mister You'], [15, 'DJ Abdel'], [16, 'Francisco'], [17, 'Huntrill'], [18, 'TH'], [19, 'Kalash'], [20, 'Vadek'], [21, 'Edge'], [22, 'Demas'], [23, 'Kekra'],
].map(([id, name]) => ({ id, name, picture_medium: null, nb_fan: 1000000 - id }));
const A = (n) => artists.find((a) => a.name === n);
const tracks = [
  [101, 'Mood', 'Ninho', ['Niska']],
  [102, 'Bené', 'Jul', ['SCH']],
  [103, 'Tout va bien', 'Naps', ['Ninho', 'Jul']],
  [104, 'Bad Boy', 'Niska', ['Booba']],
  [105, 'Work', 'Rihanna', ['Drake']],
  [106, 'Pookie', 'Aya Nakamura', ['Niska']],
  [107, 'Ma meilleure ennemie', 'Gims', ['Damso']],
  [108, 'Mamacita', 'Tiakola', ['Gims']],
  [109, 'Sans moi', 'SCH', ['Ninho']],
  [110, 'Ma vie (feat. Francisco)', 'Mister You', ['DJ Abdel', 'Francisco']],
  // Piège : « th » au milieu d'un mot, ce n'est pas un feat avec TH.
  [111, 'Thugfeelings', 'Huntrill', []],
  // Feat écrit seulement dans le titre (TH n'est pas crédité par Deezer).
  [112, 'Tchikita (feat. TH)', 'Jul', []],
  // Francisco écrit seulement dans le titre (pas crédité) : doit être flouté pendant la manche.
  [113, 'Club (feat. Francisco)', 'Naps', ['Gims']],
  // Feat rare : absent des tops des deux artistes, trouvé seulement par la recherche.
  [114, 'Face B (feat. Damso)', 'Niska', [], true],
  // Impasse : Huntrill n'a qu'un seul feat (avec Jul). Jul → Huntrill = plus rien à répondre : K.O.
  [115, 'Impasse', 'Jul', ['Huntrill']],
  // Feat caché hors des tops : Kalash n'a dans son top qu'un son avec Jul, mais il est invité chez Damso.
  // Jul → Kalash ne doit PAS faire K.O. (la fouille profonde trouve Damso), et Kalash × Damso doit être validé.
  [116, 'Seul', 'Jul', ['Kalash']],
  [117, 'Cachée (feat. Kalash)', 'Damso', [], true],
  // Cas réel signalé : son d'Edge avec Vadek et Demas crédités par Deezer (rien dans le titre),
  // absent du top de Vadek. Edge → Vadek ne doit PAS faire K.O. : on peut encore répondre Demas.
  [118, 'Trio', 'Edge', ['Vadek', 'Demas'], true],
  // Variante : l'invité n'est écrit que dans le titre.
  [119, 'Duo (feat. Kekra)', 'Naps', ['Tiakola']],
].map(([id, title, main, feats, deep]) => ({
  id, title, title_short: title, preview: null, link: '#', deep: !!deep,
  album: { title, cover_medium: id === 110 ? 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2246%22 height=%2246%22%3E%3Crect width=%2246%22 height=%2246%22 fill=%22%23d90b2c%22/%3E%3Ctext x=%224%22 y=%2228%22 font-size=%2212%22 fill=%22white%22%3EFRANCISCO%3C/text%3E%3C/svg%3E' : null },
  artist: A(main),
  contributors: [{ ...A(main), role: 'Main' }, ...feats.map((f) => ({ ...A(f), role: 'Featured' }))],
}));

function route(path) {
  const u = new URL('http://x' + path);
  const q = (u.searchParams.get('q') || '').toLowerCase().replace(/(artist|track):/g, '').replace(/"/g, '');
  const words = q.split(/\s+/).filter(Boolean);
  let m;
  if (u.pathname === '/search/artist') return { data: artists.filter((a) => a.name.toLowerCase().includes(q.trim())) };
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/top$/))) return { data: tracks.filter((t) => !t.deep && t.contributors.some((c) => c.id === +m[1])) };
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/albums$/))) return { data: [{ id: 9000 + +m[1] }] };
  if ((m = u.pathname.match(/^\/album\/9(\d{3})\/tracks$/))) return { data: tracks.filter((t) => t.artist.id === +m[1]).map(({ contributors, ...t }) => t) };
  if ((m = u.pathname.match(/^\/artist\/(\d+)$/))) return artists.find((a) => a.id === +m[1]);
  if ((m = u.pathname.match(/^\/track\/(\d+)$/))) return tracks.find((t) => t.id === +m[1]);
  if (u.pathname === '/search') return { data: tracks.filter((t) => words.some((w) => (t.title + ' ' + t.artist.name).toLowerCase().includes(w))).map(({ contributors, ...t }) => t) };
  return { error: { message: 'not found' } };
}

exports.install = (deezer) => {
  deezer.setFetcher(async (url) => {
    await new Promise((r) => setTimeout(r, 120));
    const body = route(url.replace('https://api.deezer.com', ''));
    return { ok: true, json: async () => body };
  });
  console.log('[mock] Deezer simulé');
};
