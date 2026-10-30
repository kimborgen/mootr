#!/bin/sh
# S-352 across peers, free (no models, no agent turns). Two isolated daemons, "main" and "twin",
# peered. An agent on twin mails the human a decision, so twin stores it. Checks:
#   - main lists the decision mail stored on twin, once
#   - the human's reply on twin, which holds the thread, clears it on main and on twin (main
#     can't reply to a mail it doesn't hold: mail.ts refuses an unknown reply_to)
#   - the human can't archive its thread on main while it is open (409), and can after the reply
#   - a decision mail about an ITSA homed on twin, in a human status, stays off main's list, and
#     is listed on main once that ITSA leaves the human status
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
FENCE='```'

FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")

echo "-- a decision mail stored on twin is listed on main, once"
R=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Pick a release\",\"body\":\"Which?\n\n${FENCE}pick\nbilling\nsearch\n${FENCE}\"}")
M1=$(printf '%s' "$R" | jget "d['id']"); T1=$(printf '%s' "$R" | jget "d['thread_id']")
[ "$(listed main "$M1")" = 1 ] || fail "main doesn't list twin's decision mail once (got $(listed main "$M1"))"
[ "$(listed twin "$M1")" = 1 ] || fail "twin doesn't list its own decision mail"

echo "-- the human's reply on twin, where the thread is, clears it on both daemons"
api twin POST /api/mail "{\"from\":\"human\",\"to\":[\"$FAR\"],\"subject\":\"Re: Pick a release\",\"body\":\"billing\",\"reply_to\":\"$M1\"}" human >/dev/null
_gone() { [ "$(listed main "$1")" = 0 ]; }
wait_until _gone "$M1" || fail "main still lists the decision after the human's reply"

echo "-- main refuses to archive the thread while it is open, and allows it after the reply"
R2=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Pick again\",\"body\":\"${FENCE}yesno\nship?\n${FENCE}\"}")
M2=$(printf '%s' "$R2" | jget "d['id']"); T2=$(printf '%s' "$R2" | jget "d['thread_id']")
# The listing may lag a peer's write by up to the memo's TTL (5 s), so it waits; the archive checks below don't.
_listedSecond() { [ "$(listed main "$M2")" = 1 ]; }
wait_until _listedSecond || fail "main doesn't list the second decision"
[ "$(status main POST "/api/agents/human/threads/$T2/archive")" = 409 ] || fail "main archived a thread with an open decision"
api twin POST /api/mail "{\"from\":\"human\",\"to\":[\"$FAR\"],\"subject\":\"Re: Pick again\",\"body\":\"yes\",\"reply_to\":\"$M2\"}" human >/dev/null
# main's memo still holds the decision open, so this passes only if the archive check reads the peers fresh.
[ "$(status main POST "/api/agents/human/threads/$T2/archive")" = 200 ] || fail "main refused to archive after the human answered on twin (the archive check read a memoized decision)"
wait_until _gone "$M2" || fail "the second decision isn't cleared"
[ "$(status main POST "/api/agents/human/threads/$T2/archive")" = 200 ] || fail "main refused to archive a thread with no open decision"

echo "-- a decision mail about an ITSA homed on twin is left off main while the ITSA waits on the human"
KEY=$(on twin "$STAM" itsa new "Held on twin" --owner far --status in_progress | awk '{print $1}')
api twin POST "/api/itsas/$KEY/post" "{\"by\":\"$FAR\",\"body\":\"Done: ready to look at.\"}" >/dev/null
api twin PATCH "/api/itsas/$KEY" "{\"status\":\"needs_review\",\"by\":\"$FAR\"}" >/dev/null
R3=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"About $KEY\",\"body\":\"${FENCE}question\nyes?\n${FENCE}\",\"itsa\":\"$KEY\"}")
M3=$(printf '%s' "$R3" | jget "d['id']")
[ "$(listed main "$M3")" = 0 ] || fail "main lists a decision about an ITSA waiting on the human, homed on twin"
api twin PATCH "/api/itsas/$KEY" "{\"status\":\"in_progress\",\"by\":\"$FAR\"}" >/dev/null
_listed() { [ "$(listed main "$M3")" = 1 ]; }
wait_until _listed || fail "main doesn't list the decision once its ITSA leaves the human status"

echo "PASS: decision mails across peers"
