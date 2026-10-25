#!/bin/sh
# Registers DroneX's server identity as a writer of the shared airspace. The module refuses every mutating reducer
# from identities that are not writers, so browsers can only subscribe; the mirror and the configurator's server
# share one token (SPACETIME_TOKEN) whose identity this script registers.
#
# Run it signed in to the spacetime CLI as the identity that published the database (the owner; `spacetime login
# show` prints it). Only the owner may call add_writer / remove_writer.
#
#   DroneX_live/scripts/spacetime-add-writer.sh                    # mint a new token on the server, register it
#   SPACETIME_TOKEN=eyJ... DroneX_live/scripts/spacetime-add-writer.sh   # register the identity of this token
#   DroneX_live/scripts/spacetime-add-writer.sh /path/to/token     # register the identity of a token file
#   DroneX_live/scripts/spacetime-add-writer.sh --remove 0xc200…   # take a writer's right away again
#
# Server and database: SPACETIME_SERVER (default http://127.0.0.1:3100; e.g. maincloud) and SPACETIME_DB (default
# dronex-airspace). When a new token is minted, put the printed SPACETIME_TOKEN=... line in the env of both the
# mirror and the configurator (e.g. /etc/dronex/env, or DroneX_render/.env.local in development); it is a
# credential, so keep it out of git and logs.
set -eu
export PATH="$HOME/.local/bin:$PATH"
SERVER=${SPACETIME_SERVER:-http://127.0.0.1:3100}
DB=${SPACETIME_DB:-dronex-airspace}

case "$SERVER" in
  maincloud) HTTP=https://maincloud.spacetimedb.com ;;
  local) HTTP=http://127.0.0.1:3000 ;;
  http://* | https://*) HTTP=$SERVER ;;
  *) HTTP=https://$SERVER ;;
esac

if [ "${1:-}" = "--remove" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 --remove <identity hex>" >&2; exit 2; }
  spacetime call --server "$SERVER" --yes "$DB" remove_writer "$2"
  echo "removed writer $2 from $DB on $SERVER"
  exit 0
fi

MINTED=0
if [ -n "${1:-}" ]; then
  TOKEN=$(tr -d ' \n\r' < "$1")
elif [ -n "${SPACETIME_TOKEN:-}" ]; then
  TOKEN=$SPACETIME_TOKEN
else
  # A fresh identity and its token, issued by the server itself (the same as an anonymous SDK connection gets).
  TOKEN=$(curl -fsS -X POST "$HTTP/v1/identity" | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] || { echo "could not mint a token at $HTTP/v1/identity" >&2; exit 1; }
  MINTED=1
fi

# The identity is the JWT's hex_identity claim (base64url payload, padded for base64 -d).
PAYLOAD=$(printf '%s' "$TOKEN" | cut -d. -f2 | tr '_-' '/+')
case $((${#PAYLOAD} % 4)) in 2) PAYLOAD="$PAYLOAD==" ;; 3) PAYLOAD="$PAYLOAD=" ;; esac
IDENTITY=$(printf '%s' "$PAYLOAD" | base64 -d 2>/dev/null | sed -n 's/.*"hex_identity" *: *"\([0-9a-fA-F]*\)".*/\1/p')
[ -n "$IDENTITY" ] || { echo "that token has no hex_identity claim; is it a SpacetimeDB token?" >&2; exit 1; }

echo "identity: 0x$IDENTITY"
if [ "$MINTED" = 1 ]; then
  echo "new token (set it for the mirror and the configurator):"
  echo "SPACETIME_TOKEN=$TOKEN"
fi
spacetime call --server "$SERVER" --yes "$DB" add_writer "0x$IDENTITY"
echo "0x$IDENTITY may now write to $DB on $SERVER"
