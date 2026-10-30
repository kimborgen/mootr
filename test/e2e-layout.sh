#!/bin/sh
# The daemon's layout (S-98), free (no agents, no models): against a throwaway daemon,
# GET /api/layout, PUT only while empty (409 after), POST ops all or none (400 for an invalid
# op, 409 with the current layout for a stale base, a repeated batch applied once), the stream's layout events on connect
# and after a change, the human-only check on writes, an agent's change (REST and the MCP
# tools, layout_get and layout_arrange) and its event, and persistence across a restart.
# Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
OUT="$TEST_TMP/resp.json"

# api METHOD PATH [BODY] [human]: prints the HTTP status, and leaves the response in $OUT.
api() {
  if [ "${4:-}" = human ]; then H=1; else H=0; fi
  curl -s -o "$OUT" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H "x-stam-human: $H" \
    -H 'content-type: application/json' -d "${3:-}" "$STAM_URL$2"
}
# check PYTHON-EXPR: the response's JSON (as d) satisfies the expression.
check() {
  python3 -c "import json,sys; d=json.load(open('$OUT')); sys.exit(0 if ($1) else 1)" || fail "$2: $(cat "$OUT")"
}

# A fresh daemon has an empty layout.
[ "$(api GET /api/layout)" = 200 ] || fail "GET /api/layout"
check "d['version'] == 0 and d['current'] is None and d['worlds'] == {} and d['agentWorlds'] == {}" "not an empty layout"

# PUT replaces an empty layout, once, and only for the human.
LAYOUT='{"layout":{"version":0,"current":"a1","agentWorlds":{"a1":{"root":{"id":"r1","tabs":["agent:a1"],"active":"agent:a1"},"focused":"r1"}},"worlds":{}}}'
[ "$(api PUT /api/layout "$LAYOUT")" = 403 ] || fail "PUT by a non-human should be 403"
[ "$(api PUT /api/layout "$LAYOUT" human)" = 200 ] || fail "PUT of an empty layout"
check "d['version'] == 1 and d['current'] == 'a1'" "PUT result"
[ "$(api PUT /api/layout "$LAYOUT" human)" = 409 ] || fail "a second PUT should be 409"
check "d['layout']['version'] == 1" "a refused PUT changed the layout"

# Ops apply as one batch, for the human only.
OPS='{"ops":[{"op":"open","world":"main","key":"agent:b1"},{"op":"open","world":"main","key":"agent:b2","pane":"r1","split":"right"}]}'
[ "$(api POST /api/layout/ops "$OPS")" = 403 ] || fail "POST ops by a non-human should be 403"
[ "$(api POST /api/layout/ops "$OPS" human)" = 200 ] || fail "POST ops"
check "d['version'] == 2 and d['agentWorlds']['a1']['root']['children'][1]['tabs'] == ['agent:b2']" "ops result"

# A stale base is a 409 carrying the current layout, and nothing changes.
[ "$(api POST /api/layout/ops '{"base":1,"ops":[{"op":"open","world":"main","key":"agent:c"}]}' human)" = 409 ] || fail "a stale base should be 409"
check "d['layout']['version'] == 2" "409 should carry the current layout"

# Atomic: the valid op before the invalid one doesn't apply.
[ "$(api POST /api/layout/ops '{"ops":[{"op":"open","world":"main","key":"agent:c"},{"op":"close","world":"main","key":"nope"}]}' human)" = 400 ] || fail "an unknown tab should be 400"
check "'no tab nope' in d['error']" "400 should name the problem"
[ "$(api GET /api/layout)" = 200 ]
check "d['version'] == 2 and 'agent:c' not in json.dumps(d)" "a failed batch changed the layout"

