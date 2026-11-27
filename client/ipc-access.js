'use strict';
const { pathToFileURL } = require('node:url');
function requireWindowFrame(event, window, expectedFile) {
  const contents = window && !window.isDestroyed() ? window.webContents : null;
  if (!contents || event?.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== pathToFileURL(expectedFile).href) {
    throw new Error('Недопустимый отправитель IPC.');
  }
}
module.exports = { requireWindowFrame };
