'use strict';
/**
 * RDP Manager Server — точка входа.
 * Переменные окружения:
 *   RDP_MANAGER_DATA          — каталог для базы данных и ключа (по умолчанию <домашний каталог приложения>/data)
 *   RDP_MANAGER_HOME          — «домашний» каталог приложения (web/, data/). Для однофайловой сборки определяется автоматически
 *   RDP_MANAGER_SECRET        — секрет подписи токенов (по умолчанию генерируется в data/secret.key)
 *   RDP_MANAGER_ADMIN_PASSWORD — пароль учётной записи admin при первом запуске (по умолчанию admin123)
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { installConsoleFileLogger } = require('./file-logger');
try { installConsoleFileLogger(); }
catch (error) { console.warn('Не удалось открыть файл журнала сервера:', error.message); }
const express = require('express');
const { seededAdmin, DATA_DIR } = require('./db');
const { WEB_DIR, CLIENT_RENDERER, CLIENT_ASSETS } = require('./paths');
const { attachRdpGateway } = require('./rdp-gateway');
const api = require('./api');
const VERSION = require('../package.json').version;

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

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'rdp-manager-server', version: VERSION }));
app.use('/api', api);

// Встроенная серверная веб-панель (статус, пользователи)
app.use(express.static(WEB_DIR));

// Веб-режим десктоп-клиента: если рядом есть client/renderer, он доступен по /app/
const webMode = fs.existsSync(path.join(CLIENT_RENDERER, 'index.html'));
if (webMode) {
  app.use('/assets', express.static(CLIENT_ASSETS));
  app.use('/app', express.static(CLIENT_RENDERER));
}

// 404 для API и обработчик ошибок
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const server = http.createServer(app);
// RDP-шлюз (RDCleanPath поверх WebSocket) для встроенных RDP-сессий в клиенте
attachRdpGateway(server, { path: '/ws/rdp' });

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log(`  RDP Manager Server  v${VERSION}`);
  console.log(`  API:          http://${HOST}:${PORT}/api`);
  console.log(`  RDP-шлюз:     ws://${HOST}:${PORT}/ws/rdp  (встроенный RDP в клиенте)`);
  console.log(`  Веб-панель:   http://${HOST}:${PORT}/`);
  if (webMode) console.log(`  Веб-режим:    http://${HOST}:${PORT}/app/  (клиент в браузере)`);
  console.log(`  База данных:  ${DATA_DIR}`);
  if (seededAdmin) {
    console.log('----------------------------------------------');
    console.log('  Создана учётная запись администратора:');
    console.log(`    логин:  ${seededAdmin.username}`);
    console.log('    начальный пароль задан политикой установки; смените его при первом входе.');
  }
  console.log('==============================================');
});
