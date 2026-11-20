'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// One helper per focused canvas. Stale helpers must never send to a new session.
function createWindowsLayoutHook({ executable, spawnProcess = spawn, onSwitch, onError = () => {} }) {
  let active = null;
  function stop() {
    const old = active;
    active = null;
    if (old) { old.lines.close(); old.child.stdin.end(); old.child.kill(); }
  }
  function start(hwnd) {
    stop();
    const child = spawnProcess(executable, [String(hwnd)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, lines: readline.createInterface({ input: child.stdout, crlfDelay: Infinity }) };
    active = state;
    child.stdin.on('error', () => {});
    child.stderr.resume();
    state.lines.on('line', (line) => { if (active === state && line === 'SWITCH') onSwitch(); });
    child.on('error', (error) => { if (active === state) { stop(); onError(error); } });
    child.on('exit', (code) => { if (active === state) { stop(); onError(new Error(`Keyboard hook exited (${code}).`)); } });
  }
  return { start, stop };
}
module.exports = { createWindowsLayoutHook };
