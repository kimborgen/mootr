#!/bin/sh
# The MCP lease route (S-3176), free (no agents, no models): two isolated daemons. "main" is the settings
# home and holds the grants; "far" names main as its home, so it is a peer that must not serve a lease.
# Checks:
#   - the lease route takes only the lease token: no token is 401; the peer token, the shared token, an
#     agent's token and a wrong token are 403
#   - the lease token leases a shared server (url, access_token, expires_at); an unknown server is 404, an
#     unshared one 403, a gh one 400, a grant that never expires 409, a server with no login 409
#   - the status route lists the shared servers only, with no token
#   - far refuses even its own lease token: 409, naming main
#   - a rotation refuses the old token at once, with no restart; the new one leases; the CLI prints no
#     token; the peer token and the peer link are unchanged; a daemon restart keeps the new token
#   - each lease is logged by server and expiry, never with the token
set -e
STAM_MCP_AUTH_INSECURE=1
export STAM_MCP_AUTH_INSECURE
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home far
T=$(date +%s)
python3 - "$TEST_TMP" "$T" <<'PY'
import json, os, sys, time
tmp, t = sys.argv[1:3]
url = "http://127.0.0.1:9/mcp"
fresh = int(time.time() * 1000) + 3600000
def grant(access, **extra):
    return {"server_url": url, "client_id": "stam", "token_endpoint": "http://127.0.0.1:9/token", "resource": url,
            "access_token": access, **extra}
main = f"{tmp}/main/settings.json"
s = json.load(open(main))
s["mcpServers"] = {
    "shared": {"url": url, "auth": {"type": "oauth"}, "shareWithPeers": True},
    "private": {"url": url, "auth": {"type": "oauth"}},
    "github": {"url": url, "auth": {"type": "gh"}, "shareWithPeers": True},
    "forever": {"url": url, "auth": {"type": "oauth"}, "shareWithPeers": True},
    "nologin": {"url": url, "auth": {"type": "oauth"}, "shareWithPeers": True},
}
json.dump(s, open(main, "w"), indent=2)
store = {"shared": grant("LEASED-ACCESS-" + t, expires_at=fresh),
         "private": grant("PRIVATE-ACCESS-" + t, expires_at=fresh),
         "forever": grant("FOREVER-ACCESS-" + t)}
