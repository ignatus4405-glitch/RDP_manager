'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('CI blocks high severity audit results and Electron remains pinned', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /run: npm audit --audit-level=high\s*$/m);
  assert.doesNotMatch(ci, /npm audit --audit-level=high\s*\|\|/);
  const client = JSON.parse(read('client/package.json'));
  assert.match(client.devDependencies.electron, /^\d+\.\d+\.\d+$/);
  assert.equal(client.dependencies.electron, undefined);
});

test('Dependabot checks root npm workspace lockfile and Actions', () => {
  const config = read('.github/dependabot.yml');
  assert.match(config, /package-ecosystem: npm\s+directory: \/\s+schedule:\s+interval: weekly/);
  assert.match(config, /package-ecosystem: github-actions\s+directory: \/\s+schedule:\s+interval: weekly/);
});
