#!/bin/bash
# Le Kiosque — nightly backup of what cannot be rebuilt (run by deploy/crontab).
#
#   accounts, sessions, follows, saved conversations   /data/auth.db
#   archive of the daily and weekly reports            /data/reports_archive.db
#   visitor statistics                                 Umami's PostgreSQL
#   secrets and keys                                   .env, .env.docker, .env.umami, credentials.json
#
# The articles (ChromaDB, data.json) are left out: the pipeline rebuilds them from
# the Google Sheets. Each night lands in ~/backups/lekiosque-YYYY-MM-DD.tar.gz,
# readable by ubuntu only; archives older than KEEP_DAYS are removed.

set -euo pipefail

KIOSQUE=/home/ubuntu/lekiosque
DEST=/home/ubuntu/backups
KEEP_DAYS=${KEEP_DAYS:-14}
DC="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --profile ollama"

cd "$KIOSQUE"
umask 077
mkdir -p "$DEST"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# SQLite through its backup API: a consistent copy even while the API writes
for db in auth.db reports_archive.db; do
  $DC exec -T api python -c "
import sqlite3, sys
src = sqlite3.connect('/data/$db'); dst = sqlite3.connect('/tmp/$db.bak')
src.backup(dst); dst.close(); src.close()"
  docker cp "$($DC ps -q api)":/tmp/$db.bak "$work/$db"
  $DC exec -T api rm -f /tmp/$db.bak
done

$DC exec -T umami-db pg_dump -U umami umami | gzip > "$work/umami.sql.gz"

cp .env .env.docker .env.umami credentials.json "$work/"

name="lekiosque-$(date +%F).tar.gz"
tar -czf "$DEST/$name" -C "$work" .
find "$DEST" -name 'lekiosque-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T')  $name  $(du -h "$DEST/$name" | cut -f1)"
