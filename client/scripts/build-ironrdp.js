'use strict';
/**
 * Сборка встроенного RDP-клиента (ironrdp-wasm + WASM) в один классический
 * скрипт renderer/vendor/ironrdp/bundle.js для <script src>.
 *
 *   node scripts/build-ironrdp.js
 *
 * WASM инлайнится как data: URL (loader 'dataurl') — никаких fetch к file://.
 * Лицензия ironrdp-wasm: MIT (© Marc-André Moreau и контрибьюторы IronRDP).
 */
const path = require('path');
const fs = require('fs');

async function main() {
  const esbuild = require('esbuild');
  const outfile = path.join(__dirname, '..', 'renderer', 'vendor', 'ironrdp', 'bundle.js');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });

  // Пакет не экспортирует pkg/*.wasm через "exports" — находим его рядом с main
  const wasmPath = path.join(path.dirname(require.resolve('ironrdp-wasm')), 'rdp_client_bg.wasm');
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM не найден: ${wasmPath}`);

  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'renderer', 'ironrdp-entry.mjs')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['chrome120'],
    platform: 'browser',
    loader: { '.wasm': 'dataurl' },
    alias: { 'ironrdp-wasm-wasm-binary': wasmPath },
    banner: { js: '/* ironrdp-wasm 1.3.0 (MIT) — Devolutions/IronRDP. Собрано scripts/build-ironrdp.js */' },
    outfile,
    logLevel: 'info',
  });
  if (result.errors.length) process.exitCode = 1;
  const sizeMb = (fs.statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`✓ bundle.js собран (${sizeMb} МБ)`);
}

main().catch((err) => { console.error('Ошибка сборки ironrdp-бандла:', err); process.exit(1); });
