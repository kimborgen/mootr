#!/bin/sh
# A request is the owner only when trustedHuman holds (S-541): a forged Tailscale-User-Login over
# loopback with no token gets 401 on an API route, x-stam-human doesn't help, and a terminal socket
# upgrade with the forged header and no token is refused. Free: no agents, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_up main
fail() { echo "FAIL: $1"; exit 1; }
OWNER=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["User"][str(s["Self"]["UserID"])]["LoginName"])' 2>/dev/null || true)
# Without a Tailscale owner the daemon has none to forge; say so rather than pass vacuously.
if [ -z "$OWNER" ]; then echo "SKIP: no Tailscale owner on this machine, so there is no login to forge"; exit 0; fi
URL=$(on main sh -c 'echo "$STAM_URL"')
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$URL/api/agents")" = 401 ] || fail "a request with no credential wasn't 401"
[ "$(code -H "tailscale-user-login: $OWNER" "$URL/api/agents")" = 401 ] || fail "a forged tailscale-user-login with no token wasn't 401"
[ "$(code -H "tailscale-user-login: $OWNER" -H 'x-stam-human: 1' -H 'x-forwarded-for: 192.0.2.9' "$URL/api/agents")" = 401 ] || fail "x-stam-human with the forged login wasn't 401"
[ "$(code -X POST -H 'content-type: application/json' -H "tailscale-user-login: $OWNER" -H 'x-stam-human: 1' -d '{}' "$URL/api/janitor")" = 401 ] || fail "a forged write wasn't 401"
# A terminal upgrade is refused: the socket is destroyed, so curl gets no 101 response.
OUT=$(curl -s -i -m 5 -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' \
  -H "tailscale-user-login: $OWNER" "$URL/api/shells/s1/tty" \
  -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' || true) # gitleaks:allow (RFC 6455's sample nonce)
case "$OUT" in *101*) fail "a terminal upgrade with the forged login was accepted";; esac
echo "PASS"
