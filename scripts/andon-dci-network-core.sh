#!/usr/bin/env bash
set -Eeuo pipefail

CORE_VERSION="2.3.2"
SERVICE_IP="${ANDON_DCI_SERVICE_IP:-10.138.43.217}"
BACKUP_ROOT="/var/backups/andon-dci-network-core"
RECOVERY_ROOT="/var/backups/andon-dci-network-recovery"
STAMP="$(date +%Y%m%d-%H%M%S)"
SAFETY="$RECOVERY_ROOT/$STAMP"
MARKER="/var/lib/andon-dci-network-core.version"

say(){ printf '\n==> %s\n' "$*"; }
ok(){ printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
die(){ printf '[ERROR] %s\n' "$*" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Este recovery requiere root."

say "ANDON/DCI Network Recovery $CORE_VERSION - restore pre-change network state"

TARGET_IF="$(
  ip -4 -o addr show scope global 2>/dev/null |
  awk -v ip="$SERVICE_IP" '$4 ~ ("^" ip "/") {print $2; exit}'
)"
if [[ -z "${TARGET_IF:-}" ]]; then
  DEFAULT_LINE="$(ip -4 route show default 2>/dev/null | head -n1 || true)"
  TARGET_IF="$(awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}' <<<"$DEFAULT_LINE")"
  SERVICE_IP="$(ip -4 -o addr show dev "$TARGET_IF" scope global 2>/dev/null | awk 'NR==1{split($4,a,"/");print a[1]}')"
fi
[[ -n "${TARGET_IF:-}" && -n "${SERVICE_IP:-}" ]] || die "No pude detectar interfaz/IP."

GATEWAY="$(ip -4 route show default dev "$TARGET_IF" 2>/dev/null | awk 'NR==1{print $3}')"
[[ -n "${GATEWAY:-}" ]] || die "No pude detectar gateway."

mkdir -p "$SAFETY/rootfs" "$RECOVERY_ROOT"
: > "$SAFETY/paths.list"
: > "$SAFETY/services.list"
ip -4 route show table main > "$SAFETY/routes-before.txt" || true
if [[ -f "$MARKER" ]]; then
  cp -a "$MARKER" "$SAFETY/core-marker.before"
fi

MANAGED_PATHS=(
  /etc/avahi/avahi-daemon.conf
  /etc/avahi/hosts
  /etc/avahi/services/andon.service
  /etc/avahi/services/dci.service
  /etc/nginx/sites-available/andon
  /etc/nginx/sites-available/dci
  /etc/nginx/sites-enabled/default
  /etc/nginx/sites-enabled/andon
  /etc/nginx/sites-enabled/dci
  /usr/local/sbin/andon-network-fix.sh
  /usr/local/sbin/andon-client-register.py
  /etc/systemd/system/andon-network-fix.service
  /etc/systemd/system/andon-client-register.service
  /etc/NetworkManager/dispatcher.d/90-andon-network-fix
  /etc/sysctl.d/90-andon-dci-network.conf
  /usr/local/sbin/andon-dci-vlan-routing.sh
  /etc/andon-dci-network.env
  /etc/systemd/system/andon-dci-vlan-routing.service
  /etc/NetworkManager/dispatcher.d/91-andon-dci-vlan-routing
)

backup_path(){
  local p="$1"
  if [[ -e "$p" || -L "$p" ]]; then
    printf 'EXISTS|%s\n' "$p" >> "$SAFETY/paths.list"
    mkdir -p "$SAFETY/rootfs$(dirname "$p")"
    cp -a "$p" "$SAFETY/rootfs$p"
  else
    printf 'ABSENT|%s\n' "$p" >> "$SAFETY/paths.list"
  fi
}
for p in "${MANAGED_PATHS[@]}"; do backup_path "$p"; done

for u in \
  andon-network-fix.service \
  andon-client-register.service \
  andon-dci-vlan-routing.service \
  avahi-daemon.service \
  nginx.service
do
  printf '%s|%s|%s\n' \
    "$u" \
    "$(systemctl is-enabled "$u" 2>/dev/null || true)" \
    "$(systemctl is-active "$u" 2>/dev/null || true)" \
    >> "$SAFETY/services.list"
done

ok "Safety backup actual: $SAFETY"

restore_paths(){
  local SNAP="$1"
  [[ -f "$SNAP/paths.list" ]] || return 20
  while IFS='|' read -r state p; do
    [[ -n "${p:-}" ]] || continue
    rm -rf "$p"
    if [[ "$state" == "EXISTS" ]]; then
      local src="$SNAP/rootfs$p"
      [[ -e "$src" || -L "$src" ]] || {
        warn "Falta archivo esperado en backup: $src"
        return 21
      }
      mkdir -p "$(dirname "$p")"
      cp -a "$src" "$p"
    fi
  done < "$SNAP/paths.list"
}

restore_service_states(){
  local SNAP="$1"
  [[ -f "$SNAP/services.list" ]] || return 0
  while IFS='|' read -r unit enabled active; do
    [[ -n "${unit:-}" ]] || continue

    case "$enabled" in
      enabled|enabled-runtime|linked|linked-runtime|alias)
        systemctl enable "$unit" >/dev/null 2>&1 || true
        ;;
      disabled|masked|masked-runtime|static|indirect|generated|transient|not-found|"")
        systemctl disable "$unit" >/dev/null 2>&1 || true
        ;;
    esac

    case "$active" in
      active)
        systemctl restart "$unit" >/dev/null 2>&1 || systemctl start "$unit" >/dev/null 2>&1 || true
        ;;
      *)
        systemctl stop "$unit" >/dev/null 2>&1 || true
        ;;
    esac
  done < "$SNAP/services.list"
}