path = f"{tmp}/main/mcp-auth.json"
open(path, "w").write(json.dumps(store, indent=2))
os.chmod(path, 0o600)
far = f"{tmp}/far/settings.json"
f = json.load(open(far))
f["home"] = "main"
json.dump(f, open(far, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up far
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
FAR_URL=$(on far sh -c 'echo "$STAM_URL"'); FAR_TOKEN=$(cat "$TEST_TMP/far/token")
PEER=$(cat "$TEST_TMP/main/peer-token")
LEASE=$(cat "$TEST_TMP/main/mcp-lease-token")
REG=$(curl -s -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"lessee-$T\",\"role\":\"test\",\"harness\":\"external\",\"token\":true}" "$MAIN_URL/api/register")
AGENT=$(echo "$REG" | jget "d['token']")
AGENT_ID=$(echo "$REG" | jget "d['id']")
[ -n "$AGENT" ] || fail "could not mint an agent token"

# get TOKEN PATH [BASE]: the HTTP status of a GET with that bearer; the body lands in $TEST_TMP/lease.out.
get() { curl -s -o "$TEST_TMP/lease.out" -w '%{http_code}' -H "authorization: Bearer $1" "${3:-$MAIN_URL}$2"; }
L=/api/peer/mcp/shared/lease

# The bearer: only the lease token passes.
[ "$(curl -s -o /dev/null -w '%{http_code}' "$MAIN_URL$L")" = 401 ] || fail "a request with no token wasn't a 401"
[ "$(get "$PEER" $L)" = 403 ] || fail "the peer token passed the lease route"
[ "$(get "$MAIN_TOKEN" $L)" = 403 ] || fail "the shared token passed the lease route"
[ "$(get "$AGENT" $L)" = 403 ] || fail "an agent's token passed the lease route"
[ "$(get "wrong-$T" $L)" = 403 ] || fail "a wrong token passed the lease route"
[ "$(get "$FAR_TOKEN" $L)" = 403 ] || fail "far's own token passed main's lease route"

# The lease: a shared server gets its url, token and expiry.
[ "$(get "$LEASE" $L)" = 200 ] || fail "the lease token got no lease: $(cat "$TEST_TMP/lease.out")"
python3 - "$TEST_TMP/lease.out" "$T" <<'PY' || fail "the lease body is wrong: $(cat "$TEST_TMP/lease.out")"
import json, sys
d = json.load(open(sys.argv[1]))
assert sorted(d) == ["access_token", "expires_at", "url"], sorted(d)
assert d["access_token"] == "LEASED-ACCESS-" + sys.argv[2]
assert d["url"].endswith("/mcp") and isinstance(d["expires_at"], int)
PY
[ "$(get "$LEASE" "$L?refresh=1")" = 200 ] || fail "a lease with refresh=1 was refused"

# Each refusal has its own status and names its cause.
refuse() { # NAME STATUS WORDS
  _c=$(get "$LEASE" "/api/peer/mcp/$1/lease")
  [ "$_c" = "$2" ] || fail "$1 leased as $_c, not $2: $(cat "$TEST_TMP/lease.out")"
  grep -q "$3" "$TEST_TMP/lease.out" || fail "$1 didn't say $3: $(cat "$TEST_TMP/lease.out")"
  ! grep -q "LEASED-ACCESS\|PRIVATE-ACCESS\|FOREVER-ACCESS" "$TEST_TMP/lease.out" || fail "$1's refusal carried a token"
}
refuse nosuch 404 "no MCP server named"
refuse private 403 "not shared with peers"
refuse github 400 "uses gh"
refuse forever 409 "never expires"
refuse nologin 409 "not logged in"

# The status route: the shared servers only, and no token.
[ "$(get "$LEASE" /api/peer/mcp/status)" = 200 ] || fail "the status route wasn't 200"
python3 - "$TEST_TMP/lease.out" <<'PY' || fail "the status rows are wrong: $(cat "$TEST_TMP/lease.out")"
import json, sys
raw = open(sys.argv[1]).read()
names = sorted(s["name"] for s in json.loads(raw)["servers"])
assert names == ["forever", "github", "nologin", "shared"], names
assert "ACCESS" not in raw, "a token is in the status"
PY

# far is not the home: its own lease token gets a clear 409, naming main.
FAR_LEASE=$(cat "$TEST_TMP/far/mcp-lease-token")
[ "$(get "$FAR_LEASE" $L "$FAR_URL")" = 409 ] || fail "far served a lease"
grep -q "settings home" "$TEST_TMP/lease.out" && grep -q main "$TEST_TMP/lease.out" || fail "far's refusal didn't name main: $(cat "$TEST_TMP/lease.out")"

# The token route (S-3212): a peer never gets a bearer, with or without ?agent=, with the human's header, or
# forwarded for an agent. The local flows still get one: an agent's own token (mcp-proxy) and the human.
TOK=/api/mcp/shared/token
peer_get() { curl -s -o "$TEST_TMP/token.out" -w '%{http_code}' "$@"; }
[ "$(get "$PEER" $TOK)" = 403 ] || fail "the peer token got an MCP bearer from the token route: $(cat "$TEST_TMP/lease.out")"
[ "$(get "$PEER" "$TOK?agent=$AGENT_ID")" = 403 ] || fail "the peer token with ?agent= got an MCP bearer"
[ "$(peer_get -H "authorization: Bearer $PEER" -H 'x-stam-human: 1' "$MAIN_URL$TOK")" = 403 ] || fail "the peer token with x-stam-human got an MCP bearer"
[ "$(peer_get -H "authorization: Bearer $PEER" -H 'x-stam-local: 1' -H "x-stam-agent: $AGENT_ID" "$MAIN_URL$TOK?agent=$AGENT_ID")" = 403 ] || fail "a peer-forwarded agent got an MCP bearer"
[ "$(get "$AGENT" "$TOK?agent=$AGENT_ID")" = 200 ] || fail "an agent's own token no longer gets its MCP bearer (mcp-proxy)"
[ "$(peer_get -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' "$MAIN_URL$TOK")" = 200 ] || fail "the human no longer gets an MCP bearer from the token route"

# The lease log names the caller behind tailscale serve from the forwarded address, a loopback connection's only.
[ "$(peer_get -H "authorization: Bearer $LEASE" -H 'x-forwarded-for: 203.0.113.9' "$MAIN_URL$L")" = 200 ] || fail "the forwarded lease was refused"
wait_until grep -q "mcp lease: shared to 203.0.113.9," "$TEST_TMP/main/daemon.log" || fail "the lease log doesn't name the forwarded caller"

# Rotation: the old token is refused at once, the new one leases, nothing prints a token.
ROT=$(on main "$STAM" mcp lease-rotate) || fail "lease-rotate failed"
case "$ROT" in *"$LEASE"*) fail "lease-rotate printed the old token" ;; esac
NEW=$(cat "$TEST_TMP/main/mcp-lease-token")
[ -n "$NEW" ] && [ "$NEW" != "$LEASE" ] || fail "the rotation made no new token"
[ "$(get "$LEASE" $L)" = 403 ] || fail "the old lease token still leases after a rotation"
[ "$(get "$NEW" $L)" = 200 ] || fail "the new lease token got no lease"
[ "$(cat "$TEST_TMP/main/peer-token")" = "$PEER" ] || fail "the rotation changed the peer token"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $PEER" -H 'x-stam-local: 1' "$MAIN_URL/api/health")" = 200 ] || fail "the peer link broke after a rotation"

# A restart keeps the token: the home has no state the lease needs in memory.
daemon_stop main
daemon_up main
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"')
[ "$(get "$NEW" $L)" = 200 ] || fail "the lease token didn't survive a restart"

# Every lease is logged by server and expiry, and no log line has a token.
wait_until grep -q "mcp lease: shared to" "$TEST_TMP/main/daemon.log" || fail "a lease wasn't logged"
grep -q "mcp lease: shared to .*expires " "$TEST_TMP/main/daemon.log" || fail "the lease log has no expiry"
! grep -q "LEASED-ACCESS\|$NEW\|$LEASE" "$TEST_TMP/main/daemon.log" || fail "a token reached the daemon log"
echo "PASS: the MCP lease route (S-3176)"
