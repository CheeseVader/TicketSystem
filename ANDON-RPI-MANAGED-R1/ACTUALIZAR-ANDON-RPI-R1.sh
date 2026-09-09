#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT="${APP_ROOT:-/opt/andon}"
APP_DIR="${APP_DIR:-$APP_ROOT/app}"
ENV_FILE="${UPDATER_ENV:-/etc/andon-updater/updater.env}"
SERVICE="${SERVICE_NAME:-andon.service}"
STAGE="/var/tmp/andon-update"
BACKUPS="$APP_ROOT/code-rollbacks"

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[AVISO]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Ejecuta con sudo."
[[ -f "$ENV_FILE" ]] || die "No existe $ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${GITHUB_OWNER:?Falta GITHUB_OWNER}"
: "${GITHUB_REPO:?Falta GITHUB_REPO}"
: "${GITHUB_TOKEN:?Falta GITHUB_TOKEN}"

rm -rf "$STAGE"; mkdir -p "$STAGE" "$BACKUPS"
HDR=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: ANDON-Updater")
API="https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO"

say "Consultando ultima Release estable de aplicacion"
curl -fsS "${HDR[@]}" "$API/releases?per_page=100" -o "$STAGE/releases.json" || die "No pude consultar Releases."
jq -c '[.[] | select((.draft|not) and (.prerelease|not) and (.tag_name|startswith("v")))][0] // empty' "$STAGE/releases.json" > "$STAGE/release.json"
TAG="$(jq -r '.tag_name // empty' "$STAGE/release.json")"
[[ "$TAG" == v* ]] || die "No existe Release de aplicacion v* estable."
VERSION="${TAG#v}"
MAN_URL="$(jq -r '.assets[] | select(.name=="release-manifest.json") | .url' "$STAGE/release.json")"
[[ -n "$MAN_URL" ]] || die "Release sin release-manifest.json."
curl -fsS "${HDR[@]}" -H "Accept: application/octet-stream" "$MAN_URL" -o "$STAGE/release-manifest.json"
ASSET="$(jq -r '.asset' "$STAGE/release-manifest.json")"
EXPECTED="$(jq -r '.sha256' "$STAGE/release-manifest.json")"
ASSET_URL="$(jq -r --arg a "$ASSET" '.assets[] | select(.name==$a) | .url' "$STAGE/release.json")"
[[ -n "$ASSET_URL" ]] || die "No encontre asset $ASSET."
curl -fL "${HDR[@]}" -H "Accept: application/octet-stream" "$ASSET_URL" -o "$STAGE/$ASSET"
ACTUAL="$(sha256sum "$STAGE/$ASSET" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || die "SHA256 invalido."

CURRENT="$(cat "$APP_DIR/VERSION" 2>/dev/null || echo 'ninguna')"
if [[ "$CURRENT" == "$VERSION" && -d "$APP_DIR/node_modules" ]]; then
  ok "Ya esta instalada v$VERSION."
  exit 0
fi

say "Preparando v$VERSION (actual: $CURRENT)"
mkdir -p "$STAGE/new"
tar -xzf "$STAGE/$ASSET" -C "$STAGE/new"
[[ -f "$STAGE/new/package.json" && -f "$STAGE/new/src/server.js" ]] || die "Paquete ANDON incompleto."
(cd "$STAGE/new" && if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi)

# Ejecutar migracion/DB init en staging usando la configuracion instalada.
if [[ -f /etc/andon/andon.env ]]; then
  set -a; source /etc/andon/andon.env; set +a
fi
PKG="$STAGE/new/package.json"
for candidate in db:migrate migrate db:init db:setup init-db; do
  if node -e "let p=require('$PKG');process.exit(p.scripts&&p.scripts['$candidate']?0:1)" 2>/dev/null; then
    say "Ejecutando npm run $candidate"
    (cd "$STAGE/new" && npm run "$candidate")
    break
  fi
done

STAMP="$(date +%Y%m%d-%H%M%S)"
if [[ -d "$APP_DIR" ]]; then
  cp -a "$APP_DIR" "$BACKUPS/app-$STAMP"
fi

[[ "${SKIP_SERVICE_RESTART:-0}" == "1" ]] || systemctl stop "$SERVICE" 2>/dev/null || true
rm -rf "$APP_DIR.new"
mv "$STAGE/new" "$APP_DIR.new"
rm -rf "$APP_DIR"
mv "$APP_DIR.new" "$APP_DIR"
printf '%s\n' "$VERSION" > "$APP_DIR/VERSION"
chown -R andon:andon "$APP_ROOT"

if [[ "${SKIP_SERVICE_RESTART:-0}" != "1" ]]; then
  systemctl start "$SERVICE"
  sleep 3
  if ! curl -fsS "http://127.0.0.1:${PORT:-3000}/api/build" >/dev/null; then
    warn "Nueva version no responde. Aplicando rollback."
    systemctl stop "$SERVICE" || true
    rm -rf "$APP_DIR"
    LAST="$(find "$BACKUPS" -maxdepth 1 -type d -name 'app-*' | sort | tail -1)"
    [[ -n "$LAST" ]] || die "Fallo y no existe rollback."
    cp -a "$LAST" "$APP_DIR"
    chown -R andon:andon "$APP_DIR"
    systemctl start "$SERVICE"
    die "Update v$VERSION fallo; rollback restaurado."
  fi
fi
ok "ANDON actualizado: $CURRENT -> $VERSION"
