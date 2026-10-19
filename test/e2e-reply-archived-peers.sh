#!/bin/sh
# A reply in a thread where an agent on a peer took part and is gone since (S-603), free (no
# models). Two isolated daemons, "main" (the ITSA home and the human's web UI, with boss, the
# chief of staff) and "twin", peered. On twin, far is live and gone is archived; both are
# participants of an ITSA on main, and gone started a plain thread with far and boss.
#   - with twin down, boss's reply in the ITSA's thread (send_mail with reply_to) skips gone,
#     whom main last saw archived, instead of failing as a whole with "no agent ID"; far's copy waits
#   - so does the human's reply from the web UI (ThreadView's to, sent as inferred), which named
#     nobody: the thread's people are inferred, and gone is skipped, not refused
#   - with twin up and gone forgotten there, the human's web reply in gone's plain thread
#     reaches far and says it skipped gone, where it was refused as "gone no longer exists"
#   - a recipient the sender names, whom nobody has, is still refused, and the refusal names it
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
    s.setdefault("itsa", {})["home"] = "main"
    s["mail"] = {"titles": {"model": ""}}
    s["decisions"] = {"mailCheck": False}
    if me == "main":
        s["chiefOfStaff"] = "boss"
    json.dump(s, open(path, "w"), indent=2)
PY
printf '%s\n' '{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }' >"$TEST_TMP/reply.json"
fake_claude "$TEST_TMP/reply.json"
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

