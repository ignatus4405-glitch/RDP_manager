'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFileLogger } = require('../src/file-logger');

test('file logger writes timestamped entries and rotates bounded log files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-manager-file-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = createFileLogger(dir, { maxBytes: 90, keepFiles: 2 });
  logger.write('INFO', 'first event');
  logger.write('WARN', 'x'.repeat(90));
  logger.write('ERROR', 'last event');

  const active = fs.readFileSync(logger.filePath, 'utf8');
  const rotated = fs.readFileSync(`${logger.filePath}.1`, 'utf8');
  assert.match(active, /\[ERROR\] last event/);
  assert.match(rotated, /\[WARN\]/);
  assert.match(active, /^\d{4}-\d\d-\d\dT/);
});
