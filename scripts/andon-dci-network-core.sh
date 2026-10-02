#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CORE_VERSION="2.3.4"
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

say "ANDON/DCI Wi-Fi L2 Recovery $CORE_VERSION - pre-change association recovery"

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
  if declare -F restore_wifi_profile >/dev/null 2>&1; then
    restore_wifi_profile || true
  fi
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


# ---------------------------------------------------------------------
# Wi-Fi L2 recovery
#
# Evidence from mobile:
# - Android ARP Request for SERVICE_IP reaches wlan0.
# - RPi sends ARP Reply.
# - Mobile repeats ARP and never starts TCP.
#
# A safe RPi-side action is therefore limited to restoring the previous
# Wi-Fi association/profile when that exact historical association can be
# discovered. This block NEVER invents an AP/BSSID and NEVER leaves the
# RPi disconnected: any failed reassociation triggers automatic rollback.
# ---------------------------------------------------------------------
say "Wi-Fi L2: buscando asociacion PRE-CAMBIO verificable"

WIFI_DIR="/var/lib/andon-dci-wifi-recovery"
STATUS_JSON="$WIFI_DIR/status.json"
mkdir -p "$WIFI_DIR"

WIFI_TOUCHED=0
WIFI_CON_NAME=""
WIFI_CON_UUID=""
ORIG_BSSID_PIN=""
ORIG_CLONED_MAC=""
ORIG_POWERSAVE=""
CURRENT_BSSID_BEFORE=""
CURRENT_BSSID_AFTER=""
HIST_BSSID=""
SSID=""
BASELINE_MAC=""
CURRENT_MAC_BEFORE=""
WIFI_ACTION="NO_SAFE_CHANGE"
WIFI_RESULT="UNCHANGED"

json_status(){
  python3 - "$STATUS_JSON" \
    "$CORE_VERSION" "$WIFI_ACTION" "$WIFI_RESULT" \
    "$CURRENT_BSSID_BEFORE" "$HIST_BSSID" "$CURRENT_BSSID_AFTER" \
    "$CURRENT_MAC_BEFORE" "$BASELINE_MAC" <<'PY'
import json,sys,datetime,pathlib
p=pathlib.Path(sys.argv[1])
data={
  "coreVersion":sys.argv[2],
  "action":sys.argv[3],
  "result":sys.argv[4],
  "currentBssidBefore":sys.argv[5] or None,
  "historicalBssid":sys.argv[6] or None,
  "currentBssidAfter":sys.argv[7] or None,
  "currentMacBefore":sys.argv[8] or None,
  "baselineMac":sys.argv[9] or None,
  "timestampUtc":datetime.datetime.now(datetime.timezone.utc).isoformat()
}
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps(data,indent=2)+"\n",encoding="utf-8")
PY

  # Expose status through ANDON static content.
  # IMPORTANT:
  # - /opt/andon/app/public updates the currently installed ANDON.
  # - SCRIPT_DIR/../public updates the staged ANDON payload when this script
  #   is running from an ANDON release, so the file survives the final swap.
  pubs=(/opt/andon/app/public)
  stage_public="$SCRIPT_DIR/../public"
  if [[ -d "$stage_public" ]]; then
    pubs+=("$stage_public")
  fi

  for pub in "${pubs[@]}"; do
    if [[ -d "$pub" ]]; then
      cp -f "$STATUS_JSON" "$pub/network-recovery-status.json"
      chmod 0644 "$pub/network-recovery-status.json" || true
    fi
  done
}

