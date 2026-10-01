#!/usr/bin/env bash
set -Eeuo pipefail

CORE_VERSION="2.2.0"
SERVICE_IP="${ANDON_DCI_SERVICE_IP:-10.138.43.217}"
STATE_DIR="/var/lib/andon-network-fix"
CLIENTS_FILE="$STATE_DIR/clients.txt"
FIX="/usr/local/sbin/andon-network-fix.sh"
REGISTER="/usr/local/sbin/andon-client-register.py"
BACKUP_ROOT="/var/backups/andon-dci-network-core"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$STAMP"
LAST_LINK="$BACKUP_ROOT/LAST"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say(){ printf '\n==> %s\n' "$*"; }
ok(){ printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
die(){ printf '[ERROR] %s\n' "$*" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Este postinstall requiere root."

say "ANDON/DCI Network Core $CORE_VERSION - Warehouse routing model"

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

SERVICE_OCT3="$(awk -F. '{print $3}' <<<"$SERVICE_IP")"
[[ "$SERVICE_OCT3" =~ ^[0-9]+$ ]] || die "IP invalida."

printf 'Service IP : %s\n' "$SERVICE_IP"
printf 'Interface  : %s\n' "$TARGET_IF"
printf 'Gateway    : %s\n' "$GATEWAY"
printf 'L2 local   : 10.138.%s.0/24\n' "$SERVICE_OCT3"

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
    >> "$BACKUP/services.list"
done

ip -4 route show table main > "$BACKUP/routes-before.txt" || true
ln -sfn "$BACKUP" "$LAST_LINK"
ok "Backup: $BACKUP"

restore_files(){
  while IFS='|' read -r state p; do
    [[ -n "${p:-}" ]] || continue
    rm -rf "$p"
    if [[ "$state" == "EXISTS" ]]; then
      src="$BACKUP/rootfs$p"
      [[ -e "$src" || -L "$src" ]] && {
        mkdir -p "$(dirname "$p")"
        cp -a "$src" "$p"
      }
    fi
  done < "$BACKUP/paths.list"
  systemctl daemon-reload || true
  nginx -t >/dev/null 2>&1 && systemctl restart nginx >/dev/null 2>&1 || true
  systemctl restart avahi-daemon >/dev/null 2>&1 || true
}
rollback_on_error(){
  rc=$?
  warn "Network Core fallo RC=$rc; restaurando backup."
  restore_files
  exit "$rc"
}
trap rollback_on_error ERR

# ---------------------------------------------------------------------
# Remove R2.3 broad /24 policy. It was not the exact Warehouse mechanism.
# ---------------------------------------------------------------------
say "Retirando policy /24 R2.3"
systemctl disable --now andon-dci-vlan-routing.service >/dev/null 2>&1 || true
rm -f \
  /usr/local/sbin/andon-dci-vlan-routing.sh \
  /etc/andon-dci-network.env \
  /etc/systemd/system/andon-dci-vlan-routing.service \
  /etc/NetworkManager/dispatcher.d/91-andon-dci-vlan-routing

# Remove only exact /24 routes introduced by R2.3; the kernel's connected /22
# route remains untouched.
for n in 40 41 42 43; do
  NET="10.138.${n}.0/24"
  while ip -4 route show "$NET" 2>/dev/null | grep -q .; do
    ip -4 route del "$NET" 2>/dev/null || break
  done
done
# R2.3 also created a host route to the gateway.
while ip -4 route show "$GATEWAY/32" 2>/dev/null | grep -q .; do
  ip -4 route del "$GATEWAY/32" 2>/dev/null || break
done
systemctl daemon-reload

# ---------------------------------------------------------------------
# Restore the proven Warehouse/ANDON model:
# Windows: server /32 via its active gateway.
# RPi: client /32 return route via RPi gateway.
# Same third-octet /24 is the exception: direct, no artificial gateway route.
# ---------------------------------------------------------------------
say "Instalando rutas de retorno por cliente"
mkdir -p "$STATE_DIR"
touch "$CLIENTS_FILE"
chmod 0644 "$CLIENTS_FILE"

cat > "$FIX" <<'EOF_FIX'
#!/usr/bin/env bash
set -Eeuo pipefail

CLIENTS_FILE="/var/lib/andon-network-fix/clients.txt"
SERVICE_IP="${ANDON_DCI_SERVICE_IP:-10.138.43.217}"

IFACE="$(
  ip -4 -o addr show scope global |
  awk -v ip="$SERVICE_IP" '$4 ~ ("^" ip "/") {print $2; exit}'
)"
if [[ -z "${IFACE:-}" ]]; then
  line="$(ip -4 route show default | head -n1)"
  IFACE="$(awk '{for(i=1;i<=NF;i++)if($i=="dev"){print $(i+1);exit}}' <<<"$line")"
  SERVICE_IP="$(ip -4 -o addr show dev "$IFACE" scope global | awk 'NR==1{split($4,a,"/");print a[1]}')"
fi
GW="$(ip -4 route show default dev "$IFACE" | awk 'NR==1{print $3}')"
[[ -n "${IFACE:-}" && -n "${SERVICE_IP:-}" && -n "${GW:-}" ]] || exit 20

MY_OCT3="$(awk -F. '{print $3}' <<<"$SERVICE_IP")"

while IFS= read -r CLIENT_IP; do
  [[ "$CLIENT_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
  CLIENT_OCT3="$(awk -F. '{print $3}' <<<"$CLIENT_IP")"

  # Remove any old host route first.
  while ip -4 route show "$CLIENT_IP/32" 2>/dev/null | grep -q .; do
    ip -4 route del "$CLIENT_IP/32" 2>/dev/null || break
  done

  if [[ "$CLIENT_OCT3" == "$MY_OCT3" ]]; then
    logger -t andon-network-fix "DIRECT client=$CLIENT_IP iface=$IFACE"
  else
    ip -4 route replace "$CLIENT_IP/32" via "$GW" dev "$IFACE" src "$SERVICE_IP" metric 5
    logger -t andon-network-fix "ROUTED client=$CLIENT_IP via=$GW iface=$IFACE"
  fi
done < "$CLIENTS_FILE"
EOF_FIX
chmod 0755 "$FIX"

cat > /etc/systemd/system/andon-network-fix.service <<'EOF_SERVICE'
[Unit]
Description=ANDON/DCI Automatic Client Return Routes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/andon-network-fix.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF_SERVICE

mkdir -p /etc/NetworkManager/dispatcher.d
cat > /etc/NetworkManager/dispatcher.d/90-andon-network-fix <<'EOF_DISPATCH'
#!/usr/bin/env bash
case "${2:-}" in
  up|dhcp4-change|connectivity-change)
    systemctl restart andon-network-fix.service >/dev/null 2>&1 || true
    ;;
esac
EOF_DISPATCH
chmod 0755 /etc/NetworkManager/dispatcher.d/90-andon-network-fix

say "Instalando registro UDP automatico de clientes"
cat > "$REGISTER" <<'PY'
#!/usr/bin/env python3
import socket, subprocess, pathlib, ipaddress

PORT=8788
CLIENTS=pathlib.Path("/var/lib/andon-network-fix/clients.txt")
FIX="/usr/local/sbin/andon-network-fix.sh"
CLIENTS.parent.mkdir(parents=True,exist_ok=True)
CLIENTS.touch(exist_ok=True)

def register(addr):
    ip=str(ipaddress.ip_address(addr))
    old=[]
    for x in CLIENTS.read_text(encoding="utf-8",errors="ignore").splitlines():
        x=x.strip()
        if not x:
            continue
        try:
            old.append(str(ipaddress.ip_address(x)))
        except Exception:
            pass
    if ip not in old:
        old.append(ip)
        CLIENTS.write_text("\n".join(old)+"\n",encoding="utf-8")
    subprocess.run([FIX],check=False)
    return ip

s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
s.bind(("0.0.0.0",PORT))
print(f"ANDON/DCI UDP client register listening on {PORT}",flush=True)

while True:
    data,addr=s.recvfrom(1024)
    msg=data.decode("utf-8","ignore").strip()
    if msg.startswith("ANDON_REGISTER_V1") or msg.startswith("ANDON_DCI_REGISTER_V2"):
        try:
            ip=register(addr[0])
            s.sendto(("ANDON_DCI_OK "+ip).encode(),addr)
        except Exception as e:
            try:
                s.sendto(("ANDON_DCI_ERROR "+str(e)).encode(),addr)
            except Exception:
                pass
PY
chmod 0755 "$REGISTER"

cat > /etc/systemd/system/andon-client-register.service <<'EOF_REGISTER'
[Unit]
Description=ANDON/DCI UDP Automatic Client Registration
After=network-online.target andon-network-fix.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/sbin/andon-client-register.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF_REGISTER

systemctl daemon-reload
systemctl enable andon-network-fix.service >/dev/null
systemctl enable andon-client-register.service >/dev/null
systemctl restart andon-network-fix.service
systemctl restart andon-client-register.service
systemctl is-active --quiet andon-client-register.service || die "Registro UDP no quedo activo."

# Loose reverse path filtering for asymmetric routed VLANs.
cat > /etc/sysctl.d/90-andon-dci-network.conf <<EOF_SYSCTL
net.ipv4.conf.$TARGET_IF.rp_filter=2
EOF_SYSCTL
sysctl -p /etc/sysctl.d/90-andon-dci-network.conf >/dev/null

# Firewall only if UFW is active.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow in on "$TARGET_IF" to any port 80 proto tcp >/dev/null || true
  ufw allow in on "$TARGET_IF" to any port 8788 proto udp >/dev/null || true
  ufw allow in on "$TARGET_IF" to any port 5353 proto udp >/dev/null || true
fi

# ---------------------------------------------------------------------
# Bonjour + canonical Nginx, kept idempotent.
# ---------------------------------------------------------------------
say "Asegurando Bonjour/mDNS y Nginx"
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
import re,sys
ip=sys.argv[1]
p=Path("/etc/avahi/hosts")
lines=p.read_text(encoding="utf-8",errors="ignore").splitlines() if p.exists() else []
out=[x for x in lines if not re.search(r'(^|\s)(andon|dci)\.local(\s|$)',x,re.I)]
out += [f"{ip} andon.local",f"{ip} dci.local"]
p.write_text("\n".join(out).rstrip()+"\n",encoding="utf-8")
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

if [[ -f "$SCRIPT_DIR/diagnostico-red-andondci.sh" ]]; then
  install -m 0755 "$SCRIPT_DIR/diagnostico-red-andondci.sh" /usr/local/sbin/DIAGNOSTICO-ANDON-DCI-RED
fi

printf '%s\n' "$CORE_VERSION" > /var/lib/andon-dci-network-core.version
ip -4 route show table main > "$BACKUP/routes-after.txt" || true
trap - ERR

cat <<EOF_DONE

======================================================================
 ANDON/DCI NETWORK CORE $CORE_VERSION OK
======================================================================
Modelo restaurado:
- Windows remoto -> RPi /32 via gateway
- RPi -> cliente remoto /32 via gateway
- registro UDP automatico puerto 8788
- mismo tercer octeto /24 -> directo, sin ruta artificial
- rutas de clientes persistidas en $CLIENTS_FILE

Service IP : $SERVICE_IP
Interface  : $TARGET_IF
Gateway    : $GATEWAY
ANDON      : http://andon.local/
DCI        : http://dci.local/datacenter/
======================================================================
EOF_DONE
