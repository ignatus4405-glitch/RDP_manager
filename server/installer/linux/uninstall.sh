#!/usr/bin/env bash
# ============================================================
#  RDP Manager Server — деинсталлятор для Linux
#  Использование:  sudo bash uninstall.sh          (сохранить БД)
#                  sudo bash uninstall.sh --purge  (удалить и БД)
# ============================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Ошибка: запустите от root:  sudo bash uninstall.sh" >&2
  exit 1
fi

DEST=/opt/rdp-manager-server
SERVICE_USER=rdp-manager

echo "==> Останавливаю и отключаю сервис"
systemctl disable --now rdp-manager-server 2>/dev/null || true
rm -f /etc/systemd/system/rdp-manager-server.service
systemctl daemon-reload || true

if [ "${1:-}" = "--purge" ]; then
  echo "==> Удаляю ${DEST} вместе с базой данных"
  rm -rf "$DEST"
  if id "$SERVICE_USER" &>/dev/null; then userdel "$SERVICE_USER" 2>/dev/null || true; fi
  echo "==> RDP Manager Server полностью удалён (включая БД)."
else
  echo "==> Удаляю программу, БД сохраняю в ${DEST}/data"
  rm -rf "$DEST/web" "$DEST/rdp-manager-server"
  echo "==> Для полного удаления (вместе с БД) запустите: sudo bash uninstall.sh --purge"
fi
