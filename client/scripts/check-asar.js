'use strict';
// Check the actual package, not just electron-builder's include list. Follow
// literal relative requires recursively from the main and preload entrypoints.
const path = require('node:path').posix;
const asar = require('@electron/asar');

function checkArchive(archive) {
  const files = new Set(asar.listPackage(archive).map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, '')));
  const visited = new Set();
  function visit(file, parent) {
    if (!files.has(file)) throw new Error(`В app.asar отсутствует ${file}${parent ? ` (зависимость ${parent})` : ''}`);
    if (visited.has(file)) return;
    visited.add(file);
    if (!file.endsWith('.js') && !file.endsWith('.cjs')) return;
    const source = asar.extractFile(archive, file).toString('utf8');
    const imports = source.matchAll(/\brequire\s*\(\s*(['"])(\.\.?\/[^'"\r\n]+)\1\s*\)/g);
    for (const match of imports) {
      const target = path.normalize(path.join(path.dirname(file), match[2]));
      if (target === '..' || target.startsWith('../') || path.isAbsolute(target)) throw new Error(`Недопустимая зависимость ${match[2]} в ${file}`);
      const candidates = [target, `${target}.js`, `${target}.json`, `${target}.cjs`, `${target}/index.js`];
      const resolved = candidates.find((candidate) => files.has(candidate) && !asar.statFile(archive, candidate).files);
      if (!resolved) throw new Error(`В app.asar отсутствует ${match[2]} (зависимость ${file})`);
      visit(resolved, file);
    }
  }
  for (const entry of ['main.js', 'preload.js']) visit(entry);
  return visited;
}

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Укажите путь к app.asar');
    const checked = checkArchive(process.argv[2]);
    console.log(`app.asar: проверено ${checked.size} файлов локальных зависимостей.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkArchive };
