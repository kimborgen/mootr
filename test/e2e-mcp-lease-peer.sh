#!/bin/sh
# The MCP lease on a peer (S-3177), free (no agents, no models): a home daemon "main" that holds the grants, and a peer
# "far" that names main as its home. A fake OAuth server (test/mcp-oauth-fake.mjs) is the provider; its tokens last
# 75 s (EXPIRES_IN), so the peer's 60 s margin and the home's refresh both come within seconds.
# Checks:
#   - the peer's token route gives its local callers the home's lease: the bearer, the url and the expiry
#   - the cache serves a second ask and five at once with no home lease; five forced refreshes at once, all held in
#     the peer while the first is held at the provider, make two home leases: the first, and one after it (S-3472)
#   - a server the home doesn't share is refused, with the home's 403 named
#   - status on the peer lists the home's shared servers, marked as leased from main, and no token
#   - login and logout on the peer are refused, naming main, and `stam mcp logout` prints that refusal
#   - a missing leaseToken and a wrong one each say what to do; a wrong one is refused with 403
#   - after lease-rotate on main, the old lease token fails, and the new one (set on the peer) leases
#   - near expiry the peer re-leases, and the home refreshes its grant
#   - a peer restart drops the cache: no access token is on the peer's disk, and the next ask re-leases
#   - with the home down, the peer serves from cache, and after the 60 s margin it fails with "unreachable"
#   - no access token reaches either daemon's log
set -e
STAM_MCP_AUTH_INSECURE=1
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_MCP_AUTH_INSECURE STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home far
T=$(date +%s)
PORT=$(free_port)
GOOD="ACCESS-$T"
REF="REFRESH-$T"
FAKE_READY="$TEST_TMP/fake.ready"
FAKE_LOG="$TEST_TMP/fake.log"
HOLD="$TEST_TMP/fake.hold"
: >"$FAKE_LOG"
FAKE_PORT=$PORT GOOD_TOKEN=$GOOD REFRESH_TOKEN=$REF EXPIRES_IN=75 FAKE_READY=$FAKE_READY FAKE_LOG=$FAKE_LOG HOLD_FILE=$HOLD \
  node "$ROOT/test/mcp-oauth-fake.mjs" &
FAKE_PID=$!
cleanup() { kill "$FAKE_PID" 2>/dev/null; stam_test_cleanup; }
trap cleanup EXIT
for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$FAKE_READY" ] && break; sleep 0.1; done
[ -s "$FAKE_READY" ] || { echo "FAIL: the fake OAuth server didn't start"; exit 1; }
python3 - "$TEST_TMP" "$T" "$PORT" "$GOOD" "$REF" <<'PY'
import json, os, sys, time
tmp, t, port, good, ref = sys.argv[1:6]
url = f"http://127.0.0.1:{port}/mcp"
endpoint = f"http://127.0.0.1:{port}/token"
now = int(time.time() * 1000)
main = f"{tmp}/main/settings.json"
s = json.load(open(main))
s["mcpServers"] = {
    "shared": {"url": url, "auth": {"type": "oauth"}, "shareWithPeers": True},
    "private": {"url": url, "auth": {"type": "oauth"}},
}
json.dump(s, open(main, "w"), indent=2)
def grant(access):
    return {"server_url": url, "client_id": "stam", "token_endpoint": endpoint, "resource": url,
            "access_token": access, "refresh_token": ref, "expires_at": now + 75000}
