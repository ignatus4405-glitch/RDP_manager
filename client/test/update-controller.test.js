'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateController } = require('../update-controller');

class FakeUpdater extends EventEmitter {
  constructor() { super(); this.checks = 0; this.installs = 0; }
  async checkForUpdates() { this.checks++; this.emit('update-available', { version: '2.0.0' }); }
  quitAndInstall() { this.installs++; }
}

test('update lifecycle retains download state until explicit installation', async () => {
  const updater = new FakeUpdater();
  const changes = [];
  const controller = createUpdateController({ updater, supported: true, currentVersion: '1.0.0', onChange: (state) => changes.push(state) });
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.install(), false);
  const checks = [controller.check(), controller.check()];
  await Promise.all(checks);
  assert.equal(updater.checks, 1);
  assert.equal(controller.getState().phase, 'downloading');
  updater.emit('download-progress', { percent: 49.6 });
  assert.equal(controller.getState().progress, 50);
  updater.emit('update-downloaded', { version: '2.0.0' });
  await controller.check();
  assert.equal(updater.checks, 1);
  assert.deepEqual(controller.getState(), { supported: true, phase: 'ready', version: '2.0.0', currentVersion: '1.0.0', progress: 100, error: null });
  assert.equal(controller.install(), true);
  assert.equal(updater.installs, 1);
  assert.ok(changes.some((state) => state.phase === 'ready'));
});

test('update errors are reported and a retry is possible', async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => { throw new Error('offline'); };
  const controller = createUpdateController({ updater, supported: true, currentVersion: '1.0.0' });
  assert.equal((await controller.check()).error, 'offline');
  updater.checkForUpdates = async () => updater.emit('update-not-available');
  assert.equal((await controller.check()).phase, 'current');
});

test('unsupported builds do not check or install', async () => {
  const updater = new FakeUpdater();
  const controller = createUpdateController({ updater, supported: false, currentVersion: '1.0.0' });
  assert.equal((await controller.check()).supported, false);
  assert.equal(controller.install(), false);
  assert.equal(updater.checks, 0);
});
