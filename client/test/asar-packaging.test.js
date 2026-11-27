'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { checkArchive } = require('../scripts/check-asar');
const pkg = require('../package.json');

test('electron-builder includes ipc-access in the application archive', () => {
  assert.ok(pkg.build.files.includes('ipc-access.js'));
});

test('archive check catches a missing transitive dependency', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-asar-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'main.js'), "require('./helper');\n");
  fs.writeFileSync(path.join(source, 'helper.js'), "require('./ipc-access');\n");
  fs.writeFileSync(path.join(source, 'preload.js'), "require('electron');\n");
  const broken = path.join(dir, 'broken.asar'); await asar.createPackage(source, broken);
  assert.throws(() => checkArchive(broken), /ipc-access.*helper\.js/);
  fs.writeFileSync(path.join(source, 'ipc-access.js'), 'module.exports = {};\n');
  const good = path.join(dir, 'good.asar'); await asar.createPackage(source, good);
  assert.deepEqual([...checkArchive(good)].sort(), ['helper.js', 'ipc-access.js', 'main.js', 'preload.js']);
});
