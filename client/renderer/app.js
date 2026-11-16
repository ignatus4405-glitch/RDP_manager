'use strict';
/**
 * RDP Manager — логика клиентского приложения (renderer).
 */

/* ================= Состояние ================= */
const browserOrigin = (typeof window !== 'undefined' && /^https?:$/.test(window.location?.protocol)) ? window.location.origin : null;
const DEFAULT_SERVER = browserOrigin || 'http://localhost:8720';

const state = {
  serverUrl: (localStorage.getItem('rdp_server_url') || DEFAULT_SERVER).replace(/\/+$/, ''),
  token: sessionStorage.getItem('rdp_token') || null,
  user: null,
  typeFilter: '',
  connections: [],
  meta: { categories: [], tags: [], typeCounts: [] },
  docs: [],
  currentDocId: null,
};

const TYPE_LABEL = { rdp: 'RDP', anydesk: 'AnyDesk', rustdesk: 'RustDesk' };

/* ================= Утилиты ================= */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(message, isError = false) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(state.serverUrl + '/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (res.status === 401) {
    if (state.token) { logout(); throw new Error('Сессия истекла — войдите снова'); }
    throw new Error(data.error || 'Неверные учётные данные');
  }
  if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
  return data;
}

const isAdmin = () => state.user?.role === 'admin';

