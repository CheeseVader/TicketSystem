#!/usr/bin/env bash
set -Eeuo pipefail

CORE_VERSION="2.1.0"
DEFAULT_SERVICE_IP="10.138.43.217"
SERVICE_IP="${ANDON_DCI_SERVICE_IP:-$DEFAULT_SERVICE_IP}"
BACKUP_ROOT="/var/backups/andon-dci-network-core"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$STAMP"
LAST_LINK="$BACKUP_ROOT/LAST"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTER="/usr/local/sbin/andon-dci-vlan-routing.sh"
ROUTE_ENV="/etc/andon-dci-network.env"

say(){ printf '\n==> %s\n' "$*"; }
ok(){ printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
die(){ printf '[ERROR] %s\n' "$*" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Este postinstall requiere root en Raspberry Pi."

say "ANDON/DCI Network Core $CORE_VERSION"

TARGET_IF="$({
  ip -4 -o addr show scope global 2>/dev/null |
    awk -v ip="$SERVICE_IP" '$4 ~ ("^" ip "/") {print $2; exit}'
} || true)"

if [[ -z "${TARGET_IF:-}" ]]; then
  DEFAULT_LINE="$(ip -4 route show default 2>/dev/null | head -n1 || true)"
  TARGET_IF="$(awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}' <<<"$DEFAULT_LINE")"
  DETECTED_SRC="$(awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' <<<"$DEFAULT_LINE")"
  if [[ -z "${DETECTED_SRC:-}" && -n "${TARGET_IF:-}" ]]; then
    DETECTED_SRC="$(ip -4 -o addr show dev "$TARGET_IF" scope global 2>/dev/null | awk 'NR==1{split($4,a,"/");print a[1]}')"
  fi
  [[ -n "${TARGET_IF:-}" && -n "${DETECTED_SRC:-}" ]] || die "No pude detectar interfaz/IPv4 de servicio."
  warn "$SERVICE_IP no esta asignada; usando $DETECTED_SRC en $TARGET_IF."
  SERVICE_IP="$DETECTED_SRC"
fi

