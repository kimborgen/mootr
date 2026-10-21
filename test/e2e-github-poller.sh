#!/bin/sh
# The GitHub poller end to end, free (no models, no real GitHub): one isolated daemon polls a
# fake GitHub API (test/fixtures/fake-github.mjs) whose url a test env var points at. An ITSA
# linked to a pull request is subscribed by stam, and an agent's event wait watches the same
# subject; the fake completes the checks, and both hear: the wait clears with a notice, and
# the ITSA thread gets the event. Checks:
#   - the first poll records the snapshot silently (no event)
#   - a checks completion emits checks.completed with the failing name
#   - the agent's event wait clears and its notice names the change
#   - the ITSA linked to the PR gets the event in its thread
#   - GET /api/watch/state reports the PR's fields
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }

daemon_home main
# A fold window short enough that the ITSA post lands soon after the poll (the default is 20 s).
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

# Seed an open PR #1 on sha1, its checks still running.
python3 - "$GITHUB" <<'PY'
import json, sys, urllib.request
url = sys.argv[1]
data = {
  "issues": {"o/r#1": {"number": 1, "title": "PR one", "state": "open", "html_url": "https://github.com/o/r/pull/1", "user": {"login": "octocat"}, "pull_request": {"url": "x"}}},
  "pulls": {"o/r#1": {"number": 1, "title": "PR one", "state": "open", "merged": False, "draft": False, "html_url": "https://github.com/o/r/pull/1", "user": {"login": "octocat"}, "head": {"sha": "sha1", "ref": "feature"}, "base": {"ref": "main"}}},
  "checkRuns": {"o/r@sha1": [{"name": "build", "status": "in_progress", "conclusion": None}]},
  "statuses": {"o/r@sha1": {"state": "pending", "statuses": []}},
  "reviews": {"o/r#1": []},
  "comments": {"o/r#1": []},
}
req = urllib.request.Request(url + "/_control", data=json.dumps(data).encode(), headers={"content-type": "application/json"}, method="POST")
urllib.request.urlopen(req).read()
PY

use main
daemon_up main
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
get() { curl -s -H "authorization: Bearer $TOKEN" "$1"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
count() { python3 -c "import json,sys; print(len(json.load(sys.stdin)))"; }
# The state view for PR #1, so a not-yet-polled subject (no `checks` key) reads empty.
state_field() { python3 -c "import json,sys; print((json.load(sys.stdin).get('github:o/r#1') or {}).get('$1') or '')"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
control() { curl -s -X POST -H 'content-type: application/json' -d "$1" "$GITHUB/_control" >/dev/null; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }

A=$(reg alice)
hook "$A" '{"hook_event_name":"UserPromptSubmit"}'; hook "$A" '{"hook_event_name":"Stop","last_assistant_message":"ready"}'

# The agent waits for the checks to finish on PR #1; an ITSA is linked to the same PR.
W=$(api POST "/api/agents/$A/waits/declared" '{"on":"event","filter":{"source":"github","subjects":["github:o/r#1"],"types":["checks.completed"]},"note":"checks on PR 1"}' | field '["id"]')
case "$W" in w*) ;; *) fail "no wait id: $W" ;; esac
KEY=$("$STAM" itsa new "Watch PR 1" | awk '{print $1}')
"$STAM" itsa link "$KEY" "https://github.com/o/r/pull/1" >/dev/null

echo "-- the first poll records the snapshot silently"
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  CHECKS=$(get "$STAM_URL/api/watch/state?subject=github:o/r%231" | state_field checks)
  [ "$CHECKS" = pending ] && break
  sleep 0.5
done
[ "$CHECKS" = pending ] || fail "the first poll didn't record the PR (checks=$CHECKS)"
[ "$(get "$STAM_URL/api/events?subject=github:o/r%231" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = 0 ] || fail "the first poll emitted an event"
[ "$(api GET "/api/agents/$A/waits" | count)" = 1 ] || fail "the wait cleared before the checks finished"

echo "-- the checks finish: the event clears the wait and posts to the ITSA thread"
control '{"checkRuns":{"o/r@sha1":[{"name":"build","status":"completed","conclusion":"failure"}]},"statuses":{"o/r@sha1":{"state":"success","statuses":[]}}}'
for _i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  [ "$(api GET "/api/agents/$A/waits" | count)" = 0 ] && break
  sleep 0.5
done
[ "$(api GET "/api/agents/$A/waits" | count)" = 0 ] || fail "the event wait didn't clear on the checks completion"

NOTICE=$(api POST "/api/hook/claude/$A" '{"hook_event_name":"PostToolUse"}' | field '["stdout"]')
echo "$NOTICE" | grep -q "checks failed: build" || fail "the notice doesn't name the failing check: $NOTICE"

# The state view reports the failure for the dashboard (S-65).
STATE=$(get "$STAM_URL/api/watch/state?subject=github:o/r%231")
[ "$(echo "$STATE" | state_field checks)" = failure ] || fail "the state view doesn't report the failure"
[ "$(echo "$STATE" | state_field state)" = open ] || fail "the state view doesn't report the PR state"
[ "$(echo "$STATE" | state_field title)" = "PR one" ] || fail "the state view doesn't report the title"

# The ITSA thread got the folded event (its link subscribed it on github:o/r#1).
for _i in 1 2 3 4 5 6 7 8 9 10; do
  N=$(get "$STAM_URL/api/itsas/$KEY/thread" | python3 -c 'import json,sys; print(len([i for i in json.load(sys.stdin)["items"] if i["type"]=="mail"]))')
  [ "$N" -ge 1 ] && break
  sleep 0.5
done
get "$STAM_URL/api/itsas/$KEY/thread" >"$TEST_TMP/thread.json"
python3 -c "
import json
items = json.load(open('$TEST_TMP/thread.json'))['items']
mails = [i['mail']['body'] for i in items if i['type'] == 'mail']
assert any('checks failed: build' in b for b in mails), mails
" || fail "the ITSA thread didn't get the checks event"

echo "PASS e2e-github-poller"
