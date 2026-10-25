#!/bin/sh
# Runs the DroneX Dispatch agents: the fleet (one uAgent per hangar drone), the flight agent and the dispatcher.
# Needs the configurator (http://localhost:3000) and the simulation engine running (./dev.sh at the project root
# starts both and then this). Keys come from ../DroneX_render/.env.local (see .env.example there).
#
#   DroneX_agents/dev.sh            all three, logs in DroneX_agents/logs/
#   DroneX_agents/dev.sh fleet      one of fleet | flight | dispatcher in the foreground
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
PY="$HERE/.venv/bin/python"
[ -x "$PY" ] || { echo "no venv: uv venv --python python3.11 $HERE/.venv && uv pip install --python $PY -r $HERE/requirements.txt" >&2; exit 1; }
cd "$HERE"
case "${1:-all}" in
  fleet|flight|dispatcher) exec "$PY" -m "dronex_agents.$1" ;;
  all) exec "$PY" -m dronex_agents ;;
  *) echo "usage: $0 [all|fleet|flight|dispatcher]" >&2; exit 2 ;;
esac
