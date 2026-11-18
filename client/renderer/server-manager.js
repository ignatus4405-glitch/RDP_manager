'use strict';

const $ = (id) => document.getElementById(id);
const server = window.rdpManager.server;
let currentStatus = null;
let lastLogText = null;
let busy = false;
let toastTimer = null;

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.textContent = ''; }, 5000);
}

function setBadge(kind, label) {
  const badge = $('statusBadge');
  badge.className = `badge ${kind}`;
  badge.textContent = label;
}

function renderStatus(status) {
  currentStatus = status;
  if (!status.supported) {
    setBadge('missing', 'Только Windows');
    $('statusDetails').textContent = 'Управление службой Windows доступно только в Windows-версии.';
  } else if (!status.installed) {
    setBadge(status.state === 'unknown' ? 'error' : 'missing', status.state === 'unknown' ? 'Ошибка' : 'Не установлена');
    $('statusDetails').textContent = status.error || 'Служба отсутствует. Запустите единый установщик и выберите серверный компонент.';
  } else {
    const captions = {
      running: ['running', 'Работает', 'Служба запущена и принимает подключения.'],
      stopped: ['stopped', 'Остановлена', 'Служба установлена, но сейчас не запущена.'],
      'start-pending': ['pending', 'Запускается', 'Windows запускает службу…'],
      'stop-pending': ['pending', 'Останавливается', 'Windows останавливает службу…'],
      'continue-pending': ['pending', 'Возобновляется', 'Windows возобновляет службу…'],
      'pause-pending': ['pending', 'Приостанавливается', 'Windows приостанавливает службу…'],
      paused: ['stopped', 'Приостановлена', 'Служба приостановлена.'],
    };
    const [kind, label, description] = captions[status.state] || ['pending', 'Состояние неизвестно', `Код состояния службы: ${status.stateCode ?? '—'}`];
    setBadge(kind, label);
    $('statusDetails').textContent = description;
  }
  const installed = Boolean(status.supported && status.installed);
  $('btnStart').disabled = busy || !installed || status.state === 'running' || status.state === 'start-pending';
  $('btnStop').disabled = busy || !installed || status.state === 'stopped' || status.state === 'stop-pending';
  $('btnRestart').disabled = busy || !installed || !['running', 'stopped'].includes(status.state);
}

async function refreshStatus() {
  try { renderStatus(await server.status()); }
  catch (error) { setBadge('error', 'Ошибка'); $('statusDetails').textContent = error.message; }
}

async function refreshLogs() {
  try {
    const result = await server.logs();
    $('logInfo').textContent = `${result.logFile} · ${result.modifiedAt ? `обновлён ${new Date(result.modifiedAt).toLocaleTimeString()}` : 'ещё нет записей'}`;
    let text = result.text || (result.exists ? 'Файл журнала пуст.' : 'Файл журнала ещё не создан. Запустите службу, чтобы появились записи.');
    if (result.truncated) text = '…показан конец журнала…\n' + text;
    if (text !== lastLogText) {
      $('logOutput').textContent = text;
      $('logOutput').scrollTop = $('logOutput').scrollHeight;
      lastLogText = text;
    }
  } catch (error) {
    $('logInfo').textContent = 'Не удалось прочитать лог';
    $('logOutput').textContent = error.message;
  }
}

async function runAction(action) {
  if (busy) return;
  busy = true;
  for (const id of ['btnStart', 'btnStop', 'btnRestart']) $(id).disabled = true;
  setBadge('pending', 'Выполняется…');
  $('statusDetails').textContent = 'Windows может запросить подтверждение администратора (UAC).';
  try {
    const result = await server.action(action);
    toast(result.message || 'Команда службы выполнена.');
    await refreshStatus();
    await refreshLogs();
  } catch (error) {
    toast(error.message || 'Не удалось выполнить команду службы.');
    await refreshStatus();
  } finally {
    busy = false;
    await refreshStatus();
  }
}

async function checkUpdates() {
  $('updateMessage').textContent = 'Проверяю GitHub Releases…';
  $('btnCheckUpdates').disabled = true;
  $('btnRelease').classList.add('hidden');
  try {
    const result = await server.checkUpdates();
    if (result.available) {
      $('updateMessage').textContent = `Доступна версия v${result.latest}; установлена v${result.current}.`;
      $('btnRelease').classList.remove('hidden');
      $('btnRelease').onclick = () => server.openRelease(result.releaseUrl);
    } else {
      $('updateMessage').textContent = result.latest
        ? `Установлена последняя версия v${result.current}.`
        : `Сейчас установлена версия v${result.current}.`;
    }
  } catch (error) {
    $('updateMessage').textContent = `Не удалось проверить обновления: ${error.message}`;
  } finally {
    $('btnCheckUpdates').disabled = false;
  }
}

$('btnStart').addEventListener('click', () => runAction('start'));
$('btnStop').addEventListener('click', () => runAction('stop'));
$('btnRestart').addEventListener('click', () => runAction('restart'));
$('btnPanel').addEventListener('click', async () => {
  try {
    const result = await server.openPanel();
    if (!result.ok) toast(result.message || 'Служба не запущена.');
  } catch (error) { toast(error.message); }
});
$('btnCheckUpdates').addEventListener('click', checkUpdates);
$('btnRelease').addEventListener('click', () => server.openRelease());
$('btnRefreshLogs').addEventListener('click', refreshLogs);
$('btnLogFolder').addEventListener('click', async () => {
  try { await server.openLogFolder(); }
  catch (error) { toast(error.message); }
});

server.onUpdateResult((result) => {
  if (result && result.error) $('updateMessage').textContent = `Не удалось проверить обновления: ${result.error}`;
  else if (result && result.available) {
    $('updateMessage').textContent = `Доступна версия v${result.latest}; установлена v${result.current}.`;
    $('btnRelease').classList.remove('hidden');
    $('btnRelease').onclick = () => server.openRelease(result.releaseUrl);
  }
});
server.onToast((message) => toast(message));

(async function start() {
  $('versionLabel').textContent = `v${await window.rdpManager.version()}`;
  await Promise.all([refreshStatus(), refreshLogs(), checkUpdates()]);
  setInterval(() => { if (!busy) refreshStatus(); }, 2500);
  setInterval(() => refreshLogs(), 2500);
})();
