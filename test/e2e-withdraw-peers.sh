#!/bin/sh
# Withdrawing an ask from the human (S-413) across peers, free (no models, no agent turns). Two isolated
# daemons, "main" and "twin", peered. Agents on twin ask the human; someone else settles it. Checks, on
# both machines, that the withdrawn mail counts in no unread count and the human's copy carries the note:
#   - a parent denying an agent's permission request
#   - an agent moving an ITSA out of a human status (its ask mail)
#   - a peer's withdraw call for mail twin holds (what main forwards for mail it doesn't hold)
#   - the human's own answer withdraws nothing, and a reply brings an archived thread back
#   - the withdraw route and the push relay refuse anyone but a peer: an agent with its own token can't
#     close the human's notifications by naming a peer
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/idle.json" <<'EOF2'
{ "turns": [ { "match": "", "steps": [ { "reply": "OK" } ] } ] }
EOF2
fake_claude "$TEST_TMP/idle.json"
daemon_home main
daemon_home twin
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    try:
        s = json.load(open(path))
    except FileNotFoundError:
        s = {}
    s["peers"] = [peer(other)]
    s["decisions"] = {"mailCheck": False}
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_OUTBOX_MS=300
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
# api DAEMON METHOD PATH [BODY] [human]: the human's calls carry the x-stam-human header.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  _human=; [ "$5" = human ] && _human='-H x-stam-human:1'
  curl -s -X "$2" -H "authorization: Bearer $_tok" $_human -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
# The HTTP status of the same call.
status() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "authorization: Bearer $_tok" -H 'x-stam-human: 1' -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
# Whether mail $2 is listed as a decision on daemon $1, and how many times.
listed() { api "$1" GET /api/mail/decisions | jget "[x['mail_id'] for x in d].count('$2')"; }
# The human's unread mail on daemon $1: its own, and with the peers' when asked there (the web UI's badge).
unread() { api "$1" GET '/api/agents/human/inbox?unread=1&limit=100' '' human | jget "len(d)"; }
# A call as the peer daemon would make it (its peer token and x-stam-local, S-1064).
peercall() {
  _url=$MAIN_URL; _tok=$(cat "$TEST_TMP/main/peer-token"); [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$(cat "$TEST_TMP/twin/peer-token"); }
  curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "authorization: Bearer $_tok" -H 'x-stam-local: 1' -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
# The human's copy of mail $2 in thread $3, as daemon $1 reports it.
copy() { api "$1" GET "/api/threads/$3?box=human" | jget "__import__('json').dumps([r for m in d if m['id']=='$2' for r in m['recipients'] if r['id']=='human'][0])"; }
count_is() { [ "$(unread main)" = "$1" ] && [ "$(unread twin)" = "$1" ]; }

BOSS=$(api twin POST /api/register '{"name":"boss","role":"test","harness":"claude"}' | jget "d['id']")
FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")
# Only managers mail the human directly (S-548), so far is one: its asks must reach the human.
node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(process.argv[1]).prepare("UPDATE agents SET type = ? WHERE id = ?").run("manager", process.argv[2])' "$TEST_TMP/twin/stam.db" "$FAR"
api twin POST "/api/agents/$FAR/set-parent" "{\"parent\":\"$BOSS\"}" >/dev/null

echo "-- a permission request reaches the human on both machines"
P1=$(api twin POST /api/permissions "{\"agent\":\"$FAR\",\"action\":\"Run the build\",\"reason\":\"r\",\"audience\":\"human\"}" | jget "d['id']")
wait_until count_is 1 || fail "the request isn't one unread on both machines (main $(unread main), twin $(unread twin))"
T1=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "d[0]['thread_id']")
ID1=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "d[0]['id']")

echo "-- the parent denies it: the mail counts nowhere, and carries who and what"
R=$(api twin POST "/api/permissions/$P1/answer" "{\"approve\":false,\"by\":\"$BOSS\",\"note\":\"not now\"}")
printf '%s' "$R" | grep -q '"denied"' || fail "boss couldn't deny: $R"
wait_until count_is 0 || fail "the denied request still counts (main $(unread main), twin $(unread twin))"
[ "$(copy twin "$ID1" "$T1" | jget "d['withdrawn_note']")" = "Answered by @boss: denied" ] || fail "the note is wrong: $(copy twin "$ID1" "$T1")"
[ "$(copy twin "$ID1" "$T1" | jget "d['withdrawn_by']")" = "$BOSS" ] || fail "withdrawn_by isn't boss"
[ "$(api twin GET '/api/agents/human/threads?archived=1' '' human | jget "[t['thread_id'] for t in d].count('$T1')")" = 1 ] || fail "the thread isn't archived on twin"
[ "$(api main GET "/api/threads/$T1?box=human" | jget "len(d)")" = 1 ] || fail "main can't read the thread, to show the line"

echo "-- the human's own answer withdraws nothing"
P2=$(api twin POST /api/permissions "{\"agent\":\"$FAR\",\"action\":\"Rebuild\",\"reason\":\"r\",\"audience\":\"human\"}" | jget "d['id']")
wait_until count_is 1 || fail "the second request isn't unread"
ID2=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "d[0]['id']")
T2=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "d[0]['thread_id']")
api twin POST "/api/permissions/$P2/answer" '{"approve":true,"note":"I authorize"}' human >/dev/null
[ "$(copy twin "$ID2" "$T2" | jget "d.get('withdrawn_at')")" = None ] || fail "the human's own answer was withdrawn"

