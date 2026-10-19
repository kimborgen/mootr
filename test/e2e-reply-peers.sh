#!/bin/sh
# Kim's reply to a mail a peer stores (S-359), free (no models). Two isolated daemons, "main"
# (the human's web UI) and "twin", peered. far, an agent on twin, mails the human, so the mail
# is stored on twin only. Kim replies on main naming it:
#   - the reply resolves the mail through twin and is delivered to far on twin
#   - the reply joins the mail's thread on both daemons
#   - the mail record is shown to far, which sent it, and not to nosy, another agent on twin
#   - so is the mail's thread and subject (S-388), on twin and through main for kid, an agent
#     there, while Kim's web UI on main still resolves it
#   - nor to oc, an OpenCode agent on main, or the shared token naming kid's box: main asks twin
#     for the box it read as, so twin doesn't answer as for a daemon (S-467); nor are the threads
#     of an agent on twin that shares oc's name, when oc lists its own threads (S-476)
#   - kid, an agent on main in none of its threads, can't reply to it, and the error says it
#     isn't a participant rather than that there is no such mail (S-400)
#   - a reply naming no mail on any daemon still fails with the old error, and says so when a
#     peer couldn't be asked
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
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
    s = json.load(open(path))
    s["peers"] = [peer(other)]
    s["mail"] = {"titles": {"model": ""}}
    s["decisions"] = {"mailCheck": False}
    # boss, the chief of staff on main, replies to a mail only twin stores (S-359).
    if me == "main":
        s["chiefOfStaff"] = "boss"
    json.dump(s, open(path, "w"), indent=2)
PY
# Agents on twin are fake Claude Code runs (test/fake-claude), so no model is called.
printf '%s\n' '{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }' >"$TEST_TMP/reply.json"
fake_claude "$TEST_TMP/reply.json"
# oc, an OpenCode agent on main, runs in the fake OpenCode server (test/fake-opencode).
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
daemon_up main
daemon_up twin
trap stam_test_cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
# Kim's web UI sends as the human: the daemon takes the x-stam-human header for that.
kim() {
  curl -s -X "$1" -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "$3" "$MAIN_URL$2"
}
# An agent by its own token (minted at its launch and read from its tmux environment): agent_token DAEMON NAME.
agent_token() {
  _id=$(api "$1" GET /api/agents | jget "next(a['id'] for a in d if a['name']=='$2')")
  on "$1" sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN | cut -d= -f2-' _ "$_id"
}

api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' >/dev/null
on twin "$STAM" spawn nosy --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on twin "$STAM" wait nosy --until idle --timeout 60
on main "$STAM" spawn boss --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on main "$STAM" wait boss --until idle --timeout 60
on main "$STAM" spawn kid --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on main "$STAM" wait kid --until idle --timeout 60
FAR=$(api twin GET /api/agents | jget "next(a['id'] for a in d if a['name']=='far')")
BOSS=$(api main GET /api/agents | jget "next(a['id'] for a in d if a['name']=='boss')")
BOSS_TOKEN=$(agent_token main boss)
KID=$(api main GET /api/agents | jget "next(a['id'] for a in d if a['name']=='kid')")
KID_TOKEN=$(agent_token main kid)
on main "$STAM" spawn oc --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$TEST_TMP" "Say hello." >/dev/null
on main "$STAM" wait oc --until idle --timeout 60
OC=$(api main GET /api/agents | jget "next(a['id'] for a in d if a['name']=='oc')")
# The OpenCode server's token is the STAM_TOKEN in its tmux session (_opencode).
OC_TOKEN=$(on main sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t _opencode STAM_TOKEN | cut -d= -f2-')
[ -n "$OC_TOKEN" ] || fail "the OpenCode server on main has no token"
NOSY_TOKEN=$(agent_token twin nosy)
[ -n "$NOSY_TOKEN" ] || fail "nosy on twin has no token"
api main GET /api/agents | jget "[a['name'] for a in d]" | grep -q "far" || fail "main doesn't list far"

echo "-- far mails the human on twin: the mail is stored there"
M1=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Pick a cache\",\"body\":\"Redis or memcached?\",\"new_thread\":true}" | jget "d['id']") || fail "far's mail to the human failed"
api main GET /api/agents/human/inbox | jget "any(m['id']=='$M1' for m in d)" | grep -qx True || fail "the human on main doesn't see far's mail"

