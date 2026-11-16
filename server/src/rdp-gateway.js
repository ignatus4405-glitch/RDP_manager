'use strict';
/**
 * RDP-шлюз (RDCleanPath over WebSocket).
 *
 * Веб-клиент (ironrdp-wasm в рендерере Electron) не может открыть TCP-сокет напрямую,
 * поэтому все RDP-пакеты туннелируются через WebSocket на этот эндпоинт:
 *
 *   браузер/Electron ⇄ WS /ws/rdp ⇄ этот шлюз ⇄ TCP/TLS ⇄ RDP-сервер
 *
 * Протокол RDCleanPath: ASN.1 DER-кадры поверх WebSocket (бинарные сообщения).
 * Эта реализация адаптирована из примера electerm/ironrdp-wasm (MIT,
 * https://github.com/electerm/ironrdp-wasm, example/lib/rdp-proxy.js)
 * с добавленной аутентификацией и ограничением целей:
 *
 *  - WebSocket доступен только с валидным JWT (?token=...), как и остальной API;
 *  - destination из RDCleanPath-запроса обязан совпадать (host:port) с RDP-подключением
 *    из базы данных — шлюз не является открытым релеем на произвольные хосты.
 *
 * Безопасность: пароли через шлюз НЕ сохраняются и НЕ логируются —
 * X.224-запрос формирует WASM-клиент; шлюз лишь проксирует его после TLS-переговоров.
 */
const tls = require('tls');
const net = require('net');
const { WebSocketServer } = require('ws');
const { db } = require('./db');
const { verifyToken } = require('./auth');

// ── RDCleanPath ASN.1 DER Constants ──
const VERSION_1 = 3390; // 3389 + 1

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8STRING = 0x0c;
const TAG_CTX = (n) => 0xa0 + n;

// ────────────────────────────────────────────────────
// ASN.1 DER Low-Level Helpers
// ────────────────────────────────────────────────────

function derEncodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let temp = length;
  while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derEncodeLength(content.length), content]);
}

function derEncodeInteger(value) {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]));
  const bytes = [];
  let temp = value;
  while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8; }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return derWrap(TAG_INTEGER, Buffer.from(bytes));
}

function derEncodeUtf8String(str) {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8'));
}

function derEncodeOctetString(buf) {
  return derWrap(TAG_OCTET_STRING, buf);
}

function derWrapContext(tagNum, content) {
  return derWrap(TAG_CTX(tagNum), content);
}

function derDecodeLength(buf, offset) {
  const first = buf[offset];
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i];
  return { length, bytesRead: 1 + numBytes };
}

function derDecodeTLV(buf, offset) {
  const tag = buf[offset];
  const { length, bytesRead } = derDecodeLength(buf, offset + 1);
  const headerLen = 1 + bytesRead;
  const value = buf.slice(offset + headerLen, offset + headerLen + length);
  return { tag, value, totalLength: headerLen + length };
}

function derDecodeInteger(buf) {
  let val = 0;
  for (let i = 0; i < buf.length; i++) val = (val << 8) | buf[i];
  return val;
}

function derDecodeChildren(buf) {
  const children = [];
  let offset = 0;
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset);
    children.push(tlv);
    offset += tlv.totalLength;
  }
  return children;
}

// ────────────────────────────────────────────────────
// RDCleanPath PDU Parsing & Encoding
// ────────────────────────────────────────────────────

