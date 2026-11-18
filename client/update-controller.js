'use strict';

// One state source for both Electron windows; events may fire before the renderer loads.
function createUpdateController({ updater, supported, currentVersion, onChange = () => {} }) {
  let state = { supported: Boolean(supported && updater), phase: 'idle', version: null, currentVersion, progress: null, error: null };
  let checking = null;
  const publish = (patch) => { state = { ...state, ...patch }; onChange({ ...state }); };
  if (state.supported) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.on('update-available', (info) => publish({ phase: 'downloading', version: info?.version || null, progress: 0, error: null }));
    updater.on('update-not-available', () => publish({ phase: 'current', version: currentVersion, progress: null, error: null }));
    updater.on('download-progress', (info) => publish({ phase: 'downloading', progress: Math.max(0, Math.min(100, Math.round(info.percent || 0))) }));
    updater.on('update-downloaded', (info) => publish({ phase: 'ready', version: info?.version || state.version, progress: 100, error: null }));
    updater.on('error', (error) => publish({ phase: 'error', error: String(error?.message || error), progress: null }));
  }
  return {
    getState: () => ({ ...state }),
    check() {
      if (!state.supported || state.phase === 'ready' || state.phase === 'downloading') return Promise.resolve({ ...state });
      if (checking) return checking;
      publish({ phase: 'checking', error: null, progress: null });
      checking = Promise.resolve().then(() => updater.checkForUpdates()).then(() => ({ ...state })).catch((error) => {
        publish({ phase: 'error', error: String(error?.message || error), progress: null });
        return { ...state };
      }).finally(() => { checking = null; });
      return checking;
    },
    install() {
      if (!state.supported || state.phase !== 'ready') return false;
      updater.quitAndInstall(false, false);
      return true;
    },
  };
}

module.exports = { createUpdateController };
