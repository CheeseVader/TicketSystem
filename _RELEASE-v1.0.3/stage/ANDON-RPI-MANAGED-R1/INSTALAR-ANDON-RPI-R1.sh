#!/usr/bin/env bash
set -Eeuo pipefail

OWNER="${GITHUB_OWNER:-CheeseVader}"
RELEASE_REPO="${GITHUB_RELEASE_REPO:-TicketSystem-Release}"
APP_ROOT="/opt/andon"
APP_DIR="$APP_ROOT/app"
CONFIG_DIR="/etc/andon"
UPDATER_DIR="/etc/andon-updater"
BACKUP_DIR="/etc/andon-backup"
APP_USER="andon"
APP_GROUP="andon"
SERVICE="andon.service"
PORT=3000

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[AVISO]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Ejecuta con sudo."

read_secret(){
  local prompt="$1" v=""
  read -r -s -p "$prompt: " v </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$v"
}

read_value(){
  local prompt="$1" default="${2:-}" v=""
  if [[ -n "$default" ]]; then read -r -p "$prompt [$default]: " v </dev/tty || true; else read -r -p "$prompt: " v </dev/tty || true; fi
  [[ -n "$v" ]] || v="$default"
  printf '%s' "$v"
}

say "Dependencias Linux/Raspberry Pi"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl jq ca-certificates tar gzip openssl postgresql postgresql-client avahi-daemon gh
if ! command -v node >/dev/null 2>&1; then
  apt-get install -y nodejs npm
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  ARCH="$(dpkg --print-architecture)"
  case "$ARCH" in
    arm64|amd64)
      curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" -o /tmp/cloudflared.deb
      dpkg -i /tmp/cloudflared.deb || apt-get -f install -y
      ;;
    armhf)
      curl -fL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm.deb" -o /tmp/cloudflared.deb
      dpkg -i /tmp/cloudflared.deb || apt-get -f install -y
      ;;
    *) warn "Arquitectura $ARCH: instala cloudflared manualmente." ;;
  esac
fi

say "Usuario, hostname y directorios"
getent group "$APP_GROUP" >/dev/null || groupadd --system "$APP_GROUP"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --gid "$APP_GROUP" --home "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_ROOT" "$CONFIG_DIR" "$UPDATER_DIR" "$BACKUP_DIR"
chmod 700 "$UPDATER_DIR" "$BACKUP_DIR"
hostnamectl set-hostname andon || true
systemctl enable --now avahi-daemon

say "Token de lectura para Releases"
READ_TOKEN="${GITHUB_TOKEN:-}"
if [[ -z "$READ_TOKEN" ]]; then
  READ_TOKEN="$(read_secret "GitHub token READ-ONLY para $OWNER/$RELEASE_REPO")"
fi
[[ -n "$READ_TOKEN" ]] || die "Token vacio."
cat > "$UPDATER_DIR/updater.env" <<EOF
GITHUB_OWNER=$OWNER
GITHUB_REPO=$RELEASE_REPO
GITHUB_TOKEN=$READ_TOKEN
CHANNEL=stable
EOF
chmod 600 "$UPDATER_DIR/updater.env"

say "Identidad de la instalacion"
BRAND_NAME="${BRAND_NAME:-}"
if [[ -z "$BRAND_NAME" ]]; then BRAND_NAME="$(read_value "Nombre de la marca/empresa" "TCL")"; fi
[[ -n "$BRAND_NAME" ]] || die "El nombre de la marca no puede quedar vacio."
ok "Marca configurada: $BRAND_NAME"

say "PostgreSQL ANDON"
systemctl enable --now postgresql
DB_PASSWORD="$(openssl rand -hex 24)"
SESSION_SECRET="$(openssl rand -hex 32)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='andon_app') THEN
    CREATE ROLE andon_app LOGIN PASSWORD '$DB_PASSWORD';
  ELSE
    ALTER ROLE andon_app PASSWORD '$DB_PASSWORD';
  END IF;
END
\$\$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='andon_support'" | grep -q 1; then
  sudo -u postgres createdb -O andon_app andon_support
fi
cat > "$CONFIG_DIR/andon.env" <<EOF
HOST=0.0.0.0
PORT=$PORT
NODE_ENV=production
BRAND_NAME="$BRAND_NAME"
DATABASE_URL=postgresql://andon_app:$DB_PASSWORD@127.0.0.1:5432/andon_support
SESSION_SECRET=$SESSION_SECRET
EOF
chmod 600 "$CONFIG_DIR/andon.env"
chown root:"$APP_GROUP" "$CONFIG_DIR/andon.env"

say "Instalando updater y descargando ultima Release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for s in ACTUALIZAR-ANDON-RPI-R1.sh BACKUP-ANDON-RPI-R1.sh RESTAURAR-ANDON-RPI-R1.sh DIAGNOSTICO-ANDON-RPI-R1.sh; do
  if [[ -f "$SCRIPT_DIR/$s" ]]; then install -m 0755 "$SCRIPT_DIR/$s" "/usr/local/sbin/${s%.sh}"; fi
done
[[ -x /usr/local/sbin/ACTUALIZAR-ANDON-RPI-R1 ]] || die "Falta ACTUALIZAR-ANDON-RPI-R1.sh junto al instalador."
SKIP_SERVICE_RESTART=1 /usr/local/sbin/ACTUALIZAR-ANDON-RPI-R1

say "Servicio systemd ANDON"
cat > /etc/systemd/system/andon.service <<EOF
[Unit]
Description=ANDON Support
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=$CONFIG_DIR/andon.env
ExecStart=/usr/bin/node $APP_DIR/src/server.js
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

say "Cloudflared TryCloudflare automatico"
if command -v cloudflared >/dev/null 2>&1; then
cat > /etc/systemd/system/cloudflared-andon.service <<EOF
[Unit]
Description=ANDON TryCloudflare
After=network-online.target andon.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v cloudflared) tunnel --no-autoupdate --url http://127.0.0.1:$PORT
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable --now andon.service
if [[ -f /etc/systemd/system/cloudflared-andon.service ]]; then
  systemctl enable --now cloudflared-andon.service
fi

sleep 3
curl -fsS "http://127.0.0.1:$PORT/api/build" >/dev/null || warn "ANDON aun no responde en /api/build; revisa diagnostico."

IP="$(hostname -I | awk '{print $1}')"
ok "ANDON instalado."
printf '\nLOCAL      http://127.0.0.1:%s\n' "$PORT"
printf 'MDNS       http://andon.local:%s\n' "$PORT"
[[ -n "$IP" ]] && printf 'LAN        http://%s:%s\n' "$IP" "$PORT"
printf 'DASHBOARD  /dashboard\nSOPORTE    /soporte\nESTACION   /station/CODIGO\n'
printf '\nCloudflare URL: journalctl -u cloudflared-andon -n 30 --no-pager\n'
printf 'Diagnostico: sudo /usr/local/sbin/DIAGNOSTICO-ANDON-RPI-R1\n'
