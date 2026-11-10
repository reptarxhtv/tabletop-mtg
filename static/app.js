(() => {
'use strict';

/* ======================================================================
   Helpers
   ====================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const mk = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const haptic = () => { try { navigator.vibrate && navigator.vibrate(15); } catch (_) {} };
const cap = s => {
  s = String(s).replace(/\s+/g, ' ').trim().slice(0, 20);
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const fmtPT = (p, t) =>
  `${p < 0 ? '−' : '+'}${Math.abs(p)}/${t < 0 ? '−' : '+'}${Math.abs(t)}`;

const ZONE_NAMES = { graveyard: 'Graveyard', exile: 'Exile', library: 'Library' };
const zoneName = z => ZONE_NAMES[z] || (state.czones && state.czones[z]) || 'Zone';
const HOLD_MS = 450;
/* On a PC the right mouse button does what holding a finger does: it opens the menu at once */
const isRightClick = e => !!e && e.pointerType === 'mouse' && e.button === 2;
function holdTimer(e, fn) {
  if (isRightClick(e)) { fn(); return null; } // right button: no waiting
  return setTimeout(fn, HOLD_MS);
}
const VERSION = 'v6.5';
const BACK = '<div class="back"></div>';

/* a double-faced card shows its other face only while it is flipped on the table */
function flipped(c) { return !!c && c.zone === 'battlefield' && !!c.face && !!c.img2; }
function imgHTML(c, key) {
  const src = flipped(c) ? ((key === 'thumb' && c.thumb2) || c.img2) : ((key && c[key]) || c.img);
  return src
    ? `<img src="${esc(src)}" alt="${esc(c.name)}" draggable="false">`
    : `<div class="noimg">${esc(c.name)}</div>`;
}

/* ======================================================================
   Connection
   ====================================================================== */
let ws = null, role = null, room = null, wantConnected = false, reconnectTimer = null;
let state = {
  cards: {},
  zones: { hand: [], battlefield: [], graveyard: [], exile: [], library: [], command: [], look: [] },
  tax: [0, 0],
  setup: { phase: null, mull: 0, size: 7 },
  look: null,
  trackers: {},
  ctrs: {},
  czones: {},
  turn: 0,
  undo: 0,
  drew: { n: 0, seq: 0 },
};

function normalize(m) {
  m.zones = m.zones || {};
  ['hand', 'battlefield', 'graveyard', 'exile', 'library', 'command', 'look'].forEach(z => {
    m.zones[z] = m.zones[z] || [];
  });
  m.trackers = m.trackers || {};
  m.ctrs = m.ctrs || {};
  m.czones = m.czones || {};
  m.turn = m.turn || 0;
  m.undo = m.undo || 0;
  m.drew = m.drew || { n: 0, seq: 0 };
  m.setup = m.setup || { phase: null, mull: 0, size: 7 };
  return m;
}

function setStatus(on) {
  document.querySelectorAll('.dot').forEach(d => d.classList.toggle('on', on));
}

/* The table password (online servers only): from the address (&key=...) or what was typed once on this device */
function tableKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem('tt-key') || ''; } catch (_) { return ''; }
}

function askPassword() {
  const given = window.prompt('This table has a password:');
  if (given === null) { toast('No password: not connected. Reload the page to try again.'); return; }
  try { localStorage.setItem('tt-key', given); } catch (_) {}
  const u = new URL(location.href);
  u.searchParams.delete('key'); // a wrong key in the address must not shadow the one just typed
  history.replaceState(null, '', u);
  reconnectTimer = setTimeout(connect, 200);
}

/* ---- table backup: a free online server forgets the table when it sleeps; each device keeps a copy ---- */
const BACKUP_KEY = () => 'tt-backup-' + room;
let backupTimer = null;

function saveBackupSoon(m) {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    const keep = Object.assign({}, m);
    ['type', 'room', 'undo', 'drew', 'milled', 'ver'].forEach(k => delete keep[k]);
    try { localStorage.setItem(BACKUP_KEY(), JSON.stringify({ savedAt: Date.now(), state: keep })); } catch (_) {}
  }, 1500);
}

function dropBackup() {
  clearTimeout(backupTimer);
  try { localStorage.removeItem(BACKUP_KEY()); } catch (_) {}
}

/* true when a backup was sent (the server answers with the restored table) */
function sendBackup() {
  let b = null;
  try { b = JSON.parse(localStorage.getItem(BACKUP_KEY()) || 'null'); } catch (_) {}
  if (!b || !b.state || !b.state.cards || !Object.keys(b.state.cards).length) return false;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'restore', state: b.state }));
  return true;
}

/* A small message every 25 seconds keeps the connection (and a sleepy free server) awake while you play */
setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 25000);

