#!/bin/sh
# Builds ArduPilot's native simulators (SITL) from ArduPilot's own source and
# installs them where the dev daemons look: .dev/core-data*/simulators/bin/.
# The same ArduPilot commit UXDuck builds from; no UXDuck catalogue needed.
#
#   scripts/build-sitl.sh                 rover and copter
#   scripts/build-sitl.sh rover plane sub
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PIN=${ARDUPILOT_COMMIT:-d5420ff97c843795e0aaf2ec72a06208f8e8d102}
WORK="$ROOT/.dev/ardupilot"
AP="$WORK/src"
[ $# -gt 0 ] || set -- rover copter

if [ ! -d "$AP/.git" ]; then
  mkdir -p "$WORK"
  git clone --filter=blob:none https://github.com/ArduPilot/ardupilot.git "$AP"
fi
git -C "$AP" fetch --quiet origin "$PIN" 2>/dev/null || true
git -C "$AP" checkout --quiet "$PIN"
git -C "$AP" submodule update --init --recursive --quiet

[ -f "$WORK/venv/bin/activate" ] || python3 -m venv "$WORK/venv"
. "$WORK/venv/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet empy==3.3.4 pexpect future lxml

cd "$AP"
# Xcode's linker refuses ArduPilot's packed version struct with chained fixups.
[ "$(uname)" = Darwin ] && export LDFLAGS="${LDFLAGS:-} -Wl,-no_fixup_chains"
./waf configure --board sitl --out build-sitl >/dev/null

for vehicle in "$@"; do
  case "$vehicle" in
    ardu* | blimp) program=$vehicle ;;
    *) program=ardu$vehicle ;;
  esac
  started=$(date +%s)
  ./waf build --out build-sitl --target "bin/$program"
  for data in "$ROOT"/.dev/core-data "$ROOT"/.dev/core-data-*; do
    [ -d "$data" ] || continue
    mkdir -p "$data/simulators/bin"
    cp "build-sitl/sitl/bin/$program" "$data/simulators/bin/"
  done
  echo "built $program in $(( $(date +%s) - started )) s"
done
