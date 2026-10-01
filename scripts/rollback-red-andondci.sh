#!/usr/bin/env bash
set -Eeuo pipefail
BACKUP="${ANDON_DCI_BACKUP:-/var/backups/andon-dci-network-core/LAST}"
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Ejecuta con sudo"; exit 1; }
[[ -L "$BACKUP" ]] && BACKUP="$(readlink -f "$BACKUP")"
[[ -f "$BACKUP/paths.list" ]] || { echo "Backup invalido: $BACKUP"; exit 2; }

while IFS='|' read -r state p; do
  [[ -n "${p:-}" ]] || continue
  rm -rf "$p"
  if [[ "$state" == "EXISTS" ]]; then
    src="$BACKUP/rootfs$p"
    [[ -e "$src" || -L "$src" ]] && { mkdir -p "$(dirname "$p")"; cp -a "$src" "$p"; }
  fi
done < "$BACKUP/paths.list"

systemctl daemon-reload
sysctl --system >/dev/null 2>&1 || true
nginx -t >/dev/null 2>&1 && systemctl restart nginx || true
systemctl restart avahi-daemon >/dev/null 2>&1 || true
echo "Rollback de red restaurado desde $BACKUP"
