(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

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

  const ownRoom = inviteCode && inviteCode === roomCode;
  if (inviteCode && !ownRoom) {
    $('#homeBtn').textContent = 'Rejoindre';
    $('#soloBtn').hidden = true;
    $('#invited').hidden = false;
    $('#invited').textContent = 'Tu as été invité à une partie.';
    fetch('/api/room/' + encodeURIComponent(inviteCode)).then((r) => r.json()).then((info) => {
      if (!info.exists) {
        $('#invited').textContent = 'Ce lien ne mène plus à aucune partie. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#soloBtn').hidden = false;
        $('#homeBtn').textContent = 'Créer une partie';
        history.replaceState(null, '', '/');
      } else if (info.started) {
        $('#invited').textContent = 'Cette partie a déjà commencé. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#soloBtn').hidden = false;
        $('#homeBtn').textContent = 'Créer une partie';
      } else if (info.full) {
        $('#invited').textContent = 'Cette partie est déjà complète. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#soloBtn').hidden = false;
        $('#homeBtn').textContent = 'Créer une partie';
      } else if (info.host) {
        $('#invited').innerHTML = `<b>${esc(info.host)}</b> t'invite à une partie.`;
      }
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
    else socket.emit('create', { token, name });
  });

  // Mode solo : une partie contre le bot, sans invitation.
  $('#soloBtn').addEventListener('click', () => {
    const name = $('#nameInput').value.trim() || 'Joueur';
    store.set('rg_name', name);
    unlockAudio();
    $('#soloBtn').disabled = true;
    setTimeout(() => ($('#soloBtn').disabled = false), 4000);
    socket.emit('create', { token, name, solo: true });
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
    $('#homeBtn').disabled = true; $('#soloBtn').disabled = true;
  }
  function hideWake() {
    clearInterval(wakeTimer); wakeTimer = null;
    $('#wake').hidden = true;
    $('#homeBtn').disabled = false; $('#soloBtn').disabled = false;
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

  document.querySelectorAll('[data-leave]').forEach((b) => b.addEventListener('click', () => {
    store.set('rg_room', '');
    location.href = '/';
  }));

  // ================= ÉTAT =================
  socket.on('state', (st) => {
    S = st;
    stateAt = performance.now();
    roomCode = st.code;
    store.set('rg_room', st.code);
    if (!location.pathname.startsWith('/r/' + st.code)) history.replaceState(null, '', '/r/' + st.code);
    inviteCode = st.code;
    render();
  });

  socket.on('link', ({ track }) => { if (track && track.preview) playPreview(track.preview); });

  function show(id) {
    for (const s of ['home', 'lobby', 'game']) $('#' + s).hidden = s !== id;
  }

  function render() {
    if (!S) return show('home');
    if (S.phase === 'lobby') {
      show('lobby'); $('#endSheet').hidden = true; document.body.classList.remove('sheet-open');
      document.title = 'Roland Gamos';
      return renderLobby();
    }
    show('game');
    renderGame();
  }

  // ================= SALON =================
  const TIMERS = [0, 10, 15, 20, 30, 45, 60];
  const LEVELS = [['easy', 'Facile'], ['normal', 'Normal'], ['hard', 'Difficile']];
  const levelName = (v) => (LEVELS.find((l) => l[0] === v) || LEVELS[1])[1];

  function renderLobby() {
    const isHost = S.me === S.host;
    const N = S.players.length, max = S.maxPlayers || 2;
    const ready = N >= 2;
    const url = `${location.origin}/r/${S.code}`;
    $('#lobbyCode').textContent = S.code;
    $('#inviteUrl').textContent = url.replace(/^https?:\/\//, '');

    // Une fois l'adversaire arrivé, l'invitation passe au second plan.
    $('#invite').classList.toggle('done', ready);
    $('#invite').hidden = !!S.solo;
    // L'invitation reste disponible tant qu'il reste des places (jusqu'à 8 joueurs).
    const full = N >= max;
    $('#lobbyTitle').textContent = ready ? (N === 2 ? 'Vous êtes deux' : `Vous êtes ${N}`) : isHost ? 'Invite tes potes' : 'En attente';
    $('#shareBtn').hidden = full || !isHost;
    $('#copyBtn').hidden = full || !isHost;
    $('#inviteUrl').hidden = full || !isHost;
    $('#shareBtn').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: 'Roland Gamos', text: 'Viens jouer au Roland Gamos contre moi', url }); return; } catch {} }
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
    $('#settingsSummary').innerHTML = `${S.settings.turnSeconds ? `<b>${S.settings.turnSeconds} s</b> par tour` : '<b>Sans chrono</b>'}, ${t ? `premier à <b>${plural(t, 'manche')}</b>` : '<b>manches sans limite</b>'}. ${esc(S.players[S.host]?.name || 'L’hôte')} règle la partie.`;
    document.querySelectorAll('#settings .set').forEach((el) => (el.hidden = !isHost));
    $('#levelSet').hidden = !isHost || !S.solo;
    if (S.solo && isHost) {
      const el = $('#levelChips');
      el.innerHTML = LEVELS.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === S.settings.botLevel}" class="chip ${v === S.settings.botLevel ? 'on' : ''}" data-v="${v}">${l}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => (b.onclick = () => socket.emit('settings', { botLevel: b.dataset.v })));
    }

    if (isHost) {
      const el = $('#timerChips');
      el.innerHTML = TIMERS.map((v) => `<button type="button" role="radio" aria-checked="${v === S.settings.turnSeconds}" class="chip ${v === S.settings.turnSeconds ? 'on' : ''}" data-v="${v}">${v ? v + ' s' : 'Aucun'}</button>`).join('');
      el.querySelectorAll('button').forEach((b) => (b.onclick = () => socket.emit('settings', { turnSeconds: Number(b.dataset.v) })));

      $('#stepper').classList.toggle('off', t === 0);
      $('#targetOut').textContent = t ? plural(t, 'manche') : '—';
      $('#targetMinus').disabled = t <= 1;
      $('#targetPlus').disabled = t >= 10;
      $('#targetMinus').onclick = () => socket.emit('settings', { target: Math.max(1, (t || 3) - (t ? 1 : 0)) });
      $('#targetPlus').onclick = () => socket.emit('settings', { target: Math.min(10, (t || 2) + 1) });
      $('#targetInf').classList.toggle('on', t === 0);
      $('#targetInf').setAttribute('aria-pressed', String(t === 0));
      $('#targetInf').onclick = () => socket.emit('settings', { target: t === 0 ? 3 : 0 });
      $('#targetHint').textContent = t === 0 ? (S.solo ? 'On enchaîne les manches et tu arrêtes quand tu veux.' : 'On enchaîne les manches et on arrête quand on veut.') : t === 1 ? 'Mort subite : une seule manche.' : `Le premier à ${t} manches gagne.`;
    }

    $('#startBtn').hidden = !isHost;
    $('#startBtn').disabled = !ready;
    $('#startBtn').onclick = () => { unlockAudio(); socket.emit('start'); };
    $('#lobbyWait').textContent = !ready
      ? (isHost ? 'Tu pourras lancer dès qu’un autre joueur aura rejoint.' : '')
      : isHost ? (S.solo || full ? '' : `Jusqu’à ${max} joueurs. Lance quand tout le monde est là.`) : `${S.players[S.host].name} va lancer la partie.`;
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
    sb.classList.toggle('multi', n > 2);
    sb.innerHTML = n <= 2
      ? [0, 1].map((i) => `<div class="side" data-p="${i}"><span class="pinfo"><span class="pname"></span><span class="pj"></span></span><span class="pscore"></span></div>`).join(CLOCK)
      : `${CLOCK}<ol class="roster">${Array.from({ length: n }, (_, i) => `<li class="pl p${i}" data-p="${i}"><span class="pinfo"><span class="pname"></span><span class="pj"></span></span><span class="pscore"></span></li>`).join('')}</ol>`;
  }

  function renderGame() {
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
    $('#roundLabel').textContent = S.settings.target ? `Manche ${S.roundNo}, premier à ${S.settings.target}` : `Manche ${S.roundNo}, sans limite`;
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
    if (redraw) {
      const proof = $('#proof');
      // Le son qui prouve le feat est déjà affiché dans la chaîne : pas de doublon sous l'artiste.
      if (last && last.track) {
        proof.hidden = true;
      } else if (last) {
        proof.hidden = false;
        proof.textContent = last.random ? `Tiré au hasard pour ${S.players[last.by]?.name || ''}` : `Choisi par ${S.players[last.by]?.name || ''} pour lancer la chaîne`;
      } else proof.hidden = true;
    }

    // --- À qui de jouer ---
    const banner = $('#turnBanner');
    banner.hidden = !playing;
    banner.className = 'turn ' + (myTurn ? 'me' : 'them');
    banner.innerHTML = choosing
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
    document.title = !playing ? 'Roland Gamos' : myTurn ? '● À toi | Roland Gamos' : `${turnName} joue | Roland Gamos`;

    // --- Formulaire du joueur actif ---
    $('#playForm').hidden = !myTurn;
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
    $('#watch').hidden = myTurn || !playing;
    if (!myTurn && playing) {
      let txt = `<span class="dots">${choosing ? 'Choix en cours' : 'Recherche en cours'}</span>`;
      if (r.checking && r.checking.random) txt = `<span class="spin"></span>${esc(turnName)} tire un rappeur au hasard.`;
      else if (r.checking && r.checking.joker) txt = `<span class="spin"></span>${esc(turnName)} utilise un joker 🃏`;
      else if (r.checking && r.checking.verifying) txt = `<span class="spin"></span>On vérifie qu'il reste des feats avec ${esc(r.checking.artist.name)}…`;
      else if (r.checking) txt = `<span class="spin"></span>${esc(turnName)} propose <b>${esc(r.checking.artist.name)}</b>${r.checking.song ? `, « ${esc(r.checking.song)} »` : ''}. Deezer vérifie.`;
      else if (r.appeal) txt = `${esc(turnName)} te demande de valider un feat.`;
      const triesTxt = r.tries ? ` Essai ${r.tries} sur ${r.maxTries || 3} raté.` : '';
      if (!r.checking && !r.appeal && r.lastError) txt = r.lastError.why === 'used'
        ? `${esc(turnName)} a proposé <b>${esc(r.lastError.artist.name)}</b>, déjà cité.${triesTxt} <span class="dots">Il cherche encore</span>`
        : r.lastError.why === 'random' ? `<span class="dots">${esc(turnName)} choisit l’artiste de départ</span>`
        : `Deezer ne trouve pas de son avec <b>${esc(cur ? cur.name : '')}</b> et <b>${esc(r.lastError.artist.name)}</b>${r.lastError.song ? ` (« ${esc(r.lastError.song)} »)` : ''}.${triesTxt} Si ce feat existe, tu peux le valider.`;
      const grantable = !r.checking && !r.appeal && r.lastError && ['notfound', 'api', 'refused'].includes(r.lastError.why);
      const p = S.players[r.turn];
      if (p && !p.online) txt = `${esc(turnName)} s'est déconnecté. La partie reprend dès son retour.`;
      if (outSet.has(S.me)) txt = `<b>Tu es éliminé de cette manche.</b> ` + txt;
      $('#watch').innerHTML = txt + (grantable ? `<button type="button" class="btn small-btn" id="grantBtn">Valider ce feat</button>` : '');
      if (grantable) armTwoTap($('#grantBtn'), 'Valider ce feat', 'Sûr ?', () => socket.emit('grant'));
    }

    // --- Arbitrage ---
    const judging = playing && r.appeal && r.turn !== S.me;
    const jo = $('#judgeOverlay');
    if (judging && jo.hidden) setTimeout(() => $('#judgeYes').focus(), 50);
    jo.hidden = !judging;
    if (judging) $('#judgeText').innerHTML = `${esc(cur.name)} <em>×</em> ${esc(r.appeal.artist.name)}${r.appeal.song ? `<span class="small">« ${esc(r.appeal.song)} »</span>` : ''}`;

    // --- Chaîne, la plus récente en haut ---
    if (redraw) {
      const n = Math.max(0, r.chain.length - 1);
      $('#chainTitle').textContent = r.chain.length ? `La chaîne, ${plural(n, 'feat')}` : 'La chaîne';
      $('#chain').innerHTML = r.chain.length ? r.chain.map((l, i) => {
        const who = esc(S.players[l.by]?.name || '');
        const badges = (l.rare ? ' <span class="tag rare" title="Feat rare">Rare</span>' : '') + (l.joker ? ' <span class="tag">Joker</span>' : '') + (l.relaunch ? ' <span class="tag">Relance</span>' : '');
        const detail = (i === 0 ? `<span class="by">lancé par ${who}</span>` : `<span class="by">${who}</span>`) + badges;
        return `<li class="p${l.by}${i === 0 ? ' origin' : ''}"><div class="a">${esc(l.artist.name)} ${detail}</div>${l.track ? trackCard(l.track, l.byAppeal, others(l.track)) : ''}</li>`;
      }).reverse().join('') : `<li class="empty">Les feats validés s'affichent ici.</li>`;
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

  function renderFeedback(r, cur, opp, oppTo) {
    const fb = $('#feedback');
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
      fb.innerHTML = `<span class="spin"></span>Deezer cherche un son avec ${esc(cur.name)} et ${esc(r.checking.artist.name)}. Chrono en pause.`;
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
      random: 'Le tirage n’a pas marché : Deezer ne répond pas. Réessaie ou tape un artiste.',
      joker: `Le joker n’a trouvé aucun rappeur pour ${esc(cur ? cur.name : '')}. Ton joker est conservé.`,
      notfound: `Deezer ne trouve aucun son avec <b>${esc(cur ? cur.name : '')}</b> et <b>${esc(e.artist.name)}</b>${e.song ? ` sous le titre « ${esc(e.song)} »` : ''}. Si le feat existe, demande ${esc(oppTo)} de le valider. Sinon, propose quelqu'un d'autre.`,
      refused: `<b>${esc(e.artist.name)}</b> a été refusé. Propose un autre artiste.`,
      api: `Deezer ne répond pas. Réessaie dans un instant ou demande ${esc(oppTo)} de valider.`,
    }[e.why] || 'Ce feat ne passe pas.';
    const canAppeal = e.why === 'notfound' || e.why === 'api';
    const max = r.maxTries || 3, left = max - (r.tries || 0);
    const triesMsg = e.why === 'api' || e.why === 'random' || e.why === 'joker' ? ''
      : left <= 0 ? ''
      : ` Encore ${left} essai${left > 1 ? 's' : ''}.`;
    const body = left <= 0 && e.why === 'notfound'
      ? `Deezer ne trouve aucun son avec <b>${esc(cur ? cur.name : '')}</b> et <b>${esc(e.artist.name)}</b>. <b>Plus d'essais</b> : demande ${esc(oppTo)} de valider ce feat, ou sèche.`
      : msg + triesMsg;
    fb.innerHTML = `<p>${body}</p>` + (canAppeal ? `<button type="button" class="btn ghost small-btn" id="appealBtn">Demander ${esc(oppTo)}</button>` : '');
    if (canAppeal) $('#appealBtn').onclick = () => socket.emit('appeal');
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

  function renderEnd(r, cur) {
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
        ex.innerHTML = `<p>Il y avait par exemple :</p><ul>${r.examples.map((e) => `<li><div class="ex-txt"><b>${esc(e.artist.name)}</b><span>« ${esc(e.track.title)} »</span></div>${e.track.preview ? `<button type="button" class="play-btn" data-prev="${esc(e.track.preview)}" aria-label="Écouter « ${esc(e.track.title)} »">▶</button>` : ''}</li>`).join('')}</ul>`;
        bindTracks();
      }
    }

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
    const btn = t.preview ? `<button type="button" class="play-btn" data-prev="${esc(t.preview)}" aria-label="${label}">▶</button>` : '';
    return `<span class="ti">« ${masked(t.title, hide)} »</span>${btn}`;
  }
  function trackCard(t, byAppeal, hide = []) {
    const cover = t.cover ? `<img src="${esc(t.cover)}" alt="">` : '<span class="nocover" aria-hidden="true"></span>';
    const names = (t.artists || []).map((n) => (hide.includes(n) ? hid(n.length) : esc(n))).join(', ');
    const sub = byAppeal ? '<span class="badge">Validé à la main</span>' : `<span>${names}</span>`;
    const label = hide.length ? 'Écouter l’extrait' : `Écouter « ${esc(t.title)} »`;
    const btn = t.preview ? `<button type="button" class="play-btn" data-prev="${esc(t.preview)}" aria-label="${label}">▶</button>` : '';
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
  function playPreview(src, force) {
    if (!src || (muted && !force)) return;
    audio.src = src; audio.dataset.src = src; audio.currentTime = 0;
    audio.play().catch(() => {});
  }
  function syncPlayButtons() {
    document.querySelectorAll('.play-btn').forEach((b) => {
      const on = !audio.paused && audio.dataset.src === b.dataset.prev;
      b.classList.toggle('on', on); b.textContent = on ? '❚❚' : '▶';
    });
  }
  ['play', 'pause', 'ended'].forEach((ev) => audio.addEventListener(ev, syncPlayButtons));
  function syncMute() {
    $('#muteBtn').textContent = muted ? 'Lecture auto : non' : 'Lecture auto : oui';
    $('#muteBtn').setAttribute('aria-pressed', String(muted));
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
    $('#sfxBtn').textContent = sfx.on ? 'Effets : oui' : 'Effets : non';
    $('#sfxBtn').setAttribute('aria-pressed', String(sfx.on));
  }
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
    if (!r.chain.length) return reset('—');
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
  function autocomplete(input, list, onPick) {
    let items = [], sel = -1, timer, seq = 0;
    // Juste après un choix, on ignore ce que le clavier renvoie (fin de saisie, correction auto) pendant un court instant.
    let chosen = null, lockUntil = 0;
    const close = () => { list.hidden = true; sel = -1; input.setAttribute('aria-expanded', 'false'); };
    const draw = () => {
      if (!items.length) { list.innerHTML = '<li class="none">Aucun artiste à ce nom sur Deezer</li>'; list.hidden = false; return; }
      const used = new Set((S?.round?.chain || []).map((l) => l.artist.id));
      list.innerHTML = items.map((a, i) => `<li role="option" id="ac-${i}" data-i="${i}" aria-selected="${i === sel}" class="${used.has(a.id) ? 'used' : ''}">${a.picture ? `<img src="${esc(a.picture)}" alt="">` : '<span class="ph"></span>'}<span class="nm">${esc(a.name)}</span>${used.has(a.id) ? '<span class="fans">déjà cité</span>' : `<span class="fans">${fmtFans(a.fans)}</span>`}</li>`).join('');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (sel >= 0) input.setAttribute('aria-activedescendant', 'ac-' + sel);
    };
    input.addEventListener('input', () => {
      if (Date.now() < lockUntil) {
        // Le clavier a remis le mot tapé par-dessus le nom choisi : on remet le nom complet, et la liste reste fermée.
        if (chosen && input.value !== chosen.name) input.value = chosen.name;
        return;
      }
      chosen = null;
      pickedArtist = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const res = await fetch('/api/artists?q=' + encodeURIComponent(q));
          const data = await res.json();
          if (my !== seq) return;
          items = Array.isArray(data) ? data : []; sel = items.length ? 0 : -1; draw();
        } catch { close(); }
      }, 200);
    });
    input.addEventListener('keydown', (e) => {
      if (list.hidden) return;
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0 && items[sel]) { e.preventDefault(); choose(items[sel]); }
      else if (e.key === 'Escape') close();
    });
    // Sélection au doigt ou à la souris.
    // - On garde le champ actif pendant l'appui (sinon la liste se ferme avant que le choix soit pris en compte).
    // - Le choix se fait au « clic », quand la liste est encore affichée : le toucher ne retombe pas sur le bouton en dessous.
    let pressing = false;
    list.addEventListener('pointerdown', (e) => { if (e.target.closest('li[data-i]')) { e.preventDefault(); pressing = true; } });
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      pressing = false;
      if (li) { e.preventDefault(); choose(items[Number(li.dataset.i)]); }
    });
    input.addEventListener('blur', () => setTimeout(() => { if (!pressing) close(); }, 200));
    function choose(a) {
      if (!a) return;
      // Annule toute recherche en attente : elle rouvrirait la liste juste après.
      clearTimeout(timer); seq++;
      chosen = a; lockUntil = Date.now() + 700;
      close();
      input.blur(); // termine la saisie du clavier (fin de mot, correction auto)
      input.value = a.name;
      // Certains claviers repassent après coup : on réécrit le nom complet une fois la saisie bien terminée.
      setTimeout(() => { input.value = a.name; close(); onPick(a); }, 80);
    }
  }
  const fmtFans = (n) => !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '').replace('.', ',') + ' M fans' : n >= 1e3 ? Math.round(n / 1e3) + ' k fans' : n + ' fans';

  autocomplete($('#artistInput'), $('#acList'), (a) => {
    pickedArtist = a;
    // Au départ, pas de titre à donner : on valide directement.
    if (S?.round?.chain.length === 0) $('#playForm').requestSubmit();
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
      if (!a) return toast(`Aucun artiste « ${typed} » sur Deezer`);
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
  if (meta) $('#version').textContent = `Version ${MY_VERSION}, mise à jour le ${new Date(meta.dataset.updated).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
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
