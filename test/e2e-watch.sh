#!/bin/sh
# External-event service end to end, free (no models): one isolated daemon. Subscribes a
# registered agent row and an ITSA, POSTs events through /api/events, and checks that the
# folded mail reaches the agent and the post reaches the ITSA's thread. The fold window is
# shortened (STAM_EVENT_FOLD_MS) so the test doesn't wait the default 20 s, and it polls for the
# folded mail rather than sleeping. Checks:
#   - a duplicate dedupe_key is stored once and delivered once
#   - events within the fold window arrive as one message listing each summary and url
#   - a subject outside the filter is not delivered
#   - an ITSA subscription posts into the ITSA thread
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
# A fold window long enough that all the events posted below land in one batch, and short
# enough not to slow the test; the default is 20 s.
printf "export STAM_EVENT_FOLD_MS=5000\n" >>"$TEST_TMP/main/test.env"
use main
daemon_up main
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -sf -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
reg() { api -X POST -d "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" "$STAM_URL/api/register" | jget "d['id']"; }
event() { api -X POST -d "$1" "$STAM_URL/api/events" >/dev/null; }

ALICE=$(reg alice)

# The agent subscribing itself, and an ITSA (owned by the human) alice takes part in.
SUB=$(api -X POST -d "{\"subscriber_kind\":\"agent\",\"subscriber_id\":\"$ALICE\",\"filter\":{\"source\":\"github\",\"subjects\":[\"github:o/*\"]},\"by\":\"$ALICE\"}" "$STAM_URL/api/subscriptions" | jget "d['id']")
case "$SUB" in es-*) ;; *) fail "no subscription id: $SUB" ;; esac
KEY=$("$STAM" itsa new "Watch the repo" --participant alice | awk '{print $1}')
ITSAID=$(api "$STAM_URL/api/itsas/$KEY" | jget "d['id']")
api -X POST -d "{\"subscriber_kind\":\"itsa\",\"subscriber_id\":\"$ITSAID\",\"filter\":{\"source\":\"github\"},\"by\":\"$ALICE\",\"note\":\"repo watch\"}" "$STAM_URL/api/subscriptions" >/dev/null

# Two matching events (one url each) and a duplicate of the first, then one outside the filter.
event '{"source":"github","type":"pull_request.opened","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/1","summary":"opened one","dedupe_key":"d1"}'
event '{"source":"github","type":"pull_request.opened","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/1","summary":"opened one","dedupe_key":"d1"}'
event '{"source":"github","type":"pull_request.synchronize","subjects":["github:o/r#1"],"actor":"octocat","url":"https://x/2","summary":"synced one","dedupe_key":"d2"}'
event '{"source":"github","type":"push","subjects":["github:other/r"],"summary":"elsewhere","dedupe_key":"d3"}'
# Wait for the fold window to close and the folded mail to land: the agent's inbox holds one mail.
inbox_has_one() { [ "$(api "$STAM_URL/api/agents/$ALICE/inbox" | jget "len(d)")" = 1 ]; }
wait_until inbox_has_one

# The duplicate is stored once: three events (d1, d2, d3), not four; d3 is stored though it
# matches no subscription (events are stored; only delivery filters).
[ "$(api "$STAM_URL/api/events" | jget "len(d)")" = 3 ] || fail "the duplicate dedupe_key was stored again"
[ "$(api "$STAM_URL/api/events?subject=github:o/r%231" | jget "len(d)")" = 2 ] || fail "the subject filter didn't find the two events"

# The agent got one folded mail naming both summaries and their urls, and not the filtered-out one.
api "$STAM_URL/api/agents/$ALICE/inbox" >"$TEST_TMP/inbox.json"
[ "$(jget "len(d)" <"$TEST_TMP/inbox.json")" = 1 ] || fail "the burst wasn't folded into one mail"
MAILID=$(jget "d[0]['id']" <"$TEST_TMP/inbox.json")
api -X POST -d "{\"ids\":[\"$MAILID\"]}" "$STAM_URL/api/agents/$ALICE/read" >"$TEST_TMP/mail.json"
BODY=$(jget "d[0]['body']" <"$TEST_TMP/mail.json")
echo "$BODY" | grep -q "opened one" || fail "the first event's summary is missing"
echo "$BODY" | grep -q "synced one" || fail "the second event's summary is missing"
echo "$BODY" | grep -q "https://x/2" || fail "an event's url is missing"
echo "$BODY" | grep -q "elsewhere" && fail "an event outside the filter was delivered"

# The ITSA subscription posted into the ITSA's thread.
api "$STAM_URL/api/itsas/$KEY/thread" >"$TEST_TMP/thread.json"
[ "$(jget "len([i for i in d['items'] if i['type']=='mail'])" <"$TEST_TMP/thread.json")" = 1 ] || fail "no single post in the ITSA thread"
jget "[i['mail']['body'] for i in d['items'] if i['type']=='mail'][0]" <"$TEST_TMP/thread.json" | grep -q "opened one" || fail "the ITSA post doesn't carry the event"

# Both subscriptions are listed for the human.
[ "$(api -H 'x-stam-human: 1' "$STAM_URL/api/subscriptions" | jget "len(d)")" = 2 ] || fail "the two subscriptions aren't listed"

echo "PASS e2e-watch"
