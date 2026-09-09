#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ENV="${BACKUP_ENV:-/etc/andon-backup/backup.env}"
UPDATER_ENV="${UPDATER_ENV:-/etc/andon-updater/updater.env}"
APP_ENV="/etc/andon/andon.env"
OUT="/opt/andon/disaster-backups"

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Ejecuta con sudo."
[[ -f "$APP_ENV" ]] || die "Falta $APP_ENV"
[[ -f "$UPDATER_ENV" ]] || die "Falta $UPDATER_ENV"
source "$APP_ENV"
source "$UPDATER_ENV"

if [[ -f "$BACKUP_ENV" ]]; then
  source "$BACKUP_ENV"
fi
BACKUP_TOKEN="${BACKUP_GITHUB_TOKEN:-}"
if [[ -z "$BACKUP_TOKEN" ]]; then
  read -r -s -p "Token GitHub READ/WRITE para backups en $GITHUB_OWNER/$GITHUB_REPO: " BACKUP_TOKEN </dev/tty
  printf '\n' >/dev/tty
  [[ -n "$BACKUP_TOKEN" ]] || die "Token vacio."
  mkdir -p "$(dirname "$BACKUP_ENV")"
  cat > "$BACKUP_ENV" <<EOF
BACKUP_GITHUB_TOKEN=$BACKUP_TOKEN
EOF
  chmod 600 "$BACKUP_ENV"
fi

mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TAG="backup-$STAMP"
WORK="$OUT/$TAG"
mkdir -p "$WORK"

say "Creando dump PostgreSQL"
pg_dump "$DATABASE_URL" -Fc -f "$WORK/andon-db.dump"
DBSHA="$(sha256sum "$WORK/andon-db.dump" | awk '{print $1}')"
APPVER="$(cat /opt/andon/app/VERSION 2>/dev/null || echo unknown)"

cat > "$WORK/backup-manifest.json" <<EOF
{
  "format": 1,
  "app": "ANDON",
  "backup_tag": "$TAG",
  "app_version": "$APPVER",
  "db_asset": "andon-db.dump",
  "db_sha256": "$DBSHA",
  "release_repo": "$GITHUB_OWNER/$GITHUB_REPO",
  "created_utc": "$(date -u +%FT%TZ)"
}
EOF

say "Publicando backup como Release"
GH_TOKEN="$BACKUP_TOKEN" gh release create "$TAG" \
  "$WORK/andon-db.dump" "$WORK/backup-manifest.json" \
  --repo "$GITHUB_OWNER/$GITHUB_REPO" \
  --title "ANDON Backup $STAMP" \
  --notes "Backup de desastre ANDON. App v$APPVER"

ok "Backup publicado: $TAG"
