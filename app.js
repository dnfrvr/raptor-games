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
  let muted = store.get('rg_mute') === '1';
  let pickedArtist = null;
  let lastChainLen = -1;
  let lastRoundId = null;
  let lastErrKey = '';
  let lastTurnKey = '';

  const socket = io({ transports: ['websocket', 'polling'] });

  // ================= ACCUEIL =================
  const TICKER = ['Ninho', 'Jul', 'SCH', 'Gims', 'Damso', 'Drake', 'Rihanna', 'Niska', 'Booba', 'Aya Nakamura', 'Tiakola', 'Kanye West'];
  $('#ticker').innerHTML = [...TICKER, ...TICKER].map((w) => `<span>${esc(w)}</span><span class="ft">feat.</span>`).join('');

  $('#nameInput').value = store.get('rg_name', '');

  const ownRoom = inviteCode && inviteCode === roomCode;
  if (inviteCode && !ownRoom) {
    $('#homeBtn').textContent = 'Rejoindre';
    $('#invited').hidden = false;
    $('#invited').textContent = 'Tu as été invité à une partie.';
    fetch('/api/room/' + encodeURIComponent(inviteCode)).then((r) => r.json()).then((info) => {
      if (!info.exists) {
        $('#invited').textContent = 'Ce lien ne mène plus à aucune partie. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
        $('#homeBtn').textContent = 'Créer une partie';
        history.replaceState(null, '', '/');
      } else if (info.full) {
        $('#invited').textContent = 'Cette partie est déjà complète. Tu peux en créer une nouvelle.';
        $('#invited').classList.add('warn');
        inviteCode = '';
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

  socket.on('connect', () => {
    // Reconnexion automatique (rechargement, réseau mobile qui saute…)
    const code = S?.code || (ownRoom ? roomCode : null);
    if (code) socket.emit('join', { token, code, name: null });
  });
  socket.on('disconnect', () => { if (S) toast('Connexion perdue, reconnexion…', 6000); });

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

  function renderLobby() {
    const isHost = S.me === S.host;
    const ready = S.players.length === 2;
    const url = `${location.origin}/r/${S.code}`;
    $('#lobbyCode').textContent = S.code;
    $('#inviteUrl').textContent = url.replace(/^https?:\/\//, '');

    // Une fois l'adversaire arrivé, l'invitation passe au second plan.
    $('#invite').classList.toggle('done', ready);
    $('#lobbyTitle').textContent = ready ? 'Vous êtes deux' : isHost ? 'Invite ton adversaire' : 'En attente';
    $('#shareBtn').hidden = ready || !isHost;
    $('#copyBtn').hidden = ready || !isHost;
    $('#inviteUrl').hidden = ready || !isHost;
    $('#shareBtn').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: 'Roland Gamos', text: 'Viens jouer au Roland Gamos contre moi', url }); return; } catch {} }
      copy(url);
    };
    $('#copyBtn').onclick = () => copy(url);

    $('#seats').innerHTML = [0, 1].map((i) => {
      const p = S.players[i];
      if (!p) return `<li class="seat empty"><span class="t">Joueur 2</span><span class="n">Pas encore là</span></li>`;
      const tags = [i === S.me ? 'Toi' : i === S.host ? 'Hôte' : 'Invité'];
      if (!p.online) tags.push('hors ligne');
      return `<li class="seat p${i}"><span class="t">${tags.join(', ')}</span><span class="n">${esc(p.name)}</span></li>`;
    }).join('');

    const t = S.settings.target;
    // L'hôte règle ; l'invité voit un résumé lisible plutôt que des boutons grisés.
    $('#settings').classList.toggle('readonly', !isHost);
    $('#settingsSummary').hidden = isHost;
    $('#settingsSummary').innerHTML = `${S.settings.turnSeconds ? `<b>${S.settings.turnSeconds} s</b> par tour` : '<b>Sans chrono</b>'}, ${t ? `premier à <b>${plural(t, 'manche')}</b>` : '<b>manches sans limite</b>'}. ${esc(S.players[S.host]?.name || 'L’hôte')} règle la partie.`;
    document.querySelectorAll('#settings .set').forEach((el) => (el.hidden = !isHost));

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
      $('#targetHint').textContent = t === 0 ? 'On enchaîne les manches et on arrête quand on veut.' : t === 1 ? 'Mort subite : une seule manche.' : `Le premier à ${t} manches gagne.`;
    }

    $('#startBtn').hidden = !isHost;
    $('#startBtn').disabled = !ready;
    $('#startBtn').onclick = () => { unlockAudio(); socket.emit('start'); };
    $('#lobbyWait').textContent = !ready
      ? (isHost ? 'La partie démarre dès que ton adversaire a rejoint.' : '')
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

  function renderGame() {
    const r = S.round;
    const opp = S.players[1 - S.me]?.name || 'Ton adversaire';

    document.querySelectorAll('.scorebug .side').forEach((el) => {
      const i = Number(el.dataset.p);
      const p = S.players[i] || { name: '—', score: 0, online: false };
      el.querySelector('.pname').textContent = p.name;
      el.querySelector('.pscore').textContent = p.score;
      el.classList.toggle('active', !!r && S.phase === 'playing' && r.turn === i);
      el.classList.toggle('off', !p.online);
      el.classList.toggle('me', i === S.me);
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
    const myTurn = playing && r.turn === S.me;
    const turnName = S.players[r.turn]?.name || '';
    const busy = !!r.checking || !!r.appeal;

    // --- Scène : l'artiste en jeu, et la preuve du dernier feat ---
    if (newLink) {
      $('#current').innerHTML = choosing
        ? `<span class="av q" aria-hidden="true">?</span><span class="nm q">Artiste de départ</span>`
        : `${avatar(cur)}<span class="nm">${esc(cur.name)}</span>`;
      $('#current').classList.remove('pop'); void $('#current').offsetWidth; $('#current').classList.add('pop');
      const proof = $('#proof');
      if (last && last.track) {
        proof.hidden = false;
        proof.innerHTML = last.byAppeal
          ? `Validé par ${esc(S.players[1 - last.by]?.name || 'l’adversaire')}${last.track.title && last.track.title !== 'Validé par l’adversaire' ? ` : « ${esc(last.track.title)} »` : ''}`
          : `Prouvé par ${trackInline(last.track)}`;
        bindTracks();
      } else if (last) {
        proof.hidden = false;
        proof.textContent = `Choisi par ${S.players[last.by]?.name || ''} pour lancer la chaîne`;
      } else proof.hidden = true;
      // Nouvelle saisie seulement quand la chaîne avance : en cas d'erreur, le joueur garde ce qu'il a tapé.
      $('#artistInput').value = ''; $('#songInput').value = ''; pickedArtist = null;
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
    $('#artistInput').placeholder = choosing ? 'Un artiste pour lancer la chaîne' : `Un artiste qui a fait un son avec ${cur ? cur.name : ''}`;
    $('#submitBtn').textContent = choosing ? 'Lancer' : 'Valider';
    if (myTurn) {
      $('#artistInput').disabled = busy; $('#songInput').disabled = busy;
      $('#submitBtn').disabled = busy; $('#giveupBtn').disabled = busy;
      resetGiveUp();
      renderFeedback(r, cur, opp);
    }

    // --- Vue de l'adversaire ---
    $('#watch').hidden = myTurn || !playing;
    if (!myTurn && playing) {
      let txt = `<span class="dots">${choosing ? 'Choix en cours' : 'Recherche en cours'}</span>`;
      if (r.checking) txt = `<span class="spin"></span>${esc(turnName)} propose <b>${esc(r.checking.artist.name)}</b>${r.checking.song ? `, « ${esc(r.checking.song)} »` : ''}. Deezer vérifie.`;
      else if (r.appeal) txt = `${esc(turnName)} te demande de valider un feat.`;
      else if (r.lastError) txt = r.lastError.why === 'used'
        ? `${esc(turnName)} a proposé <b>${esc(r.lastError.artist.name)}</b>, déjà cité. <span class="dots">Il cherche encore</span>`
        : `${esc(turnName)} a raté avec <b>${esc(r.lastError.artist.name)}</b>. <span class="dots">Il cherche encore</span>`;
      const p = S.players[r.turn];
      if (p && !p.online) txt = `${esc(turnName)} s'est déconnecté. La partie reprend dès son retour.`;
      $('#watch').innerHTML = txt;
    }

    // --- Arbitrage ---
    const judging = playing && r.appeal && r.turn !== S.me;
    const jo = $('#judgeOverlay');
    if (judging && jo.hidden) setTimeout(() => $('#judgeYes').focus(), 50);
    jo.hidden = !judging;
    if (judging) $('#judgeText').innerHTML = `${esc(cur.name)} <em>×</em> ${esc(r.appeal.artist.name)}${r.appeal.song ? `<span class="small">« ${esc(r.appeal.song)} »</span>` : ''}`;

    // --- Chaîne, la plus récente en haut ---
    if (newLink) {
      const n = Math.max(0, r.chain.length - 1);
      $('#chainTitle').textContent = r.chain.length ? `La chaîne, ${plural(n, 'feat')}` : 'La chaîne';
      $('#chain').innerHTML = r.chain.length ? r.chain.map((l, i) => {
        const who = esc(S.players[l.by]?.name || '');
        const detail = i === 0 ? `<span class="by">lancé par ${who}</span>` : `<span class="by">${who}</span>`;
        return `<li class="p${l.by}${i === 0 ? ' origin' : ''}"><div class="a">${esc(l.artist.name)} ${detail}</div>${l.track ? trackCard(l.track, l.byAppeal) : ''}</li>`;
      }).reverse().join('') : `<li class="empty">Les feats validés s'affichent ici.</li>`;
      bindTracks();
      lastChainLen = r.chain.length;
    }

    renderEnd(r, cur);
    tickClock();
  }

  function renderFeedback(r, cur, opp) {
    const fb = $('#feedback');
    if (r.checking) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>Deezer cherche un son avec ${esc(cur.name)} et ${esc(r.checking.artist.name)}. Chrono en pause.`;
      return;
    }
    if (r.appeal) {
      fb.hidden = false; fb.className = 'feedback info';
      fb.innerHTML = `<span class="spin"></span>${esc(opp)} décide si ton feat compte. Chrono en pause.`;
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
      setTimeout(() => { const i = $('#artistInput'); if (!i.value) i.value = e.artist.name; i.focus({ preventScroll: true }); i.select(); }, 30);
    }
    fb.hidden = false; fb.className = 'feedback';
    const msg = {
      used: `<b>${esc(e.artist.name)}</b> est déjà dans la chaîne. Trouve quelqu'un d'autre.`,
      notfound: `Deezer ne trouve aucun son avec <b>${esc(cur.name)}</b> et <b>${esc(e.artist.name)}</b>${e.song ? ` sous le titre « ${esc(e.song)} »` : ''}. Vérifie l'orthographe ou ajoute le titre du son.`,
      refused: `${esc(opp)} a refusé <b>${esc(e.artist.name)}</b>. Propose un autre artiste.`,
      api: `Deezer ne répond pas. Réessaie dans un instant ou demande à ${esc(opp)} de valider.`,
    }[e.why] || 'Ce feat ne passe pas.';
    const canAppeal = !r.appealUsed && (e.why === 'notfound' || e.why === 'api');
    fb.innerHTML = `<p>${msg}</p>` + (canAppeal ? `<button type="button" class="btn ghost small-btn" id="appealBtn">Faire valider</button>` : '');
    if (canAppeal) $('#appealBtn').onclick = () => socket.emit('appeal');
  }

  function renderEnd(r, cur) {
    const ended = S.phase === 'roundEnd' || S.phase === 'finished';
    const sheet = $('#endSheet');
    const wasHidden = sheet.hidden;
    sheet.hidden = !ended;
    document.body.classList.toggle('sheet-open', ended);
    if (!ended) return;

    const fin = S.phase === 'finished';
    const stopped = fin && S.final && S.final.stopped;
    const w = fin && S.final ? S.final.winner : r.winner;
    const loserName = S.players[1 - r.winner]?.name;
    const won = w === S.me;
    const n = Math.max(0, r.chain.length - 1);

    $('#endKicker').textContent = fin ? (stopped ? `Partie arrêtée après ${plural(S.roundNo, 'manche')}` : 'Fin de la partie') : `Fin de la manche ${S.roundNo}`;
    $('#endTitle').textContent = fin ? (w == null ? 'Égalité' : won ? 'Tu gagnes la partie' : `${S.players[w].name} gagne`) : (won ? 'Manche pour toi' : `Manche pour ${S.players[r.winner].name}`);
    sheet.classList.toggle('win', w === S.me);
    const why = r.reason === 'timeout' ? `${loserName} n'a pas répondu à temps` : `${loserName} a séché`;
    $('#endText').textContent = stopped
      ? (w == null ? 'Score parfaitement égal.' : `Score final en faveur de ${S.players[w].name}.`)
      : cur ? `${why} sur ${cur.name}, après une chaîne de ${plural(n, 'feat')}.` : `${why} avant même de poser l'artiste de départ.`;
    $('#endScore').innerHTML = `<span class="s p0">${esc(S.players[0].name)}<b>${S.players[0].score}</b></span><span class="s p1"><b>${S.players[1].score}</b>${esc(S.players[1].name)}</span>`;

    const btn = $('#endBtn');
    btn.hidden = false;
    if (fin) { btn.textContent = 'Revanche'; btn.onclick = () => socket.emit('start'); }
    else {
      const nextStarter = S.players[S.roundNo % 2]?.name;
      btn.textContent = 'Manche suivante';
      btn.onclick = () => socket.emit('next');
      $('#endText').textContent += ` ${nextStarter === S.players[S.me]?.name ? 'Tu commences' : nextStarter + ' commence'} la prochaine.`;
    }
    const stop = $('#stopBtn');
    stop.hidden = fin || S.settings.target !== 0;
    armTwoTap(stop, 'Arrêter', 'Sûr ?', () => socket.emit('stop'));
    if (wasHidden) setTimeout(() => btn.focus({ preventScroll: true }), 60);
  }

  // ================= PISTES / AUDIO =================
  function trackInline(t) {
    const btn = t.preview ? `<button type="button" class="play-btn" data-prev="${esc(t.preview)}" aria-label="Écouter « ${esc(t.title)} »">▶</button>` : '';
    return `<span class="ti">« ${esc(t.title)} »</span>${btn}`;
  }
  function trackCard(t, byAppeal) {
    const cover = t.cover ? `<img src="${esc(t.cover)}" alt="">` : '<span class="nocover" aria-hidden="true"></span>';
    const sub = byAppeal ? '<span class="badge">Validé à la main</span>' : `<span>${esc((t.artists || []).join(', '))}</span>`;
    const btn = t.preview ? `<button type="button" class="play-btn" data-prev="${esc(t.preview)}" aria-label="Écouter « ${esc(t.title)} »">▶</button>` : '';
    const title = t.link ? `<a href="${esc(t.link)}" target="_blank" rel="noopener">${esc(t.title)}</a>` : esc(t.title);
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
    $('#muteBtn').textContent = muted ? 'Son coupé' : 'Son activé';
    $('#muteBtn').setAttribute('aria-pressed', String(muted));
  }
  $('#muteBtn').onclick = () => { muted = !muted; store.set('rg_mute', muted ? '1' : '0'); if (muted) audio.pause(); syncMute(); };

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
  }
  setInterval(tickClock, 200);

  // ================= AUTOCOMPLÉTION =================
  function autocomplete(input, list, onPick) {
    let items = [], sel = -1, timer, seq = 0;
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
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) { e.preventDefault(); choose(items[Number(li.dataset.i)]); }
    });
    input.addEventListener('blur', () => setTimeout(close, 120));
    function choose(a) { input.value = a.name; close(); onPick(a); }
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

  if (ownRoom && store.get('rg_name')) socket.emit('join', { token, code: inviteCode, name: null });
  render();
})();
