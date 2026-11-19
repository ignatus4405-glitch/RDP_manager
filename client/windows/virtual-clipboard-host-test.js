'use strict';
// Run only on Windows after compiling both native binaries. Exercises the real
// cross-process OLE clipboard and verifies data is requested only on paste.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const host = spawn(path.resolve('client/build/rdp-virtual-clipboard.exe'), [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
let tester;
let reads = 0;
const timeout = setTimeout(() => fail(new Error('OLE integration test timed out')), 30000);
function fail(error) {
  console.error(error);
  clearTimeout(timeout);
  if (tester) tester.kill();
  host.kill();
  process.exitCode = 1;
}
host.on('error', fail);
host.on('exit', (code) => { if (!tester && code !== 0) fail(new Error(`Host exited: ${code}`)); });
const lines = readline.createInterface({ input: host.stdout });
lines.on('line', (line) => {
  if (line === 'READY') {
    assert.equal(reads, 0);
    tester = spawn(path.resolve('virtual-clipboard-test.exe'), ['clipboard'], { stdio: 'inherit', windowsHide: true });
    tester.on('error', fail);
    tester.on('exit', (code) => {
      if (code !== 0 || reads !== 1) return fail(new Error(`Consumer exited ${code}; reads: ${reads}`));
      clearTimeout(timeout); host.kill(); lines.close();
    });
  } else if (line === 'READ 0 0 5') {
    reads++;
    host.stdin.write('+aGVsbG8=\n');
  } else fail(new Error(`Unexpected host output: ${line}`));
});
host.stdin.write(`1\n5 0 ${Buffer.from('hello.txt').toString('base64')}\n`);
