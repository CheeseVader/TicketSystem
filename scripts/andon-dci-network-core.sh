#!/usr/bin/env bash
set -Eeuo pipefail

CORE_VERSION="2.0.0"
DEFAULT_SERVICE_IP="10.138.43.217"
SERVICE_IP="${ANDON_DCI_SERVICE_IP:-$DEFAULT_SERVICE_IP}"
BACKUP_ROOT="/var/backups/andon-dci-network-core"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUP_ROOT/$STAMP"
LAST_LINK="$BACKUP_ROOT/LAST"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say(){ printf '\n==> %s\n' "$*"; }
ok(){ printf '[OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }
die(){ printf '[ERROR] %s\n' "$*" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Este postinstall requiere root en Raspberry Pi."

say "ANDON/DCI Network Core $CORE_VERSION"

# ----------------------------------------------------------------------
# Detect the real service interface and real prefix. Never assume /24.
# Prefer the historical service IP when present; otherwise use default-route src.
# ----------------------------------------------------------------------
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
  warn "$SERVICE_IP no esta asignada; usando IPv4 activa $DETECTED_SRC en $TARGET_IF."
  SERVICE_IP="$DETECTED_SRC"
fi

mapfile -t LOCAL_CIDRS < <(
  ip -4 -o addr show dev "$TARGET_IF" scope global 2>/dev/null | awk '{print $4}'
)
[[ ${#LOCAL_CIDRS[@]} -gt 0 ]] || die "No hay prefijo IPv4 global en $TARGET_IF."

GATEWAY="$(ip -4 route show default dev "$TARGET_IF" 2>/dev/null | awk 'NR==1{print $3}')"

printf 'Service IP : %s\n' "$SERVICE_IP"
printf 'Interface  : %s\n' "$TARGET_IF"
printf 'CIDR real  : %s\n' "${LOCAL_CIDRS[*]}"
printf 'Gateway    : %s\n' "${GATEWAY:-NO-DETECTADO}"

# ----------------------------------------------------------------------
# Dependencies. Install only when missing.
# ----------------------------------------------------------------------
MISSING=()
command -v nginx >/dev/null 2>&1 || MISSING+=(nginx)
command -v avahi-daemon >/dev/null 2>&1 || MISSING+=(avahi-daemon)
command -v avahi-resolve-host-name >/dev/null 2>&1 || MISSING+=(avahi-utils)
command -v python3 >/dev/null 2>&1 || MISSING+=(python3)

if [[ ${#MISSING[@]} -gt 0 ]]; then
  say "Instalando dependencias faltantes: ${MISSING[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y "${MISSING[@]}" libnss-mdns iproute2
fi

# ----------------------------------------------------------------------
# Backup only the network layer this core owns.
# ----------------------------------------------------------------------
mkdir -p "$BACKUP/rootfs" "$BACKUP_ROOT"
: > "$BACKUP/paths.list"
: > "$BACKUP/services.list"

MANAGED_PATHS=(
  /etc/avahi/avahi-daemon.conf
  /etc/avahi/hosts
  /etc/avahi/services/andon.service
  /etc/avahi/services/dci.service
  /etc/avahi/services/andon-dci.service
  /etc/nginx/sites-available/andon
  /etc/nginx/sites-available/dci
  /etc/nginx/sites-available/dci-local
  /etc/nginx/sites-enabled/default
  /etc/nginx/sites-enabled/andon
  /etc/nginx/sites-enabled/dci
  /etc/nginx/sites-enabled/dci-local
  /usr/local/sbin/andon-network-fix.sh
  /usr/local/sbin/andon-client-register.py
  /etc/systemd/system/andon-network-fix.service
  /etc/systemd/system/andon-client-register.service
  /etc/systemd/system/dci-mdns.service
  /etc/NetworkManager/dispatcher.d/90-andon-network-fix
  /etc/sysctl.d/90-andon-dci-network.conf
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
  warn "Network Core fallo (RC=$rc). Restaurando archivos administrados."
  restore_files
  exit "$rc"
}
trap rollback_on_error ERR

# ----------------------------------------------------------------------
# Remove the old ANDON per-client /32 routing design.
# Kernel connected routes handle same-subnet traffic directly; remote VLANs
# naturally use the default gateway. No artificial client route is required.
# ----------------------------------------------------------------------
say "Retirando rutas /32 legacy y servicios de registro por cliente"
systemctl disable --now andon-client-register.service >/dev/null 2>&1 || true
systemctl disable --now andon-network-fix.service >/dev/null 2>&1 || true
systemctl disable --now dci-mdns.service >/dev/null 2>&1 || true

if [[ -f /var/lib/andon-network-fix/clients.txt ]]; then
  while IFS= read -r client; do
    [[ "$client" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
    while ip -4 route show "$client/32" 2>/dev/null | grep -q ' via '; do
      ip -4 route del "$client/32" 2>/dev/null || break
    done
  done < /var/lib/andon-network-fix/clients.txt
fi

# Also remove stale /32 via-gateway routes generated by the historical fixer
# inside the managed 10.138.40-43 ranges. A connected prefix or default route
# is the correct kernel path.
while IFS= read -r prefix; do
  [[ -n "$prefix" ]] || continue
  ip -4 route del "$prefix" 2>/dev/null || true
done < <(
  ip -4 route show table main 2>/dev/null |
  awk '$1 ~ /^10\.138\.(40|41|42|43)\.[0-9]+\/32$/ && $0 ~ / via / {print $1}'
)

rm -f \
  /usr/local/sbin/andon-network-fix.sh \
  /usr/local/sbin/andon-client-register.py \
  /etc/systemd/system/andon-network-fix.service \
  /etc/systemd/system/andon-client-register.service \
  /etc/systemd/system/dci-mdns.service \
  /etc/NetworkManager/dispatcher.d/90-andon-network-fix

systemctl daemon-reload
ok "Legacy per-client routing retirado"

# ----------------------------------------------------------------------
# Loose reverse path filtering only on the service interface.
# ----------------------------------------------------------------------
cat > /etc/sysctl.d/90-andon-dci-network.conf <<EOF_SYSCTL
# ANDON/DCI shared network core $CORE_VERSION
# Loose mode tolerates legitimate asymmetric VLAN paths without disabling
# reverse path validation globally.
net.ipv4.conf.$TARGET_IF.rp_filter=2
EOF_SYSCTL
sysctl -p /etc/sysctl.d/90-andon-dci-network.conf >/dev/null
ok "rp_filter=2 en $TARGET_IF"

# ----------------------------------------------------------------------
# Bonjour / mDNS. Publish exactly the service interface/address.
# No reflector: mDNS is link-local; routed-VLAN reflection belongs to network infra.
# ----------------------------------------------------------------------
say "Reconstruyendo Bonjour/mDNS"
mkdir -p /etc/avahi/services

cat > /etc/avahi/avahi-daemon.conf <<EOF_AVAHI
[server]
host-name=andon
use-ipv4=yes
use-ipv6=no
allow-interfaces=$TARGET_IF
ratelimit-interval-usec=1000000
ratelimit-burst=1000

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

rm -f /etc/avahi/services/andon-dci.service
touch /etc/avahi/hosts
python3 - "$SERVICE_IP" <<'PY'
from pathlib import Path
import re, sys
ip=sys.argv[1]
p=Path('/etc/avahi/hosts')
lines=p.read_text(encoding='utf-8',errors='ignore').splitlines() if p.exists() else []
out=[]
for line in lines:
    if re.search(r'(^|\s)(andon|dci)\.local(\s|$)', line, re.I):
        continue
    out.append(line)
out += [f'{ip} andon.local', f'{ip} dci.local']
p.write_text('\n'.join(out).rstrip()+'\n',encoding='utf-8')
PY

cat > /etc/avahi/services/andon.service <<'EOF_ANDON_MDNS'
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
EOF_ANDON_MDNS

cat > /etc/avahi/services/dci.service <<'EOF_DCI_MDNS'
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
EOF_DCI_MDNS

systemctl enable avahi-daemon >/dev/null
systemctl restart avahi-daemon
sleep 1
systemctl is-active --quiet avahi-daemon || die "avahi-daemon no quedo activo."
ok "Bonjour publica andon.local y dci.local en $TARGET_IF"

# ----------------------------------------------------------------------
# Canonical Nginx split: ANDON default/IP, DCI by hostname.
# ----------------------------------------------------------------------
say "Reconstruyendo Nginx compartido"
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

cat > /etc/nginx/sites-available/andon <<'EOF_NGINX_ANDON'
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
EOF_NGINX_ANDON

cat > /etc/nginx/sites-available/dci <<'EOF_NGINX_DCI'
server {
    listen 80;
    listen [::]:80;
    server_name dci.local;

    client_max_body_size 0;

    location = / {
        return 302 /datacenter/;
    }

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
EOF_NGINX_DCI

rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/dci-local
ln -sfn /etc/nginx/sites-available/andon /etc/nginx/sites-enabled/andon
ln -sfn /etc/nginx/sites-available/dci /etc/nginx/sites-enabled/dci

nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx
systemctl is-active --quiet nginx || die "nginx no quedo activo."
ok "Nginx: ANDON :3000 + DCI :3100"

# ----------------------------------------------------------------------
# Install read-only diagnostic and rollback helpers from the release payload.
# ----------------------------------------------------------------------
if [[ -f "$SCRIPT_DIR/diagnostico-red-andondci.sh" ]]; then
  install -m 0755 "$SCRIPT_DIR/diagnostico-red-andondci.sh" /usr/local/sbin/DIAGNOSTICO-ANDON-DCI-RED
fi
if [[ -f "$SCRIPT_DIR/rollback-red-andondci.sh" ]]; then
  install -m 0755 "$SCRIPT_DIR/rollback-red-andondci.sh" /usr/local/sbin/ROLLBACK-ANDON-DCI-RED
fi

# ----------------------------------------------------------------------
# Sanity checks. Same-subnet correctness comes from the kernel's connected
# route; after legacy /32 removal, a local peer must not be forced via gateway.
# ----------------------------------------------------------------------
say "Validando Network Core"
ip -4 route show table main > "$BACKUP/routes-after.txt" || true

STALE="$({
  ip -4 route show table main 2>/dev/null |
  awk '$1 ~ /^10\.138\.(40|41|42|43)\.[0-9]+\/32$/ && $0 ~ / via / {print}'
} || true)"
if [[ -n "$STALE" ]]; then
  warn "Aun existen rutas /32 via gateway no administradas:"
  warn "$STALE"
fi

A_RES="$(avahi-resolve-host-name -4 andon.local 2>/dev/null | awk 'NR==1{print $2}' || true)"
D_RES="$(avahi-resolve-host-name -4 dci.local 2>/dev/null | awk 'NR==1{print $2}' || true)"
if [[ "$A_RES" != "$SERVICE_IP" ]]; then warn "andon.local resolvio '${A_RES:-nada}', esperado $SERVICE_IP"; fi
if [[ "$D_RES" != "$SERVICE_IP" ]]; then warn "dci.local resolvio '${D_RES:-nada}', esperado $SERVICE_IP"; fi

printf '%s\n' "$CORE_VERSION" > /var/lib/andon-dci-network-core.version
trap - ERR

cat <<EOF_DONE

======================================================================
 ANDON/DCI NETWORK CORE $CORE_VERSION OK
======================================================================
Service IP : $SERVICE_IP
Interface  : $TARGET_IF
CIDR real  : ${LOCAL_CIDRS[*]}
Gateway    : ${GATEWAY:-NO-DETECTADO}
ANDON      : http://andon.local/
DCI        : http://dci.local/datacenter/
Backup     : $BACKUP

Regla activa:
- mismo segmento real -> kernel connected route / ARP, SIN gateway artificial
- otra VLAN           -> routing normal por gateway
- Bonjour             -> misma interfaz/segmento; reflector entre VLANs queda en infraestructura
======================================================================
EOF_DONE
