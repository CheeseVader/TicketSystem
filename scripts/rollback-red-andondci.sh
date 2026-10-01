#!/usr/bin/env bash
set -Eeuo pipefail
BACKUP="${ANDON_DCI_NETWORK_BACKUP:-/var/backups/andon-dci-network-core/LAST}"

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Ejecuta con sudo."; exit 1; }
if [[ -L "$BACKUP" ]]; then BACKUP="$(readlink -f "$BACKUP")"; fi
[[ -d "$BACKUP" && -f "$BACKUP/paths.list" ]] || { echo "Backup invalido: $BACKUP"; exit 2; }

echo "Restaurando ANDON/DCI network layer desde: $BACKUP"
while IFS='|' read -r state p; do
  [[ -n "${p:-}" ]] || continue
  rm -rf "$p"
  if [[ "$state" == "EXISTS" ]]; then
    src="$BACKUP/rootfs$p"
    if [[ -e "$src" || -L "$src" ]]; then
      mkdir -p "$(dirname "$p")"
      cp -a "$src" "$p"
      echo "[OK] $p"
    fi
  fi
done < "$BACKUP/paths.list"

systemctl daemon-reload

if [[ -f "$BACKUP/services.list" ]]; then
  while IFS='|' read -r unit enabled active; do
    [[ -n "${unit:-}" ]] || continue
    case "$enabled" in
      enabled|enabled-runtime|linked|linked-runtime) systemctl enable "$unit" >/dev/null 2>&1 || true ;;
      *) systemctl disable "$unit" >/dev/null 2>&1 || true ;;
    esac
    if [[ "$active" == "active" ]]; then
      systemctl restart "$unit" >/dev/null 2>&1 || true
    else
      systemctl stop "$unit" >/dev/null 2>&1 || true
    fi
  done < "$BACKUP/services.list"
fi

sysctl --system >/dev/null 2>&1 || true
nginx -t >/dev/null 2>&1 && systemctl restart nginx || true
systemctl restart avahi-daemon >/dev/null 2>&1 || true

echo "Rollback de red terminado."
