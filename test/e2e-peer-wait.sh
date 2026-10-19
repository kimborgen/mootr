#!/bin/sh
# wait_for on an agent that lives on a peer (S-275), free (no models). Two isolated daemons:
# "main" holds the target agent, "twin" the waiter. Checks:
#   - a waiter on twin can declare a reply wait on a target on main, named by name or id, and
#     the target gets its one wait_for notice
#   - the reply mail from the target, sent on main, clears the wait on twin
#   - a target on a peer that doesn't answer, but that twin has met before, still takes the
#     wait; the reply mail clears it once the peer is back
#   - an archived target is refused, on the peer and on this daemon
#   - a target nobody has still fails with "no agent"
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
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
# api DAEMON METHOD PATH [BODY] [human]: the human header only when asked, so `by` counts.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${5:+-H 'x-stam-human: 1'} ${4:+-d "$4"} "$_url$3"
}
hook() { api "$1" POST "/api/hook/claude/$2" "$3" | jget "d.get('stdout','')"; }
notice() { hook "$1" "$2" '{"hook_event_name":"PostToolUse"}'; }

TARGET=$(api main POST /api/register '{"name":"haiku-exp","role":"test","harness":"claude"}' x | jget "d['id']")
WAITER=$(api twin POST /api/register '{"name":"b-dev-1","role":"test","harness":"claude"}' x | jget "d['id']")

echo "-- a waiter on twin waits for a target on main, by name"
R=$(api twin POST "/api/agents/$WAITER/waits/declared" "{\"by\":\"$WAITER\",\"on\":\"agent\",\"target\":\"haiku-exp\"}")
W=$(printf "%s" "$R" | jget "d['id']") || fail "the waiter couldn't wait for haiku-exp on main (got: $R)"
target_asked() { notice main "$TARGET" | grep -q "b-dev-1 is waiting for your reply"; }
wait_until target_asked

echo "-- the target's reply on main clears the wait on twin"
api main POST /api/mail "{\"from\":\"$TARGET\",\"to\":[\"$WAITER\"],\"subject\":\"reply\",\"body\":\"here\"}" >/dev/null
waiter_clear() { [ "$(api twin GET "/api/agents/$WAITER/waits" | jget "len([w for w in d if w['id']=='$W'])")" = 0 ]; }
wait_until waiter_clear

echo "-- with main down, a target twin has met before still takes the wait"
daemon_stop main
R=$(api twin POST "/api/agents/$WAITER/waits/declared" "{\"by\":\"$WAITER\",\"on\":\"agent\",\"target\":\"haiku-exp\"}")
W2=$(printf "%s" "$R" | jget "d['id']") || fail "the waiter couldn't wait for haiku-exp while main was down (got: $R)"
daemon_up main
api main POST /api/mail "{\"from\":\"$TARGET\",\"to\":[\"$WAITER\"],\"subject\":\"back\",\"body\":\"here\"}" >/dev/null
waiter_clear2() { [ "$(api twin GET "/api/agents/$WAITER/waits" | jget "len([w for w in d if w['id']=='$W2'])")" = 0 ]; }
wait_until waiter_clear2

echo "-- an archived target is refused, on main and on twin itself"
ARCH=$(api main POST /api/register '{"name":"old-exp","role":"test","harness":"claude"}' x | jget "d['id']")
LOCAL=$(api twin POST /api/register '{"name":"old-local","role":"test","harness":"claude"}' x | jget "d['id']")
for pair in "main $ARCH" "twin $LOCAL"; do
  set -- $pair
  # An archive asks for the final round (S-1043): file it, so the turn end below archives at once.
  api "$1" POST "/api/agents/$2/retro-final" "{\"by\":\"$2\",\"effort\":{\"testing\":100}}" >/dev/null
  api "$1" POST "/api/agents/$2/archive" "{\"by\":\"$2\",\"force\":true}" >/dev/null
  hook "$1" "$2" '{"hook_event_name":"Stop","last_assistant_message":"done"}' >/dev/null
  archived() { [ "$(api "$1" GET "/api/agents/$2" | jget "d['lifecycle']")" = archived ]; }
  wait_until archived "$1" "$2"
done
R=$(api twin POST "/api/agents/$WAITER/waits/declared" "{\"by\":\"$WAITER\",\"on\":\"agent\",\"target\":\"old-exp\"}")
printf "%s" "$R" | grep -q "no agent old-exp (archived)" || fail "a wait on an archived peer agent wasn't refused (got: $R)"
R=$(api twin POST "/api/agents/$WAITER/waits/declared" "{\"by\":\"$WAITER\",\"on\":\"agent\",\"target\":\"old-local\"}")
printf "%s" "$R" | grep -q "no agent old-local (archived)" || fail "a wait on an archived local agent wasn't refused (got: $R)"

echo "-- a wait on an agent nobody has still fails"
R=$(api twin POST "/api/agents/$WAITER/waits/declared" "{\"by\":\"$WAITER\",\"on\":\"agent\",\"target\":\"nobody\"}")
printf "%s" "$R" | grep -q "no agent nobody" || fail "a wait on an unknown agent didn't say no agent (got: $R)"
echo "PASS e2e-peer-wait"
