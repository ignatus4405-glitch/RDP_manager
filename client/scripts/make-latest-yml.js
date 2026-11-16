'use strict';
/**
 * Генератор latest.yml / latest-linux.yml для electron-updater.
 * Запускается в CI после `electron-builder --publish never` —
 * чтобы не зависеть от внутренностей electron-builder и гонок матрицы сборки.
 *   Windows → client/dist/latest.yml        (установщик NSIS)
 *   Linux   → client/dist/latest-linux.yml  (AppImage)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

if (!fs.existsSync(dist)) {
  console.error(`Каталог ${dist} не найден — сначала выполните сборку`);
  process.exit(1);
}

const sha512b64 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

function writeLatest(installerPath, outName) {
  const name = path.basename(installerPath);
  const sha = sha512b64(installerPath);
  const size = fs.statSync(installerPath).size;
  const body = [
    `version: ${pkg.version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');
  const out = path.join(dist, outName);
  fs.writeFileSync(out, body);
  console.log(`✔ ${outName} → ${name} (${size} байт)`);
}

let made = 0;
if (process.platform === 'win32') {
  const exe = fs.readdirSync(dist).find((f) => f.endsWith('.exe'));
  if (!exe) { console.error('В client/dist не найден .exe установщик'); process.exit(1); }
  writeLatest(path.join(dist, exe), 'latest.yml');
  made++;
} else if (process.platform === 'linux') {
  const appImage = fs.readdirSync(dist).find((f) => f.endsWith('.AppImage'));
  if (!appImage) { console.error('В client/dist не найден .AppImage'); process.exit(1); }
  writeLatest(path.join(dist, appImage), 'latest-linux.yml');
  made++;
} else {
  console.warn('Неизвестная ОС — файлы обновления не генерируются');
}
process.exit(0);