on main "$STAM" spawn boss --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on main "$STAM" wait boss --until idle --timeout 60
BOSS=$(api main GET /api/agents | jget "next(a['id'] for a in d if a['name']=='boss')")
BOSS_TOKEN=$(on main sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN | cut -d= -f2-' _ "$BOSS")
[ -n "$BOSS_TOKEN" ] || fail "boss on main has no token"
# boss's call to POST /api/mail, as its send_mail tool makes it.
boss_mail() { curl -s -X POST -H "authorization: Bearer $BOSS_TOKEN" -H 'content-type: application/json' -d "$1" "$MAIN_URL/api/mail"; }
FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")
on twin "$STAM" spawn gone --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on twin "$STAM" wait gone --until idle --timeout 60
GONE=$(api twin GET /api/agents/gone | jget "d['id']")
GONE_TOKEN=$(on twin sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN | cut -d= -f2-' _ "$GONE")

echo "-- an ITSA on main with boss, far, and gone; the human posts in it"
KEY=$(kim POST /api/itsas "{\"title\":\"Reply past the gone\",\"owner\":\"$BOSS\",\"participants\":[\"$FAR\",\"$GONE\"]}" | jget "d['key']")
kim GET "/api/itsas/$KEY" | jget "sorted(d['participants'])==sorted(['$BOSS','$FAR','$GONE'])" | grep -qx True || fail "$KEY lacks its participants"
M1=$(kim POST "/api/itsas/$KEY/post" '{"by":"human","body":"Where are we?"}' | jget "d['id']") || fail "the human's post in $KEY failed"
echo "-- gone starts a plain thread with far and boss on twin"
R=$(curl -s -X POST -H "authorization: Bearer $GONE_TOKEN" -H 'content-type: application/json' -d "{\"from\":\"$GONE\",\"to\":[\"$FAR\",\"$BOSS\"],\"subject\":\"Gone soon\",\"body\":\"Any last words?\",\"new_thread\":true}" "$TWIN_URL/api/mail")
P1=$(printf "%s" "$R" | jget "d['id']") || fail "gone's mail failed (got: $R)"

echo "-- gone is archived on twin, and main sees it so"
on twin "$STAM" archive gone >/dev/null
on twin "$STAM" wait gone --until archived --timeout 30
wait_until sh -c "curl -s -H 'authorization: Bearer $MAIN_TOKEN' '$MAIN_URL/api/agents' | python3 -c \"import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(a['id']=='$GONE' and a['lifecycle']=='archived' for a in d) else 1)\""

echo "-- with twin down, boss's reply in $KEY skips gone instead of failing"
daemon_stop twin
R=$(boss_mail "{\"from\":\"$BOSS\",\"to\":[\"human\"],\"reply_to\":\"$M1\",\"body\":\"On it.\"}")
printf "%s" "$R" | grep -q "no agent" && fail "boss's reply failed on gone (got: $R)"
B1=$(printf "%s" "$R" | jget "d['id']") || fail "boss's reply failed (got: $R)"
T=$(kim GET "/api/itsas/$KEY/thread")
printf "%s" "$T" | jget "any(i.get('mail',{}).get('id')=='$B1' for i in d['items'])" | grep -qx True || fail "boss's reply isn't in $KEY's thread (reply: $R; thread: $T)"

echo "-- with twin down, the human's web reply in $KEY (to the thread's people, inferred) skips gone"
R=$(kim POST /api/mail "{\"from\":\"human\",\"to\":[\"$GONE\",\"$FAR\"],\"inferred\":[\"$GONE\",\"$FAR\"],\"reply_to\":\"$M1\",\"body\":\"Thanks, all.\"}")
H1=$(printf "%s" "$R" | jget "d['id']") || fail "the human's web reply in $KEY failed (got: $R)"
kim GET "/api/itsas/$KEY/thread" | jget "any(i.get('mail',{}).get('id')=='$H1' for i in d['items'])" | grep -qx True || fail "the human's reply isn't in $KEY's thread"

echo "-- with twin up and gone forgotten there, the human's web reply in gone's thread reaches far"
daemon_up twin
on twin "$STAM" forget gone >/dev/null
R=$(kim POST /api/mail "{\"from\":\"human\",\"to\":[\"$GONE\",\"$FAR\"],\"inferred\":[\"$GONE\",\"$FAR\"],\"reply_to\":\"$P1\",\"body\":\"Bye, gone.\"}")
H2=$(printf "%s" "$R" | jget "d['id']") || fail "the human's web reply in gone's thread failed (got: $R)"
printf "%s" "$R" | jget "d.get('skipped')" | grep -q "gone" || fail "the reply doesn't say it skipped gone (got: $R)"
wait_until sh -c "curl -s -H 'authorization: Bearer $TWIN_TOKEN' '$TWIN_URL/api/agents/far/inbox?limit=20' | grep -q '$H2'"

echo "-- the human's web reply to only gone (inferred) is refused in the outbox's words, not 'Name someone in to'"
R=$(kim POST /api/mail "{\"from\":\"human\",\"to\":[\"$GONE\"],\"inferred\":[\"$GONE\"],\"reply_to\":\"$P1\",\"body\":\"Only gone.\"}")
printf "%s" "$R" | grep -qF "gone no longer exists. Reply to someone else, or copy your text." || fail "the human's inferred-only reply wasn't refused in S-542's words (got: $R)"
printf "%s" "$R" | grep -q "Name someone in" && fail "the human is told to name someone in (got: $R)"

echo "-- a recipient the sender names, whom nobody has, is still refused by name"
R=$(kim POST /api/mail "{\"from\":\"human\",\"to\":[\"$GONE\"],\"reply_to\":\"$P1\",\"body\":\"Named.\"}")
printf "%s" "$R" | grep -q "gone no longer exists" || fail "the human's reply naming gone wasn't refused by name (got: $R)"
R=$(boss_mail "{\"from\":\"$BOSS\",\"to\":[\"nobody-here\"],\"reply_to\":\"$M1\",\"body\":\"Named.\"}")
printf "%s" "$R" | grep -q "nobody-here" || fail "boss's reply naming nobody-here wasn't refused by name (got: $R)"
printf "%s" "$R" | grep -q '"error"' || fail "boss's reply naming nobody-here wasn't refused (got: $R)"
echo "PASS: a reply skips a thread's gone participants, and refuses only a named one"
