#!/usr/bin/env bash
# Builds and switches to a DroneX release (docs/DEPLOY.md, Phase 3 and "Operations"). Idempotent: deploying a
# commit that is already built only re-switches and restarts.
#
#   sudo deploy/deploy.sh                 deploy the tip of BRANCH (from /etc/dronex/deploy.conf)
#   sudo deploy/deploy.sh deploy <ref>    deploy a branch, tag or commit
#   sudo deploy/deploy.sh rollback [sha]  switch back to the previous release (or the given one) and restart
#   sudo deploy/deploy.sh status          current/previous release, units, releases on disk
#
# Layout: releases in /opt/dronex/releases/<sha12>, the live one at /opt/dronex/current, state in /var/lib/dronex,
# secrets in /etc/dronex, database snapshots in /var/backups/dronex. Build steps run as the dronex user.
#
# Settings come from /etc/dronex/deploy.conf (written by provision.sh); the environment overrides them:
#   DOMAIN REPO_URL BRANCH KEEP_RELEASES
#   CORE_FEATURES   cargo features on top of --no-default-features (e.g. "plugins" if the bare build fails)
#   SITL_VEHICLES   default "copter plane"
#   ARDUPILOT_COMMIT  override the pin in dronex/DroneX_1/scripts/build-sitl.sh
#   SKIP_TESTS=1    skip typecheck/lint/tests during the build (CI runs them)
#   SKIP_CHECK=1    skip the public checks (deploy/check.sh) after the switch
#   AUTO_ROLLBACK=0 do not switch back automatically when the post-deploy checks fail
set -euo pipefail

