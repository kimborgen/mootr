#!/bin/sh
# watch_pr end to end, free (no models, no real GitHub): one isolated daemon polls a fake GitHub
# API (test/fixtures/fake-github.mjs). An agent calls the watch_pr tool (src/mcp.ts) on PR #1;
# the PR's only checks are commit statuses, as our gates post them. Checks:
#   - the watch makes one subscription on github:o/r#1, ending on the merge or close
#   - the first poll records the PR silently
#   - a failing status (no check runs) fires checks.completed, and the agent hears it as mail
#   - the merge is delivered, and it ends the watch: the subscription is gone
# Run by hand or by test/run.sh e2e-watch-pr.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }

daemon_home main
# A fold window short enough that the delivery lands soon after the poll (the default is 20 s).
printf "export STAM_EVENT_FOLD_MS=1500\nexport STAM_GITHUB_TOKEN=test-token\n" >>"$TEST_TMP/main/test.env"
printf '{ "peers": [], "watch": { "githubSeconds": 1 } }\n' >"$TEST_TMP/main/settings.json"

# The fake GitHub API, started before the daemon so its url is known. It is killed by PID.
node "$ROOT/test/fixtures/fake-github.mjs" "$TEST_TMP/" >"$TEST_TMP/fake.out" 2>&1 &
FAKE_PID=$!
cleanup_fake() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; }
trap 'cleanup_fake; stam_test_cleanup' EXIT INT TERM HUP
GITHUB=""
for _i in 1 2 3 4 5 6 7 8 9 10; do
  GITHUB=$(sed -n 's/^URL=//p' "$TEST_TMP/fake.out")
  [ -n "$GITHUB" ] && break
  sleep 0.3
done
[ -n "$GITHUB" ] || fail "the fake GitHub API didn't start"
printf "export STAM_GITHUB_API=%s\n" "$GITHUB" >>"$TEST_TMP/main/test.env"

# PR #1 is open on sha1, its one gate a pending status.
control() { curl -s -X POST -H 'content-type: application/json' -d "$1" "$GITHUB/_control" >/dev/null; }
control '{"issues":{"o/r#1":{"number":1,"title":"PR one","state":"open","html_url":"https://github.com/o/r/pull/1","user":{"login":"octocat"},"pull_request":{"url":"x"}}},"pulls":{"o/r#1":{"number":1,"title":"PR one","state":"open","merged":false,"draft":false,"html_url":"https://github.com/o/r/pull/1","user":{"login":"octocat"},"head":{"sha":"sha1","ref":"feature"},"base":{"ref":"main"}}},"statuses":{"o/r@sha1":{"state":"pending","statuses":[{"context":"stam/gates","state":"pending","updated_at":"2026-10-13T10:00:00Z","created_at":"2026-10-13T10:00:00Z"}]}}}'

use main
daemon_up main
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
get() { curl -s -H "authorization: Bearer $TOKEN" "$1"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
count() { python3 -c "import json,sys; print(len(json.load(sys.stdin)))"; }
state_field() { python3 -c "import json,sys; print((json.load(sys.stdin).get('github:o/r#1') or {}).get('$1') or '')"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }

A=$(reg alice)
hook "$A" '{"hook_event_name":"UserPromptSubmit"}'; hook "$A" '{"hook_event_name":"Stop","last_assistant_message":"ready"}'

echo "-- the watch_pr tool makes one subscription on PR #1, ending on the merge"
# The tool runs as alice would call it: over stdio, through `stam mcp`, against this daemon.
STAM_BIN="$STAM" with_agent_id "$A" node "$ROOT/test/mcp-call.mjs" "$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"watch_pr","arguments":{"self":sys.argv[1],"pr":"o/r#1"}}}))' "$A")" >"$TEST_TMP/watch.out" || fail "watch_pr failed: $(cat "$TEST_TMP/watch.out")"
[ "$(api GET "/api/subscriptions?by=$A" | count)" = 1 ] || fail "watch_pr made no single subscription"
api GET "/api/subscriptions?by=$A" | python3 -c "
import json,sys
s = json.load(sys.stdin)[0]
assert s['filter']['subjects'] == ['github:o/r#1'], s
assert 'pull_request.merged' in s['filter']['ends_on'], s
assert 'checks.completed' in s['filter']['types'], s
" || fail "the subscription doesn't match the watch"

echo "-- the first poll records the PR silently"
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  CHECKS=$(get "$STAM_URL/api/watch/state?subject=github:o/r%231" | state_field checks)
  [ "$CHECKS" = pending ] && break
  sleep 0.5
done
[ "$CHECKS" = pending ] || fail "the first poll didn't record the PR (checks=$CHECKS)"
[ "$(get "$STAM_URL/api/events?subject=github:o/r%231" | count)" = 0 ] || fail "the first poll emitted an event"

echo "-- the gate status fails: checks.completed reaches alice as mail"
# The poller stamps each event with when it happened, and the watch only relays changes after it
# began (S-795): this status must be newer than the watch, so it uses the current time.
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
control "{\"statuses\":{\"o/r@sha1\":{\"state\":\"failure\",\"statuses\":[{\"context\":\"stam/gates\",\"state\":\"failure\",\"updated_at\":\"$NOW\",\"created_at\":\"$NOW\"}]}}}"
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  N=$(get "$STAM_URL/api/mail/search?box=$A&q=checks%20failed%3A%20stam%2Fgates" | count)
  [ "$N" -ge 1 ] 2>/dev/null && break
  sleep 0.5
done
[ "$(get "$STAM_URL/api/mail/search?box=$A&q=checks%20failed%3A%20stam%2Fgates" | count)" -ge 1 ] || fail "alice didn't hear the failing gate"

echo "-- the merge is delivered and ends the watch"
control '{"issues":{"o/r#1":{"updated_at":"2026-10-13T11:00:00Z"}},"pulls":{"o/r#1":{"merged":true,"state":"closed"}}}'
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ "$(api GET "/api/subscriptions?by=$A" | count)" = 0 ] && break
  sleep 0.5
done
[ "$(api GET "/api/subscriptions?by=$A" | count)" = 0 ] || fail "the merge didn't end the watch"
[ "$(get "$STAM_URL/api/events?subject=github:o/r%231" | python3 -c 'import json,sys; print(sum(1 for e in json.load(sys.stdin) if e["type"]=="pull_request.merged"))')" = 1 ] || fail "the merge event wasn't stored"

echo "PASS e2e-watch-pr"
