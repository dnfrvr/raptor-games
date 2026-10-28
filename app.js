(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const ico = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
  const PLAY = ico('i-play'), PAUSE = ico('i-pause');
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const goodAnswers = (n) => `${n} bonne${n > 1 ? 's' : ''} réponse${n > 1 ? 's' : ''}`;

  let token = store.get('rg_token');
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('rg_token', token); }

  const pathCode = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})/);
  let inviteCode = (new URLSearchParams(location.search).get('r') || (pathCode && pathCode[1]) || '').toUpperCase();
  let roomCode = store.get('rg_room') || '';
  let S = null;          // dernier état reçu du serveur
  let stateAt = 0;
  // Lecture auto des extraits : désactivée par défaut, le joueur peut l'activer (choix mémorisé).
  let muted = store.get('rg_autoplay') !== '1';
  let pickedArtist = null;
  let lastChainLen = -1;
  let lastRoundId = null;
  let lastErrKey = '';
  let lastTurnKey = '';
  let lastMask = null;
  let lastOutKey = '';
  let lastBonusId = null;
  let lastMissKey = '';

  const socket = io({ transports: ['websocket', 'polling'] });

  // ================= ACCUEIL =================
  const TICKER = ['Ninho', 'Jul', 'SCH', 'Gims', 'Damso', 'Drake', 'Rihanna', 'Niska', 'Booba', 'Aya Nakamura', 'Tiakola', 'Kanye West'];
  $('#ticker').innerHTML = [...TICKER, ...TICKER].map((w) => `<span>${esc(w)}</span><span class="ft">feat.</span>`).join('');

  $('#nameInput').value = store.get('rg_name', '');

  // Choix du jeu sur l'accueil : Roland Gamos (feats) ou Blind test. Mémorisé.
  const MODE_LIST = ['feat', 'blind', 'bridge', 'fans', 'timeline'];
  let mode = MODE_LIST.includes(store.get('rg_mode', 'feat')) ? store.get('rg_mode', 'feat') : 'feat';
  function setMode(m) {
    mode = m;
    store.set('rg_mode', m);
    document.querySelectorAll('#modes .chip').forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
    $('#pitch').textContent = {
      blind: 'Le blind test rap : fais deviner tes sons, trouve ceux des autres.',
      bridge: 'Relie deux rappeurs en un minimum de feats.',
      fans: 'Qui a le plus de fans sur Deezer ? Une erreur et tu sors.',
      timeline: 'Place chaque son au bon endroit sur la frise des sorties.',
    }[m] || 'Les jeux rap entre potes, vérifiés en direct.';
    const RULES = { feat: 'rulesFeat', blind: 'rulesBlind', bridge: 'rulesBridge', fans: 'rulesFans', timeline: 'rulesTimeline' };
    for (const [k, id] of Object.entries(RULES)) $('#' + id).hidden = k !== m;
  }
  document.querySelectorAll('#modes .chip').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  setMode(mode);

  const ownRoom = inviteCode && inviteCode === roomCode;
  if (inviteCode && !ownRoom) {
    $('#homeBtn').textContent = 'Rejoindre';
    $('#soloBtn').hidden = true;
    $('#joinCode').hidden = true;
    $('#invited').hidden = false;
    $('#invited').textContent = 'Tu as été invité à une partie.';
    fetch('/api/room/' + encodeURIComponent(inviteCode)).then((r) => r.json()).then((info) => {
      if (!info.exists) {
        $('#invited').textContent = 'Ce lien ne mène plus à aucune partie. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#soloBtn').hidden = false;
        $('#joinCode').hidden = false;
        $('#homeBtn').textContent = 'Créer une partie';
        history.replaceState(null, '', '/');
      } else if (info.started) {
        $('#invited').textContent = 'Cette partie a déjà commencé. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#soloBtn').hidden = false;
        $('#joinCode').hidden = false;
        $('#homeBtn').textContent = 'Créer une partie';
      } else if (info.full) {
        $('#invited').textContent = 'Cette partie est déjà complète. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#soloBtn').hidden = false;
        $('#joinCode').hidden = false;
        $('#homeBtn').textContent = 'Créer une partie';
      } else if (info.host) {
        $('#invited').innerHTML = `<b>${esc(info.host)}</b> t'invite à ${{ blind: 'un blind test', bridge: 'une partie de Pont', fans: 'un Plus ou moins', timeline: 'une partie de Frise' }[info.mode] || 'une partie'}.`;
      }
      if (info.exists && !info.started && !info.full) { $('#modes').hidden = true; if (info.mode) setMode(info.mode); }
    }).catch(() => {});
  }

  $('#homeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#nameInput').value.trim() || 'Joueur';
    store.set('rg_name', name);
    unlockAudio();
    $('#homeBtn').disabled = true;
    setTimeout(() => ($('#homeBtn').disabled = false), 4000);
    if (inviteCode) socket.emit('join', { token, name, code: inviteCode });
    else socket.emit('create', { token, name, mode });
  });

  // Rejoindre avec un code (celui affiché en haut du salon de l'hôte).
  const codeInput = $('#codeInput');
  codeInput.addEventListener('input', () => {
    const v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (v !== codeInput.value) codeInput.value = v;
    $('#codeMsg').hidden = true;
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); joinByCode(); } });
  $('#codeBtn').addEventListener('click', joinByCode);
  async function joinByCode() {
    const code = codeInput.value.trim().toUpperCase();
    const msg = (t) => { $('#codeMsg').textContent = t; $('#codeMsg').hidden = false; };
    if (code.length < 5) { msg('Le code fait 5 caractères.'); return codeInput.focus(); }
    $('#codeBtn').disabled = true;
    try {
      const info = await (await fetch('/api/room/' + encodeURIComponent(code))).json();
      if (!info.exists) return msg('Aucune partie avec ce code. Vérifie-le auprès de l’hôte.');
      if (info.started) return msg('Cette partie a déjà commencé.');
      if (info.full) return msg('Cette partie est complète.');
      const name = $('#nameInput').value.trim();
      if (!name) { msg('Choisis d’abord ton pseudo, juste au-dessus.'); return $('#nameInput').focus(); }
      store.set('rg_name', name);
      unlockAudio();
      inviteCode = code;
      socket.emit('join', { token, name, code });
    } catch { msg('Impossible de joindre le serveur. Réessaie dans un instant.'); }
    finally { setTimeout(() => ($('#codeBtn').disabled = !socket.connected), 300); }
  }

  // Mode solo : une partie contre le bot, sans invitation.
  $('#soloBtn').addEventListener('click', () => {
    const name = $('#nameInput').value.trim() || 'Joueur';
    store.set('rg_name', name);
    unlockAudio();
    $('#soloBtn').disabled = true;
    setTimeout(() => ($('#soloBtn').disabled = false), 4000);
    socket.emit('create', { token, name, solo: true, mode });
  });

  socket.on('connect', () => {
    // Reconnexion automatique (rechargement, réseau mobile qui saute…)
    const code = S?.code || (ownRoom ? roomCode : null);
    if (code) socket.emit('join', { token, code, name: null });
  });
  // Tant que le serveur ne répond pas (il dort après 15 min sans visite), on l'indique et on bloque les boutons.
  let wakeTimer = null, wakeStart = 0;
  function showWake() {
    if (wakeTimer) return;
    wakeStart = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - wakeStart) / 1000);
      $('#wake').hidden = false;
      $('#wakeText').textContent = S
        ? `Connexion perdue, reconnexion… ${s} s`
        : `Le serveur se réveille, ça peut prendre jusqu’à une minute… ${s} s`;
    };
    wakeTimer = setInterval(tick, 1000);
    setTimeout(() => { if (wakeTimer) tick(); }, 1200); // on n'affiche rien si la connexion arrive tout de suite
    $('#homeBtn').disabled = true; $('#soloBtn').disabled = true; $('#codeBtn').disabled = true;
  }
  function hideWake() {
    clearInterval(wakeTimer); wakeTimer = null;
    $('#wake').hidden = true;
    $('#homeBtn').disabled = false; $('#soloBtn').disabled = false; $('#codeBtn').disabled = false;
  }
  if (!socket.connected) showWake();
  socket.on('connect', hideWake);
  socket.on('disconnect', showWake);
  socket.on('connect_error', showWake);

  // Garde le jeu sur le téléphone : l'accueil s'ouvre tout de suite, même quand le serveur dort.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  socket.on('oops', (msg) => {
    toast(msg);
    $('#homeBtn').disabled = false;
    if (!S) store.set('rg_room', '');
  });

  // Quitter : dans le salon (avant le lancement), on libère vraiment sa place côté serveur.
  const leaveRoom = () => {
    if (S && (S.phase === 'lobby' || S.solo)) socket.emit('leave'); // en solo, la partie contre le bot est fermée
    store.set('rg_room', '');
    setTimeout(() => { location.href = '/'; }, 120);
  };
  document.querySelectorAll('[data-leave]').forEach((b) => b.addEventListener('click', leaveRoom));
  // Quitter en pleine partie (en haut de l'écran de jeu), avec confirmation en deux appuis.
  setTimeout(() => armTwoTap($('#quitBtn'), 'Quitter', 'Sûr ?', leaveRoom), 0);

  // ================= ÉTAT =================
  socket.on('state', (st) => {
    try { showNotice(st.notice); if (st.round && st.round.me) showNotice(st.round.me.notice); } catch {}
    S = st;
    stateAt = performance.now();
    roomCode = st.code;
    store.set('rg_room', st.code);
    if (!location.pathname.startsWith('/r/' + st.code)) history.replaceState(null, '', '/r/' + st.code);
    inviteCode = st.code;
    render();
  });

  socket.on('link', ({ track }) => { if (track && track.preview) playPreview(track.preview); });

  // Confettis : chargés seulement une fois en partie (inutiles sur l'accueil), avant la première victoire.
  let confettiP = null;
  function loadConfetti() {
    if (!confettiP) confettiP = new Promise((res) => {
      const sc = document.createElement('script');
      sc.src = '/confetti.js'; sc.async = true; sc.onload = sc.onerror = () => res();
      document.head.appendChild(sc);
    });
    return confettiP;
  }

  let shown = null;
  function show(id) {
    if (id === 'game') setTimeout(loadConfetti, 1500);
    for (const s of ['home', 'lobby', 'game']) $('#' + s).hidden = s !== id;
    // Nouvel écran : on repart du haut (sinon on garde la position de l'accueil et le haut du salon est caché).
    if (id !== shown) { shown = id; window.scrollTo(0, 0); }
  }

  function render() {
    if (!S) return show('home');
    if (S.phase === 'lobby') {
      show('lobby'); $('#endSheet').hidden = true; document.body.classList.remove('sheet-open');
      document.title = 'Raptor Games';
      return renderLobby();
    }
    show('game');
    // Code du salon toujours affiché (discret) en bas : un joueur déconnecté peut revenir avec.
    $('#gameCode').hidden = !!S.solo;
    // Réactions : seulement face à d'autres joueurs (en solo, personne pour les voir).
    document.querySelectorAll('.reacts').forEach((el) => (el.hidden = !!S.solo));
    $('#gameCodeVal').textContent = S.code;
    $('#gameCode').onclick = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(S.code).then(() => toast('Code copié'), () => toast(S.code));
      else toast(S.code);
    };
    if (S.mode === 'blind') renderBlind(); else if (S.mode === 'fans' || S.mode === 'timeline') renderQuiz(); else if (S.mode === 'bridge') renderBridge(); else renderGame();
  }

  // ================= SALON =================
  const TIMERS = [0, 10, 15, 20, 30, 45, 60];
  const LEVELS = [['easy', 'Facile'], ['normal', 'Normal'], ['hard', 'Difficile']];
  const levelName = (v) => (LEVELS.find((l) => l[0] === v) || LEVELS[1])[1];

  function renderLobby() {
    const isHost = S.me === S.host;
    const N = S.players.length, max = S.maxPlayers || 2;
    // Le pont, Plus ou moins, La frise : en solo on joue seul (pas de bot), jusqu'à l'erreur.
    const soloAlone = S.solo && !S.players.some((p) => p.bot);
    const ready = N >= 2 || soloAlone;
    const url = `${location.origin}/r/${S.code}`;
    $('#lobbyCode').textContent = S.solo ? 'solo' : S.code; // en solo, pas de code à partager
    $('#bigCode').textContent = S.code;
    $('#lobby .roomtag').hidden = !S.solo; // le gros code le remplace en multi
    $('#codeBox').onclick = () => {
      if (navigator.clipboard) navigator.clipboard.writeText(S.code).then(() => toast('Code copié'), () => toast(S.code));
      else toast(S.code);
    };

    // Une fois l'adversaire arrivé, l'invitation passe au second plan.
    $('#invite').classList.toggle('done', ready);
    $('#invite').hidden = !!S.solo;
    // L'invitation reste disponible tant qu'il reste des places (jusqu'à 8 joueurs).
    const full = N >= max;
    $('#lobbyTitle').textContent = ready ? (N === 2 ? 'Vous êtes deux' : `Vous êtes ${N}`) : isHost ? 'Invite tes potes' : 'En attente';
    $('#shareBtn').hidden = full || !isHost;
    $('#copyBtn').hidden = full || !isHost;
    $('#shareBtn').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: 'Raptor Games', text: { blind: 'Viens jouer au blind test contre moi', bridge: 'Viens jouer au Pont contre moi', fans: 'Viens jouer au Plus ou moins contre moi', timeline: 'Viens jouer à la Frise contre moi' }[S.mode] || 'Viens jouer au Roland Gamos contre moi', url }); return; } catch {} }
      copy(url);
    };
    $('#copyBtn').onclick = () => copy(url);

    const seatIdx = S.players.map((_, i) => i);
    if (!S.solo && N < max) seatIdx.push(N);
    $('#seats').innerHTML = seatIdx.map((i) => {
      const p = S.players[i];
      if (!p) return `<li class="seat empty"><span class="t">Joueur ${i + 1}</span><span class="n">${i === 1 ? 'Pas encore là' : 'Place libre'}</span></li>`;
      const tags = [i === S.me ? 'Toi' : p.bot ? `Niveau ${levelName(S.settings.botLevel).toLowerCase()}` : i === S.host ? 'Hôte' : 'Invité'];
      if (!p.online) tags.push('hors ligne');
      return `<li class="seat p${i}"><span class="t">${tags.join(', ')}</span><span class="n">${esc(p.name)}</span></li>`;
    }).join('');

    const t = S.settings.target;
    // L'hôte règle ; l'invité voit un résumé lisible plutôt que des boutons grisés.
    $('#settings').classList.toggle('readonly', !isHost);
    $('#settingsSummary').hidden = isHost;
    const blind = S.mode === 'blind';
    const unit = soloAlone ? 'vie' : 'manche';
    const pts = S.settings.points || 5;
    const race = S.mode === 'bridge';
    const secTxt = (v) => (race ? (v ? `${v / 60} min` : 'Sans limite') : v ? v + ' s' : 'Aucun');
    $('#timerLabel').textContent = race ? 'Temps pour chaque pont' : 'Chrono par tour';
    $('#settingsSummary').innerHTML = `${blind ? 'Blind test. ' : ''}${S.settings.turnSeconds ? `<b>${secTxt(S.settings.turnSeconds)}</b> ${race ? 'par pont' : 'par tour'}` : '<b>Sans chrono</b>'}, ${t ? `premier à <b>${plural(t, unit)}</b>` : '<b>manches sans limite</b>'}${blind ? ` de <b>${plural(pts, 'point')}</b>` : ''}${race ? ', ponts de 3 ou 4 feats entre artistes connus' : ''}.`;
    document.querySelectorAll('#settings .set').forEach((el) => (el.hidden = !isHost));
    $('#pointsSet').hidden = !isHost || !blind;
    if (isHost && blind) {
      $('#ptsOut').textContent = plural(pts, 'point');
      $('#ptsMinus').disabled = pts <= 2; $('#ptsPlus').disabled = pts >= 20;
      $('#ptsMinus').onclick = () => socket.emit('settings', { points: pts - 1 });
      $('#ptsPlus').onclick = () => socket.emit('settings', { points: pts + 1 });
    }
    $('#levelSet').hidden = !isHost || !S.solo || soloAlone;
    $('#targetSet').hidden = !isHost;
    $('#targetSet .field').textContent = soloAlone ? 'Vies' : 'Pour gagner';
    if (S.solo && isHost) {
      const el = $('#levelChips');
      el.innerHTML = LEVELS.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === S.settings.botLevel}" class="chip ${v === S.settings.botLevel ? 'on' : ''}" data-v="${v}">${l}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => (b.onclick = () => socket.emit('settings', { botLevel: b.dataset.v })));
    }

    if (isHost) {
      const el = $('#timerChips');
      el.innerHTML = (race ? [60, 120, 180, 300, 0] : TIMERS).map((v) => `<button type="button" role="radio" aria-checked="${v === S.settings.turnSeconds}" class="chip ${v === S.settings.turnSeconds ? 'on' : ''}" data-v="${v}">${secTxt(v)}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => (b.onclick = () => socket.emit('settings', { turnSeconds: Number(b.dataset.v) })));

      $('#stepper').classList.toggle('off', t === 0);
      const maxT = soloAlone ? 5 : 10;
      $('#targetOut').textContent = t ? plural(t, unit) : '—';
      $('#targetMinus').disabled = t <= 1;
      $('#targetPlus').disabled = t >= maxT;
      $('#targetMinus').onclick = () => socket.emit('settings', { target: Math.max(1, (t || 3) - (t ? 1 : 0)) });
      $('#targetPlus').onclick = () => socket.emit('settings', { target: Math.min(maxT, (t || 2) + 1) });
      $('#targetInf').hidden = blind || soloAlone || S.mode === 'fans' || S.mode === 'timeline';
      $('#targetInf').classList.toggle('on', t === 0);
      $('#targetInf').setAttribute('aria-pressed', String(t === 0));
      $('#targetInf').onclick = () => socket.emit('settings', { target: t === 0 ? 3 : 0 });
      $('#targetHint').textContent = soloAlone ? `Chaque erreur coûte une vie. ${S.mode === 'bridge' ? 'Relie un maximum de ponts' : 'Fais le plus de bonnes réponses'} avant de toutes les perdre.` : blind ? `Une manche se gagne en premier à ${plural(pts, 'point')} : artiste trouvé +1, titre en plus +1.` : t === 0 ? (S.solo ? 'On enchaîne les manches et tu arrêtes quand tu veux.' : 'On enchaîne les manches et on arrête quand on veut.') : t === 1 ? 'Mort subite : une seule manche.' : '';
    }

    $('#startBtn').hidden = !isHost;
    $('#startBtn').disabled = !ready;
    $('#startBtn').onclick = () => { unlockAudio(); socket.emit('start'); };
    $('#lobbyWait').textContent = !ready
      ? (isHost ? 'Tu pourras lancer dès qu’un autre joueur aura rejoint.' : '')
      : isHost ? '' : `${S.players[S.host].name} va lancer la partie.`;
  }

  function copy(text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Lien copié'), () => toast(text));
    else toast(text);
  }

  // ================= JEU =================
  function avatar(a, cls = '') {
    return a && a.picture ? `<img class="av ${cls}" src="${esc(a.picture)}" alt="">` : `<span class="av ${cls}" aria-hidden="true">${esc(((a && a.name) || '?')[0])}</span>`;
  }

  // À deux : le bandeau face à face. À trois et plus : une rangée de joueurs avec le chrono à gauche.
  let scorebugFor = 0;
  const CLOCK = `<div class="clock" id="clock" role="timer" aria-label="Temps restant"><span id="clockNum">∞</span><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" pathLength="100"/></svg></div>`;
  function buildScorebug(n) {
    if (n === scorebugFor) return;
    scorebugFor = n;
    const sb = $('#scorebug');
    sb.classList.toggle('multi', n !== 2);
    sb.innerHTML = n === 2
      ? [0, 1].map((i) => `<div class="side" data-p="${i}"><span class="pinfo"><span class="pname"></span><span class="pj"></span></span><span class="pscore"></span></div>`).join(CLOCK)
      : `${CLOCK}<ol class="roster">${Array.from({ length: n }, (_, i) => `<li class="pl p${i}" data-p="${i}"><span class="pinfo"><span class="pname"></span><span class="pj"></span></span><span class="pscore"></span></li>`).join('')}</ol>`;
  }

  function renderGame() {
    $('#playForm').classList.remove('br-form');
    $('#randomBtn').textContent = 'Au hasard'; $('#randomBtn').onclick = () => socket.emit('randomStart');
    $('#goal').hidden = S.mode !== 'bridge';
    $('#btPanel').hidden = true;
    $('#qzPanel').hidden = true;
    $('#chainWrap').hidden = false;
    $('#muteBtn').hidden = false;
    const bridge = S.mode === 'bridge';
    const r = S.round;
    const N = S.players.length;
    // À deux : on parle de l'adversaire par son nom ; à plusieurs : « les autres ».
    const opp = N === 2 ? (S.players[1 - S.me]?.name || 'Ton adversaire') : 'les autres';
    const oppTo = N === 2 ? `à ${opp}` : 'aux autres';
    buildScorebug(N);
    const outSet = new Set((r?.out || []).map((o) => o.who));
    document.querySelectorAll('#scorebug [data-p]').forEach((el) => {
      const i = Number(el.dataset.p);
      const p = S.players[i] || { name: '—', score: 0, online: false };
      el.querySelector('.pname').textContent = p.name;
      // Compteur de jokers de chaque joueur, toujours affiché (grisé à 0).
      const pj = el.querySelector('.pj');
      pj.textContent = `🃏 ${p.jokers || 0}`;
      pj.classList.toggle('zero', !p.jokers);
      pj.setAttribute('aria-label', `${p.jokers || 0} joker${p.jokers > 1 ? 's' : ''}`);
      el.querySelector('.pscore').textContent = p.score;
      el.classList.toggle('active', !!r && S.phase === 'playing' && r.turn === i);
      el.classList.toggle('off', !p.online);
      el.classList.toggle('me', i === S.me);
      el.classList.toggle('out', S.phase === 'playing' && outSet.has(i));
    });
    if (S.mode === 'bridge' && S.solo) { $('#roundLabel').innerHTML = `Le pont ${hearts()}`; lifeNotice(); }
    else $('#roundLabel').textContent = S.settings.target ? `Manche ${S.roundNo}, premier à ${S.settings.target}` : `Manche ${S.roundNo}, sans limite`;
    syncMute();

    if (!r) return;

    if (r.id !== lastRoundId) {
      lastRoundId = r.id; lastChainLen = -1; pickedArtist = null; lastErrKey = '';
      $('#artistInput').value = ''; $('#songInput').value = '';
    }

    const playing = S.phase === 'playing';
    const choosing = r.chain.length === 0;
    const last = r.chain[r.chain.length - 1];
    const cur = last ? last.artist : null;
    const newLink = r.chain.length !== lastChainLen;
    // Anti-triche : pendant la manche, on masque les autres artistes présents sur les sons (révélés à la fin).
    const mask = S.phase === 'playing';
    const redraw = newLink || mask !== lastMask;
    lastMask = mask;
    const known = new Set(r.chain.map((l) => nrm(l.artist.name)));
    // À cacher : les artistes crédités sur le son ET les noms écrits dans la partie feat du titre, sauf ceux déjà dans la chaîne.
    const others = (t) => {
      if (!mask || !t) return [];
      const names = [...(t.artists || []), ...featCredits(t.title)].filter((n) => !known.has(nrm(n)));
      return [...new Set(names)];
    };
    const myTurn = playing && r.turn === S.me;
    const turnName = S.players[r.turn]?.name || '';
    const busy = !!r.checking || !!r.appeal;

    // --- Scène : l'artiste en jeu, et la preuve du dernier feat ---
    if (newLink) {
      $('#current').innerHTML = choosing
        ? `<span class="av q" aria-hidden="true">?</span><span class="nm q">Artiste de départ</span>`
        : `${avatar(cur)}<span class="nm">${esc(cur.name)}</span>`;
      $('#current').classList.remove('pop'); void $('#current').offsetWidth; $('#current').classList.add('pop');
      // Nouvelle saisie seulement quand la chaîne avance : en cas d'erreur, le joueur garde ce qu'il a tapé.
      $('#artistInput').value = ''; $('#songInput').value = ''; pickedArtist = null;
    }
    // Le pont : l'arrivée à atteindre, toujours visible sous l'artiste en jeu.
    const goal = $('#goal');
    goal.hidden = !(bridge && r.target);
    if (bridge && r.target && goal.dataset.id !== String(r.target.id)) {
      goal.dataset.id = String(r.target.id);
      goal.innerHTML = `<span class="goal-k">Arrivée</span>${avatar(r.target, 'sm')}<b>${esc(r.target.name)}</b>`;
    }
    if (redraw) {
      const proof = $('#proof');
      // Le son qui prouve le feat est déjà affiché dans la chaîne : pas de doublon sous l'artiste.
      if (last && last.track) {
        proof.hidden = true;
      } else if (last) {
        proof.hidden = false;
        proof.textContent = last.bridge ? 'Départ du pont' : last.random ? `Tiré au hasard pour ${S.players[last.by]?.name || ''}` : `Choisi par ${S.players[last.by]?.name || ''} pour lancer la chaîne`;
      } else proof.hidden = true;
    }

    // --- À qui de jouer ---
    const banner = $('#turnBanner');
    banner.hidden = !playing;
    banner.className = 'turn ' + (myTurn ? 'me' : 'them');
    banner.innerHTML = r.solved ? `Pont réussi en ${plural(r.solved.links, 'feat')} ! <b>+1</b>`
      : r.failed ? `Raté.${r.solution && r.solution.via ? ` Le jeu passait par <b>${esc(r.solution.via.name)}</b>.` : ''} Pont suivant…`
      : bridge && choosing ? '<span class="spin"></span>Le jeu cherche deux rappeurs à relier…'
      : choosing
      ? (myTurn ? 'À toi de choisir l’artiste de départ.' : `${esc(turnName)} choisit l’artiste de départ.`)
      : myTurn ? `À toi. Qui a fait un son avec <b>${esc(cur.name)}</b> ?` : `${esc(turnName)} cherche un feat avec <b>${esc(cur.name)}</b>.`;

    const turnKey = `${r.id}-${r.chain.length}-${r.turn}`;
    if (turnKey !== lastTurnKey) {
      lastTurnKey = turnKey;
      if (myTurn) {
        if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
        // Sur mobile, amène le champ au-dessus du clavier.
        setTimeout(() => {
          $('#playForm').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          $('#artistInput').focus({ preventScroll: true });
        }, 80);
      }
    }
    document.title = !playing ? 'Raptor Games' : myTurn ? '● À toi | Raptor Games' : `${turnName} joue | Raptor Games`;

    // --- Formulaire du joueur actif ---
    const soloPause = !!(r.solved || r.failed);
    $('#playForm').hidden = !myTurn || (bridge && choosing) || soloPause;
    $('#songInput').hidden = choosing;
    $('#giveupBtn').hidden = choosing;
    $('#randomBtn').hidden = !choosing;
    // Joker : visible pendant ton tour si tu en as au moins un.
    $('#jokerBtn').hidden = choosing || !(S.jokers > 0);
    $('#jokerBtn').textContent = 'Joker';
    $('#jokerBtn').setAttribute('aria-label', `Joker : un rappeur à ta place (${S.jokers} restant${S.jokers > 1 ? 's' : ''})`);
    $('#artistInput').placeholder = choosing ? 'Un artiste pour lancer la chaîne' : `Un artiste qui a fait un son avec ${cur ? cur.name : ''}`;
    $('#submitBtn').textContent = choosing ? 'Lancer' : 'Valider';
    if (myTurn) {
      const out = !choosing && (r.tries || 0) >= (r.maxTries || 3); // plus d'essais
      $('#artistInput').disabled = busy || out; $('#songInput').disabled = busy || out;
      $('#submitBtn').disabled = busy || out; $('#giveupBtn').disabled = busy; $('#randomBtn').disabled = busy; $('#jokerBtn').disabled = busy;
      resetGiveUp();
      renderFeedback(r, cur, opp, oppTo);
    }

    // --- Vue de l'adversaire ---
    $('#watch').hidden = (myTurn && !(bridge && choosing)) || !playing;
    if (bridge && choosing && playing) $('#watch').innerHTML = r.lastError ? 'Impossible de tirer un pont pour l’instant. Réessaie la manche suivante.' : '<span class="dots">Préparation du pont</span>';
    else if (!myTurn && playing) {
      let txt = choosing ? '' : '<span class="dots">Recherche en cours</span>'; // le choix du départ est déjà annoncé au-dessus
      if (r.checking && r.checking.random) txt = `<span class="spin"></span>${esc(turnName)} tire un rappeur au hasard.`;
      else if (r.checking && r.checking.joker) txt = `<span class="spin"></span>${esc(turnName)} utilise un joker 🃏`;
      else if (r.checking && r.checking.verifying) txt = `<span class="spin"></span>On vérifie qu'il reste des feats avec ${esc(r.checking.artist.name)}…`;
      else if (r.checking) txt = `<span class="spin"></span>${esc(turnName)} propose <b>${esc(r.checking.artist.name)}</b>${r.checking.song ? `, « ${esc(r.checking.song)} »` : ''}. Vérification…`;
      else if (r.appeal) txt = `${esc(turnName)} te demande de valider un feat.`;
      const triesTxt = r.tries ? ` Essai ${r.tries} sur ${r.maxTries || 3} raté.` : '';
      if (!r.checking && !r.appeal && r.lastError) txt = r.lastError.why === 'used'
        ? `${esc(turnName)} a proposé <b>${esc(r.lastError.artist.name)}</b>, déjà cité.${triesTxt} <span class="dots">Il cherche encore</span>`
        : r.lastError.why === 'random' ? `<span class="dots">${esc(turnName)} choisit l’artiste de départ</span>`
        : r.lastError.why === 'joker' ? `${esc(turnName)} a tenté un joker, sans résultat. <span class="dots">Il cherche encore</span>`
        : `Aucun son trouvé avec <b>${esc(cur ? cur.name : '')}</b> et <b>${esc(r.lastError.artist.name)}</b>${r.lastError.song ? ` (« ${esc(r.lastError.song)} »)` : ''}.${triesTxt} Si ce feat existe, tu peux le valider.`;
      const grantable = !r.checking && !r.appeal && r.lastError && ['notfound', 'api', 'refused'].includes(r.lastError.why);
      const p = S.players[r.turn];
      // Adversaire parti et plus personne d'autre en ligne : on peut quitter au lieu d'attendre indéfiniment.
      const alone = !S.players.some((x, i) => i !== S.me && !x.bot && x.online);
      const leavable = p && !p.online && alone;
      if (p && !p.online) txt = `${esc(turnName)} s'est déconnecté. La partie reprend dès son retour.`
        + (S.solo ? '' : `<span class="rejoin">Pour revenir : code <b>${esc(S.code)}</b> sur l’accueil.</span>`);
      if (outSet.has(S.me)) txt = `<b>Tu es éliminé de cette manche.</b> ` + txt;
      if (!txt && !grantable) $('#watch').hidden = true;
      $('#watch').innerHTML = txt + (grantable ? `<button type="button" class="btn small-btn" id="grantBtn">Valider ce feat</button>` : '')
        + (leavable ? `<button type="button" class="btn ghost small-btn" id="quitGameBtn">Quitter la partie</button>` : '');
      if (grantable) armTwoTap($('#grantBtn'), 'Valider ce feat', 'Sûr ?', () => socket.emit('grant'));
      if (leavable) $('#quitGameBtn').onclick = leaveRoom;
    }

    // --- Arbitrage ---
    const judging = playing && r.appeal && r.turn !== S.me;
    const jo = $('#judgeOverlay');
    if (judging && jo.hidden) setTimeout(() => $('#judgeYes').focus(), 50);
    jo.hidden = !judging;
    if (judging) $('#judgeText').innerHTML = `${esc(cur.name)} <em>×</em> ${esc(r.appeal.artist.name)}${r.appeal.song ? `<span class="small">« ${esc(r.appeal.song)} » · validé, ce feat sera reconnu dans toutes les parties</span>` : ''}`;

    // --- Chaîne, la plus récente en haut ---
    if (redraw) {
      const n = Math.max(0, r.chain.length - 1);
      $('#chainTitle').textContent = r.chain.length ? `La chaîne, ${plural(n, 'feat')}` : 'La chaîne';
      $('#chain').innerHTML = r.chain.length ? r.chain.map((l, i) => {
        const who = esc(S.players[l.by]?.name || '');
        const badges = (l.rare ? ' <span class="tag rare" title="Feat rare">Rare</span>' : '') + (l.joker ? ' <span class="tag">Joker</span>' : '') + (l.relaunch ? ' <span class="tag">Relance</span>' : '');
        const detail = (i === 0 ? `<span class="by">${l.bridge ? 'départ' : `lancé par ${who}`}</span>` : `<span class="by">${who}</span>`) + badges;
        return `<li class="p${l.by}${i === 0 ? ' origin' : ''}"><div class="a">${esc(l.artist.name)} ${detail}</div>${l.track ? trackCard(l.track, l.byAppeal, others(l.track)) : ''}</li>`;
      }).reverse().join('') : '';
      $('#chainWrap').hidden = !r.chain.length; // pas de liste vide à l'écran
      bindTracks();
      lastChainLen = r.chain.length;
    }

    // Sons : feat validé, mauvaise réponse (chez tout le monde).
    if (newLink && r.chain.length > 1 && lastChainLen !== -1) sfx.ding();
    const missKey = r.lastError && ['used', 'notfound', 'refused'].includes(r.lastError.why) ? `${r.id}-${r.chain.length}-${r.tries}-${r.lastError.why}-${r.lastError.artist.name}` : '';
    if (missKey && missKey !== lastMissKey) sfx.buzz();
    lastMissKey = missKey;

    // Jokers gagnés (feat rare, bon titre).
    const b = r.lastBonus;
    if (b && b.id !== lastBonusId) {
      if (lastBonusId !== null) {
        const n = (b.rare ? 1 : 0) + (b.title ? 1 : 0);
        const why = [b.rare && 'feat rare ⭐', b.title && 'bon titre 🎯'].filter(Boolean).join(' + ');
        toast(`${b.who === S.me ? 'Tu gagnes' : S.players[b.who].name + ' gagne'} ${n} joker${n > 1 ? 's' : ''} 🃏 (${why})`, 3500);
        sfx.bonus();
      }
      lastBonusId = b.id;
    } else if (lastBonusId === null) lastBonusId = b ? b.id : 0;
    // Annonce des éliminations pendant la manche (à 3 et plus).
    const outKey = `${r.id}-${(r.out || []).length}`;
    if (outKey !== lastOutKey) {
      if (lastOutKey && r.out && r.out.length && S.phase === 'playing') {
        const o = r.lastOut, me = o.who === S.me, nm = S.players[o.who].name;
        sfx.out();
        toast(o.reason === 'timeout' ? `Temps écoulé pour ${me ? 'toi' : nm} : éliminé de la manche`
          : o.reason === 'tries' ? `${me ? 'Tu as' : nm + ' a'} raté 3 essais : éliminé de la manche`
          : o.reason === 'ko' ? `${me ? 'Tu es' : nm + ' est'} K.O. : éliminé de la manche`
          : `${me ? 'Tu as' : nm + ' a'} séché : éliminé de la manche`, 3500);
      }
      lastOutKey = outKey;
    }
    renderKO(r);
    renderEnd(r, cur);
    tickClock();
  }

  // ================= BLIND TEST =================
  // Même écran que le Roland Gamos : bandeau des scores, chrono, scène, formulaire, réactions, historique.
  let btStepKey = '', btLogLen = -1, btFbKey = '', btGiveKey = '', btResultKey = '';
  const nameOf = (i, cap) => (i === S.me ? (cap ? 'Tu' : 'toi') : S.players[i]?.name || '');

  // ================= PLUS OU MOINS / LA FRISE =================
  const fmtNum = (n) => Number(n || 0).toLocaleString('fr-FR');
  // Date précise au jour, au mois ou à l'année (selon ce que MusicBrainz / Deezer savent).
  const fmtDate = (d, prec = 'day') => {
    try {
      const opts = prec === 'year' ? { year: 'numeric' } : prec === 'month' ? { month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' };
      return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', opts);
    } catch { return d; }
  };
  // La réponse qu'on a ratée, rappelée sur l'écran de fin.
  const missedLine = (r) => {
    const n = r && r.next;
    if (!n) return '';
    if (S.mode === 'fans' && n.fans != null) return ` ${n.artist.name} avait ${fmtNum(n.fans)} fans.`;
    if (S.mode === 'timeline' && n.date) return ` « ${n.track.title} » (${n.track.artist || ''}) est sorti ${n.prec === 'year' ? 'en' : 'le'} ${fmtDate(n.date, n.prec)}.`;
    return '';
  };
  let qzKey = '', qzResId = null, qzOutKey = '';

  // Feat non crédité chez Deezer : l'ajouter avec le titre du son (pris dans « Titre du son »).
  const ADD_FEAT = '<button type="button" class="btn ghost small-btn" data-addfeat>Ajouter ce feat</button>';
  function armAddFeat(el, e) {
    const b = el.querySelector('[data-addfeat]');
    if (!b) return;
    b.onclick = () => {
      const typed = ($('#songInput').value || '').trim();
      const song = typed || e.song || '';
      if (song.length < 2) {
        toast('Écris le titre du son dans « Titre du son », puis touche Ajouter ce feat.', 3200);
        if (!$('#artistInput').value) $('#artistInput').value = e.artist.name;
        $('#songInput').focus();
        return;
      }
      b.disabled = true;
      socket.emit('addFeat', { song });
    };
  }
  let noticeId = null;
  function showNotice(n) {
    if (!n || n.id === noticeId) return;
    const first = noticeId === null;
    noticeId = n.id;
    if (!first || Date.now() - n.id < 4000) toast(n.text, 4200);
  }

  // Deezer muet : bouton pour relancer le tirage au lieu de rester bloqué.
  const RETRY = '<button type="button" class="btn ghost small-btn retry-btn" data-retry>Réessayer</button>';
  const armRetry = (el) => { const b = el.querySelector('[data-retry]'); if (b) b.onclick = () => { b.disabled = true; socket.emit('retry'); }; };

  function renderQuiz() {
    const r = S.round;
    const fans = S.mode === 'fans';
    const N = S.players.length;
    buildScorebug(N);
    const outSet = new Set((r?.out || []).map((o) => o.who));
    document.querySelectorAll('#scorebug [data-p]').forEach((el) => {
      const i = Number(el.dataset.p);
      const p = S.players[i] || { name: '—', score: 0, online: false };
      el.querySelector('.pname').textContent = p.name;
      el.querySelector('.pj').textContent = '';
      el.querySelector('.pscore').textContent = p.score;
      el.classList.toggle('active', !!r && S.phase === 'playing' && r.turn === i);
      el.classList.toggle('off', !p.online);
      el.classList.toggle('me', i === S.me);
      el.classList.toggle('out', S.phase === 'playing' && outSet.has(i));
    });
    $('#roundLabel').innerHTML = S.solo ? `${fans ? 'Plus ou moins' : 'La frise'} ${hearts()}` : `Manche ${S.roundNo}, premier à ${S.settings.target}`;
    lifeNotice();
    $('#muteBtn').hidden = true; $('#jokerBtn').hidden = true; $('#judgeOverlay').hidden = true; $('#ko').hidden = true;
    $('#btPanel').hidden = true; $('#playForm').hidden = true; $('#goal').hidden = true; $('#proof').hidden = true;
    $('#chainWrap').hidden = true;
    if (!r) return;

    const playing = S.phase === 'playing';
    const myTurn = playing && r.turn === S.me && !outSet.has(S.me);
    const turnName = S.players[r.turn]?.name || '';
    const res = r.result;
    const items = r.items || [];
    const next = r.next;
    const prev = items[items.length - 1];

    // --- Scène : ce qu'il faut juger ---
    const key = `${r.id}-${items.length}-${next ? (fans ? next.artist.id : next.track.id) : 'x'}-${res ? res.id : ''}`;
    if (key !== qzKey) {
      qzKey = key;
      let html = '<span class="av q" aria-hidden="true">?</span><span class="nm q">Chargement…</span>';
      if (next && fans) html = `${avatar(next.artist)}<span class="nm">${esc(next.artist.name)}</span>`;
      else if (next) html = `${next.track.cover ? `<img class="qz-cover" src="${esc(next.track.cover)}" alt="">` : '<span class="av q" aria-hidden="true">♪</span>'}<span class="nm qz-t">${esc(next.track.title)}</span><span class="qz-a">${esc(next.track.artist || '')}</span>`;
      $('#current').innerHTML = html;
      if (!res) { $('#current').classList.remove('pop'); void $('#current').offsetWidth; $('#current').classList.add('pop'); }
    }

    // --- Bandeau ---
    const banner = $('#turnBanner');
    banner.hidden = !playing;
    banner.className = 'turn ' + (myTurn ? 'me' : 'them');
    if (res) {
      const who = res.who === S.me ? 'Tu' : S.players[res.who]?.name;
      const truth = fans ? (next && next.fans != null ? `${esc(next.artist.name)} a <b>${fmtNum(next.fans)}</b> fans.` : '') : (next && next.date ? `Sorti ${next.prec === 'year' ? 'en' : 'le'} <b>${fmtDate(next.date, next.prec)}</b>.` : '');
      banner.innerHTML = res.ok ? `${res.who === S.me ? 'Bien vu' : esc(who) + ' a vu juste'} ! ${truth}` : `${res.value == null ? 'Temps écoulé' : 'Raté'}${res.who === S.me ? '' : ` pour ${esc(who)}`}. ${truth}`;
      banner.className = 'turn ' + (res.ok ? 'me' : 'them');
    } else if (r.error) banner.innerHTML = `Impossible de charger la question.${RETRY}`;
    else if (!next) banner.innerHTML = '<span class="spin"></span>Question suivante…';
    else if (fans) banner.innerHTML = myTurn ? `À toi : <b>${esc(next.artist.name)}</b> a-t-il plus ou moins de fans que <b>${esc(prev.artist.name)}</b> ?` : `${esc(turnName)} réfléchit : plus ou moins que ${esc(prev.artist.name)} ?`;
    else banner.innerHTML = myTurn ? 'À toi : <b>où placer ce son</b> sur la frise ?' : `${esc(turnName)} place ce son sur la frise.`;
    armRetry(banner);
    document.title = !playing ? 'Raptor Games' : myTurn ? '● À toi | Raptor Games' : `${turnName} joue | Raptor Games`;

    // --- Panneau ---
    const panel = $('#qzPanel');
    panel.hidden = !playing && S.phase !== 'roundEnd' && S.phase !== 'finished';
    const pkey = `${key}-${myTurn}-${S.phase}`;
    if (panel.dataset.key !== pkey) {
      panel.dataset.key = pkey;
      const can = myTurn && next && !res && !r.checking;
      if (fans) {
        const shown = prev ? `<div class="qz-ref">${avatar(prev.artist, 'sm')}<span><b>${esc(prev.artist.name)}</b><span>${fmtNum(prev.fans)} fans</span></span></div>` : '';
        const choice = res && res.value ? `<p class="small">Réponse : ${res.value === 'more' ? 'plus' : 'moins'} de fans.</p>` : '';
        panel.innerHTML = shown + choice + (can ? `<div class="play-row"><button type="button" class="btn" id="qzMore">Plus ▲</button><button type="button" class="btn ghost" id="qzLess">Moins ▼</button></div>` : '')
          + (S.solo ? '' : `<p class="small qz-streak">Série : ${goodAnswers(Math.max(0, items.length - 1))}</p>`); // en solo, le score l'affiche déjà
        if (can) { $('#qzMore').onclick = () => socket.emit('qz:answer', { v: 'more' }); $('#qzLess').onclick = () => socket.emit('qz:answer', { v: 'less' }); }
      } else {
        // La frise, du plus ancien au plus récent ; des emplacements « Ici » entre les sons pour le joueur actif.
        const slot = (k) => (can ? `<li class="qz-slot"><button type="button" class="qz-here" data-k="${k}">Ici</button></li>` : '');
        const mark = res && !res.ok && res.slot != null ? res.slot : null;
        let html = '';
        items.forEach((it, k) => {
          html += slot(k) + (mark === k ? '<li class="qz-wrong">Placé ici</li>' : '');
          html += `<li class="qz-item">${it.track.cover ? `<img src="${esc(it.track.cover)}" alt="">` : '<span class="nocover"></span>'}<span class="qz-y">${esc(fmtDate(it.date, it.prec))}</span><span class="qz-tt"><b>${esc(it.track.title)}</b><span>${esc(it.track.artist || '')}</span></span></li>`;
        });
        html += slot(items.length) + (mark === items.length ? '<li class="qz-wrong">Placé ici</li>' : '');
        panel.innerHTML = `<p class="small">Du plus ancien au plus récent.</p><ol class="qz-line">${html}</ol>`;
        if (can) panel.querySelectorAll('.qz-here').forEach((b) => (b.onclick = () => socket.emit('qz:answer', { v: Number(b.dataset.k) })));
      }
    }

    // --- Les autres ---
    $('#watch').hidden = true;
    const p = S.players[r.turn];
    if (playing && !myTurn && p && !p.online && !res) {
      const alone = !S.players.some((x, i) => i !== S.me && !x.bot && x.online);
      $('#watch').hidden = false;
      $('#watch').innerHTML = `${esc(p.name)} s'est déconnecté. La partie reprend dès son retour.` + (S.solo ? '' : `<span class="rejoin">Pour revenir : code <b>${esc(S.code)}</b> sur l’accueil.</span>`)
        + (alone ? `<button type="button" class="btn ghost small-btn" id="quitGameBtn">Quitter la partie</button>` : '');
      if (alone) $('#quitGameBtn').onclick = leaveRoom;
    }

    // Sons et annonces
    if (res && res.id !== qzResId) { qzResId = res.id; (res.ok ? sfx.ding : sfx.buzz)(); if (myTurn || res.who === S.me) { if (navigator.vibrate) try { navigator.vibrate(res.ok ? 40 : [30, 40, 30]); } catch {} } }
    const outKey = `${r.id}-${(r.out || []).length}`;
    if (outKey !== qzOutKey) {
      if (qzOutKey && r.out && r.out.length && playing) { const o = r.out[r.out.length - 1]; toast(`${o.who === S.me ? 'Tu es éliminé' : S.players[o.who].name + ' est éliminé'} de la manche`, 3000); sfx.out(); }
      qzOutKey = outKey;
    }
    renderQuizEnd(r);
    tickClock();
  }

  function renderQuizEnd(r) {
    if (S.phase === 'finished' && S.final && S.final.solo) return renderSoloEnd(r);
    const ended = S.phase === 'roundEnd' || S.phase === 'finished';
    const sheet = $('#endSheet');
    const wasHidden = sheet.hidden;
    sheet.hidden = !ended;
    document.body.classList.toggle('sheet-open', ended);
    if (!ended) return;
    const fin = S.phase === 'finished';
    const w = fin && S.final ? S.final.winner : r.winner;
    const N = S.players.length;
    const streak = Math.max(0, (r.items || []).length - 1);
    $('#endKicker').textContent = fin ? 'Fin de la partie' : `Fin de la manche ${S.roundNo}`;
    $('#endTitle').textContent = fin ? (w === S.me ? 'Tu gagnes la partie' : `${S.players[w].name} gagne`) : (r.winner === S.me ? 'Manche pour toi' : `Manche pour ${S.players[r.winner].name}`);
    sheet.classList.toggle('win', w === S.me);
    const lo = r.lastOut;
    $('#endText').textContent = `${lo ? `${lo.who === S.me ? 'Tu t’es trompé' : S.players[lo.who].name + ' s’est trompé'}` : 'Fin'} après une série de ${goodAnswers(streak)}.${missedLine(r)}`;
    $('#endExamples').hidden = true;
    $('#endScore').innerHTML = N === 2
      ? `<span class="s p0">${esc(S.players[0].name)}<b>${S.players[0].score}</b></span><span class="s p1"><b>${S.players[1].score}</b>${esc(S.players[1].name)}</span>`
      : `<ol class="board">${S.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score).map(({ p, i }) => `<li class="p${i}${i === S.me ? ' me' : ''}"><span class="dot"></span><span class="nm">${esc(p.name)}</span><b>${p.score}</b></li>`).join('')}</ol>`;
    renderRecap(fin && S.final ? S.final.recap : null);
    const btn = $('#endBtn');
    btn.hidden = false;
    if (fin) { btn.textContent = 'Revanche'; btn.onclick = () => socket.emit('start'); }
    else {
      const nextStarter = S.players[S.roundNo % N]?.name;
      btn.textContent = 'Manche suivante'; btn.onclick = () => socket.emit('next');
      $('#endText').textContent += ` ${nextStarter === S.players[S.me]?.name ? 'Tu commences' : nextStarter + ' commence'} la prochaine.`;
    }
    $('#stopBtn').hidden = true;
    if (wasHidden) { setTimeout(() => btn.focus({ preventScroll: true }), 60); if ((fin ? w : r.winner) === S.me) sfx.win(); else sfx.out(); }
  }

  // ================= LE PONT (course en parallèle) =================
  const solPath = (r) => (r.solution && r.solution.path ? r.solution.path.map((x) => x.name).join(' → ') : r.solution && r.solution.via ? `${r.start ? r.start.name : ''} → ${r.solution.via.name} → ${r.target ? r.target.name : ''}` : '');
  const fmtTime = (ms) => { const s = Math.round((ms || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  let brKey = '', brLen = -1, brErrKey = '', brGiveKey = '', brResKey = '';
  let brPrev = { id: null, done: false }, brWinTimer = null;
  function celebrateBridge(r, me, mine) {
    const el = $('#brWin');
    const names = mine.map((c) => c.artist.name);
    if (r.target && names[names.length - 1] !== r.target.name) names.push(r.target.name);
    const links = names.length - 1;
    el.style.setProperty('--n', names.length);
    $('#brWinPath').innerHTML = names.map((nm, k) => `<li style="--i:${k}"${k === names.length - 1 ? ' class="end"' : ''}><b>${esc(nm)}</b></li>`).join('');
    const best = r.shortest && links <= r.shortest ? ' Le chemin le plus court !' : '';
    $('#brWinSub').innerHTML = `<b>${plural(links, 'feat')}</b> en <b>${fmtTime(me.doneAt)}</b>.${best}`
      + (S.solo ? '<span class="plus">+1</span>' : S.players.length > 1 ? '<br>Les autres peuvent encore faire plus court…' : '');
    el.classList.remove('out');
    el.hidden = false;
    sfx.win();
    if (navigator.vibrate) try { navigator.vibrate([40, 60, 80]); } catch {}
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) loadConfetti().then(() => {
      if (!window.confetti) return;
      const colors = ['#ffd21f', '#43b85c', '#f3f7e6', '#2fae4f'];
      setTimeout(() => confetti({ particleCount: 110, spread: 85, origin: { y: 0.6 }, colors, zIndex: 60 }), 300);
    });
    const close = () => { clearTimeout(brWinTimer); el.classList.add('out'); setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 340); };
    el.onclick = close;
    clearTimeout(brWinTimer);
    brWinTimer = setTimeout(close, 3200);
  }
  function renderBridge() {
    const r = S.round;
    const N = S.players.length;
    buildScorebug(N);
    document.querySelectorAll('#scorebug [data-p]').forEach((el) => {
      const i = Number(el.dataset.p);
      const p = S.players[i] || { name: '—', score: 0, online: false };
      const l = r && r.lanes && r.lanes[i];
      el.querySelector('.pname').textContent = p.name;
      el.querySelector('.pj').textContent = l && S.phase === 'playing' ? (l.done ? `✓ ${plural(l.links, 'feat')}` : l.gaveUp ? 'abandon' : `${plural(Math.max(0, l.links), 'feat')}`) : '';
      el.querySelector('.pscore').textContent = p.score;
      el.classList.toggle('active', i === S.me && S.phase === 'playing');
      el.classList.toggle('off', !p.online);
      el.classList.toggle('me', i === S.me);
      el.classList.remove('out');
    });
    if (S.solo) { $('#roundLabel').innerHTML = `Le pont ${hearts()}`; lifeNotice(); }
    else $('#roundLabel').textContent = `Manche ${S.roundNo}, premier à ${S.settings.target}`;
    for (const id of ['#muteBtn', '#jokerBtn', '#judgeOverlay', '#ko', '#qzPanel', '#proof']) $(id).hidden = true;
    $('#chainWrap').hidden = false;
    if (!r) return;

    const playing = S.phase === 'playing' && !r.results;
    const me = r.me || {};
    const mine = r.chain || [];
    const cur = mine.length ? mine[mine.length - 1].artist : null;
    const n = Math.max(0, mine.length - 1);

    // --- Scène : mon artiste en cours, et l'arrivée ---
    const key = `${r.id}-${mine.length}-${r.loading}-${cur ? cur.id : ''}`;
    if (key !== brKey) {
      brKey = key;
      $('#current').innerHTML = r.loading || !cur
        ? `<span class="av q" aria-hidden="true">?</span><span class="nm q">${r.error ? 'Pas de pont' : 'Préparation du pont'}</span>`
        : `${avatar(cur)}<span class="nm">${esc(cur.name)}</span>`;
      $('#current').classList.remove('pop'); void $('#current').offsetWidth; $('#current').classList.add('pop');
      $('#artistInput').value = ''; $('#songInput').value = ''; pickedArtist = null;
    }
    const goal = $('#goal');
    goal.hidden = !r.target;
    if (r.target && goal.dataset.id !== String(r.target.id)) {
      goal.dataset.id = String(r.target.id);
      goal.innerHTML = `<span class="goal-k">Arrivée</span>${avatar(r.target, 'sm')}<b>${esc(r.target.name)}</b>`;
    }

    // --- Bandeau ---
    const banner = $('#turnBanner');
    banner.hidden = S.phase !== 'playing';
    const res = r.results;
    const mineRes = res && res.find((x) => x.i === S.me);
    banner.className = 'turn ' + (playing && !me.done && !me.gaveUp ? 'me' : 'them');
    banner.innerHTML = r.loading ? '<span class="spin"></span>Le jeu cherche deux rappeurs à relier…'
      : r.error ? `Impossible de tirer un pont pour l’instant.${RETRY}`
      : res ? (mineRes && mineRes.done ? `Pont réussi en ${plural(mineRes.links, 'feat')} (${fmtTime(mineRes.time)}) ! <b>+1</b>` : `Raté.${r.solution ? ` Chemin le plus court : <b>${esc(solPath(r))}</b>.` : ''} Pont suivant…`)
      : me.done ? `${me.auto && mine.length > 2 ? `<b>${esc(mine[mine.length - 2].artist.name)}</b> a un son avec <b>${esc(r.target.name)}</b> : ` : 'A'}${me.auto && mine.length > 2 ? 'a' : ''}rrivé en ${plural(n, 'feat')} (${fmtTime(me.doneAt)}) ! ${N > 1 ? 'Les autres peuvent encore faire plus court…' : ''}`
      : me.gaveUp ? 'Tu as abandonné ce pont. En attente des autres…'
      : `Relie <b>${esc(r.start ? r.start.name : '')}</b> à <b>${esc(r.target ? r.target.name : '')}</b> : qui a fait un son avec <b>${esc(cur ? cur.name : '')}</b> ?`
        + (me.left != null ? `<span class="bt-fast">${mine.length <= 1 ? (r.level === 'hard' ? 'Pont difficile. ' : '') + (r.shortest ? `Chemin le plus court : ${plural(r.shortest, 'feat')}` : `Le jeu connaît un chemin en ${plural(r.pathLen, 'feat')}. Fais aussi court, ou mieux !`) : me.left === 1 ? 'Plus qu’un feat avant l’arrivée !' : `Il te reste au moins ${plural(me.left, 'feat')}`}</span>` : (playing && mine.length > 1 && !me.done && !me.gaveUp ? '<span class="bt-fast">Calcul des feats restants…</span>' : ''));
    armRetry(banner);
    document.title = playing && !me.done && !me.gaveUp ? '● Le pont | Raptor Games' : 'Raptor Games';

    // --- Formulaire ---
    const canPlay = playing && !r.loading && !r.error && cur && !me.done && !me.gaveUp;
    $('#playForm').hidden = !canPlay;
    $('#playForm').classList.add('br-form');
    $('#playForm').classList.toggle('solo-action', mine.length < 2);
    if (canPlay) {
      const busy = !!me.checking || !!me.arriving;
      $('#songInput').hidden = false;
      $('#songInput').placeholder = 'Titre du son (facultatif)';
      $('#artistInput').placeholder = `Un artiste qui a fait un son avec ${cur.name}`;
      $('#submitBtn').textContent = 'Valider';
      $('#randomBtn').hidden = mine.length < 2;
      $('#randomBtn').textContent = 'Retour';
      $('#randomBtn').onclick = () => socket.emit('br:undo');
      $('#giveupBtn').hidden = false;
      const gk = `${r.id}`;
      if (brGiveKey !== gk) { brGiveKey = gk; armTwoTap($('#giveupBtn'), 'Abandonner', 'Sûr ?', () => socket.emit('giveup')); }
      for (const id of ['#artistInput', '#songInput', '#submitBtn', '#randomBtn', '#giveupBtn']) $(id).disabled = busy;
      const fb = $('#feedback');
      if (me.arriving) { fb.hidden = false; fb.className = 'feedback info'; fb.innerHTML = `<span class="spin"></span>${esc(cur.name)} a-t-il déjà un son avec ${esc(r.target.name)} ? Vérification…`; }
      else if (busy) { fb.hidden = false; fb.className = 'feedback info'; fb.innerHTML = `<span class="spin"></span>Recherche d’un son avec ${esc(cur.name)} et ${esc(me.checking.artist.name)}…`; }
      else if (me.lastError) {
        const e = me.lastError;
        const k = JSON.stringify(e) + mine.length;
        if (k !== brErrKey) { brErrKey = k; const f = $('#playForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); sfx.buzz(); }
        fb.hidden = false; fb.className = 'feedback';
        const addable = e.why === 'notfound' || e.why === 'api';
        fb.innerHTML = `<p>${e.why === 'used' ? `<b>${esc(e.artist.name)}</b> est déjà dans ton chemin.` : e.why === 'api' ? 'La vérification n’a pas abouti, réessaie.' : `Aucun son trouvé avec <b>${esc(cur.name)}</b> et <b>${esc(e.artist.name)}</b>${e.song ? ` sous le titre « ${esc(e.song)} »` : ''}. Si le feat existe (invité non crédité), ajoute-le.`}</p>` + (addable ? ADD_FEAT : '');
        if (addable) armAddFeat(fb, e);
      } else fb.hidden = true;
    }

    // --- Avancée des autres (sans montrer leur chemin) ---
    const others = S.players.map((p, i) => ({ p, i, l: r.lanes && r.lanes[i] })).filter((x) => x.i !== S.me && x.l);
    $('#watch').hidden = !(playing && others.length);
    if (playing && others.length) {
      $('#watch').innerHTML = others.map(({ p, l }) => `<span class="br-other"><b>${esc(p.name)}</b> ${l.done ? `est arrivé en ${plural(l.links, 'feat')} (${fmtTime(l.doneAt)})` : l.gaveUp ? 'a abandonné' : `en est à ${plural(l.links, 'feat')}`}</span>`).join('');
    }

    // --- Mon chemin ---
    if (mine.length !== brLen || key !== brKey) {
      if (mine.length > brLen && brLen > 0 && mine.length > 1) sfx.ding();
      brLen = mine.length;
      $('#chainTitle').textContent = mine.length ? `Ton chemin, ${plural(n, 'feat')}` : 'Ton chemin';
      $('#chain').innerHTML = mine.length ? mine.map((l, i) => `<li class="p${S.me}${i === 0 ? ' origin' : ''}"><div class="a">${esc(l.artist.name)} ${i === 0 ? '<span class="by">départ</span>' : ''}</div>${l.track ? trackCard(l.track, false, []) : ''}</li>`).reverse().join('') : '';
      $('#chainWrap').hidden = !mine.length;
      bindTracks();
    }
    const rk = res ? `${r.id}` : '';
    brResKey = rk;
    // Arrivée : célébration plein écran, seulement au moment où ça arrive (pas en revenant sur une manche déjà finie).
    if (brPrev.id === r.id && !brPrev.done && me.done) celebrateBridge(r, me, mine);
    brPrev = { id: r.id, done: !!me.done };
    renderBridgeEnd(r);
    tickClock();
  }

  function renderBridgeEnd(r) {
    if (S.phase === 'finished' && S.final && S.final.solo) return renderSoloEnd(r);
    const ended = S.phase === 'roundEnd' || S.phase === 'finished';
    const sheet = $('#endSheet');
    const wasHidden = sheet.hidden;
    sheet.hidden = !ended;
    document.body.classList.toggle('sheet-open', ended);
    if (!ended) return;
    const fin = S.phase === 'finished';
    const w = fin && S.final ? S.final.winner : r.winner;
    const res = r.results || [];
    $('#endKicker').textContent = fin ? 'Fin de la partie' : `Fin du pont ${S.roundNo}`;
    $('#endTitle').textContent = w == null ? 'Personne n’est arrivé' : fin ? (w === S.me ? 'Tu gagnes la partie' : `${S.players[w].name} gagne`) : (w === S.me ? 'Pont pour toi' : `Pont pour ${S.players[w].name}`);
    sheet.classList.toggle('win', w === S.me);
    $('#endText').textContent = r.solution
      ? `${r.shortest ? 'Chemin le plus court' : 'Chemin du jeu'} : ${solPath(r)} (${plural(r.pathLen || r.shortest || 2, 'feat')}).`
      : `${r.start ? r.start.name : ''} → ${r.target ? r.target.name : ''}.`;
    const ex = $('#endExamples');
    ex.hidden = false; ex.dataset.key = '';
    ex.innerHTML = `<p>Le classement :</p><ul>${res.map((x) => {
      const lane = r.lanes[x.i];
      const path = lane && lane.chain ? lane.chain.map((c) => c.artist.name + (c.track && c.track.added ? ' (feat ajouté)' : '')).join(' → ') : '';
      const st = x.done ? `${plural(x.links, 'feat')} en ${fmtTime(x.time)}` : x.gaveUp ? 'abandon' : 'pas arrivé';
      return `<li><div class="ex-txt"><b>${esc(S.players[x.i]?.name || '')} · ${st}</b><span>${esc(path)}</span></div></li>`;
    }).join('')}</ul>`;
    const N = S.players.length;
    $('#endScore').innerHTML = N === 2
      ? `<span class="s p0">${esc(S.players[0].name)}<b>${S.players[0].score}</b></span><span class="s p1"><b>${S.players[1].score}</b>${esc(S.players[1].name)}</span>`
      : `<ol class="board">${S.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score).map(({ p, i }) => `<li class="p${i}${i === S.me ? ' me' : ''}"><span class="dot"></span><span class="nm">${esc(p.name)}</span><b>${p.score}</b></li>`).join('')}</ol>`;
    $('#endRecap').hidden = true;
    const btn = $('#endBtn');
    btn.hidden = false;
    if (fin) { btn.textContent = 'Revanche'; btn.onclick = () => socket.emit('start'); }
    else { btn.textContent = 'Pont suivant'; btn.onclick = () => socket.emit('next'); }
    $('#stopBtn').hidden = true;
    if (wasHidden) { setTimeout(() => btn.focus({ preventScroll: true }), 60); if (w === S.me) sfx.win(); else sfx.out(); }
  }

  function renderBlind() {
    $('#playForm').classList.remove('br-form');
    // « Au hasard » : avec un artiste déjà tapé, un son au hasard de cet artiste ; sinon un artiste au hasard.
    $('#randomBtn').onclick = async () => {
      const typed = $('#artistInput').value.trim();
      if (!typed) return socket.emit('randomStart');
      let a = pickedArtist && pickedArtist.name.toLowerCase() === typed.toLowerCase() ? pickedArtist : null;
      if (!a) {
        try { const data = await (await fetch('/api/artists?q=' + encodeURIComponent(typed))).json(); a = data.find((x) => x.name.toLowerCase() === typed.toLowerCase()) || data[0]; } catch {}
      }
      $('#acList').hidden = true;
      socket.emit('randomStart', a ? { artist: a } : {});
    };
    const r = S.round;
    const N = S.players.length;
    buildScorebug(N);
    const actor = r && S.phase === 'playing' ? (r.step === 'guess' ? r.guesser : r.step === 'reveal' ? -1 : r.proposer) : -1;
    document.querySelectorAll('#scorebug [data-p]').forEach((el) => {
      const i = Number(el.dataset.p);
      const p = S.players[i] || { name: '—', score: 0, online: false };
      el.querySelector('.pname').textContent = p.name;
      const pj = el.querySelector('.pj');
      pj.textContent = `🃏 ${p.jokers || 0}`;
      pj.classList.toggle('zero', !p.jokers);
      el.querySelector('.pscore').textContent = p.pts || 0; // points de la manche en cours
      el.classList.toggle('active', actor === i);
      el.classList.toggle('off', !p.online);
      el.classList.toggle('me', i === S.me);
      el.classList.remove('out');
    });
    $('#roundLabel').textContent = `Manche ${S.mancheNo || 1}, premier à ${plural(S.settings.points || 5, 'point')}`;
    $('#muteBtn').hidden = true;
    $('#judgeOverlay').hidden = true;
    $('#ko').hidden = true;
    if (!r) return;

    const playing = S.phase === 'playing';
    const iPropose = playing && r.proposer === S.me && (r.step === 'propose' || r.step === 'pick');
    const iGuess = playing && r.guesser === S.me && r.step === 'guess';
    const prop = S.players[r.proposer]?.name || '', gues = S.players[r.guesser]?.name || '';
    const key = `${r.id}-${r.step}-${r.artist ? r.artist.id : ''}`;
    const newStep = key !== btStepKey;

    // --- Scène ---
    if (newStep) {
      btStepKey = key;
      let html;
      if (r.step === 'reveal' && r.artist) html = `${avatar(r.artist)}<span class="nm">${esc(r.artist.name)}</span>`;
      else if (r.step === 'guess') html = `<button type="button" class="bt-disc" id="btDisc" data-prev="${esc(r.track && r.track.preview || '')}" aria-label="Écouter l’extrait"><span>${PLAY}</span></button><span class="nm q">Qui chante ?</span>`;
      else if (r.step === 'pick' && r.artist) html = `${avatar(r.artist)}<span class="nm">${esc(r.artist.name)}</span>`;
      else html = `<span class="av q" aria-hidden="true">♪</span><span class="nm q">${r.proposer === S.me ? 'À toi de choisir' : 'Choix du son'}</span>`;
      $('#current').innerHTML = html;
      $('#current').classList.remove('pop'); void $('#current').offsetWidth; $('#current').classList.add('pop');
      if (r.step !== 'guess' || iGuess) { $('#artistInput').value = ''; $('#songInput').value = ''; pickedArtist = null; }
      if (r.step === 'propose') audio.pause();
      if (iPropose || iGuess) {
        if (navigator.vibrate) try { navigator.vibrate(60); } catch {}
        setTimeout(() => { $('#playForm').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('#artistInput').focus({ preventScroll: true }); }, 80);
      }
    }
    $('#qzPanel').hidden = true; $('#goal').hidden = true; $('#chainWrap').hidden = false;
    const disc = $('#btDisc');
    if (disc) {
      syncPlayButtons();
      disc.onclick = () => {
        if (!r.track || !r.track.preview) return;
        if (!audio.paused && audio.dataset.src === r.track.preview) audio.pause();
        else playPreview(r.track.preview, true, { limit: r.extended ? 0 : S.listenSeconds || 10 });
      };
    }
    $('#proof').hidden = true;

    // --- Bandeau ---
    const banner = $('#turnBanner');
    banner.hidden = !playing;
    const res = r.result;
    banner.className = 'turn ' + (iPropose || iGuess ? 'me' : 'them');
    banner.innerHTML = r.step === 'reveal'
      ? (res && res.points ? `${r.guesser === S.me ? 'Tu trouves' : esc(gues) + ' trouve'} ${res.title ? 'l’artiste et le titre' : 'l’artiste'} : <b>+${res.points}</b>${res.ms != null ? ` en ${(res.ms / 1000).toFixed(1).replace('.', ',')} s` : ''}${res.fast ? ' et un joker 🃏' : ''}`
        : res && res.why === 'timeout' ? 'Temps écoulé : personne ne marque.' : res && res.why === 'pass' ? `${r.guesser === S.me ? 'Tu passes' : esc(gues) + ' passe'} : personne ne marque.` : 'Raté : personne ne marque.')
      : r.step === 'loading' ? '<span class="spin"></span>Chargement de l’extrait…'
      : r.step === 'guess'
        ? (iGuess ? `À toi : <b>quel artiste chante ?</b><span class="bt-fast">Trouve en moins de ${S.fastSeconds} s : +1 joker</span>` : `${esc(gues)} écoute l’extrait choisi par ${esc(nameOf(r.proposer))}.`)
        : iPropose ? (r.step === 'pick' ? `Choisis le son à faire deviner à <b>${esc(nameOf(r.guesser))}</b>.` : `Fais deviner un son à <b>${esc(nameOf(r.guesser))}</b>.`)
          : `${esc(prop)} choisit un son pour ${esc(nameOf(r.guesser))}.`;
    document.title = !playing ? 'Raptor Games' : (iPropose || iGuess) ? '● À toi | Blind test' : 'Blind test | Raptor Games';

    // --- Formulaire ---
    const form = iGuess || (iPropose && r.step === 'propose');
    $('#playForm').hidden = !form;
    if (!form) $('#jokerBtn').hidden = true;
    if (form) {
      const busy = !!r.checking;
      $('#songInput').hidden = !iGuess;
      $('#songInput').placeholder = 'Titre du son (+1 point bonus)';
      $('#giveupBtn').hidden = !iGuess;
      $('#randomBtn').hidden = !iPropose;
      $('#randomBtn').textContent = 'Au hasard';
      $('#artistInput').placeholder = iGuess ? 'L’artiste que tu entends' : 'Un artiste à faire deviner';
      $('#submitBtn').textContent = iGuess ? 'Valider' : 'Choisir';
      const out = iGuess && (r.tries || 0) >= (r.maxTries || 3);
      $('#artistInput').disabled = busy || out; $('#songInput').disabled = busy || out;
      $('#submitBtn').disabled = busy || out; $('#giveupBtn').disabled = busy; $('#randomBtn').disabled = busy;
      if (btGiveKey !== key) { btGiveKey = key; armTwoTap($('#giveupBtn'), 'Je passe', 'Sûr ?', () => socket.emit('giveup')); }
      // Joker : écouter la suite de l'extrait (après les premières secondes).
      $('#jokerBtn').hidden = !iGuess || r.extended || !(S.jokers > 0);
      $('#jokerBtn').textContent = 'Joker : écouter la suite';
      $('#jokerBtn').setAttribute('aria-label', `Joker : écouter la suite de l’extrait (${S.jokers} restant${S.jokers > 1 ? 's' : ''})`);
      $('#jokerBtn').disabled = busy;
      const fb = $('#feedback');
      if (busy) { fb.hidden = false; fb.className = 'feedback info'; fb.innerHTML = `<span class="spin"></span>Chargement des sons${r.checking.artist ? ` de ${esc(r.checking.artist.name)}` : ''}…`; }
      else if (r.lastError) {
        const e = r.lastError, left = (r.maxTries || 3) - (r.tries || 0);
        const fk = JSON.stringify(e) + r.tries;
        if (fk !== btFbKey) {
          btFbKey = fk;
          const f = $('#playForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
          if (navigator.vibrate) try { navigator.vibrate([30, 40, 30]); } catch {}
          setTimeout(() => { const i = $('#artistInput'); i.focus({ preventScroll: true }); i.select(); }, 30);
        }
        fb.hidden = false; fb.className = 'feedback';
        fb.innerHTML = e.why === 'nopreview'
          ? `<p>Aucun extrait audio disponible pour <b>${esc(e.artist.name)}</b>. Choisis un autre artiste.</p>`
          : e.why === 'allused'
          ? `<p>Tous les sons de <b>${esc(e.artist.name)}</b> ont déjà été joués. Choisis un autre artiste.</p>`
          : `<p>Ce n’est pas <b>${esc(e.artist.name)}</b>.${left > 0 ? ` Encore ${plural(left, 'essai')}.` : ''}</p>`;
      } else fb.hidden = true;
    }

    // --- Panneau : choix du son (celui qui propose) ou réponse ---
    const panel = $('#btPanel');
    const optsKey = iPropose && r.step === 'pick' ? 'pick-' + key : r.step === 'reveal' ? 'rev-' + key : '';
    panel.hidden = !optsKey;
    if (optsKey && panel.dataset.key !== optsKey) {
      panel.dataset.key = optsKey;
      if (r.step === 'pick') {
        // Le champ de recherche n'est construit qu'une fois : la liste se met à jour dessous sans couper la saisie.
        panel.innerHTML = `<input id="btSearch" placeholder="Un son précis de ${esc(r.artist.name)} ?" aria-label="Chercher un son de ${esc(r.artist.name)}" autocomplete="off" enterkeyhint="search">
          <p class="small" id="btListHint"></p><ul class="bt-opts" id="btOpts"></ul>
          <div class="play-row"><button type="button" class="btn" id="btRandomPick">Au hasard</button><button type="button" class="btn ghost" id="btBack">Autre artiste</button></div>`;
        let t = null;
        $('#btSearch').addEventListener('input', (e) => {
          clearTimeout(t);
          const q = e.target.value;
          $('#btListHint').innerHTML = q.trim().length >= 2 ? '<span class="spin"></span>Recherche…' : '';
          t = setTimeout(() => socket.emit('bt:search', { q }), 300);
        });
        $('#btSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); socket.emit('bt:search', { q: e.target.value }); } });
        $('#btRandomPick').onclick = () => { audio.pause(); socket.emit('bt:pick', { id: null }); };
        $('#btBack').onclick = () => socket.emit('bt:back');
        panel.dataset.list = '';
      } else {
        const res2 = r.result || {};
        const said = res2.points ? '' : r.lastError && r.lastError.why === 'wrong' ? `<p class="small">Dernière réponse : ${esc(r.lastError.artist.name)}</p>` : '';
        const titleNote = res2.points && !res2.title && res2.song ? `<p class="small">Titre proposé : « ${esc(res2.song)} », pas le bon.</p>` : '';
        panel.innerHTML = (r.track ? trackCard(r.track, false, []) : '') + said + titleNote
          + (S.phase === 'playing' ? `<p class="small bt-next">Prochain extrait dans quelques secondes. ${esc(nameOf(r.guesser, true))} ${r.guesser === S.me ? 'proposes' : 'propose'} ensuite.</p>` : '');
      }
      bindTracks();
    }
    // Liste des sons proposés (les plus écoutés, ou résultats de la recherche tapée).
    if (optsKey && r.step === 'pick') {
      const listKey = (r.query || '') + '|' + r.options.map((o) => o.id).join(',');
      if (panel.dataset.list !== listKey) {
        panel.dataset.list = listKey;
        const q = r.query || '';
        const typed = ($('#btSearch').value || '').trim();
        if (typed === q.trim() || typed.length < 2) {
          $('#btListHint').innerHTML = q.length >= 2
            ? (r.options.length ? `Sons de ${esc(r.artist.name)} pour « ${esc(q)} » :` : `Aucun son de ${esc(r.artist.name)} trouvé pour « ${esc(q)} ». Essaie un autre titre.`)
            : `Ses sons les plus écoutés. Choisis-en un, ou tape un titre au-dessus.`;
        }
        // En grille, sans extrait à écouter : plus de sons visibles d'un coup.
        $('#btOpts').innerHTML = r.options.map((t) => `<li><button type="button" class="bt-opt" data-id="${t.id}" title="${esc(t.title)}"><b>${esc(t.title)}</b>${t.album && t.album !== t.title ? `<span>${esc(t.album)}</span>` : ''}</button></li>`).join('');
        $('#btOpts').querySelectorAll('.bt-opt').forEach((b) => (b.onclick = () => { audio.pause(); socket.emit('bt:pick', { id: Number(b.dataset.id) }); }));
        bindTracks();
      }
    }

    // --- Ce que voient les autres ---
    const watching = playing && !iPropose && !iGuess && r.step !== 'reveal';
    $('#watch').hidden = !watching;
    if (watching) {
      let txt = r.step === 'guess'
        ? (r.lastError && r.lastError.why === 'wrong'
          ? `${esc(gues)} a proposé <b>${esc(r.lastError.artist.name)}</b> : raté. Essai ${r.tries} sur ${r.maxTries || 3}. <span class="dots">Il cherche encore</span>`
          : `<span class="dots">${esc(gues)} cherche</span>`)
        : `<span class="dots">${esc(prop)} choisit un son</span>`;
      const p = S.players[r.turn];
      const alone = !S.players.some((x, i) => i !== S.me && !x.bot && x.online);
      const leavable = p && !p.online && alone;
      if (p && !p.online) txt = `${esc(p.name)} s'est déconnecté. La partie reprend dès son retour.` + (S.solo ? '' : `<span class="rejoin">Pour revenir : code <b>${esc(S.code)}</b> sur l’accueil.</span>`);
      $('#watch').innerHTML = txt + (leavable ? `<button type="button" class="btn ghost small-btn" id="quitGameBtn">Quitter la partie</button>` : '');
      if (leavable) $('#quitGameBtn').onclick = leaveRoom;
    }

    // --- Historique des extraits, le plus récent en haut ---
    const log = S.log || [];
    const logTotal = S.logTotal ?? log.length;
    if (logTotal !== btLogLen) {
      btLogLen = logTotal;
      $('#chainTitle').textContent = logTotal ? `Les extraits, ${logTotal}` : 'Les extraits';
      $('#chain').innerHTML = log.length ? log.map((l) => {
        const pts = (l.points ? `<span class="tag rare">+${l.points}</span>` : '<span class="tag">0</span>') + (l.fast ? ' <span class="tag">Rapide</span>' : '') + (l.extended ? ' <span class="tag">Joker</span>' : '');
        return `<li class="p${l.guesser}"><div class="a">${esc(l.artist ? l.artist.name : '')} <span class="by">${esc(S.players[l.proposer]?.name || '')} → ${esc(S.players[l.guesser]?.name || '')}</span> ${pts}</div>${l.track ? trackCard(l.track, false, []) : ''}</li>`;
      }).reverse().join('') : '';
      $('#chainWrap').hidden = !log.length; // pas de liste vide à l'écran
      bindTracks();
    }

    // Sons : bonne réponse, raté.
    const rk = r.step === 'reveal' ? `${r.id}-${res ? res.points : 0}` : r.lastError ? `${r.id}-miss-${r.tries}` : '';
    if (rk && rk !== btResultKey && btResultKey !== '') {
      if (r.step === 'reveal') { (res && res.points ? sfx.ding : sfx.out)(); if (res && res.fast) setTimeout(() => sfx.bonus(), 250); }
      else if (r.lastError.why === 'wrong') sfx.buzz();
    }
    btResultKey = rk || btResultKey || 'init';

    renderBlindEnd();
    tickClock();
  }

  function renderBlindEnd() {
    const fin = S.phase === 'finished';
    const ended = fin || S.phase === 'roundEnd';
    const sheet = $('#endSheet');
    const wasHidden = sheet.hidden;
    sheet.hidden = !ended;
    document.body.classList.toggle('sheet-open', ended);
    if (!ended) return;
    const w = fin && S.final ? S.final.winner : S.round ? S.round.winner : null;
    const nm = (i) => (i === S.me ? 'Tu' : S.players[i]?.name);
    $('#endKicker').textContent = fin ? 'Fin du blind test' : `Fin de la manche ${S.mancheNo}`;
    $('#endTitle').textContent = w == null ? 'Égalité' : fin ? (w === S.me ? 'Tu gagnes le blind test' : `${S.players[w].name} gagne`) : (w === S.me ? 'Manche pour toi' : `Manche pour ${S.players[w].name}`);
    sheet.classList.toggle('win', w === S.me);
    $('#endText').textContent = w == null ? '' : `${nm(w)} ${w === S.me ? 'atteins' : 'atteint'} ${plural(S.settings.points || 5, 'point')}.` + (fin ? '' : ` ${(() => { const s = S.players[S.mancheNo % S.players.length]; return s ? (s.name === S.players[S.me]?.name ? 'Tu fais' : s.name + ' fait') : ''; })()} deviner en premier à la prochaine.`);
    $('#endExamples').hidden = true;
    const N = S.players.length;
    $('#endScore').innerHTML = N === 2
      ? `<span class="s p0">${esc(S.players[0].name)}<b>${S.players[0].score}</b></span><span class="s p1"><b>${S.players[1].score}</b>${esc(S.players[1].name)}</span>`
      : `<ol class="board">${S.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score).map(({ p, i }) => `<li class="p${i}${i === S.me ? ' me' : ''}"><span class="dot"></span><span class="nm">${esc(p.name)}</span><b>${p.score}</b></li>`).join('')}</ol>`;
    renderRecap(fin && S.final ? S.final.recap : null);
    const btn = $('#endBtn');
    btn.hidden = false;
    if (fin) { btn.textContent = 'Revanche'; btn.onclick = () => { unlockAudio(); socket.emit('start'); }; }
    else { btn.textContent = 'Manche suivante'; btn.onclick = () => { unlockAudio(); socket.emit('next'); }; }
    $('#stopBtn').hidden = true;
    if (wasHidden) { setTimeout(() => btn.focus({ preventScroll: true }), 60); if (w === S.me) sfx.win(); else sfx.out(); }
  }
  socket.on('extract', ({ preview }) => { if (S && S.mode === 'blind' && preview) playPreview(preview, true, { limit: S.listenSeconds || 10 }); });
  socket.on('extractMore', ({ preview, from }) => { if (S && S.mode === 'blind' && preview) playPreview(preview, true, { from }); });

  function renderFeedback(r, cur, opp, oppTo) {
    const fb = $('#feedback');
    if (!cur && S.mode === 'bridge') { fb.hidden = true; return; } // pont en préparation
    if (r.checking && r.checking.verifying) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>On vérifie qu'il reste des feats avec ${esc(r.checking.artist.name)}… Chrono en pause.`;
      return;
    }
    if (r.checking && r.checking.joker) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>Le joker cherche un rappeur pour toi…`;
      return;
    }
    if (r.checking && r.checking.random) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>Tirage d'un rappeur français…`;
      return;
    }
    if (r.checking) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>Recherche d’un son avec ${esc(cur.name)} et ${esc(r.checking.artist.name)}. Chrono en pause.`;
      return;
    }
    if (r.appeal) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>${S.players.length === 2 ? `${esc(opp)} décide` : 'Les autres décident'} si ton feat compte. Chrono en pause.`;
      return;
    }
    if (!r.lastError) { fb.hidden = true; return; }
    const e = r.lastError;
    const key = JSON.stringify(e);
    if (key !== lastErrKey) {
      lastErrKey = key;
      const f = $('#playForm'); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake');
      if (navigator.vibrate) try { navigator.vibrate([30, 40, 30]); } catch {}
      // Garde la saisie, sélectionnée pour retaper vite.
      if (e.why !== 'random') setTimeout(() => { const i = $('#artistInput'); if (!i.value) i.value = e.artist.name; i.focus({ preventScroll: true }); i.select(); }, 30);
    }
    fb.hidden = false; fb.className = 'feedback';
    const msg = {
      used: `<b>${esc(e.artist.name)}</b> est déjà dans la chaîne. Trouve quelqu'un d'autre.`,
      random: 'Le tirage n’a pas marché. Réessaie ou tape un artiste.',
      joker: `Le joker n’a trouvé aucun rappeur pour ${esc(cur ? cur.name : '')}. Ton joker est conservé.`,
      notfound: `Aucun son trouvé avec <b>${esc(cur ? cur.name : '')}</b> et <b>${esc(e.artist.name)}</b>${e.song ? ` sous le titre « ${esc(e.song)} »` : ''}. Si le feat existe, demande ${esc(oppTo)} de le valider. Sinon, propose quelqu'un d'autre.`,
      refused: `<b>${esc(e.artist.name)}</b> a été refusé. Propose un autre artiste.`,
      api: `La vérification n’a pas abouti. Réessaie dans un instant ou demande ${esc(oppTo)} de valider.`,
    }[e.why] || 'Ce feat ne passe pas.';
    const canAppeal = (e.why === 'notfound' || e.why === 'api') && !S.solo;
    const canAdd = (e.why === 'notfound' || e.why === 'api') && S.solo;
    const max = r.maxTries || 3, left = max - (r.tries || 0);
    const triesMsg = e.why === 'api' || e.why === 'random' || e.why === 'joker' ? ''
      : left <= 0 ? ''
      : ` Encore ${left} essai${left > 1 ? 's' : ''}.`;
    const body = left <= 0 && e.why === 'notfound'
      ? `Aucun son trouvé avec <b>${esc(cur ? cur.name : '')}</b> et <b>${esc(e.artist.name)}</b>. <b>Plus d'essais</b> : demande ${esc(oppTo)} de valider ce feat, ou sèche.`
      : msg + triesMsg;
    const soloBody = canAdd ? body.replace(/ Si le feat existe, demande [^.]*\. Sinon,/, ' Si le feat existe (invité non crédité), ajoute-le. Sinon,').replace(/ ou demande [^.]*de valider\./, '.').replace(/demande [^:]*de valider ce feat, ou sèche\./, 'ajoute ce feat, ou sèche.') : body;
    fb.innerHTML = `<p>${soloBody}</p>` + (canAppeal ? `<button type="button" class="btn ghost small-btn" id="appealBtn">Demander ${esc(oppTo)}</button>` : '') + (canAdd ? ADD_FEAT : '');
    if (canAppeal) $('#appealBtn').onclick = () => socket.emit('appeal');
    if (canAdd) armAddFeat(fb, e);
  }

  // ================= K.O. =================
  // Plus aucun feat possible avec l'artiste en jeu : écran K.O. façon jeu de combat, puis le choix du joueur mis K.O.
  let koShownId = null, koVictimAt = null;
  function renderKO(r) {
    const el = $('#ko');
    const ko = S.phase === 'playing' && r.ko;
    if (!ko) { el.hidden = true; el.classList.remove('ko-in', 'settled'); document.body.classList.remove('ko-open'); return; }
    const first = ko.id !== koShownId;
    const newVictim = ko.at !== koVictimAt;
    koShownId = ko.id; koVictimAt = ko.at;
    const victim = S.players[ko.victim], author = S.players[ko.by];
    const meVictim = ko.victim === S.me;
    $('#koSub').innerHTML = first || newVictim
      ? `Plus aucun feat possible avec <b>${esc(ko.artist.name)}</b>.<br>${meVictim ? `<b>${esc(author?.name || '')}</b> te met K.O. !` : ko.by === S.me ? `Tu mets <b>${esc(victim?.name || '')}</b> K.O. !` : `<b>${esc(author?.name || '')}</b> met <b>${esc(victim?.name || '')}</b> K.O. !`}`
      : $('#koSub').innerHTML;
    const panel = $('#koPanel');
    let html = '';
    const relaunching = r.checking && r.checking.relaunch;
    if (relaunching) {
      html = `<p class="small"><span class="spin"></span>${meVictim ? 'Tirage de ton rappeur…' : esc(victim.name) + ' relance avec un rappeur au hasard…'}</p>`;
    } else if (meVictim && ko.canRelaunch) {
      html = `<p class="small">Tu peux relancer avec un rappeur au hasard pour ${ko.cost} jokers.</p>
        <span class="ko-jokers">Tes jokers : <b>${S.jokers}</b></span>
        <button type="button" class="btn big" id="koRelaunch">Relancer · ${ko.cost} 🃏</button>
        <button type="button" class="link" id="koGiveUp">Abandonner la manche</button>`;
    } else if (meVictim) {
      html = `<p class="small">Il te faudrait ${ko.cost} jokers pour relancer. Tu es éliminé de la manche.</p>
        <span class="ko-jokers">Tes jokers : <b>${S.jokers}</b></span>`;
    } else {
      html = `<p class="small">${ko.canRelaunch ? `${esc(victim.name)} peut relancer avec ${ko.cost} jokers…` : `${esc(victim.name)} est éliminé de la manche.`}</p>`;
    }
    // On ne réécrit le panneau que s'il change : sinon un appui pourrait tomber pendant une mise à jour et se perdre.
    if (panel.dataset.html !== html) {
      panel.dataset.html = html;
      panel.innerHTML = html;
      const rl = $('#koRelaunch'), gu = $('#koGiveUp');
      if (rl) rl.onclick = () => { rl.disabled = true; socket.emit('koRelaunch'); };
      if (gu) gu.onclick = () => socket.emit('koGiveUp');
    }
    if (first || newVictim) {
      el.hidden = false;
      document.body.classList.add('ko-open');
      el.classList.remove('ko-in', 'settled', 'again'); void el.offsetWidth;
      el.classList.add(first ? 'ko-in' : 'again');
      if (first) {
        sfx.ko();
        const g = $('#game'); g.classList.remove('ko-shake'); void g.offsetWidth; g.classList.add('ko-shake');
        if (navigator.vibrate) try { navigator.vibrate([80, 40, 160]); } catch {}
      }
      clearTimeout(renderKO.t);
      renderKO.t = setTimeout(() => el.classList.add('settled'), first ? 1500 : 500);
    }
  }

  // Vies restantes (solo sans bot), et annonce quand on en perd une.
  function hearts() {
    if (S.lives == null) return '';
    const max = Math.min(5, Math.max(1, S.settings.target || 3));
    return `<span class="hearts" aria-label="${plural(S.lives, 'vie')} sur ${max}">${ico('i-heart', 'hrt on').repeat(Math.max(0, S.lives))}${ico('i-heart', 'hrt').repeat(Math.max(0, max - S.lives))}</span>`;
  }
  let lastLifeId = null;
  function lifeNotice() {
    const l = S.lifeLoss;
    const id = l ? l.id : 0;
    if (lastLifeId !== null && id && id !== lastLifeId && S.phase === 'playing') {
      toast(l.left > 1 ? `Une vie en moins, il t’en reste ${l.left}` : 'Dernière vie !', 2600);
      sfx.out();
      const h = document.querySelector('.hearts'); if (h) { h.classList.remove('hit'); void h.offsetWidth; h.classList.add('hit'); }
    }
    lastLifeId = id;
  }

  // Fin d'une partie solo sans bot (pont, plus ou moins, frise) : le résultat et le record de la session.
  function renderSoloEnd(r) {
    const f = S.final;
    const sheet = $('#endSheet');
    const wasHidden = sheet.hidden;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    const bridge = S.mode === 'bridge';
    $('#endKicker').textContent = bridge ? 'Le pont' : S.mode === 'fans' ? 'Plus ou moins' : 'La frise';
    $('#endTitle').textContent = f.record ? 'Nouveau record' : 'Plus de vies';
    sheet.classList.toggle('win', !!f.record);
    const why = r.reason === 'timeout' ? 'Temps écoulé' : r.reason === 'ko' ? 'K.O., plus aucun feat possible' : r.reason === 'giveup' ? 'Tu as séché' : r.reason === 'tries' ? 'Plus d’essais' : 'Mauvaise réponse';
    $('#endText').textContent = (bridge
      ? `${f.count ? `${plural(f.count, 'pont')} réussi${f.count > 1 ? 's' : ''}` : 'Aucun pont réussi'} avec ${plural(S.settings.target || 3, 'vie')}. Dernier pont : ${why.toLowerCase()}, il fallait rejoindre ${r.target ? r.target.name : ''}.` + (r.solution ? ` Chemin le plus court : ${solPath(r)}.` : '')
      : `${goodAnswers(f.count)} avec ${plural(S.settings.target || 3, 'vie')}.${missedLine(r)}`);
    $('#endExamples').hidden = true;
    $('#endScore').innerHTML = f.best != null && f.plays > 1
      ? `<p class="solo-best">Record de la session : <b>${f.best}</b></p>` : '';
    $('#endRecap').hidden = true;
    const btn = $('#endBtn');
    btn.hidden = false; btn.textContent = 'Rejouer'; btn.onclick = () => socket.emit('start');
    $('#stopBtn').hidden = true;
    if (wasHidden) { setTimeout(() => btn.focus({ preventScroll: true }), 60); if (f.won || f.record) sfx.win(); else sfx.out(); }
  }

  function renderEnd(r, cur) {
    if (S.phase === 'finished' && S.final && S.final.solo) return renderSoloEnd(r);
    const ended = S.phase === 'roundEnd' || S.phase === 'finished';
    const sheet = $('#endSheet');
    const wasHidden = sheet.hidden;
    sheet.hidden = !ended;
    if (ended && wasHidden) $('#toast').hidden = true; // pas de message par-dessus le résultat
    document.body.classList.toggle('sheet-open', ended);
    if (!ended) return;

    const fin = S.phase === 'finished';
    const stopped = fin && S.final && S.final.stopped;
    const w = fin && S.final ? S.final.winner : r.winner;
    const N = S.players.length;
    const lastOut = r.lastOut || { who: (r.winner + 1) % N, on: cur ? cur.name : null };
    const loserName = S.players[lastOut.who]?.name;
    const won = w === S.me;
    const n = Math.max(0, r.chain.length - 1);

    $('#endKicker').textContent = fin ? (stopped ? `Partie arrêtée après ${plural(S.roundNo, 'manche')}` : 'Fin de la partie') : `Fin de la manche ${S.roundNo}`;
    $('#endTitle').textContent = fin ? (w == null ? 'Égalité' : won ? 'Tu gagnes la partie' : `${S.players[w].name} gagne`) : (won ? 'Manche pour toi' : `Manche pour ${S.players[r.winner].name}`);
    sheet.classList.toggle('win', w === S.me);
    const why = r.reason === 'timeout' ? `${loserName} n'a pas répondu à temps` : r.reason === 'tries' ? `${loserName} a raté ses ${r.maxTries || 3} essais` : r.reason === 'ko' ? `${loserName} est K.O., plus aucun feat possible` : `${loserName} a séché`;
    $('#endText').textContent = stopped
      ? (w == null ? 'Score parfaitement égal.' : `Score final en faveur de ${S.players[w].name}.`)
      : (lastOut.on ? (r.reason === 'ko' ? `${why} avec ${lastOut.on}, après une chaîne de ${plural(n, 'feat')}.` : `${why} sur ${lastOut.on}, après une chaîne de ${plural(n, 'feat')}.`) : `${why} avant même de poser l'artiste de départ.`)
        + (N > 2 ? (r.winner === S.me ? ' Tu es le dernier en jeu.' : ` ${S.players[r.winner].name} est le dernier en jeu.`) : '');
    // Le pont : gagné en atteignant l'arrivée ; on montre aussi le chemin prévu par le jeu.
    if (S.mode === 'bridge' && r.target) {
      const via = r.solution && r.solution.via ? ` Le jeu passait par ${r.solution.via.name}.` : '';
      if (r.reason === 'bridge') $('#endText').textContent = `${S.players[r.winner].name === S.players[S.me]?.name ? 'Tu relies' : S.players[r.winner].name + ' relie'} ${r.start ? r.start.name : ''} à ${r.target.name} en ${plural(n, 'feat')}.${via}`;
      else if (via) $('#endText').textContent += via;
    }
    $('#endScore').innerHTML = N === 2
      ? `<span class="s p0">${esc(S.players[0].name)}<b>${S.players[0].score}</b></span><span class="s p1"><b>${S.players[1].score}</b>${esc(S.players[1].name)}</span>`
      : `<ol class="board">${S.players.map((p, i) => ({ p, i })).sort((a, b) => b.p.score - a.p.score).map(({ p, i }) => `<li class="p${i}${i === S.me ? ' me' : ''}"><span class="dot"></span><span class="nm">${esc(p.name)}</span><b>${p.score}</b></li>`).join('')}</ol>`;

    // Feats qu'on aurait pu citer (chargés juste après la fin de manche).
    const ex = $('#endExamples');
    const exKey = JSON.stringify(r.examples || []);
    if (ex.dataset.key !== exKey) {
      ex.dataset.key = exKey;
      ex.hidden = !(r.examples && r.examples.length);
      if (!ex.hidden) {
        ex.innerHTML = `<p>Il y avait par exemple :</p><ul>${r.examples.map((e) => `<li><div class="ex-txt"><b>${esc(e.artist.name)}</b><span>« ${esc(e.track.title)} »</span></div>${e.track.preview ? `<button type="button" class="play-btn" data-prev="${esc(e.track.preview)}" aria-label="Écouter « ${esc(e.track.title)} »">${PLAY}</button>` : ''}</li>`).join('')}</ul>`;
        bindTracks();
      }
    }

    renderRecap(fin && S.final ? S.final.recap : null);

    const btn = $('#endBtn');
    btn.hidden = false;
    if (fin) { btn.textContent = 'Revanche'; btn.onclick = () => socket.emit('start'); }
    else {
      const nextStarter = S.players[S.roundNo % N]?.name;
      btn.textContent = 'Manche suivante';
      btn.onclick = () => socket.emit('next');
      $('#endText').textContent += ` ${nextStarter === S.players[S.me]?.name ? 'Tu commences' : nextStarter + ' commence'} la prochaine.`;
    }
    const stop = $('#stopBtn');
    stop.hidden = fin || S.settings.target !== 0;
    armTwoTap(stop, 'Arrêter', 'Sûr ?', () => socket.emit('stop'));
    if (wasHidden) {
      setTimeout(() => btn.focus({ preventScroll: true }), 60);
      if (r.winner === S.me || (fin && w === S.me)) sfx.win(); else sfx.out();
    }
  }

  // Récap de fin de partie
  function renderRecap(rc) {
    const el = $('#endRecap');
    el.hidden = !rc;
    if (!rc) return;
    const key = JSON.stringify(rc);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    if (rc.quiz) {
      el.innerHTML = `<p class="recap-title">Le récap</p><ul class="recap-facts"><li><b>${rc.best}</b><span>meilleure série</span></li><li><b>${rc.rounds}</b><span>${rc.rounds > 1 ? 'manches' : 'manche'}</span></li></ul><ul class="recap-players">${rc.players.map((st, i) => S.players[i] ? `<li class="recap-p p${i}${i === S.me ? ' me' : ''}"><span class="recap-name">${esc(S.players[i].name)}</span><span class="recap-stats">${goodAnswers(st.good)} · ${plural(st.rounds, 'manche')} gagnée${st.rounds > 1 ? 's' : ''}</span></li>` : '').join('')}</ul>`;
      return;
    }
    if (rc.blind) {
      el.innerHTML = `<p class="recap-title">Le récap</p><ul class="recap-players">${rc.players.map((st, i) => {
        const p = S.players[i];
        if (!p) return '';
        const bits = [`${st.found} trouvé${st.found > 1 ? 's' : ''} sur ${st.heard}`];
        if (st.titles) bits.push(`${st.titles} titre${st.titles > 1 ? 's' : ''}`);
        if (st.fast) bits.push(`${st.fast} rapide${st.fast > 1 ? 's' : ''}`);
        if (st.jokers) bits.push(`${st.jokers} joker${st.jokers > 1 ? 's' : ''} joué${st.jokers > 1 ? 's' : ''}`);
        if (st.best != null) bits.push(`record ${(st.best / 1000).toFixed(1).replace('.', ',')} s`);
        if (st.stumped) bits.push(`${st.stumped} colle${st.stumped > 1 ? 's' : ''} posée${st.stumped > 1 ? 's' : ''}`);
        return `<li class="recap-p p${i}${i === S.me ? ' me' : ''}"><span class="recap-name">${esc(p.name)}</span><span class="recap-stats">${bits.join(' · ')}</span></li>`;
      }).join('')}</ul>`;
      return;
    }
    const L = rc.longest;
    const head = `<p class="recap-title">Le récap</p><ul class="recap-facts">`
      + `<li><b>${rc.totalFeats}</b><span>${rc.totalFeats > 1 ? 'feats' : 'feat'} en ${plural(rc.rounds, 'manche')}</span></li>`
      + (L && L.n > 0 ? `<li><b>${L.n}</b><span>plus longue chaîne${rc.rounds > 1 ? `, manche ${L.round}` : ''}${L.start ? `, partie de ${esc(L.start)}` : ''}</span></li>` : '')
      + `</ul>`;
    const cards = rc.players.map((st, i) => {
      const p = S.players[i];
      if (!p) return '';
      const bits = [plural(st.feats, 'feat')];
      if (st.rare) bits.push(`${st.rare} rare${st.rare > 1 ? 's' : ''}`);
      if (st.titles) bits.push(`${st.titles} bon${st.titles > 1 ? 's' : ''} titre${st.titles > 1 ? 's' : ''}`);
      if (st.jokers) bits.push(`${st.jokers} joker${st.jokers > 1 ? 's' : ''} joué${st.jokers > 1 ? 's' : ''}`);
      if (st.relaunches) bits.push(`${st.relaunches} relance${st.relaunches > 1 ? 's' : ''}`);
      if (st.kos) bits.push(`${st.kos} K.O. infligé${st.kos > 1 ? 's' : ''}`);
      const best = st.best ? `<span class="recap-best">Meilleur coup : <b>${esc(st.best.artist)}</b>${st.best.title ? ` avec « ${esc(st.best.title)} »` : ''}${st.best.rare ? ' <span class="tag rare">Rare</span>' : ''}</span>` : '';
      return `<li class="recap-p p${i}${i === S.me ? ' me' : ''}"><span class="recap-name">${esc(p.name)}</span><span class="recap-stats">${bits.join(' · ')}</span>${best}</li>`;
    }).join('');
    el.innerHTML = head + `<ul class="recap-players">${cards}</ul>`;
  }

  // ================= PISTES / AUDIO =================
  // Remplace les noms à cacher par un bloc flouté. Le vrai nom n'est jamais mis dans la page, donc impossible à lire en trichant.
  const nrm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hid = (n) => `<span class="hid" aria-label="artiste masqué">${'x'.repeat(Math.min(Math.max(n, 4), 12))}</span>`;
  // Même découpage que le serveur : les noms crédités dans la partie « feat » du titre.
  const FEAT_GROUP = /[([]\s*(?:feat\.?|ft\.?|featuring|with|avec|w\/)\s+([^)\]]+)[)\]]/gi;
  const FEAT_TAIL = /(?:^|\s)(?:feat\.?|ft\.?|featuring)\s+([^([]+)/i;
  function featCredits(title) {
    title = String(title || '');
    const parts = [];
    let m;
    FEAT_GROUP.lastIndex = 0;
    while ((m = FEAT_GROUP.exec(title))) parts.push(m[1]);
    const rest = title.replace(FEAT_GROUP, ' ');
    if ((m = rest.match(FEAT_TAIL))) parts.push(m[1]);
    return parts.flatMap((p) => p.split(/\s*(?:,|&|\+|\s(?:x|et|and|feat\.?|ft\.?)\s)\s*/i)).map((n) => n.trim()).filter(Boolean);
  }
  // Remplace chaque nom à cacher, seulement en mot entier (jamais « th » au milieu de « Truth »).
  function masked(text, hide) {
    text = String(text || '');
    if (!hide.length) return esc(text);
    const alt = hide.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((x, y) => y.length - x.length).join('|');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${alt})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    let out = '', at = 0;
    text.replace(re, (m, pre, name, off) => {
      const start = off + pre.length;
      out += esc(text.slice(at, start)) + hid(name.length);
      at = start + name.length;
      return m;
    });
    return out + esc(text.slice(at));
  }
  function trackInline(t, hide = []) {
    const label = hide.length ? 'Écouter l’extrait' : `Écouter « ${esc(t.title)} »`;
    const btn = t.preview ? `<button type="button" class="play-btn" data-prev="${esc(t.preview)}" aria-label="${label}">${PLAY}</button>` : '';
    return `<span class="ti">« ${masked(t.title, hide)} »</span>${btn}`;
  }
  function trackCard(t, byAppeal, hide = []) {
    // Pochette floutée tant que des artistes du son sont cachés : on pourrait y lire leur nom.
    const cover = t.cover ? `<img src="${esc(t.cover)}" alt=""${hide.length ? ' class="veiled"' : ''}>` : '<span class="nocover" aria-hidden="true"></span>';
    const names = (t.artists || []).map((n) => (hide.includes(n) ? hid(n.length) : esc(n))).join(', ');
    const sub = byAppeal ? `<span class="badge">${t.added ? 'Feat ajouté' : 'Validé à la main'}</span>` : `<span>${names}</span>`;
    const label = hide.length ? 'Écouter l’extrait' : `Écouter « ${esc(t.title)} »`;
    const btn = t.preview ? `<button type="button" class="play-btn" data-prev="${esc(t.preview)}" aria-label="${label}">${PLAY}</button>` : '';
    // Le lien Deezer montrerait tous les artistes : il n'apparaît qu'une fois la manche finie.
    const title = t.link && !hide.length ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">${esc(t.title)}</a>` : masked(t.title, hide);
    return `<div class="track">${cover}<div class="tt"><b>${title}</b>${sub}</div>${btn}</div>`;
  }
  function bindTracks() {
    document.querySelectorAll('.play-btn').forEach((b) => (b.onclick = () => {
      if (!audio.paused && audio.dataset.src === b.dataset.prev) { audio.pause(); return; }
      playPreview(b.dataset.prev, true);
    }));
    syncPlayButtons();
  }

  const audio = $('#audio');
  audio.volume = 0.6;
  let audioUnlocked = false;
  function unlockAudio() {
    sfx.unlock();
    if (audioUnlocked) return;
    audioUnlocked = true;
    try { audio.muted = true; audio.play().catch(() => {}).finally(() => { audio.pause(); audio.muted = false; }); } catch {}
  }
  // limit : arrêt automatique à cette seconde (blind test : première écoute limitée) ; from : départ plus loin.
  function playPreview(src, force, { limit = 0, from = 0 } = {}) {
    if (!src || (muted && !force)) return;
    if (audio.dataset.src !== src) { audio.src = src; audio.dataset.src = src; }
    audio.dataset.limit = limit ? String(limit) : '';
    const go = () => { try { audio.currentTime = from; } catch {} audio.play().catch(() => {}); };
    if (audio.readyState >= 1) go(); else audio.addEventListener('loadedmetadata', go, { once: true });
    if (audio.readyState < 1) audio.play().catch(() => {});
  }
  audio.addEventListener('timeupdate', () => {
    const lim = Number(audio.dataset.limit || 0);
    if (lim && audio.currentTime >= lim) { audio.pause(); audio.dataset.limit = ''; }
  });
  function syncPlayButtons() {
    document.querySelectorAll('.play-btn').forEach((b) => {
      const on = !audio.paused && audio.dataset.src === b.dataset.prev;
      b.classList.toggle('on', on); b.innerHTML = on ? PAUSE : PLAY;
    });
    const d = document.getElementById('btDisc');
    if (d) { const on = !audio.paused && audio.dataset.src === d.dataset.prev; d.classList.toggle('on', on); d.firstElementChild.innerHTML = on ? PAUSE : PLAY; }
  }
  ['play', 'pause', 'ended'].forEach((ev) => audio.addEventListener(ev, syncPlayButtons));
  // Extrait refusé par le navigateur (lien Deezer expiré) : on demande un lien neuf au serveur.
  audio.addEventListener('error', () => {
    if (S && S.mode === 'blind' && S.round && S.round.step === 'guess' && audio.dataset.src && S.round.track && audio.dataset.src === S.round.track.preview) socket.emit('bt:refresh');
  });
  // Interrupteurs du menu réglages (roue) : aria-pressed = activé.
  function syncMute() {
    $('#muteBtn').setAttribute('aria-pressed', String(!muted));
  }
  syncMute();
  $('#muteBtn').onclick = () => { muted = !muted; store.set('rg_autoplay', muted ? '0' : '1'); if (muted) audio.pause(); syncMute(); };

  // ================= EFFETS SONORES =================
  // Sons synthétisés par le navigateur (aucun fichier à télécharger). Réglage à part de la lecture des extraits.
  const sfx = (() => {
    let ctx = null;
    let on = store.get('rg_sfx', '1') === '1';
    const ac = () => {
      try {
        if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
        if (ctx.state === 'suspended') ctx.resume();
      } catch { return null; }
      return ctx;
    };
    function tone(freq, dur, { type = 'square', vol = 0.06, at = 0, to = null } = {}) {
      const c = on && ac();
      if (!c) return;
      const t0 = c.currentTime + at;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    return {
      get on() { return on; },
      toggle() { on = !on; store.set('rg_sfx', on ? '1' : '0'); if (on) ac(); return on; },
      unlock() { if (on) ac(); },
      tick() { tone(1250, 0.045, { vol: 0.035 }); },
      ding() { tone(880, 0.09, { type: 'triangle', vol: 0.09 }); tone(1320, 0.16, { type: 'triangle', vol: 0.09, at: 0.08 }); },
      buzz() { tone(150, 0.32, { type: 'sawtooth', vol: 0.05 }); },
      out() { tone(420, 0.18, { type: 'sawtooth', vol: 0.05, to: 200 }); tone(210, 0.32, { type: 'sawtooth', vol: 0.05, at: 0.16, to: 90 }); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: 'triangle', vol: 0.08, at: i * 0.1 })); },
      bonus() { [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.09, { type: 'triangle', vol: 0.06, at: i * 0.055 })); },
      pop() { tone(660, 0.06, { type: 'sine', vol: 0.05, to: 990 }); },
      // Gros impact de K.O. : souffle de bruit + coup grave qui descend, puis deux notes de « fin de round ».
      ko() {
        const c = on && ac();
        if (!c) return;
        const len = 0.5, buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
        const n = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 1400; g.gain.value = 0.35;
        n.buffer = buf; n.connect(f).connect(g).connect(c.destination); n.start();
        tone(160, 0.6, { type: 'sine', vol: 0.4, to: 38 });
        tone(330, 0.22, { type: 'square', vol: 0.05, at: 0.55 });
        tone(220, 0.5, { type: 'square', vol: 0.05, at: 0.78, to: 110 });
      },
    };
  })();
  document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
  function syncSfx() {
    $('#sfxBtn').setAttribute('aria-pressed', String(sfx.on));
  }
  // Roue des réglages : petit menu sous la ligne de la manche, fermé en touchant ailleurs.
  const gearMenu = $('#gearMenu'), gearBtn = $('#gearBtn');
  const setGear = (open) => { gearMenu.hidden = !open; gearBtn.setAttribute('aria-expanded', String(open)); gearBtn.classList.toggle('on', open); };
  gearBtn.onclick = (e) => { e.stopPropagation(); setGear(gearMenu.hidden); };
  document.addEventListener('click', (e) => { if (!gearMenu.hidden && !gearMenu.contains(e.target) && e.target !== gearBtn) setGear(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setGear(false); });
  $('#sfxBtn').onclick = () => { sfx.toggle(); syncSfx(); };
  syncSfx();

  // ================= CHRONO =================
  function tickClock() {
    const el = $('#clock'), num = $('#clockNum'), circle = el.querySelector('circle');
    const r = S && S.round;
    const reset = (txt) => { num.textContent = txt; circle.style.strokeDashoffset = 0; el.classList.remove('hot', 'paused'); };
    if (!r || S.phase !== 'playing') return reset('—');
    const total = S.settings.turnSeconds * 1000;
    if (!total) return reset('∞');
    if (r.chain && !r.chain.length) return reset('—');
    if (S.mode === 'blind' && r.step !== 'guess') return reset('—');
    if (r.paused ? r.remaining == null : r.msLeft == null) return reset('—'); // pas de chrono en cours (ex. pause entre deux ponts)
    const left = r.paused ? r.remaining : Math.max(0, r.msLeft - (performance.now() - stateAt));
    const held = r.paused && (r.checking || r.appeal);
    el.classList.toggle('paused', !!held);
    num.textContent = held ? '❚❚' : Math.ceil(left / 1000);
    circle.style.strokeDashoffset = 100 - (left / total) * 100;
    el.classList.toggle('hot', !r.paused && left < 5000);
    // Tic-tac sur les 5 dernières secondes de MON tour.
    const sec = Math.ceil(left / 1000);
    if (!r.paused && r.turn === S.me && sec <= 5 && sec > 0 && sec !== lastTickSec) sfx.tick();
    lastTickSec = r.paused ? null : sec;
  }
  let lastTickSec = null;
  setInterval(tickClock, 200);

  // ================= AUTOCOMPLÉTION =================
  // Liste de suggestions d'artistes.
  // Règles pour que le toucher soit fiable sur téléphone :
  // - la liste ne se redessine JAMAIS pendant qu'un doigt est posé dessus (les nouveaux résultats attendent) ;
  // - on mémorise l'artiste touché au moment où le doigt se pose (par son identité, pas par sa position) ;
  // - le choix se fait au lever du doigt, s'il n'a pas glissé (sinon c'était un défilement) ;
  // - le « clic » fantôme qui suit est bloqué, pour ne pas toucher le bouton qui apparaît dessous.
  let ghostUntil = 0;
  document.addEventListener('click', (e) => { if (Date.now() < ghostUntil) { e.preventDefault(); e.stopPropagation(); } }, true);

  function autocomplete(input, list, onPick) {
    let items = [], sel = -1, timer = null, seq = 0;
    let press = null;        // { artist, x, y, li } pendant qu'un doigt est posé
    let pending = null;      // résultats arrivés pendant l'appui, affichés au lever du doigt
    let chosen = null, lockUntil = 0;
    const used = () => new Set((S?.round?.chain || []).map((l) => l.artist.id));
    const close = () => { list.hidden = true; sel = -1; press = null; pending = null; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
    const draw = () => {
      if (press) return; // jamais sous le doigt
      if (!items.length) { list.innerHTML = '<li class="none">Aucun artiste à ce nom</li>'; list.hidden = false; return; }
      const u = used();
      list.innerHTML = items.map((a, i) => `<li role="option" id="ac-${i}" data-i="${i}" aria-selected="${i === sel}" class="${u.has(a.id) ? 'used' : ''}">${a.picture ? `<img src="${esc(a.picture)}" alt="">` : '<span class="ph"></span>'}<span class="nm">${esc(a.name)}</span>${u.has(a.id) ? '<span class="fans">déjà cité</span>' : `<span class="fans">${fmtFans(a.fans)}</span>`}</li>`).join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (sel >= 0) input.setAttribute('aria-activedescendant', 'ac-' + sel);
    };
    const show = (data) => {
      if (press) { pending = data; return; }
      items = data; sel = items.length ? 0 : -1; draw();
    };

    input.addEventListener('input', () => {
      if (Date.now() < lockUntil) {
        // Le clavier a remis le mot tapé par-dessus le nom choisi : on remet le nom complet, la liste reste fermée.
        if (chosen && input.value !== chosen.name) input.value = chosen.name;
        return;
      }
      chosen = null;
      pickedArtist = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { seq++; return close(); }
      const my = ++seq;
      timer = setTimeout(async () => {
        try {
          const res = await fetch('/api/artists?q=' + encodeURIComponent(q));
          const data = await res.json();
          // Résultat périmé (on a tapé autre chose depuis, ou déjà choisi) : ignoré.
          if (my !== seq || input.value.trim() !== q || Date.now() < lockUntil) return;
          show(Array.isArray(data) ? data : []);
        } catch { if (my === seq) close(); }
      }, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0 && items[sel]) { e.preventDefault(); choose(items[sel]); }
      else if (e.key === 'Escape') close();
    });

    list.addEventListener('pointerdown', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      e.preventDefault(); // garde le champ actif : la liste ne se ferme pas pendant l'appui
      press = { artist: items[Number(li.dataset.i)], x: e.clientX, y: e.clientY, li };
      li.classList.add('pressed');
    });
    list.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) release(false); // c'est un défilement
    });
    list.addEventListener('pointerup', () => release(true));
    list.addEventListener('pointercancel', () => release(false));
    list.addEventListener('pointerleave', () => { if (press) release(false); });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    function release(pick) {
      if (!press) return;
      const p = press;
      press = null;
      p.li.classList.remove('pressed');
      if (pick && p.artist) { ghostUntil = Date.now() + 350; return choose(p.artist); }
      if (pending) { const d = pending; pending = null; show(d); }
    }
    input.addEventListener('blur', () => setTimeout(() => { if (!press) close(); }, 200));

    function choose(a) {
      if (!a) return;
      clearTimeout(timer); seq++;          // annule toute recherche en attente ou en cours
      chosen = a; lockUntil = Date.now() + 700;
      close();
      input.blur();                         // termine la saisie du clavier (fin de mot, correction auto)
      input.value = a.name;
      setTimeout(() => { input.value = a.name; close(); onPick(a); }, 80);
    }
  }
  const fmtFans = (n) => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '').replace('.', ',') + ' M fans' : n >= 1e3 ? Math.round(n / 1e3) + ' k fans' : n + ' fans';

  autocomplete($('#artistInput'), $('#acList'), (a) => {
    pickedArtist = a;
    // Au départ (ou artiste à faire deviner au blind test), pas de titre à donner : on valide directement.
    if (S?.mode === 'blind' ? S.round?.step === 'propose' : S?.round?.chain.length === 0) $('#playForm').requestSubmit();
    else $('#songInput').focus();
  });

  $('#playForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let a = pickedArtist;
    const typed = $('#artistInput').value.trim();
    if (!typed) return $('#artistInput').focus();
    if (!a || a.name.toLowerCase() !== typed.toLowerCase()) {
      // Pas choisi dans la liste : on prend le résultat Deezer le plus proche.
      try {
        const res = await fetch('/api/artists?q=' + encodeURIComponent(typed));
        const data = await res.json();
        a = data.find((x) => x.name.toLowerCase() === typed.toLowerCase()) || data[0];
      } catch {}
      if (!a) return toast(`Aucun artiste « ${typed} »`);
    }
    $('#acList').hidden = true;
    socket.emit('answer', { artist: a, song: $('#songInput').value.trim() });
  });

  // Confirmation en deux appuis, sans fenêtre système.
  function armTwoTap(btn, label, confirmLabel, action) {
    btn.textContent = label; btn.classList.remove('confirm'); clearTimeout(btn._t);
    btn.onclick = () => {
      if (btn.classList.contains('confirm')) { clearTimeout(btn._t); btn.classList.remove('confirm'); action(); return; }
      btn.classList.add('confirm'); btn.textContent = confirmLabel;
      btn._t = setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = label; }, 3000);
    };
  }
  let giveupArmedFor = null;
  function resetGiveUp() {
    const key = lastTurnKey;
    if (giveupArmedFor === key) return;
    giveupArmedFor = key;
    armTwoTap($('#giveupBtn'), 'Je sèche', 'Sûr ?', () => socket.emit('giveup'));
  }

  $('#randomBtn').onclick = () => socket.emit('randomStart');

  // ================= RÉACTIONS =================
  // 5 emojis visibles chez tout le monde ; une réaction toutes les 2 s par joueur (aussi limité côté serveur).
  let reactLock = false;
  document.querySelectorAll('.reacts button').forEach((b) => (b.onclick = () => {
    if (reactLock) return;
    reactLock = true;
    document.querySelectorAll('.reacts').forEach((el) => el.classList.add('cool'));
    setTimeout(() => { reactLock = false; document.querySelectorAll('.reacts').forEach((el) => el.classList.remove('cool')); }, 2000);
    socket.emit('react', { e: b.dataset.e });
  }));
  socket.on('reaction', ({ who, e }) => {
    if (!S || !S.players[who]) return;
    const el = document.createElement('div');
    el.className = `float p${who}`;
    el.innerHTML = `<span class="e">${esc(e)}</span><span class="n">${esc(who === S.me ? 'Toi' : S.players[who].name)}</span>`;
    el.style.left = `${12 + Math.random() * 70}%`;
    document.body.appendChild(el);
    sfx.pop();
    setTimeout(() => el.remove(), 3500);
  });
  $('#jokerBtn').onclick = () => socket.emit('joker');
  $('#judgeYes').onclick = () => socket.emit('judge', { ok: true });
  $('#judgeNo').onclick = () => socket.emit('judge', { ok: false });

  // ================= MASCOTTE ET CONFETTIS =================
  // Le raptor de la feuille de fin change d'humeur : lunettes de soleil si tu gagnes, larme si tu perds.
  // Victoire : pluie de confettis vert et jaune (canvas-confetti).
  const sheetEl = $('#endSheet');
  let sheetWas = '';
  new MutationObserver(() => {
    const open = !sheetEl.hidden, win = sheetEl.classList.contains('win');
    const rex = sheetEl.querySelector('.sheet-raptor');
    const src = win ? '/rex-win.webp' : '/rex-sad.webp';
    if (rex && !rex.src.endsWith(src)) rex.src = src;
    const key = open ? (win ? 'win' : 'lose') + (S ? S.roundNo + '-' + S.phase : '') : '';
    if (open && win && key !== sheetWas && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      loadConfetti().then(() => {
        if (!window.confetti) return;
        const colors = ['#ffd21f', '#43b85c', '#f3f7e6', '#2fae4f'];
        confetti({ particleCount: 90, spread: 75, origin: { y: 0.75 }, colors, disableForReducedMotion: true });
        setTimeout(() => confetti({ particleCount: 50, angle: 60, spread: 60, origin: { x: 0, y: 0.8 }, colors }), 250);
        setTimeout(() => confetti({ particleCount: 50, angle: 120, spread: 60, origin: { x: 1, y: 0.8 }, colors }), 400);
      });
    }
    sheetWas = key;
  }).observe(sheetEl, { attributes: true, attributeFilter: ['hidden', 'class'] });

  // ================= TOAST =================
  let toastT;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
  }
  socket.on('connect', () => { if (S) $('#toast').hidden = true; });

  // ================= MISE À JOUR AUTOMATIQUE =================
  // Si le site a été mis à jour depuis l'ouverture de la page, on recharge pour avoir la nouvelle version.
  const meta = document.querySelector('meta[name="app-version"]');
  const MY_VERSION = meta ? meta.content : null;
  function checkVersion(v) {
    if (!MY_VERSION || !v || v === MY_VERSION) { try { sessionStorage.removeItem('rg_reload'); } catch {} return; }
    // Garde-fou : une seule tentative par minute pour ne jamais boucler.
    let lastTry = 0; try { lastTry = Number(sessionStorage.getItem('rg_reload')) || 0; } catch {}
    if (Date.now() - lastTry < 60000) return;
    try { sessionStorage.setItem('rg_reload', String(Date.now())); } catch {}
    location.reload();
  }
  socket.on('version', checkVersion);
  const recheck = () => fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).then((d) => checkVersion(d.version)).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) recheck(); });

  if (ownRoom && store.get('rg_name')) socket.emit('join', { token, code: inviteCode, name: null });
  render();
})();

