#!/bin/sh
# A parent on another machine, free (no models). Two isolated daemons: "main" holds the
# parent (a registered agent, hooks read by hand), "twin" the child it spawns there.
# Checks (S-207):
#   - a spawn on twin naming a parent nobody has fails before any worktree or branch exists
#   - a spawn on twin with its parent on main stores the parent's id and names it in the brief
#   - the child's finished turn reaches the parent on main in "turn" mode, not in "none";
#     its blocked notice always does
#   - wait_for across machines, both ways, and the reply mail clears it
#   - with main down, the child's blocked and tree-idle notices wait for it and arrive once it
#     is back, and twin never falls back to the human as if the child had no parent; its
#     second parent, local on twin, hears the turn once, though a grandchild's turn on twin
#     announces it again while the remote delivery still waits
#   - the parent archives the child on twin through main
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
  [ -n "$AGENT_TOK" ] && _tok=$AGENT_TOK
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${5:+-H 'x-stam-human: 1'} ${4:+-d "$4"} "$_url$3"
}
hook() { api "$1" POST "/api/hook/claude/$2" "$3" | jget "d.get('stdout','')"; }
# kid_api ...: api as kid, with its own token (the shared token can't name an agent that has one, S-545).
kid_api() ( AGENT_TOK=$(on twin sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN | cut -d= -f2-' _ "$KID"); api "$@" )
notice() { hook "$1" "$2" '{"hook_event_name":"PostToolUse"}'; }

BOSS=$(api main POST /api/register '{"name":"boss","role":"test","harness":"claude"}' x | jget "d['id']")
notice main "$BOSS" >/dev/null
REPO="$TEST_TMP/repo"; git init -q "$REPO" && git -C "$REPO" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

echo "-- a parent nobody has fails the spawn before the workspace"
R=$(api main POST /api/agents "{\"name\":\"orphan\",\"machine\":\"twin\",\"parent\":\"nobody\",\"cwd\":\"$REPO\",\"worktree\":true,\"branch\":\"stam/orphan\",\"type\":\"developer\"}" x)
printf "%s" "$R" | grep -q "no agent nobody" || fail "the spawn didn't refuse the unknown parent (got: $R)"
[ -z "$(git -C "$REPO" branch --list stam/orphan)" ] || fail "the refused spawn left the branch stam/orphan"

echo "-- a spawn on twin with its parent on main"
R=$(api main POST /api/agents "{\"name\":\"kid\",\"machine\":\"twin\",\"parent\":\"boss\",\"cwd\":\"$REPO\",\"type\":\"developer\",\"prompt\":\"Do the thing.\"}" x)
KID=$(printf "%s" "$R" | jget "d['id']") || fail "the spawn on twin failed (got: $R)"
[ "$(printf "%s" "$R" | jget "d['parent_id']")" = "$BOSS" ] || fail "kid's parent isn't boss's id (got: $R)"
printf "%s" "$R" | jget "d['first_prompt']" | grep -q "boss" || fail "kid's brief doesn't name boss"
api main GET '/api/agents' | jget "[a['machine'] for a in d if a['id']=='$KID'][0]" | grep -qx twin || fail "main's list doesn't show kid on twin"
notice twin "$KID" >/dev/null
notice main "$BOSS" >/dev/null

echo "-- child notices reach the parent on main"
api main POST "/api/agents/$BOSS/set-child-notices" "{\"by\":\"$BOSS\",\"child_notices\":\"none\"}" >/dev/null
hook twin "$KID" '{"hook_event_name":"UserPromptSubmit","prompt":"go"}' >/dev/null
hook twin "$KID" '{"hook_event_name":"Stop","last_assistant_message":"FIRST-TURN"}' >/dev/null
api main POST "/api/agents/$BOSS/set-child-notices" "{\"by\":\"$BOSS\",\"child_notices\":\"turn\"}" >/dev/null
hook twin "$KID" '{"hook_event_name":"UserPromptSubmit","prompt":"go"}' >/dev/null
hook twin "$KID" '{"hook_event_name":"Stop","last_assistant_message":"SECOND-TURN"}' >/dev/null
turn_told() { N=$(notice main "$BOSS"); printf "%s" "$N" | grep -q "SECOND-TURN"; }
wait_until turn_told
printf "%s" "$N" | grep -q "FIRST-TURN" && fail "boss heard a turn while its child notices were none"
hook twin "$KID" '{"hook_event_name":"Notification","notification_type":"permission_prompt"}' >/dev/null
blocked_told() { notice main "$BOSS" | grep -q "kid, your child, is blocked"; }
wait_until blocked_told
hook twin "$KID" '{"hook_event_name":"Stop","last_assistant_message":"done"}' >/dev/null
notice main "$BOSS" >/dev/null

echo "-- wait_for across machines, both ways"
R=$(kid_api twin POST "/api/agents/$KID/waits/declared" "{\"by\":\"$KID\",\"on\":\"agent\",\"target\":\"boss\"}")
W=$(printf "%s" "$R" | jget "d['id']") || fail "kid couldn't wait for boss (got: $R)"
boss_asked() { notice main "$BOSS" | grep -q "kid is waiting for your reply"; }
wait_until boss_asked
api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"$KID\"],\"subject\":\"reply\",\"body\":\"here\"}" >/dev/null
kid_waits_clear() { [ "$(api twin GET "/api/agents/$KID/waits" | jget "len([w for w in d if w['id']=='$W'])")" = 0 ]; }
wait_until kid_waits_clear
R=$(api main POST "/api/agents/$BOSS/waits/declared" "{\"by\":\"$BOSS\",\"on\":\"agent\",\"target\":\"kid\"}")
W=$(printf "%s" "$R" | jget "d['id']") || fail "boss couldn't wait for kid (got: $R)"
kid_api twin POST /api/mail "{\"from\":\"$KID\",\"to\":[\"$BOSS\"],\"subject\":\"reply\",\"body\":\"here\"}" >/dev/null
boss_waits_clear() { [ "$(api main GET "/api/agents/$BOSS/waits" | jget "len([w for w in d if w['id']=='$W'])")" = 0 ]; }
wait_until boss_waits_clear

echo "-- with main down, the notices wait for it"
api main POST "/api/agents/$BOSS/set-child-notices" "{\"by\":\"$BOSS\",\"child_notices\":\"tree-idle\"}" >/dev/null
LP=$(api twin POST /api/register '{"name":"lp","role":"test","harness":"claude"}' x | jget "d['id']")
api twin POST "/api/agents/$KID/adopt" "{\"parent\":\"$LP\"}" x | grep -q "lp is now a parent" || fail "lp couldn't adopt kid"
DEE=$(api twin POST /api/register '{"name":"dee","role":"test","harness":"claude"}' x | jget "d['id']")
api twin POST "/api/agents/$DEE/set-parent" "{\"parent\":\"$KID\"}" x >/dev/null
hook twin "$DEE" '{"hook_event_name":"UserPromptSubmit","prompt":"go"}' >/dev/null
hook twin "$DEE" '{"hook_event_name":"Stop","last_assistant_message":"dee done"}' >/dev/null
notice main "$BOSS" >/dev/null
daemon_stop main
: >"$TEST_TMP/lp-notices"
hook twin "$KID" '{"hook_event_name":"UserPromptSubmit","prompt":"go"}' >/dev/null
hook twin "$KID" '{"hook_event_name":"Notification","notification_type":"permission_prompt"}' >/dev/null
hook twin "$KID" '{"hook_event_name":"Stop","last_assistant_message":"OUTAGE-TURN"}' >/dev/null
lp_told() { notice twin "$LP" >>"$TEST_TMP/lp-notices"; grep -q "OUTAGE-TURN" "$TEST_TMP/lp-notices"; }
wait_until lp_told
# dee's turn on twin announces kid again (its ancestor) while boss's delivery still waits.
hook twin "$DEE" '{"hook_event_name":"UserPromptSubmit","prompt":"go"}' >/dev/null
hook twin "$DEE" '{"hook_event_name":"Stop","last_assistant_message":"dee again"}' >/dev/null
daemon_up main
# A peer that failed is probed every STAM_PEER_PROBE_MS (500 ms here, src/peers.ts), so this waits for main to come back.
: >"$TEST_TMP/boss-notices"
both_told() { notice main "$BOSS" >>"$TEST_TMP/boss-notices"; grep -q "kid, your child, is blocked" "$TEST_TMP/boss-notices" && grep -q "OUTAGE-TURN" "$TEST_TMP/boss-notices"; }
wait_until both_told || fail "the notices held during main's outage never arrived (got: $(cat "$TEST_TMP/boss-notices"))"
on twin "$STAM" mail inbox human | grep -q "kid" && fail "twin mailed the human about kid as if it had no parent"
[ "$(grep -o "OUTAGE-TURN" "$TEST_TMP/boss-notices" | wc -l)" = 1 ] || fail "the tree-idle notice arrived more than once"
notice twin "$LP" >>"$TEST_TMP/lp-notices"
[ "$(grep -o "OUTAGE-TURN" "$TEST_TMP/lp-notices" | wc -l)" = 1 ] || fail "lp, kid's local parent, heard kid's turn more than once (got: $(cat "$TEST_TMP/lp-notices"))"

echo "-- the parent archives its child through main"
R=$(api main POST "/api/agents/$KID/archive" "{\"by\":\"$BOSS\"}")
# An archive waits for the kid's final round and runs at its next turn end (S-1043): this Stop ends it.
hook twin "$KID" '{"hook_event_name":"Stop","last_assistant_message":"wrapped up"}' >/dev/null
kid_archived() { [ "$(api main GET "/api/agents/$KID" | jget "d['lifecycle']")" = archived ]; }
wait_until kid_archived || fail "boss couldn't archive kid (got: $(api main GET "/api/agents/$KID" | jget "d['lifecycle']"); archive said: $R)"
echo "PASS e2e-peer-parent"
