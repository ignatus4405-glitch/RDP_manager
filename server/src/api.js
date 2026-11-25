'use strict';
/**
 * REST API RDP Manager.
 * Все маршруты монтируются под /api. Чтение доступно всем авторизованным,
 * изменение — только администраторам.
 */
const express = require('express');
const { db, DATA_DIR, hashPassword, verifyPassword } = require('./db');
const { createConnectionSecrets, secureSecretTransport } = require('./connection-secrets');
const secrets = createConnectionSecrets({ db, dataDir: DATA_DIR });
const { signToken, requireAuth, requireAdmin } = require('./auth');

const router = express.Router();

const VALID_TYPES = ['rdp', 'anydesk', 'rustdesk', 'ssh', 'sftp', 'web'];
const VALID_ROLES = ['admin', 'employee'];
const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    role: u.role,
    disabled: !!u.disabled,
    must_change_password: !!u.must_change_password,
    created_at: u.created_at,
  };
}

/* ============ Авторизация ============ */

router.post('/login', (req, res) => {
  const username = clean(req.body?.username, 100);
  const password = String(req.body?.password ?? '');
  if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  if (user.disabled) return res.status(403).json({ error: 'Учётная запись отключена. Обратитесь к администратору.' });

  const token = signToken({ sub: user.id, username: user.username, role: user.role });
  res.json({ token, user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json({ user: publicUser(user) });
});

router.post('/change-password', requireAuth, (req, res) => {
  const current = String(req.body?.current_password ?? '');
  const next = String(req.body?.new_password ?? '');
  if (next.length < 6) return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !verifyPassword(current, user.password_hash)) {
    return res.status(400).json({ error: 'Текущий пароль указан неверно' });
  }
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`)
    .run(hashPassword(next), user.id);
  res.json({ ok: true });
});

/* ============ Пользователи (только администраторы) ============ */

router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY role, username').all();
  res.json({ users: users.map(publicUser) });
});

router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const username = clean(req.body?.username, 100);
  const full_name = clean(req.body?.full_name, 200);
  const password = String(req.body?.password ?? '');
  const role = VALID_ROLES.includes(req.body?.role) ? req.body.role : 'employee';

  if (!/^[a-zA-Z0-9_.@-]{3,100}$/.test(username)) {
    return res.status(400).json({ error: 'Логин: минимум 3 символа, латиница/цифры и _ . @ -' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Пользователь с таким логином уже существует' });

  const info = db.prepare(
    `INSERT INTO users (username, full_name, password_hash, role, must_change_password)
     VALUES (?, ?, ?, ?, 1)`
  ).run(username, full_name, hashPassword(password), role);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ user: publicUser(user) });
});

router.put('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const full_name = req.body?.full_name !== undefined ? clean(req.body.full_name, 200) : user.full_name;
  const role = VALID_ROLES.includes(req.body?.role) ? req.body.role : user.role;
  const disabled = req.body?.disabled !== undefined ? (req.body.disabled ? 1 : 0) : user.disabled;

  // Нельзя отключить или понизить самого себя — иначе можно потерять доступ к серверу
  if (user.id === req.user.id && ((role !== 'admin') || disabled)) {
    return res.status(400).json({ error: 'Нельзя отключить или понизить свою учётную запись' });
  }

  db.prepare(`UPDATE users SET full_name = ?, role = ?, disabled = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(full_name, role, disabled, id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ user: publicUser(updated) });
});

router.post('/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body?.password ?? '');
  if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`)
    .run(hashPassword(password), id);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить свою учётную запись' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

/* ============ Подключения ============ */

router.get('/connections', requireAuth, (req, res) => {
  const { search, category, type, tag } = req.query;
  let sql = 'SELECT connections.*, EXISTS(SELECT 1 FROM connection_secrets WHERE connection_id = connections.id) AS has_secret FROM connections WHERE 1 = 1';
  const params = [];

  if (VALID_TYPES.includes(type)) { sql += ' AND type = ?'; params.push(type); }
  if (category && category !== 'all') { sql += ' AND category = ?'; params.push(clean(category, 100)); }
  if (search) {
    sql += ` AND (name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')`;
    const q = `%${likeEscape(clean(search, 200))}%`;
    params.push(q, q, q, q, q);
  }
  if (tag) { sql += " AND (',' || tags || ',') LIKE ? ESCAPE '\\'"; params.push(`%,${likeEscape(clean(tag, 100))},%`); }

  sql += ' ORDER BY category, name';
  res.json({ connections: db.prepare(sql).all(...params) });
});

