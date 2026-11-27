'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { compareVersions, parseServiceStatus, readLogTail } = require('../server-manager-utils');

test('service status parser handles running, stopped, and missing services', () => {
  assert.deepEqual(parseServiceStatus('SERVICE_NAME: RDPManagerServer\n        STATE              : 4  RUNNING', 0), {
    installed: true, state: 'running', stateCode: 4,
  });
  assert.deepEqual(parseServiceStatus('СЛУЖБА: RDPManagerServer\n        СОСТОЯНИЕ          : 1  ОСТАНОВЛЕНА', 0), {
    installed: true, state: 'stopped', stateCode: 1,
  });
  assert.deepEqual(parseServiceStatus('[SC] OpenService FAILED 1060', 1060), {
    installed: false, state: 'not-installed', stateCode: null,
  });
});

test('service status parser handles localized OEM output decoded as UTF-8', () => {
  const corruptedOutput = '���_����: RDPManagerServer\n        ��� : 10 WIN32_OWN_PROCESS\n        ��������� : 4 RUNNING (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\n        ���_Win32 : 0 (0x0)';
  assert.deepEqual(parseServiceStatus(corruptedOutput, 0), {
    installed: true, state: 'running', stateCode: 4,
  });
  assert.deepEqual(parseServiceStatus('���� : 1 STOPPED', 0), {
    installed: true, state: 'stopped', stateCode: 1,
  });
  assert.equal(parseServiceStatus('���� : 10 WIN32_OWN_PROCESS\n���� : 4 (0x4)', 0).state, 'unknown');
  assert.equal(parseServiceStatus('STATE : 4 RUNNING', 5).state, 'unknown');
});

test('server log reader returns only the bounded tail and handles a missing file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-manager-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, 'line 1\nline 2\nline 3\nline 4\n');
  assert.deepEqual(readLogTail(path.join(dir, 'missing.log')), {
    exists: false, text: '', truncated: false, modifiedAt: null,
  });
  const result = readLogTail(file, { maxBytes: 1024, maxLines: 2 });
  assert.equal(result.exists, true);
  assert.equal(result.text, 'line 3\nline 4');
  assert.equal(result.truncated, true);
});

test('semantic version comparison detects newer server/client releases', () => {
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.3.5', 'v1.3.5'), 0);
  assert.equal(compareVersions('1.2.9', '1.3.0'), -1);
});

test('server panel URL follows service XML, supports TLS and rejects unsafe settings', () => {
  const { serverPanelUrl } = require('../server-manager-utils');
  const xml = (body = '') => `<service>${body}</service>`;
  const env = (name, value) => `<env name="${name}" value="${value}" />`;
  assert.equal(serverPanelUrl(xml(), {}), 'http://127.0.0.1:8720/');
  assert.equal(serverPanelUrl(xml(env('RDP_MANAGER_PORT', '9999') + env('RDP_MANAGER_HOST', '192.0.2.2')), {}), 'http://192.0.2.2:9999/');
  assert.equal(serverPanelUrl(xml(env('RDP_MANAGER_HOST', '::') + env('RDP_MANAGER_TLS_CERT', 'cert.pem') + env('RDP_MANAGER_TLS_KEY', 'key.pem')), {}), 'https://[::1]:8720/');
  assert.equal(serverPanelUrl(xml(env('RDP_MANAGER_PORT', '%MY_PORT%')), { MY_PORT: '4321', RDP_MANAGER_TLS_CERT: 'a', RDP_MANAGER_TLS_KEY: 'b' }), 'https://127.0.0.1:4321/');
  assert.throws(() => serverPanelUrl(xml(env('RDP_MANAGER_PORT', '0')), {}));
  assert.throws(() => serverPanelUrl(xml(env('RDP_MANAGER_HOST', 'example.com@evil.com')), {}));
  assert.throws(() => serverPanelUrl(xml(env('RDP_MANAGER_TLS_CERT', 'a')), {}));
  assert.throws(() => serverPanelUrl(xml(env('RDP_MANAGER_PORT', '%MISSING%')), {}));
  assert.throws(() => serverPanelUrl(xml(env('RDP_MANAGER_PORT', '1') + env('RDP_MANAGER_PORT', '2')), {}));
  assert.throws(() => serverPanelUrl('<!DOCTYPE service><service/>', {}));
  assert.throws(() => serverPanelUrl('<service><env>', {}));
});