function parseRDCleanPathRequest(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const outer = derDecodeTLV(buf, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Ожидался SEQUENCE (0x30), получено 0x${outer.tag.toString(16)}`);
  }
  const children = derDecodeChildren(outer.value);

  let version = null;
  let destination = null;
  let proxyAuth = null;
  let x224ConnectionRequest = null;
  let preconnectionBlob = null;

  for (const child of children) {
    const ctxTag = child.tag & 0x1f;
    switch (ctxTag) {
      case 0: {
        const intTlv = derDecodeTLV(child.value, 0);
        version = derDecodeInteger(intTlv.value);
        break;
      }
      case 2: {
        const strTlv = derDecodeTLV(child.value, 0);
        destination = strTlv.value.toString('utf-8');
        break;
      }
      case 3: {
        const strTlv = derDecodeTLV(child.value, 0);
        proxyAuth = strTlv.value.toString('utf-8');
        break;
      }
      case 5: {
        const strTlv = derDecodeTLV(child.value, 0);
        preconnectionBlob = strTlv.value.toString('utf-8');
        break;
      }
      case 6: {
        const octTlv = derDecodeTLV(child.value, 0);
        x224ConnectionRequest = octTlv.value;
        break;
      }
    }
  }

  if (version !== VERSION_1) throw new Error(`Неподдерживаемая версия RDCleanPath: ${version}`);
  if (!destination) throw new Error('В RDCleanPath-запросе нет destination');
  if (!x224ConnectionRequest) throw new Error('В RDCleanPath-запросе нет x224_connection_pdu');

  return { destination, proxyAuth, x224ConnectionRequest, preconnectionBlob };
}

function buildRDCleanPathResponse(serverAddr, x224Response, certChain) {
  const parts = [];
  parts.push(derWrapContext(0, derEncodeInteger(VERSION_1)));
  parts.push(derWrapContext(6, derEncodeOctetString(x224Response)));
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map((c) => derEncodeOctetString(c))));
  parts.push(derWrapContext(7, certSeq));
  parts.push(derWrapContext(9, derEncodeUtf8String(serverAddr)));
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

function buildRDCleanPathError(errorCode, httpStatusCode) {
  const errParts = [];
  errParts.push(derWrapContext(0, derEncodeInteger(errorCode)));
  if (httpStatusCode != null) errParts.push(derWrapContext(1, derEncodeInteger(httpStatusCode)));
  const parts = [];
  parts.push(derWrapContext(0, derEncodeInteger(VERSION_1)));
  parts.push(derWrapContext(1, derWrap(TAG_SEQUENCE, Buffer.concat(errParts))));
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

// ────────────────────────────────────────────────────
// Destination parsing + allowlist по базе подключений
// ────────────────────────────────────────────────────

/** "host:port" / "[::1]:3389" → { host, port } (порт по умолчанию 3389) */
function parseDestination(destination) {
  const dest = String(destination || '').trim();
  if (dest.startsWith('[')) {
    const bracketEnd = dest.indexOf(']');
    if (bracketEnd === -1) throw new Error(`Недопустимый IPv6 destination: ${dest}`);
    const host = dest.slice(1, bracketEnd);
    const rest = dest.slice(bracketEnd + 1);
    const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) : 3389;
    return { host, port: Number.isNaN(port) ? 3389 : port };
  }
  const lastColon = dest.lastIndexOf(':');
  if (lastColon === -1) return { host: dest, port: 3389 };
  const host = dest.slice(0, lastColon);
  const port = parseInt(dest.slice(lastColon + 1), 10);
  if (Number.isNaN(port)) return { host: dest, port: 3389 };
  return { host, port };
}

/** Нормализация хоста для сравнения: lowercase, без завершающей точки */
function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Проверяет, что destination совпадает с RDP-подключением в базе данных
 * (host — без учёта регистра и завершающей точки; port — с дефолтом 3389).
 */
function isKnownRdpTarget(host, port) {
  const h = normalizeHost(host);
  const p = Number(port) || 3389;
  if (!h) return false;
  const rows = db.prepare(`SELECT address, port FROM connections WHERE type = 'rdp'`).all();
  return rows.some((row) => {
    const addr = String(row.address || '').trim();
    let rowHost = addr;
    let rowPort = row.port != null ? Number(row.port) : 3389;
    // Подстраховка: если порт хранится прямо в address ("host:3389" / "[::1]:3389")
    if (addr.includes(':')) {
      try { const parsed = parseDestination(addr); rowHost = parsed.host; rowPort = parsed.port; } catch { /* оставляем как есть */ }
    }
    if (!Number.isFinite(rowPort) || rowPort <= 0) rowPort = 3389;
    return normalizeHost(rowHost) === h && rowPort === p;
  });
}

// ────────────────────────────────────────────────────
// Network: TCP + X.224 + TLS + Certificate Extraction
// ────────────────────────────────────────────────────

function performRDPHandshake(host, port, x224Request) {
  return new Promise((resolve, reject) => {
    const tcpSocket = net.createConnection({ host, port }, () => {
      tcpSocket.write(x224Request);
    });

    tcpSocket.once('error', (err) => reject(new Error(`TCP ${host}:${port}: ${err.message}`)));

    tcpSocket.once('data', (x224Response) => {
      if (!x224Response || x224Response.length === 0) {
        tcpSocket.destroy();
        reject(new Error('RDP-сервер закрыл соединение без X.224 Connection Confirm'));
        return;
      }
      tcpSocket.removeAllListeners('error');
      tcpSocket.removeAllListeners('data');

      const tlsSocket = tls.connect(
        { socket: tcpSocket, servername: host, rejectUnauthorized: false }, // RDP обычно со self-signed сертификатами
        () => {
          const certChain = extractCertChain(tlsSocket.getPeerCertificate(true));
          resolve({ x224Response: Buffer.from(x224Response), certChain, tlsSocket });
        }
      );
      tlsSocket.once('error', (err) => reject(new Error(`TLS handshake с ${host}:${port}: ${err.message}`)));
    });

    tcpSocket.setTimeout(15000, () => {
      tcpSocket.destroy();
      reject(new Error(`Тайм-аут подключения к ${host}:${port}`));
    });
  });
}

function extractCertChain(peerCert) {
  const certs = [];
  if (!peerCert || !peerCert.raw) return certs;
  const seen = new Set();
  let current = peerCert;
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex');
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    certs.push(Buffer.from(current.raw));
    if (current.issuerCertificate && current.issuerCertificate !== current) current = current.issuerCertificate;
    else break;
  }
  return certs;
}

function setupRelay(ws, tlsSocket, logPrefix) {
  tlsSocket.on('data', (data) => {
    try { if (ws.readyState === 1) ws.send(data); } catch (err) { console.error(`${logPrefix} TLS→WS:`, err.message); }
  });

  ws.on('message', (data, isBinary) => {
    try { if (!tlsSocket.destroyed) tlsSocket.write(isBinary ? data : Buffer.from(data)); } catch (err) { console.error(`${logPrefix} WS→TLS:`, err.message); }
  });

  const cleanup = (source) => {
    if (!tlsSocket.destroyed) tlsSocket.destroy();
    if (ws.readyState === 1) { try { ws.close(); } catch { /* уже закрыт */ } }
    console.log(`${logPrefix} соединение закрыто (${source})`);
  };

  tlsSocket.on('end', () => cleanup('TLS end'));
  tlsSocket.on('error', (err) => { console.error(`${logPrefix} TLS error:`, err.message); cleanup('TLS error'); });
  ws.on('close', () => cleanup('WebSocket close'));
  ws.on('error', (err) => { console.error(`${logPrefix} WebSocket error:`, err.message); cleanup('WebSocket error'); });
}

function handleConnection(ws) {
  ws.once('message', async (data) => {
    const requestData = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let host = '?'; let port = 0;
    try {
      const request = parseRDCleanPathRequest(requestData);
      ({ host, port } = parseDestination(request.destination));
      const logPrefix = `[rdp ${host}:${port}]`;

      // Allowlist по базе подключений — шлюз не ходит к произвольным хостам
      if (!isKnownRdpTarget(host, port)) {
        console.warn(`${logPrefix} отказ: цель не найдена среди RDP-подключений БД`);
        ws.send(buildRDCleanPathError(1, 403));
        ws.close();
        return;
      }

      console.log(`${logPrefix} RDCleanPath: установка соединения…`);
      const { x224Response, certChain, tlsSocket } = await performRDPHandshake(host, port, request.x224ConnectionRequest);
      ws.send(buildRDCleanPathResponse(`${host}:${port}`, x224Response, certChain));
      console.log(`${logPrefix} TLS установлен, начинается ретрансляция`);
      setupRelay(ws, tlsSocket, logPrefix);
    } catch (err) {
      console.error(`[rdp ${host}:${port}] ошибка шлюза:`, err.message);
      try { ws.send(buildRDCleanPathError(1, 502)); } catch { /* сокет уже закрыт */ }
      try { ws.close(); } catch { /* уже закрыт */ }
    }
  });

  ws.on('error', () => { /* ошибки логируются в relay/handshake */ });
}

/**
 * Подключает RDP-шлюз к HTTP-серверу (upgrade на /ws/rdp?token=<JWT>).
 * Вызывать ПОСЛЕ создания http.Server и ДО server.listen().
 */
function attachRdpGateway(server, { path: wsPath = '/ws/rdp' } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== wsPath) return; // не наш эндпоинт — отдаём другим обработчикам

    const token = url.searchParams.get('token');
    const payload = verifyToken(token);
    if (!payload) {
      console.warn('[rdp] отказ в upgrade: невалидный или отсутствующий токен');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = { id: payload.sub, username: payload.username, role: payload.role };
      handleConnection(ws);
    });
  });

  return wss;
}

module.exports = {
  attachRdpGateway,
  // Экспорт для unit-тестов
  parseDestination,
  normalizeHost,
  isKnownRdpTarget,
  parseRDCleanPathRequest,
  buildRDCleanPathResponse,
  buildRDCleanPathError,
  extractCertChain,
};
