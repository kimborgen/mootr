#!/bin/sh
# Routes an agent's own token can't use (S-587), free (no models): a scripted Claude Code agent
# (test/fake-claude) for a real agent token, on its own daemon (test/lib.sh), with a stub peer.
#   - an agent's token is refused (403) on the merge queue, what waits on the human, an ITSA's cost,
#     the event log, and the retro digest; the shared token (the human's CLI) still reads them
#   - the same on a daemon that isn't the ITSA home, for the OpenCode server's token too, which the proxy
#     would forward with no identity
#   - an agent's token can't read another agent's view, view history, event log, files, instructions
#     or inventory (its own and its tree's it can), nor the daemon's event stream; the shared token can
#   - the per-agent routes (src/agent-routes.ts): a parent and the human read a child's files, instructions,
#     inventory, events and inbox; an unrelated token can't; any agent's token reads another's waits (policy:
#     waits are coordination data between one user's agents, S-1900)
#   - the shared token reading /api/agents/NAME/threads asks a peer for the id this daemon resolved,
#     never for NAME, which could be another mailbox there
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/scope.json" <<'EOT'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOT
fake_claude "$TEST_TMP/scope.json"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
daemon_home main
daemon_home edge
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 - "$PORT" "$TEST_TMP/stub-paths" >"$TEST_TMP/stub.log" 2>&1 <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        open(sys.argv[2], "a").write(self.path + "\n")
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b"[]")
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
STUB=$!
trap 'kill $STUB 2>/dev/null; wait $STUB 2>/dev/null || true; stam_test_cleanup' EXIT
python3 - "$TEST_TMP" "$PORT" <<'PY'
import json, sys
path = f"{sys.argv[1]}/main/settings.json"
s = json.load(open(path))
s["peers"] = [{"name": "far", "url": f"http://127.0.0.1:{sys.argv[2]}", "token": "x"}]
json.dump(s, open(path, "w"), indent=2)
PY
# edge: a daemon that isn't the ITSA home, so it proxies ITSA routes to far.
python3 - "$TEST_TMP" "$PORT" <<'PY'
import json, sys
path = f"{sys.argv[1]}/edge/settings.json"
s = json.load(open(path))
s["peers"] = [{"name": "far", "url": f"http://127.0.0.1:{sys.argv[2]}", "token": "x"}]
s["itsa"] = {"home": "far"}
json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up edge
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
api() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
"$STAM" spawn bob --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait bob --until idle --timeout 60
BOB=$(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/bob" | jget "d['id']")
BT=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$BOB" STAM_TOKEN | cut -d= -f2-)
[ -n "$BT" ] || fail "bob has no token"
as_bob() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $BT" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
"$STAM" spawn amy --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait amy --until idle --timeout 60
AMY=$(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/amy" | jget "d['id']")
AT=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$AMY" STAM_TOKEN | cut -d= -f2-)
[ -n "$AT" ] || fail "amy has no token"
as_amy() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $AT" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
"$STAM" spawn kid --parent bob --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait kid --until idle --timeout 60
KEY=$("$STAM" itsa new "Scope probe" | awk '{print $1}')

echo "-- an agent's token is refused; the shared token still reads and sends"
for r in "GET /api/itsas/queue" "GET /api/itsas/attention" "GET /api/itsas/$KEY/cost" "GET /api/events" "POST /api/retros/digest {}"; do
  set -- $r
  [ "$(as_bob "$1" "$2" "$3")" = 403 ] || fail "bob's token wasn't refused on $1 $2"
  [ "$(api "$1" "$2" "$3")" = 200 ] || fail "the shared token was refused on $1 $2"
done
# What an agent legitimately uses stays open.
for p in "/api/itsas" "/api/itsas/$KEY" "/api/itsas/fields" "/api/itsas/statuses"; do
  [ "$(as_bob GET "$p")" = 200 ] || fail "bob's token was refused on GET $p"
done

echo "-- an agent's token can't read another agent's view, history or events, nor the event stream"
for p in "/api/agents/amy/view/history" "/api/agents/amy/view" "/api/agents/amy/view/tools?mail=nope" "/api/agents/amy/events" "/api/agents/amy/files" "/api/agents/amy/instructions" "/api/agents/amy/inventory" "/api/live"; do
  [ "$(as_bob GET "$p")" = 403 ] || fail "bob's token wasn't refused on GET $p"
done
[ "$(api GET /api/agents/amy/view/history)" = 200 ] || fail "the shared token couldn't read amy's history"
# The tool slice passes the same check: a mail that isn't there answers 404, not 403.
[ "$(as_bob GET "/api/agents/bob/view/tools?mail=nope")" = 404 ] || fail "bob couldn't reach its own view/tools"
[ "$(api GET "/api/agents/amy/view/tools?mail=nope")" != 403 ] || fail "the shared token was refused on amy's view/tools"
[ "$(api GET /api/agents/amy/events)" = 200 ] || fail "the shared token couldn't read amy's events"
[ "$(as_bob GET /api/agents/bob/events)" = 200 ] || fail "bob couldn't read its own events"
[ "$(as_bob GET /api/agents/bob/view/history)" = 200 ] || fail "bob couldn't read its own history"
for r in files instructions inventory; do
  [ "$(as_bob GET "/api/agents/bob/$r")" = 200 ] || fail "bob couldn't read its own $r"
  [ "$(api GET "/api/agents/amy/$r")" = 200 ] || fail "the shared token couldn't read amy's $r"
done
[ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$STAM_URL/api/live" || true)" = 200 ] || fail "the shared token couldn't open the event stream"

echo "-- the per-agent routes (src/agent-routes.ts): an ancestor and the human read what an unrelated agent can't"
human() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' "$STAM_URL$1"; }
for r in files instructions inventory events inbox; do
  [ "$(as_bob GET "/api/agents/kid/$r")" = 200 ] || fail "bob, kid's parent, couldn't read kid's $r"
  [ "$(as_amy GET "/api/agents/kid/$r")" = 403 ] || fail "amy's token wasn't refused on kid's $r"
  [ "$(human "/api/agents/amy/$r")" = 200 ] || fail "the human couldn't read amy's $r"
done
[ "$(as_amy GET /api/agents/bob/waits)" = 200 ] || fail "amy's token was refused on bob's waits, which are open to every agent token"
echo "-- off the ITSA home, an agent's token and the OpenCode server's are refused before the proxy"
use edge
ETOKEN=$(cat "$STAM_HOME/token")
"$STAM" spawn oc --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait oc --until idle --timeout 60
OCT=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t _opencode STAM_TOKEN | cut -d= -f2-)
[ -n "$OCT" ] || fail "the OpenCode server has no token"
for p in /api/itsas/queue /api/itsas/attention /api/itsas/S-1/cost; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $OCT" "$STAM_URL$p")" = 403 ] || fail "the OpenCode server's token wasn't refused on $p"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $ETOKEN" "$STAM_URL$p")" = 200 ] || fail "the shared token wasn't proxied on $p"
done
use main

echo "-- a peer is asked for the resolved id, not NAME"
: >"$TEST_TMP/stub-paths"
[ "$(api GET /api/agents/bob/threads)" = 200 ] || fail "the shared token couldn't read bob's threads"
grep -q "^/api/agents/$BOB/threads" "$TEST_TMP/stub-paths" || fail "the peer wasn't asked for bob's id ($(cat "$TEST_TMP/stub-paths"))"
grep -q "^/api/agents/bob/threads" "$TEST_TMP/stub-paths" && fail "the peer was asked to resolve bob"
echo "ok: token scope"
