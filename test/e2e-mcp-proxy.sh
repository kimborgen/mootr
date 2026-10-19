#!/bin/sh
# Shared MCP proxy end to end (S-50), free (no agents, no models): one throwaway daemon and
# a fake remote MCP server (test/mcp-oauth-fake.mjs) play a service the daemon has a login
# for. The fake accepts only its `GOOD` bearer, so the proxy's first POST with the stored
# (stale) token gets a 401, the proxy asks the daemon to refresh, and the retry gets through
# — proving the 401 recovery. Checks a JSON answer, an SSE answer, the Mcp-Session-Id, a
# notification's silent 202, the login URL (from the canonical origin), status, logout, and
# the store's 0600 mode. It also pins the security fixes: login and logout accept only the
# human (`trustedHuman`), a foreign Origin is refused, and the CLI points at the web UI.
set -e
# The fake OAuth/MCP server is http on loopback, and the human is the request carrying the
# test key (no tailscale serve here). The canonical web origin is pinned for the redirect.
STAM_MCP_AUTH_INSECURE=1
STAM_WEB_ORIGIN="http://stam-web.test:9"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_MCP_AUTH_INSECURE STAM_WEB_ORIGIN STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
T=$(date +%s)
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")

PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
GOOD="good-$T"
REF="ref-$T"
FAKE_READY="$TEST_TMP/fake.ready"
FAKE_LOG="$TEST_TMP/fake.log"
: >"$FAKE_LOG"
FAKE_PORT=$PORT GOOD_TOKEN=$GOOD REFRESH_TOKEN=$REF FAKE_READY=$FAKE_READY FAKE_LOG=$FAKE_LOG \
  node "$ROOT/test/mcp-oauth-fake.mjs" &
FAKE_PID=$!
cleanup() { kill "$FAKE_PID" 2>/dev/null; stam_test_cleanup; }
trap cleanup EXIT

for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$FAKE_READY" ] && break; sleep 0.1; done
[ -s "$FAKE_READY" ] || fail "the fake MCP server didn't start"

# The daemon has a login for `fake`: a stale access_token the fake rejects, and the
# refresh_token the fake accepts.
python3 - "$STAM_HOME" "$PORT" "$REF" <<'PY'
import json, os, sys, time
home, port, ref = sys.argv[1:4]
s = json.load(open(f"{home}/settings.json"))
s["mcpServers"] = {"fake": {"url": f"http://127.0.0.1:{port}/mcp", "auth": {"type": "oauth"}}}
json.dump(s, open(f"{home}/settings.json", "w"), indent=2)
store = {"fake": {"server_url": f"http://127.0.0.1:{port}/mcp", "client_id": "stam",
                  "access_token": "stale-token", "refresh_token": ref,
                  "expires_at": int(time.time() * 1000) + 3600000,
                  "token_endpoint": f"http://127.0.0.1:{port}/token",
                  "resource": f"http://127.0.0.1:{port}/mcp"}}
path = f"{home}/mcp-auth.json"
open(path, "w").write(json.dumps(store, indent=2))
os.chmod(path, 0o600)
PY
[ "$(stat -c %a "$STAM_HOME/mcp-auth.json")" = "600" ] || fail "the token store is not 0600"

AID=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"proxy-$T\",\"role\":\"test\",\"harness\":\"external\"}" "$STAM_URL/api/register" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ -n "$AID" ] || fail "could not register an agent"

# initialize (JSON), a notification (silent 202), then tools/list (SSE), all through the
# proxy. Two requests carry an id, so two lines come back.
OUT=$(STAM_BIN="$STAM" STAM_AGENT_ID="$AID" STAM_URL="$STAM_URL" STAM_TOKEN="$TOKEN" \
  node "$ROOT/test/mcp-proxy-call.mjs" fake \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}') || fail "mcp-proxy-call did not get both answers"
echo "$OUT" | grep -q '"id":1' || fail "no initialize answer: $OUT"
echo "$OUT" | grep -q '"id":2' || fail "no tools/list answer: $OUT"
echo "$OUT" | grep -q '"ping"' || fail "tools/list did not carry the server's tools: $OUT"

# The stale token got a 401, the proxy refreshed, and the replayed requests arrived.
grep -qx '401' "$FAKE_LOG" || fail "the fake never saw the stale token (no 401)"
grep -qx 'refresh' "$FAKE_LOG" || fail "the proxy did not refresh after the 401"
grep -qx 'initialize' "$FAKE_LOG" || fail "initialize never reached the server"
grep -qx 'tools/list' "$FAKE_LOG" || fail "tools/list never reached the server after the session id"
grep -qx 'notification' "$FAKE_LOG" || fail "the notification never reached the server"

# The login URL comes from discovery + dynamic registration, with PKCE and a state, and the
# redirect uses the one canonical web origin (STAM_WEB_ORIGIN), not the request's Origin.
LOGIN=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H "Origin: $STAM_WEB_ORIGIN" "$STAM_URL/api/mcp/fake/login")
echo "$LOGIN" | grep -q '"url"' || fail "login returned no url: $LOGIN"
echo "$LOGIN" | grep -q 'code_challenge_method=S256' || fail "login url has no PKCE: $LOGIN"
echo "$LOGIN" | grep -q 'state=' || fail "login url has no state: $LOGIN"
echo "$LOGIN" | grep -q "redirect_uri=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote('$STAM_WEB_ORIGIN/oauth/callback', safe=''))")" || fail "login url has the wrong redirect: $LOGIN"

# An agent's token plus x-stam-human proves nothing: login and logout need the human.
code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" "$@"; }
[ "$(code -H 'x-stam-human: 1' "$STAM_URL/api/mcp/fake/login")" = 403 ] || fail "an agent's x-stam-human started a login"
[ "$(code -H 'x-stam-human: 1' "$STAM_URL/api/mcp/fake/logout")" = 403 ] || fail "an agent's x-stam-human logged out"
# A login whose Origin differs from the canonical web origin is refused.
[ "$(code -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'Origin: http://evil.example' "$STAM_URL/api/mcp/fake/login")" = 403 ] || fail "a login from a foreign Origin was allowed"
# The CLI cannot satisfy the human check, so it points at the web UI instead.
"$STAM" mcp login fake | grep -q 'web UI' || fail "stam mcp login did not point at the web UI"

# Status names the server without a token.
"$STAM" mcp status | grep -q '^fake' || fail "status did not list the auth server"
"$STAM" mcp status | grep -q 'logged in' || fail "status did not show it logged in"

# Logout (as the human) forgets the stored tokens.
curl -s -X POST -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$STAM_URL/api/mcp/fake/logout" >/dev/null
python3 -c "import json; assert 'fake' not in json.load(open('$STAM_HOME/mcp-auth.json'))" || fail "logout did not forget the tokens"

echo "PASS e2e-mcp-proxy"
