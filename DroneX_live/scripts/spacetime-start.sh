#!/bin/sh
# A local SpacetimeDB server for the shared airspace, on 127.0.0.1:3100 (port 3000 is the configurator).
#   DroneX_live/scripts/spacetime-start.sh
# First time: install the CLI with `curl -sSf https://install.spacetimedb.com | sh` (adds ~/.local/bin/spacetime).
set -eu
export PATH="$HOME/.local/bin:$PATH"
exec spacetime start --listen-addr "${SPACETIME_LISTEN:-127.0.0.1:3100}"
