'use strict';
/**
 * Подключение к SQLite (встроенный node:sqlite, без нативных зависимостей).
 * Файл базы создаётся в server/data/ (или в каталоге из RDP_MANAGER_DATA).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { APP_HOME } = require('./paths');

const DATA_DIR = process.env.RDP_MANAGER_DATA
  ? path.resolve(process.env.RDP_MANAGER_DATA)
  : path.join(APP_HOME, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'rdp-manager.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT NOT NULL UNIQUE,
  full_name           TEXT NOT NULL DEFAULT '',
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL CHECK (type IN ('rdp', 'anydesk', 'rustdesk')),
  name        TEXT NOT NULL,
  address     TEXT NOT NULL,
  port        INTEGER,
  category    TEXT NOT NULL DEFAULT 'Общее',
  tags        TEXT NOT NULL DEFAULT '',
  username    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_type ON connections(type);
CREATE INDEX IF NOT EXISTS idx_connections_category ON connections(category);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'Общая',
  content     TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
`);

// Existing databases predate per-connection RustDesk configuration.
const connectionColumns = new Set(db.prepare('PRAGMA table_info(connections)').all().map((column) => column.name));
for (const name of ['rustdesk_server', 'rustdesk_key']) {
  if (!connectionColumns.has(name)) db.exec(`ALTER TABLE connections ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
}

/* ---------- Хеширование паролей (scrypt) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, nStr, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N: Number(nStr), r: 8, p: 1 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* ---------- Секрет для подписи токенов ---------- */
function getTokenSecret() {
  if (process.env.RDP_MANAGER_SECRET) return process.env.RDP_MANAGER_SECRET;
  const keyPath = path.join(DATA_DIR, 'secret.key');
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(keyPath, secret, { mode: 0o600 });
  return secret;
}

/* ---------- Первичное наполнение: учётная запись администратора ---------- */
function seedDefaultAdmin() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (row.c > 0) return null;
  const password = process.env.RDP_MANAGER_ADMIN_PASSWORD || 'admin123';
  db.prepare(
    `INSERT INTO users (username, full_name, password_hash, role, must_change_password)
     VALUES (?, ?, ?, 'admin', 1)`
  ).run('admin', 'Администратор', hashPassword(password));
  return { username: 'admin', password };
}

const seededAdmin = seedDefaultAdmin();

module.exports = { db, DATA_DIR, hashPassword, verifyPassword, getTokenSecret, seededAdmin };
