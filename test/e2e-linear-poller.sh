#!/bin/sh
# The Linear poller end to end, free (no models, no real Linear): one isolated daemon polls a
# fake Linear MCP server (test/fixtures/fake-linear.mjs) through its `linear` MCP entry, with a
# login seeded in the daemon's token store. An ITSA linked to a Linear issue is subscribed by
# stam, so when the fake's issue changes state, the ITSA's thread hears it. Checks:
#   - the first poll records the issue silently (no event, state Todo)
#   - a state change emits issue.state_changed once, and the state view reports it
#   - the ITSA linked to the issue gets the event in its thread
set -e
STAM_MCP_AUTH_INSECURE=1
export STAM_MCP_AUTH_INSECURE
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }

daemon_home main
# A fold window short enough that the ITSA post lands soon after the poll (the default is 20 s).
printf "export STAM_EVENT_FOLD_MS=1500\nexport STAM_MCP_AUTH_INSECURE=1\n" >>"$TEST_TMP/main/test.env"

# The fake Linear MCP server, started before the daemon so its url is known. Killed by PID.
node "$ROOT/test/fixtures/fake-linear.mjs" >"$TEST_TMP/fake.out" 2>&1 &
FAKE_PID=$!
cleanup_fake() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; }
trap 'cleanup_fake; stam_test_cleanup' EXIT INT TERM HUP
LINEAR=""
for _i in 1 2 3 4 5 6 7 8 9 10; do
  LINEAR=$(sed -n 's/^URL=//p' "$TEST_TMP/fake.out")
  [ -n "$LINEAR" ] && break
  sleep 0.3
done
[ -n "$LINEAR" ] || fail "the fake Linear MCP server didn't start"

# The `linear` MCP server, pointed at the fake, with a login the fake accepts (its bearer is `good`).
python3 - "$TEST_TMP/main" "$LINEAR" <<'PY'
import json, os, sys, time
home, url = sys.argv[1:3]
s = json.load(open(f"{home}/settings.json"))
s["mcpServers"] = {"linear": {"url": url, "auth": {"type": "oauth"}}}
s["watch"] = {"githubSeconds": 0, "linearSeconds": 1}
json.dump(s, open(f"{home}/settings.json", "w"), indent=2)
store = {"linear": {"server_url": url, "client_id": "stam", "access_token": "good",
                    "expires_at": int(time.time() * 1000) + 3600000, "resource": url}}
path = f"{home}/mcp-auth.json"
open(path, "w").write(json.dumps(store, indent=2))
os.chmod(path, 0o600)
PY

# Seed ENG-1 in Todo, with no comments.
CONTROL="${LINEAR%/mcp}/_control"
curl -s -X POST -H 'content-type: application/json' \
  -d '{"issues":{"ENG-1":{"id":"ENG-1","title":"Fix login","url":"https://linear.app/acme/issue/ENG-1/fix-login","state":{"name":"Todo"},"assignee":null,"priority":{"name":"High","value":2},"updatedAt":"2026-10-11T10:00:00Z"}}}' \
  "$CONTROL" >/dev/null

use main
daemon_up main
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
get() { curl -s -H "authorization: Bearer $TOKEN" "$1"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
state_field() { python3 -c "import json,sys; print((json.load(sys.stdin).get('linear:ENG-1') or {}).get('$1') or '')"; }
control() { curl -s -X POST -H 'content-type: application/json' -d "$1" "$CONTROL" >/dev/null; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }
# An agent that is working, so the ITSA's thread can be posted to as stam (as the GitHub e2e does).
A=$(reg alice)
hook "$A" '{"hook_event_name":"UserPromptSubmit"}'

# The ITSA is linked to the issue; stam subscribes it to linear:ENG-1.
KEY=$("$STAM" itsa new "Watch ENG-1" | awk '{print $1}')
"$STAM" itsa link "$KEY" "https://linear.app/acme/issue/ENG-1/fix-login" >/dev/null

echo "-- the first poll records the issue silently"
STATE=""
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  STATE=$(get "$STAM_URL/api/watch/state?subject=linear:ENG-1" | state_field state)
  [ "$STATE" = Todo ] && break
  sleep 0.5
done
[ "$STATE" = Todo ] || fail "the first poll didn't record the issue (state=$STATE)"
[ "$(get "$STAM_URL/api/events?subject=linear:ENG-1" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = 0 ] || fail "the first poll emitted an event"

echo "-- the state moves: one issue.state_changed, and the ITSA thread hears it"
control '{"issues":{"ENG-1":{"state":{"name":"In Progress"},"updatedAt":"2026-10-11T11:00:00Z"}}}'
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ "$(get "$STAM_URL/api/events?subject=linear:ENG-1" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" -ge 1 ] && break
  sleep 0.5
done
EVENTS=$(get "$STAM_URL/api/events?subject=linear:ENG-1")
[ "$(echo "$EVENTS" | python3 -c 'import json,sys; print(len([e for e in json.load(sys.stdin) if e["type"]=="issue.state_changed"]))')" = 1 ] || fail "expected one issue.state_changed: $EVENTS"

STATE=$(get "$STAM_URL/api/watch/state?subject=linear:ENG-1" | state_field state)
[ "$STATE" = "In Progress" ] || fail "the state view doesn't report the new state (state=$STATE)"

for _i in 1 2 3 4 5 6 7 8 9 10; do
  get "$STAM_URL/api/itsas/$KEY/thread" >"$TEST_TMP/thread.json"
  python3 -c "
import json, sys
items = json.load(open('$TEST_TMP/thread.json'))['items']
mails = [i['mail']['body'] for i in items if i['type'] == 'mail']
sys.exit(0 if any('ENG-1 state: Todo → In Progress' in b for b in mails) else 1)
" && break
  sleep 0.5
done
python3 -c "
import json
items = json.load(open('$TEST_TMP/thread.json'))['items']
mails = [i['mail']['body'] for i in items if i['type'] == 'mail']
assert any('ENG-1 state: Todo → In Progress' in b for b in mails), mails
" || fail "the ITSA thread didn't get the state change"

echo "PASS e2e-linear-poller"
