#!/usr/bin/env bash
# One-time setup of an Ubuntu 24.04 VM for DroneX (docs/DEPLOY.md, Phases 1 and 2). Safe to run again: every step
# checks before it changes anything, and existing files under /etc/dronex are never overwritten.
#
#   sudo DOMAIN=example.com REPO_URL=https://github.com/you/DroneX1.git SSH_FROM=203.0.113.7 deploy/provision.sh
#
#   DOMAIN     required: serves dronex.DOMAIN and sim.DOMAIN
#   REPO_URL   git URL deploy.sh clones (default: this checkout's origin). For a private repo use an ssh URL and
#              put a read-only deploy key at /var/lib/dronex/.ssh/id_ed25519 (owned by dronex).
#   BRANCH     default main
#   SSH_FROM   your IP (or CIDR) for SSH; without it SSH stays open to everyone (a warning is printed)
#
# Installs: build tools, ArduPilot SITL build deps, Node 24 (>= 24.11), Caddy (official repo), Rust (the Core
# toolchain) and uv for the dronex user; creates the dronex user, /opt/dronex, /var/lib/dronex, /etc/dronex;
# writes the env files from deploy/env.example with generated secrets; enables ufw with 22/80/443.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
DOMAIN=${DOMAIN:-}
BRANCH=${BRANCH:-main}
SSH_FROM=${SSH_FROM:-}
REPO_URL=${REPO_URL:-$(git -C "$ROOT" remote get-url origin 2>/dev/null || true)}
RUST_TOOLCHAIN=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$ROOT/dronex/DroneX_1/core/rust-toolchain.toml" 2>/dev/null || true)
RUST_TOOLCHAIN=${RUST_TOOLCHAIN:-stable}

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'provision: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -n "$DOMAIN" ] || die "set DOMAIN=example.com"
case "$DOMAIN" in *[!A-Za-z0-9.-]* | .* | *.) die "DOMAIN looks wrong: $DOMAIN" ;; esac
[ -n "$REPO_URL" ] || die "set REPO_URL (no git origin found)"
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || echo "provision: warning: tested on Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}" >&2

export DEBIAN_FRONTEND=noninteractive

say "apt packages"
apt-get update -q
apt-get install -y -q \
  git curl ca-certificates gnupg rsync jq sqlite3 ufw openssl \
  build-essential pkg-config cmake clang libssl-dev perl \
  python3 python3-venv python3-dev python3-pip libxml2-dev libxslt1-dev \
  g++ gawk make ccache libtool \
  ffmpeg sysstat \
  debian-keyring debian-archive-keyring apt-transport-https

say "Node.js 24"
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=11)?0:1)'; }
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q nodejs
fi
node_ok || die "need Node >= 24.11, have $(node --version 2>/dev/null || echo none)"

say "Caddy (official repository)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

say "dronex user and directories"
id dronex >/dev/null 2>&1 || adduser --system --group --home /var/lib/dronex --shell /usr/sbin/nologin dronex
install -d -o dronex -g dronex -m 0755 /opt/dronex /opt/dronex/releases
install -d -o dronex -g dronex -m 0750 /var/lib/dronex
for d in render-sim agents-logs agents-data spacetime next-cache build deploy; do
  install -d -o dronex -g dronex -m 0750 "/var/lib/dronex/$d"
done
install -d -o dronex -g dronex -m 0700 /var/lib/dronex/core /var/lib/dronex/core/simulators /var/lib/dronex/core/simulators/bin
install -d -o root -g dronex -m 0750 /etc/dronex
install -d -o root -g root -m 0700 /var/backups/dronex

