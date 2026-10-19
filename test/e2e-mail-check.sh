#!/bin/sh
# The mail check end to end, with a stubbed decisions endpoint (free): a mail to the human is
# checked once against the mail-to-human rules and gets a verdict stored on the mail (with the
# detail scores and a cost on the Usage page), turning the setting off means no call, and mail
# between agents is never checked. One daemon, registered agents, no model turns, no spend.
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
# The mail gate (S-983) is off here: the failing mails below must be stored and marked after delivery.
python3 - "$TEST_TMP/main/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('decisions', {})['mailGate'] = False
json.dump(s, open(p, 'w'), indent=2)
PY
daemon_up main
use main
T=$(date +%s)
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
calls() { cat "$STUB/count" 2>/dev/null || echo 0; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]??""))' "$1"; }
# The first mail of a thread as JSON, for the verdict helpers.
first() { get "/api/threads/$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(JSON.stringify(a[0]??null))})'; }
# True/false once a verdict is stored, "" while there is none.
follows() { first "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);console.log(m&&m.verdict?String(m.verdict.follows):"")})'; }
# `id` -> the new mail's id.
send() { post /api/mail "$1" | field id; }
until_verdict() {
  _i=0
  while [ "$(follows "$1")" != "$2" ]; do
    _i=$((_i + 1))
    [ "$_i" -gt 60 ] && fail "no $2 verdict on $1 (got '$(follows "$1")')"
    sleep 0.2
  done
}

# A mail between agents and a mail from the human exist up front, so the checks below can see
# the call count not move for them.
post /api/register '{"name":"sender"}' >/dev/null
post /api/register '{"name":"target"}' >/dev/null

# A mail to the human is checked once and gets a "follows" verdict with the detail scores.
BEFORE=$(calls)
M=$(send "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Mail check $T\",\"body\":\"TLDR: a concise mail that needs no answer.\"}")
until_verdict "$M" true
[ "$(calls)" = "$((BEFORE + 1))" ] || fail "the mail to the human was not checked exactly once ($BEFORE -> $(calls))"
first "$M" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const v=JSON.parse(s).verdict;
  const n=(x)=>typeof x==="number";
  if (!v || v.follows!==true || !n(v.score) || !n(v.concise) || !n(v.fluff) || !n(v.value)) { console.error("bad verdict", v); process.exit(1); }
})' || fail "the verdict is missing its scores"

# A mail the stub marks as not following gets a "no" verdict (the warning mark's data).
N=$(send "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Fluffy mail $T\",\"body\":\"MAILCHECK:NO hello there, I hope this finds you well, just a long preamble.\"}")
until_verdict "$N" false

# The cost is recorded under the OpenRouter account, attributed to stam with the purpose, so
# it shows on the Usage page.
get "/api/usage?days=1" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const u=JSON.parse(s);
  const a=(u.by_agent||[]).find((x)=>x.agent==="stam");
  const m=(u.by_model||[]).find((x)=>x.harness==="openrouter"&&x.model==="decide:mail-check");
  if (!a || !(a.cost_usd>0)) { console.error("no stam spend in by_agent", a); process.exit(1); }
  if (!m || !(m.cost_usd>0)) { console.error("no openrouter/decide:mail-check in by_model", m); process.exit(1); }
})' || fail "the decide cost is not on the Usage page"

# Mail between agents is never checked, whatever it says: no call and no verdict.
BEFORE=$(calls)
B=$(send "{\"from\":\"sender\",\"to\":[\"target\"],\"new_thread\":true,\"subject\":\"Between agents $T\",\"body\":\"MAILCHECK:NO nope.\"}")
# A later mail to the human is checked after it: once its verdict is stored, the between-agents
# mail has had its turn, and the stub has seen exactly one call (this one).
S1=$(send "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Sentinel $T\",\"body\":\"TLDR: a concise sentinel mail.\"}")
until_verdict "$S1" true
[ "$(calls)" = "$((BEFORE + 1))" ] || fail "mail between agents was checked ($BEFORE -> $(calls))"
[ -z "$(follows "$B")" ] || fail "a verdict was stored on mail between agents"

# The setting off means no call and no verdict; settings are read live, no restart.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('decisions', {})['mailCheck'] = False
json.dump(s, open(p, 'w'), indent=2)
PY
BEFORE=$(calls)
O=$(send "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Off check $T\",\"body\":\"TLDR: with the check off.\"}")
[ -z "$(follows "$O")" ] || fail "a verdict was stored with decisions.mailCheck off"
# Turn it back on: a later mail is checked (one call), and the mail stored while off has had no call.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('decisions', {})['mailCheck'] = True
json.dump(s, open(p, 'w'), indent=2)
PY
S2=$(send "{\"from\":\"sender\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Sentinel on $T\",\"body\":\"TLDR: a concise sentinel mail.\"}")
until_verdict "$S2" true
[ "$(calls)" = "$((BEFORE + 1))" ] || fail "the check ran with decisions.mailCheck off ($BEFORE -> $(calls))"
[ -z "$(follows "$O")" ] || fail "a verdict was stored with decisions.mailCheck off"

kill "$STUB_PID" 2>/dev/null || true
echo "PASS e2e-mail-check"
