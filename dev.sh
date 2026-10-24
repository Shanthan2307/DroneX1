#!/bin/sh
# Runs the whole DroneX project: the simulation engine (dronex/DroneX_1: account backend, Core daemon and its web
# UI) and the rendering engine (DroneX_render: the Next.js configurator). Open the configurator, build a drone,
# press "Fly in simulation": the drone is sent to the simulation engine and the browser moves there.
#
#   ./dev.sh                 configurator on http://localhost:3000, simulation on http://127.0.0.1:45010
#
# First time: the simulation engine needs Rust and Node 24.11+, and `cd dronex/DroneX_1/backend && npm install`;
# the configurator needs `cd DroneX_render && npm install`. The simulation UI must be patched once for DroneX
# models: `node dronex/DroneX_1/scripts/patch-interface-dronex.mjs` (it is idempotent, so it runs here too).
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
SIM="$ROOT/dronex/DroneX_1"

node "$SIM/scripts/patch-interface-dronex.mjs"

cleanup() { kill "$SIM_PID" "$RENDER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

"$SIM/scripts/dev.sh" &
SIM_PID=$!

(cd "$ROOT/DroneX_render" && DRONEX_CORE_DATA_DIR="$SIM/.dev/core-data" npm run dev) &
RENDER_PID=$!

echo "configurator: http://localhost:3000   simulation: http://127.0.0.1:${CORE_PORT:-45010}/"
wait