RELEASE_PUBLIC_KEY=RWSzgl9fdAptLFtOnN956tu/GY+/ANg5Of8nZVlOBgWsZTpGzJQbMyfP
UNITS=(dronex-backend dronex-core dronex-render dronex-mirror dronex-agents)
OPT=/opt/dronex
STATE=/var/lib/dronex
BUILD=$STATE/build
DEPLOYSTATE=$STATE/deploy
BACKUPS=/var/backups/dronex

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
warn() { printf 'deploy: warning: %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"

# Settings: environment first, then deploy.conf for whatever is unset.
for v in DOMAIN REPO_URL BRANCH KEEP_RELEASES CORE_FEATURES SITL_VEHICLES; do
  [ -n "${!v+x}" ] && declare "ENV_$v=${!v}"
done
# shellcheck disable=SC1091
[ -f /etc/dronex/deploy.conf ] && . /etc/dronex/deploy.conf
for v in DOMAIN REPO_URL BRANCH KEEP_RELEASES CORE_FEATURES SITL_VEHICLES; do
  e="ENV_$v"; [ -n "${!e+x}" ] && declare "$v=${!e}"
done
DOMAIN=${DOMAIN:-}
REPO_URL=${REPO_URL:-}
BRANCH=${BRANCH:-main}
KEEP_RELEASES=${KEEP_RELEASES:-4}
CORE_FEATURES=${CORE_FEATURES:-}
SITL_VEHICLES=${SITL_VEHICLES:-copter plane}
ARDUPILOT_COMMIT=${ARDUPILOT_COMMIT:-}
SKIP_TESTS=${SKIP_TESTS:-0}
SKIP_CHECK=${SKIP_CHECK:-0}
AUTO_ROLLBACK=${AUTO_ROLLBACK:-1}

as_dronex() {
  sudo -u dronex -H env HOME=$STATE \
    PATH="$STATE/.cargo/bin:$STATE/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

# The value of KEY in an env file (last assignment wins, as in systemd).
env_get() { awk -v k="$2" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$1"; }

current_release() { readlink -f "$OPT/current" 2>/dev/null || true; }
previous_release() { cat "$DEPLOYSTATE/previous" 2>/dev/null || true; }

preflight() {
  [ -n "$DOMAIN" ] || die "DOMAIN is not set (/etc/dronex/deploy.conf)"
  [ -n "$REPO_URL" ] || die "REPO_URL is not set (/etc/dronex/deploy.conf)"
  local f
  for f in /etc/dronex/env /etc/dronex/mirror.env /etc/dronex/backend.env /etc/dronex/core.env; do
    [ -f "$f" ] || die "$f is missing (run deploy/provision.sh)"
    if grep -nE '^[A-Za-z_][A-Za-z0-9_]*=.*[[:space:]]#' "$f" >/dev/null; then
      warn "$f has what looks like an inline comment; the '# ...' becomes part of the value:"
      grep -nE '^[A-Za-z_][A-Za-z0-9_]*=.*[[:space:]]#' "$f" | sed 's/=.*/=.../' >&2
    fi
  done
  local missing=() k
  for k in DRONEX_PUBLIC_URL DRONEX_SIM_UI_URL DRONEX_CORE_DATA_DIR DRONEX_AGENT_TOKEN DRONEX_COOKIE_SECRET \
           DRONEX_MAX_SIMS DRONEX_SIM_IDLE_MIN DRONEX_SIM_MAX_MIN SPACETIME_URI SPACETIME_DB \
           NEXT_PUBLIC_SPACETIME_URI NEXT_PUBLIC_SPACETIME_DB MIRROR_OPERATOR DRONEX_RENDER_URL \
           DRONEX_DISPATCHER_SEED DRONEX_FLEET_SEED DRONEX_FLIGHT_SEED; do
    [ -n "$(env_get /etc/dronex/env "$k")" ] || missing+=("env:$k")
  done
  for k in SESSION_SECRET ARCGIS_KEY GOOGLE_MAPS_KEY ARCGIS_GEOCODE_KEY DATABASE_PATH; do
    [ -n "$(env_get /etc/dronex/backend.env "$k")" ] || missing+=("backend.env:$k")
  done
  for k in DRONEX_SIM_ORIGIN DRONEX_SIM_PUBLIC_PORT DRONEX_SIM_MAX_AGE_MIN UXDUCK_API_URL; do
    [ -n "$(env_get /etc/dronex/core.env "$k")" ] || missing+=("core.env:$k")
  done
  [ ${#missing[@]} -eq 0 ] || die "empty settings: ${missing[*]}"
  for k in CARTESIA_API_KEY CARTESIA_VOICE_ID INTENT_API_KEY ELASTIC_URL ELASTIC_API_KEY SPACETIME_TOKEN; do
    [ -n "$(env_get /etc/dronex/env "$k")" ] || warn "env:$k is empty; that feature will be unavailable"
  done
  [ -n "$(env_get /etc/dronex/mirror.env ELASTIC_API_KEY)" ] || warn "mirror.env:ELASTIC_API_KEY (writer) is empty"

  local want_pub="https://dronex.$DOMAIN" want_sim="https://sim.$DOMAIN"
  [ "$(env_get /etc/dronex/env DRONEX_PUBLIC_URL)" = "$want_pub" ] || die "env:DRONEX_PUBLIC_URL must be $want_pub"
  [ "$(env_get /etc/dronex/env DRONEX_SIM_UI_URL)" = "$want_sim" ] || die "env:DRONEX_SIM_UI_URL must be $want_sim"
  [ "$(env_get /etc/dronex/core.env DRONEX_SIM_ORIGIN)" = "$want_sim" ] || die "core.env:DRONEX_SIM_ORIGIN must be $want_sim"
  case "$(env_get /etc/dronex/env NEXT_PUBLIC_SPACETIME_URI)" in wss://*) ;; *) die "env:NEXT_PUBLIC_SPACETIME_URI must start with wss://" ;; esac
  local max; max=$(env_get /etc/dronex/env DRONEX_MAX_SIMS)
  [[ $max =~ ^[0-9]+$ ]] && [ "$max" -ge 1 ] && [ "$max" -lt 32 ] || die "env:DRONEX_MAX_SIMS must be 1..31 (got $max)"
  [ "$(env_get /etc/dronex/env DRONEX_PAYMENTS)" = 1 ] && warn "DRONEX_PAYMENTS=1: docs/DEPLOY.md item 26 says run live with payments off"
  [ "$(env_get /etc/dronex/env DRONEX_DISPATCHER_SEED)" != "$(env_get /etc/dronex/env DRONEX_FLEET_SEED)" ] || die "agent seeds must differ"
  command -v caddy >/dev/null || die "caddy is not installed (run deploy/provision.sh)"
  [ -x $STATE/.cargo/bin/cargo ] || die "no cargo for dronex (run deploy/provision.sh)"
  [ -x $STATE/.local/bin/uv ] || die "no uv for dronex (run deploy/provision.sh)"
}

# A bare mirror of the repo that every release is cloned from (fast, local, hardlinked).
resolve_sha() {
  local ref=$1 cache=$BUILD/repo.git
  if [ -d "$cache" ]; then
    as_dronex git -C "$cache" remote set-url origin "$REPO_URL"
    as_dronex git -C "$cache" fetch --quiet --prune origin
  else
    as_dronex git clone --quiet --mirror "$REPO_URL" "$cache"
  fi
  as_dronex git -C "$cache" rev-parse --verify --quiet "$ref^{commit}" || die "unknown ref: $ref"
}

build_release() {
  local sha=$1 short=${1:0:12} r=$OPT/releases/${1:0:12}
  if [ -f "$r/.dronex-release" ] && [ "$(cut -d' ' -f1 "$r/.dronex-release")" = "$sha" ]; then
    say "release $short is already built"
    return
  fi
  say "building release $short in $r"
  rm -rf "$r"
  # The build script goes to a file, not stdin, so npm/cargo/git cannot read the rest of it.
  local script
  script=$(mktemp /tmp/dronex-build.XXXXXX)
  chmod 0644 "$script"
  build_script > "$script"
  if ! as_dronex env R="$r" SHA="$sha" SHORT="$short" DOMAIN="$DOMAIN" CACHE="$BUILD/repo.git" STATE="$STATE" \
    BUILD="$BUILD" KEY="$RELEASE_PUBLIC_KEY" CORE_FEATURES="$CORE_FEATURES" SITL_VEHICLES="$SITL_VEHICLES" \
    ARDUPILOT_COMMIT="$ARDUPILOT_COMMIT" SKIP_TESTS="$SKIP_TESTS" bash "$script" < /dev/null; then
    rm -f "$script"
    die "build of $short failed (the partial release stays in $r; the next deploy rebuilds it)"
  fi
  rm -f "$script"
}

# Phase 3 of docs/DEPLOY.md, run as dronex with the variables build_release passes.
build_script() {
  cat <<'BUILD'
#!/usr/bin/env bash
set -euo pipefail
step() { printf '\n--> %s\n' "$*"; }
fail() { printf 'build: %s\n' "$*" >&2; exit 1; }
# Exports plain KEY=VALUE lines literally (no shell expansion), skipping comments, like systemd's EnvironmentFile.
load_env() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    [[ $line =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    export "${line?}"
  done < "$1"
}
SIM="https://sim.$DOMAIN"
PUB="https://dronex.$DOMAIN"

step "checkout $SHA"
git clone --quiet --no-checkout "$CACHE" "$R"
git -C "$R" checkout --quiet --detach "$SHA"

step "state symlinks (docs/DEPLOY.md item 29)"
rm -rf "$R/DroneX_render/.dronex" "$R/DroneX_agents/logs" "$R/DroneX_render/.env.local"
ln -s "$STATE/render-sim" "$R/DroneX_render/.dronex"
ln -s "$STATE/agents-logs" "$R/DroneX_agents/logs"
ln -s /etc/dronex/env "$R/DroneX_render/.env.local"

step "Core release build"
cd "$R/dronex/DroneX_1/core"
features=(--no-default-features)
[ -z "$CORE_FEATURES" ] || features+=(--features "$CORE_FEATURES")
CARGO_TARGET_DIR="$BUILD/cargo-target" UXDUCK_RELEASE_PUBLIC_KEY="$KEY" \
  cargo build --release --locked -p uxduck "${features[@]}"
install -D -m 0755 "$BUILD/cargo-target/release/uxduck" "$R/bin/uxduck"
"$R/bin/uxduck" --version || true
daemon_help=$("$R/bin/uxduck" daemon --help)
for flag in --public-origin --public-port --sim-max-age; do
  grep -qF -- "$flag" <<< "$daemon_help" || fail "this Core build has no $flag (public guest mode not merged?)"
done

step "ArduPilot SITL ($SITL_VEHICLES)"
cd "$R/dronex/DroneX_1"
pin=${ARDUPILOT_COMMIT:-$(sed -n 's/^PIN=\${ARDUPILOT_COMMIT:-\([0-9a-f]*\)}.*/\1/p' scripts/build-sitl.sh)}
[ -n "$pin" ] || fail "could not read the ArduPilot pin from scripts/build-sitl.sh"
bin="$STATE/core/simulators/bin"
stamp="$bin/.dronex-sitl"
programs=()
for v in $SITL_VEHICLES; do
  case "$v" in ardu* | blimp) programs+=("$v") ;; *) programs+=("ardu$v") ;; esac
done
need=0
[ "$(cat "$stamp" 2>/dev/null)" = "$pin $SITL_VEHICLES" ] || need=1
for p in "${programs[@]}"; do [ -x "$bin/$p" ] || need=1; done
if [ "$need" = 1 ]; then
  # Keep the ArduPilot checkout and its waf build between releases.
  mkdir -p "$BUILD/sitl-dev"
  rm -rf .dev && ln -s "$BUILD/sitl-dev" .dev
  # shellcheck disable=SC2086
  ARDUPILOT_COMMIT="$pin" sh scripts/build-sitl.sh $SITL_VEHICLES
  mkdir -p "$bin"
  for p in "${programs[@]}"; do
    # Copy then rename, so a running simulator keeps its old file.
    install -m 0755 ".dev/ardupilot/src/build-sitl/sitl/bin/$p" "$bin/.$p.new"
    mv -f "$bin/.$p.new" "$bin/$p"
  done
  echo "$pin $SITL_VEHICLES" > "$stamp"
else
  echo "SITL already built for $pin ($SITL_VEHICLES)"
fi

step "interface pointed at $SIM (items 8 and 9)"
node scripts/point-interface.mjs --from http://localhost:45103 "$SIM"
node scripts/patch-interface-dronex.mjs
node scripts/patch-interface-tracks.mjs
node scripts/set-render-url.mjs "$PUB"
V=$(cat interface/current)
! grep -rqF 'localhost:45103' "interface/$V" || fail "interface still points at localhost:45103"
grep -rqF "\`$SIM\`" "interface/$V/assets" || fail "interface does not contain $SIM"
grep -qF "window.DRONEX_RENDER_URL='$PUB'" "interface/$V/index.html" || fail "DRONEX_RENDER_URL not in index.html"
ln -sfn "$R/dronex/DroneX_1/interface/$V" "$R/ui"

step "backend"
cd "$R/dronex/DroneX_1/backend"
npm ci --omit=dev --no-audit --no-fund
[ "$SKIP_TESTS" = 1 ] || node --test test/*.test.ts

step "configurator (public values from /etc/dronex/env baked in at build time)"
cd "$R/DroneX_render"
npm ci --no-audit --no-fund
if [ "$SKIP_TESTS" != 1 ]; then
  npm run typecheck
  npm run lint
  npm test
fi
( load_env /etc/dronex/env; NEXT_TELEMETRY_DISABLED=1 npm run build )
grep -rqF "$SIM" .next/server/app || fail "the simulator URL $SIM is not baked into .next/server/app"
node prototype/drone-assembly/scripts/check-drone-physics.mjs > /dev/null || fail "physics check failed"
# next start writes .next/cache; keep it in /var/lib/dronex (ProtectSystem=strict).
rm -rf "$STATE/next-cache/$SHORT"
if [ -d .next/cache ]; then mv .next/cache "$STATE/next-cache/$SHORT"; else mkdir -p "$STATE/next-cache/$SHORT"; fi
ln -s "$STATE/next-cache/$SHORT" .next/cache

step "live layer"
cd "$R/DroneX_live"
npm ci --omit=dev --no-audit --no-fund
[ "$SKIP_TESTS" = 1 ] || npm run typecheck

step "agents"
cd "$R/DroneX_agents"
uv venv --quiet --python 3.11 .venv
uv pip install --quiet --python .venv/bin/python -r requirements.txt
[ "$SKIP_TESTS" = 1 ] || .venv/bin/python -m pytest -q

echo "$SHA $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$R/.dronex-release"
step "release $SHORT built"
BUILD
}

# Units and Caddyfile come from the release being switched to, so they always match its code.
install_system_files() {
  local r=$1 changed=0 u
  for u in "${UNITS[@]}"; do
    if ! cmp -s "$r/deploy/systemd/$u.service" "/etc/systemd/system/$u.service"; then
      install -m 0644 "$r/deploy/systemd/$u.service" "/etc/systemd/system/$u.service"
      changed=1
    fi
  done
  [ "$changed" = 0 ] || echo "systemd units updated"
  systemctl daemon-reload
  systemctl enable "${UNITS[@]}" >/dev/null 2>&1

  local tmp=/etc/caddy/Caddyfile.dronex-new
  sed "s/\.DOMAIN\b/.$DOMAIN/g" "$r/deploy/Caddyfile" > "$tmp"
  caddy validate --adapter caddyfile --config "$tmp" >/dev/null || { rm -f "$tmp"; die "the new Caddyfile does not validate"; }
  if ! cmp -s "$tmp" /etc/caddy/Caddyfile; then
    mv -f "$tmp" /etc/caddy/Caddyfile
    systemctl enable caddy >/dev/null 2>&1
    if systemctl is-active --quiet caddy; then systemctl reload caddy; else systemctl start caddy; fi
    echo "Caddyfile updated"
  else
    rm -f "$tmp"
    systemctl is-active --quiet caddy || systemctl start caddy
  fi
}

backup_databases() {
  local tag=$1 ts db name
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  install -d -m 0700 "$BACKUPS"
  for db in "$(env_get /etc/dronex/backend.env DATABASE_PATH)" "$STATE/core/uxduck.db"; do
    [ -n "$db" ] && [ -f "$db" ] || continue
    name=$(basename "$db" .db)
    sqlite3 "$db" ".backup '$BACKUPS/$name-$tag-$ts.db'"
    echo "snapshot: $BACKUPS/$name-$tag-$ts.db"
  done
  # Keep the newest 30 snapshots.
  find "$BACKUPS" -maxdepth 1 -name '*.db' -printf '%T@ %p\n' | sort -rn | tail -n +31 | cut -d' ' -f2- | xargs -r rm -f
}

# uagents keeps <agent>_data.json in DroneX_agents; keep them in /var/lib/dronex/agents-data across releases.
carry_agent_data() {
  local from=$1 to=$2 f
  if [ -n "$from" ] && [ -d "$from/DroneX_agents" ]; then
    for f in "$from"/DroneX_agents/*_data.json; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      mv -f "$f" "$STATE/agents-data/"
      ln -s "$STATE/agents-data/$(basename "$f")" "$f"
    done
  fi
  for f in "$STATE"/agents-data/*_data.json; do
    [ -f "$f" ] || continue
    ln -sfn "$f" "$to/DroneX_agents/$(basename "$f")"
  done
  chown -h dronex:dronex "$STATE"/agents-data/* "$to"/DroneX_agents/*_data.json 2>/dev/null || true
}

wait_http() {
  local url=$1 secs=${2:-90} i
  for ((i = 0; i < secs; i += 2)); do
    curl -fsS -o /dev/null --max-time 5 "$url" && return 0
    sleep 2
  done
  return 1
}

restart_units() {
  say "restarting units (running sims stop)"
  systemctl restart dronex-backend dronex-core
  wait_http http://127.0.0.1:45103/health 60 || warn "backend not answering on 127.0.0.1:45103"
  systemctl restart dronex-render
  wait_http http://127.0.0.1:3000/api/tracks 120 || warn "configurator not answering on 127.0.0.1:3000"
  systemctl restart dronex-mirror dronex-agents
}

smoke() {
  say "smoke checks"
  local ok=0 u
  sleep 5
  for u in "${UNITS[@]}"; do
    if systemctl is-active --quiet "$u"; then echo "ok   $u active"; else echo "FAIL $u is $(systemctl is-active "$u")"; ok=1; fi
  done
  if curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:45103/health; then echo "ok   backend /health"; else echo "FAIL backend /health"; ok=1; fi
  if curl -fsS -o /dev/null --max-time 10 http://127.0.0.1:3000/api/tracks; then echo "ok   configurator /api/tracks"; else echo "FAIL configurator /api/tracks"; ok=1; fi
  if [ "$SKIP_CHECK" != 1 ] && [ $ok = 0 ]; then
    bash "$OPT/current/deploy/check.sh" --local --no-rate "$DOMAIN" || ok=1
  fi
  return $ok
}

switch_to() {
  local target=$1 from
  from=$(current_release)
  [ -f "$target/.dronex-release" ] || die "$target is not a finished release"
  install_system_files "$target"
  systemctl stop dronex-agents 2>/dev/null || true
  carry_agent_data "$from" "$target"
  ln -sfn "$target" "$OPT/current.new"
  mv -T "$OPT/current.new" "$OPT/current"
  if [ -n "$from" ] && [ "$from" != "$target" ]; then echo "$from" > "$DEPLOYSTATE/previous"; fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $(basename "$target") $(cut -d' ' -f1 "$target/.dronex-release")" >> "$DEPLOYSTATE/history"
  echo "current -> $target"
  restart_units
}

prune_releases() {
  local cur prev keep=0 d
  cur=$(current_release); prev=$(previous_release)
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ "$d" = "$cur" ] || [ "$d" = "$prev" ]; then continue; fi
    keep=$((keep + 1))
    [ "$keep" -le $((KEEP_RELEASES > 2 ? KEEP_RELEASES - 2 : 0)) ] && continue
    echo "removing old release $d"
    rm -rf "$d" "$STATE/next-cache/$(basename "$d")"
  done < <(find "$OPT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

cmd_deploy() {
  local ref=${1:-$BRANCH} sha prev r
  preflight
  say "resolving $ref from $REPO_URL"
  sha=$(resolve_sha "$ref")
  r=$OPT/releases/${sha:0:12}
  build_release "$sha"
  prev=$(current_release)
  say "database snapshots"
  backup_databases "before-${sha:0:12}"
  say "switching"
  switch_to "$r"
  if smoke; then
    prune_releases
    say "deployed ${sha:0:12} to https://dronex.$DOMAIN and https://sim.$DOMAIN"
  else
    if [ "$AUTO_ROLLBACK" = 1 ] && [ -n "$prev" ] && [ "$prev" != "$r" ] && [ -d "$prev" ]; then
      warn "post-deploy checks failed; rolling back to $prev"
      switch_to "$prev"
      smoke || true
    fi
    die "post-deploy checks failed for ${sha:0:12} (journalctl -u dronex-core -u dronex-render -n 100)"
  fi
}

cmd_rollback() {
  local target
  if [ -n "${1:-}" ]; then target=$OPT/releases/${1:0:12}; else target=$(previous_release); fi
  [ -n "$target" ] && [ -d "$target" ] || die "no release to roll back to (have: $(ls "$OPT/releases" | tr '\n' ' '))"
  [ "$target" != "$(current_release)" ] || die "$target is already current"
  say "rolling back to $target"
  backup_databases "rollback-$(basename "$target")"
  switch_to "$target"
  smoke || die "checks failed after rollback"
  local latest
  latest=$(ls -t "$BACKUPS"/backend-before-*.db 2>/dev/null | head -1 || true)
  cat <<EOF

Rolled back. If the newer release changed a database schema, restore its pre-deploy snapshot:
  systemctl stop dronex-backend && cp ${latest:-$BACKUPS/backend-before-<sha>-<time>.db} $(env_get /etc/dronex/backend.env DATABASE_PATH) && chown dronex:dronex $(env_get /etc/dronex/backend.env DATABASE_PATH) && systemctl start dronex-backend
SpacetimeDB modules do not roll back with the code.
EOF
}

cmd_status() {
  echo "domain:   ${DOMAIN:-?}"
  echo "current:  $(current_release) ($(cat "$(current_release)/.dronex-release" 2>/dev/null || echo '?'))"
  echo "previous: $(previous_release)"
  echo "releases:"; ls -1t "$OPT/releases" 2>/dev/null | sed 's/^/  /'
  echo "units:"; for u in "${UNITS[@]}" caddy; do printf '  %-16s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"; done
  echo "last deploys:"; tail -n 5 "$DEPLOYSTATE/history" 2>/dev/null | sed 's/^/  /'
}

install -d -o dronex -g dronex -m 0750 "$DEPLOYSTATE" "$BUILD" "$STATE/agents-data" "$STATE/next-cache"
exec 9> "$DEPLOYSTATE/lock"
flock -n 9 || die "another deploy is running"

case "${1:-deploy}" in
  deploy) shift || true; cmd_deploy "$@" ;;
  rollback) shift; cmd_rollback "$@" ;;
  status) cmd_status ;;
  -h | --help | help) sed -n '2,22p' "$0" ;;
  *) die "unknown command: $1 (deploy | rollback | status)" ;;
esac
