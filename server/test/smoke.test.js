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

  // 1. Логин администратора по умолчанию
  const badLogin = await post('/api/login', { username: 'admin', password: 'wrong-password' });
  assert.equal(badLogin.status, 401);

  const login = await post('/api/login', { username: 'admin', password: 'admin123' });
  assert.equal(login.status, 200);
  const { token, user } = await login.json();
  assert.equal(user.role, 'admin');
  assert.equal(user.must_change_password, true);

  // 2. Создание подключения (типизация/валидация)
  const badConn = await post('/api/connections', { type: 'vnc', name: 'x', address: 'y' }, token);
  assert.equal(badConn.status, 400);

  const created = await post('/api/connections', { type: 'rdp', name: 'Тест', address: '192.0.2.10', tags: ' a , b ' }, token);
  assert.equal(created.status, 201);
  const { connection } = await created.json();
  assert.equal(connection.port, 3389);
  assert.equal(connection.tags, 'a,b');

  // 3. Поиск и фильтр по тегу
  const found = await get('/api/connections?tag=' + encodeURIComponent('b'), token);
  const { connections } = await found.json();
  assert.equal(connections.length, 1);

  // 4. Документы
  const doc = await post('/api/documents', { title: 'Инструкция', content: '# Привет' }, token);
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
  const empRead = await get('/api/connections', empToken);
  assert.equal(empRead.status, 200, 'сотрудник должен видеть подключения');

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

  // 7. Отрицательный путь: обращение без токена
  const anon = await get('/api/connections');
  assert.equal(anon.status, 401);
});
