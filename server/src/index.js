'use strict';
/**
 * RDP Manager Server — точка входа.
 * Переменные окружения:
 *   RDP_MANAGER_PORT          — порт (по умолчанию 8720)
 *   RDP_MANAGER_HOST          — адрес привязки (по умолчанию 0.0.0.0)
 *   RDP_MANAGER_DATA          — каталог для базы данных и ключа (по умолчанию server/data)
 *   RDP_MANAGER_SECRET        — секрет подписи токенов (по умолчанию генерируется в data/secret.key)
 *   RDP_MANAGER_ADMIN_PASSWORD — пароль учётной записи admin при первом запуске (по умолчанию admin123)
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { seededAdmin, DATA_DIR } = require('./db');
const api = require('./api');

const PORT = Number(process.env.RDP_MANAGER_PORT || 8720);
const HOST = process.env.RDP_MANAGER_HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Простой лог запросов
app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'rdp-manager-server', version: '1.0.0' }));
app.use('/api', api);

// Встроенная серверная веб-панель (статус, пользователи)
app.use(express.static(path.join(__dirname, '..', 'web')));

// Веб-режим десктоп-клиента: если рядом есть client/renderer, он доступен по /app/
const clientRenderer = path.join(__dirname, '..', '..', 'client', 'renderer');
const clientAssets = path.join(__dirname, '..', '..', 'client', 'assets');
const webMode = fs.existsSync(path.join(clientRenderer, 'index.html'));
if (webMode) {
  app.use('/assets', express.static(clientAssets));
  app.use('/app', express.static(clientRenderer));
}

// 404 для API и обработчик ошибок
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

app.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  RDP Manager Server  v1.0.0');
  console.log(`  API:          http://${HOST}:${PORT}/api`);
  console.log(`  Веб-панель:   http://${HOST}:${PORT}/`);
  if (webMode) console.log(`  Веб-режим:    http://${HOST}:${PORT}/app/  (клиент в браузере)`);
  console.log(`  База данных:  ${DATA_DIR}`);
  if (seededAdmin) {
    console.log('----------------------------------------------');
    console.log('  Создана учётная запись администратора:');
    console.log(`    логин:  ${seededAdmin.username}`);
    console.log(`    пароль: ${seededAdmin.password}`);
    console.log('  Смените пароль при первом входе!');
  }
  console.log('==============================================');
});