mapfile -t LOCAL_CIDRS < <(
  ip -4 -o addr show dev "$TARGET_IF" scope global 2>/dev/null | awk '{print $4}'
)
[[ ${#LOCAL_CIDRS[@]} -gt 0 ]] || die "No hay IPv4 global en $TARGET_IF."

GATEWAY="$(ip -4 route show default dev "$TARGET_IF" 2>/dev/null | awk 'NR==1{print $3}')"
[[ -n "${GATEWAY:-}" ]] || die "No pude detectar gateway en $TARGET_IF."

SERVICE_OCT3="$(awk -F. '{print $3}' <<<"$SERVICE_IP")"
[[ "$SERVICE_OCT3" =~ ^[0-9]+$ ]] || die "IPv4 de servicio invalida: $SERVICE_IP"
LOCAL_L2_NET="10.138.${SERVICE_OCT3}.0/24"

printf 'Service IP : %s\n' "$SERVICE_IP"
printf 'Interface  : %s\n' "$TARGET_IF"
printf 'CIDR OS    : %s\n' "${LOCAL_CIDRS[*]}"
printf 'L2 policy  : %s direct\n' "$LOCAL_L2_NET"
printf 'Gateway    : %s\n' "$GATEWAY"

MISSING=()
command -v nginx >/dev/null 2>&1 || MISSING+=(nginx)
command -v avahi-daemon >/dev/null 2>&1 || MISSING+=(avahi-daemon)
command -v avahi-resolve-host-name >/dev/null 2>&1 || MISSING+=(avahi-utils)
command -v python3 >/dev/null 2>&1 || MISSING+=(python3)
if [[ ${#MISSING[@]} -gt 0 ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y "${MISSING[@]}" libnss-mdns iproute2
fi

mkdir -p "$BACKUP/rootfs" "$BACKUP_ROOT"
: > "$BACKUP/paths.list"
: > "$BACKUP/services.list"

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
  /etc/systemd/system/dci-mdns.service
  /etc/NetworkManager/dispatcher.d/90-andon-network-fix
  /etc/sysctl.d/90-andon-dci-network.conf
  /usr/local/sbin/andon-dci-vlan-routing.sh
  /etc/andon-dci-network.env
  /etc/systemd/system/andon-dci-vlan-routing.service
  /etc/NetworkManager/dispatcher.d/91-andon-dci-vlan-routing
)

backup_one(){
  local p="$1"
  if [[ -e "$p" || -L "$p" ]]; then
    printf 'EXISTS|%s\n' "$p" >> "$BACKUP/paths.list"
    mkdir -p "$BACKUP/rootfs$(dirname "$p")"
    cp -a "$p" "$BACKUP/rootfs$p"
  else
    printf 'ABSENT|%s\n' "$p" >> "$BACKUP/paths.list"
  fi
}
for p in "${MANAGED_PATHS[@]}"; do backup_one "$p"; done

for unit in \
  andon-network-fix.service \
  andon-client-register.service \
  dci-mdns.service \
  andon-dci-vlan-routing.service \
  avahi-daemon.service \
  nginx.service
do
  printf '%s|%s|%s\n' \
    "$unit" \
    "$(systemctl is-enabled "$unit" 2>/dev/null || true)" \
    "$(systemctl is-active "$unit" 2>/dev/null || true)" \
    >> "$BACKUP/services.list"
done

printf '%s\n' "$SERVICE_IP" > "$BACKUP/service-ip.txt"
printf '%s\n' "$TARGET_IF" > "$BACKUP/interface.txt"
printf '%s\n' "${LOCAL_CIDRS[*]}" > "$BACKUP/cidrs.txt"
ip -4 route show table main > "$BACKUP/routes-before.txt" || true
ln -sfn "$BACKUP" "$LAST_LINK"
ok "Backup de red: $BACKUP"

restore_files(){
  [[ -f "$BACKUP/paths.list" ]] || return 0
  while IFS='|' read -r state p; do
    [[ -n "${p:-}" ]] || continue
    rm -rf "$p"
    if [[ "$state" == "EXISTS" ]]; then
      src="$BACKUP/rootfs$p"
      if [[ -e "$src" || -L "$src" ]]; then
        mkdir -p "$(dirname "$p")"
        cp -a "$src" "$p"
      fi
    fi
  done < "$BACKUP/paths.list"
  systemctl daemon-reload || true
  nginx -t >/dev/null 2>&1 && systemctl restart nginx >/dev/null 2>&1 || true
  systemctl restart avahi-daemon >/dev/null 2>&1 || true
}
rollback_on_error(){
  rc=$?
  warn "Network Core fallo RC=$rc; restaurando."
  restore_files
  exit "$rc"
}
trap rollback_on_error ERR

# Retire the legacy per-client services. v2.1 replaces them with deterministic
# /24 L2-segment routing for the observed corporate 40-43 network.
systemctl disable --now andon-client-register.service >/dev/null 2>&1 || true
systemctl disable --now andon-network-fix.service >/dev/null 2>&1 || true
systemctl disable --now dci-mdns.service >/dev/null 2>&1 || true
rm -f \
  /usr/local/sbin/andon-network-fix.sh \
  /usr/local/sbin/andon-client-register.py \
  /etc/systemd/system/andon-network-fix.service \
  /etc/systemd/system/andon-client-register.service \
  /etc/systemd/system/dci-mdns.service \
  /etc/NetworkManager/dispatcher.d/90-andon-network-fix

# ----------------------------------------------------------------------
# R2.1 FIX:
# The hosts receive /22 masks, but observed L2 reachability is segmented by
# third octet. 10.138.41.x cannot ARP 10.138.43.x directly.
# Therefore:
#   own 10.138.<octet>.0/24 -> link/direct
#   other 10.138.40/41/42/43 /24 -> gateway
# A /32 link route keeps the gateway itself reachable even when its /24 is
# routed through the gateway.
# ----------------------------------------------------------------------
cat > "$ROUTER" <<'EOF_ROUTER'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f /etc/andon-dci-network.env ]] && source /etc/andon-dci-network.env

SERVICE_IP="${SERVICE_IP:-10.138.43.217}"

IFACE="$(
  ip -4 -o addr show scope global |
  awk -v ip="$SERVICE_IP" '$4 ~ ("^" ip "/") {print $2; exit}'
)"
[[ -n "${IFACE:-}" ]] || {
  line="$(ip -4 route show default | head -n1)"
  IFACE="$(awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}' <<<"$line")"
  SERVICE_IP="$(ip -4 -o addr show dev "$IFACE" scope global | awk 'NR==1{split($4,a,"/");print a[1]}')"
}

GW="$(ip -4 route show default dev "$IFACE" | awk 'NR==1{print $3}')"
[[ -n "${IFACE:-}" && -n "${SERVICE_IP:-}" && -n "${GW:-}" ]] || exit 20

OCT3="$(awk -F. '{print $3}' <<<"$SERVICE_IP")"
LOCAL_NET="10.138.${OCT3}.0/24"

# Gateway must always remain directly ARP-reachable.
ip -4 route replace "$GW/32" dev "$IFACE" src "$SERVICE_IP" scope link metric 1

for n in 40 41 42 43; do
  NET="10.138.${n}.0/24"
  if [[ "$NET" == "$LOCAL_NET" ]]; then
    ip -4 route replace "$NET" dev "$IFACE" src "$SERVICE_IP" scope link metric 5
  else
    ip -4 route replace "$NET" via "$GW" dev "$IFACE" src "$SERVICE_IP" metric 10
  fi
done

logger -t andon-dci-routing \
  "service=$SERVICE_IP iface=$IFACE gw=$GW local=$LOCAL_NET policy=VLAN24"
EOF_ROUTER
chmod 0755 "$ROUTER"

cat > "$ROUTE_ENV" <<EOF_ENV
SERVICE_IP=$SERVICE_IP
EOF_ENV
chmod 0644 "$ROUTE_ENV"

cat > /etc/systemd/system/andon-dci-vlan-routing.service <<'EOF_SERVICE'
[Unit]
Description=ANDON/DCI corporate VLAN /24 routing policy
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/andon-dci-vlan-routing.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF_SERVICE

mkdir -p /etc/NetworkManager/dispatcher.d
cat > /etc/NetworkManager/dispatcher.d/91-andon-dci-vlan-routing <<'EOF_NM'
#!/usr/bin/env bash
case "${2:-}" in
  up|dhcp4-change|connectivity-change)
    systemctl restart andon-dci-vlan-routing.service >/dev/null 2>&1 || true
    ;;
esac
EOF_NM
chmod 0755 /etc/NetworkManager/dispatcher.d/91-andon-dci-vlan-routing

systemctl daemon-reload
systemctl enable andon-dci-vlan-routing.service >/dev/null
systemctl restart andon-dci-vlan-routing.service

# Loose reverse-path filtering for routed VLAN return traffic.
cat > /etc/sysctl.d/90-andon-dci-network.conf <<EOF_SYSCTL
net.ipv4.conf.$TARGET_IF.rp_filter=2
EOF_SYSCTL
sysctl -p /etc/sysctl.d/90-andon-dci-network.conf >/dev/null

# Bonjour/mDNS: valid on the local L2 only. Cross-VLAN name resolution still
# needs infrastructure mDNS reflection or a unicast DNS/hosts fallback.
mkdir -p /etc/avahi/services
cat > /etc/avahi/avahi-daemon.conf <<EOF_AVAHI
[server]
host-name=andon
use-ipv4=yes
use-ipv6=no
allow-interfaces=$TARGET_IF

[wide-area]
enable-wide-area=no

[publish]
disable-publishing=no
publish-addresses=yes
publish-hinfo=no
publish-workstation=no
publish-domain=no
publish-dns-servers=no
publish-resolv-conf-dns-servers=no

[reflector]
enable-reflector=no
EOF_AVAHI

touch /etc/avahi/hosts
python3 - "$SERVICE_IP" <<'PY'
from pathlib import Path
import re, sys
ip=sys.argv[1]
p=Path('/etc/avahi/hosts')
lines=p.read_text(encoding='utf-8',errors='ignore').splitlines() if p.exists() else []
out=[x for x in lines if not re.search(r'(^|\s)(andon|dci)\.local(\s|$)',x,re.I)]
out += [f'{ip} andon.local',f'{ip} dci.local']
p.write_text('\n'.join(out).rstrip()+'\n',encoding='utf-8')
PY

cat > /etc/avahi/services/andon.service <<'EOF_ANDON'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>ANDON</name>
  <service protocol="ipv4">
    <type>_http._tcp</type>
    <host-name>andon.local</host-name>
    <port>80</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
EOF_ANDON

cat > /etc/avahi/services/dci.service <<'EOF_DCI'
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>Data Center Inspection</name>
  <service protocol="ipv4">
    <type>_http._tcp</type>
    <host-name>dci.local</host-name>
    <port>80</port>
    <txt-record>path=/datacenter/</txt-record>
  </service>
</service-group>
EOF_DCI

systemctl enable avahi-daemon >/dev/null
systemctl restart avahi-daemon
systemctl is-active --quiet avahi-daemon || die "avahi-daemon no quedo activo"

# Shared Nginx remains canonical.
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
cat > /etc/nginx/sites-available/andon <<'EOF_NA'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name andon.local _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300;
        proxy_send_timeout 300;
    }
}
EOF_NA