clear_managed_routes(){
  # Remove only policies introduced/managed by the recent Network Core work.
  for n in 40 41 42 43; do
    NET="10.138.${n}.0/24"
    while ip -4 route show "$NET" 2>/dev/null | grep -q .; do
      ip -4 route del "$NET" 2>/dev/null || break
    done
  done

  while ip -4 route show "$GATEWAY/32" 2>/dev/null | grep -q .; do
    ip -4 route del "$GATEWAY/32" 2>/dev/null || break
  done
}

apply_baseline_routes(){
  local ROUTES="$1"
  [[ -f "$ROUTES" ]] || return 22

  # Recreate only the two routes documented in the known-good mobile baseline.
  local r41 r42
  r41="$(grep -m1 -E '^10\.138\.41\.0/24[[:space:]]+via[[:space:]]+10\.138\.40\.1([[:space:]]|$)' "$ROUTES" || true)"
  r42="$(grep -m1 -E '^10\.138\.42\.0/24[[:space:]]+via[[:space:]]+10\.138\.40\.1([[:space:]]|$)' "$ROUTES" || true)"

  [[ -n "$r41" && -n "$r42" ]] || return 23

  ip -4 route replace 10.138.41.0/24 via 10.138.40.1 dev "$TARGET_IF" src "$SERVICE_IP" metric 20
  ip -4 route replace 10.138.42.0/24 via 10.138.40.1 dev "$TARGET_IF" src "$SERVICE_IP" metric 20
}

restore_runtime_from_snapshot(){
  local SNAP="$1"

  restore_paths "$SNAP" || return $?
  systemctl daemon-reload || true
  sysctl --system >/dev/null 2>&1 || true

  clear_managed_routes || true

  if [[ -f "$SNAP/routes-before.txt" ]]; then
    # Restore known baseline /24 return routes if they existed in the snapshot.
    if grep -q -E '^10\.138\.41\.0/24[[:space:]]+via[[:space:]]+10\.138\.40\.1' "$SNAP/routes-before.txt" &&
       grep -q -E '^10\.138\.42\.0/24[[:space:]]+via[[:space:]]+10\.138\.40\.1' "$SNAP/routes-before.txt"; then
      apply_baseline_routes "$SNAP/routes-before.txt" || true
    fi
  fi

  # Re-run whichever per-client fixer existed in that snapshot.
  if [[ -x /usr/local/sbin/andon-network-fix.sh ]]; then
    /usr/local/sbin/andon-network-fix.sh >/dev/null 2>&1 || true
  fi

  restore_service_states "$SNAP" || true

  if command -v nginx >/dev/null 2>&1; then
    nginx -t >/dev/null 2>&1 && systemctl restart nginx >/dev/null 2>&1 || true
  fi
  systemctl restart avahi-daemon >/dev/null 2>&1 || true
}