echo "-- an agent moving an ITSA out of a human status withdraws its ask"
KEY=$(on twin "$STAM" itsa new "Held on twin" --owner far --status in_progress | awk '{print $1}')
api twin POST "/api/itsas/$KEY/post" "{\"by\":\"$FAR\",\"body\":\"Done: ready to look at.\"}" >/dev/null
api twin PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$FAR\"}" >/dev/null
ask() { [ "$(unread twin)" = 2 ]; }
wait_until ask || fail "the ITSA ask doesn't reach the human (twin $(unread twin))"
ID3=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "[m for m in d if m.get('kind')=='ask'][0]['id']")
T3=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "[m for m in d if m.get('kind')=='ask'][0]['thread_id']")
api twin PATCH "/api/itsas/$KEY" "{\"status\":\"in_progress\",\"by\":\"$BOSS\"}" >/dev/null
gone() { [ "$(unread twin)" = 1 ] && [ "$(unread main)" = 1 ]; }
wait_until gone || fail "the settled ask still counts (main $(unread main), twin $(unread twin))"
[ "$(copy twin "$ID3" "$T3" | jget "d['withdrawn_note']")" = "@boss moved $KEY to in_progress" ] || fail "the ITSA note is wrong: $(copy twin "$ID3" "$T3")"

echo "-- the human's own move of an ITSA withdraws nothing"
api twin POST "/api/itsas/$KEY/post" "{\"by\":\"$FAR\",\"body\":\"Question: which way?\"}" >/dev/null
api twin PATCH "/api/itsas/$KEY" "{\"status\":\"needs_input\",\"by\":\"$FAR\"}" >/dev/null
again() { [ "$(unread twin)" = 2 ]; }
wait_until again || fail "the second ITSA ask doesn't reach the human"
ID4=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "[m for m in d if m.get('kind')=='ask'][0]['id']")
T4=$(api twin GET '/api/agents/human/inbox?unread=1' '' human | jget "[m for m in d if m.get('kind')=='ask'][0]['thread_id']")
api twin PATCH "/api/itsas/$KEY" '{"status":"in_progress"}' human >/dev/null
[ "$(copy twin "$ID4" "$T4" | jget "d.get('withdrawn_at')")" = None ] || fail "the human's own move was withdrawn"

echo "-- a peer's withdraw call for mail twin holds, and only a peer may make it"
R5=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Pick\",\"body\":\"x\"}")
ID5=$(printf '%s' "$R5" | jget "d['id']"); T5=$(printf '%s' "$R5" | jget "d['thread_id']")
[ "$(status twin POST /api/mail/withdraw "{\"ids\":[\"$ID5\"],\"by\":\"$BOSS\",\"note\":\"x\"}")" = 403 ] || fail "a non-peer withdrew mail"
[ "$(peercall twin POST /api/mail/withdraw "{\"ids\":[\"$ID5\",\"mnone\"],\"by\":\"$BOSS\",\"note\":\"Answered elsewhere\"}")" = 200 ] || fail "the peer's withdraw failed"
[ "$(copy twin "$ID5" "$T5" | jget "d['withdrawn_note']")" = "Answered elsewhere" ] || fail "the peer's note isn't kept"

echo "-- an agent with its own token can't relay a close, naming the peer or forging x-stam-local"
WORK="$TEST_TMP/work"; mkdir -p "$WORK"
SPY=$(api main POST /api/agents "{\"name\":\"spy\",\"cwd\":\"$WORK\",\"prompt\":\"hello\"}" | jget "d['id']")
token_of() { on main sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$1"; }
has_token() { [ -n "$(token_of "$SPY")" ]; }
wait_until has_token
SPY_TOKEN=$(token_of "$SPY")
for extra in "-H x-stam-x:1" "-H x-stam-local:1"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $SPY_TOKEN" $extra -H 'content-type: application/json' -d "{\"machine\":\"twin\",\"holder\":\"twin\",\"close\":true,\"thread_id\":\"$T1\",\"mail_ids\":[\"$ID1\"]}" "$MAIN_URL/api/push/notify")
  [ "$code" = 403 ] || fail "an agent's relayed close got $code, not 403 ($extra)"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $SPY_TOKEN" -H 'content-type: application/json' -d "{\"ids\":[\"$ID5\"],\"by\":\"x\",\"note\":\"x\"}" "$MAIN_URL/api/mail/withdraw")
[ "$code" = 403 ] || fail "an agent's withdraw got $code"

echo "-- a reply brings an archived thread back"
api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Re: Pick\",\"body\":\"one more thing\",\"reply_to\":\"$ID5\"}" >/dev/null
back() { [ "$(api twin GET '/api/agents/human/threads?limit=50' '' human | jget "[t['thread_id'] for t in d].count('$T5')")" = 1 ]; }
wait_until back || fail "the reply didn't bring the thread back"

echo "PASS: withdraw across peers"