# A change that would leave a malformed tree is a 400 and changes nothing (it would be
# refused at the next start).
for BAD in '{"id":"r","split":"row","children":[{"id":"x","tabs":[],"active":null}],"sizes":[]}' '{"id":"r","split":"row","children":[{"id":"x","tabs":[],"active":null},{"id":"y","tabs":[],"active":null}],"sizes":["bad",1]}' '{"id":"r","split":"row","children":[{"id":"x","tabs":[],"active":null},{"id":"y","tabs":[],"active":null}],"sizes":[0,0]}'; do
  [ "$(api POST /api/layout/ops "{\"ops\":[{\"op\":\"setRoot\",\"world\":\"main\",\"root\":$BAD}]}" human)" = 400 ] || fail "a bad tree should be 400: $BAD"
done
[ "$(api GET /api/layout)" = 200 ]
check "d['version'] == 2 and d['agentWorlds']['a1']['root']['children'][1]['tabs'] == ['agent:b2']" "a refused tree changed the layout"

# A batch sent again (its reply was lost) applies once: the repeat gets the layout as it is,
# and the pane ids it names aren't made twice ("pd" is the new pane's id and the focus; agent:d its tab and active tab).
B='{"batch":"bt1","ops":[{"op":"open","world":"main","key":"agent:d","pane":"r1","split":"down","ids":["pd","sd"]}]}'
[ "$(api POST /api/layout/ops "$B" human)" = 200 ] || fail "POST a batch"
check "d['version'] == 3 and json.dumps(d).count(chr(34) + 'pd' + chr(34)) == 2" "the batch should apply once"
[ "$(api POST /api/layout/ops "$B" human)" = 200 ] || fail "a repeated batch should be 200"
check "d['version'] == 3 and json.dumps(d).count(chr(34) + 'pd' + chr(34)) == 2 and json.dumps(d).count('agent:d') == 2" "a repeated batch applied again"

# The stream: the layout on connect, and again after a change.
STREAM="$TEST_TMP/stream.out"
curl -sN -m 6 -H "authorization: Bearer $TOKEN" "$STAM_URL/api/layout/stream" >"$STREAM" &
SPID=$!
sleep 1
[ "$(api POST /api/layout/ops '{"ops":[{"op":"focus","world":"main","pane":"r1"}]}' human)" = 200 ] || fail "focus op"
wait $SPID || true
python3 - "$STREAM" <<'PY' || fail "the stream didn't send the layout on connect and after the change"
import json, sys
versions = [json.loads(l[6:])['version'] for l in open(sys.argv[1]) if l.startswith('data: ')]
assert versions[:1] == [3] and versions[-1] == 4, versions
PY

# Agents (S-100): an agent naming itself with `by` may change the layout over REST, and the
# change is logged as its event; without `by`, or with a PUT, an agent is still refused.
ANAME="layout-$$"
AID=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"$ANAME\",\"role\":\"caller\",\"harness\":\"external\"}" "$STAM_URL/api/register" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ -n "$AID" ] || fail "register an agent"
[ "$(api POST /api/layout/ops '{"ops":[{"op":"open","world":"main","key":"agent:d1"}]}')" = 403 ] || fail "POST ops with no human and no by should be 403"
[ "$(api POST /api/layout/ops "{\"by\":\"$AID\",\"ops\":[{\"op\":\"focus\",\"world\":\"main\",\"pane\":\"r1\"}]}")" = 200 ] || fail "an agent's POST ops"
check "d['version'] == 5" "an agent's change should be version 5"
[ "$(api PUT /api/layout "{\"by\":\"$AID\",\"layout\":{\"version\":0,\"current\":null,\"agentWorlds\":{},\"worlds\":{}}}")" = 403 ] || fail "PUT by an agent should be 403"
"$STAM" events "$ANAME" | grep -q 'layout {"summary":"focus pane r1 in main"}' || fail "the agent's change isn't logged as its event: $("$STAM" events "$ANAME")"

# The MCP tools (S-100): layout_get reads it, layout_arrange acts for the agent, and a stale
# base or an invalid op is an error that changes nothing.
mcp() {
  STAM_BIN="$STAM" with_agent_id "$AID" node "$ROOT/test/mcp-call.mjs" \
    "$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$1" "$2")" |
    python3 -c 'import json,sys
m = json.load(sys.stdin); r = m.get("result", {})
t = r.get("content", [{}])[0].get("text", "")
if r.get("isError"): print("ERROR " + t); sys.exit(0)
print(t)'
}
G=$(mcp layout_get '{}')
echo "$G" | grep -q 'Layout version 5' || fail "layout_get: $G"
echo "$G" | grep -q 'pane r1 (focused)' || fail "layout_get doesn't show the focused pane: $G"
A=$(mcp layout_arrange '{"base":5,"ops":[{"op":"open","world":"main","key":"usage","split":"right"}]}')
echo "$A" | grep -q 'Layout version 6' || fail "layout_arrange: $A"
[ "$(api GET /api/layout)" = 200 ]
check "d['version'] == 6 and 'usage' in json.dumps(d['agentWorlds']['a1'])" "layout_arrange didn't change the daemon's layout"
A=$(mcp layout_arrange '{"base":5,"ops":[{"op":"focus","world":"main","pane":"r1"}]}')
echo "$A" | grep -q '^ERROR .*version 6' || fail "a stale base should be an error: $A"
A=$(mcp layout_arrange '{"ops":[{"op":"close","world":"main","key":"nope"}]}')
echo "$A" | grep -q '^ERROR .*no tab nope' || fail "an invalid op should be an error: $A"
[ "$(api GET /api/layout)" = 200 ]
check "d['version'] == 6" "a refused arrange changed the layout"

# Persistence: the file exists, and a restarted daemon serves the same layout.
[ -f "$STAM_HOME/layout.json" ] || fail "no layout.json in $STAM_HOME"
api GET /api/layout >/dev/null
cp "$OUT" "$TEST_TMP/before.json"
on main "$STAM" daemon stop >/dev/null 2>&1 || true
daemon_up main
api GET /api/layout >/dev/null
cmp -s "$OUT" "$TEST_TMP/before.json" || fail "the layout changed across a restart"
echo "PASS: layout (GET, PUT once, ops all or none, 409 on a stale base, stream, agent ops and MCP tools, persistence)"
