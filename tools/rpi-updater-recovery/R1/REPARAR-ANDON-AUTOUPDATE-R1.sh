#!/usr/bin/env bash
set -Eeuo pipefail

EXPECTED_ANDON="1.0.13"
EXPECTED_CORE="2.3.4"
OWNER_DEFAULT="CheeseVader"
REPO_DEFAULT="TicketSystem-Release"

APP_ROOT="/opt/andon"
APP_DIR="$APP_ROOT/app"
APP_ENV="/etc/andon/andon.env"
ENV_FILE="/etc/andon-updater/updater.env"
UPDATER="/usr/local/sbin/andon-auto-update.sh"
SERVICE="/etc/systemd/system/andon-auto-update.service"
TIMER="/etc/systemd/system/andon-auto-update.timer"
STATUS_DIR="/var/lib/andon-updater"
STATUS_FILE="$STATUS_DIR/bootstrap-status.json"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/var/backups/andon-auto-update-repair/$STAMP"

log(){ printf '[BOOTSTRAP] %s\n' "$*"; }
die(){ printf '[BOOTSTRAP][ERROR] %s\n' "$*" >&2; exit 1; }

[[ ${EUID:-$(id -u)} -eq 0 ]] || die "Debe ejecutarse como root."

for c in bash curl jq flock sha256sum tar npm systemctl; do
  command -v "$c" >/dev/null 2>&1 || die "Falta comando: $c"
done

mkdir -p "$BACKUP" "$STATUS_DIR"
chmod 0755 "$STATUS_DIR"

for p in "$UPDATER" "$SERVICE" "$TIMER" "$ENV_FILE"; do
  if [[ -e "$p" ]]; then
    mkdir -p "$BACKUP$(dirname "$p")"
    cp -a "$p" "$BACKUP$p"
  fi
done

TOKEN=""
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE" || true
  TOKEN="${GITHUB_TOKEN:-}"
fi

mkdir -p "$(dirname "$ENV_FILE")"
umask 077
cat >"$ENV_FILE" <<EOF
GITHUB_OWNER=$OWNER_DEFAULT
GITHUB_REPO=$REPO_DEFAULT
GITHUB_TOKEN=$TOKEN
CHANNEL=stable
AUTO_INSTALL=true
EOF
chmod 0600 "$ENV_FILE"

cat >"$UPDATER" <<'UPDATER'
#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="/opt/andon"
APP_DIR="$APP_ROOT/app"
APP_ENV="/etc/andon/andon.env"
ENV_FILE="/etc/andon-updater/updater.env"
LOCK_FILE="/run/andon-auto-update.lock"
STATUS_DIR="/var/lib/andon-updater"
STATUS_FILE="$STATUS_DIR/status.json"
LOG_TAG="andon-auto-update"

log(){ logger -t "$LOG_TAG" "$*"; printf '[ANDON-UPDATE] %s\n' "$*"; }

status(){
  local phase="${1:-UNKNOWN}"
  local message="${2:-}"
  local current="${3:-}"
  local latest="${4:-}"
  mkdir -p "$STATUS_DIR"
  jq -n     --arg phase "$phase"     --arg message "$message"     --arg current "$current"     --arg latest "$latest"     --arg ts "$(date -Is)"     '{phase:$phase,message:$message,currentVersion:$current,latestVersion:$latest,timestamp:$ts}'     >"$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
  chmod 0644 "$STATUS_FILE" || true
  if [[ -d "$APP_DIR/public" ]]; then
    cp -f "$STATUS_FILE" "$APP_DIR/public/updater-recovery-status.json" 2>/dev/null || true
    chmod 0644 "$APP_DIR/public/updater-recovery-status.json" 2>/dev/null || true
  fi
}

CURRENT=""
NEW=""

fail(){
  local msg="$*"
  status "FAILED" "$msg" "$CURRENT" "$NEW"
  log "ERROR: $msg"
  exit 1
}

trap 'rc=$?; if (( rc != 0 )); then status "FAILED" "Updater termino RC=$rc" "$CURRENT" "$NEW"; fi' EXIT

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

