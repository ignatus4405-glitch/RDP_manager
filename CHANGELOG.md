# Changelog

Все значимые изменения проекта фиксируются здесь.
Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — по [SemVer](https://semver.org/lang/ru/).
Файл поддерживается автоматически [release-please](https://github.com/googleapis/release-please)
на основе [Conventional Commits](https://www.conventionalcommits.org/ru/v1.0.0/) — вручную редактировать не нужно,
если запись создаётся релиз-PR (см. CONTRIBUTING.md).

## [Unreleased]

### Исправлено
- Сборка клиента (electron-builder): `electron` перенесён из `dependencies` в `devDependencies` (раньше билд падал мгновенно с «Package electron is only allowed in devDependencies»); версия Electron закреплена точно (`45.3.3`, без `^`) — electron-builder требует exact version. Добавлены `author` и `license` (убраны предупреждения).
- CI Build: публикация релиза перенесена с `electron-builder --publish` на `softprops/action-gh-release` (убрана гонка матрицы Windows/Linux и нестабильность publish); `latest(-linux).yml` генерируется отдельным скриптом `client/scripts/make-latest-yml.js`.
- Смоук-тест сервера: на Windows ждём выхода дочернего процесса перед удалением временной папки SQLite (иначе EPERM/EBUSY); при падении сервера его лог выводится в ошибку.
- Build запускается на каждый push любой ветки, а не только `main`/теги.

## [1.1.0] - 2026-11-16

### Добавлено
- **CI** (`.github/workflows/ci.yml`): синтаксическая проверка всех JS, смоук-тесты сервера (`node:test`), проверка доступности electron-builder — на каждый push и PR.
- **Автосборка** (`.github/workflows/build.yml`): сборка установщиков Windows (NSIS) и Linux (AppImage) на push в `main`, на теги `v*`, на PR и вручную. Артефакты сохраняются (14 дней).
- **Автопубликация**: на теге `v*` установщики и `latest.yml` публикуются в GitHub Release (`electron-builder --publish always`).
- **Автоматическое версионирование** (`.github/workflows/release.yml`, release-please): Release PR с bump версии и этим changelog по Conventional Commits; мерж PR создаёт тег `vX.Y.Z`.
- **Клиент: уведомление о новой версии**. Собранное приложение при старте и раз в 6 часов проверяет GitHub Releases (electron-updater, тихая загрузка, установка при выходе / по кнопке «Установить и перезапустить»). В профиле — кнопка «Проверить обновления» и номер версии. В dev-режиме и в браузере проверка идёт через публичное Releases API GitHub с предложением скачать новую версию.
- **Смоук-тест сервера** (`server/test/smoke.test.js`): здоровье API, логин, CRUD, права доступа, смена пароля.
- Документация: `CHANGELOG.md`, `CONTRIBUTING.md`, `AGENTS.md` (инструкция для продолжения работы любым агентом), раздел про автосборку в `README.md`.

### Изменено
- Версии пакетов (`root`, `client`, `server`) подняты до `1.1.0`.
- Клиент переведён на компонентную версионную схему артефактов: `RDPManager-Setup-1.1.0.exe`, `RDPManager-1.1.0.AppImage`.
- `electron-builder` обновлён до `^26.18.0` (исправления предупреждений безопасности), `electron` — до `^45.3.3`.

### Технические заметки
- `electron-updater` публикует и потребляет `latest.yml` из GitHub Releases; требуется `contents: write` у `GITHUB_TOKEN` (выдан в workflows).
- Автообновление в приватном репозитории не работает анонимно — см. CONTRIBUTING.md, раздел «Приватный репозиторий».

## [1.0.0] - 2026-11-16

### Добавлено
- **Сервер** (`server/`): Node.js + Express + SQLite (`node:sqlite`).
  - REST API: авторизация JWT (HMAC-SHA256, 12 ч), роли `admin` / `employee`.
  - База подключений RDP / AnyDesk / RustDesk: категории, теги, полнотекстовый поиск, фильтры, счётчики.
  - Документация (Markdown) с разделами и поиском.
  - Управление учётными записями: создание администраторов и сотрудников, сброс пароля, отключение, удаление; защита от удаления/отключения собственной записи.
  - Пароли: scrypt + соль; принудительная смена при первом входе (поле `must_change_password`).
  - Встроенная веб-панель администратора (`/`) и веб-режим клиента (`/app/`).
  - Первичное наполнение: `admin` / `admin123` (смена обязательна).
- **Десктоп-клиент** (`client/`): Electron.
  - Вход под своей учётной записью, адрес сервера настраивается и сохраняется.
  - Поиск и фильтрация подключений, запуск в один клик: Windows — `mstsc` / AnyDesk / RustDesk; Linux — FreeRDP / Remmina (иначе protocol-handler).
  - Документация внутри приложения (Markdown-просмотр, свои стили).
  - Разделы «Пользователи» (только администратор) и «Профиль» (смена пароля).
