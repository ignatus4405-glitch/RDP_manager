'use strict';
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
(async () => {
  const dir = path.join(__dirname, '../renderer/vendor/ssh');
  fs.mkdirSync(dir, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, '../renderer/ssh-entry.mjs')], outfile: path.join(dir, 'bundle.js'), bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['chrome120'] });
  fs.copyFileSync(require.resolve('@xterm/xterm/css/xterm.css'), path.join(dir, 'xterm.css'));
})().catch((error) => { console.error(error); process.exitCode = 1; });
