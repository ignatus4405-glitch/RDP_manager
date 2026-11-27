# AGENTS.md — инструкция для любого агента, продолжающего проект

Прочитайте это ПЕРЕД внесением изменений. Здесь — карта проекта, команды, релизный цикл и грабли.

## Что это за проект
RDP Manager — система единого доступа к инфраструктуре для компании:
- **server/** — отдельная серверная программа: REST API + SQLite, база подключений RDP/AnyDesk/RustDesk, документация, учётные записи (admin/employee). Встроенная веб-панель (`/`) и веб-режим клиента (`/app/`).
- **client/** — Electron-клиент сотрудников и отдельный GUI-компаньон для Windows-службы: управление службой, окно логов и системный трей.

Стек: Node.js ≥ 22.5, Express 4, встроенный `node:sqlite` (без нативных модулей), Electron + electron-builder + electron-updater. Для встроенного RDP — IronRDP (WebAssembly) + RDCleanPath поверх WebSocket (шлюз на сервере, без нативных модулей). Внешних сервисов нет — всё самодельное, работает в закрытой сети (кроме проверки обновлений GitHub).

## Команды
| Команда | Что делает |
|---|---|
| `npm install` | установка (workspaces server+client). **В sandbox без доступа к `objects.githubusercontent.com`** ставьте `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — иначе postinstall electron упадёт TLS-ошибкой; на обычной машине ставить НЕ нужно |
| `npm run server` | запуск сервера :8720. При первом старте создаёт `server/data/rdp-manager.db` и `admin/admin123` (смена обязательна) |
| `npm run client` | Electron-клиент |
| `npm run server-manager` | GUI Windows-службы (в dev-режиме; служебные кнопки активны в Windows) |
| `npm run check` | `node --check` всех JS, включая менеджер и build-скрипт |
| `npm test` | тесты сервера и client utilities: smoke, RDP gateway, файловый лог, Windows service status/log-tail |
| `npm run dist` | единый Windows NSIS (клиент / Windows-служба / оба) или Linux AppImage |
| `npm run build:ironrdp --workspace client` | сборка `client/renderer/vendor/ironrdp/bundle.js` (esbuild) — обязательна перед запуском/сборкой клиента |
| `npm run build:sea --workspace server` | сборка однофайлового сервера (esbuild → SEA) в `server/dist/rdp-manager-server[.exe]` |
| `npm run stage:windows-server --workspace client` | скачивает/проверяет закреплённый WinSW и готовит `client/build/server-payload/` для общего Windows-установщика |
| `node client/scripts/make-latest-yml.js` | генерация `latest(-linux).yml` для автообновления (CI делает сам на тегах) |
| `server/installer/linux/install.sh` | установка сервера в `/opt/rdp-manager-server` + systemd (внутри tar.gz) |
| `client/build/installer.nsh` + `server/installer/windows/RDPManagerServer.xml` | единый компонентный NSIS для Windows и конфигурация WinSW-службы |

## Карта файлов
```
server/src/index.js   — HTTP-сервер, статика панели (/) и веб-клиента (/app/), WebSocket-upgrade, запуск файлового логгера
server/src/file-logger.js — файловый `server.log` с ротацией (включается `RDP_MANAGER_LOG_DIR`; в Windows Service лежит в ProgramData)
server/src/api.js     — все маршруты /api: login, change-password, users CRUD, connections CRUD + /meta, documents CRUD, stats
server/src/db.js      — схема SQLite, seed admin, scrypt hash/verify, секрет токенов (data/secret.key)
server/src/auth.js    — HMAC-JWT (sign/verify), requireAuth, requireAdmin (12 ч TTL, env RDP_MANAGER_TOKEN_TTL)
server/src/rdp-gateway.js — RDCleanPath-шлюз: WS `/ws/rdp` → TCP/TLS → RDP; одноразовый тикет + проверка выбранной RDP-карточки; ASN.1 DER, адаптировано из electerm/ironrdp-wasm (MIT)
server/web/index.html — веб-панель администратора (vanilla JS, те же /api/*)
server/test/          — смоук + unit-тесты (smoke.test.js, rdp-gateway.test.js)
server/src/paths.js   — «домашний» каталог приложения (env → web/ рядом с exe (SEA) → dev из репозитория)
server/scripts/build-sea.js — esbuild-бандл + инъекция в node-бинарник (SEA)
server/installer/     — WinSW XML + license (Windows), install.sh/uninstall.sh + systemd-юнит (Linux), README
client/main.js        — Electron-клиент + `--server-manager` GUI/tray, IPC управления WinSW, обновления, внешние подключения
client/preload.js     — contextBridge: клиентский API + `rdpManager.server.*` для фиксированных команд/логов службы
client/server-manager-utils.js — парсер состояния службы, ограниченный tail лог-файла, сравнение версий
client/renderer/server-manager.* — окно состояния/управления/обновлений/логов службы
client/build/installer.nsh — NSIS-страница выбора client/server/both, WinSW install/uninstall, migration legacy server
client/scripts/stage-windows-server.js — staging SEA + pinned WinSW (SHA-256) для общего инсталлятора
client/renderer/*.js  — UI (vanilla, без фреймворка); md.js — безопасный Markdown→HTML
client/renderer/ironrdp-entry.mjs — вход IIFE-бандла встроенного RDP (IronRDP WASM, wasm как data:URL)
client/renderer/vendor/ — генерируется scripts/build-ironrdp.js (в .gitignore, НЕ коммитить; нужен для RDP-в-окне)
client/renderer/index.html — CSP: script-src 'self' 'wasm-unsafe-eval'; connect-src http: https: ws: wss:
.github/workflows/    — ci.yml (check+test на каждый push/PR), build.yml (установщики, publish на тегах v*), release.yml (release-please)
release-please-config.json / .release-please-manifest.json — конфигурация Release Please; в этом репозитории PR выпускается вручную из-за ограничений прав токена
```

## Релизный цикл (вручную)
1. Обычные изменения попадают в `main` через PR и проходят CI/Build.
2. После слияния изменений подготовьте отдельный release PR: синхронно обновите версии root/client/server, `package-lock.json`, release manifest и `CHANGELOG.md`.
3. Дождитесь зелёных проверок и влейте release PR.
4. Вручную создайте и отправьте тег `vX.Y.Z` на merge-коммит release PR. Не рассчитывайте на Release Please: workflow `release.yml` настроен, но `GITHUB_TOKEN` в репозитории не имеет права создавать PR.
5. Build на теге публикует единый Windows NSIS (клиент/служба/оба), Linux AppImage, Linux server tar.gz и `latest*.yml`. Проверьте assets через `gh release view vX.Y.Z`.
6. Клиент проверяет/загружает автообновление; Server Manager проверяет GitHub Releases при старте, раз в 6 ч и по кнопке, после чего открывает страницу релиза для ручного запуска компонента-установщика.
Подробности и приватный репозиторий: CONTRIBUTING.md.

## Встроенный RDP (как в RDM) — как устроено
- Клиент рендерит RDP на `<canvas>` через **IronRDP WASM** (`client/renderer/vendor/ironrdp/bundle.js`, собирается esbuild'ом из `renderer/ironrdp-entry.mjs`; WASM декодируется из data:URL в байты и передаётся в `WebAssembly.instantiate` напрямую — НИКАКОГО `fetch(data:)`: `connect-src` его блокирует).
- Между WASM и RDP-узлом — **RDCleanPath** (ASN.1 DER поверх WebSocket). Шлюз на сервере: `server/src/rdp-gateway.js` (`/ws/rdp`, зависимость `ws`), адаптирован из electerm/ironrdp-wasm (MIT) + аутентификация и allowlist.
- Аутентификация шлюза: одноразовый тикет из `POST /api/rdp/ticket` привязан к пользователю, выбранной карточке и IP; цели сверяются с соответствующей RDP-карточкой (host case-insensitive, порт по умолчанию 3389). Старый клиент и сервер с новыми тикетами несовместимы; для работы через балансировщик HTTP и WS должны попадать на один сервер с одинаковым видимым IP. Пароль RDP через шлюз не логируется (CredSSP выполняет WASM-клиент).
- Рендерер: полноэкранный `#rdpOverlay`, форма (username из карточки + пароль каждый раз), `desktopSize` по доступному пространству `.rdp-body` (чётные, до 4096×2160; расширение `display_control` + живой `session.resize()` при изменении окна через 250 мс debounce), ввод — PS/2-сканкоды (раскладка не влияет), буфер обмена — текст, двусторонний: remote→local через `remoteClipboardChangedCallback` → `clipboard.writeText` главного процесса (IPC `clipboard-read`/`clipboard-write` в `client/main.js` + `readClipboard`/`writeClipboard` в preload), local→remote — поллинг системного буфера раз в 800 мс во время сессии (API `navigator.clipboard` в renderer ненадёжен без жестов/разрешений), `Esc` уходит в сессию (закрыть окно можно с формы).
- Сборка: `npm run build:ironrdp --workspace client` (входит в `npm run dist`; CI собирать ничего отдельно не нужно). Unit-тесты шлюза: `server/test/rdp-gateway.test.js`.
- Ограничения: экзотика (RD Gateway, RemoteFX, smartcard, редиректы дисков) не поддерживается — для таких узлов есть кнопка «Во внешнем клиенте». Графическую часть проверяйте на реальной машине: в sandbox GUI нет.

## SEA (однофайловый сервер) — как устроено
- `esbuild` собирает весь сервер в один `dist/server.cjs`; встроенные модули (`node:sqlite`, `crypto`) внешние.
- `node --experimental-sea-config` → blob; чистый node-бинарник копируется в `dist/rdp-manager-server[.exe]`; `postject` внедряет blob (sentinel `NODE_SEA_FUSE_...`).
- Пути к `web/` и `data/` определяются в `src/paths.js` ЧЕРЕЗ `process.execPath` (а не `__dirname`!) — поэтому в бандле `__dirname` себя не спасёт: порядок — env `RDP_MANAGER_HOME` → `web/` рядом с исполняемым файлом → dev из репозитория.
- `web/` — обязательно рядом с бинарником (веб-панель); без неё статика просто не раздастся (не падает).
- SEA-бинарник ≈ 120 МБ (внутри рантайм Node); в релизе — как есть, сжимается самим GitHub.
- Локально SEA собирается и проверяется только на той же ОС; в CI Windows SEA входит в общий NSIS-клиент job, Linux SEA упаковывается в tar.gz отдельным job.
- Версия в баннере/`/api/health` берётся из `server/package.json` (инлайнится esbuild'ом).

## Подводные камни
1. **`node:sqlite` experimental** в Node 22 → везде используются `--disable-warning=ExperimentalWarning` (скрипты `server`); API стабилен в рамках нашей схемы. Если переходите на <22.5 — нужен `better-sqlite3` (нативная сборка).
2. **CSP клиента**: только внешние скрипты; `script-src 'self' 'wasm-unsafe-eval'` (нужен для WebAssembly), `connect-src http: https: ws: wss:` (адрес сервера вводится пользователем + WebSocket шлюза). Не добавляйте inline-обработчики.
2a. **`client/renderer/vendor/` НЕ коммитить** — бандл собирается `npm run build:ironrdp --workspace client` (автоматически из `npm run dist` и в CI перед electron-builder). Без него встроенный RDP не работает (форма покажет подсказку), остальное работает; «Во внешнем клиенте» на карточке/в панели — запасной путь.
3. **Теги подключений** хранятся через `tags` колонку `"a,b,c"` (без пробелов) — фильтр `tag=` требует точного совпадения элемента; нормализация на сервере (`normalizeTags`).
4. **Запуск программ**: адреса валидируются на управляющие символы; `spawn` без `shell` — не собирайте командную строку строкой. AnyDesk ID чистится от пробелов (`123 456 789` → `123456789`).
5. **Токены**: секрет подписи лежит в `server/data/secret.key` (создаётся при первом старте, НЕ коммитится; можно переопределить env `RDP_MANAGER_SECRET`). Если ключ удалить — все выданные токены перестанут быть валидными, пользователи просто войдут заново.
6. **БД и `must_change_password`**: свежий сервер всегда создаёт `admin/admin123` с обязательной сменой. Не коммитьте `server/data/`.
7. **Версии**: обновлять вручную только в release PR — синхронно в root/client/server `package.json`, `package-lock.json`, release manifest и CHANGELOG; обычные feature/fix PR версию не меняют.
8. **Публикация релиза** — вручную отправить тег `v*`, затем проверить assets командой `gh release view vX.Y.Z`. Build публикует единый Windows NSIS, AppImage, Linux server tar.gz и `latest*.yml` через `softprops/action-gh-release` (НЕ `electron-builder --publish`). `latest.yml`/`latest-linux.yml` генерирует `client/scripts/make-latest-yml.js`. **Секция `publish` в `build` клиента отсутствует намеренно** — при её наличии electron-builder требует GH_TOKEN даже при `--publish never`.
9. **Приватный репозиторий**: автообновление клиентов не скачает установщик анонимно — см. CONTRIBUTING.md.
10. **Аудит**: `npm audit` показывает moderate (minimatch, build-time цепочка electron-builder) — осознанно не блокируем CI; новые high+ уязвимости чините.
11. **electron — только в devDependencies и ТОЧНАЯ версия** (без `^`): иначе electron-builder мгновенно падает («only allowed in devDependencies» / «version is a range»). Версия electron должна совпадать с той, что скачана в node_modules.
12. **electron-updater в dependencies** клиента (не dev) — он нужен в собранном приложении. `electron-builder` и `electron` — devDependencies.

## После внесения изменений (чеклист агента)
1. `npm run check && npm test` — зелёные.
2. Conventional Commit (`feat(server): …` / `fix(client): …`).
3. Для заметных изменений добавьте запись в `CHANGELOG.md` в секцию Unreleased; перед релизом версию и историю синхронизирует отдельный release PR.
4. Обновите этот файл и `README.md`, если менялась архитектура/команды/релизный процесс.
5. Push → GitHub Actions (ci + build) отработает автоматически; для выпуска версии используйте ручной release PR, после его мержа отправьте тег `v*` и проверьте assets через `gh release view`.
6. Никогда не пушьте в `main` напрямую без ревью (кроме экстренных случаев), не коммитьте `server/data/`, не ломайте CSP.
