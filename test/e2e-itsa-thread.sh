#!/bin/sh
# ITSAs step 3 end to end, free (no models): two isolated daemons play two machines. "home"
# is the ITSA home (alice and bob live there); "main" proxies to it (carol and dave live
# there). Agents are registered, not spawned, so nothing runs a model; the PostToolUse hook
# is called by hand to read the notice it would return. Checks:
#   - the first post creates the thread (subject KEY Title); a post from carol on main reaches
#     the home, which sends to alice and bob and forwards to nobody extra; the sender joins
#   - recipients: participants minus the sender; a non-participant gets nothing
#   - quiet delivery on both daemons: a plain comment leaves the hook notice empty and sits
#     unread for the idle batch; an @name mention, the human, and the owner interrupt
#   - updates carry a health (refused without one); send_mail with reply_to into the thread
#     from main is a comment
#   - GET /api/itsas/:id/thread (also through main) merges mails and status/owner events by
#     time, with one entry per mail although it is stored on both daemons
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d in ("main", "home"):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer("home")] if d == "main" else [peer("main")]
    s.setdefault("itsa", {})["home"] = "home"
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up home
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
# api D METHOD PATH [BODY] [human]: a call to daemon main or home; the 5th word "human" acts as the human.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  if [ "$5" = human ]; then
    curl -sf -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
  else
    curl -sf -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
  fi
}
register() { api "$1" POST /api/register "{\"name\":\"$2\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
# notice D ID: what the PostToolUse hook returns for the agent (empty when nothing interrupts).
notice() { api "$1" POST "/api/hook/claude/$2" '{"hook_event_name":"PostToolUse"}' | jget "d.get('stdout','')"; }
# unread D ID: how many unread mails the agent has.
unread() { api "$1" GET "/api/agents/$2/inbox?unread=1" | jget "len([m for m in d if not m.get('read_at')])"; }
# clear: marks every mail read on both daemons, so each step counts only its own.
clear() { for d in main home; do python3 - "$TEST_TMP/$d/stam.db" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1], timeout=10); c.execute("UPDATE mail_recipients SET read_at = datetime('now') WHERE read_at IS NULL"); c.commit()
PY
done; }

ALICE=$(register home alice); BOB=$(register home bob)
CAROL=$(register main carol); DAVE=$(register main dave)

# alice owns the ITSA; bob (home) and carol (main) take part; dave doesn't.
KEY=$(on home "$STAM" itsa new "Thread e2e" --owner alice --participant bob --participant carol | awk '{print $1}')
[ "$(api home GET "/api/itsas/$KEY" | jget "d['thread_id']")" = None ] || fail "a thread exists before the first post"

# 1. The first post, by carol on main (proxied to the home, relayed as a remote sender).
STAM_AGENT_ID="$CAROL" on main "$STAM" itsa post "$KEY" "first from carol" >/dev/null || fail "carol's post failed"
TID=$(api home GET "/api/itsas/$KEY" | jget "d['thread_id']")
[ "$TID" != None ] || fail "the first post set no thread_id"
api home GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t1.json"
[ "$(jget "len([i for i in d['items'] if i['type']=='mail'])" <"$TEST_TMP/t1.json")" = 1 ] || fail "the thread doesn't hold exactly the first mail"
[ "$(jget "d['items'][0]['mail']['subject']" <"$TEST_TMP/t1.json")" = "$KEY Thread e2e" ] || fail "subject isn't KEY Title"
[ "$(jget "d['items'][0]['mail']['kind']" <"$TEST_TMP/t1.json")" = comment ] || fail "kind isn't comment"
[ "$(jget "d['items'][0]['mail']['itsa_id'] is not None" <"$TEST_TMP/t1.json")" = True ] || fail "the mail has no itsa_id"
[ "$(jget "d['items'][0]['mail']['from_name']" <"$TEST_TMP/t1.json")" = carol ] || fail "the remote sender's name is lost"
[ "$(unread home "$ALICE")" = 1 ] && [ "$(unread home "$BOB")" = 1 ] || fail "alice and bob didn't each get the comment"
[ "$(unread main "$CAROL")" = 0 ] || fail "the sender got her own comment"
[ "$(unread main "$DAVE")" = 0 ] || fail "a non-participant got the comment"
api home GET "/api/itsas/$KEY" | jget "sorted(d['participants'])" | grep -q "$CAROL" || fail "carol isn't a participant"