echo "-- the mail record: far sent it, nosy didn't"
api twin GET "/api/mail/$M1?box=$FAR" | jget "len(d)" | grep -qx 1 || fail "far's box doesn't show its own mail record"
curl -s -H "authorization: Bearer $NOSY_TOKEN" "$TWIN_URL/api/mail/$M1" | jget "len(d)" | grep -qx 0 || fail "nosy reads far's mail record"

echo "-- the mail's thread and subject (S-388): far and Kim see them, nosy and kid don't"
api twin GET "/api/mail/$M1/thread?box=$FAR" | jget "d[0]['subject']" | grep -qx "Pick a cache" || fail "far's box doesn't see its own mail's thread"
api main GET "/api/mail/$M1/thread" | jget "d[0]['thread_id']" | grep -qx "$M1" || fail "Kim's web UI on main doesn't resolve the peer mail's thread"
curl -s -H "authorization: Bearer $NOSY_TOKEN" "$TWIN_URL/api/mail/$M1/thread" | jget "len(d)" | grep -qx 0 || fail "nosy reads far's mail thread on twin"
curl -s -H "authorization: Bearer $KID_TOKEN" "$MAIN_URL/api/mail/$M1/thread" | jget "len(d)" | grep -qx 0 || fail "kid reads far's mail thread through main"
echo "-- through main, the OpenCode server and the shared token are checked on twin as the box they name (S-467)"
curl -s -H "authorization: Bearer $OC_TOKEN" "$MAIN_URL/api/mail/$M1/thread?box=$OC" | jget "len(d)" | grep -qx 0 || fail "oc reads far's mail thread through main"
curl -s -H "authorization: Bearer $OC_TOKEN" "$MAIN_URL/api/mail/$M1?box=$OC" | jget "len(d)" | grep -qx 0 || fail "oc reads far's mail record through main"
curl -s -H "authorization: Bearer $OC_TOKEN" "$MAIN_URL/api/threads/$M1?box=$OC" | jget "len(d)" | grep -qx 0 || fail "oc reads far's thread through main"
api main GET "/api/mail/$M1/thread?box=$KID" | jget "len(d)" | grep -qx 0 || fail "the shared token naming kid's box reads far's mail thread"
api main GET "/api/mail/$M1?box=$KID" | jget "len(d)" | grep -qx 0 || fail "the shared token naming kid's box reads far's mail record"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $OC_TOKEN" "$MAIN_URL/api/mail/$M1/thread")" = 403 ] || fail "the OpenCode server read a mail thread naming no box"
curl -s -H "authorization: Bearer $BOSS_TOKEN" "$MAIN_URL/api/mail/$M1/thread" | jget "d[0]['thread_id']" | grep -qx "$M1" || fail "boss, the chief of staff, doesn't resolve the peer mail's thread"
echo "-- oc's threads through main: twin is asked as oc, so twin's own agent named oc stays private (S-476)"
TWIN_OC=$(api twin POST /api/register '{"name":"oc","role":"test","harness":"claude"}' | jget "d['id']") || fail "twin refused an agent named oc"
api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"$TWIN_OC\"],\"subject\":\"Twin oc only\",\"body\":\"Not for main's oc.\",\"new_thread\":true}" >/dev/null
OC_THREADS=$(curl -s -H "authorization: Bearer $OC_TOKEN" "$MAIN_URL/api/agents/oc/threads?limit=50")
printf "%s" "$OC_THREADS" | jget "isinstance(d, list)" | grep -qx True || fail "oc can't list its own threads through main (got: $OC_THREADS)"
printf "%s" "$OC_THREADS" | jget "any(m['subject']=='Twin oc only' for t in d for m in t['mails'])" | grep -qx False || fail "oc reads the threads of twin's agent named oc through main"

