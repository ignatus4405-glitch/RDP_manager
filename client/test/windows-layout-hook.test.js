'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createWindowsLayoutHook } = require('../windows-layout-hook');
function host() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}
test('only the current focused helper may request a layout switch', () => {
  const children = []; const switches = []; const errors = [];
  const bridge = createWindowsLayoutHook({ executable: 'helper.exe', onSwitch: () => switches.push(1), onError: (e) => errors.push(e), spawnProcess: (_, args) => { assert.equal(args[0], '123'); const child = host(); children.push(child); return child; } });
  bridge.start(123);
  children[0].stdout.write('SWITCH\n');
  assert.equal(switches.length, 1);
  bridge.start(123);
  children[0].stdout.write('SWITCH\n');
  children[0].emit('exit', 1);
  assert.equal(switches.length, 1);
  assert.equal(errors.length, 0);
  children[1].stdout.write('SWITCH\n');
  assert.equal(switches.length, 2);
  bridge.stop();
  children[1].stdout.write('SWITCH\n');
  assert.equal(switches.length, 2);
  assert.equal(children[1].killed, true);
});
test('helper failure stops capture and reports an error', () => {
  const child = host(); const errors = [];
  const bridge = createWindowsLayoutHook({ executable: 'helper.exe', onSwitch() {}, onError: (e) => errors.push(e), spawnProcess: () => child });
  bridge.start(123);
  child.emit('error', new Error('failed'));
  assert.equal(errors.length, 1);
  assert.equal(child.killed, true);
  bridge.stop();
});