path = f"{tmp}/main/mcp-auth.json"
open(path, "w").write(json.dumps({"shared": grant(good), "private": grant("PRIVATE-" + t)}, indent=2))
os.chmod(path, 0o600)
PY
daemon_up main
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"')
MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
LEASE=$(cat "$TEST_TMP/main/mcp-lease-token")
# far's settings name main as its home and carry main's lease token, as a peer does.
python3 - "$TEST_TMP/far/settings.json" "$MAIN_URL" "$MAIN_TOKEN" "$LEASE" <<'PY'
import json, sys
path, url, token, lease = sys.argv[1:5]
s = json.load(open(path))
s["home"] = "main"
s["peers"] = [{"name": "main", "url": url, "token": token, "leaseToken": lease}]
json.dump(s, open(path, "w"), indent=2)
PY
daemon_up far
FAR_URL=$(on far sh -c 'echo "$STAM_URL"')
FAR_TOKEN=$(cat "$TEST_TMP/far/token")
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
fail() { echo "FAIL: $1"; exit 1; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
past_ms() { [ "$(now_ms)" -ge "$1" ]; }
field() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$TEST_TMP/ask.out" "$1"; }
# ask NAME [QUERY]: far's own token route for NAME, as a human would reach it; the body lands in $TEST_TMP/ask.out.
ask() { curl -s -o "$TEST_TMP/ask.out" -w '%{http_code}' -H "authorization: Bearer $FAR_TOKEN" -H 'x-stam-human: 1' "$FAR_URL/api/mcp/$1/token$2"; }
# leases: how many leases main has granted (its log names each one).
leases() { grep -c "mcp lease: shared to" "$TEST_TMP/main/daemon.log" || true; }
# refreshes: how many refreshes the provider has answered.
refreshes() { grep -cx refresh "$FAKE_LOG" || true; }
# held: how many refreshes the provider has held (HOLD_FILE); waits: how many asks on far waited for a running fetch.
held() { grep -cx held "$FAKE_LOG" || true; }
waits() { grep -c "mcp lease: shared waits for the running fetch" "$TEST_TMP/far/daemon.log" || true; }
held_over() { [ "$(held)" -gt "$1" ]; }
waits_reach() { [ "$(waits)" -ge "$1" ]; }
# far_lease VALUE: sets far's leaseToken to VALUE, or removes it for "-".
far_lease() {
  python3 - "$TEST_TMP/far/settings.json" "$1" <<'PY'
import json, sys
path, value = sys.argv[1:3]
s = json.load(open(path))
if value == "-": s["peers"][0].pop("leaseToken", None)
else: s["peers"][0]["leaseToken"] = value
json.dump(s, open(path, "w"), indent=2)
PY
}

# The bearer: far's local callers get the home's lease, with its url and expiry.
[ "$(ask shared)" = 200 ] || fail "the peer got no bearer: $(cat "$TEST_TMP/ask.out")"
[ "$(field token)" = "$GOOD" ] || fail "the peer's bearer isn't the home's leased token"
[ "$(field url)" = "http://127.0.0.1:$PORT/mcp" ] || fail "the peer's url isn't the home's: $(field url)"
EXP=$(field expires_at)
[ "$(leases)" = 1 ] || fail "the first ask made $(leases) home leases, not 1"

# The cache: a second ask, and five at once, make no home lease.
[ "$(ask shared)" = 200 ] || fail "the second ask failed"
PIDS=""
for _i in 1 2 3 4 5; do curl -s -o /dev/null -H "authorization: Bearer $FAR_TOKEN" -H 'x-stam-human: 1' "$FAR_URL/api/mcp/shared/token" & PIDS="$PIDS $!"; done
wait $PIDS
[ "$(leases)" = 1 ] || fail "cached asks reached the home: $(leases) leases"

# A server the home doesn't share is refused, and the refusal says so.
[ "$(ask private)" != 200 ] || fail "a server the home doesn't share was leased"
grep -q "is not shared with peers" "$TEST_TMP/ask.out" || fail "the refusal for an unshared server didn't say so: $(cat "$TEST_TMP/ask.out")"
grep -q "403" "$TEST_TMP/ask.out" || fail "the refusal for an unshared server isn't the home's 403: $(cat "$TEST_TMP/ask.out")"

# Status: the home's shared servers, marked as leased from main, with no token.
[ "$(curl -s -o "$TEST_TMP/ask.out" -w '%{http_code}' -H "authorization: Bearer $FAR_TOKEN" -H 'x-stam-human: 1' "$FAR_URL/api/mcp/status")" = 200 ] || fail "status on the peer failed: $(cat "$TEST_TMP/ask.out")"
python3 - "$TEST_TMP/ask.out" "$GOOD" <<'PY' || fail "the peer's status is wrong: $(cat "$TEST_TMP/ask.out")"
import json, sys
raw = open(sys.argv[1]).read()
rows = json.loads(raw)["servers"]
assert [r["name"] for r in rows] == ["shared"], rows
assert rows[0]["leased_from"] == "main", rows[0]
assert sys.argv[2] not in raw, "a token is in the status"
PY

# A peer holds no logins: logout is refused and names main (login is refused in test/mcp-auth.test.mjs).
for route in logout; do
  [ "$(curl -s -o "$TEST_TMP/ask.out" -w '%{http_code}' -X POST -H "authorization: Bearer $FAR_TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$FAR_URL/api/mcp/shared/$route")" != 200 ] || fail "the peer let $route through"
  grep -q "keeps the MCP logins" "$TEST_TMP/ask.out" && grep -q "main" "$TEST_TMP/ask.out" || fail "the peer's $route refusal didn't name main: $(cat "$TEST_TMP/ask.out")"
done
# The CLI prints the daemon's refusal rather than a generic line (S-3178). The CLI here is not the human, so the
# daemon refuses it before the peer check; the peer's refusal naming main is the route's, checked above.
OUT=$(on far "$STAM" mcp logout shared 2>&1) && fail "stam mcp logout on the peer succeeded"
case "$OUT" in *"only the human can log out of an MCP server"*) ;; *) fail "stam mcp logout on the peer didn't print the daemon's refusal: $OUT" ;; esac

