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
  assert.equal(await controller.install(), false);
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
  assert.equal(await controller.install(), true);
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
  assert.equal(await controller.install(), false);
  assert.equal(updater.checks, 0);
});

test('Windows waits for installer launch, preserves app on failure, and prevents duplicate launches', async () => {
  const updater = new FakeUpdater(); let resolve, calls = 0, quits = 0;
  const controller = createUpdateController({ updater, supported: true, currentVersion: '1', openInstaller: (file) => { assert.equal(file, 'verified-installer.exe'); calls++; return new Promise((r) => { resolve = r; }); }, quit: () => { quits++; } });
  updater.emit('update-downloaded', { version: '2', downloadedFile: 'verified-installer.exe' });
  const launch = controller.install(); assert.equal(quits, 0); assert.equal(await controller.install(), false); assert.equal(calls, 1);
  resolve('Запуск отклонён'); await assert.rejects(launch, /отклонён/); assert.equal(quits, 0); assert.equal(controller.getState().phase, 'ready');
  const retry = controller.install(); resolve(''); assert.equal(await retry, true); assert.equal(quits, 1); assert.equal(calls, 2);
});
test('Windows refuses to launch when updater did not supply a file', async () => {
  const updater = new FakeUpdater(); let quits = 0;
  const controller = createUpdateController({ updater, supported: true, currentVersion: '1', openInstaller: async () => '', quit: () => quits++ });
  updater.emit('update-downloaded', { version: '2' });
  await assert.rejects(controller.install(), /Не найден/); assert.equal(quits, 0);
});
