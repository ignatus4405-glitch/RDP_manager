#!/usr/bin/env bash
# ============================================================
#  RDP Manager Server — установщик для Linux
#  Использование:  sudo bash install.sh
#  Ожидает в своей папке: rdp-manager-server, web/, rdp-manager-server.service
# ============================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ошибка: запустите установщик от root:  sudo bash install.sh" >&2
  exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/rdp-manager-server
SERVICE_USER=rdp-manager

echo "==> Ставлю RDP Manager Server в ${DEST}"

# 1. Системный пользователь без логина
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 2. Файлы
mkdir -p "$DEST/data"
cp "$SRC/rdp-manager-server" "$DEST/rdp-manager-server"
chmod 755 "$DEST/rdp-manager-server"
rm -rf "$DEST/web"
cp -r "$SRC/web" "$DEST/web"
cp "$SRC/rdp-manager-server.service" /etc/systemd/system/rdp-manager-server.service

# 3. Права: всё принадлежит сервисному пользователю, БД живёт в data/
chown -R "$SERVICE_USER:$SERVICE_USER" "$DEST"

# 4. systemd: включить и запустить
systemctl daemon-reload
systemctl enable --now rdp-manager-server

# Предпочитаем «нормальный» LAN-адрес: пропускаем loopback и link-local (169.254.x.x)
IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -vE '^(127\.|169\.254\.)' | head -n 1 || true)"
IP="${IP:-127.0.0.1}"
echo ""
echo "============================================================"
echo "  RDP Manager Server установлен и запущен"
echo ""
echo "  API:             http://${IP:-<IP-сервера>}:8720/api"
echo "  Панель админа:   http://${IP:-<IP-сервера>}:8720/"
echo ""
echo "  Первый вход: admin / admin123  (смена пароля обязательна)"
echo "  Логи:         journalctl -u rdp-manager-server -f"
echo "  Данные:       ${DEST}/data"
echo "============================================================"
