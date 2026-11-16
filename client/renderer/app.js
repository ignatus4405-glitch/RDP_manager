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

/** Запуск подключения: десктоп-клиент вызывает нативные программы, браузер — protocol handler */
async function launchConnection(conn, btn) {
  if (window.rdpManager?.launch) {
    btn.disabled = true;
    const result = await window.rdpManager.launch({ type: conn.type, name: conn.name, address: conn.address, port: conn.port, username: conn.username });
    btn.disabled = false;
    toast(result.message, !result.ok);
    return;
  }
  // Режим браузера: AnyDesk/RustDesk открываются по протоколу, RDP — только в десктоп-приложении
  const id = String(conn.address || '').replace(/\s+/g, '');
  if (conn.type === 'anydesk') { window.location.href = 'anydesk:' + id; toast('Передаю AnyDesk системному обработчику…'); }
  else if (conn.type === 'rustdesk') { window.location.href = 'rustdesk://' + id; toast('Передаю RustDesk системному обработчику…'); }
  else toast(`Запуск RDP доступен в десктоп-приложении. Адрес: ${conn.address}${conn.port && conn.port !== 3389 ? ':' + conn.port : ''}`, true);
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