restore_wifi_profile(){
  [[ "${WIFI_TOUCHED:-0}" == "1" ]] || return 0
  [[ -n "${WIFI_CON_UUID:-}" ]] || return 0
  command -v nmcli >/dev/null 2>&1 || return 0

  warn "Wi-Fi rollback: restaurando perfil NetworkManager original."

  nmcli connection modify uuid "$WIFI_CON_UUID" \
    802-11-wireless.bssid "$ORIG_BSSID_PIN" >/dev/null 2>&1 || true

  nmcli connection modify uuid "$WIFI_CON_UUID" \
    802-11-wireless.cloned-mac-address "$ORIG_CLONED_MAC" >/dev/null 2>&1 || true

  if [[ -n "$ORIG_POWERSAVE" ]]; then
    nmcli connection modify uuid "$WIFI_CON_UUID" \
      802-11-wireless.powersave "$ORIG_POWERSAVE" >/dev/null 2>&1 || true
  fi

  nmcli connection down uuid "$WIFI_CON_UUID" >/dev/null 2>&1 || true
  timeout 75s nmcli connection up uuid "$WIFI_CON_UUID" ifname "$TARGET_IF" >/dev/null 2>&1 || true

  # Give DHCP / routes time to settle.
  for _ in $(seq 1 30); do
    ip -4 addr show dev "$TARGET_IF" | grep -q "$SERVICE_IP/" && break
    sleep 1
  done

  # Restore known-good return routes after reconnect.
  ip -4 route replace 10.138.41.0/24 via "$GATEWAY" dev "$TARGET_IF" src "$SERVICE_IP" metric 20 >/dev/null 2>&1 || true
  ip -4 route replace 10.138.42.0/24 via "$GATEWAY" dev "$TARGET_IF" src "$SERVICE_IP" metric 20 >/dev/null 2>&1 || true

  WIFI_ACTION="ROLLBACK_PROFILE"
  WIFI_RESULT="ROLLED_BACK"
  CURRENT_BSSID_AFTER="$(iw dev "$TARGET_IF" link 2>/dev/null | awk '/Connected to/{print tolower($3);exit}')"
  json_status || true
}

