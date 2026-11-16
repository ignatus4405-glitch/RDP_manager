'use strict';
/**
 * Лёгкая JWT-совместимая авторизация на HMAC-SHA256 (без внешних зависимостей).
 */
const crypto = require('crypto');
const { getTokenSecret } = require('./db');

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

/** Middleware: требует валидный токен, кладёт req.user = {id, username, role} */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Требуется авторизация' });
  req.user = { id: payload.sub, username: payload.username, role: payload.role };
  next();
}

/** Middleware: только для администраторов */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Доступно только администраторам' });
  }
  next();
}

module.exports = { signToken, verifyToken, requireAuth, requireAdmin, TOKEN_TTL_SECONDS };
