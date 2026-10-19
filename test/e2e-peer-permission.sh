#!/bin/sh
# A harness dialog answered from another machine, free (no models), S-320: two isolated daemons,
# "main" and "twin", peered. main holds the chief of staff cos, the parent pa, and an unrelated
# stranger; twin holds pa's child kid, whose fake Claude Code shows a Read dialog.
# Checks:
#   - pa, with its own token on main, can't approve kid's dialog (only the human approves), and
#     its denial reaches twin: Esc goes into the dialog and kid hears who denied it
#   - cos on main denies kid's next dialog through the peer link too
#   - stranger on main is refused, and the request stays pending
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/dialog.json" <<'EOF2'
{ "turns": [
  { "match": "KIDREAD", "steps": [
    { "permission": "Read", "input": { "file_path": "/elsewhere/kid.log" }, "output": "LOGTEXT" },
    { "reply": "READ-${answer}" } ] },
  { "match": "was denied", "steps": [ { "reply": "NOTED: ${prompt}" } ] },
  { "match": "", "steps": [ { "reply": "OK" } ] } ] }
EOF2
fake_claude "$TEST_TMP/dialog.json"
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
    if me == "main":
        s["chiefOfStaff"] = "cos"
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${5:+-H 'x-stam-human: 1'} ${4:+-d "$4"} "$_url$3"
}
token_of() {
  on "$1" sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$2"
}
has_token() { [ -n "$(token_of "$1" "$2")" ]; }
# answer TOKEN ID APPROVE NOTE: an agent answers on main with its own token, as answer_permission does.
answer() {
  curl -s -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"approve\":$3,\"note\":\"$4\"}" "$MAIN_URL/api/permissions/$2/answer"
}
pending() { api twin GET '/api/permissions?status=pending' | jget "' '.join(r['id'] for r in d)"; }
status() { api twin GET /api/permissions | jget "next(r['status'] for r in d if r['id']=='$1')"; }
activity() { api twin GET "/api/agents/$KID" | jget "d['activity']"; }

WORK="$TEST_TMP/work"; mkdir -p "$WORK"
spawn() { api main POST /api/agents "$1" x | jget "d['id']"; }
COS=$(spawn "{\"name\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "cos didn't spawn"
PA=$(spawn "{\"name\":\"pa\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "pa didn't spawn"
STRANGER=$(spawn "{\"name\":\"stranger\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "stranger didn't spawn"
KID=$(spawn "{\"name\":\"kid\",\"machine\":\"twin\",\"parent\":\"pa\",\"cwd\":\"$WORK\",\"prompt\":\"KIDREAD one\"}") || fail "kid didn't spawn"
for pair in "main $COS" "main $PA" "main $STRANGER"; do
  set -- $pair
  wait_until has_token "$1" "$2"
done
COS_TOKEN=$(token_of main "$COS"); PA_TOKEN=$(token_of main "$PA"); STRANGER_TOKEN=$(token_of main "$STRANGER")

echo "-- kid's dialog on twin is a pending request there"
has_one() { [ -n "$(pending)" ]; }
wait_until has_one
P1=$(pending)

echo "-- a stranger on main is refused; the parent on main can't approve"
answer "$STRANGER_TOKEN" "$P1" false no | grep -q "can't answer" || fail "stranger answered kid's request"
answer "$PA_TOKEN" "$P1" true yes | grep -q 'only the human' || fail "pa approved a dialog"
[ "$(status "$P1")" = pending ] || fail "request $P1 is $(status "$P1") after refused answers"

echo "-- the parent on main denies it through the peer link"
R=$(answer "$PA_TOKEN" "$P1" false 'keep logs in ./tmp')
printf "%s" "$R" | grep -q '"denied"' || fail "pa couldn't deny kid's dialog on twin: $R"
# The notice arrives as a prompt over several lines; this joins them.
last() { api twin GET "/api/agents/$KID" | jget "(d.get('last_message') or '').replace(chr(10), ' ')"; }
noted() { last | grep -q 'NOTED: .*keep logs in ./tmp'; }
wait_until noted
last | grep -q 'denied by pa, your parent agent' || fail "kid didn't hear that pa denied it: $(last)"
idle() { [ "$(activity)" = idle ]; }
wait_until idle

echo "-- the chief of staff on main denies the next one"
on twin "$STAM" mail send --to kid --subject "KIDREAD two" "again" >/dev/null
other() { P2=$(pending); [ -n "$P2" ] && [ "$P2" != "$P1" ]; }
wait_until other
P2=$(pending)
R=$(answer "$COS_TOKEN" "$P2" false 'not needed')
printf "%s" "$R" | grep -q '"denied"' || fail "cos couldn't deny kid's dialog on twin: $R"
[ "$(api twin GET /api/permissions | jget "next(r['decided_by'] for r in d if r['id']=='$P2')")" = "$COS" ] || fail "the denial isn't recorded as cos's"
echo "PASS e2e-peer-permission"
