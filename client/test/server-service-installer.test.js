'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const script = fs.readFileSync(path.join(__dirname, '../build/installer.nsh'), 'utf8');
test('installer checks and stops an existing service before replacing its executable', () => {
  const prepare = script.indexOf('nsExec::ExecToStack', script.indexOf('prepare-server-service.ps1'));
  const overwrite = script.indexOf('File "${RDP_SERVER_PAYLOAD}\\rdp-manager-server.exe"');
  const registration = script.indexOf('register-server-service.ps1"\'');
  assert.ok(prepare >= 0 && prepare < overwrite && registration > overwrite);
});

for (const file of ['prepare-server-service.ps1', 'register-server-service.ps1', 'remove-server-service.ps1']) {
  test(`${file} rejects another service with the same name`, { skip: process.platform !== 'win32' }, () => {
    const target = path.join(__dirname, '../build', file).replace(/'/g, "''");
    const mock = `function Get-CimInstance { [pscustomobject]@{ PathName = 'C:\\Other\\foreign-service.exe' } }; function Get-ItemProperty { $null }; $env:RDP_INSTALL_DIR = 'C:\\RDP-Manager-Test'; & '${target}'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mock], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /different service/i);
  });
}

test('register script retains a service registered to the expected path', { skip: process.platform !== 'win32' }, () => {
  const target = path.join(__dirname, '../build/register-server-service.ps1').replace(/'/g, "''");
  const mock = `function Get-CimInstance { [pscustomobject]@{ PathName = '"C:\\RDP-Manager-Test\\server\\RDPManagerServer.exe"' } }; function Get-ItemProperty { $null }; $env:RDP_INSTALL_DIR = 'C:\\RDP-Manager-Test'; & '${target}'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mock], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('prepare waits for a deletion-marked service without changing other services', { skip: process.platform !== 'win32' }, () => {
  const target = path.join(__dirname, '../build/prepare-server-service.ps1').replace(/'/g, "''");
  const mock = `function Get-ItemProperty { [pscustomobject]@{ DeleteFlag = 1 } }; function Start-Sleep {}; function Get-CimInstance { throw 'unexpected service query' }; $env:RDP_INSTALL_DIR = 'C:\\RDP-Manager-Test'; & '${target}'`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', mock], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /marked for deletion/i); assert.doesNotMatch(result.stderr, /unexpected service query/i);
});

test('upgrades retain service registration; component removal remains explicit', () => {
  const uninstall = script.slice(script.indexOf('!macro customUnInstall'));
  const upgrade = uninstall.slice(uninstall.indexOf('${If} ${isUpdated}'), uninstall.indexOf('${ElseIfNot} ${isUpdated}'));
  assert.match(upgrade, /prepare-server-service\.ps1/);
  assert.doesNotMatch(upgrade, /RDPManagerServer\.exe" uninstall/);
  assert.match(uninstall.slice(uninstall.indexOf('${ElseIfNot} ${isUpdated}')), /RDPManagerServer\.exe" uninstall/);
  assert.match(script, /remove-server-service\.ps1/);
});
