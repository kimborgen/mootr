#!/bin/sh
# ITSA fields across two machines, free (no models), S-366: two isolated daemons, "home" is the
# ITSA home (settings.itsa.home) and "main" proxies to it. alice and bob are scripted agents on
# main, each holding its own token. Checks:
#   - with no chief of staff, any agent defines a field through main (the proxy)
#   - a field is created and valued through main, and the value shows in list and show
#   - with alice the chief of staff (set on home, resolved through the peer), alice and the
#     human may change definitions and bob gets 403 naming alice, for every definition route
#   - bob still sets a value, and a bad value is a 400
#   - reorder and remove (with its values) work through the proxy
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
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
for me, other in (("main", "home"), ("home", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer(other)]
    s.setdefault("itsa", {})["home"] = "home"
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up home
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
# api DAEMON METHOD PATH [BODY]: as the human.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
}
# as TOKEN METHOD PATH [BODY]: an agent through main; prints "STATUS BODY".
as() {
  _t=$1; _m=$2; _p=$3; shift 3
  curl -s -w ' %{http_code}' -X "$_m" -H "authorization: Bearer $_t" -H 'content-type: application/json' ${1:+-d "$1"} "$MAIN_URL$_p" | python3 -c "import sys; t=sys.stdin.read(); b,_,c=t.rpartition(' '); print(c, b)"
}
code() { echo "$1" | cut -d' ' -f1; }
token_of() {
  on main sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$1"
}
has_token() { [ -n "$(token_of "$1")" ]; }

WORK="$TEST_TMP/work"; mkdir -p "$WORK"
spawn() { api main POST /api/agents "{\"name\":\"$1\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}" | jget "d['id']"; }
ALICE=$(spawn alice) || fail "alice didn't spawn"
BOB=$(spawn bob) || fail "bob didn't spawn"
wait_until has_token "$ALICE"; wait_until has_token "$BOB"
ALICE_TOKEN=$(token_of "$ALICE"); BOB_TOKEN=$(token_of "$BOB")

echo "-- no chief of staff: any agent defines a field through the proxy"
R=$(as "$BOB_TOKEN" POST /api/itsas/fields '{"key":"pr","label":"PR","type":"link"}')
[ "$(code "$R")" = 200 ] || fail "bob couldn't create a field with no chief of staff: $R"
[ "$(api home GET /api/itsas/fields | jget "[f['created_by'] for f in d]")" = "['$BOB']" ] || fail "the field wasn't created by bob's id on the home"

echo "-- a field is created and valued through main; list and show carry the value"
api main POST /api/itsas/fields '{"key":"stage","label":"Stage","type":"choice","options":[{"value":"dev","label":"Dev","tone":"accent"},{"value":"live","tone":"ok"}],"card":"chip"}' | grep -q '"key":"stage"' || fail "the human couldn't create stage"
# bob takes part, so his changes reach the field checks (an agent changes only an ITSA it's in, S-480).
K=$(api main POST /api/itsas '{"title":"Valued","participants":["'"$BOB"'"]}' | jget "d['key']")
api main PATCH "/api/itsas/$K" '{"fields":{"stage":"dev","pr":"https://example.com/pr/1"}}' | grep -q '"fields"' || fail "setting values failed"
[ "$(api main GET "/api/itsas/$K" | jget "d['fields']['stage']")" = dev ] || fail "show doesn't carry the value"
[ "$(api main GET /api/itsas | jget "d[0]['fields']['pr']")" = "https://example.com/pr/1" ] || fail "list doesn't carry the value"
[ "$(code "$(as "$BOB_TOKEN" PATCH "/api/itsas/$K" '{"fields":{"stage":"nope"}}')")" = 400 ] || fail "a bad value wasn't a 400"

echo "-- alice is the chief of staff (set on the home): she and the human change definitions, bob gets 403"
curl -sf -X PATCH -H "authorization: Bearer $HOME_TOKEN" -H 'content-type: application/json' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" \
  -d '{"patch":{"chiefOfStaff":"alice"}}' "$HOME_URL/api/config/settings" >/dev/null || fail "couldn't set the chief of staff on the home"
R=$(as "$ALICE_TOKEN" PATCH /api/itsas/fields/pr '{"label":"Pull request"}')
[ "$(code "$R")" = 200 ] || fail "the chief of staff couldn't update a field: $R"
api main PATCH /api/itsas/fields/pr '{"hint":"the PR"}' | grep -q '"hint":"the PR"' || fail "the human couldn't update a field"
for op in "POST /api/itsas/fields {\"key\":\"x\",\"label\":\"X\",\"type\":\"text\"}" "PATCH /api/itsas/fields/pr {\"label\":\"Z\"}" "POST /api/itsas/fields/order {\"order\":[]}" "DELETE /api/itsas/fields/pr"; do
  set -- $op
  R=$(as "$BOB_TOKEN" "$1" "$2" "$3")
  [ "$(code "$R")" = 403 ] || fail "bob's $1 $2 wasn't refused: $R"
  echo "$R" | grep -q "chief of staff (alice)" || fail "the refusal doesn't name alice: $R"
done
[ "$(api main GET /api/itsas/fields | jget "len(d)")" = 2 ] || fail "a refused call changed the fields"

echo "-- bob still sets a value; reorder and remove (with values) work through the proxy"
[ "$(code "$(as "$BOB_TOKEN" PATCH "/api/itsas/$K" '{"fields":{"stage":"live"}}')")" = 200 ] || fail "bob couldn't set a value"
[ "$(api main POST /api/itsas/fields/order '{"order":["stage","pr"]}' | jget "[f['key'] for f in d]")" = "['stage', 'pr']" ] || fail "reorder failed"
[ "$(code "$(as "$ALICE_TOKEN" DELETE /api/itsas/fields/stage)")" = 200 ] || fail "alice couldn't remove a field"
[ "$(api main GET "/api/itsas/$K" | jget "sorted(d['fields'])")" = "['pr']" ] || fail "removing a field left its value"
echo "PASS e2e-itsa-fields"
