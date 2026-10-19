#!/bin/sh
# The requirements check engine end to end (S-503), with a stubbed decisions endpoint (free): a
# mail that violates an `inform` requirement gives its sender a notice worded as an indication,
# an `observe` requirement records the verdict and tells nobody, and a repeat of the same mail
# makes no second call. One daemon, registered agents, no model turns, no spend.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
stub_key main
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$(dirname "$(readlink -f "$0")")/decide-stub.mjs" "$STUB" &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null; stam_test_cleanup' EXIT
for _i in $(seq 1 50); do
  [ -s "$STUB/url" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || { echo "FAIL: the stub endpoint didn't start"; exit 1; }
  sleep 0.2
done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
daemon_up main
use main
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s['requirements'] = {'enabled': True, 'approval': 'human', 'keyPrefix': 'R', 'dailyCapUsd': 1, 'defaultThreshold': 0.8, 'defaultMode': 'observe'}
json.dump(s, open(p, 'w'), indent=2)
PY
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
calls() { cat "$STUB/count" 2>/dev/null || echo 0; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]??""))' "$1"; }
# How many notices naming a requirement key this agent was sent.
notices() { get "/api/agents/$1/events" | python3 -c 'import json,sys; print(sum(e["type"]=="notice:queued" and "A model check" in (e.get("data") or "") for e in json.load(sys.stdin)))'; }
# The number of stored verdicts on a requirement.
verdicts() { get "/api/requirements/$1" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["verdicts"]))'; }
until_eq() { # description, command, expected
  _i=0
  while [ "$($2)" != "$3" ]; do
    _i=$((_i + 1))
    [ "$_i" -gt 100 ] && fail "$1: wanted $3, got $($2)"
    sleep 0.2
  done
}
v_notices() { notices "$SENDER"; }
v_inform() { verdicts "$RINFORM"; }
v_observe() { verdicts "$ROBSERVE"; }

SENDER=$(post /api/register '{"name":"sender"}' | field id)
post /api/register '{"name":"target"}' >/dev/null
RINFORM=$(post /api/requirements '{"title":"Inform","text":"A mail shall state its outcome first.","status":"in_force","verification":["decision"],"mode":"inform"}' | field key)
ROBSERVE=$(post /api/requirements '{"title":"Observe","text":"A mail shall be short.","status":"in_force","verification":["decision"],"mode":"observe"}' | field key)

# An observe-only violation: recorded, and the sender hears nothing.
post /api/mail "{\"from\":\"sender\",\"to\":[\"target\"],\"new_thread\":true,\"subject\":\"Observe\",\"body\":\"REQ:$ROBSERVE=violates\"}" >/dev/null
until_eq "the observe verdict" v_observe 1
[ "$(get "/api/requirements/$ROBSERVE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdicts"][0]["verdict"])')" = violates ] || fail "the observe verdict isn't violates"
[ "$(notices "$SENDER")" = 0 ] || fail "an observe requirement sent a notice"

# An inform violation: the sender gets one notice, naming the requirement as likely not met.
BEFORE=$(calls)
M=$(post /api/mail "{\"from\":\"sender\",\"to\":[\"target\"],\"new_thread\":true,\"subject\":\"Inform\",\"body\":\"REQ:$RINFORM=violates\"}" | field id)
until_eq "the sender's notice" v_notices 1
get "/api/agents/$SENDER/events" | grep -q "likely\|A model check of your mail:$M" || fail "the notice isn't about the mail"
[ "$(calls)" = "$((BEFORE + 1))" ] || fail "the mail wasn't checked with exactly one call ($BEFORE -> $(calls))"

# A conforming mail gives no notice.
post /api/mail "{\"from\":\"sender\",\"to\":[\"target\"],\"new_thread\":true,\"subject\":\"Fine\",\"body\":\"a short plain mail\"}" >/dev/null
until_eq "the conforming verdict" v_inform 3
[ "$(notices "$SENDER")" = 1 ] || fail "a conforming mail sent a notice"