# A missing or wrong leaseToken: each says what to do, and a wrong one is refused by main with 403.
far_lease -
[ "$(ask shared '?refresh=1')" != 200 ] || fail "a peer with no leaseToken got a bearer"
grep -q "leaseToken is missing" "$TEST_TMP/ask.out" || fail "a missing leaseToken didn't say so: $(cat "$TEST_TMP/ask.out")"
far_lease "wrong-$T"
[ "$(ask shared '?refresh=1')" != 200 ] || fail "a wrong lease token got a bearer"
grep -q "refused the lease token (403" "$TEST_TMP/ask.out" || fail "a wrong lease token didn't get the clear 403: $(cat "$TEST_TMP/ask.out")"
! grep -q "$GOOD" "$TEST_TMP/ask.out" || fail "the refusal carried the bearer"
far_lease "$LEASE"

# Five forced refreshes at once (S-3472): the first one's refresh is held at the provider until the other four wait in
# the peer. They share one forced fetch after it, never the first one's answer: two home leases, two refreshes.
BEFORE=$(leases)
REFRESHES=$(refreshes)
HELD=$(held)
WAITS=$(waits)
: >"$HOLD"
PIDS=""
for _i in 1 2 3 4 5; do curl -s -o /dev/null -H "authorization: Bearer $FAR_TOKEN" -H 'x-stam-human: 1' "$FAR_URL/api/mcp/shared/token?refresh=1" & PIDS="$PIDS $!"; done
wait_until held_over "$HELD"
wait_until waits_reach $((WAITS + 4))
rm -f "$HOLD"
wait $PIDS
[ "$(leases)" = $((BEFORE + 2)) ] || fail "five forced refreshes made $(($(leases) - BEFORE)) home leases, not 2"
[ "$(refreshes)" = $((REFRESHES + 2)) ] || fail "five forced refreshes made $(($(refreshes) - REFRESHES)) provider refreshes, not 2"
[ "$(ask shared '?refresh=1')" = 200 ] || fail "a forced refresh got no bearer: $(cat "$TEST_TMP/ask.out")"
EXP=$(field expires_at)