// Boutons en blocs (gros boutons, puces de réglage, +/−) : trois éclats placés au hasard sur chaque bouton (toujours les mêmes pour un même bouton,
// pour qu'ils ne bougent pas quand l'écran se redessine).
(function chips() {
  const B = 'calc(100% + var(--depth))';
  const SEL = '.btn, .chip, .step';
  const hash = (str) => { let h = 2166136261; for (const c of str) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  // Toutes les combinaisons de 2 ou 3 éclats (au moins une encoche) : les boutons voisins en prennent chacun
  // une différente, pour qu'aucun ne ressemble à son voisin.
  const KINDS = ['top', 'left', 'right', 'tl', 'tr', 'br', 'bl'];
  const NOTCH = ['top', 'left', 'right'];
  const COMBOS = [];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b; c < 7; c++) {
    const set = c === b ? [KINDS[a], KINDS[b]] : [KINDS[a], KINDS[b], KINDS[c]];
    const notches = set.filter((k) => NOTCH.includes(k)).length;
    if (notches >= 1 && notches <= 2) COMBOS.push(set);
  }
  const shape = (seed, combo, small) => {
    let h = hash(seed);
    const r = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
    const n = (a, b) => Math.round(a + r() * (b - a));
    const pick = new Set(combo);
    const notch = () => (small ? { at: n(12, 68), d: n(3, 4), w: n(7, 9) } : { at: n(8, 78), d: n(4, 5), w: n(9, 12) });
    const corner = () => (small ? n(4, 5) : n(6, 8)); // coins écornés : assez grands pour se voir
    const p = [];
    if (pick.has('tl')) { const c = corner(); p.push(`0 ${c}px`, `${c}px 0`); } else p.push('0 0');
    if (pick.has('top')) { const k = notch(); p.push(`${k.at}% 0`, `calc(${k.at}% + ${k.w / 2}px) ${k.d}px`, `calc(${k.at}% + ${k.w}px) 0`); }
    if (pick.has('tr')) { const c = corner(); p.push(`calc(100% - ${c}px) 0`, `100% ${c}px`); } else p.push('100% 0');
    if (pick.has('right')) { const k = notch(); const y = Math.round(k.at * 0.6); p.push(`100% ${y}%`, `calc(100% - ${k.d}px) calc(${y}% + ${k.w / 2}px)`, `100% calc(${y}% + ${k.w}px)`); }
    if (pick.has('br')) { const c = corner(); p.push(`100% calc(${B} - ${c}px)`, `calc(100% - ${c}px) ${B}`); } else p.push(`100% ${B}`);
    if (pick.has('bl')) { const c = corner(); p.push(`${c}px ${B}`, `0 calc(${B} - ${c}px)`); } else p.push(`0 ${B}`);
    if (pick.has('left')) { const k = notch(); const y = Math.round(k.at * 0.6); p.push(`0 calc(${y}% + ${k.w}px)`, `${k.d}px calc(${y}% + ${k.w / 2}px)`, `0 ${y}%`); }
    return `polygon(${p.join(', ')})`;
  };
  const label = (b) => b.id || b.className.split(' ')[0] + '|' + (b.dataset.v ?? b.textContent.trim());
  const apply = () => {
    for (const b of document.querySelectorAll('.btn:not([data-chip]), .chip:not([data-chip]), .step:not([data-chip])')) {
      // Rang du bouton parmi ses voisins (même conteneur) : combinaisons consécutives = toutes différentes.
      const parent = b.parentElement;
      const sibs = parent ? [...parent.children].filter((x) => x.matches(SEL)) : [b];
      const idx = Math.max(0, sibs.indexOf(b));
      const base = hash((parent && (parent.id || parent.className)) + '|' + sibs.length);
      const combo = COMBOS[(base + idx * 13) % COMBOS.length];
      b.dataset.chip = '1';
      b.style.setProperty('--chip', shape(label(b) + '#' + idx, combo, !b.classList.contains('btn')));
    }
  };
  apply();
  new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
})();
