#!/bin/sh
# Runs the whole DroneX project:
#   simulation engine   dronex/DroneX_1: account backend, Core daemon and its web UI      http://127.0.0.1:45010
#   rendering engine    DroneX_render: the Next.js configurator and the Copilot page      http://localhost:3000
#   live layer          DroneX_live: the mirror feeding the SpacetimeDB airspace and the Elastic flight index
#   agents              DroneX_agents: the Fetch.ai Dispatch agents (dispatcher, fleet, flight) on ASI:One
#
#   ./dev.sh                 everything; pieces whose keys are missing say so and stay off
#   NO_AGENTS=1 ./dev.sh     without the Fetch.ai agents
#   NO_LIVE=1 ./dev.sh       without the mirror
#
# First time: the simulation engine needs Rust and Node 24.11+, and `cd dronex/DroneX_1/backend && npm install`;
# the configurator `cd DroneX_render && npm install`; the live layer `cd DroneX_live && npm install`; the agents a
# Python 3.11 venv at DroneX_agents/.venv (see DroneX_agents/README.md). Keys go in DroneX_render/.env.local (copy
# .env.example); every other process reads that same file. The simulation UI is patched once for DroneX models
# and for the "Built with" badge (both idempotent, so they run here too). SpacetimeDB: `spacetime start` is
# launched here when the CLI is installed and SPACETIME_URI points at 127.0.0.1 (see DroneX_live/README.md).
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
SIM="$ROOT/dronex/DroneX_1"
DATA="$SIM/.dev/core-data"
export DRONEX_CORE_DATA_DIR="$DATA"

node "$SIM/scripts/patch-interface-dronex.mjs"
node "$SIM/scripts/patch-interface-tracks.mjs"

PIDS=""
cleanup() { [ -n "$PIDS" ] && kill $PIDS 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# A key from DroneX_render/.env.local, or empty.
envkey() { sed -n "s/^$1=//p" "$ROOT/DroneX_render/.env.local" 2>/dev/null | head -1; }

"$SIM/scripts/dev.sh" &
PIDS="$PIDS $!"

(cd "$ROOT/DroneX_render" && npm run dev) &
PIDS="$PIDS $!"

# SpacetimeDB standalone server for the shared airspace, when the CLI is here and the URI is local.
SPACETIME_URI=$(envkey SPACETIME_URI)
if command -v spacetime >/dev/null 2>&1 && printf '%s' "$SPACETIME_URI" | grep -q '127\.0\.0\.1\|localhost'; then
  PORT=$(printf '%s' "$SPACETIME_URI" | sed -n 's/.*:\([0-9][0-9]*\).*/\1/p')
  spacetime start --listen-addr "127.0.0.1:${PORT:-3100}" &
  PIDS="$PIDS $!"
  echo "spacetime: standalone server on 127.0.0.1:${PORT:-3100}"
elif [ -n "$SPACETIME_URI" ]; then
  echo "spacetime: using $SPACETIME_URI (CLI not installed or remote)"
fi

# The mirror waits for the daemon's socket, then follows every vehicle.
if [ -z "${NO_LIVE:-}" ]; then
  (
    for i in $(seq 1 90); do [ -S "$DATA/uxduck.sock" ] && break; sleep 2; done
    sleep 3
    cd "$ROOT/DroneX_live" && exec npm run --silent mirror
  ) &
  PIDS="$PIDS $!"
fi

# The Fetch.ai agents wait for the configurator, then come up and print their Agentverse inspector links.
if [ -z "${NO_AGENTS:-}" ] && [ -x "$ROOT/DroneX_agents/dev.sh" ]; then
  (
    for i in $(seq 1 90); do curl -sf -o /dev/null http://localhost:3000/api/tracks && break; sleep 2; done
    exec "$ROOT/DroneX_agents/dev.sh"
  ) &
  PIDS="$PIDS $!"
fi

echo "configurator: http://localhost:3000   copilot: http://localhost:3000/copilot   simulation: http://127.0.0.1:${CORE_PORT:-45010}/"
wait
