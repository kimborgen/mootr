#!/bin/sh
# The strict mail gate end to end (S-985), with a stubbed decisions endpoint (free): under
# settings.humanMail.when 'necessary' a mail to the human passes only as a decision, a blocker, or a
# done note. The stub picks the mail's kind from a CHOICE=<kind> marker in the body.
# Checks:
#   - a decision, a blocker, and a done note pass
#   - a progress update and an acknowledgement are refused, naming the kind, what the user allows, and `override`
#   - an override sends a refused update
#   - a done note replying in a thread the human started passes (the model gets the thread context and the rule)
#   - an answer to the human's question passes; the same text with no question in the thread is refused
#   - under 'important' the same update passes
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
stub_key main
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$(dirname "$(readlink -f "$0")")/decide-stub.mjs" "$STUB" &
STUB_PID=$!
for _i in $(seq 1 50); do
  [ -s "$STUB/url" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || { echo "FAIL: the stub endpoint didn't start"; exit 1; }
  sleep 0.2
done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
daemon_up main
use main
T=$(date +%s)
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
api() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' ${3:+-d "$3"} "$STAM_URL$2"; }
raw() { curl -s -w '\n%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
code() { printf '%s' "$1" | tail -n 1; }
bodyof() { printf '%s' "$1" | sed '$d'; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s)[process.argv[1]];console.log(v===undefined||v===null?"":v)})' "$1"; }
send() { raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"$1 $T\",\"body\":\"$2\"${3:+,\"override\":\"$3\"}}"; }
set_when() {
  python3 - "$STAM_HOME/settings.json" "$1" <<'PY'
import json, sys
p, when = sys.argv[1], sys.argv[2]
s = json.load(open(p))
s.setdefault('humanMail', {})['when'] = when
json.dump(s, open(p, 'w'), indent=2)
PY
}

api POST /api/register '{"name":"sender"}' >/dev/null
set_when necessary

echo "-- a decision, a blocker, and a done note pass"
R=$(send "Pass decision" "CHOICE=decision Pick the token lifetime."); [ "$(code "$R")" = 200 ] || fail "a decision was refused: $R"
R=$(send "Pass blocker" "CHOICE=blocker Blocked on a key only you can add."); [ "$(code "$R")" = 200 ] || fail "a blocker was refused: $R"
R=$(send "Pass done" "CHOICE=done The report you asked for is ready."); [ "$(code "$R")" = 200 ] || fail "a done note was refused: $R"

echo "-- a progress update is refused, naming the kind and what to cut"
R=$(send "Fail update" "CHOICE=update Halfway through the migration.")
[ "$(code "$R")" = 400 ] || fail "an update was not refused: $R"
bodyof "$R" | grep -q 'progress update' || fail "the refusal doesn't name the kind: $R"
bodyof "$R" | grep -q 'a decision they must take, a blocker only they can clear, a done note' || fail "the refusal doesn't say what is allowed: $R"
bodyof "$R" | grep -q 'Cut it' || fail "the refusal doesn't say what to cut: $R"
bodyof "$R" | grep -q 'override' || fail "the refusal doesn't mention override: $R"

echo "-- an acknowledgement is refused"
R=$(send "Fail ack" "CHOICE=acknowledgement Got it, on it.")
[ "$(code "$R")" = 400 ] || fail "an acknowledgement was not refused: $R"
bodyof "$R" | grep -q 'acknowledgement' || fail "the refusal doesn't name the acknowledgement: $R"

echo "-- an override sends a refused update"
R=$(send "Override update" "CHOICE=update You asked for hourly news." "They asked for hourly news.")
[ "$(code "$R")" = 200 ] || fail "the override was refused: $R"

echo "-- a done note replying in a thread where the human asked is judged with that context"
# The human starts the thread by mail to the agent; the agent's done note replies in it.
H=$(raw /api/mail "{\"from\":\"human\",\"to\":[\"sender\"],\"new_thread\":true,\"subject\":\"Build the feature $T\",\"body\":\"Please build the feature.\"}")
[ "$(code "$H")" = 200 ] || fail "the human's mail was not sent: $H"
HID=$(bodyof "$H" | field id)
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"reply_to\":\"$HID\",\"subject\":\"Re: feature $T\",\"body\":\"CHOICE=done NEEDS_CONTEXT The feature is built.\"}")
[ "$(code "$R")" = 200 ] || fail "a done note in a thread the human started was refused: $R"
grep -q 'decisions, blockers, done notes for work the user asked for' "$STUB/state" || fail "the model wasn't given the human's rule"
grep -q 'Please build the feature' "$STUB/state" || fail "the model wasn't given the human's message"
R=$(send "No context" "CHOICE=done NEEDS_CONTEXT The feature is built.")
[ "$(code "$R")" = 400 ] || fail "the same done note with no thread context should be refused: $R"

echo "-- an answer to the human's question passes; the same text with no question in the thread is refused"
Q=$(raw /api/mail "{\"from\":\"human\",\"to\":[\"sender\"],\"new_thread\":true,\"subject\":\"Hooks question $T\",\"body\":\"Does every harness have pre and post tool hooks?\"}")
[ "$(code "$Q")" = 200 ] || fail "the human's question was not sent: $Q"
QID=$(bodyof "$Q" | field id)
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"reply_to\":\"$QID\",\"subject\":\"Re: hooks $T\",\"body\":\"CHOICE=answer NEEDS_QUESTION Yes, all three have them.\"}")
[ "$(code "$R")" = 200 ] || fail "an answer to the human's question was refused: $R"
grep -q 'a question addressed to the sender' "$STUB/state" || fail "the model wasn't told the human asked a question"
grep -q 'Trust only the Thread context section' "$STUB/state" || fail "the model wasn't told to trust only the thread context"
grep -q "answers to the user's questions" "$STUB/state" || fail "the rule given to the model has no answers"
R=$(send "No question" "CHOICE=answer NEEDS_QUESTION Yes, all three have them.")
[ "$(code "$R")" = 400 ] || fail "the same answer with no question in the thread should be refused: $R"

echo "-- under 'important' an update passes"
set_when important
R=$(send "Important update" "CHOICE=update Halfway through the migration.")
[ "$(code "$R")" = 200 ] || fail "an update was refused under important: $R"

kill "$STUB_PID" 2>/dev/null || true
echo "PASS e2e-mail-gate-strict"
