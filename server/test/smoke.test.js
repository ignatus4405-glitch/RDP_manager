'use strict';
/**
 * Смоук-тест сервера: поднимает настоящий процесс на случайном порту
 * с временным каталогом БД и проверяет основные сценарии API.
 * Запуск: npm test --workspace server
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createConnectionSecrets } = require('../src/connection-secrets');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) return true;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test('server smoke: health → login → CRUD → защита доступа', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-manager-test-'));
  // Simulate the connections table from a pre-migration installation.
  const oldDb = new DatabaseSync(path.join(dataDir, 'rdp-manager.db'));
  oldDb.exec(`CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK(type IN ('rdp','anydesk','rustdesk')), name TEXT NOT NULL, address TEXT NOT NULL, port INTEGER, category TEXT NOT NULL DEFAULT 'Общее', tags TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO connections (type, name, address) VALUES ('rustdesk', 'Старое', '123');
    CREATE TABLE connection_secrets (connection_id INTEGER PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, iv BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL);`);
  createConnectionSecrets({ db: oldDb, dataDir }).save(1, 'legacy-secret');
  oldDb.close();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'index.js')],
    {
      env: { ...process.env, RDP_MANAGER_PORT: String(port), RDP_MANAGER_HOST: '127.0.0.1', RDP_MANAGER_DATA: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  t.after(async () => {
    child.kill('SIGTERM');
    // Ждём выхода процесса — на Windows иначе файлы SQLite остаются залоченными
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (process.env.DEBUG_SMOKE) console.log('--- server log ---\n' + childLog);
  });

  assert.ok(await waitForServer(base), 'сервер не поднялся за отведённое время. Лог сервера:\n' + childLog);

  const post = (url, body, token) =>
    fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const get = (url, token) => fetch(base + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  const headers = await get('/api/health');
  assert.equal(headers.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.headers.get('strict-transport-security'), null);
  assert.equal(headers.headers.get('x-powered-by'), null);

  // Concurrent scrypt checks must not block the server event loop.
  const logins = Array.from({ length: 20 }, (_, i) => post('/api/login', { username: 'absent' + i, password: 'wrong' }));
  const start = Date.now();
  assert.equal((await get('/api/health')).status, 200);
  assert.ok(Date.now() - start < 1500, 'health should remain responsive during login checks');
  const failures = await Promise.all(logins);
  assert.ok(failures.every((r) => r.status === 401));

  for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { username: 'unknown-rate-test', password: 'wrong' })).status, 401);
  assert.equal((await post('/api/login', { username: 'unknown-rate-test', password: 'wrong' })).status, 429);

  // 1. Логин администратора по умолчанию
  const badLogin = await post('/api/login', { username: 'admin', password: 'wrong-password' });
  assert.equal(badLogin.status, 401);

  const login = await post('/api/login', { username: 'admin', password: 'admin123' });
  assert.equal(login.status, 200);
  let { token, user } = await login.json();
  assert.equal(user.role, 'admin');
  assert.equal(user.must_change_password, true);
  // First login must not provide access to any application API or RDP tickets.
  assert.equal((await get('/api/me', token)).status, 200);
  for (const url of ['/api/connections', '/api/documents', '/api/users', '/api/stats']) {
    const blocked = await get(url, token);
    assert.equal(blocked.status, 403); assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED');
  }
  assert.equal((await post('/api/rdp/ticket', { connection_id: 1 }, token)).status, 403);
  // Default admin must change their initial password before using stored secrets.
  const lockedSecret = await fetch(base + '/api/connections/1/secret', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(lockedSecret.status, 403);
  assert.equal((await post('/api/change-password', { current_password: 'admin123', new_password: 'admin123' }, token)).status, 400);
  assert.equal((await get('/api/users', token)).status, 403);
  const initialToken = token;
  const passwordChanged = await post('/api/change-password', { current_password: 'admin123', new_password: 'admin456' }, token);
  assert.equal(passwordChanged.status, 200);
  token = (await passwordChanged.json()).token;
  assert.equal((await get('/api/me', initialToken)).status, 401);

  // 2. Создание подключения (типизация/валидация)
  const badConn = await post('/api/connections', { type: 'vnc', name: 'x', address: 'y' }, token);
  assert.equal(badConn.status, 400);

  const created = await post('/api/connections', { type: 'rdp', name: 'Тест', address: '192.0.2.10', tags: ' a , b ' }, token);
  assert.equal(created.status, 201);
  const { connection } = await created.json();
  const ticketResponse = await post('/api/rdp/ticket', { connection_id: connection.id }, token);
  assert.equal(ticketResponse.status, 200);
  assert.equal(ticketResponse.headers.get('cache-control'), 'no-store');
  assert.match((await ticketResponse.json()).ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await post('/api/rdp/ticket', { connection_id: 999999 }, token)).status, 404);
  assert.equal((await post('/api/rdp/ticket', { connection_id: connection.id })).status, 401);
  assert.equal(connection.port, 3389);
  assert.equal(connection.tags, 'a,b');
  assert.equal(connection.domain, '');
  const domainUpdate = await fetch(base + '/api/connections/' + connection.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ domain: 'EXAMPLE' }) });
  assert.equal(domainUpdate.status, 200);
  assert.equal((await domainUpdate.json()).connection.domain, 'EXAMPLE');
  const invalidDomain = await post('/api/connections', { type: 'rdp', name: 'bad', address: 'host', domain: 'domain\\user' }, token);
  assert.equal(invalidDomain.status, 400);

  const legacy = (await (await get('/api/connections?type=rustdesk', token)).json()).connections[0];
  assert.equal(legacy.rustdesk_server, '');
  assert.equal(legacy.rustdesk_key, '');
  assert.equal(legacy.domain, '');
  assert.equal((await (await get('/api/connections/' + legacy.id + '/secret', token)).json()).password, 'legacy-secret');
  const webCreated = await post('/api/connections', { type: 'web', name: 'Portal', address: 'https://example.com/login', username: 'alice' }, token);
  assert.equal(webCreated.status, 201);
  assert.equal((await webCreated.json()).connection.type, 'web');
  for (const address of ['http://example.com', 'https://u:p@example.com', 'file:///tmp/x']) {
    assert.equal((await post('/api/connections', { type: 'web', name: 'Bad', address }, token)).status, 400);
  }
  const sshCreated = await post('/api/connections', { type: 'ssh', name: 'SSH', address: 'ssh.example', username: 'alice' }, token);
  assert.equal(sshCreated.status, 201);
  assert.equal((await sshCreated.json()).connection.port, 22);
  const key = Buffer.alloc(32, 42).toString('base64');
  const rd = await post('/api/connections', { type: 'rustdesk', name: 'RD', address: '123456', rustdesk_server: '37.17.55.196', rustdesk_key: key }, token);
  assert.equal(rd.status, 201);
  const rdConnection = (await rd.json()).connection;
  assert.equal(rdConnection.rustdesk_server, '37.17.55.196');
  assert.equal(rdConnection.rustdesk_key, key);
  const updated = await fetch(base + '/api/connections/' + rdConnection.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'RD2' }) });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).connection.rustdesk_key, key);
  const badKey = await post('/api/connections', { type: 'rustdesk', name: 'Bad', address: '123', rustdesk_server: 'host', rustdesk_key: 'bad' }, token);
  assert.equal(badKey.status, 400);

  const secretUrl = base + '/api/connections/' + rdConnection.id + '/secret';
  const savedSecret = await fetch(secretUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ password: ' SSH $пароль ' }) });
  assert.equal(savedSecret.status, 200);
  const secretReply = await fetch(secretUrl, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(secretReply.headers.get('cache-control'), 'no-store');
  assert.equal((await secretReply.json()).password, ' SSH $пароль ');
  const exposedList = JSON.stringify(await (await get('/api/connections?type=rustdesk', token)).json());
  assert.equal(exposedList.includes('SSH $пароль'), false);
  assert.match(exposedList, /"has_secret":1/);
  const forwarded = await fetch(secretUrl, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-Proto': 'https' } });
  assert.equal(forwarded.status, 403);

  // 3. Поиск и фильтр по тегу
  const found = await get('/api/connections?tag=' + encodeURIComponent('b'), token);
  const { connections } = await found.json();
  assert.equal(connections.length, 1);

  // 4. Документы
  const searchCyrillic = await get('/api/connections?search=' + encodeURIComponent('тЕст'), token);
  assert.ok((await searchCyrillic.json()).connections.some((c) => c.id === connection.id));
  const doc = await post('/api/documents', { title: 'Инструкция', content: '# Привет' }, token);
  const searchDoc = await get('/api/documents?search=' + encodeURIComponent('пРИВЕТ'), token);
  assert.ok((await searchDoc.json()).documents.some((d) => d.title === 'Инструкция'));
  assert.equal(doc.status, 201);

  // 5. Создание сотрудника и проверка прав
  const emp = await post('/api/users', { username: 'sotrudnik', password: 'secret1', role: 'employee', full_name: 'Тест' }, token);
  assert.equal(emp.status, 201);
  const empLogin = await post('/api/login', { username: 'sotrudnik', password: 'secret1' });
  const empToken = (await empLogin.json()).token;

  const empCreate = await post('/api/connections', { type: 'rdp', name: 'hack', address: '192.0.2.99' }, empToken);
  assert.equal(empCreate.status, 403, 'сотрудник не должен создавать подключения');
  const empUsers = await get('/api/users', empToken);
  assert.equal(empUsers.status, 403, 'сотрудник не должен видеть список пользователей');
  const employeeSecretBeforeChange = await get('/api/connections/' + rdConnection.id + '/secret', empToken);
  assert.equal(employeeSecretBeforeChange.status, 403);
  const empWriteSecret = await fetch(secretUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` }, body: JSON.stringify({ password: 'bad' }) });
  assert.equal(empWriteSecret.status, 403);
  const empRead = await get('/api/connections', empToken);
  assert.equal(empRead.status, 403, 'до смены пароля подключения недоступны');

  const another = await post('/api/users', { username: 'otheradmin', password: 'secret3', role: 'admin' }, token);
  const otherId = (await another.json()).user.id;
  const initialOtherToken = (await (await post('/api/login', { username: 'otheradmin', password: 'secret3' })).json()).token;
  assert.equal((await get('/api/users', initialOtherToken)).status, 403);
  const otherChange = await post('/api/change-password', { current_password: 'secret3', new_password: 'secret5' }, initialOtherToken);
  assert.equal(otherChange.status, 200);
  const otherToken = (await otherChange.json()).token;
  assert.equal((await get('/api/users', otherToken)).status, 200);
  const demote = await fetch(base + '/api/users/' + otherId, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ role: 'employee' }) });
  assert.equal(demote.status, 200);
  assert.equal((await get('/api/users', otherToken)).status, 401);
  const demotedToken = (await (await post('/api/login', { username: 'otheradmin', password: 'secret5' })).json()).token;
  assert.equal((await get('/api/users', demotedToken)).status, 403);
  assert.equal((await post('/api/users/' + otherId + '/reset-password', { password: 'secret4' }, token)).status, 200);
  assert.equal((await get('/api/me', demotedToken)).status, 401);
  const resetToken = (await (await post('/api/login', { username: 'otheradmin', password: 'secret4' })).json()).token;
  assert.equal((await get('/api/me', resetToken)).status, 200);
  assert.equal((await get('/api/connections', resetToken)).status, 403);
  assert.equal((await post('/api/rdp/ticket', { connection_id: connection.id }, resetToken)).status, 403);

  // 6. Неверный текущий пароль не должен выглядеть как истёкшая сессия.
  const badChange = await post('/api/change-password', { current_password: 'wrong', new_password: 'secret2' }, empToken);
  assert.equal(badChange.status, 400);
  assert.equal((await badChange.json()).error, 'Текущий пароль указан неверно');
  assert.equal((await get('/api/me', empToken)).status, 200);

  // Смена пароля и вход по новому паролю.
  const change = await post('/api/change-password', { current_password: 'secret1', new_password: 'secret2' }, empToken);
  assert.equal(change.status, 200);
  const relogin = await post('/api/login', { username: 'sotrudnik', password: 'secret2' });
  assert.equal(relogin.status, 200);
  const employeeToken = (await relogin.json()).token;
  assert.equal((await get('/api/connections', employeeToken)).status, 200);
  const employeeSecret = await get('/api/connections/' + rdConnection.id + '/secret', employeeToken);
  assert.equal((await employeeSecret.json()).password, ' SSH $пароль ');
  const disable = await fetch(base + '/api/users/' + (await emp.json()).user.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ disabled: true }) });
  assert.equal(disable.status, 200);
  assert.equal((await get('/api/connections/' + rdConnection.id + '/secret', employeeToken)).status, 401);
  assert.equal((await get('/api/connections', employeeToken)).status, 401);
  const deletedSecret = await fetch(secretUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(deletedSecret.status, 200);
  assert.equal((await (await get('/api/connections/' + rdConnection.id + '/secret', token)).json()).password, null);
  assert.equal((await fetch(secretUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ password: 'old-service' }) })).status, 200);
  const rdpSecretUrl = base + '/api/connections/' + connection.id + '/secret';
  assert.equal((await fetch(rdpSecretUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ password: 'port-secret' }) })).status, 200);
  const changedPort = await fetch(base + '/api/connections/' + connection.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ port: 3391 }) });
  assert.equal(changedPort.status, 200);
  assert.equal((await (await get('/api/connections/' + connection.id + '/secret', token)).json()).password, null, 'changing port must not reuse its password');
  const changedAddress = await fetch(base + '/api/connections/' + rdConnection.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ address: 'different' }) });
  assert.equal(changedAddress.status, 200);
  assert.equal((await (await get('/api/connections/' + rdConnection.id + '/secret', token)).json()).password, null, 'changing target must not reuse its password');
  assert.equal((await fetch(secretUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ password: 'old-service' }) })).status, 200);
  const changedType = await fetch(base + '/api/connections/' + rdConnection.id, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'anydesk' }) });
  assert.equal(changedType.status, 200);
  assert.equal((await (await get('/api/connections/' + rdConnection.id + '/secret', token)).json()).password, null, 'changing protocol must not reuse its password');

  // 7. Отрицательный путь: обращение без токена
  const anon = await get('/api/connections');
  assert.equal(anon.status, 401);
});
