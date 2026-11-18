'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLIENT_PACKAGE = require('../package.json');
const SERVER_PACKAGE = require('../../server/package.json');
const SERVER_BINARY = path.join(ROOT, 'server', 'dist', 'rdp-manager-server.exe');
const SERVER_WEB = path.join(ROOT, 'server', 'web');
const SERVER_SERVICE_XML = path.join(ROOT, 'server', 'installer', 'windows', 'RDPManagerServer.xml');
const WINSW_LICENSE = path.join(ROOT, 'server', 'installer', 'windows', 'WinSW-LICENSE.txt');
const BUILD_DIR = path.join(ROOT, 'client', 'build');
const PAYLOAD_DIR = path.join(BUILD_DIR, 'server-payload');
const WINSW_VERSION = '2.13.0';
const WINSW_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe_Release`;
const WINSW_SHA256 = '286c5e550c606593d249bb70599be5c9013573acb290693c3717da690bab8574';
const WINSW_CACHE = path.join(BUILD_DIR, `WinSW-${WINSW_VERSION}-x64.exe`);

async function getWinSwBinary() {
  if (fs.existsSync(WINSW_CACHE) && sha256(fs.readFileSync(WINSW_CACHE)) === WINSW_SHA256) return WINSW_CACHE;
  console.log(`Скачиваю WinSW ${WINSW_VERSION} из официального GitHub release…`);
  const response = await fetch(WINSW_URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Не удалось скачать WinSW: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== WINSW_SHA256) throw new Error(`SHA-256 WinSW не совпал: ожидался ${WINSW_SHA256}, получен ${digest}`);
  fs.writeFileSync(WINSW_CACHE, bytes);
  return WINSW_CACHE;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Этот скрипт подготовки нужен только в Windows job сборки.');
  if (CLIENT_PACKAGE.version !== SERVER_PACKAGE.version) {
    throw new Error(`Версии клиента (${CLIENT_PACKAGE.version}) и сервера (${SERVER_PACKAGE.version}) не совпадают.`);
  }
  if (!fs.existsSync(SERVER_BINARY)) throw new Error(`Сначала соберите SEA-сервер: не найден ${SERVER_BINARY}`);
  if (!fs.existsSync(path.join(SERVER_WEB, 'index.html'))) throw new Error(`Не найдена веб-панель: ${SERVER_WEB}`);

  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const winsw = await getWinSwBinary();
  fs.rmSync(PAYLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  fs.copyFileSync(SERVER_BINARY, path.join(PAYLOAD_DIR, 'rdp-manager-server.exe'));
  fs.cpSync(SERVER_WEB, path.join(PAYLOAD_DIR, 'web'), { recursive: true });
  fs.copyFileSync(winsw, path.join(PAYLOAD_DIR, 'RDPManagerServer.exe'));
  fs.copyFileSync(SERVER_SERVICE_XML, path.join(PAYLOAD_DIR, 'RDPManagerServer.xml'));
  fs.copyFileSync(WINSW_LICENSE, path.join(PAYLOAD_DIR, 'WinSW-LICENSE.txt'));
  fs.writeFileSync(path.join(PAYLOAD_DIR, 'server-version.txt'), `${SERVER_PACKAGE.version}\n`);

  console.log(`Windows installer payload подготовлен: ${PAYLOAD_DIR}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