# Rotation on main: the old lease token fails on the peer at once; the new one, set on the peer, leases.
ROT=$(on main "$STAM" mcp lease-rotate) || fail "lease-rotate failed"
case "$ROT" in *"$LEASE"*) fail "lease-rotate printed the old token" ;; esac
NEW=$(cat "$TEST_TMP/main/mcp-lease-token")
[ -n "$NEW" ] && [ "$NEW" != "$LEASE" ] || fail "the rotation made no new token"
[ "$(ask shared '?refresh=1')" != 200 ] || fail "the old lease token still leases on the peer after a rotation"
grep -q "refused the lease token (403" "$TEST_TMP/ask.out" || fail "the old lease token wasn't refused with 403: $(cat "$TEST_TMP/ask.out")"
far_lease "$NEW"
[ "$(ask shared '?refresh=1')" = 200 ] || fail "the new lease token got no bearer: $(cat "$TEST_TMP/ask.out")"
EXP=$(field expires_at)

# Near expiry: once the 60 s margin is reached, the peer re-leases, and the home refreshes its grant (under a minute left).
REFRESHES=$(refreshes)
BEFORE=$(leases)
[ "$(ask shared)" = 200 ] || fail "a cached ask failed before expiry"
[ "$(leases)" = "$BEFORE" ] || fail "a cached ask before the margin reached the home"
wait_until past_ms $((EXP - 59000))
[ "$(ask shared)" = 200 ] || fail "the peer didn't re-lease near expiry: $(cat "$TEST_TMP/ask.out")"
[ "$(leases)" = $((BEFORE + 1)) ] || fail "the re-lease near expiry made $(($(leases) - BEFORE)) home leases, not 1"
[ "$(refreshes)" = $((REFRESHES + 1)) ] || fail "the home didn't refresh its grant near expiry"
EXP=$(field expires_at)

# A peer restart drops the cache: the access token is nowhere on the peer's disk, and the next ask re-leases.
daemon_stop far
daemon_up far
FAR_TOKEN=$(cat "$TEST_TMP/far/token")
! grep -rq "$GOOD" "$TEST_TMP/far" || fail "the access token is on the peer's disk"
BEFORE=$(leases)
[ "$(ask shared)" = 200 ] || fail "the first ask after a restart failed: $(cat "$TEST_TMP/ask.out")"
[ "$(leases)" = $((BEFORE + 1)) ] || fail "the first ask after a restart didn't re-lease"
EXP=$(field expires_at)

# Home down: the peer serves its cached lease, then, once the margin is reached, fails with the home-unreachable error.
daemon_stop main
[ "$(ask shared)" = 200 ] || fail "the peer didn't serve its cached lease with the home down: $(cat "$TEST_TMP/ask.out")"
[ "$(field token)" = "$GOOD" ] || fail "the cached lease with the home down isn't the leased bearer"
wait_until past_ms $((EXP - 59000))
[ "$(ask shared)" != 200 ] || fail "the peer served a lease past the margin with the home down"
grep -q "is unreachable" "$TEST_TMP/ask.out" || fail "the home-down error didn't say the home is unreachable: $(cat "$TEST_TMP/ask.out")"
! grep -q "$GOOD" "$TEST_TMP/ask.out" || fail "the home-down error carried the bearer"

# No access token, lease token, or refresh token reaches a log on either daemon, nor the peer's disk.
! grep -rq "$GOOD" "$TEST_TMP/far" || fail "the access token is on the peer's disk"
! grep -rq "$REF" "$TEST_TMP/far" || fail "the refresh token is on the peer's disk"
! grep -q "$GOOD\|$REF\|$LEASE\|$NEW" "$TEST_TMP/far/daemon.log" "$TEST_TMP/main/daemon.log" || fail "a token reached a daemon log"
grep -q "mcp lease: shared from main, expires " "$TEST_TMP/far/daemon.log" || fail "the peer doesn't log its leases"
echo "PASS: the MCP lease on a peer (S-3177)"
