#!/usr/bin/env bash
# Automated first-run / verification checks for a live DroneX (docs/DEPLOY.md, Phase 10 and the security part of
# the verification checklist). Run it from your laptop (outside the VM) for the firewall checks; deploy.sh also runs
# it on the VM with --local after every switch.
#
#   deploy/check.sh example.com                 public checks from outside, including a port scan and the 429 test
#   deploy/check.sh --ip 203.0.113.10 example.com   scan this address instead of what sim.DOMAIN resolves to
#   deploy/check.sh --no-rate example.com       skip the rate-limit test (it leaves your IP limited for a minute)
#   deploy/check.sh --local example.com         on the VM: public checks plus units, listeners and loopback auth
#
# Not automated (do these by hand, see docs/DEPLOY.md "Verification checklist"): the browser demo, guest RPC denials
# over /rpc (smoke.rs guest test + a devtools WebSocket test), a guest token on the loopback listener, visitor B
# commanding visitor A's vehicle, SpacetimeDB anonymous writes, idle-sim reaping, hostname leaks.
#
# Exit status: 0 when every check passes, 1 otherwise. Needs bash and curl.
set -uo pipefail

LOCAL=0
RATE=1
IP=""
DOMAIN=""
RATE_PATH=${RATE_PATH:-/api/catalog}
RATE_N=${RATE_N:-150}
while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL=1 ;;
    --no-rate) RATE=0 ;;
    --ip) IP=${2:-}; shift ;;
    -h | --help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "check: unknown option $1" >&2; exit 2 ;;
    *) DOMAIN=$1 ;;
  esac
  shift
done
if [ -z "$DOMAIN" ] && [ -r /etc/dronex/deploy.conf ]; then
  DOMAIN=$(sed -n 's/^DOMAIN=//p' /etc/dronex/deploy.conf | tail -1)
fi
[ -n "$DOMAIN" ] || { echo "usage: deploy/check.sh [--local] [--no-rate] [--ip ADDR] DOMAIN" >&2; exit 2; }

APP="https://dronex.$DOMAIN"
SIM="https://sim.$DOMAIN"
FAILS=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$*"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

expect() { # expect <want-regex> <label> <curl args...>
  local want=$1 label=$2 got
  shift 2
  got=$(code "$@")
  if [[ $got =~ ^($want)$ ]]; then pass "$label -> $got"; else fail "$label -> $got (want $want)"; fi
}

echo "DroneX checks for $APP and $SIM"

# 1. HTTPS on both names (retry: right after a first deploy, ACME may still be issuing).
for url in "$APP/" "$SIM/"; do
  got=000
  for _ in $(seq 1 30); do
    got=$(code "$url")
    [ "$got" = 200 ] && break
    sleep 3
  done
  if [ "$got" = 200 ]; then pass "HTTPS $url -> 200"; else fail "HTTPS $url -> $got"; fi
  if curl -sI --max-time 15 "$url" | grep -qi '^strict-transport-security:'; then pass "HSTS on $url"; else fail "no HSTS header on $url"; fi
done
expect 200 "configurator GET /api/tracks" "$APP/api/tracks"

# 2. Guest session on sim: paired:true, a Secure cookie, and no pairing.
resp=$(curl -s -i --max-time 15 "$SIM/api/session")
status=$(printf '%s' "$resp" | head -1 | awk '{print $2}')
if [ "$status" = 503 ]; then
  warn "GET $SIM/api/session -> 503 (simulator full); the guest checks could not run"
elif [ "$status" = 200 ]; then
  if printf '%s' "$resp" | grep -Eq '"paired"[[:space:]]*:[[:space:]]*true'; then pass "GET /api/session on sim -> paired:true"; else fail "GET /api/session on sim did not answer paired:true"; fi
  if printf '%s' "$resp" | grep -i '^set-cookie:' | grep -qi 'secure'; then pass "guest cookie is Secure"; else fail "no Secure Set-Cookie from /api/session"; fi
  if printf '%s' "$resp" | grep -Eqi '"(code|pairingCode|pairing_code)"[[:space:]]*:[[:space:]]*"'; then fail "/api/session returned a pairing code"; else pass "no pairing code in /api/session"; fi
else
  fail "GET $SIM/api/session -> ${status:-no answer}"
fi
expect 404 "POST /api/pairing on sim" -X POST -H 'content-type: application/json' -d '{}' "$SIM/api/pairing"
expect 404 "GET /v1/auth on sim (backend stays private)" "$SIM/v1/auth"
expect 404 "GET /v1/me on sim" "$SIM/v1/me"
expect '200|503' "GET /v1/maps/key on sim (backend, same-origin)" "$SIM/v1/maps/key"