router.get('/connections/meta', requireAuth, (req, res) => {
  const categories = db.prepare(
    `SELECT category, COUNT(*) AS count FROM connections GROUP BY category ORDER BY category`
  ).all();
  const typeCounts = db.prepare(`SELECT type, COUNT(*) AS count FROM connections GROUP BY type`).all();
  const tagSet = new Set();
  for (const row of db.prepare(`SELECT tags FROM connections WHERE tags <> ''`).all()) {
    for (const t of row.tags.split(',')) { const v = t.trim(); if (v) tagSet.add(v); }
  }
  res.json({ categories, typeCounts, tags: [...tagSet].sort((a, b) => a.localeCompare(b, 'ru')) });
});

router.post('/connections', requireAuth, requireAdmin, (req, res) => {
  const data = validateConnection(req.body);
  if (data.error) return res.status(400).json({ error: data.error });
  const info = db.prepare(
    `INSERT INTO connections (type, name, address, port, category, tags, username, description, rustdesk_server, rustdesk_key, domain, created_by)
     VALUES (@type, @name, @address, @port, @category, @tags, @username, @description, @rustdesk_server, @rustdesk_key, @domain, @created_by)`
  ).run({ ...data.value, created_by: req.user.id });
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ connection: row });
});

router.put('/connections/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Подключение не найдено' });
  const data = validateConnection({ ...existing, ...req.body });
  if (data.error) return res.status(400).json({ error: data.error });
  // Changing the target or identity must not silently send an old password to
  // another account or service. Keep the update and secret removal atomic.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE connections SET type=@type, name=@name, address=@address, port=@port, category=@category,
         tags=@tags, username=@username, description=@description, rustdesk_server=@rustdesk_server, rustdesk_key=@rustdesk_key, domain=@domain, updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...data.value, id });
    if (['type', 'address', 'username', 'domain'].some((key) => (existing[key] || '') !== (data.value[key] || ''))) secrets.remove(id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  res.json({ connection: row });
});

// Passwords never appear in connection lists, search results or logs. A secret
// is available to active authorized employees on an explicitly secure channel.
function secretAccess(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!secureSecretTransport(req)) return res.status(403).json({ error: 'Для паролей требуется HTTPS непосредственно к серверу или локальное подключение.' });
  const user = db.prepare('SELECT role, disabled, must_change_password FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.disabled || user.must_change_password) return res.status(403).json({ error: 'Учётная запись недоступна или необходимо сменить пароль.' });
  req.user.role = user.role;
  next();
}
router.get('/connections/:id/secret', requireAuth, secretAccess, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM connections WHERE id = ?').get(id)) return res.status(404).json({ error: 'Подключение не найдено' });
  try { return res.json({ password: secrets.read(id) }); }
  catch (error) { console.error('Не удалось расшифровать пароль подключения:', id); return res.status(500).json({ error: 'Не удалось открыть хранилище паролей.' }); }
});
router.put('/connections/:id/secret', requireAuth, secretAccess, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM connections WHERE id = ?').get(id)) return res.status(404).json({ error: 'Подключение не найдено' });
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 8192) return res.status(400).json({ error: 'Укажите пароль длиной до 8192 байт.' });
  try { secrets.save(id, password); return res.json({ ok: true }); }
  catch (error) { console.error('Не удалось сохранить пароль подключения:', id); return res.status(500).json({ error: 'Не удалось сохранить пароль подключения.' }); }
});
router.delete('/connections/:id/secret', requireAuth, secretAccess, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || !db.prepare('SELECT id FROM connections WHERE id = ?').get(id)) return res.status(404).json({ error: 'Подключение не найдено' });
  secrets.remove(id);
  return res.json({ ok: true });
});

router.delete('/connections/:id', requireAuth, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM connections WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Подключение не найдено' });
  res.json({ ok: true });
});

/** Теги: храним через запятую без пробелов — так одинаково работают фильтр и точный поиск */
function normalizeTags(tags) {
  return String(tags ?? '')
    .split(',')
    .map((t) => t.trim().slice(0, 50))
    .filter(Boolean)
    .slice(0, 20)
    .join(',');
}

