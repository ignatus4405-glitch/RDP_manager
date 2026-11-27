'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/build.yml'), 'utf8').replace(/\r\n/g, '\n');

test('tag release is published by one job after all build artifacts are checked', () => {
  assert.equal((workflow.match(/uses: softprops\/action-gh-release@v2/g) || []).length, 1);
  const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
  assert.match(publish, /needs: \[build, build-server\]/);
  assert.match(publish, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(publish, /group: release-\$\{\{ github\.ref \}\}/);
  for (const name of ['installers-windows-latest', 'installers-ubuntu-latest', 'server-installers-linux']) {
    assert.ok(publish.includes(`name: ${name}`));
  }
  for (const file of ['.exe.blockmap', 'latest.yml', '.AppImage', 'latest-linux.yml', '-linux-x64.tar.gz']) {
    assert.ok(publish.includes(file));
  }
  assert.match(publish, /fail_on_unmatched_files: true/);
  assert.ok(publish.indexOf('Проверка комплекта релиза') < publish.indexOf('softprops/action-gh-release'));
});