[[ -f "$ENV_FILE" ]] || fail "No existe $ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"

OWNER="${GITHUB_OWNER:-CheeseVader}"
REPO="${GITHUB_REPO:-TicketSystem-Release}"
TOKEN="${GITHUB_TOKEN:-}"

api(){
  local url="$1"
  local tmp
  tmp="$(mktemp)"
  if [[ -n "$TOKEN" ]]; then
    if curl -fsSL --connect-timeout 10 --max-time 30       -H "Accept: application/vnd.github+json"       -H "Authorization: Bearer $TOKEN"       -H "X-GitHub-Api-Version: 2022-11-28"       "$url" -o "$tmp"; then
      cat "$tmp"; rm -f "$tmp"; return 0
    fi
  fi
  curl -fsSL --connect-timeout 10 --max-time 30     -H "Accept: application/vnd.github+json"     -H "X-GitHub-Api-Version: 2022-11-28"     "$url" -o "$tmp" || { rm -f "$tmp"; return 1; }
  cat "$tmp"
  rm -f "$tmp"
}

[[ -f "$APP_DIR/VERSION" ]] && CURRENT="$(tr -d '[:space:]' < "$APP_DIR/VERSION")"
status "CHECKING" "Consultando GitHub Releases" "$CURRENT" ""

REL="$(api "https://api.github.com/repos/$OWNER/$REPO/releases/latest")" || fail "No se pudo consultar GitHub Releases."
TAG="$(printf '%s' "$REL" | jq -r '.tag_name // empty')"
[[ -n "$TAG" ]] || fail "GitHub no devolvio tag_name."
NEW="${TAG#v}"

status "CHECKING" "Release detectada" "$CURRENT" "$NEW"

if [[ "$CURRENT" == "$NEW" ]]; then
  status "UP_TO_DATE" "Sin cambios" "$CURRENT" "$NEW"
  log "Sin cambios. Instalada=$CURRENT GitHub=$NEW"
  trap - EXIT
  exit 0
fi

log "Nueva release detectada: instalada=${CURRENT:-ninguna} nueva=$NEW"
status "DOWNLOADING" "Descargando manifest y asset" "$CURRENT" "$NEW"

MANIFEST_URL="$(printf '%s' "$REL" | jq -r '.assets[] | select(.name=="release-manifest.json") | .browser_download_url' | head -1)"
[[ -n "$MANIFEST_URL" && "$MANIFEST_URL" != "null" ]] || fail "$TAG no contiene release-manifest.json."

WORK="$(mktemp -d /tmp/andon-update.XXXXXX)"
cleanup(){ rm -rf "$WORK"; }
trap 'rc=$?; cleanup; if (( rc != 0 )); then status "FAILED" "Updater termino RC=$rc" "$CURRENT" "$NEW"; fi' EXIT

curl -fsSL --connect-timeout 10 --max-time 60 "$MANIFEST_URL" -o "$WORK/manifest.json"
ASSET="$(jq -r '.asset // empty' "$WORK/manifest.json")"
ASHA="$(jq -r '.sha256 // empty' "$WORK/manifest.json" | tr '[:upper:]' '[:lower:]')"
[[ -n "$ASSET" && -n "$ASHA" ]] || fail "Manifest incompleto."

AURL="$(printf '%s' "$REL" | jq -r --arg a "$ASSET" '.assets[] | select(.name==$a) | .browser_download_url' | head -1)"
[[ -n "$AURL" && "$AURL" != "null" ]] || fail "No se encontro asset $ASSET."

curl -fsSL --connect-timeout 10 --max-time 180 "$AURL" -o "$WORK/app.tgz"
GOT="$(sha256sum "$WORK/app.tgz" | awk '{print $1}')"
[[ "$GOT" == "$ASHA" ]] || fail "SHA256 incorrecto para $ASSET."

mkdir "$WORK/newapp"
tar -xzf "$WORK/app.tgz" -C "$WORK/newapp"
for f in src/server.js package.json; do
  [[ -f "$WORK/newapp/$f" ]] || fail "Release incompleta: falta $f"
