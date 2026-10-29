#!/bin/sh
# An ask in its home thread over HTTP (S-3827): POST /api/permissions with `thread` puts the ask in that thread, to the
# human only; an unreadable `thread` is a 400 that stores nothing; an ask with no home goes to a new thread and its
# answer carries a hint. A pending ask placed in a thread survives a daemon restart and is answered there; the
# human's thread read shows Approve and Deny's request on it, among the thread's other mail. Free and no models:
# registered agents plus the permission and mail API, against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$1" -d "$2"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
mail() { api POST /api/mail "$1" | field '["id"]'; }
count() { api GET /api/permissions | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
fail() { echo "FAIL: $1"; exit 1; }

A=$(reg alice)
B=$(reg bob)
C=$(reg carol)
M1=$(mail '{"from":"bob","to":["alice"],"subject":"Release plan","body":"Ship on Friday?","new_thread":true}')
M2=$(mail "{\"from\":\"bob\",\"to\":[\"human\"],\"subject\":\"Re: Release plan\",\"body\":\"FYI, alice is on it.\",\"reply_to\":\"$M1\"}")
HIDDEN=$(mail '{"from":"bob","to":["carol"],"subject":"Not for alice","body":"x","new_thread":true}')

echo "-- an ask with thread goes in that thread, to the human only"
R=$(api POST /api/permissions "{\"agent\":\"$A\",\"action\":\"git push origin main\",\"reason\":\"auto mode blocks it\",\"audience\":\"human\",\"thread\":\"$M1\"}" | field '["id"]')
T=$(hapi GET "/api/threads/$M1")
printf %s "$T" | python3 -c "
import json, sys
ms = json.load(sys.stdin)
ask = [m for m in ms if m.get('permission_id') == '$R']
assert len(ask) == 1, ms
assert ask[0]['thread_id'] == '$M1', ask[0]
assert [r['id'] for r in ask[0]['recipients']] == ['human'], ask[0]['recipients']
assert ask[0]['permission']['status'] == 'pending', ask[0]
assert len(ms) == 3, [m['id'] for m in ms]
" || fail "the ask isn't in thread $M1 as the human's only: $T"

echo "-- bob, in the thread, doesn't see the ask"
BT=$(api GET "/api/threads/$M1?box=$B")
printf %s "$BT" | grep -q "$R" && fail "bob's thread read shows the ask: $BT"
printf %s "$BT" | grep -q "$M2" || fail "bob's thread read lost his own mail: $BT"

echo "-- an unreadable thread is a 400 that stores nothing"
N=$(count)
[ "$(code /api/permissions "{\"agent\":\"$A\",\"action\":\"deploy\",\"reason\":\"needed\",\"audience\":\"human\",\"thread\":\"$HIDDEN\"}")" = 400 ] || fail "an unreadable thread wasn't refused: $(cat "$TEST_TMP/body")"
grep -q "isn't visible to you" "$TEST_TMP/body" || fail "the refusal doesn't say why: $(cat "$TEST_TMP/body")"
[ "$(count)" = "$N" ] || fail "the refused ask stored a request"

echo "-- an ask with no home goes to a new thread, with a hint"
H=$(api POST /api/permissions "{\"agent\":\"$C\",\"action\":\"npm publish\",\"reason\":\"outward\",\"audience\":\"human\"}")
printf %s "$H" | grep -q 'Next time pass' || fail "no hint for an ask with no home: $H"

echo "-- the placed ask survives a restart and is answered in its thread"
daemon_stop main
daemon_up main
hapi POST "/api/permissions/$R/answer" '{"approve":false,"note":"not on Friday"}' | grep -q denied || fail "the human's answer after restart failed"
hapi GET "/api/threads/$M1" | python3 -c "
import json, sys
ms = json.load(sys.stdin)
assert [m['permission']['status'] for m in ms if m.get('permission_id') == '$R'] == ['denied'], ms
" || fail "the thread doesn't show the ask denied"

echo "ok: ask-home-http"
