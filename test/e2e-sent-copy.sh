#!/bin/sh
# The sender's copy of mail to a peer (S-241), free (no models). Two peered throwaway daemons:
# "main" holds boss, "twin" holds far.
# Checks:
#   - boss on main mails far on twin; main keeps the mail under its id, so reply_to that id works
#     from main, and the reply joins the same thread on both daemons
#   - the thread and boss's merged thread list show each mail once, from both daemons' copies
#   - a mail queued while twin is down is in boss's thread on main, and still shows once after
#     twin is back and the queue delivers it
#   - the sender's copy is never unread for anyone: far's inbox has the mail once, read state untouched
#   - a send a peer refuses (400) leaves no copy on main
#   - boss's mail search shows far among the people of the thread, not only boss
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
# A throwaway stand-in peer ("fake"): knows agent fxa, refuses every mail with 400.
FAKE_PORT=$(free_port)
cat >"$TEST_TMP/fake.mjs" <<'JS'
import { createServer } from 'node:http';
createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && req.url === '/api/agents/fxa') return json(200, { id: 'fx1', name: 'fxa', machine: 'fake', lifecycle: 'active', role: 'test', harness: 'claude' });
    if (req.method === 'POST' && req.url === '/api/mail') return json(400, { error: 'nope' });
    json(404, { error: 'not found' });
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
JS
node "$TEST_TMP/fake.mjs" "$FAKE_PORT" &
FAKE_PID=$!
trap 'kill $FAKE_PID 2>/dev/null; stam_test_cleanup' EXIT
python3 - "$TEST_TMP" "$FAKE_PORT" <<'PY'
import json, re, sys
tmp, fake_port = sys.argv[1], sys.argv[2]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, others in (("main", [peer("twin"), {"name": "fake", "url": f"http://127.0.0.1:{fake_port}", "token": "x"}]), ("twin", [peer("main")])):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = others
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_OUTBOX_MS=300
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
# once ID_LIST_JSON: how many times the mail ids of a thread listing show, one per distinct id.
mail_ids() { jget "' '.join(m['id'] for m in d)"; }

BOSS=$(api main POST /api/register '{"name":"boss","role":"test","harness":"claude"}' | jget "d['id']")
FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")
api main GET /api/agents >/dev/null

echo "-- boss mails far; main keeps the sent mail, so a reply to it works from main"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"first\",\"body\":\"one\"}")
M1=$(printf "%s" "$R" | jget "d['id']"); TID=$(printf "%s" "$R" | jget "d['thread_id']")
[ -n "$M1" ] || fail "send failed (got: $R)"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"Re: first\",\"body\":\"two\",\"reply_to\":\"$M1\"}")
printf "%s" "$R" | grep -q '"error"' && fail "reply_to the sent mail failed on main (got: $R)"
M2=$(printf "%s" "$R" | jget "d['id']")
[ "$(printf "%s" "$R" | jget "d['thread_id']")" = "$TID" ] || fail "the reply didn't join the thread"
api twin GET "/api/threads/$TID" | mail_ids | tr ' ' '\n' | grep -qx "$M2" || fail "twin's thread lacks the reply"

echo "-- the thread and the merged list show each mail once"
ids=$(api main GET "/api/threads/$TID" | mail_ids)
[ "$(printf "%s\n" $ids | sort | uniq -d | wc -l)" = 0 ] || fail "main's thread shows a mail twice: $ids"
printf "%s\n" $ids | grep -qx "$M1" || fail "main's thread lacks the first mail"
printf "%s\n" $ids | grep -qx "$M2" || fail "main's thread lacks the reply"
LIST=$(api main GET "/api/agents/$BOSS/threads?limit=50" | jget "len([t for t in d if t['thread_id']=='$TID'])")
[ "$LIST" = 1 ] || fail "the merged thread list shows the thread $LIST times"

echo "-- a queued mail is in boss's thread while twin is down, and once after delivery"
daemon_stop twin
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"Re: first\",\"body\":\"three\",\"reply_to\":\"$M2\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "mail to far wasn't queued (got: $R)"
M3=$(printf "%s" "$R" | jget "d['id']")
ids=$(api main GET "/api/threads/$TID" | mail_ids)
printf "%s\n" $ids | grep -qx "$M3" || fail "boss's thread on main lacks the queued mail"
daemon_up twin
delivered() { api main GET "/api/agents/$BOSS/events" | grep -q "mail:delivered_late"; }
for i in $(seq 1 120); do delivered && break; sleep 0.5; done
delivered || fail "the queued mail was never delivered"
ids=$(api main GET "/api/threads/$TID" | mail_ids)
[ "$(printf "%s\n" $ids | grep -cx "$M3")" = 1 ] || fail "the queued mail shows $(printf "%s\n" $ids | grep -cx "$M3") times after delivery"
api twin GET "/api/agents/$FAR/inbox?unread=0" | jget "len([m for m in d if m['id']=='$M3'])" | grep -qx 1 || fail "far didn't get the queued mail once"