echo "-- Kim replies on main to the mail stored on twin"
R=$(kim POST /api/mail "{\"from\":\"human\",\"to\":[\"far\"],\"reply_to\":\"$M1\",\"body\":\"Redis.\"}")
M2=$(printf "%s" "$R" | jget "d['id']") || fail "the reply to a peer-stored mail failed (got: $R)"

echo "-- far gets the reply in the thread on twin"
api twin GET "/api/agents/far/inbox?unread=0&limit=20" | jget "next((m['subject'] for m in d if m['id']=='$M2'), '')" | grep -qx "Re: Pick a cache" || fail "far's inbox on twin has no reply titled Re: Pick a cache"
api twin GET "/api/agents/far/threads?limit=50" | jget "len([t for t in d if t['thread_id']=='$M1' and sorted(m['id'] for m in t['mails'])==sorted(['$M1','$M2'])])" | grep -qx 1 || fail "far's thread on twin lacks the reply"

echo "-- the human's thread on main holds both mails"
api main GET "/api/agents/human/threads?limit=50" | jget "len([t for t in d if t['thread_id']=='$M1' and sorted(m['id'] for m in t['mails'])==sorted(['$M1','$M2'])])" | grep -qx 1 || fail "the human's thread on main lacks the reply"

echo "-- boss, the chief of staff on main, replies to the mail stored on twin"
R5=$(curl -s -X POST -H "authorization: Bearer $BOSS_TOKEN" -H 'content-type: application/json' -d "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"reply_to\":\"$M1\",\"body\":\"Memcached, from boss.\"}" "$MAIN_URL/api/mail")
M5=$(printf "%s" "$R5" | jget "d['id']") || fail "boss's reply to a peer-stored mail failed (got: $R5)"
api twin GET "/api/agents/far/inbox?unread=0&limit=20" | jget "next((m['subject'] for m in d if m['id']=='$M5'), '')" | grep -qx "Re: Pick a cache" || fail "far on twin has no reply from boss"

echo "-- kid on main, in none of its threads, can't reply to it and is told why (S-400)"
R6=$(curl -s -X POST -H "authorization: Bearer $KID_TOKEN" -H 'content-type: application/json' -d "{\"from\":\"$KID\",\"to\":[\"far\"],\"reply_to\":\"$M1\",\"body\":\"Me too.\"}" "$MAIN_URL/api/mail")
printf "%s" "$R6" | grep -q "mail $M1 isn't visible to you (you aren't in its thread)" || fail "kid's reply wasn't refused as a non-participant (got: $R6)"
printf "%s" "$R6" | grep -q "new_thread: true" || fail "the non-participant error doesn't say to start a new thread (got: $R6)"
api twin GET "/api/agents/far/inbox?unread=0&limit=20" | jget "any(m['from_id']=='$KID' for m in d)" | grep -qx False || fail "kid's refused reply still reached far"

echo "-- a reply naming no mail on any daemon fails as before"
R3=$(kim POST /api/mail '{"from":"human","to":["far"],"reply_to":"nope-nope","body":"x"}')
printf "%s" "$R3" | grep -q "no mail nope-nope to reply to\"" || fail "a reply to no mail didn't fail as before (got: $R3)"

echo "-- with twin stopped, the same error says a peer was unreachable"
daemon_stop twin
R4=$(kim POST /api/mail '{"from":"human","to":["far"],"reply_to":"nope-nope","body":"x"}')
printf "%s" "$R4" | grep -q "no mail nope-nope to reply to (a peer was unreachable)" || fail "no unreachable note with twin down (got: $R4)"
echo "PASS: a human reply to a peer-stored mail reaches the agent and threads"