rollback(){
  rc=$?
  trap - ERR
  warn "Recovery fallo RC=$rc. Restaurando automaticamente el estado previo a esta actualizacion."
  restore_runtime_from_snapshot "$SAFETY" || true

  if [[ -f "$SAFETY/core-marker.before" ]]; then
    cp -a "$SAFETY/core-marker.before" "$MARKER" || true
  fi

  warn "ROLLBACK AUTOMATICO ejecutado."
  exit "$rc"
}
trap rollback ERR

say "Buscando backup PRE-CAMBIO conocido como funcional"

CANDIDATE=""
while IFS= read -r d; do
  [[ -d "$d" ]] || continue
  [[ -f "$d/routes-before.txt" ]] || continue
  [[ -f "$d/paths.list" ]] || continue

  # Exact known-good signature:
  #  - .41/24 and .42/24 via 10.138.40.1
  #  - no broad .40/24 or .43/24 policy
  #  - old Avahi had wide-area enabled
  grep -q -E '^10\.138\.41\.0/24[[:space:]]+via[[:space:]]+10\.138\.40\.1' "$d/routes-before.txt" || continue
  grep -q -E '^10\.138\.42\.0/24[[:space:]]+via[[:space:]]+10\.138\.40\.1' "$d/routes-before.txt" || continue
  grep -q -E '^10\.138\.40\.0/24[[:space:]]+via' "$d/routes-before.txt" && continue
  grep -q -E '^10\.138\.43\.0/24[[:space:]]+via' "$d/routes-before.txt" && continue

  AV="$d/rootfs/etc/avahi/avahi-daemon.conf"
  [[ -f "$AV" ]] || continue
  grep -q 'enable-wide-area=yes' "$AV" || continue

  CANDIDATE="$d"
  break
done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%p\n' 2>/dev/null | sort)

[[ -n "$CANDIDATE" ]] || die "No encontre backup pre-cambio con la firma de red movil funcional."

ok "Backup pre-cambio detectado automaticamente: $CANDIDATE"

say "Restaurando SOLO capa de red desde backup pre-cambio"
restore_paths "$CANDIDATE"
systemctl daemon-reload
sysctl --system >/dev/null 2>&1 || true

clear_managed_routes
apply_baseline_routes "$CANDIDATE/routes-before.txt"

if [[ -x /usr/local/sbin/andon-network-fix.sh ]]; then
  /usr/local/sbin/andon-network-fix.sh >/dev/null 2>&1 || true
fi

restore_service_states "$CANDIDATE"

# Ensure core services are usable after exact config restore.
if command -v nginx >/dev/null 2>&1; then
  nginx -t
  systemctl restart nginx
fi
systemctl restart avahi-daemon

say "Validando antes de aceptar la actualizacion"

ip -4 route show default dev "$TARGET_IF" | grep -q "via $GATEWAY"
ip -4 route show 10.138.41.0/24 | grep -q "via 10.138.40.1"
ip -4 route show 10.138.42.0/24 | grep -q "via 10.138.40.1"

ping -c 1 -W 3 "$GATEWAY" >/dev/null

curl -fsS --max-time 5 -H 'Host: andon.local' http://127.0.0.1/ >/dev/null
curl -fsS --max-time 5 -H 'Host: dci.local' http://127.0.0.1/datacenter/ >/dev/null

systemctl is-active --quiet nginx
systemctl is-active --quiet avahi-daemon

# Confirm the old Avahi behavior was really restored.
grep -q 'enable-wide-area=yes' /etc/avahi/avahi-daemon.conf

printf '%s\n' "$CORE_VERSION" > "$MARKER"
ip -4 route show table main > "$SAFETY/routes-after.txt" || true

trap - ERR

cat <<EOF

======================================================================
 ANDON/DCI NETWORK RECOVERY $CORE_VERSION OK
======================================================================
Se restauro automaticamente la capa de red PRE-CAMBIO conocida como funcional.

Backup origen : $CANDIDATE
Safety backup : $SAFETY
RPi            : $SERVICE_IP
Interfaz       : $TARGET_IF
Gateway        : $GATEWAY

Validado:
- default route
- 10.138.41.0/24 via 10.138.40.1
- 10.138.42.0/24 via 10.138.40.1
- gateway alcanzable
- Nginx OK
- ANDON localhost OK
- DCI localhost OK
- Avahi OK

Si cualquiera de estas validaciones hubiera fallado, el script habria
restaurado automaticamente el estado previo a esta actualizacion.
======================================================================
EOF