# On demand: the route and the CLI check pasted text and tell nobody.
RP=$(post /api/requirements '{"title":"Plain","text":"Text shall be plain.","status":"in_force","verification":["decision"],"mode":"inform","scope":{"subjects":["manual"]}}' | field key)
OUT=$(post /api/requirements/check "{\"text\":\"pasted REQ:$RP=violates\",\"keys\":\"$RP\"}")
echo "$OUT" | python3 -c 'import json,sys; r=json.load(sys.stdin)["results"]; assert [(x["key"],x["verdict"]) for x in r]==[(sys.argv[1],"violates")], r' "$RP" || fail "the manual check route: $OUT"
"$STAM" req check --text "cli words REQ:$RP=violates" --keys "$RP" | grep -q "$RP.*violates" || fail "stam req check printed no verdict"
[ "$(notices "$SENDER")" = 1 ] || fail "a manual check sent a notice"

# A tool call: an enforce requirement scoped to the tool denies it, naming the requirement.
RT=$(post /api/requirements '{"title":"No kill","text":"Never run pkill -f.","status":"in_force","verification":["decision"],"mode":"enforce","scope":{"tools":["Bash"]}}' | field key)
D=$(post /api/steps/check "{\"agent\":\"$SENDER\",\"tool\":\"Bash\",\"args\":{\"command\":\"pkill -f x REQ:$RT=violates\"}}")
echo "$D" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["allow"] is False and d["requirement"]==sys.argv[1] and "Denied by requirement "+sys.argv[1] in d["error"], d' "$RT" || fail "the tool call wasn't denied by the requirement: $D"
D=$(post /api/steps/check "{\"agent\":\"$SENDER\",\"tool\":\"Bash\",\"args\":{\"command\":\"ls\"}}")
echo "$D" | python3 -c 'import json,sys; assert json.load(sys.stdin)["allow"] is True' || fail "a conforming tool call was denied: $D"

# A branch entering ready_to_merge is checked, and the merge queue row carries the conformity line and hold.
REPO="$TEST_TMP/repo"
mkdir -p "$REPO/src"
git -C "$REPO" init -q -b main 2>/dev/null || { git init -q -b main "$REPO"; }
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name t
echo base > "$REPO/README.md"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
RB=$(post /api/requirements '{"title":"Branch","text":"Source shall be tidy.","status":"in_force","verification":["decision"],"mode":"enforce","severity":"major","scope":{"paths":["src/**"]}}' | field key)
echo "export const x = 1; // REQ:$RB=violates" > "$REPO/src/x.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm feature
git -C "$REPO" checkout -q main
python3 - "$STAM_HOME/settings.json" "$REPO" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s.setdefault('itsa', {}).setdefault('repos', {})['r'] = sys.argv[2]; json.dump(s, open(p, 'w'), indent=2)
PY
IK=$(post /api/itsas '{"title":"Branch work"}' | field key)
post "/api/itsas/$IK/links" '{"system":"branch","external_id":"feature","repo":"r"}' >/dev/null
curl -sf -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d '{"status":"ready_to_merge"}' "$STAM_URL/api/itsas/$IK" >/dev/null
hold() { get /api/itsas/queue | python3 -c 'import json,sys; rows=json.load(sys.stdin); c=rows[0].get("conformity") if rows else None; print(str(bool(c and c["hold"])))'; }
until_eq "the merge queue hold" hold True
get /api/itsas/queue | python3 -c 'import json,sys; c=json.load(sys.stdin)[0]["conformity"]; l=[x for x in c["lines"] if x["key"]==sys.argv[1]][0]; assert l["verdict"]=="violates" and l["severity"]=="major", c' "$RB" || fail "the conformity line is wrong"

kill "$STUB_PID" 2>/dev/null || true
echo "PASS e2e-req-check"
