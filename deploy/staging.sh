#!/bin/sh
# Le Kiosque — the private staging copy, on the server, in ~/lekiosque-staging.
#
#   From the Mac, send the code of the working folder (tracked files only):
#     deploy/staging.sh send
#   Then on the server (ssh ubuntu@187.126.9.83 lekiosque-staging/src/deploy/staging.sh …):
#     password   choose the access password (asked twice, never displayed)
#     refresh    copy the live articles and editions; accounts stay separate
#     up         build and start
#     down       stop: it then uses no memory
#     status     show what runs
set -eu

SERVER=ubuntu@187.126.9.83
ROOT="$HOME/lekiosque-staging"
LIVE="$HOME/lekiosque"
LOCK=/tmp/lekiosque-pipeline.lock
# Uid of the app inside its image: the copies must be writable by it
APP_UID=10001

dc() { docker compose --project-directory "$ROOT" -f "$ROOT/src/deploy/docker-compose.staging.yml" "$@"; }

# The live nginx settings, with the staging API, a password and a visible mark
write_nginx() {
  sed -e 's/server api:8000;/server staging-api:8000;/' \
      -e 's/^    server_name _;/    server_name _;\n    auth_basic "Le Kiosque staging";\n    auth_basic_user_file \/etc\/nginx\/htpasswd;\n    sub_filter_once on;\n    sub_filter "<\/head>" "<style>body::after{content:\\"STAGING\\";position:fixed;z-index:9999;left:8px;bottom:8px;padding:3px 8px;border-radius:6px;background:#b45309;color:#fff;font:700 11px sans-serif;letter-spacing:.08em;pointer-events:none}<\/style><\/head>";/' \
      "$ROOT/src/frontend/nginx.conf" > "$ROOT/nginx.conf"
  grep -q 'server staging-api:8000;' "$ROOT/nginx.conf" && grep -q 'auth_basic_user_file' "$ROOT/nginx.conf" \
    || { echo "nginx settings not as expected: nothing started" >&2; exit 1; }
}

# Only the keys it needs, read from the live settings and never displayed
write_env() {
  ( umask 077; grep -E '^(LLM_[A-Z_]*|GEMINI_API_KEY|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)=' "$LIVE/.env.docker" > "$ROOT/.env.staging" )
}

case "${1:-}" in
  send)
    cd "$(git rev-parse --show-toplevel)"
    ssh "$SERVER" 'mkdir -p ~/lekiosque-staging && rm -rf ~/lekiosque-staging/src && mkdir ~/lekiosque-staging/src'
    git ls-files -c -- . ':!docs' ':!ios' | COPYFILE_DISABLE=1 tar -czf - -T - | ssh "$SERVER" 'tar -xzf - -C ~/lekiosque-staging/src --warning=no-unknown-keyword'
    echo "code sent"
    ;;
  password)
    hash=$(openssl passwd -apr1)
    printf 'vhiny:%s\n' "$hash" > "$ROOT/htpasswd"
    echo "password saved (user: vhiny)"
    ;;
  refresh)
    # Under the collection's lock, so the copy is not taken mid-write
    flock -w 1500 "$LOCK" docker run --rm --user 0 --entrypoint sh \
      -v "$LIVE/newspaper_chroma_db:/live/news:ro" -v "$LIVE/codes_chroma_db:/live/codes:ro" \
      -v "$LIVE/frontend/public/data.json:/live/data.json:ro" -v lekiosque_kiosque-data:/live/data:ro \
      -v "$ROOT:/s" lekiosque-api:latest -c "
        rm -rf /s/newspaper_chroma_db /s/codes_chroma_db &&
        cp -a /live/news /s/newspaper_chroma_db && cp -a /live/codes /s/codes_chroma_db &&
        cp /live/data.json /s/data.json && mkdir -p /s/data && cp /live/data/reports_archive.db /s/data/ &&
        chown -R $APP_UID /s/newspaper_chroma_db /s/codes_chroma_db /s/data"
    echo "articles and editions copied"
    ;;
  up)
    [ -s "$ROOT/htpasswd" ] || { echo "no password yet: run 'password' first" >&2; exit 1; }
    [ -f "$ROOT/data.json" ] || { echo "no articles yet: run 'refresh' first" >&2; exit 1; }
    write_env
    write_nginx
    flock -w 1500 "$LOCK" docker compose --project-directory "$ROOT" -f "$ROOT/src/deploy/docker-compose.staging.yml" up -d --build --quiet-pull
    dc ps --format '{{.Service}} {{.Status}}'
    ;;
  down)
    dc down
    ;;
  status)
    dc ps --format '{{.Service}} {{.Status}}'
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 1
    ;;
esac