/* ================= Модалка ================= */
function openModal(title, bodyHtml, footerButtons) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  $('modalFooter').innerHTML = '';
  for (const btn of footerButtons) {
    const b = document.createElement('button');
    b.textContent = btn.label;
    b.className = btn.class || 'btn-ghost';
    b.addEventListener('click', btn.onClick);
    $('modalFooter').appendChild(b);
  }
  $('modalBackdrop').classList.remove('hidden');
}
const closeModal = () => $('modalBackdrop').classList.add('hidden');
$('modalClose').addEventListener('click', closeModal);
$('modalBackdrop').addEventListener('click', (e) => { if (e.target === $('modalBackdrop')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

/* ================= Вход / выход ================= */
$('serverUrl').value = state.serverUrl;

async function doLogin() {
  const serverUrl = $('serverUrl').value.trim().replace(/\/+$/, '');
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;
  $('loginError').textContent = '';
  if (!/^https?:\/\//i.test(serverUrl)) { $('loginError').textContent = 'Адрес сервера должен начинаться с http:// или https://'; return; }
  if (!username || !password) { $('loginError').textContent = 'Введите логин и пароль'; return; }

  state.serverUrl = serverUrl;
  localStorage.setItem('rdp_server_url', serverUrl);

  const btn = $('btnLogin');
  btn.disabled = true; btn.textContent = 'Подключаемся…';
  try {
    // Без токена в заголовке — это логин
    const res = await fetch(serverUrl + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка сервера (${res.status})`);
    state.token = data.token;
    state.user = data.user;
    sessionStorage.setItem('rdp_token', state.token);
    enterApp();
  } catch (err) {
    $('loginError').textContent = err.message.includes('fetch') ? 'Не удалось связаться с сервером. Проверьте адрес и сеть.' : err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Войти';
  }
}

function logout() {
  state.token = null; state.user = null;
  sessionStorage.removeItem('rdp_token');
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('loginPassword').value = '';
}

$('btnLogin').addEventListener('click', doLogin);
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('loginUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
$('btnLogout').addEventListener('click', logout);

/* ================= Переход между разделами ================= */
document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('main .view').forEach((v) => v.classList.toggle('hidden', v.id !== btn.dataset.view));
    if (btn.dataset.view === 'usersView') loadUsers();
    if (btn.dataset.view === 'docsView') loadDocuments();
  });
});

function applyRoleVisibility() {
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
}

async function enterApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('sideServer').textContent = state.serverUrl.replace(/^https?:\/\//, '');
  $('userName').textContent = state.user.full_name || state.user.username;
  $('userAvatar').textContent = (state.user.full_name || state.user.username || '?').trim().charAt(0).toUpperCase();
  $('userRole').textContent = state.user.role === 'admin' ? 'Администратор' : 'Сотрудник';
  $('mustChangeBanner').classList.toggle('hidden', !state.user.must_change_password);
  $('profUsername').textContent = state.user.username;
  $('profFullName').textContent = state.user.full_name || '—';
  $('profRole').textContent = state.user.role === 'admin' ? 'Администратор' : 'Сотрудник';
  $('profServer').textContent = state.serverUrl;
  applyRoleVisibility();
  await loadConnections();
}

/* ================= Подключения ================= */
async function loadMeta() {
  try {
    state.meta = await api('/connections/meta');
    const catSel = $('connCategory');
    const cur = catSel.value;
    catSel.innerHTML = '<option value="all">Все категории</option>' +
      state.meta.categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.count})</option>`).join('');
    catSel.value = cur || 'all';

    const tagSel = $('connTag');
    const curTag = tagSel.value;
    tagSel.innerHTML = '<option value="">Все теги</option>' +
      state.meta.tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    tagSel.value = curTag || '';

    const counts = { rdp: 0, anydesk: 0, rustdesk: 0 };
    for (const row of state.meta.typeCounts) counts[row.type] = row.count;
    const total = counts.rdp + counts.anydesk + counts.rustdesk;
    $('cntAll').textContent = total || '';
    $('cntRdp').textContent = counts.rdp || '';
    $('cntAnydesk').textContent = counts.anydesk || '';
    $('cntRustdesk').textContent = counts.rustdesk || '';
  } catch (err) { /* метаданные не критичны */ }
}

async function loadConnections() {
  const params = new URLSearchParams();
  const search = $('connSearch').value.trim();
  const category = $('connCategory').value;
  const tag = $('connTag').value;
  if (search) params.set('search', search);
  if (category && category !== 'all') params.set('category', category);
  if (tag) params.set('tag', tag);
  if (state.typeFilter) params.set('type', state.typeFilter);

  try {
    const { connections } = await api('/connections?' + params.toString());
    state.connections = connections;
    renderConnections();
    loadMeta();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderConnections() {
  const grid = $('connectionsGrid');
  $('connectionsEmpty').classList.toggle('hidden', state.connections.length !== 0);
  grid.innerHTML = state.connections.map((c) => `
    <article class="conn-card" data-id="${c.id}">
      ${isAdmin() ? `
        <div class="admin-tools">
          <button data-action="edit" title="Редактировать">✏️</button>
          <button data-action="delete" title="Удалить">🗑️</button>
        </div>` : ''}
      <span class="conn-type ${esc(c.type)}">${TYPE_LABEL[c.type] || esc(c.type)}</span>
      <div class="conn-name">${esc(c.name)}</div>
      <div class="conn-addr" title="${esc(c.address)}">${esc(c.address)}${c.type === 'rdp' && c.port && c.port !== 3389 ? ':' + c.port : ''}</div>
      ${c.description ? `<div class="conn-desc">${esc(c.description)}</div>` : '<div class="conn-desc"></div>'}
      <div class="conn-meta">
        <span class="chip cat">${esc(c.category)}</span>
        ${c.tags ? c.tags.split(',').map((t) => t.trim()).filter(Boolean).map((t) => `<span class="chip">${esc(t)}</span>`).join('') : ''}
        ${c.username ? `<span class="chip" title="Имя пользователя">👤 ${esc(c.username)}</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn-primary" data-action="launch">Подключить →</button>
      </div>
    </article>`).join('');
}

/* ================= Встроенная RDP-сессия (ironrdp-wasm, как в RDM) ================= */
const RDP_SCANCODE_MAP = {
  'Escape': 0x01, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
  'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
  'Digit8': 0x09, 'Digit9': 0x0A, 'Digit0': 0x0B, 'Minus': 0x0C,
  'Equal': 0x0D, 'Backspace': 0x0E, 'Tab': 0x0F,
  'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13,
  'KeyT': 0x14, 'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17,
  'KeyO': 0x18, 'KeyP': 0x19, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
  'Enter': 0x1C, 'ControlLeft': 0x1D,
  'KeyA': 0x1E, 'KeyS': 0x1F, 'KeyD': 0x20, 'KeyF': 0x21,
  'KeyG': 0x22, 'KeyH': 0x23, 'KeyJ': 0x24, 'KeyK': 0x25,
  'KeyL': 0x26, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
  'ShiftLeft': 0x2A, 'Backslash': 0x2B,
  'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E, 'KeyV': 0x2F,
  'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32, 'Comma': 0x33,
  'Period': 0x34, 'Slash': 0x35, 'ShiftRight': 0x36,
  'NumpadMultiply': 0x37, 'AltLeft': 0x38, 'Space': 0x39,
  'CapsLock': 0x3A,
  'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E,
  'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
  'F9': 0x43, 'F10': 0x44,
  'NumLock': 0x45, 'ScrollLock': 0x46,
  'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
  'NumpadSubtract': 0x4A, 'Numpad4': 0x4B, 'Numpad5': 0x4C,
  'Numpad6': 0x4D, 'NumpadAdd': 0x4E, 'Numpad1': 0x4F,
  'Numpad2': 0x50, 'Numpad3': 0x51, 'Numpad0': 0x52,
  'NumpadDecimal': 0x53,
  'F11': 0x57, 'F12': 0x58,
  'NumpadEnter': 0xE01C, 'ControlRight': 0xE01D,
  'NumpadDivide': 0xE035, 'PrintScreen': 0xE037,
  'AltRight': 0xE038, 'Home': 0xE047, 'ArrowUp': 0xE048,
  'PageUp': 0xE049, 'ArrowLeft': 0xE04B, 'ArrowRight': 0xE04D,
  'End': 0xE04F, 'ArrowDown': 0xE050, 'PageDown': 0xE051,
  'Insert': 0xE052, 'Delete': 0xE053,
  'MetaLeft': 0xE05B, 'MetaRight': 0xE05C, 'ContextMenu': 0xE05D,
  'Pause': 0xE11D45,
};

/** Состояние встроенной RDP-сессии */
const rdpSession = {
  conn: null,
  session: null,
  clipboardReady: false,
  inputAttached: false,
};

const rdpConnAddress = (conn) =>
  `${conn.address}${conn.type === 'rdp' && conn.port && conn.port !== 3389 ? ':' + conn.port : ''}`;

const rdpGatewayBase = () => `${state.serverUrl.replace(/^http(s?)/, 'ws$1')}/ws/rdp`;

function setRdpStatus(text, kind = 'idle') {
  const el = $('rdpStatus');
  el.textContent = text;
  el.dataset.kind = kind;
}

function showRdpForm(show) {
  $('rdpConnectForm').classList.toggle('hidden', !show);
  $('rdpScreenWrap').classList.toggle('hidden', show);
}

/** Текст ошибки RDP с учётом IronErrorKind из WASM */
function rdpErrorText(err) {
  try {
    if (err && typeof err.kind === 'function') {
      const kind = err.kind();
      if (kind === 1) return 'Неверный пароль (WrongPassword).';
      if (kind === 2) return 'Вход на компьютер отклонён (LogonFailure).';
      if (kind === 3) return 'Недостаточно прав (AccessDenied).';
      if (kind === 4) return 'Ошибка RDCleanPath-обмена со шлюзом.';
      if (kind === 5) return 'Не удалось подключиться к RDP-шлюзу на сервере.';
      if (kind === 6) return 'Не удалось согласовать параметры RDP (NegotiationFailure). Узел требует NLA/TLS или не отвечает.';
    }
  } catch { /* не IronError — отдаём message */ }
  const msg = String(err?.message || err || 'Неизвестная ошибка');
  if (/\b403\b/.test(msg)) return 'Шлюз отклонил цель: подключение не найдено в базе RDP Manager.';
  return msg;
}

function openEmbeddedRdp(conn) {
  rdpSession.conn = conn;
  $('rdpConnName').textContent = conn.name || conn.address;
  $('rdpConnAddr').textContent = rdpConnAddress(conn);
  $('rdpFormName').textContent = conn.name || conn.address;
  $('rdpUsername').value = conn.username || '';
  $('rdpPassword').value = '';
  $('rdpFormError').textContent = '';
  $('rdpScreenHint').textContent = 'Подключение…';
  $('rdpScreenHint').classList.remove('hidden');
  $('rdpScreenWrap').classList.remove('fill');
  showRdpForm(true);
  setRdpStatus('Не подключено', 'idle');
  $('rdpDisconnectBtn').disabled = true;
  $('rdpOverlay').classList.remove('hidden');
  setTimeout(() => $('rdpPassword').focus(), 60);
}

function teardownRdpSession() {
  const s = rdpSession.session;
  rdpSession.session = null;
  rdpSession.clipboardReady = false;
  if (s) { try { s.shutdown(); } catch { /* уже завершена */ } }
  $('rdpDisconnectBtn').disabled = true;
}

function closeEmbeddedRdp() {
  teardownRdpSession();
  const canvas = $('rdpCanvas');
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('rdpOverlay').classList.add('hidden');
}

/** Буфер обмена: remote → clipboard браузера, local → remote по запросу RDCleanPath */
function setupRdpClipboard(builder, IronRDP) {
  builder.remoteClipboardChangedCallback((clipboardData) => {
    rdpSession.clipboardReady = true;
    try {
      if (!clipboardData || clipboardData.isEmpty()) return;
      const textItem = clipboardData.items().find((item) => String(item.mimeType()).includes('text/plain'));
      const value = textItem && textItem.value();
      if (typeof value === 'string' && value) navigator.clipboard?.writeText(value).catch(() => {});
    } catch (err) {
      console.warn('Clipboard (remote→local):', err);
    }
  });

  builder.forceClipboardUpdateCallback(async () => {
    if (rdpSession.clipboardReady) return;
    rdpSession.clipboardReady = true;
    try {
      const text = await navigator.clipboard.readText();
      const data = new IronRDP.ClipboardData();
      if (text) data.addText('text/plain', text);
      if (rdpSession.session) await rdpSession.session.onClipboardPaste(data);
    } catch {
      try {
        const data = new IronRDP.ClipboardData();
        if (rdpSession.session) await rdpSession.session.onClipboardPaste(data);
      } catch { /* буфер недоступен — не критично */ }
    }
  });
}

/** Клавиатура/мышь/колесо на canvas. Обработчики подключаются один раз. */
function attachRdpInputOnce() {
  if (rdpSession.inputAttached) return;
  rdpSession.inputAttached = true;

  const canvas = $('rdpCanvas');
  const applyTx = (build) => {
    const session = rdpSession.session;
    if (!session || !window.IronRDP) return;
    try {
      const tx = new window.IronRDP.InputTransaction();
      build(tx, window.IronRDP.DeviceEvent);
      session.applyInputs(tx);
    } catch (err) {
      console.warn('RDP input:', err);
    }
  };

  canvas.addEventListener('keydown', (e) => {
    const scancode = RDP_SCANCODE_MAP[e.code];
    if (scancode == null) return;
    e.preventDefault();
    applyTx((tx, DE) => tx.addEvent(DE.keyPressed(scancode)));
  });
  canvas.addEventListener('keyup', (e) => {
    const scancode = RDP_SCANCODE_MAP[e.code];
    if (scancode == null) return;
    e.preventDefault();
    applyTx((tx, DE) => tx.addEvent(DE.keyReleased(scancode)));
  });
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    applyTx((tx, DE) => tx.addEvent(DE.mouseMove(x, y)));
  });
  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    canvas.focus();
    applyTx((tx, DE) => tx.addEvent(DE.mouseButtonPressed(e.button)));
  });
  canvas.addEventListener('mouseup', (e) => {
    e.preventDefault();
    applyTx((tx, DE) => tx.addEvent(DE.mouseButtonReleased(e.button)));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const amount = (e.deltaY !== 0 ? (e.deltaY > 0 ? -1 : 1) : 0);
    applyTx((tx, DE) => {
      if (e.deltaY !== 0) tx.addEvent(DE.wheelRotations(true, amount, 1));
      if (e.deltaX !== 0) tx.addEvent(DE.wheelRotations(false, e.deltaX > 0 ? -1 : 1, 1));
    });
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function startEmbeddedRdp() {
  const conn = rdpSession.conn;
  if (!conn) return;
  const username = $('rdpUsername').value.trim();
  const password = $('rdpPassword').value;
  const formError = $('rdpFormError');
  formError.textContent = '';
  if (!password) { formError.textContent = 'Введите пароль'; return; }
  if (!window.IronRDP) {
    formError.textContent = 'Встроенный RDP не собран: отсутствует vendor/ironrdp/bundle.js (npm run build:ironrdp --workspace client).';
    return;
  }

  const connectBtn = $('rdpConnectBtn');
  connectBtn.disabled = true;
  const destination = rdpConnAddress(conn);

  try {
    const IronRDP = window.IronRDP;
    await IronRDP.init();
    try { IronRDP.setup('info'); } catch { /* логирование не критично */ }

    // Размер десктопа: почти весь экран, чётные значения, не больше 1920×1080
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    const width = Math.min(1920, Math.max(800, even(window.innerWidth - 80)));
    const height = Math.min(1080, Math.max(600, even(window.innerHeight - 220)));

    const canvas = $('rdpCanvas');
    canvas.width = width;
    canvas.height = height;

    const enableCredssp = new IronRDP.Extension('enable_credssp', true);
    const builder = new IronRDP.SessionBuilder();
    builder.username(username);
    builder.password(password);
    builder.destination(destination);
    builder.proxyAddress(rdpGatewayBase());
    builder.authToken('none');
    builder.desktopSize(new IronRDP.DesktopSize(width, height));
    builder.renderCanvas(canvas);
    builder.extension(enableCredssp);
    builder.setCursorStyleCallbackContext(canvas);
    builder.setCursorStyleCallback((style) => { canvas.style.cursor = style || 'default'; });
    setupRdpClipboard(builder, IronRDP);

    showRdpForm(false);
    setRdpStatus('Подключение…', 'connecting');
    $('rdpScreenHint').classList.remove('hidden');
    $('rdpScreenHint').textContent = `Подключение к ${destination}…`;

    const session = await builder.connect();
    rdpSession.session = session;
    rdpSession.clipboardReady = false;

    const ds = session.desktopSize();
    canvas.width = ds.width;
    canvas.height = ds.height;

    attachRdpInputOnce();
    $('rdpPassword').value = '';
    $('rdpDisconnectBtn').disabled = false;
    setRdpStatus(`Подключено · ${ds.width}×${ds.height}`, 'connected');
    $('rdpScreenHint').classList.add('hidden');
    canvas.focus();

    session.run().then((info) => {
      let reason = '';
      try { reason = info?.reason ? info.reason() : ''; } catch { /* ignore */ }
      teardownRdpSession();
      showRdpForm(true);
      setRdpStatus(reason ? `Сессия завершена (${reason})` : 'Сессия завершена', 'idle');
    }).catch((err) => {
      teardownRdpSession();
      showRdpForm(true);
      $('rdpFormError').textContent = rdpErrorText(err);
      setRdpStatus('Ошибка сессии', 'error');
    });
  } catch (err) {
    rdpSession.session = null;
    showRdpForm(true);
    formError.textContent = rdpErrorText(err);
    setRdpStatus('Ошибка подключения', 'error');
  } finally {
    connectBtn.disabled = false;
  }
}

$('rdpConnectForm').addEventListener('submit', (e) => { e.preventDefault(); startEmbeddedRdp(); });
$('rdpDisconnectBtn').addEventListener('click', () => {
  teardownRdpSession();
  showRdpForm(true);
  setRdpStatus('Отключено', 'idle');
});
$('rdpCloseBtn').addEventListener('click', closeEmbeddedRdp);
$('rdpOverlay').addEventListener('keydown', (e) => {
  // Esc закрывает окно только вне canvas — при фокусе canvas Esc уходит в удалённый сеанс
  if (e.key === 'Escape' && e.target !== $('rdpCanvas')) closeEmbeddedRdp();
});
$('rdpFillBtn').addEventListener('click', () => {
  $('rdpScreenWrap').classList.toggle('fill');
});
$('rdpExternalBtn').addEventListener('click', () => {
  const conn = rdpSession.conn;
  if (!conn) return;
  if (window.rdpManager?.launch) {
    window.rdpManager.launch({ type: 'rdp', name: conn.name, address: conn.address, port: conn.port, username: conn.username })
      .then((r) => toast(r.message, !r.ok));
  } else {
    toast('Внешний запуск доступен в десктоп-приложении', true);
  }
});

/** Запуск подключения: RDP — во встроенном окне (как в RDM); AnyDesk/RustDesk — нативными обработчиками */
async function launchConnection(conn, btn) {
  if (conn.type === 'rdp') {
    openEmbeddedRdp(conn);
    return;
  }
  if (window.rdpManager?.launch) {
    btn.disabled = true;
    const result = await window.rdpManager.launch({ type: conn.type, name: conn.name, address: conn.address, port: conn.port, username: conn.username });
    btn.disabled = false;
    toast(result.message, !result.ok);
    return;
  }
  // Режим браузера: AnyDesk/RustDesk открываются по protocol handler
  const id = String(conn.address || '').replace(/\s+/g, '');
  if (conn.type === 'anydesk') { window.location.href = 'anydesk:' + id; toast('Передаю AnyDesk системному обработчику…'); }
  else if (conn.type === 'rustdesk') { window.location.href = 'rustdesk://' + id; toast('Передаю RustDesk системному обработчику…'); }
  else toast(`Неизвестный тип подключения: ${conn.type}`, true);
}

$('connectionsGrid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const card = btn.closest('.conn-card');
  const conn = state.connections.find((c) => c.id === Number(card.dataset.id));
  if (!conn) return;

  const action = btn.dataset.action;
  if (action === 'launch') {
    await launchConnection(conn, btn);
  } else if (action === 'edit') {
    openConnectionModal(conn);
  } else if (action === 'delete') {
    if (!confirm(`Удалить подключение «${conn.name}»?`)) return;
    try { await api('/connections/' + conn.id, { method: 'DELETE' }); toast('Подключение удалено'); loadConnections(); }
    catch (err) { toast(err.message, true); }
  }
});

$('connSearch').addEventListener('input', debounce(loadConnections));
$('connCategory').addEventListener('change', loadConnections);
$('connTag').addEventListener('change', loadConnections);
$('typePills').addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  state.typeFilter = pill.dataset.type;
  document.querySelectorAll('#typePills .pill').forEach((p) => p.classList.toggle('active', p === pill));
  loadConnections();
});

/* ---------- Модалка подключения ---------- */
function openConnectionModal(conn) {
  const isEdit = !!conn;
  const c = conn || { type: 'rdp', name: '', address: '', port: 3389, category: '', tags: '', username: '', description: '' };
  const catOptions = state.meta.categories.map((x) => `<option value="${esc(x.category)}"></option>`).join('');
  openModal(isEdit ? 'Редактировать подключение' : 'Новое подключение', `
    <label>Тип *</label>
    <select id="fType">
      <option value="rdp" ${c.type === 'rdp' ? 'selected' : ''}>RDP (mstsc / FreeRDP)</option>
      <option value="anydesk" ${c.type === 'anydesk' ? 'selected' : ''}>AnyDesk (ID, напр. 123 456 789)</option>
      <option value="rustdesk" ${c.type === 'rustdesk' ? 'selected' : ''}>RustDesk (ID)</option>
    </select>
    <label>Название *</label>
    <input id="fName" value="${esc(c.name)}" placeholder="Сервер 1С, ПК бухгалтера…" />
    <div class="form-row">
      <div>
        <label>Адрес / ID *</label>
        <input id="fAddress" value="${esc(c.address)}" placeholder="192.168.0.11 или 123 456 789" spellcheck="false" />
      </div>
      <div id="fPortWrap">
        <label>Порт RDP</label>
        <input id="fPort" type="number" min="1" max="65535" value="${c.port ?? 3389}" />
      </div>
    </div>
    <div class="form-row">
      <div>
        <label>Категория</label>
        <input id="fCategory" list="categoryList" value="${esc(c.category)}" placeholder="Серверы, Рабочие станции…" />
        <datalist id="categoryList">${catOptions}</datalist>
      </div>
      <div>
        <label>Теги (через запятую)</label>
        <input id="fTags" value="${esc(c.tags)}" placeholder="1c, бухгалтерия" />
      </div>
    </div>
    <label>Имя пользователя (необязательно)</label>
    <input id="fUsername" value="${esc(c.username)}" placeholder="administrator" autocomplete="off" spellcheck="false" />
    <label>Описание</label>
    <input id="fDescription" value="${esc(c.description)}" placeholder="Краткое пояснение для коллег" />
  `, [
    { label: 'Отмена', class: 'btn-ghost', onClick: closeModal },
    {
      label: isEdit ? 'Сохранить' : 'Создать', class: 'btn-primary',
      onClick: async () => {
        const payload = {
          type: $('fType').value,
          name: $('fName').value.trim(),
          address: $('fAddress').value.trim(),
          port: $('fType').value === 'rdp' ? Number($('fPort').value) || 3389 : null,
          category: $('fCategory').value.trim() || 'Общее',
          tags: $('fTags').value.trim(),
          username: $('fUsername').value.trim(),
          description: $('fDescription').value.trim(),
        };
        try {
          if (isEdit) await api('/connections/' + c.id, { method: 'PUT', body: payload });
          else await api('/connections', { method: 'POST', body: payload });
          closeModal();
          toast(isEdit ? 'Подключение сохранено' : 'Подключение создано');
          loadConnections();
        } catch (err) { toast(err.message, true); }
      },
    },
  ]);

  const syncPortVisibility = () => { $('fPortWrap').style.visibility = $('fType').value === 'rdp' ? 'visible' : 'hidden'; };
  $('fType').addEventListener('change', syncPortVisibility);
  syncPortVisibility();
}

$('btnAddConnection').addEventListener('click', () => openConnectionModal(null));

/* ================= Документация ================= */
const docSearchDebounced = debounce(loadDocuments);
$('docSearch').addEventListener('input', docSearchDebounced);
$('docCategory').addEventListener('change', loadDocuments);

async function loadDocuments() {
  const params = new URLSearchParams();
  const search = $('docSearch').value.trim();
  const category = $('docCategory').value;
  if (search) params.set('search', search);
  if (category && category !== 'all') params.set('category', category);
  try {
    const { documents, categories } = await api('/documents?' + params.toString());
    state.docs = documents;
    const catSel = $('docCategory');
    const cur = catSel.value;
    catSel.innerHTML = '<option value="all">Все разделы</option>' +
      categories.map((c) => `<option value="${esc(c.category)}">${esc(c.category)} (${c.count})</option>`).join('');
    catSel.value = cur || 'all';
    renderDocsList();
  } catch (err) { toast(err.message, true); }
}

function renderDocsList() {
  const list = $('docsList');
  if (state.docs.length === 0) { list.innerHTML = '<div class="empty" style="padding:24px 8px">Документы не найдены</div>'; return; }
  list.innerHTML = state.docs.map((d) => `
    <button class="doc-item ${d.id === state.currentDocId ? 'active' : ''}" data-id="${d.id}">
      <strong>${esc(d.title)}</strong>
      <span>${esc(d.category)} · обновлён ${esc((d.updated_at || '').slice(0, 10))}</span>
    </button>`).join('');
}

$('docsList').addEventListener('click', (e) => {
  const item = e.target.closest('.doc-item');
  if (item) openDocument(Number(item.dataset.id));
});

async function openDocument(id) {
  try {
    const { document: doc } = await api('/documents/' + id);
    state.currentDocId = id;
    renderDocsList();
    $('docsReaderEmpty').classList.add('hidden');
    const article = $('docArticle');
    article.innerHTML = window.renderMarkdown(doc.content);
    article.dataset.docId = id;
    article.dataset.title = doc.title;
    article.dataset.category = doc.category;
    article.classList.remove('hidden');
    $('docActions').classList.toggle('hidden', !isAdmin());
    state.currentDoc = doc;
  } catch (err) { toast(err.message, true); }
}

function openDocumentModal(doc) {
  const isEdit = !!doc;
  const d = doc || { title: '', category: '', content: '' };
  const catOptions = [...new Set(state.docs.map((x) => x.category))].map((c) => `<option value="${esc(c)}"></option>`).join('');
  openModal(isEdit ? 'Редактировать документ' : 'Новый документ', `
    <label>Заголовок *</label>
    <input id="fDocTitle" value="${esc(d.title)}" placeholder="Как подключиться к 1С…" />
    <label>Раздел</label>
    <input id="fDocCategory" list="docCatList" value="${esc(d.category)}" placeholder="Инструкции, Регламенты…" />
    <datalist id="docCatList">${catOptions}</datalist>
    <label>Содержимое (Markdown: # заголовок, **жирный**, списки, \`код\`)</label>
    <textarea id="fDocContent" spellcheck="false" placeholder="# Заголовок&#10;&#10;Текст инструкции…">${esc(d.content)}</textarea>
  `, [
    { label: 'Отмена', class: 'btn-ghost', onClick: closeModal },
    {
      label: isEdit ? 'Сохранить' : 'Создать', class: 'btn-primary',
      onClick: async () => {
        const payload = { title: $('fDocTitle').value.trim(), category: $('fDocCategory').value.trim() || 'Общая', content: $('fDocContent').value };
        try {
          if (isEdit) await api('/documents/' + d.id, { method: 'PUT', body: payload });
          else await api('/documents', { method: 'POST', body: payload });
          closeModal();
          toast(isEdit ? 'Документ сохранён' : 'Документ создан');
          await loadDocuments();
          if (isEdit) openDocument(d.id);
        } catch (err) { toast(err.message, true); }
      },
    },
  ]);
}

$('btnAddDocument').addEventListener('click', () => openDocumentModal(null));
$('btnEditDoc').addEventListener('click', () => state.currentDoc && openDocumentModal(state.currentDoc));
$('btnDeleteDoc').addEventListener('click', async () => {
  if (!state.currentDoc) return;
  if (!confirm(`Удалить документ «${state.currentDoc.title}»?`)) return;
  try {
    await api('/documents/' + state.currentDoc.id, { method: 'DELETE' });
    state.currentDoc = null; state.currentDocId = null;
    $('docArticle').classList.add('hidden'); $('docActions').classList.add('hidden'); $('docsReaderEmpty').classList.remove('hidden');
    toast('Документ удалён');
    loadDocuments();
  } catch (err) { toast(err.message, true); }
});
// ссылки из документа открываем в системном браузере
$('docArticle').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="http"]');
  if (a && window.rdpManager?.openExternal) { e.preventDefault(); window.rdpManager.openExternal(a.href); }
});

/* ================= Пользователи ================= */
async function loadUsers() {
  if (!isAdmin()) return;
  try {
    const { users } = await api('/users');
    $('usersTableBody').innerHTML = users.map((u) => `
      <tr>
        <td><strong>${esc(u.username)}</strong></td>
        <td>${esc(u.full_name || '—')}</td>
        <td><span class="badge ${esc(u.role)}">${u.role === 'admin' ? 'Администратор' : 'Сотрудник'}</span></td>
        <td>${u.disabled ? '<span class="badge off">Отключена</span>' : (u.must_change_password ? '<span class="muted">До смены пароля</span>' : '<span class="badge ok">Активна</span>')}</td>
        <td class="muted">${esc((u.created_at || '').slice(0, 10))}</td>
        <td>
          <div class="row-actions">
            <button class="btn-ghost" data-action="toggle-disable" data-id="${u.id}" data-disabled="${u.disabled ? '1' : '0'}">${u.disabled ? 'Включить' : 'Отключить'}</button>
            <button class="btn-ghost" data-action="reset-pass" data-id="${u.id}" data-username="${esc(u.username)}">Сброс пароля</button>
            <button class="btn-danger" data-action="delete-user" data-id="${u.id}" data-username="${esc(u.username)}">Удалить</button>
          </div>
        </td>
      </tr>`).join('');
  } catch (err) { toast(err.message, true); }
}

$('usersTableBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id, username } = btn.dataset;
  try {
    if (action === 'toggle-disable') {
      await api('/users/' + id, { method: 'PUT', body: { disabled: btn.dataset.disabled !== '1' } });
      toast('Готово'); loadUsers();
    } else if (action === 'reset-pass') {
      openResetPasswordModal(Number(id), username);
    } else if (action === 'delete-user') {
      if (!confirm(`Удалить учётную запись «${username}»?`)) return;
      await api('/users/' + id, { method: 'DELETE' });
      toast('Учётная запись удалена'); loadUsers();
    }
  } catch (err) { toast(err.message, true); }
});

function openAddUserModal() {
  openModal('Новая учётная запись', `
    <label>Логин * (латиница, цифры, _ . @ -)</label>
    <input id="fNewLogin" autocomplete="off" spellcheck="false" placeholder="ivanov" />
    <label>ФИО</label>
    <input id="fNewName" placeholder="Иванов Иван Иванович" />
    <label>Роль</label>
    <select id="fNewRole"><option value="employee">Сотрудник</option><option value="admin">Администратор</option></select>
    <label>Временный пароль * (мин. 6 символов)</label>
    <input id="fNewPass" type="password" autocomplete="new-password" />
  `, [
    { label: 'Отмена', class: 'btn-ghost', onClick: closeModal },
    {
      label: 'Создать', class: 'btn-primary',
      onClick: async () => {
        try {
          await api('/users', { method: 'POST', body: { username: $('fNewLogin').value.trim(), full_name: $('fNewName').value.trim(), role: $('fNewRole').value, password: $('fNewPass').value } });
          closeModal(); toast('Учётная запись создана. Пароль нужно сменить при первом входе.'); loadUsers();
        } catch (err) { toast(err.message, true); }
      },
    },
  ]);
}

function openResetPasswordModal(id, username) {
  openModal(`Сброс пароля — ${username}`, `
    <label>Новый временный пароль * (мин. 6 символов)</label>
    <input id="fResetPass" type="password" autocomplete="new-password" />
    <p class="muted" style="margin-top:8px;font-size:12px">Пользователь будет обязан сменить пароль при следующем входе.</p>
  `, [
    { label: 'Отмена', class: 'btn-ghost', onClick: closeModal },
    {
      label: 'Сбросить', class: 'btn-primary',
      onClick: async () => {
        try {
          await api(`/users/${id}/reset-password`, { method: 'POST', body: { password: $('fResetPass').value } });
          closeModal(); toast('Пароль сброшен'); loadUsers();
        } catch (err) { toast(err.message, true); }
      },
    },
  ]);
}

$('btnAddUser').addEventListener('click', openAddUserModal);

/* ================= Профиль / смена пароля ================= */
$('btnChangePassword').addEventListener('click', async () => {
  const cur = $('curPassword').value, next = $('newPassword').value, next2 = $('newPassword2').value;
  if (next.length < 6) return toast('Новый пароль — минимум 6 символов', true);
  if (next !== next2) return toast('Пароли не совпадают', true);
  try {
    await api('/change-password', { method: 'POST', body: { current_password: cur, new_password: next } });
    $('curPassword').value = ''; $('newPassword').value = ''; $('newPassword2').value = '';
    if (state.user) { state.user.must_change_password = false; $('mustChangeBanner').classList.add('hidden'); }
    toast('Пароль изменён');
  } catch (err) { toast(err.message, true); }
});

/* ================= Обновления из GitHub Releases ================= */
const GH_REPO = 'ignatus4405-glitch/RDP_manager';
let currentVersion = null;
let updateReleaseUrl = `https://github.com/${GH_REPO}/releases/latest`;

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function getCurrentVersion() {
  if (currentVersion) return currentVersion;
  try { currentVersion = window.rdpManager?.version ? await window.rdpManager.version() : 'dev'; } catch { currentVersion = 'dev'; }
  $('profVersion').textContent = 'v' + currentVersion;
  return currentVersion;
}

function openReleasePage() {
  if (window.rdpManager?.openExternal) window.rdpManager.openExternal(updateReleaseUrl);
  else window.open(updateReleaseUrl, '_blank', 'noopener');
}

function showUpdateBanner(mode, version) {
  const banner = $('updateBanner');
  const text = $('updateBannerText');
  const btn = $('updateBannerBtn');
  banner.className = 'update-banner' + (mode === 'ready' ? ' ready' : mode === 'downloading' ? ' downloading' : '');
  if (mode === 'ready') {
    text.textContent = `Новая версия ${version} загружена и будет установлена при выходе`;
    btn.textContent = 'Установить и перезапустить';
    btn.onclick = () => window.rdpManager?.updates?.install();
  } else if (mode === 'downloading') {
    text.textContent = `Доступна новая версия ${version}. Идёт загрузка обновления…`;
    btn.textContent = 'Перейти к релизу';
    btn.onclick = openReleasePage;
  } else {
    text.textContent = `Доступна новая версия ${version}. Рекомендуем обновиться.`;
    btn.textContent = 'Скачать';
    btn.onclick = openReleasePage;
  }
  banner.classList.remove('hidden');
}

/** Проверка по GitHub Releases API — работает и в dev, и в браузерном режиме */
async function checkForUpdatesViaGitHub() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    updateReleaseUrl = rel.html_url || updateReleaseUrl;
    const current = await getCurrentVersion();
    if (latest && compareVersions(latest, current) > 0) showUpdateBanner('available', latest);
    return { latest, current };
  } catch {
    return null; // нет сети или API недоступен — молча пропускаем
  }
}

/** События от встроенного автообновления (только в собранном приложении) */
if (window.rdpManager?.updates) {
  window.rdpManager.updates.onAvailable((v) => { if (v) showUpdateBanner('downloading', v); });
  window.rdpManager.updates.onDownloaded((v) => { if (v) showUpdateBanner('ready', v); toast(`Версия ${v} загружена и готова к установке`); });
}

$('btnCheckUpdates').addEventListener('click', async () => {
  const status = $('updateStatus');
  status.textContent = 'Проверяю…';
  const current = await getCurrentVersion();
  try {
    // В собранном приложении спрашиваем electron-updater, иначе — GitHub API
    const r = await window.rdpManager?.updates?.check?.();
    if (r && r.packaged) {
      if (r.error) throw new Error(r.error);
      if (r.version && compareVersions(r.version, current) > 0) status.textContent = `Доступна версия ${r.version} — идёт загрузка…`;
      else status.textContent = `У вас последняя версия (v${current})`;
      checkForUpdatesViaGitHub();
      return;
    }
    const gh = await checkForUpdatesViaGitHub();
    status.textContent = gh && gh.latest && compareVersions(gh.latest, current) > 0
      ? `Доступна версия ${gh.latest}`
      : `У вас последняя версия (v${current})`;
  } catch (err) {
    status.textContent = 'Не удалось проверить: ' + err.message;
  }
});

// Фоновая проверка при старте
getCurrentVersion().then(checkForUpdatesViaGitHub);

/* ================= Автовход по сохранённой сессии ================= */
(async function restoreSession() {
  if (!state.token) return;
  try {
    const { user } = await api('/me');
    state.user = user;
    enterApp();
  } catch {
    state.token = null;
    sessionStorage.removeItem('rdp_token');
    toast('Не удалось связаться с сервером. Войдите снова.', true);
  }
})();