# 2. Quiet delivery on the home daemon: carol's plain comment doesn't interrupt bob (or alice, the owner).
[ -z "$(notice home "$BOB")" ] || fail "a plain comment interrupted bob"
[ -z "$(notice home "$ALICE")" ] || fail "a plain comment interrupted alice"

# 3. The owner's post interrupts everyone, on both daemons (the interrupt list crosses machines).
clear
STAM_AGENT_ID="$ALICE" on home "$STAM" itsa post "$KEY" "from the owner" >/dev/null
notice home "$BOB" | grep -q "unread mail" || fail "the owner's post didn't interrupt bob"
notice main "$CAROL" | grep -q "unread mail" || fail "the owner's post didn't interrupt carol on the other machine"

# 4. A plain comment from bob is quiet for alice (home) and carol (main); both still hold it unread.
clear
STAM_AGENT_ID="$BOB" on home "$STAM" itsa post "$KEY" "plain from bob" >/dev/null
[ -z "$(notice home "$ALICE")" ] || fail "bob's comment interrupted the owner"
[ -z "$(notice main "$CAROL")" ] || fail "bob's comment interrupted carol on the other machine"
[ "$(unread main "$CAROL")" = 1 ] || fail "carol's quiet comment isn't waiting for her idle batch"
[ "$(unread home "$ALICE")" = 1 ] || fail "alice's quiet comment isn't waiting for her idle batch"

# 5. An @name mention interrupts only the one named, across machines.
clear
STAM_AGENT_ID="$BOB" on home "$STAM" itsa post "$KEY" "@carol please look at this" >/dev/null
notice main "$CAROL" | grep -q "unread mail" || fail "an @carol mention didn't interrupt carol"
[ -z "$(notice home "$ALICE")" ] || fail "an @carol mention interrupted alice"

# 6. The human interrupts; the human is a participant afterwards. An agent's later comment doesn't mail the human (only a move to a human status, or a named `to`, does).
clear
api home POST "/api/itsas/$KEY/post" '{"body":"from the human"}' human >/dev/null
notice home "$BOB" | grep -q "unread mail" || fail "the human's comment didn't interrupt bob"
api home GET "/api/itsas/$KEY" | jget "sorted(d['participants'])" | grep -q human || fail "the human isn't a participant after posting"
STAM_AGENT_ID="$BOB" on home "$STAM" itsa post "$KEY" "now the human is told" >/dev/null
[ "$(api home GET "/api/itsas/$KEY/thread" | jget "[r['id'] for r in [i for i in d['items'] if i['type']=='mail'][-1]['mail']['recipients']].count('human')")" = 0 ] || fail "an agent's comment mailed the human"

# 7. Updates: a health is required and stored; a comment can't carry one.
STAM_AGENT_ID="$ALICE" on home "$STAM" itsa post "$KEY" "update without health" --update bogus >/dev/null 2>&1 && fail "an update with a bad health was accepted"
STAM_AGENT_ID="$ALICE" on home "$STAM" itsa post "$KEY" "slipping" --update at_risk >/dev/null || fail "an update failed"
[ "$(api home GET "/api/itsas/$KEY/thread" | jget "[i['mail'] for i in d['items'] if i['type']=='mail'][-1]['health']")" = at_risk ] || fail "the update's health isn't stored"
[ "$(api home GET "/api/itsas/$KEY/thread" | jget "[i['mail'] for i in d['items'] if i['type']=='mail'][-1]['kind']")" = update ] || fail "the update's kind isn't update"

# 8. send_mail with reply_to into the thread, from main, is a comment on the ITSA.
clear
PARENT=$(api main GET "/api/agents/$CAROL/inbox" | jget "[m for m in d if m.get('itsa_id')][0]['id']")
api main POST /api/mail "{\"from\":\"$CAROL\",\"to\":[\"dave\"],\"body\":\"reply via send_mail\",\"reply_to\":\"$PARENT\"}" >/dev/null || fail "carol's reply failed"
api home GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t2.json"
[ "$(jget "[i['mail'] for i in d['items'] if i['type']=='mail'][-1]['body']" <"$TEST_TMP/t2.json")" = "reply via send_mail" ] || fail "the reply isn't in the ITSA thread"
[ "$(jget "[i['mail'] for i in d['items'] if i['type']=='mail'][-1]['kind']" <"$TEST_TMP/t2.json")" = comment ] || fail "the reply isn't a comment"
[ "$(unread main "$DAVE")" = 1 ] || fail "a recipient named in send_mail's to didn't get the comment"
api home GET "/api/itsas/$KEY" | jget "sorted(d['participants'])" | grep -q "$CAROL" || fail "carol left the participants"
[ "$(unread home "$ALICE")" = 1 ] && [ "$(unread home "$BOB")" = 1 ] || fail "the reply didn't reach the other participants"
[ -z "$(notice home "$ALICE")" ] || fail "the send_mail reply interrupted alice"

