#!/bin/sh
# The mail gate end to end (S-983), with a stubbed decisions endpoint (free): an agent's mail to
# the human is checked before it is stored. One daemon, registered agents, no model turns, no spend.
# Checks:
#   - a mail that passes is stored with the gate's verdict, asked once (the after-delivery check doesn't repeat it)
#   - a mail that fails is refused with 400, names the failed checks and `override`, and is not stored
#   - a resend with `override` is delivered and carries the reason on the mail
#   - a model error (a 500) delivers the mail with no verdict
#   - an ITSA post that names the human is gated the same way (refused, then overridden)
#   - an owner's move to a status that waits on the human still mails the ask, though its text would fail the gate
#   - mail between agents, an ITSA post that doesn't name the human, and the setting off make no call
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
# The after-delivery check stays on: a gated mail must not be asked about twice.
daemon_up main
use main
T=$(date +%s)
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
calls() { cat "$STUB/count" 2>/dev/null || echo 0; }
api() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' ${3:+-d "$3"} "$STAM_URL$2"; }
# POST and keep the status: prints the body, then the HTTP code on a last line.
raw() { curl -s -w '\n%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
code() { printf '%s' "$1" | tail -n 1; }
bodyof() { printf '%s' "$1" | sed '$d'; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s)[process.argv[1]];console.log(v===undefined||v===null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
mailof() { api GET "/api/threads/$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(JSON.stringify(a[0]??null))})'; }
jq1() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(String(eval(process.argv[1])))})' "$1"; }

api POST /api/register '{"name":"sender"}' >/dev/null
api POST /api/register '{"name":"target"}' >/dev/null

echo "-- a mail that passes is stored with the gate's verdict, asked once"
B=$(calls)
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Gate pass $T\",\"body\":\"TLDR: a concise mail that needs an answer.\"}")
[ "$(code "$R")" = 200 ] || fail "a good mail was refused: $R"
M=$(bodyof "$R" | field id)
mailof "$M" | jq1 'm&&m.verdict&&m.verdict.follows===true&&m.verdict.score>0.5' | grep -q true || fail "no gate verdict on the stored mail"
sleep 1
[ "$(calls)" = "$((B + 1))" ] || fail "the mail was asked about more than once ($B -> $(calls))"

echo "-- a mail that fails is refused with the reasons and not stored"
B=$(calls)
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Gate fail $T\",\"body\":\"MAILCHECK:NO hello there, I hope this finds you well.\"}")
[ "$(code "$R")" = 400 ] || fail "a failing mail was not refused with 400: $R"
bodyof "$R" | grep -q 'follows the mail rules' || fail "the refusal doesn't name the failed check: $R"
bodyof "$R" | grep -q 'fluff' || fail "the refusal doesn't name the fluff score: $R"
bodyof "$R" | grep -q 'override' || fail "the refusal doesn't mention override: $R"
[ "$(calls)" = "$((B + 1))" ] || fail "the refused mail was asked about $(( $(calls) - B )) times"
api GET "/api/mail/search?q=Gate+fail+$T" >/dev/null 2>&1 || true
api GET /api/agents/human/inbox?unread=0 | grep -q "Gate fail $T" && fail "the refused mail was stored"

echo "-- a resend with override is delivered and carries the reason"
B=$(calls)
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Gate override $T\",\"body\":\"MAILCHECK:NO the user asked to hear about every restart.\",\"override\":\"They asked for restart news.\"}")
[ "$(code "$R")" = 200 ] || fail "the override was refused: $R"
O=$(bodyof "$R" | field id)
mailof "$O" | jq1 'm.override' | grep -q 'They asked for restart news.' || fail "the override reason is not on the mail"

echo "-- a model error delivers the mail, with no verdict"
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Gate error $T\",\"body\":\"STUB:FAIL a mail while the model is down.\"}")
[ "$(code "$R")" = 200 ] || fail "a model error refused the mail: $R"
E=$(bodyof "$R" | field id)
mailof "$E" | jq1 '!m.verdict' | grep -q true || fail "the mail sent during a model error got a verdict"

echo "-- an ITSA post that names the human is gated, and an override sends it"
KEY=$("$STAM" itsa new "Gate e2e" --owner sender --status in_progress | awk '{print $1}')
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"sender\",\"to\":[\"human\"],\"body\":\"MAILCHECK:NO a chatty post.\"}")
[ "$(code "$R")" = 400 ] || fail "a failing ITSA post to the human was not refused: $R"
bodyof "$R" | grep -q 'override' || fail "the ITSA refusal doesn't mention override: $R"
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"sender\",\"to\":[\"human\"],\"body\":\"MAILCHECK:NO a chatty post.\",\"override\":\"Needed for the record.\"}")
[ "$(code "$R")" = 200 ] || fail "the ITSA override was refused: $R"
I=$(bodyof "$R" | field id)
api GET "/api/itsas/$KEY/thread" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const m=d.items.filter((i)=>i.type==="mail"&&i.mail.id===process.argv[1])[0];if(!m||m.mail.override!=="Needed for the record."){console.error("no override on the post",m);process.exit(1)}})' "$I" || fail "the ITSA post lost its override"

echo "-- the ask for a human status is stam's own mail: never gated, even with a failing text"
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"sender\",\"body\":\"MAILCHECK:NO please decide the thing.\"}")
[ "$(code "$R")" = 200 ] || fail "the owner's comment was refused: $R"
api PATCH "/api/itsas/$KEY" '{"status":"needs_input","by":"sender"}' >/dev/null
_i=0
until api GET "/api/itsas/$KEY/thread" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);process.exit(d.items.some((i)=>i.type==="mail"&&i.mail.kind==="ask")?0:1)})'; do
  _i=$((_i + 1))
  [ "$_i" -gt 50 ] && fail "the ask for needs_input never reached the human (the gate refused it)"
  sleep 0.2
done

R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"sender\",\"to\":[\"human\"],\"kind\":\"ask\",\"body\":\"MAILCHECK:NO an agent naming kind ask.\"}")
[ "$(code "$R")" = 400 ] || fail "an agent's post naming kind ask was not refused: $R"

echo "-- mail between agents, a post that doesn't name the human, and the setting off make no call"
sleep 1
B=$(calls)
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"target\"],\"new_thread\":true,\"subject\":\"Gate peers $T\",\"body\":\"MAILCHECK:NO between agents.\"}")
[ "$(code "$R")" = 200 ] || fail "mail between agents was refused: $R"
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"sender\",\"body\":\"MAILCHECK:NO a post for the agents only.\"}")
[ "$(code "$R")" = 200 ] || fail "a post not naming the human was refused: $R"
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
d = s.setdefault('decisions', {})
d['mailGate'] = False
d['mailCheck'] = False
json.dump(s, open(p, 'w'), indent=2)
PY
R=$(raw /api/mail "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Gate off $T\",\"body\":\"MAILCHECK:NO with the gate off.\"}")
[ "$(code "$R")" = 200 ] || fail "a mail was refused with the gate off: $R"
sleep 1
[ "$(calls)" = "$B" ] || fail "a call was made for mail that is not gated ($B -> $(calls))"

kill "$STUB_PID" 2>/dev/null || true
echo "PASS e2e-mail-gate"
