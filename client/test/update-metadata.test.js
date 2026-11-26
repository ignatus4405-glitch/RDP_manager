'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const crypto = require('node:crypto');

for (const platform of ['win32', 'linux']) {
  test(`generated ${platform} update metadata matches installer and elevation requirements`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdpm-update-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'dist'));
    fs.copyFileSync(path.join(__dirname, '../scripts/make-latest-yml.js'), path.join(root, 'scripts/make-latest-yml.js'));
    fs.copyFileSync(path.join(__dirname, '../package.json'), path.join(root, 'package.json'));
    const name = platform === 'win32' ? 'RDPManager-Setup-1.2.3.exe' : 'RDPManager-1.2.3.AppImage';
    const bytes = Buffer.from('installer test'); fs.writeFileSync(path.join(root, 'dist', name), bytes);
    const code = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); require(${JSON.stringify(path.join(root, 'scripts/make-latest-yml.js'))})`;
    const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    const data = yaml.load(fs.readFileSync(path.join(root, 'dist', platform === 'win32' ? 'latest.yml' : 'latest-linux.yml'), 'utf8'));
    assert.equal(data.files[0].url, name); assert.equal(data.files[0].size, bytes.length);
    assert.equal(data.files[0].sha512, crypto.createHash('sha512').update(bytes).digest('base64'));
    assert.equal(data.files[0].isAdminRightsRequired, platform === 'win32' ? true : undefined);
  });
}
