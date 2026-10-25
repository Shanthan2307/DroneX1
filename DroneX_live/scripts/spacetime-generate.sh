#!/bin/sh
# Regenerates the TypeScript bindings for the airspace module, into the live layer (the mirror sink) and the
# configurator (the /api/airspace routes and the Copilot page's airspace view). Run after changing the module.
#   DroneX_live/scripts/spacetime-generate.sh
set -eu
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
# The module pins Rust 1.98.1 (spacetime/rust-toolchain.toml); the CLI runs cargo from here, so pin it for it too.
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-1.98.1}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/src/spacetime/bindings"
spacetime generate --lang typescript --module-path "$ROOT/spacetime" --out-dir "$OUT" --yes
rm -rf "$ROOT/../DroneX_render/src/lib/airspace/bindings"
cp -R "$OUT" "$ROOT/../DroneX_render/src/lib/airspace/bindings"
echo "bindings written to $OUT and DroneX_render/src/lib/airspace/bindings"