# 9. Events: status and owner changes show in the merged thread, in time order, and aren't mail.
# Each change is recorded before the next one runs, so the thread's time order is the order of the
# commands; the waits are on the events themselves, not the clock.
events_at_least() { [ "$(api home GET "/api/itsas/$KEY/thread" | jget "len([i for i in d['items'] if i['type']=='event'])")" -ge "$1" ]; }
on home "$STAM" itsa set "$KEY" --status in_progress >/dev/null
wait_until events_at_least 1
on home "$STAM" itsa set "$KEY" --owner bob >/dev/null
wait_until events_at_least 2
STAM_AGENT_ID="$BOB" on home "$STAM" itsa post "$KEY" "after the changes" >/dev/null
for d in home main; do
  api "$d" GET "/api/itsas/$KEY/thread" >"$TEST_TMP/t3.json"
  [ "$(jget "[i['type'] for i in d['items']]" <"$TEST_TMP/t3.json" | tr -d "[]',")" = "mail mail mail mail mail mail mail mail event event mail" ] || { cat "$TEST_TMP/t3.json"; fail "the thread through $d isn't the 8 earlier mails, status and owner events, then the last mail"; }
  [ "$(jget "[i['text'] for i in d['items'] if i['type']=='event'][0]" <"$TEST_TMP/t3.json")" = "the human changed status from backlog to in_progress" ] || fail "the status event text through $d is wrong"
  [ "$(jget "[i['text'] for i in d['items'] if i['type']=='event'][1]" <"$TEST_TMP/t3.json")" = "the human changed owner from alice to bob" ] || fail "the owner event text through $d is wrong"
done
[ "$(on home "$STAM" itsa thread "$KEY" | grep -c -- '--')" = 2 ] || fail "the CLI thread doesn't show the two events"
# Events are not mail: no mail anywhere carries a status or owner change.
api home GET "/api/threads/$TID" | grep -q "changed status" && fail "an event was sent as mail"

# One mail, one id on every daemon: the plain thread API shows each post once through either
# daemon, and two identical comments from one sender stay two entries.
STAM_AGENT_ID="$BOB" on home "$STAM" itsa post "$KEY" "same words" >/dev/null
api home POST "/api/itsas/$KEY/post" "{\"by\":\"$BOB\",\"body\":\"same words\",\"to\":[\"human\"]}" >/dev/null
N=$(api home GET "/api/itsas/$KEY/thread" | jget "len([i for i in d['items'] if i['type']=='mail'])")
for d in home main; do
  [ "$(api "$d" GET "/api/threads/$TID" | jget "len(d)")" = "$N" ] || fail "/api/threads/$TID through $d doesn't show each of the $N posts once"
  [ "$(api "$d" GET "/api/itsas/$KEY/thread" | jget "len([i for i in d['items'] if i['type']=='mail'])")" = "$N" ] || fail "the ITSA thread through $d doesn't show $N posts"
done
# Same-id copies keep every recipient: the last post, named to the human, went to the human (home), alice (home),
# and carol (main), and the thread through either daemon lists all of them.
for d in home main; do
  api "$d" GET "/api/threads/$TID" | jget "sorted(r['id'] for r in d[-1]['recipients'])" | grep -q human || fail "the merged copy through $d lost the human recipient"
  api "$d" GET "/api/threads/$TID" | jget "sorted(r['id'] for r in d[-1]['recipients'])" | grep -q "$CAROL" || fail "the merged copy through $d lost carol"
done
[ "$(api home GET "/api/itsas/$KEY/thread" | jget "len([i for i in d['items'] if i['type']=='mail' and i['mail']['body']=='same words'])")" = 2 ] || fail "identical comments folded into one"

echo "PASS e2e-itsa-thread"
