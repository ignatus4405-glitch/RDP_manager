# RDP Manager

[![CI](https://github.com/ignatus4405-glitch/RDP_manager/actions/workflows/ci.yml/badge.svg)](https://github.com/ignatus4405-glitch/RDP_manager/actions/workflows/ci.yml)
[![Build](https://github.com/ignatus4405-glitch/RDP_manager/actions/workflows/build.yml/badge.svg)](https://github.com/ignatus4405-glitch/RDP_manager/actions/workflows/build.yml)
[![Release](https://github.com/ignatus4405-glitch/RDP_manager/actions/workflows/release.yml/badge.svg)](https://github.com/ignatus4405-glitch/RDP_manager/actions/workflows/release.yml)
[Changelog](CHANGELOG.md)

Централизованное хранилище и лаунчер подключений **RDP / AnyDesk / RustDesk** с встроенной документацией.
Состоит из двух частей:

| Часть | Что это | Где запускается |
|-------|---------|-----------------|
| **Сервер** (`server/`) | Отдельная программа: база данных всех подключений, документов и учётных записей. REST API + SQLite + встроенная веб-панель администратора | Любой компьютер/сервер в локальной сети (Windows, Linux) |
| **Десктоп-клиент** (`client/`) | Программа на компьютере сотрудника: вход под своей учётной записью, поиск по базе, запуск RDP / AnyDesk / RustDesk в один клик, чтение документации | Компьютеры сотрудников и администраторов |

## Структура репозитория

```
RDP_manager/
├── server/                 # Серверная часть (Node.js + Express + SQLite)
│   ├── src/
│   │   ├── index.js        # Точка входа: HTTP-сервер, раздача панели и веб-клиента
│   │   ├── api.js          # REST API: auth, пользователи, подключения, документы, статистика
│   │   ├── db.js           # SQLite (node:sqlite), схема БД, scrypt-хеши, первичный admin
│   │   └── auth.js         # HMAC-JWT токены, middleware авторизации и ролей
│   ├── web/index.html      # Встроенная веб-панель администратора (создание админов и пр.)
│   ├── scripts/build-sea.js  # Однофайловый SEA-бинарник сервера (esbuild + postject)
│   ├── installer/          # Установщики сервера: windows/installer.nsi, linux/install.sh + systemd-юнит
│   └── data/               # Создаётся при первом запуске: rdp-manager.db, secret.key (в .gitignore)
├── client/                 # Десктоп-клиент (Electron)
│   ├── main.js             # Главный процесс: окно + запуск mstsc / AnyDesk / RustDesk
│   ├── preload.js          # Безопасный IPC-мост (contextIsolation)
│   ├── renderer/           # UI: index.html, styles.css, app.js, md.js (Markdown)
│   └── assets/icon.png     # Иконка приложения
└── package.json            # npm workspaces: server + client
```

## Автосборка и автообновление (GitHub Actions)

Три workflow (`.github/workflows/`):

| Workflow | Когда запускается | Что делает |
|----------|-------------------|------------|
| **CI** (`ci.yml`) | каждый push (любая ветка) и PR | `node --check` всех JS, смоук-тесты сервера, проверка electron-builder |
| **Build** (`build.yml`) | любой push (ветки и теги), PR в `main`, вручную | сборка установщиков: клиент (**Windows NSIS** / **Linux AppImage**) и сервер (**Windows NSIS** / **Linux tar.gz**); генерация `latest(-linux).yml`; на теге `v*` — публикация в GitHub Release (softprops/action-gh-release) |
| **Release Please** (`release.yml`) | push в `main` | автоматический Release PR с bump версии и CHANGELOG по Conventional Commits; мерж создаёт тег и релиз |

**Как выйти новая версия (полностью автоматически):**
1. `feat:`/`fix:`-коммиты → в `main`;
2. release-please сам поднимет версию (например, 1.1.0 → 1.2.0) и changelog;
3. мерж Release PR → тег `v1.2.0` → Build собирает и публикует установщики;
4. установленные клиенты при старте (и раз в 6 ч) видят баннер «Доступна новая версия…»; обновление тихо скачивается и ставится по кнопке «Установить и перезапустить» или при выходе. В Профиле всегда есть «Проверить обновления» и номер версии.

Текущие версии пакетов: `1.2.0`. Подробности — `CONTRIBUTING.md`, `AGENTS.md`, `CHANGELOG.md`.

## Требования

- **Node.js ≥ 22.5** на сервере (используется встроенный `node:sqlite`, внешние нативные модули не нужны).
- На **клиентском** компьютере:
  - Windows: `mstsc.exe` (встроен), установленные AnyDesk и/или RustDesk;
  - Linux: `xfreerdp3`/`xfreerdp` или `remmina` для RDP, `anydesk`, `rustdesk` в `PATH`;
  - если программа не найдена в `PATH`, клиент вызовет системный protocol-обработчик (`anydesk:`, `rustdesk://`).
- Сеть: клиентские ПК должны видеть порт сервера (по умолчанию **8720**, TCP).

## Установка из готовых установщиков (рекомендуется)

В каждом GitHub Release лежат **два отдельных продукта** (и клиент, и сервер):

| Файл | Что | Куда ставится |
|------|-----|----------------|
| `RDPManager-Setup-<версия>.exe` | десктоп-клиент (Windows, NSIS) | `C:\Program Files\RDP Manager` |
| `RDPManager-<версия>.AppImage` | десктоп-клиент (Linux) | портативно |
| `RDPManager-Server-Setup-<версия>.exe` | **сервер** (Windows, NSIS) | `C:\Program Files\RDP Manager Server` |
| `RDPManager-Server-<версия>-linux-x64.tar.gz` | **сервер** (Linux) | `/opt/rdp-manager-server` |

**Сервер на Windows**: запустите `RDPManager-Server-Setup-<версия>.exe` от имени администратора — сервер поставится, зарегистрируется в автозапуске от SYSTEM, запустится сразу, порт 8720 будет открыт в брандмауэре. Панель: `http://<IP-сервера>:8720/`.

**Сервер на Linux**:
```bash
tar -xzf RDPManager-Server-<версия>-linux-x64.tar.gz
cd rdp-manager-server
sudo bash install.sh
```
Ставит в `/opt/rdp-manager-server`, запускает systemd-юнит `rdp-manager-server` (пользователь `rdp-manager`). Логи: `journalctl -u rdp-manager-server -f`. Удаление: `sudo bash uninstall.sh` (БД сохраняется), полный снос: `sudo bash uninstall.sh --purge`.

**Дальше на каждом клиентском ПК**: поставьте `RDPManager-Setup-<версия>.exe` / AppImage, в окне входа укажите `http://<IP-сервера>:8720`, логин и пароль.

## Быстрый старт: сервер (из исходников)

```bash
npm install          # установить зависимости (server + client)
npm run server       # запустить сервер
```

При первом запуске создаётся база (`server/data/rdp-manager.db`) и учётная запись администратора:

```
логин:  admin
пароль: admin123   ← смена обязательна при первом входе (клиент потребует это явно)
```

После запуска доступно:

- **API:** `http://<IP-сервера>:8720/api`
- **Веб-панель администратора:** `http://<IP-сервера>:8720/` — состояние сервера и управление учётными записями (создание админов и сотрудников, сброс паролей, отключение, удаление)
- **Веб-режим клиента:** `http://<IP-сервера>:8720/app/` — тот же клиент в браузере (удобно проверить, что сервер работает; запуск подключений и документов из браузера ограничен — полный режим только в десктоп-клиенте)

## Быстрый старт: десктоп-клиент

```bash
npm run client       # dev-запуск Electron-окна
```

В окне входа указывается **адрес сервера** (например `http://192.168.0.10:8720`), логин и пароль. Адрес запоминается на этом ПК.

### Сборка установщика

```bash
npm run dist         # client → electron-builder (Windows: NSIS, Linux: AppImage)
```

Готовые файлы появятся в `client/dist/`.
> При `npm install` бинарник Electron скачивается с GitHub Releases — машине сборки нужен доступ к `github.com`. За прокси задайте `NODE_EXTRA_CA_CERTS=/path/to/ca.crt` или `ELECTRON_MIRROR`.

## Возможности

**Сотрудник (роль `employee`)**
- Вход под своей учётной записью
- Поиск по подключениям: название, адрес, описание, теги; фильтры по типу (RDP/AnyDesk/RustDesk), категории и тегу; счётчики
- Запуск подключения в один клик («Подключить →»)
- Чтение документации (Markdown) с поиском и разделами
- Смена собственного пароля

**Администратор (роль `admin`)** — всё перечисленное, плюс:
- Добавление / редактирование / удаление подключений (тип, адрес, порт, категория, теги, логин, описание)
- Создание и редактирование документов (Markdown)
- Управление учётными записями: создание админов и сотрудников, отключение, сброс пароля, удаление (менять и удалять собственную запись нельзя — защита от потери доступа)

## Как выполняется подключение

| Тип | Windows | Linux |
|-----|---------|-------|
| RDP | `mstsc.exe /v:<адрес>[:port] [/u:user]` | `xfreerdp3` → `xfreerdp` → `remmina` (что найдётся в PATH) |
| AnyDesk | `"AnyDesk.exe" <id>` (из Program Files), иначе `anydesk:<id>` | `anydesk <id>`, иначе `anydesk:<id>` |
| RustDesk | `rustdesk --connect <id>`, иначе `rustdesk://<id>` | `rustdesk --connect <id>`, иначе `rustdesk://<id>` |

Пароли от самих подключений в базе не хранятся (только при необходимости логин) — их вводит пользователь в самом RDP/AnyDesk/RustDesk-клиенте.

## REST API (кратко)

Все маршруты, кроме `/api/login` и `/api/health`, требуют `Authorization: Bearer <token>`. Запись — только администраторам.

```
POST /api/login                  вход, выдаёт токен (12 ч) и профиль
GET  /api/me                     текущий пользователь
POST /api/change-password        смена своего пароля
GET  /api/stats                  счётчики (для панели)

GET    /api/users                список учётных записей            (admin)
POST   /api/users                создать учётную запись            (admin)
PUT    /api/users/:id            изменить ФИО / роль / отключение  (admin)
POST   /api/users/:id/reset-password  сброс пароля                 (admin)
DELETE /api/users/:id            удалить (не себя)                 (admin)

GET    /api/connections?search=&type=&category=&tag=   список + фильтры
GET    /api/connections/meta     категории, теги, счётчики по типам
POST   /api/connections          создать                             (admin)
PUT    /api/connections/:id      изменить                            (admin)
DELETE /api/connections/:id      удалить                             (admin)

GET    /api/documents?search=&category=   список + разделы
GET    /api/documents/:id                 документ целиком
POST   /api/documents                     создать                    (admin)
PUT    /api/documents/:id                 изменить                   (admin)
DELETE /api/documents/:id                 удалить                    (admin)
```

## Переменные окружения сервера

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `RDP_MANAGER_PORT` | `8720` | Порт HTTP |
| `RDP_MANAGER_HOST` | `0.0.0.0` | Адрес привязки |
| `RDP_MANAGER_DATA` | `server/data` | Каталог БД и ключа токенов |
| `RDP_MANAGER_SECRET` | генерируется в `data/secret.key` | Секрет подписи токенов |
| `RDP_MANAGER_ADMIN_PASSWORD` | `admin123` | Пароль admin при **первом** запуске |
| `RDP_MANAGER_TOKEN_TTL` | `43200` (12 ч) | Время жизни токена, сек |

## Безопасность

- Пароли хешируются **scrypt** (N=16384) с индивидуальной солью, сравнение через `timingSafeEqual`
- Токены — HMAC-SHA256 JWT, секрет хранится в `data/secret.key` (chmod 600) и переживает перезапуск
- Новые учётные записи и сброшенные пароли требуют смены при первом входе
- Администратор не может отключить, понизить или удалить **себя**
- Рендерер клиента: `contextIsolation`, без `nodeIntegration`, CSP, весь пользовательский HTML экранируется

## Резервное копирование

База — один файл SQLite (`server/data/rdp-manager.db`, WAL-режим). Достаточно регулярно копировать каталог `server/data/` при остановленном сервере, например:

```bash
# Windows (Планировщик заданий)
xcopy C:\RDP_manager\server\data D:\backup\rdp-manager /E /Y

# Linux (cron)
0 2 * * *  systemctl stop rdp-manager && cp -a /opt/RDP_manager/server/data /backup/ && systemctl start rdp-manager
```

Более аккуратно — онлайн-бэкап без остановки: `sqlite3 server/data/rdp-manager.db ".backup backup.db"`.

## Обслуживание

- **Сменить пароль admin:** веб-панель → «Сброс пароля», или в клиенте → Пользователи.
- **Забыть пароль admin полностью:** остановить сервер, удалить `server/data/rdp-manager.db` — при следующем запуске создастся новая БД (все данные будут потеряны!) с admin/admin123. Поэтому регулярно делайте бэкап.
- **Обновление приложения:** `git pull && npm install && npm run server`.

## Документация в репозитории

- `CHANGELOG.md` — история изменений (поддерживается release-please)
- `CONTRIBUTING.md` — как контрибьютить и как выходит релиз (Conventional Commits, автообновление)
- `AGENTS.md` — карта проекта и правила для любого агента, продолжающего работу

## Статус реализации / ограничения

- Проверено end-to-end: API (авторизация, CRUD подключений/документов/пользователей, поиск, фильтры), запуск сервера, веб-панель и веб-режим клиента — `http://<IP>:8720/app/`. Смоук-тесты сервера зелёные (`npm test`).
- Графический интерфейс клиента реализован на Electron; бинарник Electron намеренно не входит в репозиторий (ставится через `npm install`).
- Автообновление клиента требует опубликованного GitHub Release с установщиками и `latest.yml`; появляется после мержа Release PR (см. выше). В приватном репозитории автообновление не скачает релиз анонимно — см. `CONTRIBUTING.md`.
- RustDesk и AnyDesk запускаются как внешние программы — они должны быть установлены на клиентском ПК.
- Пароли RDP/AnyDesk/RustDesk не хранятся и не передаются через сервер.
