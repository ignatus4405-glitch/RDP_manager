'use strict';
/**
 * Unit-тесты RDP-шлюза (RDCleanPath): парсинг destination, allowlist по БД,
 * аутентификация WebSocket upgrade. Сеть до RDP-хостов не требуется.
 * Запуск: npm test --workspace server
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-manager-gw-test-'));
process.env.RDP_MANAGER_DATA = dataDir;
process.env.RDP_MANAGER_SECRET = 'test-secret-key-for-unit-tests';

const {
  attachRdpGateway,
  parseDestination,
  normalizeHost,
  isKnownRdpTarget,
  parseRDCleanPathRequest,
  buildRDCleanPathError,
  buildRDCleanPathResponse,
} = require('../src/rdp-gateway');
const { db } = require('../src/db');
const { signToken } = require('../src/auth');

before(() => {
  db.prepare(
    `INSERT INTO connections (type, name, address, port, category, tags, username, description)
     VALUES ('rdp', 'Тестовый узел', '192.168.55.10', 3389, 'Тест', '', 'ivanov', '')`
  ).run();
  db.prepare(
    `INSERT INTO connections (type, name, address, port, category, tags, username, description)
     VALUES ('rdp', 'Узел без порта', 'rdp-node.internal', NULL, 'Тест', '', '', '')`
  ).run();
  db.prepare(
    `INSERT INTO connections (type, name, address, port, category, tags, username, description)
     VALUES ('rdp', 'Нестандартный порт', '192.168.55.11', 3390, 'Тест', '', '', '')`
  ).run();
  db.prepare(
    `INSERT INTO connections (type, name, address, port, category, tags, username, description)
     VALUES ('anydesk', 'Не RDP', 'anydesk-node', NULL, 'Тест', '', '', '')`
  ).run();
});

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('parseDestination: хост, хост:порт, IPv6', () => {
  assert.deepEqual(parseDestination('server1'), { host: 'server1', port: 3389 });
  assert.deepEqual(parseDestination('server1:3390'), { host: 'server1', port: 3390 });
  assert.deepEqual(parseDestination('[::1]:3389'), { host: '::1', port: 3389 });
  assert.deepEqual(parseDestination('[fe80::1]'), { host: 'fe80::1', port: 3389 });
  assert.deepEqual(parseDestination('server1:notaport'), { host: 'server1:notaport', port: 3389 });
});

test('normalizeHost: регистр и завершающая точка', () => {
  assert.equal(normalizeHost('SERVER1.'), 'server1');
  assert.equal(normalizeHost('  Node.CORP.local '), 'node.corp.local');
});

test('isKnownRdpTarget: allowlist по базе (host case-insensitive, port default 3389)', () => {
  assert.equal(isKnownRdpTarget('192.168.55.10', 3389), true);
  assert.equal(isKnownRdpTarget('192.168.55.10', 3390), false);
  assert.equal(isKnownRdpTarget('192.168.55.11', 3390), true);
  assert.equal(isKnownRdpTarget('RDP-NODE.INTERNAL', 3389), true, 'регистр не должен влиять');
  assert.equal(isKnownRdpTarget('rdp-node.internal.', 3389), true, 'завершающая точка игнорируется');
  assert.equal(isKnownRdpTarget('unknow-node', 3389), false);
  assert.equal(isKnownRdpTarget('anydesk-node', 3389), false, 'не-RDP подключения отклоняются');
});

/** Минимальный DER-кодер для сборки RDCleanPath-запроса в тесте */
function derLen(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  let t = n;
  while (t > 0) { bytes.unshift(t & 0xff); t >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), Buffer.from(derLen(content.length)), content]);
function derInt(value) {
  const bytes = [];
  let t = value;
  while (t > 0) { bytes.unshift(t & 0xff); t >>= 8; }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

test('RDCleanPath: запрос разбирается (version, destination, x224)', () => {
  const x224 = Buffer.from([0xe0, 0x00, 0x00, 0x00, 0x00, 0x00]); // произвольная X.224 CR
  const request = tlv(0x30, Buffer.concat([
    tlv(0xa0, derInt(3390)),                  // [0] version
    tlv(0xa2, tlv(0x0c, Buffer.from('192.168.55.10:3389', 'utf8'))), // [2] destination
    tlv(0xa6, tlv(0x04, x224)),                // [6] x224_connection_pdu
  ]));

  const parsed = parseRDCleanPathRequest(request);
  assert.equal(parsed.destination, '192.168.55.10:3389');
  assert.deepEqual(parsed.x224ConnectionRequest, x224);
});

test('RDCleanPath: ответ и ошибка имеют форму SEQUENCE с version 3390', () => {
  const x224Rsp = Buffer.from([0xd0, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const resp = buildRDCleanPathResponse('192.168.55.10:3389', x224Rsp, []);
  assert.equal(resp[0], 0x30);
  const err = buildRDCleanPathError(1, 502);
  assert.equal(err[0], 0x30);
  assert.ok(err.length > 10);
});

test('WebSocket upgrade без токена → 401; с токеном → 101', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end('not found'); });
  attachRdpGateway(server, { path: '/ws/rdp' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const rawUpgrade = (query) => new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET /ws/rdp${query} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n\r\n')) { sock.destroy(); resolve(buf); }
    });
    sock.on('error', (err) => { if (buf) { resolve(buf); } else reject(err); });
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
  });

  const denied = await rawUpgrade('?token=bad-token');
  assert.match(denied, /^HTTP\/1\.1 401/);

  const token = signToken({ sub: 1, username: 'admin', role: 'admin' });
  const allowed = await rawUpgrade(`?token=${encodeURIComponent(token)}`);
  assert.match(allowed, /^HTTP\/1\.1 101/);

  // Закрываем все оставшиеся сокеты (в т.ч. апгрейднутые), иначе server.close() зависает
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  await new Promise((r) => server.close(r));
});
