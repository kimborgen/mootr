#!/bin/sh
# The daemon's event stream end to end, free (no models): one isolated daemon. Opens
# GET /api/live, registers two agents, sends mail between them, reads it, and checks
# the events arrive with the right ids (S-456). Checks:
#   - a connected client gets agent.spawned and agent.changed as an agent registers
#   - mail.sent carries the id, from, to, thread, subject, and ask
#   - mail.read carries the mail id and the reader
#   - a subscription reading emits usage.changed
#   - GET /api/events still returns the external-event list (the stream has its own path)
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -sf -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }

# The event stream, read in the background into a file. curl -N keeps it unbuffered; the
# data lines are parsed below with grep -A1. Kill curl when the test ends (lib.sh stops the
# daemon either way, but this leaves no reader behind on failure).
STREAM="$TEST_TMP/events.log"
curl -sN -H "authorization: Bearer $TOKEN" "$STAM_URL/api/live" >"$STREAM" &
CURL_PID=$!
trap 'kill "$CURL_PID" 2>/dev/null; stam_test_cleanup' EXIT
connected() { grep -q '^: connected' "$STREAM"; }
wait_until connected || fail "the event stream never connected"

# The payload of one event type whose JSON carries `"id":"ID"` (the last one, if several).
payload() { grep -A1 "^event: $1\$" "$STREAM" | grep '^data: ' | sed 's/^data: //' | grep "\"id\":\"$2\"" | tail -1; }

# Registering two agents spawns them; the client sees agent.spawned, and agent.changed
# (register moves the new row from its 'starting' default to 'unknown').
ALICE=$(api -X POST -d '{"name":"alice","role":"test","harness":"claude"}' "$STAM_URL/api/register" | jget "d['id']")
BOB=$(api -X POST -d '{"name":"bob","role":"test","harness":"claude"}' "$STAM_URL/api/register" | jget "d['id']")
case "$ALICE$BOB" in '') fail "register returned no agent ids" ;; esac

spawned() { [ -n "$(payload agent.spawned "$ALICE")" ]; }
wait_until spawned || fail "no agent.spawned for $ALICE"
printf '%s' "$(payload agent.spawned "$ALICE")" | jget "d['name']" | grep -qx alice || fail "agent.spawned carries the wrong name"

changed() { [ -n "$(payload agent.changed "$ALICE")" ]; }
wait_until changed || fail "no agent.changed for $ALICE"
CHANGED=$(payload agent.changed "$ALICE")
[ "$(printf '%s' "$CHANGED" | jget "d['activity']")" = unknown ] || fail "agent.changed carries the wrong activity"
printf '%s' "$CHANGED" | jget "'state' in d and 'cost_usd' in d and 'unread' in d" | grep -qx True || fail "agent.changed is missing state, cost_usd, or unread"

# A mail between the two agents, then bob reads it.
MAIL=$(api -X POST -d "{\"from\":\"$ALICE\",\"to\":[\"$BOB\"],\"subject\":\"hello\",\"body\":\"a short note\"}" "$STAM_URL/api/mail")
MAILID=$(printf '%s' "$MAIL" | jget "d['id']")
case "$MAILID" in m*) ;; *) fail "no mail id: $MAIL" ;; esac

sent() { [ -n "$(payload mail.sent "$MAILID")" ]; }
wait_until sent || fail "no mail.sent for $MAILID"
SENT=$(payload mail.sent "$MAILID")
[ "$(printf '%s' "$SENT" | jget "d['from']")" = "$ALICE" ] || fail "mail.sent names the wrong sender"
[ "$(printf '%s' "$SENT" | jget "'$BOB' in d['to']")" = True ] || fail "mail.sent doesn't name the recipient"
[ "$(printf '%s' "$SENT" | jget "d['subject']")" = hello ] || fail "mail.sent carries the wrong subject"
[ -n "$(printf '%s' "$SENT" | jget "d['thread']")" ] || fail "mail.sent carries no thread"
[ "$(printf '%s' "$SENT" | jget "d['ask']")" = False ] || fail "mail.sent marks a mail to an agent as an ask"

api -X POST -d "{\"ids\":[\"$MAILID\"]}" "$STAM_URL/api/agents/$BOB/read" >/dev/null
was_read() { [ -n "$(payload mail.read "$MAILID")" ]; }
wait_until was_read || fail "no mail.read for $MAILID"
[ "$(payload mail.read "$MAILID" | jget "d['by']")" = "$BOB" ] || fail "mail.read names the wrong reader"

# A subscription reading notifies the web to refetch usage (the test-only cost hook).
api -X POST -d '{"action":"reading","name":"claude","windows":{"five_hour":{"used_percentage":42}}}' "$STAM_URL/api/test/cost" >/dev/null
usage_changed() { [ "$(grep -c '^event: usage.changed$' "$STREAM")" -ge 1 ]; }
wait_until usage_changed || fail "no usage.changed after a subscription reading"

# GET /api/events is untouched: the external-event list, not a stream (the stream is /api/live).
[ "$(api "$STAM_URL/api/events" | jget "type(d).__name__")" = list ] || fail "GET /api/events no longer returns the external-event list"

echo "PASS e2e-events"
