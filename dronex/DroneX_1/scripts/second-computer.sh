#!/bin/sh
# A second Core daemon, as if on another computer, for trying sync and the
# account's computers: its own data folder and ports, the same backend.
# Run scripts/dev.sh first.
#
#   scripts/second-computer.sh     app on :45020, named "Field laptop"
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="$ROOT/.dev/core-data-2"
PORT=${CORE_PORT:-45020}
mkdir -p "$DATA"

UXDUCK_TERRAIN_KEY=RWSzgl9fdAptLFtOnN956tu/GY+/ANg5Of8nZVlOBgWsZTpGzJQbMyfP \
UXDUCK_SIM_CATALOGUE_KEY=RWSzgl9fdAptLFtOnN956tu/GY+/ANg5Of8nZVlOBgWsZTpGzJQbMyfP \
UXDUCK_DATA_DIR="$DATA" \
UXDUCK_DEVICE_NAME=${DEVICE_NAME:-Field laptop} \
UXDUCK_NO_TRAY=1 \
UXDUCK_INTERFACE_URL=none \
UXDUCK_API_URL="http://localhost:${BACKEND_PORT:-45103}" \
  exec "$ROOT/core/target/debug/uxduck" daemon --data-dir "$DATA" --port "$PORT" \
    --ui-dir "$ROOT/interface/$(cat "$ROOT/interface/current")" \
    --video-port "${VIDEO_PORT:-45021}" --no-update-check --no-analytics
