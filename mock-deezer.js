// Faux Deezer hors-ligne pour tester le jeu sans réseau : DEEZER_MOCK=1 npm start
const artists = [
  [1, 'Ninho'], [2, 'Jul'], [3, 'SCH'], [4, 'Booba'], [5, 'Damso'], [6, 'Gims'], [7, 'Niska'],
  [8, 'Aya Nakamura'], [9, 'Naps'], [10, 'Drake'], [11, 'Rihanna'], [12, 'Kanye West'], [13, 'Tiakola'], [14, 'Mister You'], [15, 'DJ Abdel'], [16, 'Francisco'],
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
].map(([id, title, main, feats]) => ({
  id, title, title_short: title, preview: null, link: '#',
  album: { title, cover_medium: null },
  artist: A(main),
  contributors: [{ ...A(main), role: 'Main' }, ...feats.map((f) => ({ ...A(f), role: 'Featured' }))],
}));

function route(path) {
  const u = new URL('http://x' + path);
  const q = (u.searchParams.get('q') || '').toLowerCase().replace(/(artist|track):/g, '').replace(/"/g, '');
  const words = q.split(/\s+/).filter(Boolean);
  let m;
  if (u.pathname === '/search/artist') return { data: artists.filter((a) => a.name.toLowerCase().includes(q.trim())) };
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/top$/))) return { data: tracks.filter((t) => t.contributors.some((c) => c.id === +m[1])) };
  if ((m = u.pathname.match(/^\/artist\/(\d+)\/albums$/))) return { data: [] };
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