# A Host aimed at the operator listener must not get the UI.
body=$(curl -s --max-time 15 -H 'Host: 127.0.0.1:45010' "$SIM/")
if printf '%s' "$body" | grep -qi '<html'; then fail "Host: 127.0.0.1:45010 via sim served a page"; else pass "Host: 127.0.0.1:45010 via sim is not served"; fi

# 3. Agent-only configurator paths are 404 from the internet.
expect 404 "POST /api/sim/refly/x" -X POST -H 'content-type: application/json' -d '{}' "$APP/api/sim/refly/x"
expect 404 "GET /api/sim/refly/x" "$APP/api/sim/refly/x"
expect 404 "POST /api/sim/stop/x" -X POST "$APP/api/sim/stop/x"
expect 404 "POST /api/sim/vehicles/x" -X POST -H 'content-type: application/json' -d '{}' "$APP/api/sim/vehicles/x"
expect 404 "POST /api/airspace/mission" -X POST -H 'content-type: application/json' -d '{}' "$APP/api/airspace/mission"
expect 404 "GET /api/airspace/mission" "$APP/api/airspace/mission"
expect 404 "GET /api/sim/designs (list)" "$APP/api/sim/designs"
expect 404 "GET /api/SIM/REFLY/x (case)" "$APP/api/SIM/REFLY/x"
expect '404|405' "GET /api/copilot/speak (no GET handler)" "$APP/api/copilot/speak?text=hi"
# Body cap: 300 KB of JSON to a small route.
big=$(head -c 300000 /dev/zero | tr '\0' 'a')
expect 413 "300 KB body to /api/assistant is refused by Caddy" -X POST -H 'content-type: application/json' --data-binary "{\"x\":\"$big\"}" "$APP/api/assistant"

# 4. Internal ports are not reachable from outside.
if [ "$LOCAL" = 0 ] || [ -n "$IP" ]; then
  if [ -z "$IP" ]; then
    IP=$( (getent hosts "sim.$DOMAIN" 2>/dev/null || dig +short "sim.$DOMAIN" 2>/dev/null || host "sim.$DOMAIN" 2>/dev/null) | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1)
  fi
  if [ -z "$IP" ]; then
    warn "could not resolve sim.$DOMAIN; skipping the port scan (pass --ip)"
  else
    for p in 45010 45020 45103 3000 5600 5760 5770 8001 8002 8003; do
      curl -s -o /dev/null --connect-timeout 4 --max-time 6 "http://$IP:$p/"
      rc=$?
      if [ $rc = 7 ] || [ $rc = 28 ]; then pass "port $p closed on $IP"; else fail "port $p reachable on $IP (curl exit $rc)"; fi
    done
  fi
fi

# 5. Rate limit: a cheap configurator route returns 429 when hammered.
if [ "$RATE" = 1 ]; then
  args=()
  for _ in $(seq 1 "$RATE_N"); do args+=(-o /dev/null "$APP$RATE_PATH"); done
  n429=$(curl -s --max-time 120 -w '%{http_code}\n' "${args[@]}" | grep -c '^429$')
  if [ "$n429" -gt 0 ]; then pass "rate limit: $n429 of $RATE_N GET $RATE_PATH -> 429"; else fail "rate limit: no 429 in $RATE_N GET $RATE_PATH"; fi
fi

# 6. On the VM: units, listeners, loopback auth.
if [ "$LOCAL" = 1 ]; then
  for u in dronex-backend dronex-core dronex-render dronex-mirror dronex-agents caddy; do
    if systemctl is-active --quiet "$u"; then pass "unit $u active"; else fail "unit $u is $(systemctl is-active "$u" 2>/dev/null)"; fi
  done
  if command -v ss >/dev/null; then
    for p in 45010 45020 45103 3000; do
      addrs=$(ss -ltnH "sport = :$p" 2>/dev/null | awk '{print $4}')
      if [ -z "$addrs" ]; then fail "nothing listens on :$p"
      elif printf '%s\n' "$addrs" | grep -Eqv '^(127\.0\.0\.1|\[::1\]):'; then fail ":$p listens beyond loopback: $(echo "$addrs" | tr '\n' ' ')"
      else pass ":$p bound to loopback only"; fi
    done
  fi
  expect '401|403' "loopback POST /api/sim/refly/x without token" -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/api/sim/refly/x
  expect '401|403' "loopback POST /api/sim/vehicles/x without token" -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/api/sim/vehicles/x
  expect '401|403' "loopback POST /api/airspace/mission without token" -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/api/airspace/mission
  if command -v ufw >/dev/null; then
    if ufw status 2>/dev/null | grep -q 'Status: active'; then pass "ufw active"; else fail "ufw is not active"; fi
  fi
fi

echo
if [ "$FAILS" = 0 ]; then echo "all checks passed"; else echo "$FAILS check(s) failed"; fi
[ "$FAILS" = 0 ]
