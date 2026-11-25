'use strict';
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
async function main() {
  const outfile = path.join(__dirname, '../renderer/vendor/rustdesk/bundle.js');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({ entryPoints: [path.join(__dirname, '../renderer/rustdesk-entry.mjs')], outfile, bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['chrome120'], logLevel: 'info', banner: { js: '/* rdweb 0.11.1, MIT, https://github.com/bropines/rdweb */' } });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