as_dronex() { sudo -u dronex -H env HOME=/var/lib/dronex PATH="/var/lib/dronex/.cargo/bin:/var/lib/dronex/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

say "Rust $RUST_TOOLCHAIN for dronex"
if [ ! -x /var/lib/dronex/.cargo/bin/rustup ]; then
  as_dronex sh -c 'curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none'
fi
as_dronex rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal
as_dronex rustup default "$RUST_TOOLCHAIN"

say "uv for dronex"
if [ ! -x /var/lib/dronex/.local/bin/uv ]; then
  as_dronex sh -c 'curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh'
fi
as_dronex uv python install 3.11

say "env files in /etc/dronex (existing files are kept)"
# Splits deploy/env.example on its "### FILE: <path>" headers.
gen_hex() { openssl rand -hex 32; }
gen_b64() { openssl rand -base64 48 | tr -d '\n'; }
current=""
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "### FILE: "*) current=${line#"### FILE: "}; : > "$tmpdir/$(basename "$current")"; echo "$current" >> "$tmpdir/.list"; continue ;;
  esac
  [ -n "$current" ] || continue
  line=${line//@DOMAIN@/$DOMAIN}
  while [[ $line == *@HEX32@* ]]; do line=${line/@HEX32@/$(gen_hex)}; done
  while [[ $line == *@B64_48@* ]]; do line=${line/@B64_48@/$(gen_b64)}; done
  printf '%s\n' "$line" >> "$tmpdir/$(basename "$current")"
done < "$HERE/env.example"
while IFS= read -r path; do
  if [ -e "$path" ]; then
    echo "kept $path"
  else
    install -o root -g dronex -m 0640 "$tmpdir/$(basename "$path")" "$path"
    echo "wrote $path (fill in the empty values: sudo -e $path)"
  fi
done < "$tmpdir/.list"

cat > /etc/dronex/deploy.conf.new <<EOF
# Read by deploy/deploy.sh and deploy/check.sh.
DOMAIN=$DOMAIN
REPO_URL=$REPO_URL
BRANCH=$BRANCH
# Releases to keep under /opt/dronex/releases (the live one and the previous one are never removed).
KEEP_RELEASES=4
# Cargo features for the Core release build: empty means --no-default-features. If that build fails, use plugins.
CORE_FEATURES=
# ArduPilot vehicles built for SITL.
SITL_VEHICLES="copter plane"
EOF
if [ -e /etc/dronex/deploy.conf ]; then
  rm /etc/dronex/deploy.conf.new
  echo "kept /etc/dronex/deploy.conf"
else
  install -o root -g dronex -m 0640 /etc/dronex/deploy.conf.new /etc/dronex/deploy.conf
  rm /etc/dronex/deploy.conf.new
  echo "wrote /etc/dronex/deploy.conf"
fi

say "Core resource limits (systemd drop-in; set real values after sizing)"
dropin=/etc/systemd/system/dronex-core.service.d/limits.conf
if [ ! -e "$dropin" ]; then
  cores=$(nproc)
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  install -d /etc/systemd/system/dronex-core.service.d
  cat > "$dropin" <<EOF
# Caps the whole simulator fleet (Core and every SITL child). Defaults from provision.sh: 70% of $cores cores and
# 60% of ${mem_mb} MB. Re-derive after sizing (deploy/README.md), then: systemctl daemon-reload && systemctl restart dronex-core
[Service]
CPUQuota=$(( cores * 70 ))%
MemoryMax=$(( mem_mb * 60 / 100 ))M
TasksMax=4096
EOF
  echo "wrote $dropin"
else
  echo "kept $dropin"
fi

say "firewall (ufw): 22 from ${SSH_FROM:-anywhere}, 80, 443"
ufw default deny incoming
ufw default allow outgoing
if [ -n "$SSH_FROM" ]; then
  ufw allow from "$SSH_FROM" to any port 22 proto tcp
else
  echo "provision: warning: SSH_FROM not set, allowing 22/tcp from anywhere" >&2
  ufw allow 22/tcp
fi
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

say "done"
cat <<EOF
Next:
  1. Fill in the keys: sudo -e /etc/dronex/env /etc/dronex/backend.env /etc/dronex/mirror.env
  2. Point DNS for dronex.$DOMAIN and sim.$DOMAIN at this VM.
  3. sudo $HERE/deploy.sh
EOF
