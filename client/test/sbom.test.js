'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');

test('lockfile SBOM includes both workspaces and validates as CycloneDX', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-sbom-'));
  try {
    const output = path.join(temp, 'bom.json');
    const cli = path.join(root, 'node_modules', '@cyclonedx', 'cyclonedx-npm', 'bin', 'cyclonedx-npm-cli.js');
    execFileSync(process.execPath, [cli, '--package-lock-only', '--output-reproducible', '--output-format', 'JSON', '--output-file', output], {
      cwd: root, env: { ...process.env, NODE_ENV: 'development' }, timeout: 60000,
    });
    const bom = JSON.parse(fs.readFileSync(output, 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(bom.bomFormat, 'CycloneDX');
    assert.equal(bom.metadata.component.version, pkg.version);
    for (const name of ['express', 'ws', 'electron', 'electron-updater']) {
      assert.ok(bom.components.some((component) => component.name === name), `${name} missing from SBOM`);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