function connect() {
  wantConnected = true;
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const key = tableKey();
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}${key ? '&key=' + encodeURIComponent(key) : ''}`);
  ws.onopen = () => { gotState = false; setStatus(true); }; // after a reconnect, anything announced meanwhile is old news
  ws.onclose = ev => {
    setStatus(false);
    if (ev.code !== 4401) toast('Disconnected (code ' + ev.code + (ev.reason ? ': ' + ev.reason : '') + '), retrying...');
    if (ev.code === 4401) { askPassword(); return; }  // an online server asked for its password
    if (wantConnected) reconnectTimer = setTimeout(connect, 1500);
  };
  ws.onerror = () => { toast('Connection error'); };
  ws.onmessage = ev => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'state') {
      if (m.ver && m.ver !== VERSION && staleCopy(m.ver)) return;
      const first = !gotState;
      if (first) {  // the first state from the server: whatever was drawn or milled before is old news
        gotState = true;
        lastDrewSeq = (m.drew || {}).seq || 0; lastMilledSeq = (m.milled || {}).seq || 0;
      }
      if (!Object.keys(m.cards || {}).length) {
        // an empty table: a free server that woke up empty gets this device's backup back,
        // but an empty table later in the same connection is a reset, so the backup goes too
        if (!(first && sendBackup())) dropBackup();
      } else saveBackupSoon(m);
      state = normalize(m); render();
    }
    else if (m.type === 'notice') toast(m.text);
    else if (m.type === 'token_results') showTokenResults(m);
  };
}

/* This device runs an older (cached) copy of the app than the server: reload once to get the new one. */
function staleCopy(serverVer) {
  const key = 'tt-reload-' + serverVer;
  let done = false;
  try { done = !!sessionStorage.getItem(key); sessionStorage.setItem(key, '1'); } catch (_) {}
  if (!done) { location.reload(); return true; }
  toast('This device shows an old copy (' + VERSION + '); the server is ' + serverVer + '. Close the app / clear the browser cache and open it again.');
  return false;
}

function send(o) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
  else toast('Not connected to the server (socket state ' + (ws ? ws.readyState : 'none') + ')');
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && wantConnected && (!ws || ws.readyState > 1)) connect();
});
document.addEventListener('contextmenu', e => e.preventDefault());

function toast(text) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = mk('div', 'toast', esc(text));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

/* ======================================================================
   Menus (with sub-menus) & dialogs
   ====================================================================== */
let guardUntil = 0; // ignores the click that follows a long press

function closeMenu() { const m = $('#menu-bd'); if (m) m.remove(); }

/* items: [{label, run} | {label, sub:[...]} | {label, danger:true, run}] */
function showMenu(title, items) {
  closeMenu();
  const bd = mk('div', 'backdrop menu-bd'); bd.id = 'menu-bd';
  const m = mk('div', 'menu');
  bd.appendChild(m);

  const draw = (t, its, back) => {
    m.innerHTML = '';
    if (back) {
      const b = mk('button', 'backbtn', '<span>‹ Back</span>');
      b.addEventListener('click', () => {
        if (Date.now() < guardUntil) return;
        guardUntil = Date.now() + 200;
        back();
      });
      m.appendChild(b);
    }
    if (t) m.appendChild(mk('h3', null, esc(t)));
    its.forEach(it => {
      const b = mk('button', it.danger ? 'danger' : '',
        `<span>${esc(it.label)}</span>` + (it.sub ? '<span class="chev">›</span>' : ''));
      b.addEventListener('click', () => {
        if (Date.now() < guardUntil) return;
        if (it.sub) {
          guardUntil = Date.now() + 200;
          draw(it.label, it.sub, () => draw(t, its, back));
        } else {
          closeMenu();
          it.run();
        }
      });
      m.appendChild(b);
    });
  };

  draw(title, items, null);
  bd.addEventListener('click', e => {
    if (e.target === bd && Date.now() >= guardUntil) closeMenu();
  });
  document.body.appendChild(bd);
  guardUntil = Date.now() + 300;
}

function openZoom(c) {
  if (!c) return;
  document.querySelectorAll('.layer-zoom').forEach(z => z.remove());
  const bd = mk('div', 'backdrop layer-zoom', imgHTML(c));
  bd.addEventListener('click', () => bd.remove());
  document.body.appendChild(bd);
}

const mvMsg = (id, extra) => () => send({ t: 'move', id, ...(extra || {}) });

/* Where a card can be sent from its current zone */
function destinations(c) {
  const d = [];
  if (c.zone !== 'hand') d.push(['Hand', { to: 'hand' }]);
  if (c.zone !== 'graveyard') d.push(['Graveyard', { to: 'graveyard' }]);
  if (!(c.zone === 'exile' && !c.down)) d.push(['Exile', { to: 'exile', down: false }]);
  if (!(c.zone === 'exile' && c.down)) d.push(['Exile face down', { to: 'exile', down: true }]);
  d.push(['Top of library', { to: 'library', where: 'top' }]);
  d.push(['Bottom of library', { to: 'library', where: 'bottom' }]);
  Object.entries(state.czones || {}).forEach(([id, name]) => {
    if (c.zone !== id) d.push([name, { to: id }]);
  });
  if (c.commander && c.zone !== 'command') d.push(['Command zone', { to: 'command' }]);
  return d;
}

function moveItems(c) {
  return destinations(c).map(([label, extra]) => ({ label, run: mvMsg(c.id, extra) }));
}

/* card_actions: cards in hand / graveyard / exile / library / command zone.
   Opens on a tap or a hold. `extra` adds more items at the end. */
function openCardActions(id, extra) {
  const c = state.cards[id];
  if (!c) return;
  const play = [
    { label: 'Face up', run: mvMsg(id, { to: 'battlefield', down: false }) },
    { label: 'Face down', run: mvMsg(id, { to: 'battlefield', down: true }) },
    { label: 'Tapped face up', run: mvMsg(id, { to: 'battlefield', down: false, tapped: true }) },
  ];
  showMenu(c.name, [
    { label: 'Play', sub: play },
    { label: 'Move to', sub: moveItems(c) },
    { label: 'Zoom', run: () => openZoom(c) },
  ].concat(extra || []));
}

/* Graveyard / exile: the menu of the top card, plus Search for the whole pile */
function openZoneTopMenu(z, half) {
  let ids = state.zones[z];
  if (z === 'exile' && half) ids = ids.filter(i => state.cards[i] && !!state.cards[i].down === (half === 'down'));
  const extra = [{ label: 'Search', run: () => openViewer(z) }];
  // the table's own zones can be shuffled
  if (state.czones && state.czones[z]) extra.push({ label: 'Shuffle', run: () => send({ t: 'shuffle', zone: z }) });
  if (!ids.length) { showMenu(zoneName(z), extra); return; }
  openCardActions(ids[ids.length - 1], extra);
}

/* The message that sends a dragged card to a zone (a library drop goes on top) */
function dropMsg(id, to, slot) {
  if (to === 'library') return { t: 'move', id, to, where: 'top' };
  // the lower exile half is the face-down pile
  return { t: 'move', id, to, down: to === 'exile' && !!slot && slot.dataset.down === '1' };
}

/* menu for cards ON the battlefield */
function openBoardMenu(id) {
  const c = state.cards[id];
  if (!c) return;
  const items = [];
  if (c.token) {
    const names = Object.values(state.czones || {});
    const zs = moveItems(c).filter(m => names.includes(m.label));
    if (zs.length) items.push({ label: 'Move to', sub: zs });
    items.push({ label: 'Remove token', danger: true, run: mvMsg(id, { to: 'graveyard' }) });
  } else items.push({ label: 'Move to', sub: moveItems(c) });
  items.push(
    { label: 'Flip', run: () => send({ t: 'flip', id }) },
    ...(c.img2 ? [{ label: c.cover ? 'Uncover back side' : 'Cover back side', run: () => send({ t: 'cover', id }) }] : []),
    { label: 'Copy', run: () => send({ t: 'copy_token', id }) },
    { label: 'Add counter', run: () => openCounters(id) },
  );
  showMenu(c.name, items);
}

/* scry / surveil: the cards being looked at */
function lookMove(id, act) {
  if (act === 'top') send({ t: 'move', id, to: 'library', where: 'top' });
  else if (act === 'bottom') send({ t: 'move', id, to: 'library', where: 'bottom' });
  else if (act === 'grave') send({ t: 'move', id, to: 'graveyard' });
}

/* Scry: top or bottom of the library. Surveil: top of the library or graveyard. */
function openLookMenu(id) {
  const c = state.cards[id];
  if (!c) return;
  const surveil = !!state.look && state.look.mode === 'surveil';
  showMenu(c.name, [
    { label: 'To top of library', run: () => lookMove(id, 'top') },
    surveil
      ? { label: 'To graveyard', run: () => lookMove(id, 'grave') }
      : { label: 'To bottom of library', run: () => lookMove(id, 'bottom') },
    { label: 'Zoom', run: () => openZoom(c) },
  ]);
}

function lookSubs(mode) {
  return [1, 2, 3, 4, 5, 6].map(n => ({ label: String(n), run: () => send({ t: 'look', mode, n }) }));
}

/* Mill: the top N cards of the library go to the graveyard */
const MILL_COUNTS = [1, 2, 3, 4, 5, 6, 8, 10];
function millSubs() {
  const subs = MILL_COUNTS.map(n => ({ label: String(n), run: () => send({ t: 'mill', n }) }));
  subs.push({
    label: 'Other...',
    run: () => {
      const v = parseInt(window.prompt('Mill how many cards?', '3'), 10);
      if (v > 0) send({ t: 'mill', n: Math.min(v, 99) });
    },
  });
  return subs;
}

function openZoneMenu(z) {
  const items = [{ label: 'Search', run: () => openViewer(z) }];
  if (z === 'library') {
    items.push(
      { label: 'Scry', sub: lookSubs('scry') },
      { label: 'Surveil', sub: lookSubs('surveil') },
      { label: 'Mill', sub: millSubs() },
      { label: 'Shuffle', run: () => send({ t: 'shuffle' }) },
      { label: 'Draw 1', run: () => send({ t: 'draw', n: 1 }) },
    );
  }
  showMenu(zoneName(z), items);
}

function changeRole() { location.href = location.pathname; }

function openBoardMainMenu() {
  showMenu('Table', [
    { label: 'New game', run: openLoadDialog },
    {
      label: 'Restart game',
      run: () => {
        if (confirm('Same deck: shuffle everything back and deal a new opening hand?')) send({ t: 'restart' });
      },
    },
    {
      label: 'Reset table', danger: true,
      run: () => {
        if (confirm('Clear the whole table, including the deck?')) send({ t: 'reset_all' });
      },
    },
    { label: 'Change role / room', run: changeRole },
  ]);
}

function closeDialog() {
  tokenCtx = null;
  const d = $('#dialog-bd');
  if (d) d.remove();
}

function openLoadDialog() {
  closeDialog();
  const bd = mk('div', 'backdrop layer-dialog'); bd.id = 'dialog-bd';
  bd.innerHTML = `
    <div class="menu dialog">
      <h3>New game</h3>
      <label for="ld-cmd">Commander(s): one name per line (max 2)</label>
      <textarea id="ld-cmd" rows="2" placeholder="Atraxa, Praetors' Voice" autocapitalize="off" spellcheck="false"></textarea>
      <label for="ld-deck">Decklist: paste a text export from Moxfield or Archidekt</label>
      <textarea id="ld-deck" rows="10" placeholder="1 Sol Ring&#10;1 Command Tower&#10;30 Forest" autocapitalize="off" spellcheck="false"></textarea>
      <div class="dlg-actions">
        <button id="ld-cancel">Cancel</button>
        <button id="ld-cmdset" title="Make the name(s) above the commander(s) without reloading the deck">Set commander</button>
        <button id="ld-go" class="primary">Start game</button>
      </div>
    </div>`;
  bd.addEventListener('click', e => { if (e.target === bd) closeDialog(); });
  document.body.appendChild(bd);
  $('#ld-cancel').onclick = closeDialog;
  // a commander already in the deck is pulled out of it, otherwise it is imported; the table stays as it is
  $('#ld-cmdset').onclick = () => {
    send({ t: 'set_commanders', commander: $('#ld-cmd').value });
    closeDialog();
  };
  $('#ld-go').onclick = () => {
    send({ t: 'load', commander: $('#ld-cmd').value, deck: $('#ld-deck').value });
    closeDialog();
  };
}

/* ======================================================================
   Tokens
   ====================================================================== */
let tokenCtx = null;
let tokenKind = 'token'; // "token" (disappears when it leaves the table) or "card" (a real card)

function openTokenDialog(x, y) {
  closeDialog();
  tokenCtx = { x, y };
  const bd = mk('div', 'backdrop layer-dialog'); bd.id = 'dialog-bd';
  bd.innerHTML = `
    <div class="menu dialog">
      <h3>Create token / card</h3>
      <div class="seg" id="tk-kind">
        <button data-kind="token">Token</button>
        <button data-kind="card">Card</button>
      </div>
      <div class="cadd">
        <input id="tk-name" maxlength="160" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button id="tk-go" class="primary">Search</button>
      </div>
      <div id="tk-res" class="tkgrid"></div>
      <div class="dlg-actions"><button id="tk-close">Close</button></div>
    </div>`;
  bd.addEventListener('click', e => { if (e.target === bd) closeDialog(); });
  document.body.appendChild(bd);

  const search = () => {
    const name = $('#tk-name').value.trim();
    if (!name) return;
    $('#tk-res').innerHTML = '<div class="empty">Searching...</div>';
    send({ t: 'token_search', name, kind: tokenKind });
  };
  const setKind = (k, rerun) => {
    tokenKind = k;
    bd.querySelectorAll('#tk-kind button').forEach(b => b.classList.toggle('on', b.dataset.kind === k));
    $('#tk-name').placeholder = k === 'token'
      ? 'Token name (Goblin, Monarch, dungeon...) or a Scryfall link'
      : 'Card name or a Scryfall link (it disappears when it leaves the table)';
    $('#tk-res').innerHTML = '';
    if (rerun && $('#tk-name').value.trim()) search();
  };
  bd.querySelectorAll('#tk-kind button').forEach(b => { b.onclick = () => setKind(b.dataset.kind, true); });
  $('#tk-go').onclick = search;
  $('#tk-name').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  $('#tk-close').onclick = closeDialog;
  setKind(tokenKind, false);
  setTimeout(() => { const i = $('#tk-name'); if (i) i.focus(); }, 50);
}

/* On touch screens a mostly vertical swipe over a tile in a list scrolls the list; a sideways or
   diagonal move picks the card up straight away (no hold needed). */
function listScrolls(grid) { return !!grid && grid.scrollHeight > grid.clientHeight + 2; }
function isScrollSwipe(dx, dy, tile) {
  // nothing to scroll in this list: any direction picks the card up
  if (!listScrolls(tile && tile.parentElement)) return false;
  return Math.abs(dy) > Math.abs(dx) * 0.7;
}
/* touch-action decides whether the browser may take a swipe over a tile as a scroll: only when the list overflows */
function fitTouchAction(grid) {
  const apply = () => {
    const v = listScrolls(grid) ? 'pan-y' : 'none';
    grid.querySelectorAll('.tile').forEach(t => { t.style.touchAction = v; });
  };
  requestAnimationFrame(apply); setTimeout(apply, 350); // again once the pictures have loaded
}

/* A search result: tap = create it where you held the table, drag = drop it anywhere on the table */
function bindResultTile(tile, res) {
  let down = false, dragging = false, armed = false, touch = false;
  let ghost = null, timer = null, sx = 0, sy = 0;
  const end = () => {
    clearTimeout(timer);
    down = dragging = armed = false;
    if (ghost) { ghost.remove(); ghost = null; }
    const d = $('#dialog-bd'); if (d) d.classList.remove('dragging-out');
    tileDragLock = false;
  };
  const create = (x, y) => {
    send({ t: 'token_create', kind: tokenKind, name: res.name, img: res.img, thumb: res.thumb, img2: res.img2 || '', thumb2: res.thumb2 || '', special: !!res.special, x, y });
    closeDialog();
  };
  tile.addEventListener('pointerdown', e => {
    end();
    down = true; sx = e.clientX; sy = e.clientY; touch = e.pointerType !== 'mouse';
    try { tile.setPointerCapture(e.pointerId); } catch (_) {}
  });
  tile.addEventListener('pointermove', e => {
    if (!down) return;
    if (!dragging) {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) <= 10) return;
      if (touch && isScrollSwipe(dx, dy, tile)) { end(); return; } // a mostly vertical swipe scrolls the list
      dragging = true; tileDragLock = true;
      clearTimeout(timer);
      ghost = makeGhost({ name: res.name, img: res.img });
      const d = $('#dialog-bd'); if (d) d.classList.add('dragging-out');
    }
    moveGhost(ghost, e.clientX, e.clientY);
  });
  tile.addEventListener('pointerup', e => {
    if (!down) return;
    if (dragging && ghost) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const field = $('#field');
      if (el && field && field.contains(el)) {
        const r = field.getBoundingClientRect();
        const x = clamp((e.clientX - ghost.offsetWidth / 2 - r.left) / r.width, 0, 1);
        const y = clamp((e.clientY - ghost.offsetHeight / 2 - r.top) / r.height, 0, 1);
        end();
        create(x, y);
      } else end(); // dropped somewhere else: nothing is created, the dialog stays
      return;
    }
    end();
    const ctx = tokenCtx;
    if (ctx) create(ctx.x, ctx.y);
  });
  tile.addEventListener('pointercancel', end);
}

function showTokenResults(m) {
  const box = $('#tk-res');
  if (!box || !tokenCtx || m.kind !== tokenKind) return; // stale answer from the other tab
  box.innerHTML = '';
  if (!m.results || !m.results.length) {
    box.appendChild(mk('div', 'empty', tokenKind === 'token' ? 'No tokens found' : 'Nothing found'));
    return;
  }
  m.results.forEach(r => {
    const t = mk('div', 'tile',
      `<img src="${esc(r.thumb || r.img)}" alt="" draggable="false"><span>${esc(r.name)}${r.pt ? ' ' + esc(r.pt) : ''}</span>`);
    bindResultTile(t, r);
    box.appendChild(t);
  });
  fitTouchAction(box);
}

/* ======================================================================
   Counters dialog (+1/+1 / -1/-1 net, and named counters)
   ====================================================================== */
let counterId = null;
let ctrMode = 1; // the card counters dialog: 1 = the power/toughness buttons add, -1 = they subtract
const DEFAULT_KW = ['Flying', 'Trample', 'Deathtouch', 'Lifelink', 'First strike',
  'Vigilance', 'Haste', 'Menace', 'Hexproof', 'Indestructible'];

function loadChips() {
  try {
    const a = JSON.parse(localStorage.getItem('tt-chips'));
    if (Array.isArray(a) && a.length === DEFAULT_KW.length &&
        a.every(x => x && typeof x.name === 'string' && typeof x.uses === 'number')) return a;
  } catch (_) {}
  return DEFAULT_KW.map(name => ({ name, uses: 0 }));
}
function saveChips(a) { try { localStorage.setItem('tt-chips', JSON.stringify(a)); } catch (_) {} }

/* Counts a use. A name that is not on the chip list replaces the least used chip
   (the last one wins a tie). Returns the capitalised name. */
function useCounterName(raw) {
  const name = cap(raw);
  if (!name) return '';
  const chips = loadChips();
  const i = chips.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
  if (i >= 0) chips[i].uses += 1;
  else {
    let k = 0;
    chips.forEach((c, j) => { if (c.uses <= chips[k].uses) k = j; });
    chips[k] = { name, uses: 1 };
  }
  saveChips(chips);
  return name;
}

function closeCounters() { counterId = null; const d = $('#counters-bd'); if (d) d.remove(); }
function openCounters(id) { counterId = id; renderCounters(); }

function renderChips() {
  const box = $('#c-chips');
  if (!box) return;
  box.innerHTML = loadChips().map(c => `<button data-chip="${esc(c.name)}">${esc(c.name)}</button>`).join('');
}

function renderCounters() {
  const c = state.cards[counterId];
  if (!c || c.zone !== 'battlefield') { closeCounters(); return; }

  let bd = $('#counters-bd');
  if (!bd) {
    bd = mk('div', 'backdrop layer-counters'); bd.id = 'counters-bd';
    const box = mk('div', 'menu counters');
    box.innerHTML = `
      <h3 id="c-title"></h3>
      <div id="c-rows"></div>
      <div class="cadd">
        <input id="c-name" maxlength="20" placeholder="Custom counter (e.g. Loyalty)" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button id="c-add" class="primary">Add</button>
      </div>
      <div class="gpresets" id="c-chips"></div>
      <div class="cdone"><button id="c-done">Done</button></div>`;
    bd.appendChild(box);
    bd.addEventListener('click', e => { if (e.target === bd) closeCounters(); });
    box.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.w) {
        const w = b.dataset.w, m = ctrMode;
        send({ t: 'counter', id: counterId, kind: 'pt', dp: w === 't' ? 0 : m, dt: w === 'p' ? 0 : m });
      } else if (b.dataset.m) {
        const nm = parseInt(b.dataset.m, 10) < 0 ? -1 : 1;
        // first tap lights the sign; tapping it again (already lit) adds/subtracts power and toughness together
        if (nm === ctrMode) send({ t: 'counter', id: counterId, kind: 'pt', dp: nm, dt: nm });
        ctrMode = nm;
        renderCounters();
      } else if (b.dataset.k) {
        send({ t: 'counter', id: counterId, kind: b.dataset.k, delta: parseInt(b.dataset.d, 10), name: b.dataset.name });
      } else if (b.dataset.chip) {
        const name = useCounterName(b.dataset.chip);
        send({ t: 'counter', id: counterId, kind: 'named', delta: 1, name });
      } else if (b.id === 'c-add') addNamed();
      else if (b.id === 'c-done') closeCounters();
    });
    box.querySelector('#c-name').addEventListener('keydown', e => { if (e.key === 'Enter') addNamed(); });
    document.body.appendChild(bd);
    renderChips();
  }

  $('#c-title').textContent = c.name + ' (counters)';
  const sg = v => (v > 0 ? ' pos' : (v < 0 ? ' neg' : ''));
  const box = (label, num, cls, k, name) => `<div class="gctr inl">
      <div class="thandle"><span class="glabel"><span>${esc(label)}</span></span></div>
      <div class="gmain">
        <button data-k="${k}" data-d="-1" data-name="${esc(name)}">−</button>
        <span class="gnum ${cls}">${num}</span>
        <button data-k="${k}" data-d="1" data-name="${esc(name)}">+</button>
      </div>
    </div>`;
  // +1/+1 and -1/-1 counters: the same layout as the P/T tracker, power and toughness apart or together
  let html = `<div class="gctr inl ptbox">
      <div class="thandle"><span class="glabel"><span>+1/+1 and −1/−1</span></span></div>
      <div class="tmain">
        <button data-w="p" class="tp${sg(c.p)}">${fmtMod(c.p || 0)}</button>
        <button data-w="pt" class="tslash" aria-label="Both">/</button>
        <button data-w="t" class="tt${sg(c.t)}">${fmtMod(c.t || 0)}</button>
      </div>
      <div class="tops">
        <button data-m="1" class="${ctrMode > 0 ? 'on' : ''}" aria-label="Add">+</button>
        <button data-m="-1" class="${ctrMode < 0 ? 'on' : ''}" aria-label="Subtract">−</button>
      </div>
    </div>`;
  Object.entries(c.counters || {}).forEach(([name, n]) => { html += box(name, n, '', 'named', name); });
  $('#c-rows').innerHTML = html;
}

function addNamed() {
  const input = $('#c-name');
  const name = useCounterName(input.value);
  if (!name) return;
  send({ t: 'counter', id: counterId, kind: 'named', delta: 1, name });
  input.value = '';
  renderChips();
}

/* ======================================================================
   Zone viewer ("Search")
   ====================================================================== */
let viewer = null;

function openViewer(zone) {
  closeViewer();
  viewer = { zone, filter: '' };
  const bd = mk('div', 'backdrop layer-viewer'); bd.id = 'viewer-bd';
  const p = mk('div', 'viewer');
  p.innerHTML = `
    <div class="vhead">
      <h2 id="v-title"></h2>
      <input id="v-filter" type="search" placeholder="Search by name..." autocomplete="off" autocapitalize="off" spellcheck="false">
      <span class="grow"></span>
      <span id="v-extra"></span>
      <button id="v-close">Close</button>
    </div>
    <div class="vgrid" id="v-grid"></div>`;
  bd.appendChild(p);
  bd.addEventListener('click', e => { if (e.target === bd) closeViewer(); });
  document.body.appendChild(bd);
  $('#v-close').onclick = closeViewer;
  $('#v-filter').addEventListener('input', e => { viewer.filter = e.target.value; renderViewer(); });
  renderViewer();
}

function closeViewer() { viewer = null; const d = $('#viewer-bd'); if (d) d.remove(); }

/* A card in a Search window: tap or hold = its menu, drag = drop it on the table or on a zone.
   While it is dragged the window greys out and stops catching the pointer, so the drop reaches
   the table; afterwards the window is still open. With a finger, a sideways or diagonal move picks
   the card up at once, a mostly vertical swipe scrolls the list, and holding still opens its menu. */
let tileDragLock = false;     // true while a Search-window card is being dragged
let viewerStale = false;      // the table changed during the drag: redraw afterwards
document.addEventListener('touchmove', e => {
  if (tileDragLock && e.cancelable) e.preventDefault();
}, { passive: false });

function bindTile(tile, id) {
  let down = false, dragging = false, armed = false, touch = false;
  let ghost = null, timer = null, sx = 0, sy = 0;
  const end = () => {
    clearTimeout(timer);
    down = dragging = armed = false;
    if (ghost) { ghost.remove(); ghost = null; }
    highlightDrop(null);
    const v = $('#viewer-bd'); if (v) v.classList.remove('dragging-out');
    tileDragLock = false;
    if (viewerStale) { viewerStale = false; renderViewer(); }
  };
  tile.addEventListener('pointerdown', e => {
    end();
    down = true; sx = e.clientX; sy = e.clientY; touch = e.pointerType !== 'mouse';
    try { tile.setPointerCapture(e.pointerId); } catch (_) {}
    // hold still = the card's menu (same as a tap, but without lifting the finger)
    timer = holdTimer(e, () => {
      if (!down || dragging) return;
      haptic(); guardUntil = Date.now() + 300;
      end();
      openCardActions(id);
    });
  });
  tile.addEventListener('pointermove', e => {
    if (!down) return;
    if (!dragging) {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) <= 10) return;
      if (touch && isScrollSwipe(dx, dy, tile)) { end(); return; } // a mostly vertical swipe scrolls the list
      const c = state.cards[id];
      if (!c) { end(); return; }
      dragging = true; tileDragLock = true;
      clearTimeout(timer);
      ghost = makeGhost(c);
      const v = $('#viewer-bd'); if (v) v.classList.add('dragging-out');
    }
    moveGhost(ghost, e.clientX, e.clientY);
    const target = slotAt(e.clientX, e.clientY);
    highlightDrop(target && dropZoneFor(state.cards[id], target) ? target : null);
  });
  tile.addEventListener('pointerup', e => {
    if (!down) return;
    if (dragging && ghost) {
      const c = state.cards[id];
      const target = slotAt(e.clientX, e.clientY);
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const field = $('#field');
      if (target) {
        const to = dropZoneFor(c, target);
        if (to) send(dropMsg(id, to, target));
        else if (target.dataset.drop === 'command' && c && !c.commander) toast('Only a commander can go to the command zone.');
      } else if (el && field && field.contains(el)) {
        const r = field.getBoundingClientRect();
        send({
          t: 'move', id, to: 'battlefield', down: false,
          x: clamp((e.clientX - ghost.offsetWidth / 2 - r.left) / r.width, 0, 1),
          y: clamp((e.clientY - ghost.offsetHeight / 2 - r.top) / r.height, 0, 1),
        });
      }
      end();
      return;
    }
    end();
    openCardActions(id);
  });
  tile.addEventListener('pointercancel', end);
}

function renderViewer() {
  if (!viewer) return;
  if (tileDragLock) { viewerStale = true; return; }
  const z = viewer.zone;
  const ids = state.zones[z].slice();
  if (z !== 'library') ids.reverse(); // most recent first
  const f = viewer.filter.trim().toLowerCase();
  const list = ids.map(id => state.cards[id]).filter(c => c && (!f || c.name.toLowerCase().includes(f)));
  $('#v-title').textContent = `${zoneName(z)} (${state.zones[z].length})`;

  const extra = $('#v-extra'); extra.innerHTML = '';
  if (z === 'library') {
    const sh = mk('button', null, 'Shuffle'); sh.onclick = () => send({ t: 'shuffle' });
    const dr = mk('button', null, 'Draw 1'); dr.onclick = () => send({ t: 'draw', n: 1 });
    extra.append(sh, dr);
  }

  const grid = $('#v-grid');
  const st = grid.scrollTop;
  grid.innerHTML = '';
  if (!list.length) grid.appendChild(mk('div', 'empty', f ? 'No match' : 'Empty'));
  list.forEach((c, i) => {
    const t = mk('div', 'tile', imgHTML(c, 'thumb') + `<span>${esc(c.name)}</span>`);
    if (z === 'library' && i === 0 && !f) t.classList.add('top');
    if (z === 'exile' && c.down) t.classList.add('fd');
    bindTile(t, c.id);
    grid.appendChild(t);
  });
  grid.scrollTop = st;
  fitTouchAction(grid);
}

/* ======================================================================
   Phone: hand (and scry / surveil)
   ====================================================================== */
let handSig = null;
let showHand = false; // while scrying: peek at the (locked) hand

function renderHand() {
  const look = state.look;
  if (!look) showHand = false;
  const viewing = look && !showHand ? 'look' : 'hand';
  const ids = viewing === 'look' ? state.zones.look : state.zones.hand;
  const locked = !!look && viewing === 'hand';
  const lookMode = look ? look.mode : '';

  $('#h-lib').textContent = 'Lib ' + state.zones.library.length;
  $('#h-turn-n').textContent = state.turn || 0;
  renderBanner();
  renderMull();

  const sig = [viewing, lookMode, locked, ids.join(',')].join('|');
  if (sig === handSig) return;
  handSig = sig;
  const box = $('#hand');
  const sl = box.scrollLeft;
  box.classList.toggle('locked', locked);
  box.innerHTML = '';
  if (!ids.length) {
    box.appendChild(mk('div', 'empty', viewing === 'look'
      ? 'Nothing left to look at'
      : 'Your hand is empty<br>Pick a number and tap Draw'));
    return;
  }
  ids.forEach(id => {
    const c = state.cards[id];
    if (!c) return;
    const n = mk('div', 'hcard', imgHTML(c));
    n.dataset.id = id;
    bindHandCard(n, id, viewing);
    if (viewing === 'look') {
      // scry: top / bottom, surveil: top / graveyard; the buttons sit above their own card
      const col = mk('div', 'lcol');
      const btns = mk('div', 'lbtns', '<button data-act="top">To top</button>' +
        (lookMode === 'surveil'
          ? '<button data-act="grave">To graveyard</button>'
          : '<button data-act="bottom">To bottom</button>'));
      btns.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (b) lookMove(id, b.dataset.act);
      });
      col.append(btns, n);
      box.appendChild(col);
    } else {
      box.appendChild(n);
    }
  });
  box.scrollLeft = sl;
}

function renderBanner() {
  const b = $('#h-banner');
  const look = state.look;
  let html = '';
  if (look) {
    const left = state.zones.look.length;
    html = `<span class="grow">${look.mode === 'scry' ? 'Scry' : 'Surveil'} · ${left} left</span>` +
      `<button data-act="toggle">${showHand ? 'Show cards' : 'Show hand'}</button>` +
      `<button data-act="lcancel">Cancel</button>`;
  }
  b.hidden = !html;
  if (b._html !== html) { b._html = html; b.innerHTML = html; }
}

/* Opening hand: buttons floating in the middle of the screen (they never cover a card name).
   The first mulligan is free and draws seven. After that: seven again, or one fewer than the
   current hand; at one card the hand is kept. */
function renderMull() {
  const box = $('#h-mull');
  const s = state.setup || {};
  let html = '';
  if (s.phase === 'mull' && !state.look && state.zones.hand.length) {
    const size = s.size || 7;
    if (s.mull) html += `<span class="mullcount">Mulligans: ${s.mull}</span>`;
    html += '<button data-n="7">Mulligan 7</button>';
    if (s.mull && size > 1) html += `<button data-n="${size - 1}">Mulligan ${size - 1}</button>`;
    html += '<button class="primary" data-act="keep">Keep hand</button>';
  }
  box.hidden = !html;
  if (box._html !== html) { box._html = html; box.innerHTML = html; }
}

/* A card in the hand: tap or hold = its menu, swipe up = play it face up.
   (Swiping sideways scrolls the hand, which cancels the tap.) */
function bindHandCard(node, id, mode) {
  let sx = 0, sy = 0, down = false, swiping = false, moved = false, timer = null;
  const reset = () => {
    clearTimeout(timer);
    down = false; swiping = false; moved = false;
    node.classList.remove('swiping');
    node.style.transform = '';
    node.style.opacity = '';
  };
  const open = () => (mode === 'look' ? openLookMenu(id) : openCardActions(id));
  node.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; down = true; swiping = false; moved = false;
    clearTimeout(timer);
    timer = holdTimer(e, () => {
      if (down && !swiping && !moved) { down = false; haptic(); open(); }
    });
  });
  node.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) { moved = true; clearTimeout(timer); }
    if (mode !== 'hand') return; // no swipe-to-play while scrying
    if (!swiping && dy < -12 && Math.abs(dy) > Math.abs(dx) * 1.2) {
      swiping = true;
      node.classList.add('swiping');
      try { node.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (swiping) {
      const up = Math.min(0, dy);
      node.style.transform = `translateY(${up}px) scale(${1 + up / 2500})`;
      node.style.opacity = String(Math.max(0.4, 1 + up / 500));
    }
  });
  node.addEventListener('pointerup', e => {
    if (!down && !swiping) return;
    const play = swiping && (e.clientY - sy) < -90;
    const tap = !moved && !swiping;
    reset();
    if (play) { haptic(); send({ t: 'move', id, to: 'battlefield', down: false }); }
    else if (tap) open();
  });
  node.addEventListener('pointercancel', reset);
}

function initHand() {
  $('#h-untap').onclick = () => send({ t: 'untap_all' });
  $('#h-next').onclick = () => send({ t: 'next_turn' });
  bindTurnCounter($('#h-turn'));
  $('#h-draw').onclick = () => send({ t: 'draw', n: parseInt($('#h-x').value, 10) || 1 });
  $('#h-menu').onclick = () => showMenu('Table (' + VERSION + ')', [
    { label: 'Scry', sub: lookSubs('scry') },
    { label: 'Surveil', sub: lookSubs('surveil') },
    { label: 'Change role / room', run: changeRole },
  ]);
  $('#h-banner').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const a = b.dataset.act;
    if (a === 'toggle') { showHand = !showHand; handSig = null; renderHand(); }
    else if (a === 'lcancel') { if (confirm('Put the remaining cards back on top, in their original order?')) send({ t: 'look_cancel' }); }
  });
  $('#h-mull').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.n) send({ t: 'mulligan', n: parseInt(b.dataset.n, 10) });
    else if (b.dataset.act === 'keep') send({ t: 'keep' });
  });
}

/* ======================================================================
   Tablet: board
   ====================================================================== */
const cardEls = new Map();
const trackerEls = new Map();
const ctrEls = new Map();
let boardReady = false;

function initBoard() {
  if (boardReady) return;
  boardReady = true;

  // Commander slots, graveyard, exile and library: a tap or a hold opens the menu,
  // a drag plays the top card on the table or sends it to another zone.
  // They are also drop targets (the library takes a dropped card on top).
  [0, 1].forEach(i => {
    const s = $('#cmd' + i);
    s.dataset.drop = 'command';
    const open = () => { if (s._cid) openCardActions(s._cid); };
    bindSource(s, { id: () => s._cid, tap: open, hold: open });
  });
  {
    const s = $('#z-graveyard');
    s.dataset.drop = 'graveyard';
    const open = () => openZoneTopMenu('graveyard');
    bindSource(s, { id: () => s._cid, tap: open, hold: open });
  }
  // exile: face-up cards in the top half, face-down cards in the bottom half
  $('#z-exile').dataset.drop = 'exile';
  [['up', $('#x-up')], ['down', $('#x-down')]].forEach(([half, el]) => {
    el.dataset.drop = 'exile';                      // each half takes drops: the lower one is face down
    el.dataset.down = half === 'down' ? '1' : '0';
    const open = () => openZoneTopMenu('exile', half);
    bindSource(el, { id: () => el._cid, tap: open, hold: open });
  });
  const lib = $('#z-library');
  lib.dataset.drop = 'library';
  const openLib = () => openZoneMenu('library');
  bindSource(lib, {
    tap: openLib,
    hold: openLib,
    id: () => {
      if (state.look) { toast('Finish the scry/surveil first.'); return null; }
      return state.zones.library[0] || null;
    },
  });
  bindFieldHold($('#field'));

  $('#side').addEventListener('click', e => {
    const b = e.target.closest('.tax button');
    if (b) send({ t: 'tax', slot: parseInt(b.dataset.slot, 10), delta: parseInt(b.dataset.d, 10) });
  });
  initTurnBar();
  $('#b-menu').onclick = openBoardMainMenu;
  $('#b-new').onclick = openLoadDialog;
  window.addEventListener('resize', () => { const b = $('#hb-cards'); if (b) b._sig = null; renderHandBar(); });
}

/* hold on empty table: create token / card, P/T tracker, counter */
function bindFieldHold(field) {
  let down = false, timer = null, sx = 0, sy = 0, pos = null;
  field.addEventListener('pointerdown', e => {
    if (e.target.closest('.card, .tracker, .gctr, .czone, #b-new')) return;
    down = true; sx = e.clientX; sy = e.clientY;
    const r = field.getBoundingClientRect();
    pos = {
      x: clamp((e.clientX - r.left) / r.width - 0.04, 0, 0.9),
      y: clamp((e.clientY - r.top) / r.height - 0.08, 0, 0.8),
    };
    clearTimeout(timer);
    timer = holdTimer(e, () => {
      if (!down) return;
      down = false; haptic();
      const p = pos;
      showMenu('Table', [
        { label: 'Create token / card', run: () => openTokenDialog(p.x, p.y) },
        { label: 'Add P/T tracker', run: () => send({ t: 'tracker_add', x: p.x, y: p.y }) },
        { label: 'Add counter', run: () => openCtrDialog(p.x, p.y) },
        { label: 'Add zone', run: openZoneDialog },
      ]);
    });
  });
  field.addEventListener('pointermove', e => {
    if (down && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { down = false; clearTimeout(timer); }
  });
  const stop = () => { down = false; clearTimeout(timer); };
  field.addEventListener('pointerup', stop);
  field.addEventListener('pointercancel', stop);
}

/* ---------- drag and drop between the table and the zones ----------
   Zone slots that accept drops carry data-drop="graveyard|exile|command|library". */
let dropHi = null;

function highlightDrop(slot) {
  if (dropHi === slot) return;
  if (dropHi) dropHi.classList.remove('dropover');
  dropHi = slot;
  if (slot) slot.classList.add('dropover');
}

/* Can this card be dropped on that zone slot? Returns the zone name, or '' */
function dropZoneFor(c, slot) {
  const to = slot && slot.dataset.drop;
  if (!to || !c) return '';
  // a card already in exile can still go to the other exile half (face up <-> face down)
  const turnOver = to === 'exile' && c.zone === 'exile' && !!c.down !== (slot.dataset.down === '1');
  if (c.zone === to && !turnOver) return '';
  if (to === 'command' && !c.commander) return '';
  return to;
}

function slotAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest('.xhalf[data-drop], .slot[data-drop]') : null;
}

function makeGhost(c) {
  const g = mk('div', 'dragghost', c.down ? BACK : imgHTML(c));
  document.body.appendChild(g);
  return g;
}

function moveGhost(g, x, y) { g.style.left = x + 'px'; g.style.top = y + 'px'; }

/* A zone slot that is a button and a drag source:
   tap -> opts.tap, hold -> opts.hold, drag -> drop on the table (play it face up)
   or on another zone. opts.id() gives the card that would be dragged (or null). */
function bindSource(slot, opts) {
  let down = false, held = false, moved = false;
  let ghost = null, dragId = null, timer = null, sx = 0, sy = 0;
  const cleanup = () => {
    clearTimeout(timer);
    down = false; held = false; moved = false; dragId = null;
    if (ghost) { ghost.remove(); ghost = null; }
    highlightDrop(null);
  };
  slot.addEventListener('pointerdown', e => {
    cleanup();
    down = true; sx = e.clientX; sy = e.clientY;
    try { slot.setPointerCapture(e.pointerId); } catch (_) {}
    timer = holdTimer(e, () => {
      if (down && !moved && opts.hold) { held = true; haptic(); opts.hold(); }
    });
  });
  slot.addEventListener('pointermove', e => {
    if (!down || held) return;
    if (!moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) {
      moved = true;
      clearTimeout(timer);
      dragId = opts.id ? opts.id() : null;
      const c = dragId && state.cards[dragId];
      if (c) ghost = makeGhost(c);
    }
    if (ghost) {
      moveGhost(ghost, e.clientX, e.clientY);
      const target = slotAt(e.clientX, e.clientY);
      highlightDrop(target && target !== slot && dropZoneFor(state.cards[dragId], target) ? target : null);
    }
  });
  slot.addEventListener('pointerup', e => {
    if (!down) return;
    const id = dragId, g = ghost, wasHeld = held, wasMoved = moved;
    if (g && id) {
      const c = state.cards[id];
      const target = slotAt(e.clientX, e.clientY);
      const field = $('#field');
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (target && target !== slot) {
        const to = dropZoneFor(c, target);
        if (to) send(dropMsg(id, to, target));
        else if (target.dataset.drop === 'command' && c && !c.commander) toast('Only a commander can go to the command zone.');
      } else if (el && field.contains(el)) {
        const r = field.getBoundingClientRect();
        send({
          t: 'move', id, to: 'battlefield', down: false,
          x: clamp((e.clientX - g.offsetWidth / 2 - r.left) / r.width, 0, 1),
          y: clamp((e.clientY - g.offsetHeight / 2 - r.top) / r.height, 0, 1),
        });
      }
    }
    cleanup();
    if (!wasHeld && !wasMoved && opts.tap) opts.tap();
  });
  slot.addEventListener('pointercancel', cleanup);
}

function buildBoardCard(id) {
  const node = mk('div', 'card');
  node.dataset.id = id;
  node.innerHTML = '<div class="face"></div><button class="zoombtn" aria-label="Zoom">🔍</button><div class="badges"></div>';
  node.querySelector('.zoombtn').addEventListener('click', e => {
    e.stopPropagation();
    openZoom(state.cards[id]);
  });
  node.querySelector('.badges').addEventListener('click', e => {
    e.stopPropagation();
    openCounters(id);
  });
  bindBoardCard(node, id);
  return node;
}

function updateBoardCard(node, c, z) {
  if (!node.classList.contains('dragging')) {
    node.style.left = (c.x * 100) + '%';
    node.style.top = (c.y * 100) + '%';
    node.style.zIndex = String(z + 1);
  }
  node.classList.toggle('tapped', !!c.tapped);
  node.classList.toggle('token', !!c.token);
  node.classList.toggle('copy', !!c.copy);

  const sig = c.down ? 'down' : ((flipped(c) ? c.img2 : c.img) || c.name);
  if (node._sig !== sig) {
    node._sig = sig;
    node.querySelector('.face').innerHTML = c.down ? BACK : imgHTML(c);
  }

  let html = '';
  const bp = c.p || 0, bt = c.t || 0;
  if (bp !== 0 || bt !== 0) {
    const net = bp + bt;
    html += `<span class="badge ${net > 0 ? 'pos' : (net < 0 ? 'neg' : '')}">${fmtPT(bp, bt)}</span>`;
  }
  Object.entries(c.counters || {}).forEach(([name, n]) => {
    html += `<span class="badge">${esc(name)} ×${n}</span>`;
  });
  if (node._bsig !== html) {
    node._bsig = html;
    node.querySelector('.badges').innerHTML = html;
  }
}

/* Cards on the table: tap = tap/untap, hold = menu, drag = move it. Dragging past the
   edge of the table turns into a drag-and-drop onto the graveyard, exile or command zone. */
function bindBoardCard(node, id) {
  let down = false, moved = false, held = false, timer = null, ghost = null;
  let sx = 0, sy = 0, startX = 0, startY = 0, rect = null;

  const endDrag = () => {
    if (ghost) { ghost.remove(); ghost = null; }
    node.style.opacity = '';
    highlightDrop(null);
    node.classList.remove('dragging');
  };
  const outsideField = e =>
    e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;

  node.addEventListener('pointerdown', e => {
    if (e.target.closest('.zoombtn, .badges')) return;
    const c = state.cards[id];
    if (!c) return;
    down = true; moved = false; held = false;
    sx = e.clientX; sy = e.clientY;
    startX = c.x; startY = c.y;
    rect = $('#field').getBoundingClientRect();
    try { node.setPointerCapture(e.pointerId); } catch (_) {}
    clearTimeout(timer);
    timer = holdTimer(e, () => {
      if (down && !moved) { held = true; haptic(); openBoardMenu(id); }
    });
  });

  node.addEventListener('pointermove', e => {
    if (!down || held) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) > 8) {
      moved = true;
      clearTimeout(timer);
      node.classList.add('dragging');
      node.style.pointerEvents = 'none'; // so a zone under the card can be found (the pointer stays captured)
    }
    if (!moved) return;
    const maxX = Math.max(0, 1 - node.offsetWidth / rect.width);
    const maxY = Math.max(0, 1 - node.offsetHeight / rect.height);
    const x = clamp(startX + dx / rect.width, 0, maxX);
    const y = clamp(startY + dy / rect.height, 0, maxY);
    node.style.left = (x * 100) + '%';
    node.style.top = (y * 100) + '%';
    node._x = x; node._y = y;

    // outside the table: carry a ghost copy and light up the zone under the finger
    const c = state.cards[id];
    // (a custom zone sits on top of the table, so a zone slot under the finger counts too)
    if (c && (outsideField(e) || slotAt(e.clientX, e.clientY))) {
      if (!ghost) { ghost = makeGhost(c); node.style.opacity = '0.35'; }
      moveGhost(ghost, e.clientX, e.clientY);
      const target = slotAt(e.clientX, e.clientY);
      highlightDrop(dropZoneFor(c, target) ? target : null);
    } else if (ghost) {
      endDrag();
      node.classList.add('dragging');
    }
  });

  node.addEventListener('pointerup', e => {
    if (!down) return;
    down = false;
    clearTimeout(timer);
    if (moved) {
      const c = state.cards[id];
      const target = slotAt(e.clientX, e.clientY);
      node.style.pointerEvents = '';
      const to = target ? dropZoneFor(c, target) : '';
      endDrag();
      if (to) {
        send(dropMsg(id, to, target));
      } else if (target) {
        // released on a zone that cannot take this card: put it back where it was
        if (target.dataset.drop === 'command' && c && !c.commander) toast('Only a commander can go to the command zone.');
        node.style.left = (startX * 100) + '%';
        node.style.top = (startY * 100) + '%';
      } else {
        send({ t: 'pos', id, x: node._x, y: node._y });
      }
    } else if (!held) {
      send({ t: 'tap', id });
    }
    held = false; moved = false;
  });

  node.addEventListener('pointercancel', () => {
    down = false; moved = false; held = false;
    clearTimeout(timer);
    node.style.pointerEvents = '';
    endDrag();
  });
}

/* ---------- table widgets: dragged by their header ---------- */
function makeDraggable(node, handle, id, msg, get) {
  let down = false, sx = 0, sy = 0, startX = 0, startY = 0, rect = null;
  handle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const w = get();
    if (!w) return;
    down = true; sx = e.clientX; sy = e.clientY; startX = w.x; startY = w.y;
    rect = $('#field').getBoundingClientRect();
    node.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });
  handle.addEventListener('pointermove', e => {
    if (!down) return;
    const x = clamp(startX + (e.clientX - sx) / rect.width, 0, Math.max(0, 1 - node.offsetWidth / rect.width));
    const y = clamp(startY + (e.clientY - sy) / rect.height, 0, Math.max(0, 1 - node.offsetHeight / rect.height));
    node.style.left = (x * 100) + '%';
    node.style.top = (y * 100) + '%';
    node._x = x; node._y = y;
  });
  const end = () => {
    if (!down) return;
    down = false;
    node.classList.remove('dragging');
    if (node._x != null) send({ t: msg, id, x: node._x, y: node._y });
    node._x = null;
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/* syncs the widgets of one kind with the state: builds new ones, removes old ones, places them */
function syncWidgets(els, items, build, fill) {
  const field = $('#field');
  for (const [id, n] of els) {
    if (!items[id]) { n.remove(); els.delete(id); }
  }
  Object.keys(items).forEach(id => {
    const it = items[id];
    let n = els.get(id);
    if (!n) { n = build(id); field.appendChild(n); els.set(id, n); }
    if (!n.classList.contains('dragging')) {
      n.style.left = (it.x * 100) + '%';
      n.style.top = (it.y * 100) + '%';
    }
    fill(n, it);
  });
}

/* ---------- P/T trackers ----------
   Top row: [power] [/] [toughness]. Under it a + and a - button, one of them lit.
   Tapping a number adds or subtracts 1 (whichever is lit); the / button changes both. */
const fmtMod = n => (n === 0 ? '0' : (n > 0 ? '+' : '−') + Math.abs(n));

function buildTracker(id) {
  const n = mk('div', 'tracker');
  n.innerHTML = `
    <div class="thandle">
      <span class="ttitle">Power / Toughness</span>
      <span class="tbtns">
        <button data-a="reset" aria-label="Reset">↺</button>
        <button data-a="del" aria-label="Remove">✕</button>
      </span>
    </div>
    <div class="tmain">
      <button data-w="p" class="tp"></button>
      <button data-w="pt" class="tslash" aria-label="Both">/</button>
      <button data-w="t" class="tt"></button>
    </div>
    <div class="tops">
      <button data-m="1" aria-label="Add">+</button>
      <button data-m="-1" aria-label="Subtract">−</button>
    </div>`;

  n.addEventListener('click', e => {
    const b = e.target.closest('button');
    const tr = state.trackers[id];
    if (!b || !tr) return;
    const m = tr.m < 0 ? -1 : 1;
    if (b.dataset.a === 'del') send({ t: 'tracker_del', id });
    else if (b.dataset.a === 'reset') send({ t: 'tracker_reset', id });
    else if (b.dataset.m) {
      const nm = parseInt(b.dataset.m, 10) < 0 ? -1 : 1;
      // already lit: tap again = power and toughness together
      if (nm === m) send({ t: 'tracker_mod', id, dp: nm, dt: nm });
      else send({ t: 'tracker_mode', id, m: nm });
    }
    else if (b.dataset.w) {
      const w = b.dataset.w;
      send({ t: 'tracker_mod', id, dp: w === 't' ? 0 : m, dt: w === 'p' ? 0 : m });
    }
  });
  makeDraggable(n, n.querySelector('.thandle'), id, 'tracker_pos', () => state.trackers[id]);
  return n;
}

function fillTracker(n, t) {
  const sign = v => (v > 0 ? ' pos' : (v < 0 ? ' neg' : ''));
  const p = n.querySelector('.tp'), q = n.querySelector('.tt');
  p.textContent = fmtMod(t.p); p.className = 'tp' + sign(t.p);
  q.textContent = fmtMod(t.t); q.className = 'tt' + sign(t.t);
  const m = t.m < 0 ? -1 : 1;
  n.querySelectorAll('.tops button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.m, 10) === m));
}

function renderTrackers() { syncWidgets(trackerEls, state.trackers, buildTracker, fillTracker); }

/* ---------- generic counters: a label (or a mana symbol) and a number ---------- */
const CTR_PRESETS = [
  { label: 'White', mana: 'W' }, { label: 'Blue', mana: 'U' }, { label: 'Black', mana: 'B' },
  { label: 'Red', mana: 'R' }, { label: 'Green', mana: 'G' }, { label: 'Colorless', mana: 'C' },
  { label: 'Storm' }, { label: 'Energy' }, { label: 'Experience' }, { label: 'Poison' },
];
const manaHTML = m => `<span class="mana ${esc(m)}">${esc(m)}</span>`;

function openCtrDialog(x, y) {
  closeDialog();
  const bd = mk('div', 'backdrop layer-dialog'); bd.id = 'dialog-bd';
  bd.innerHTML = `
    <div class="menu dialog">
      <h3>Add counter</h3>
      <div class="gpresets">${CTR_PRESETS.map(p =>
        `<button data-label="${esc(p.label)}" data-mana="${p.mana || ''}">` +
        `${p.mana ? manaHTML(p.mana) : ''}${esc(p.label)}</button>`).join('')}</div>
      <div class="cadd">
        <input id="gc-name" maxlength="20" placeholder="Custom counter (e.g. Rad)" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button id="gc-go" class="primary">Add</button>
      </div>
      <div class="dlg-actions"><button id="gc-close">Close</button></div>
    </div>`;
  bd.addEventListener('click', e => { if (e.target === bd) closeDialog(); });
  document.body.appendChild(bd);
  const add = (label, mana) => {
    if (!label) return;
    send({ t: 'ctr_add', label, mana: mana || '', x, y });
    closeDialog();
  };
  bd.querySelector('.gpresets').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) add(b.dataset.label, b.dataset.mana);
  });
  $('#gc-go').onclick = () => add($('#gc-name').value.trim());
  $('#gc-name').addEventListener('keydown', e => { if (e.key === 'Enter') add($('#gc-name').value.trim()); });
  $('#gc-close').onclick = closeDialog;
}

function buildCtr(id) {
  const n = mk('div', 'gctr');
  n.innerHTML = `
    <div class="thandle">
      <span class="glabel"></span>
      <span class="tbtns">
        <button data-a="reset" aria-label="Reset to zero">↺</button>
        <button data-a="del" aria-label="Remove">✕</button>
      </span>
    </div>
    <div class="gmain">
      <button data-d="-1" aria-label="Minus one">−</button>
      <span class="gnum">0</span>
      <button data-d="1" aria-label="Plus one">+</button>
    </div>`;
  n.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !state.ctrs[id]) return;
    if (b.dataset.a === 'del') send({ t: 'ctr_del', id });
    else if (b.dataset.a === 'reset') send({ t: 'ctr_reset', id });
    else if (b.dataset.d) send({ t: 'ctr_mod', id, delta: parseInt(b.dataset.d, 10) });
  });
  makeDraggable(n, n.querySelector('.thandle'), id, 'ctr_pos', () => state.ctrs[id]);
  return n;
}

function fillCtr(n, k) {
  const sig = k.mana + '|' + k.label;
  if (n._sig !== sig) {
    n._sig = sig;
    n.querySelector('.glabel').innerHTML = (k.mana ? manaHTML(k.mana) : '') + `<span>${esc(k.label)}</span>`;
  }
  n.querySelector('.gnum').textContent = k.n;
}

function renderCtrs() { syncWidgets(ctrEls, state.ctrs, buildCtr, fillCtr); }

/* ---------- hand count: one card back per card in hand ---------- */
/* "DREW 3 CARDS": a big grey text on the table that fades out over 3 seconds, so everybody sees draws */
let lastDrewSeq = null, lastMilledSeq = null, gotState = false;
/* "DREW 3 CARDS" / "MILLED 3 CARDS": big grey text on the table that fades out over 3 seconds */
function announce(word, n) {
  const f = $('#drawflag');
  f.textContent = `${word} ${n} CARD${n === 1 ? '' : 'S'}`;
  f.classList.remove('show');
  void f.offsetWidth; // restart the fade for a new announcement
  f.classList.add('show');
}

function renderDrew() {
  const d = state.drew || { n: 0, seq: 0 };
  const m = state.milled || { n: 0, seq: 0 };
  const firstLook = lastDrewSeq === null; // do not announce an old draw or mill when the page opens
  const drewNew = !firstLook && d.seq !== lastDrewSeq;
  const milledNew = lastMilledSeq !== null && m.seq !== lastMilledSeq;
  lastDrewSeq = d.seq; lastMilledSeq = m.seq;
  if (milledNew && m.n) announce('MILLED', m.n);
  else if (drewNew && d.n) announce('DREW', d.n);
}

function renderHandBar() {
  const n = state.zones.hand.length;
  $('#hb-n').textContent = n;
  $('#t-n').textContent = state.turn || 0;
  $('#t-undo-n').textContent = state.undo || 0;
  $('#t-undo').disabled = !state.undo;
  renderDrew();
  const box = $('#hb-cards');
  const W = box.clientWidth;
  const sig = n + '|' + W;
  if (box._sig === sig) return;
  box._sig = sig;
  box.innerHTML = '';
  const cw = 46;
  // spacing between cards: a small gap when they fit, overlap when they do not
  const sp = n > 1 && W > 0 ? Math.min(8, (W - n * cw) / (n - 1)) : 0;
  for (let i = 0; i < n; i++) {
    const d = mk('div', 'hb back');
    d.style.marginRight = (i < n - 1 ? sp : 0) + 'px';
    box.appendChild(d);
  }
}

function renderBoard() {
  const field = $('#field');
  const ids = state.zones.battlefield;
  const seen = new Set(ids);
  for (const [id, node] of cardEls) {
    if (!seen.has(id)) { node.remove(); cardEls.delete(id); }
  }
  ids.forEach((id, i) => {
    const c = state.cards[id];
    if (!c) return;
    let node = cardEls.get(id);
    if (!node) {
      node = buildBoardCard(id);
      field.appendChild(node);
      cardEls.set(id, node);
    }
    updateBoardCard(node, c, i);
  });
  renderTrackers();
  renderCtrs();
  renderHandBar();
  renderSide();
  renderCZones();
}

function fillExileHalf(el, ids, down) {
  const top = ids.length ? state.cards[ids[ids.length - 1]] : null;
  el._cid = top ? top.id : null;
  el.className = 'xhalf ' + (down ? 'dn' : 'up') + (top ? '' : ' empty');
  const html = `<div class="xrot">${top ? (down ? BACK : imgHTML(top)) : ''}</div>` +
    (top ? `<span class="count">${ids.length}</span>` : '') +
    `<span class="xtag">${down ? 'Face down' : 'Face up'}</span>`;
  if (el._html !== html) { el._html = html; el.innerHTML = html; }
}

/* ---------- custom zones (top right of the table) ---------- */
const czEls = new Map();

function openZoneDialog() {
  closeDialog();
  const bd = mk('div', 'backdrop layer-dialog'); bd.id = 'dialog-bd';
  bd.innerHTML = `
    <div class="menu dialog">
      <h3>Add zone</h3>
      <div class="gpresets">${['Plotted', 'Adventure', 'Foretold', 'Emblems'].map(n =>
        `<button data-n="${n}">${n}</button>`).join('')}</div>
      <div class="cadd">
        <input id="cz-name" maxlength="20" placeholder="Zone name" autocomplete="off" autocapitalize="off" spellcheck="false">
        <button id="cz-go" class="primary">Add</button>
      </div>
      <div class="dlg-actions"><button id="cz-close">Close</button></div>
    </div>`;
  bd.addEventListener('click', e => { if (e.target === bd) closeDialog(); });
  document.body.appendChild(bd);
  const add = name => { if (name) { send({ t: 'czone_add', name }); closeDialog(); } };
  bd.querySelector('.gpresets').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) add(b.dataset.n);
  });
  $('#cz-go').onclick = () => add($('#cz-name').value.trim());
  $('#cz-name').addEventListener('keydown', e => { if (e.key === 'Enter') add($('#cz-name').value.trim()); });
  $('#cz-close').onclick = closeDialog;
}

function buildCZone(id) {
  const n = mk('div', 'czone');
  n.innerHTML = '<div class="czhead"><span class="czname"></span><button class="czdel" aria-label="Remove zone">✕</button></div><div class="slot"></div>';
  const slot = n.querySelector('.slot');
  slot.dataset.drop = id;
  const open = () => openZoneTopMenu(id);
  bindSource(slot, { id: () => slot._cid, tap: open, hold: open });
  n.querySelector('.czdel').addEventListener('click', () => {
    if (confirm(`Remove "${state.czones[id]}"? Its cards go to the graveyard (tokens disappear).`)) send({ t: 'czone_del', zone: id });
  });
  return n;
}

function renderCZones() {
  const box = $('#czones');
  const zs = state.czones || {};
  for (const [id, n] of czEls) {
    if (!zs[id]) { n.remove(); czEls.delete(id); }
  }
  Object.keys(zs).forEach(id => {
    let n = czEls.get(id);
    if (!n) { n = buildCZone(id); box.appendChild(n); czEls.set(id, n); }
    const list = (state.zones[id] || []).filter(i => state.cards[i]);
    const top = list.length ? state.cards[list[list.length - 1]] : null;
    const slot = n.querySelector('.slot');
    slot._cid = top ? top.id : null;
    slot.className = 'slot' + (top ? '' : ' empty');
    const html = top ? imgHTML(top) + `<span class="count">${list.length}</span>` : '';
    if (slot._html !== html) { slot._html = html; slot.innerHTML = html; }
    n.querySelector('.czname').textContent = zs[id];
  });
}

/* ---------- turn counter, untap all, next turn (board bar and phone header) ---------- */
/* tap = +1; hold = a small menu to go back a turn or reset (in case of a mis-tap) */
function bindTurnCounter(tc) {
  let down = false, held = false, timer = null;
  tc.addEventListener('pointerdown', e => {
    down = true; held = false;
    clearTimeout(timer);
    timer = holdTimer(e, () => {
      if (!down) return;
      held = true; haptic();
      showMenu('Turn ' + (state.turn || 0), [
        { label: 'Back one turn', run: () => send({ t: 'turn_set', delta: -1 }) },
        { label: 'Reset to turn 0', run: () => send({ t: 'turn_set', reset: true }) },
      ]);
    });
  });
  tc.addEventListener('pointerup', () => {
    clearTimeout(timer);
    if (down && !held) send({ t: 'turn_set', delta: 1 });
    down = false;
  });
  const stop = () => { clearTimeout(timer); down = false; };
  tc.addEventListener('pointerleave', stop);
  tc.addEventListener('pointercancel', stop);
}

function initTurnBar() {
  $('#t-untap').onclick = () => send({ t: 'untap_all' });
  $('#t-undo').onclick = () => send({ t: 'undo' });
  $('#t-next').onclick = () => send({ t: 'next_turn' });
  bindTurnCounter($('#t-turn'));
}

function renderSide() {
  const cards = Object.values(state.cards);

  [0, 1].forEach(i => {
    const slot = $('#cmd' + i);
    const c = cards.find(x => x.commander && x.slot === i);
    slot._cid = null;
    if (!c) {
      slot.className = 'slot empty';
      slot.innerHTML = '';
    } else {
      const inZone = c.zone === 'command';
      slot.className = 'slot' + (inZone ? '' : ' ghost');
      slot.innerHTML = imgHTML(c);
      if (inZone) slot._cid = c.id;
    }
    $('#tax' + i).textContent = (state.tax && state.tax[i]) || 0;
  });

  {
    const ids = state.zones.graveyard;
    const slot = $('#z-graveyard');
    const top = ids.length ? state.cards[ids[ids.length - 1]] : null;
    slot._cid = top ? top.id : null;
    slot.className = 'slot' + (top ? '' : ' empty');
    slot.innerHTML = top ? imgHTML(top) + `<span class="count">${ids.length}</span>` : '';
    $('#n-graveyard').textContent = ids.length;
  }
  {
    const ex = state.zones.exile.filter(i => state.cards[i]);
    fillExileHalf($('#x-up'), ex.filter(i => !state.cards[i].down), false);
    fillExileHalf($('#x-down'), ex.filter(i => state.cards[i].down), true);
    $('#n-exile').textContent = ex.length;
  }

  const lf = $('#lookflag');
  lf.hidden = !state.look;
  if (state.look) lf.textContent = state.look.mode === 'scry' ? 'SCRYING' : 'SURVEILING';

  const lib = $('#z-library');
  const n = state.zones.library.length;
  lib.className = 'slot' + (n ? '' : ' empty');
  lib.innerHTML = n ? `${BACK}<span class="count">${n}</span>` : '';
  const look = state.look;
  $('#n-library').textContent = look ? `${n} · ${look.mode === 'scry' ? 'Scry' : 'Surveil'} ${state.zones.look.length}` : n;

  $('#empty-state').hidden = cards.length > 0;
}

/* ======================================================================
   Render dispatcher + startup
   ====================================================================== */
function render() {
  if (role === 'hand') renderHand();
  else if (role === 'board') renderBoard();
  if (viewer) renderViewer();
  if (counterId) renderCounters();
}

function start(r, roomName) {
  role = r;
  room = (roomName || 'table').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'table';
  try { localStorage.setItem('tt-room', room); } catch (_) {}
  $('#connect').hidden = true;
  if (role === 'hand') {
    $('#hand-view').hidden = false;
    initHand();
  } else {
    $('#board-view').hidden = false;
    $('#b-room').textContent = room;
    initBoard();
  }
  connect();
  render();
}

function init() {
  document.querySelectorAll('.ver').forEach(e => { e.textContent = VERSION; });
  const q = new URLSearchParams(location.search);
  let saved = '';
  try { saved = localStorage.getItem('tt-room') || ''; } catch (_) {}
  const r = q.get('room') || saved || 'table';
  $('#room-input').value = r;
  const wanted = q.get('role');
  if (wanted === 'hand' || wanted === 'board') { start(wanted, r); return; }
  $('#btn-board').onclick = () => start('board', $('#room-input').value);
  $('#btn-hand').onclick = () => start('hand', $('#room-input').value);
}

init();
})();