#!/usr/bin/env bash
set -Eeuo pipefail

UPDATER_ENV="${UPDATER_ENV:-/etc/andon-updater/updater.env}"
APP_ENV="/etc/andon/andon.env"
SERVICE="andon.service"
STAGE="/var/tmp/andon-restore"

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[AVISO]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Ejecuta con sudo."
[[ -f "$UPDATER_ENV" ]] || die "Falta $UPDATER_ENV"
[[ -f "$APP_ENV" ]] || die "Falta $APP_ENV"
source "$UPDATER_ENV"
source "$APP_ENV"

read -r -p "Esto reemplazara la BD actual. Escribe RESTAURAR: " CONFIRM </dev/tty
[[ "$CONFIRM" == "RESTAURAR" ]] || die "Cancelado."

rm -rf "$STAGE"; mkdir -p "$STAGE"
HDR=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" -H "User-Agent: ANDON-Restore")
API="https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO"

say "Buscando ultimo backup-*"
PAGE="$STAGE/releases.json"
curl -fsS "${HDR[@]}" "$API/releases?per_page=100" -o "$PAGE"
TAG="$(jq -r '[.[] | select(.tag_name|startswith("backup-"))][0].tag_name // empty' "$PAGE")"
[[ -n "$TAG" ]] || die "No hay backup-*."
REL="$(jq -c --arg t "$TAG" '.[] | select(.tag_name==$t)' "$PAGE")"
MANURL="$(jq -r '.assets[] | select(.name=="backup-manifest.json") | .url' <<<"$REL")"
DBURL="$(jq -r '.assets[] | select(.name=="andon-db.dump") | .url' <<<"$REL")"
[[ -n "$MANURL" && -n "$DBURL" ]] || die "Backup incompleto."
curl -fsS "${HDR[@]}" -H "Accept: application/octet-stream" "$MANURL" -o "$STAGE/backup-manifest.json"
curl -fL "${HDR[@]}" -H "Accept: application/octet-stream" "$DBURL" -o "$STAGE/andon-db.dump"
EXPECTED="$(jq -r '.db_sha256' "$STAGE/backup-manifest.json")"
ACTUAL="$(sha256sum "$STAGE/andon-db.dump" | awk '{print $1}')"
[[ "$EXPECTED" == "$ACTUAL" ]] || die "SHA256 del backup invalido."

# Recuperar tambien la version EXACTA de la aplicacion asociada al backup.
APPVER="$(jq -r '.app_version // empty' "$STAGE/backup-manifest.json")"
if [[ -n "$APPVER" && "$APPVER" != "unknown" ]]; then
  say "Descargando aplicacion exacta v$APPVER del backup"
  curl -fsS "${HDR[@]}" "$API/releases/tags/v$APPVER" -o "$STAGE/app-release.json" || die "No existe Release v$APPVER requerido por el backup."
  APPMANURL="$(jq -r '.assets[] | select(.name=="release-manifest.json") | .url' "$STAGE/app-release.json")"
  [[ -n "$APPMANURL" ]] || die "v$APPVER no tiene release-manifest.json."
  curl -fsS "${HDR[@]}" -H "Accept: application/octet-stream" "$APPMANURL" -o "$STAGE/release-manifest.json"
  APPASSET="$(jq -r '.asset' "$STAGE/release-manifest.json")"
  APPSHA="$(jq -r '.sha256' "$STAGE/release-manifest.json")"
  APPURL="$(jq -r --arg a "$APPASSET" '.assets[] | select(.name==$a) | .url' "$STAGE/app-release.json")"
  [[ -n "$APPURL" ]] || die "Falta asset $APPASSET en v$APPVER."
  curl -fL "${HDR[@]}" -H "Accept: application/octet-stream" "$APPURL" -o "$STAGE/$APPASSET"
  [[ "$(sha256sum "$STAGE/$APPASSET" | awk '{print $1}')" == "$APPSHA" ]] || die "SHA256 de app v$APPVER invalido."
  mkdir -p "$STAGE/app"
  tar -xzf "$STAGE/$APPASSET" -C "$STAGE/app"
  [[ -f "$STAGE/app/package.json" && -f "$STAGE/app/src/server.js" ]] || die "App v$APPVER incompleta."
  (cd "$STAGE/app" && if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi)
fi

say "Creando respaldo local de seguridad antes de restaurar"
mkdir -p /opt/andon/pre-restore
pg_dump "$DATABASE_URL" -Fc -f "/opt/andon/pre-restore/pre-restore-$(date +%Y%m%d-%H%M%S).dump"

say "Restaurando PostgreSQL y aplicacion asociada"
systemctl stop "$SERVICE" || true
if [[ -d "$STAGE/app" ]]; then
  rm -rf /opt/andon/app.pre-restore
  [[ -d /opt/andon/app ]] && mv /opt/andon/app /opt/andon/app.pre-restore
  mv "$STAGE/app" /opt/andon/app
  printf '%s\n' "$APPVER" > /opt/andon/app/VERSION
  chown -R andon:andon /opt/andon/app
fi
# Limpia objetos del dump dentro de la misma DB y restaura.
pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" "$STAGE/andon-db.dump"
systemctl start "$SERVICE"
sleep 3
curl -fsS "http://127.0.0.1:${PORT:-3000}/api/build" >/dev/null || warn "Servicio iniciado pero /api/build no respondio."
ok "Restaurado $TAG."