if command -v nmcli >/dev/null 2>&1 && command -v iw >/dev/null 2>&1; then
  WIFI_CON_NAME="$(nmcli -g GENERAL.CONNECTION device show "$TARGET_IF" 2>/dev/null | head -n1 || true)"
  if [[ -n "$WIFI_CON_NAME" && "$WIFI_CON_NAME" != "--" ]]; then
    WIFI_CON_UUID="$(nmcli -g connection.uuid connection show "$WIFI_CON_NAME" 2>/dev/null | head -n1 || true)"
  fi

  SSID="$(iw dev "$TARGET_IF" link 2>/dev/null | sed -n 's/^[[:space:]]*SSID:[[:space:]]*//p' | head -n1)"
  CURRENT_BSSID_BEFORE="$(iw dev "$TARGET_IF" link 2>/dev/null | awk '/Connected to/{print tolower($3);exit}')"
  CURRENT_MAC_BEFORE="$(cat "/sys/class/net/$TARGET_IF/address" 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"

  # Extract the MAC wlan0 used in the known-good September baseline snapshot.
  BASE_ARCHIVE="/home/andon/ANDON-CORE-NETWORK-BASELINE-R1-andon-20260914-152255.tar.gz"
  if [[ -f "$BASE_ARCHIVE" ]]; then
    BTMP="$(mktemp -d)"
    if tar -xzf "$BASE_ARCHIVE" -C "$BTMP" >/dev/null 2>&1; then
      BADDR="$(find "$BTMP" -type f -path '*/baseline/network/ip-addr.txt' | head -n1 || true)"
      if [[ -n "$BADDR" ]]; then
        BASELINE_MAC="$(
          awk '
            /^[0-9]+: wlan0:/ {inside=1; next}
            /^[0-9]+: / {inside=0}
            inside && /link\/ether/ {print tolower($2); exit}
          ' "$BADDR"
        )"
      fi
    fi
    rm -rf "$BTMP"
  fi

  # Use the timestamp of the detected pre-change backup as journal cutoff.
  # We only accept an AP/BSSID that was actually used before that backup.
  CBASE="$(basename "$CANDIDATE")"
  CUTOFF=""
  if [[ "$CBASE" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})$ ]]; then
    CUTOFF="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}"
  fi

  if [[ -n "$CUTOFF" ]]; then
    HIST_BSSID="$(
      journalctl --no-pager --until "$CUTOFF" 2>/dev/null |
      grep -Ei 'CTRL-EVENT-CONNECTED|Connection to ([0-9a-f]{2}:){5}[0-9a-f]{2}|associated with ([0-9a-f]{2}:){5}[0-9a-f]{2}|BSSID[ =:]' |
      grep -Eio '([0-9a-f]{2}:){5}[0-9a-f]{2}' |
      tr '[:upper:]' '[:lower:]' |
      tail -n1 || true
    )"
  fi

  # If the pre-change cutoff journal does not contain a BSSID, use the
  # last BSSID from the known-good September baseline window.
  if [[ -z "$HIST_BSSID" ]]; then
    HIST_BSSID="$(
      journalctl --no-pager \
        --since "2026-09-13 00:00:00" \
        --until "2026-09-17 23:59:59" 2>/dev/null |
      grep -Ei 'CTRL-EVENT-CONNECTED|Connection to ([0-9a-f]{2}:){5}[0-9a-f]{2}|associated with ([0-9a-f]{2}:){5}[0-9a-f]{2}|BSSID[ =:]' |
      grep -Eio '([0-9a-f]{2}:){5}[0-9a-f]{2}' |
      tr '[:upper:]' '[:lower:]' |
      tail -n1 || true
    )"
  fi

  if [[ -n "$WIFI_CON_UUID" ]]; then
    ORIG_BSSID_PIN="$(nmcli -g 802-11-wireless.bssid connection show uuid "$WIFI_CON_UUID" 2>/dev/null | head -n1 || true)"
    ORIG_CLONED_MAC="$(nmcli -g 802-11-wireless.cloned-mac-address connection show uuid "$WIFI_CON_UUID" 2>/dev/null | head -n1 || true)"
    ORIG_POWERSAVE="$(nmcli -g 802-11-wireless.powersave connection show uuid "$WIFI_CON_UUID" 2>/dev/null | head -n1 || true)"
  fi

  HIST_VISIBLE=0
  if [[ -n "$HIST_BSSID" && -n "$SSID" ]]; then
    if iw dev "$TARGET_IF" scan 2>/dev/null |
      awk -v want="$SSID" -v wantb="$HIST_BSSID" '
        /^BSS / {
          b=tolower($2); sub(/\(.*/,"",b)
        }
        /^[[:space:]]*SSID:/ {
          s=$0
          sub(/^[[:space:]]*SSID:[[:space:]]*/,"",s)
          if (s==want && b==wantb) found=1
        }
        END {exit(found?0:1)}
      '
    then
      HIST_VISIBLE=1
    fi
  fi

  NEED_BSSID=0
  NEED_MAC=0

  if [[ -n "$HIST_BSSID" && "$HIST_VISIBLE" == "1" && "$HIST_BSSID" != "$CURRENT_BSSID_BEFORE" ]]; then
    NEED_BSSID=1
  fi

  # Only restore baseline MAC when it is a valid unicast MAC and differs.
  if [[ "$BASELINE_MAC" =~ ^([0-9a-f]{2}:){5}[0-9a-f]{2}$ &&
        -n "$CURRENT_MAC_BEFORE" &&
        "$BASELINE_MAC" != "$CURRENT_MAC_BEFORE" ]]; then
    first_octet=$((16#${BASELINE_MAC%%:*}))
    if (( (first_octet & 1) == 0 )); then
      NEED_MAC=1
    fi
  fi

  if [[ "$NEED_BSSID" == "1" || "$NEED_MAC" == "1" ]]; then
    [[ -n "$WIFI_CON_UUID" ]] || die "Wi-Fi recovery requiere UUID de conexion NetworkManager."

    WIFI_TOUCHED=1
    WIFI_ACTION="RESTORE_PRECHANGE_WIFI_PROFILE"

    if [[ "$NEED_BSSID" == "1" ]]; then
      say "Wi-Fi L2: restaurando BSSID historico $HIST_BSSID"
      nmcli connection modify uuid "$WIFI_CON_UUID" 802-11-wireless.bssid "$HIST_BSSID"
    fi

    if [[ "$NEED_MAC" == "1" ]]; then
      say "Wi-Fi L2: restaurando MAC de baseline $BASELINE_MAC"
      nmcli connection modify uuid "$WIFI_CON_UUID" 802-11-wireless.cloned-mac-address "$BASELINE_MAC"
    fi

    # Prevent client power-save from introducing avoidable unicast loss.
    nmcli connection modify uuid "$WIFI_CON_UUID" 802-11-wireless.powersave 2

    nmcli connection down uuid "$WIFI_CON_UUID" >/dev/null 2>&1 || true
    timeout 75s nmcli connection up uuid "$WIFI_CON_UUID" ifname "$TARGET_IF"

    for _ in $(seq 1 45); do
      if ip -4 addr show dev "$TARGET_IF" | grep -q "$SERVICE_IP/" &&
         ip -4 route show default dev "$TARGET_IF" | grep -q "via $GATEWAY"; then
        break
      fi
      sleep 1
    done

    ip -4 addr show dev "$TARGET_IF" | grep -q "$SERVICE_IP/"
    ip -4 route show default dev "$TARGET_IF" | grep -q "via $GATEWAY"
    ping -c 1 -W 3 "$GATEWAY" >/dev/null

    CURRENT_BSSID_AFTER="$(iw dev "$TARGET_IF" link 2>/dev/null | awk '/Connected to/{print tolower($3);exit}')"

    if [[ "$NEED_BSSID" == "1" ]]; then
      [[ "$CURRENT_BSSID_AFTER" == "$HIST_BSSID" ]] || die "La RPi no quedo asociada al BSSID historico."
    fi

    # Reapply exact known-good return routes after Wi-Fi reconnect.
    ip -4 route replace 10.138.41.0/24 via "$GATEWAY" dev "$TARGET_IF" src "$SERVICE_IP" metric 20
    ip -4 route replace 10.138.42.0/24 via "$GATEWAY" dev "$TARGET_IF" src "$SERVICE_IP" metric 20

    if systemctl list-unit-files 2>/dev/null | grep -q '^andon-network-fix\.service'; then
      systemctl restart andon-network-fix.service >/dev/null 2>&1 || true
    fi

    curl -fsS --max-time 5 -H 'Host: andon.local' http://127.0.0.1/api/build >/dev/null
    curl -fsS --max-time 5 -H 'Host: dci.local' http://127.0.0.1/datacenter/ >/dev/null

    WIFI_RESULT="APPLIED"
    WIFI_TOUCHED=0
    json_status
    ok "Wi-Fi L2 recovery aplicado y validado localmente."
  else
    CURRENT_BSSID_AFTER="$CURRENT_BSSID_BEFORE"

    if [[ -n "$HIST_BSSID" && "$HIST_BSSID" == "$CURRENT_BSSID_BEFORE" ]]; then
      WIFI_ACTION="HISTORICAL_BSSID_ALREADY_ACTIVE"
      WIFI_RESULT="ALREADY_ON_PRECHANGE_BSSID"
      ok "Wi-Fi ya esta asociado al BSSID historico pre-cambio."
    elif [[ -n "$HIST_BSSID" && "$HIST_VISIBLE" != "1" ]]; then
      WIFI_ACTION="HISTORICAL_BSSID_NOT_VISIBLE"
      WIFI_RESULT="NO_CHANGE"
      warn "BSSID historico detectado pero no visible actualmente; no se fuerza otro AP."
    else
      WIFI_ACTION="NO_VERIFIABLE_HISTORICAL_BSSID"
      WIFI_RESULT="NO_CHANGE"
      warn "No hay BSSID historico verificable; no se inventa una asociacion."
    fi

    json_status
  fi
else
  WIFI_ACTION="NMCLI_OR_IW_UNAVAILABLE"
  WIFI_RESULT="NO_CHANGE"
  json_status
  warn "nmcli/iw no disponible; se conserva red actual."
fi


printf '%s\n' "$CORE_VERSION" > "$MARKER"
ip -4 route show table main > "$SAFETY/routes-after.txt" || true

trap - ERR

cat <<EOF

======================================================================
 ANDON/DCI WI-FI L2 RECOVERY $CORE_VERSION OK
======================================================================
Se restauro la capa de red PRE-CAMBIO y se evaluo/restauro la asociacion Wi-Fi historica de forma segura.

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
- Wi-Fi L2 recovery evaluado

Si cualquiera de estas validaciones hubiera fallado, el script habria
restaurado automaticamente el estado previo a esta actualizacion.
======================================================================
EOF