cat > /etc/nginx/sites-available/dci <<'EOF_ND'
server {
    listen 80;
    listen [::]:80;
    server_name dci.local;
    client_max_body_size 0;

    location = / { return 302 /datacenter/; }

    location /datacenter/ {
        proxy_pass http://127.0.0.1:3100/datacenter/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300;
        proxy_send_timeout 300;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3100/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF_ND

rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/dci-local
ln -sfn /etc/nginx/sites-available/andon /etc/nginx/sites-enabled/andon
ln -sfn /etc/nginx/sites-available/dci /etc/nginx/sites-enabled/dci
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx
systemctl is-active --quiet nginx || die "nginx no quedo activo"

if [[ -f "$SCRIPT_DIR/diagnostico-red-andondci.sh" ]]; then
  install -m 0755 "$SCRIPT_DIR/diagnostico-red-andondci.sh" /usr/local/sbin/DIAGNOSTICO-ANDON-DCI-RED
fi
if [[ -f "$SCRIPT_DIR/rollback-red-andondci.sh" ]]; then
  install -m 0755 "$SCRIPT_DIR/rollback-red-andondci.sh" /usr/local/sbin/ROLLBACK-ANDON-DCI-RED
fi

ip -4 route show table main > "$BACKUP/routes-after.txt" || true
printf '%s\n' "$CORE_VERSION" > /var/lib/andon-dci-network-core.version

trap - ERR
cat <<EOF_DONE

======================================================================
 ANDON/DCI NETWORK CORE $CORE_VERSION OK
======================================================================
Service IP : $SERVICE_IP
Interface  : $TARGET_IF
OS CIDR    : ${LOCAL_CIDRS[*]}
L2 direct  : $LOCAL_L2_NET
Gateway    : $GATEWAY

Routing policy:
- same third-octet /24 -> DIRECT L2
- other 10.138.40-43 /24 -> VIA GATEWAY
- gateway itself -> DIRECT /32

ANDON : http://andon.local/
DCI   : http://dci.local/datacenter/

NOTE: .local/mDNS remains L2-local. Cross-VLAN clients need mDNS reflection
or a unicast DNS/hosts fallback.
======================================================================
EOF_DONE
