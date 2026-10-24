#!/bin/sh
# Runs the whole app locally: the backend, and a debug Core daemon serving the
# interface in interface/, with its own data folder in .dev/ so it never
# touches an installed UXDuck (~/.uxduck, port 45000).
#
#   scripts/dev.sh            backend on :45103, Core + UI on :45010
#   CORE_PORT=45020 scripts/dev.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV="$ROOT/.dev"
DATA="$DEV/core-data"
BACKEND_PORT=${BACKEND_PORT:-45103}
CORE_PORT=${CORE_PORT:-45010}
VIDEO_PORT=${VIDEO_PORT:-45011}
# UXDuck's public release key (minisign), built into the released app. Debug
# builds have none, so without it they cannot check the signed terrain and
# simulator catalogue that terrain.uxduck.com and simulators.uxduck.com publish.
RELEASE_KEY=RWSzgl9fdAptLFtOnN956tu/GY+/ANg5Of8nZVlOBgWsZTpGzJQbMyfP
UI_DIR="$ROOT/interface/$(cat "$ROOT/interface/current")"
mkdir -p "$DATA"

# A session secret kept between runs.
[ -f "$DEV/session-secret" ] || openssl rand -base64 48 > "$DEV/session-secret"

(cd "$ROOT/core" && cargo build --locked -p uxduck)

cleanup() { kill "$BACKEND_PID" "$CORE_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

(cd "$ROOT/backend" && \
  PORT=$BACKEND_PORT DATABASE_PATH="$DEV/backend.db" SESSION_SECRET=$(cat "$DEV/session-secret") \
  node --env-file-if-exists=.env src/server.ts) &
BACKEND_PID=$!

UXDUCK_TERRAIN_KEY=$RELEASE_KEY \
UXDUCK_SIM_CATALOGUE_KEY=$RELEASE_KEY \
UXDUCK_DATA_DIR="$DATA" \
UXDUCK_PORT=$CORE_PORT \
UXDUCK_NO_TRAY=1 \
UXDUCK_NO_ANALYTICS=1 \
UXDUCK_INTERFACE_URL=none \
UXDUCK_API_URL="http://localhost:$BACKEND_PORT" \
  "$ROOT/core/target/debug/uxduck" daemon --data-dir "$DATA" --port "$CORE_PORT" \
    --ui-dir "$UI_DIR" --video-port "$VIDEO_PORT" --no-update-check --no-analytics &
CORE_PID=$!

echo "backend: http://localhost:$BACKEND_PORT   app: http://127.0.0.1:$CORE_PORT/"
wait