echo "-- the sender's copy is never unread for boss, and never in boss's inbox"
api main GET "/api/agents/$BOSS/inbox?unread=1" | jget "len([m for m in d if m['id'] in ('$M1','$M2','$M3')])" | grep -qx 0 || fail "boss has its own sent mail unread"
echo "-- each view on main shows mail once: boss's own views, then the human's (the mail Dana sends to far)"
# count ID JSON: how many mail objects (dicts with that id) the response holds, at any depth.
# countt ID JSON: how many search rows or thread entries hold that thread id.
count() { printf "%s" "$2" | python3 -c "
import json,sys
want=sys.argv[1]
def walk(x):
    if isinstance(x, dict): return (1 if x.get('id')==want and 'subject' in x else 0) + sum(walk(v) for v in x.values())
    if isinstance(x, list): return sum(walk(v) for v in x)
    return 0
print(walk(json.load(sys.stdin)))" "$1"; }
countt() { printf "%s" "$2" | python3 -c "
import json,sys
want=sys.argv[1]
d=json.load(sys.stdin)
print(sum(1 for x in d if isinstance(x, dict) and x.get('thread_id')==want))" "$1"; }
S=$(api main GET "/api/mail/search?box=$BOSS&q=first&limit=20")
[ "$(countt "$TID" "$S")" = 1 ] || fail "boss's mail search shows the thread $(countt "$TID" "$S") times (got: $S)"
W=$(api main GET "/api/agents/$BOSS/threads?limit=50")
[ "$(count "$M1" "$W")" = 1 ] || fail "boss's world shows the first mail $(count "$M1" "$W") times"
T=$(api main GET "/api/threads/$TID")
[ "$(count "$M1" "$T")" = 1 ] || fail "the thread opened on main shows the first mail $(count "$M1" "$T") times"
R=$(curl -s -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "{\"from\":\"human\",\"to\":[\"far\"],\"subject\":\"octocat note\",\"body\":\"hello from octocat about the sent copy\"}" "$MAIN_URL/api/mail")
HN=$(printf "%s" "$R" | jget "d['id']") || fail "the human's mail to far failed (got: $R)"
HT=$(printf "%s" "$R" | jget "d['thread_id']")
HS=$(api main GET "/api/mail/search?box=human&q=octocat%20note&limit=20")
[ "$(countt "$HT" "$HS")" = 1 ] || fail "the human's mail search shows its thread $(countt "$HT" "$HS") times (got: $HS)"
HL=$(api main GET "/api/agents/human/threads?limit=50")
[ "$(countt "$HT" "$HL")" = 1 ] || fail "the human's thread list shows its thread $(countt "$HT" "$HL") times"
A=$(api main GET "/api/search?q=octocat%20note&limit=20")
[ "$(printf "%s" "$A" | python3 -c "import json,sys; print(sum(1 for x in json.load(sys.stdin) if x.get('kind')=='thread' and x.get('id')=='$HT'))")" = 1 ] || fail "search shows the human's thread other than once (got: $A)"
echo "-- a refused send leaves no copy on main"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"fxa\"],\"subject\":\"refused one\",\"body\":\"x\"}")
printf "%s" "$R" | grep -q "fake: nope" || fail "the refused send didn't fail (got: $R)"
W=$(api main GET "/api/agents/$BOSS/threads?limit=50")
[ "$(printf "%s" "$W" | python3 -c "import json,sys; print(sum(1 for t in json.load(sys.stdin) for m in t['mails'] if m['subject']=='refused one'))")" = 0 ] || fail "a refused send left a copy on main"
echo "-- a relayed send with only remote recipients returns the mail id"
R=$(curl -s -X POST -H "authorization: Bearer $(cat "$TEST_TMP/main/peer-token")" -H 'content-type: application/json' -H 'x-stam-local: 1' -d "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"relayed\",\"body\":\"x\",\"relay\":true,\"forwarded\":{\"from_name\":\"boss\"}}" "$MAIN_URL/api/mail")
printf "%s" "$R" | jget "d['id']" | grep -q . || fail "a relayed send returned no id (got: $R)"
printf "%s" "$R" | jget "d['thread_id']" | grep -q . || fail "a relayed send returned no thread (got: $R)"
echo "-- boss's mail search lists far among the people of the thread"
PEOPLE=$(api main GET "/api/mail/search?box=$BOSS&q=first&limit=20" | jget "' '.join(p for r in d if r['thread_id']=='$TID' for p in r['people'])")
printf "%s" "$PEOPLE" | grep -qw far || fail "mail search lists no far among the people (got: $PEOPLE)"
echo "PASS e2e-sent-copy"
