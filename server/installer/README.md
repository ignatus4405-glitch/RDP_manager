# Установщики RDP Manager Server

Сервер распространяется в виде **однофайлового нативного исполняемого файла** (SEA — Single Executable Application Node.js: внутри бинарника скомпилированный бандл сервера, зависимости и сам рантайм Node; наружу нужен только папка `web/`). База данных (`data/`) создаётся рядом с исполняемым файлом при первом запуске.

## Windows → `RDPManager-Server-Setup-<версия>.exe`

NSIS-установщик (`windows/installer.nsi`):

- ставит в `C:\Program Files\RDP Manager Server\` (бинарь + `web/`);
- создаёт `data\` рядом (под системными правами);
- регистрирует автозапуск **от SYSTEM при старте Windows** (Планировщик заданий, задача «RDP Manager Server») и сразу запускает сервер;
- открывает входящий **TCP 8720** в брандмауэре Windows;
- добавляет ярлыки «Панель сервера» и «Удалить…» в меню Пуск, запись в «Установка и удаление программ»;
- деинсталляция спрашивает, удалять ли базу данных (по умолчанию — оставить).

> Права администратора требуются. Сервер слушает `0.0.0.0:8720`, доступен по сети.

## Linux → `RDPManager-Server-<версия>-linux-x64.tar.gz`

```bash
tar -xzf RDPManager-Server-<версия>-linux-x64.tar.gz
cd rdp-manager-server
sudo bash install.sh
```

`install.sh`:
- ставит в `/opt/rdp-manager-server/`;
- создаёт системного пользователя `rdp-manager` (без логина) — сервер работает не от root;
- создаёт systemd-юнит `/etc/systemd/system/rdp-manager-server.service`, включает и запускает его;
- печатает адрес панели и подсказки (`journalctl -u rdp-manager-server -f`).

Удаление без потери БД: `sudo bash uninstall.sh`; полное удаление (с БД): `sudo bash uninstall.sh --purge`.
> Если нужен другой порт: `sudo systemctl edit rdp-manager-server` → `[Service]` → `Environment=RDP_MANAGER_PORT=9000`, затем `daemon-reload && restart`.

## Сборка вручную (из репозитория)

```bash
npm ci
npm run build:sea --workspace server      # esbuild → SEA (тот же рантайм, что на runner'е)
# Дальше staging: см. job build-server в .github/workflows/build.yml
```

На CI для Windows установщик собирается через `choco install nsis` и `makensis /DVERSION=<версия> installer.nsi`.
