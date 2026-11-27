'use strict';
/**
 * Лёгкая JWT-совместимая авторизация на HMAC-SHA256 (без внешних зависимостей).
 */
const crypto = require('crypto');
const { db, getTokenSecret } = require('./db');

const TOKEN_TTL_SECONDS = Number(process.env.RDP_MANAGER_TOKEN_TTL || 12 * 60 * 60); // 12 часов

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  const signature = crypto.createHmac('sha256', getTokenSecret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = crypto.createHmac('sha256', getTokenSecret()).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Resolve identity and privileges from the database for every new request.
function authenticateToken(token) {
  const payload = verifyToken(token);
  if (!payload || !Number.isSafeInteger(payload.sub) || !Number.isSafeInteger(payload.ver)) return null;
  const user = db.prepare('SELECT id, username, role, disabled, must_change_password, token_version FROM users WHERE id = ?').get(payload.sub);
  if (!user || user.disabled || user.token_version !== payload.ver) return null;
  return { id: user.id, username: user.username, role: user.role, tokenVersion: user.token_version, must_change_password: !!user.must_change_password };
}

/** Middleware: требует действующую учётную запись и актуальный токен */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = authenticateToken(token);
  if (!user) return res.status(401).json({ error: 'Требуется авторизация' });
  req.user = user;
  const allowed = (req.method === 'GET' && req.path === '/me') || (req.method === 'POST' && req.path === '/change-password');
  if (user.must_change_password && !allowed) return res.status(403).json({ error: 'Перед продолжением необходимо сменить пароль.', code: 'PASSWORD_CHANGE_REQUIRED' });
  next();
}

/** Middleware: только для администраторов */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Доступно только администраторам' });
  }
  next();
}

module.exports = { signToken, verifyToken, authenticateToken, requireAuth, requireAdmin, TOKEN_TTL_SECONDS };
