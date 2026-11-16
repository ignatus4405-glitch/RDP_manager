'use strict';
/**
 * Сборка единого исполняемого файла сервера (SEA — Single Executable Application).
 *
 * Шаги:
 *   1) esbuild: весь сервер (вместе с express и пр.) → dist/server.cjs
 *   2) node --experimental-sea-config: blob → dist/server.blob
 *   3) копия текущего node-бинарника → dist/rdp-manager-server[.exe]
 *   4) postject: инъекция blob в бинарник (по документации Node SEA)
 *
 * Встроенные модули (node:sqlite, crypto …) остаются внешними и работают нативно.
 * Запускать на той же платформе, под которую собирается инсталлятор.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const DIST = path.join(SERVER_DIR, 'dist');
const isWin = process.platform === 'win32';
const APP_NAME = isWin ? 'rdp-manager-server.exe' : 'rdp-manager-server';
const OUT_EXE = path.join(DIST, APP_NAME);

const run = (cmd, args, opts = {}) => {
  console.log('+', cmd, args.join(' '));
  execFileSync(cmd, args, { cwd: SERVER_DIR, stdio: 'inherit', ...opts });
};

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1) Сборка в один файл
require('esbuild').buildSync({
  entryPoints: [path.join(SERVER_DIR, 'src', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(DIST, 'server.cjs'),
  logLevel: 'info',
  // node:sqlite и все node:* — внешние по определению platform=node
});

// 2) SEA blob
const seaConfig = {
  main: path.join(DIST, 'server.cjs'),
  output: path.join(DIST, 'server.blob'),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')]);

// 3) Чистый node-бинарник как база
fs.copyFileSync(process.execPath, OUT_EXE);
fs.chmodSync(OUT_EXE, 0o755);

// 4) Инъекция blob'а (postject из devDependencies)
const postjectCli = require.resolve('postject/dist/cli.js');
run(process.execPath, [
  postjectCli,
  OUT_EXE,
  'NODE_SEA_BLOB',
  path.join(DIST, 'server.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);

console.log(`\n✔ SEA-бинарь готов: ${OUT_EXE}`);
console.log(`  Размер: ${(fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1)} МБ`);
