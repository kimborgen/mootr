#!/bin/sh
# withdraw_ask across peers (S-425), free (no models). Two isolated daemons, "main" and "twin", peered. The
# child's decision mail is held on twin; the chief of staff is on main, so its call reaches main, which
# doesn't hold the mail, and main forwards it to twin as that agent. Checks:
#   - a stranger agent on main is refused by twin (403), and the mail still waits on both
#   - the chief of staff on main withdraws twin's mail (200): it leaves /api/mail/decisions on both daemons,
#     and twin's copy of the human's mail carries who did it
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/idle.json" <<'EOF3'
{ "turns": [ { "match": "", "steps": [ { "reply": "OK" } ] } ] }
EOF3
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
# api DAEMON METHOD PATH [BODY] [human]: the owner's calls, as the web and the tests make them.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  _human=; [ "$5" = human ] && _human='-H x-stam-human:1'
  curl -s -X "$2" -H "authorization: Bearer $_tok" $_human -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
# acall DAEMON TOKEN METHOD PATH [BODY]: an agent's own token on a daemon. Prints the status and the body.
acall() {
  _url=$MAIN_URL; [ "$1" = twin ] && _url=$TWIN_URL
  curl -s -w '\n%{http_code}' -X "$3" -H "authorization: Bearer $2" -H 'content-type: application/json' ${5:+-d "$5"} "$_url$4"
}
# The STAM_TOKEN of an agent on a daemon, from its tmux session.
token_on() { on "$1" sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$2"; }
has_token_on() { [ -n "$(token_on "$1" "$2")" ]; }
# How many times mail $1 is listed as a decision, as daemon $2 reports it.
listed() { api "$2" GET /api/mail/decisions | jget "[x['mail_id'] for x in d].count('$1')"; }

api twin POST /api/register '{"name":"kid","role":"test","harness":"claude"}' >/dev/null
KID=$(api twin GET /api/agents | jget "next(a['id'] for a in d if a['name']=='kid')")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
api main POST /api/agents "{\"name\":\"cos\",\"cwd\":\"$DIR\",\"prompt\":\"hello\"}" >/dev/null
api main POST /api/agents "{\"name\":\"stranger\",\"cwd\":\"$DIR\",\"prompt\":\"hello\"}" >/dev/null
COS=$(api main GET /api/agents | jget "next(a['id'] for a in d if a['name']=='cos')")
STRANGER=$(api main GET /api/agents | jget "next(a['id'] for a in d if a['name']=='stranger')")
wait_until has_token_on main "$COS"
wait_until has_token_on main "$STRANGER"
COS_TOKEN=$(token_on main "$COS"); STRANGER_TOKEN=$(token_on main "$STRANGER")
api main POST "/api/agents/$COS/chief-of-staff" '{}' >/dev/null

echo "-- the child's decision mail is held on twin, and listed on both"
R=$(api twin POST /api/mail "{\"from\":\"$KID\",\"to\":[\"human\"],\"subject\":\"Pick\",\"body\":\"Which?\n\n\`\`\`pick\nship\nhold\n\`\`\`\"}")
M=$(printf '%s' "$R" | jget "d['id']"); T=$(printf '%s' "$R" | jget "d['thread_id']")
[ "$(listed "$M" main)" = 1 ] && [ "$(listed "$M" twin)" = 1 ] || fail "the decision isn't listed on both"

echo "-- a stranger on main is refused by twin, and the mail still waits"
S=$(acall main "$STRANGER_TOKEN" POST "/api/mail/$M/withdraw-ask" '{"note":"moot"}')
[ "$(printf '%s' "$S" | tail -n1)" = 403 ] || fail "a stranger's forwarded withdraw got $(printf '%s' "$S" | tail -n1), not 403"
[ "$(listed "$M" main)" = 1 ] && [ "$(listed "$M" twin)" = 1 ] || fail "a refused ask left the list"

echo "-- the chief of staff on main withdraws twin's mail: it leaves both lists, and twin's copy says who"
S=$(acall main "$COS_TOKEN" POST "/api/mail/$M/withdraw-ask" '{"note":"answered in the terminal"}')
[ "$(printf '%s' "$S" | tail -n1)" = 200 ] || fail "the chief of staff's forwarded withdraw got $(printf '%s' "$S" | tail -n1): $S"
[ "$(listed "$M" main)" = 0 ] && [ "$(listed "$M" twin)" = 0 ] || fail "the withdrawn ask is still listed (main $(listed "$M" main), twin $(listed "$M" twin))"
COPY=$(api twin GET "/api/threads/$T?box=human" | jget "__import__('json').dumps([r for m in d if m['id']=='$M' for r in m['recipients'] if r['id']=='human'][0])")
printf '%s' "$COPY" | jget "d['withdrawn_by']" | grep -qx "$COS" || fail "twin's copy isn't withdrawn by the chief of staff: $COPY"
printf '%s' "$COPY" | jget "d['withdrawn_note']" | grep -q "Withdrawn by @cos: answered in the terminal" || fail "the note is wrong: $COPY"

echo "PASS: withdraw-ask across peers"