function validateConnection(body) {
  const type = clean(body.type, 20);
  if (!VALID_TYPES.includes(type)) return { error: 'Тип должен быть: rdp, anydesk, rustdesk, ssh, sftp или web' };
  const name = clean(body.name, 200);
  const address = clean(body.address, 300);
  if (!name) return { error: 'Укажите название' };
  if (!address) return { error: 'Укажите адрес / ID' };
  if (type === 'web') {
    let url; try { url = new URL(address); } catch { return { error: 'Укажите полный HTTPS-адрес веб-приложения.' }; }
    if (url.protocol !== 'https:' || url.username || url.password || /[\x00-\x20\x7f]/.test(address)) return { error: 'Веб-приложению требуется HTTPS-адрес без логина и пароля.' };
  }

  let port = body.port === null || body.port === undefined || body.port === '' ? null : Number(body.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return { error: 'Порт должен быть целым числом от 1 до 65535' };
  }
  if (!['rdp', 'ssh', 'sftp'].includes(type)) port = null;
  if (type === 'rdp' && port === null) port = 3389;
  if ((type === 'ssh' || type === 'sftp') && port === null) port = 22;
  if ((type === 'ssh' || type === 'sftp') && (/[\s\/@?#\x00-\x1f]/.test(address) || address.length > 253)) return { error: 'Укажите имя или IP SSH-сервера без порта и протокола.' };

  const domain = type === 'rdp' ? clean(body.domain, 150) : '';
  if (/[\x00-\x1f\x7f\\/@]/.test(domain)) return { error: 'Недопустимое имя домена RDP.' };

  const rustdesk_server = type === 'rustdesk' ? clean(body.rustdesk_server, 300) : '';
  const rustdesk_key = type === 'rustdesk' ? clean(body.rustdesk_key, 128) : '';
  if (Boolean(rustdesk_server) !== Boolean(rustdesk_key)) return { error: 'Укажите сервер ID и публичный ключ RustDesk вместе.' };
  if (rustdesk_server) {
    let server;
    try { server = new URL(`http://${rustdesk_server}`); } catch { return { error: 'Некорректный сервер ID RustDesk.' }; }
    if (/[\\/?#@\s]/.test(rustdesk_server) || !server.hostname || Number(server.port || 21116) > 65532) return { error: 'Некорректный сервер ID RustDesk.' };
    if (!/^[A-Za-z0-9+/]{43}=$/.test(rustdesk_key) || Buffer.from(rustdesk_key, 'base64').length !== 32 || Buffer.from(rustdesk_key, 'base64').toString('base64') !== rustdesk_key) return { error: 'Укажите публичный ключ RustDesk id_ed25519.pub.' };
  }

  return {
    value: {
      type,
      name,
      address,
      port,
      category: clean(body.category, 100) || 'Общее',
      tags: normalizeTags(body.tags),
      username: clean(body.username, 150),
      domain,
      description: clean(body.description, 2000),
      rustdesk_server,
      rustdesk_key,
    },
  };
}

/* ============ Документация ============ */

router.get('/documents', requireAuth, (req, res) => {
  const { search, category } = req.query;
  let sql = `SELECT id, title, category, created_at, updated_at,
                    substr(content, 1, 200) AS preview FROM documents WHERE 1 = 1`;
  const params = [];
  if (category && category !== 'all') { sql += ' AND category = ?'; params.push(clean(category, 100)); }
  if (search) {
    sql += " AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')";
    const q = `%${likeEscape(clean(search, 200))}%`;
    params.push(q, q);
  }
  sql += ' ORDER BY updated_at DESC';
  const documents = db.prepare(sql).all(...params);
  const categories = db.prepare(
    `SELECT category, COUNT(*) AS count FROM documents GROUP BY category ORDER BY category`
  ).all();
  res.json({ documents, categories });
});

router.get('/documents/:id', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });
  res.json({ document: doc });
});

router.post('/documents', requireAuth, requireAdmin, (req, res) => {
  const title = clean(req.body?.title, 300);
  if (!title) return res.status(400).json({ error: 'Укажите заголовок' });
  const info = db.prepare(
    `INSERT INTO documents (title, category, content, created_by) VALUES (?, ?, ?, ?)`
  ).run(title, clean(req.body?.category, 100) || 'Общая', String(req.body?.content ?? ''), req.user.id);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ document: doc });
});

router.put('/documents/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });
  const title = req.body?.title !== undefined ? clean(req.body.title, 300) : doc.title;
  if (!title) return res.status(400).json({ error: 'Заголовок не может быть пустым' });
  db.prepare(
    `UPDATE documents SET title = ?, category = ?, content = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(
    title,
    req.body?.category !== undefined ? (clean(req.body.category, 100) || 'Общая') : doc.category,
    req.body?.content !== undefined ? String(req.body.content) : doc.content,
    id
  );
  res.json({ document: db.prepare('SELECT * FROM documents WHERE id = ?').get(id) });
});

router.delete('/documents/:id', requireAuth, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM documents WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Документ не найден' });
  res.json({ ok: true });
});

/* ============ Статистика (для серверной панели) ============ */

router.get('/stats', requireAuth, (req, res) => {
  const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  res.json({
    connections: count('connections'),
    documents: count('documents'),
    users: count('users'),
    admins: db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`).get().c,
  });
});

module.exports = router;