done

status "INSTALLING" "Instalando dependencias y postinstall" "$CURRENT" "$NEW"
(
  cd "$WORK/newapp"
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev
  else
    npm install --omit=dev
  fi
)

printf '%s\n' "$NEW" > "$WORK/newapp/VERSION"

BACKUP="$APP_ROOT/code-rollbacks/$(date +%Y%m%d-%H%M%S)-${CURRENT:-unknown}"
mkdir -p "$APP_ROOT/code-rollbacks"
[[ -d "$APP_DIR" ]] && cp -a "$APP_DIR" "$BACKUP"
chown -R andon:andon "$WORK/newapp"

rollback_app(){
  log "Rollback de aplicacion."
  systemctl stop andon.service >/dev/null 2>&1 || true
  rm -rf "$APP_DIR"
  if [[ -d "$APP_ROOT/app.previous" ]]; then
    mv "$APP_ROOT/app.previous" "$APP_DIR"
    chown -R andon:andon "$APP_DIR"
  fi
  systemctl start andon.service >/dev/null 2>&1 || true
}

systemctl stop andon.service
OLD="$APP_ROOT/app.previous"
rm -rf "$OLD"
[[ -d "$APP_DIR" ]] && mv "$APP_DIR" "$OLD"
mv "$WORK/newapp" "$APP_DIR"
chown -R andon:andon "$APP_DIR"

if [[ -f "$APP_ENV" && -f "$APP_DIR/src/migrate-managed.js" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$APP_ENV"
  set +a
  if ! sudo -u andon env       DATABASE_URL="${DATABASE_URL:-}"       NODE_ENV="${NODE_ENV:-production}"       SESSION_SECRET="${SESSION_SECRET:-}"       /usr/bin/node "$APP_DIR/src/migrate-managed.js"; then
    rollback_app
    fail "migrate-managed.js fallo; aplicacion restaurada."
  fi
fi

systemctl start andon.service

OK=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/build >/dev/null 2>&1; then
    OK=1
    break
  fi
  sleep 2
done

if (( ! OK )); then
  rollback_app
  fail "Health check ANDON fallo; aplicacion restaurada."
fi

rm -rf "$OLD"
status "SUCCESS" "Actualizacion completada" "$CURRENT" "$NEW"
log "Actualizacion completada: $CURRENT -> $NEW"
trap - EXIT
cleanup
UPDATER

chmod 0755 "$UPDATER"
bash -n "$UPDATER" || die "Updater nuevo no pasa bash -n."

cat >"$SERVICE" <<'EOF'
[Unit]
Description=ANDON GitHub Release Auto Update
After=network-online.target andon.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/andon-auto-update.sh
EOF

cat >"$TIMER" <<'EOF'
[Unit]
Description=Buscar actualizaciones ANDON cada 5 minutos

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true
Unit=andon-auto-update.service

[Install]
WantedBy=timers.target
EOF

cat >"$STATUS_FILE" <<EOF
{
  "phase": "BOOTSTRAP_INSTALLED",
  "message": "Updater reparado; se encolo una ejecucion.",
  "expectedAndon": "$EXPECTED_ANDON",
  "expectedCore": "$EXPECTED_CORE",
  "backup": "$BACKUP",
  "timestamp": "$(date -Is)"
}
EOF
chmod 0644 "$STATUS_FILE"
if [[ -d "$APP_DIR/public" ]]; then
  cp -f "$STATUS_FILE" "$APP_DIR/public/updater-recovery-status.json"
  chmod 0644 "$APP_DIR/public/updater-recovery-status.json"
fi

systemctl daemon-reload
systemctl enable --now andon-auto-update.timer >/dev/null
systemctl start --no-block andon-auto-update.service

log "Updater reparado."
log "Backup: $BACKUP"
log "Timer activo: $(systemctl is-active andon-auto-update.timer 2>/dev/null || true)"
log "Update service encolado; Windows puede validar por HTTP."