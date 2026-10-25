#!/bin/sh
# Builds the airspace module (Rust → wasm) and publishes it as `dronex-airspace` to the local server (default) or
# to the server named in SPACETIME_SERVER (e.g. maincloud, after `spacetime login`).
#   DroneX_live/scripts/spacetime-publish.sh            # local, http://127.0.0.1:3100
#   SPACETIME_SERVER=maincloud DroneX_live/scripts/spacetime-publish.sh
set -eu
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
# The module pins Rust 1.98.1 (spacetime/rust-toolchain.toml); the CLI runs cargo from here, so pin it for it too.
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.98.1}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SERVER=${SPACETIME_SERVER:-http://127.0.0.1:3100}
DB=${SPACETIME_DB:-dronex-airspace}
spacetime publish --module-path "$ROOT/spacetime" --server "$SERVER" --yes "$DB" "$@"
