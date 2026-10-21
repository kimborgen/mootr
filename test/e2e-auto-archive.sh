#!/bin/sh
# Auto-archive of the human's resolved threads (S-637): the pass (POST /api/mail/resolved, which the
# daemon also runs every 10 minutes and after events) archives a thread once its ITSA is closed, the
# human has read every mail to them in it, and its last mail on their side asks nothing; a thread
# of plain mail about no ITSA, an unread one, or one ending in an ask stays; a request thread
# archives once its request is answered and its mail read. A dry run archives nothing. Threads
# from before the pass was switched on wait for the one-off sweep (`all`). A new mail to the human
# brings an archived thread back; one the human unarchived stays until it has new mail for them. Free and no models: registered
# agents plus the mail and ITSA API, against its own daemon (test/lib.sh), with no quiet period
# and, as in every test daemon, no one-time full pass.
set -e
export STAM_AUTO_ARCHIVE_QUIET_MS=0
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
# tapi: api for /api/test/* routes; -f fails at the call when the gate answers 404.
tapi() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
mail() { api POST /api/mail "$1" | field '["id"]'; }
readall() { hapi POST /api/agents/human/read "{\"ids\":[\"$1\"]}" >/dev/null; }
pass() { api POST /api/mail/resolved "{\"dry\":${1:-false}${2:+,\"all\":true}}"; }
archived() { hapi GET '/api/agents/human/threads?limit=100&archived=1' | grep -q "\"thread_id\":\"$1\""; }
BT='`'
FENCE="${BT}${BT}${BT}"
fail() { echo "FAIL: $1"; exit 1; }

A=$(reg alice)
newitsa() { "$STAM" itsa new "$1" --owner alice --status in_progress | awk '{print $1}'; }
close() { api PATCH "/api/itsas/$1" "{\"status\":\"done\",\"by\":\"$A\"}" >/dev/null; }

K1=$(newitsa "Ship the fix")
T1=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Done: the fix is live\",\"body\":\"Merged and deployed.\",\"itsa\":\"$K1\",\"new_thread\":true}")
readall "$T1"

echo "-- an open ITSA's thread stays"
pass >/dev/null
archived "$T1" && fail "a thread whose ITSA is open was archived"

echo "-- a dry run lists the resolved thread and archives nothing"
close "$K1"
pass true | grep -q "\"$T1\"" || fail "the dry run doesn't list $T1: $(pass true)"
archived "$T1" && fail "a dry run archived $T1"

echo "-- the pass archives it once its ITSA closed, and keeps the others"
K2=$(newitsa "Unread result")
T2=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Result you haven't read\",\"body\":\"Done.\",\"itsa\":\"$K2\",\"new_thread\":true}")
close "$K2"
K3=$(newitsa "Ends in a question")
T3=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Pick one\",\"body\":\"${FENCE}pick\nA\nB\n${FENCE}\",\"itsa\":\"$K3\",\"new_thread\":true}")
readall "$T3"
T4=$(mail '{"from":"alice","to":["human"],"subject":"No ITSA","body":"FYI, done.","new_thread":true}')
readall "$T4"
pass >/dev/null
archived "$T1" || fail "the resolved thread $T1 wasn't archived"
archived "$T2" && fail "an unread result was archived"
archived "$T4" && fail "a thread about no ITSA was archived"
close "$K3"
pass >/dev/null
archived "$T3" && fail "a thread ending in a decision block was archived"

echo "-- a request thread about no ITSA archives once its request is answered and its mail read"
R=$(api POST /api/permissions "{\"agent\":\"$A\",\"action\":\"Push the branch\",\"reason\":\"needed\",\"details\":\"\",\"audience\":\"human\"}" | field '["id"]')
TR=$(hapi GET '/api/agents/human/threads?limit=100' | python3 -c "import json,sys; print(next(t['thread_id'] for t in json.load(sys.stdin) for m in t['mails'] if m.get('permission_id')=='$R'))")
readall "$TR"
pass >/dev/null
archived "$TR" && fail "a thread with a pending request was archived"
hapi POST "/api/permissions/$R/answer" '{"approve":false,"note":"no"}' >/dev/null
pass >/dev/null
archived "$TR" || fail "an answered, read request thread wasn't archived"

echo "-- reading the result lets the next pass archive it"
readall "$T2"
pass >/dev/null
archived "$T2" || fail "a read result on a closed ITSA wasn't archived"

echo "-- a thread the human unarchived stays until it has new mail for them"
hapi POST "/api/agents/human/threads/$T2/unarchive" '{}' >/dev/null
pass >/dev/null
archived "$T2" && fail "the pass archived $T2 again after the human unarchived it"
# The human's own mail in it isn't news to them: the thread stays.
hapi POST /api/mail "{\"from\":\"human\",\"to\":[\"$A\"],\"subject\":\"Re: Result\",\"body\":\"Thanks\",\"reply_to\":\"$T2\"}" >/dev/null
pass >/dev/null
archived "$T2" && fail "the human's own mail let the pass archive $T2 again"
N2=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Re: Result\",\"body\":\"Also done: the docs.\",\"reply_to\":\"$T2\"}")
readall "$N2"
pass >/dev/null
archived "$T2" || fail "new mail, read, didn't let the pass archive $T2 again"

echo "-- a new mail to the human brings an archived thread back"
mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Re: Done: the fix is live\",\"body\":\"One more thing?\",\"reply_to\":\"$T1\"}" >/dev/null
archived "$T1" && fail "a new mail to the human didn't bring $T1 back"

echo "-- threads from before the pass was switched on wait for the sweep (all)"
K5=$(newitsa "Before the switch")
T5=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Old result\",\"body\":\"Done.\",\"itsa\":\"$K5\",\"new_thread\":true}")
readall "$T5"
close "$K5"
tapi POST /api/test/kv '{"key":"autoArchive.since","value":"99999999999999"}' >/dev/null
pass >/dev/null
archived "$T5" && fail "a thread from before the switch was archived without the sweep"
pass true all | grep -q "\"$T5\"" || fail "the sweep's dry run doesn't list $T5"
pass false all >/dev/null
archived "$T5" || fail "the sweep didn't archive $T5"

echo "-- a test daemon never runs the one-time full pass (test/lib.sh's default delay)"
[ "$STAM_AUTO_ARCHIVE_FULL_DELAY_MS" = 2147483647 ] || fail "lib.sh's full-pass delay is $STAM_AUTO_ARCHIVE_FULL_DELAY_MS"
[ "$(tapi GET '/api/test/kv?key=autoArchive.fullPassDone3')" = '{"value":null}' ] || fail "the test daemon ran the full pass"

echo "ok: auto-archive"
