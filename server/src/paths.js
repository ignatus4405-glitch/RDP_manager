'use strict';
/**
 * Определение «домашнего» каталога приложения RDP Manager Server.
 *
 *   1. RDP_MANAGER_HOME (env) — всегда перекрывает
 *   2. Если рядом с исполняемым файлом есть папка web/ → приложение работает
 *      как однофайловый SEA-бинарь в установке (program files / /opt)
 *   3. Иначе dev-режим из репозитория: server/
 */
const path = require('path');
const fs = require('fs');

function detectHome() {
  if (process.env.RDP_MANAGER_HOME) return path.resolve(process.env.RDP_MANAGER_HOME);
  const exeDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(exeDir, 'web'))) return exeDir;
  return path.join(__dirname, '..');
}

const APP_HOME = detectHome();
const WEB_DIR = path.join(APP_HOME, 'web');
const CLIENT_RENDERER = path.join(APP_HOME, '..', 'client', 'renderer');
const CLIENT_ASSETS = path.join(APP_HOME, '..', 'client', 'assets');

module.exports = { APP_HOME, WEB_DIR, CLIENT_RENDERER, CLIENT_ASSETS };
