#!/bin/sh
# cost_switch on an agent of another machine, free (no models), S-923: two isolated daemons,
# "main" holds the chief of staff cos, "twin" holds kid (parent cos). Checks:
#   - cos on main switches kid on twin: the successor kid-t2 runs on twin, kid is held as taken over
#   - the refusals read the same as for a local agent (an unrelated agent), with no token or URL in them
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/idle.json" <<'EOF2'
{ "turns": [ { "match": "", "steps": [ { "reply": "OK" } ] } ] }
EOF2
fake_claude "$TEST_TMP/idle.json"
daemon_home main
daemon_home twin
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    # The peer token is made ahead of the daemon, which keeps an existing file.
    open(f"{tmp}/{name}/peer-token", "w").write(f"peer-token-{name}")
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip(), "peerToken": f"peer-token-{name}"}
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer(other)]
    s["chiefOfStaff"] = "cos"
    # main is the ITSA home: the ITSAs a switch on twin hands over live there (S-3636)
    s.setdefault("itsa", {})["home"] = "main"
    json.dump(s, open(path, "w"), indent=2)
    json.dump({"presets": {"alt": {"harness": "claude", "model": "alt-model", "effort": "low"}}}, open(f"{tmp}/{me}/registry.json", "w"))
PY
# The OpenCode server's token is a sha256 in STAM_HOME/opencode-token; a known one lets the test act as it.
OC=oc-token-$$
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500 STAM_ITSA_RETRY_MS=1000
daemon_up main
daemon_up twin
# The daemon mints the token when it starts; the test replaces its hash with a known one.
printf '%s' "$(printf '%s' "$OC" | sha256sum | cut -d' ' -f1)" >"$TEST_TMP/main/opencode-token"
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
WORK="$TEST_TMP/work"; mkdir -p "$WORK"
spawn() { api main POST /api/agents "$1" x | jget "d['id']"; }
COS=$(spawn "{\"name\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "cos didn't spawn"
KID=$(spawn "{\"name\":\"kid\",\"machine\":\"twin\",\"parent\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid didn't spawn"
GP=$(spawn "{\"name\":\"gp\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "gp didn't spawn"
MID=$(spawn "{\"name\":\"mid\",\"parent\":\"gp\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "mid didn't spawn"
KID2=$(spawn "{\"name\":\"kid2\",\"machine\":\"twin\",\"parent\":\"gp\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid2 didn't spawn"
OCM=$(api main POST /api/register '{"name":"ocmgr","role":"manager","harness":"opencode"}' | jget "d['id']") || fail "ocmgr didn't register"
KID4=$(spawn "{\"name\":\"kid4\",\"machine\":\"twin\",\"parent\":\"ocmgr\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid4 didn't spawn"
KID3=$(spawn "{\"name\":\"kid3\",\"machine\":\"twin\",\"parent\":\"mid\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid3 didn't spawn"
OTHER=$(spawn "{\"name\":\"other\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "other didn't spawn"
for id in "$COS" "$OTHER" "$GP"; do wait_until has_token main "$id"; done
COS_TOKEN=$(token_of main "$COS"); OTHER_TOKEN=$(token_of main "$OTHER"); GP_TOKEN=$(token_of main "$GP")
# sw TOKEN BY AGENT: a cost_switch call on main; the code is in $CODE, the body in $TEST_TMP/body.
sw() { CODE=$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"by\":\"$2\",\"agent\":\"$3\",\"preset\":\"alt\",\"soft_stop_minutes\":0}" "$MAIN_URL/api/cost/switch"); }
# swuntil TOKEN BY AGENT: repeats until the twin knows the manager's chain and the call is not refused for it.
swok() { sw "$1" "$2" "$3"; [ "$CODE" = 200 ]; }
has_t2() { [ "$(api twin GET /api/agents | jget "next((a['machine'] for a in d if a['name']=='$1-t2'), '')")" = twin ]; }
switch() { curl -s -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"by\":\"$2\",\"agent\":\"kid\",\"preset\":\"alt\",\"soft_stop_minutes\":0}" "$MAIN_URL/api/cost/switch"; }

echo "-- an unrelated agent on main can't switch kid on twin"
R=$(switch "$OTHER_TOKEN" "$OTHER")
echo "$R"
printf "%s" "$R" | grep -q "$TWIN_TOKEN" && fail "a peer token is in the refusal"
printf "%s" "$R" | grep -q "$TWIN_URL" && fail "a peer URL is in the refusal"

# The twin knows main's agents from its peer list; a manager it does not know is refused.
PEER_TWIN=$(cat "$TEST_TMP/twin/peer-token")
forward() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -H 'x-stam-local: 1' -H "x-stam-agent: $2" ${3:+-H 'x-stam-agent-assistant: 1'} -d "{\"by\":\"$2\",\"agent\":\"kid\",\"preset\":\"alt\",\"soft_stop_minutes\":0}" "$TWIN_URL/api/cost/switch"; }
echo "-- a forward naming a manager the twin doesn't know, or the shared token forging one, is refused"
[ "$(forward "$PEER_TWIN" ghost-agent)" = 404 ] || fail "twin took an unknown forwarded manager: $(cat "$TEST_TMP/body")"
[ "$(forward "$TWIN_TOKEN" "$COS")" = 403 ] || fail "twin took the shared token's forged manager: $(cat "$TEST_TMP/body")"
is403() { [ "$(forward "$PEER_TWIN" "$OTHER")" = 403 ]; }
wait_until is403
[ "$(forward "$PEER_TWIN" "$OTHER")" = 403 ] || fail "twin let a known unrelated manager switch kid: $(cat "$TEST_TMP/body")"
[ "$(api twin GET /api/agents | jget "next(a['forwarded_to'] is None for a in d if a['name']=='kid')")" = True ] || fail "kid was switched by a refused call"

echo "-- a forged move of kid's ITSAs is refused: only a real switch (forwarded_to) moves them (S-3636)"
IT_OPEN=$(api main POST /api/itsas "{\"title\":\"Kid open\",\"owner\":\"$KID\",\"status\":\"in_progress\"}" x | jget "d['key']") || fail "no open ITSA"
IT_DONE=$(api main POST /api/itsas "{\"title\":\"Kid done\",\"owner\":\"$KID\",\"status\":\"in_progress\"}" x | jget "d['key']") || fail "no ITSA to close"
api main PATCH "/api/itsas/$IT_DONE" '{"status":"done"}' x >/dev/null || fail "couldn't close $IT_DONE"
owner_of() { api main GET "/api/itsas/$1" "" x | jget "d.get('owner')"; }
move() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' ${2:+-H 'x-stam-local: 1'} -d "{\"from\":\"$KID\",\"to\":\"$3\"}" "$MAIN_URL/api/itsas/switch-owner"; }
[ "$(move "$(cat "$TEST_TMP/main/peer-token")" 1 "$KID2")" = 403 ] || fail "main took a forged move kid -> kid2 (kid wasn't switched): $(cat "$TEST_TMP/body")"
[ "$(move "$MAIN_TOKEN" "" "$KID2")" = 403 ] || fail "main took the shared token's move: $(cat "$TEST_TMP/body")"
[ "$(move "$(cat "$TEST_TMP/main/peer-token")" 1 "$OTHER")" = 403 ] || fail "main took a move to an agent no peer holds with kid: $(cat "$TEST_TMP/body")"
IT_PART=$(api main POST /api/itsas "{\"title\":\"Kid joined\",\"owner\":\"$OTHER\",\"status\":\"in_progress\",\"participants\":[\"$KID\"]}" x | jget "d['key']") || fail "no ITSA kid only takes part in"
KID_OWNER=$(owner_of "$IT_OPEN")
[ "$KID_OWNER" = "$KID" ] || fail "a forged move changed the owner of $IT_OPEN to $KID_OWNER"

echo "-- cos on main switches kid on twin"
R=$(switch "$COS_TOKEN" "$COS")
echo "$R"
printf "%s" "$R" | grep -q '"to":"kid-t2"' || fail "cos couldn't switch kid: $R"
# A working agent switches in the background.
on_twin() { [ "$(api twin GET /api/agents | jget "next((a['machine'] for a in d if a['name']=='kid-t2'), '')")" = twin ]; }
wait_until on_twin
[ "$(api twin GET "/api/agents?state=all" | jget "next(a['forwarded_to'] is not None for a in d if a['name']=='kid')")" = True ] || fail "kid isn't held as taken over"

echo "-- the open ITSA follows kid to kid-t2 on the ITSA home; the closed one keeps its owner"
KID_T2=$(api twin GET /api/agents | jget "next(a['id'] for a in d if a['name']=='kid-t2')")
moved() { [ "$(owner_of "$IT_OPEN")" = "$KID_T2" ]; }
wait_until moved || fail "$IT_OPEN is owned by $(owner_of "$IT_OPEN"), not kid-t2"
[ "$(owner_of "$IT_DONE")" = "$KID" ] || fail "the closed $IT_DONE moved to $(owner_of "$IT_DONE")"
echo "-- the successor joins the open ITSA kid only took part in; its owner stays"
joined() { api main GET "/api/itsas/$IT_PART" "" x | jget "'$KID_T2' in d.get('participants', [])"; }
[ "$(joined)" = True ] || fail "kid-t2 didn't join $IT_PART"
[ "$(owner_of "$IT_PART")" = "$OTHER" ] || fail "the owner of $IT_PART changed to $(owner_of "$IT_PART")"
echo "-- a repeated move changes nothing (idempotent)"
[ "$(move "$(cat "$TEST_TMP/main/peer-token")" 1 "$KID_T2")" = 200 ] || fail "the repeat was refused: $(cat "$TEST_TMP/body")"
grep -q '"moved":\[\]' "$TEST_TMP/body" || fail "the repeat moved something: $(cat "$TEST_TMP/body")"
for leak in "$TWIN_TOKEN" "$TWIN_URL" "$MAIN_TOKEN"; do grep -q "$leak" "$TEST_TMP/body" && fail "a token or URL is in the repeat's answer"; done

echo "-- the chief of staff switches kid2, whose parent is not cos"
wait_until swok "$COS_TOKEN" "$COS" kid2
wait_until has_t2 kid2

echo "-- a grandparent on main switches kid3 (twin knows mid's parents)"
wait_until swok "$GP_TOKEN" "$GP" kid3
wait_until has_t2 kid3

echo "-- an OpenCode manager switches a peer's agent (kid4), naming itself, its parent"
OCT=$OC
sw "$OCT" "$OCM" kid4
[ "$CODE" = 200 ] || fail "the OpenCode server couldn't switch kid4 for ocmgr ($CODE): $(cat "$TEST_TMP/body")"

echo "-- the home is down during a switch: the ITSA stays, and a restart of the switching daemon moves it (S-3636)"
KID5=$(spawn "{\"name\":\"kid5\",\"machine\":\"twin\",\"parent\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid5 didn't spawn"
IT5=$(api main POST /api/itsas "{\"title\":\"Kid5 open\",\"owner\":\"$KID5\",\"status\":\"in_progress\"}" x | jget "d['key']") || fail "no ITSA for kid5"
daemon_stop main
CODE=$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $TWIN_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "{\"agent\":\"kid5\",\"preset\":\"alt\",\"soft_stop_minutes\":0}" "$TWIN_URL/api/cost/switch")
[ "$CODE" = 200 ] || fail "the switch of kid5 with the home down answered $CODE: $(cat "$TEST_TMP/body")"
grep -q "$MAIN_TOKEN" "$TEST_TMP/body" && fail "a token is in the switch's answer"
# The switch of a working agent goes on in the background: wait until it finished and the hand-off to the down home failed.
handoff_failed() { [ "$(api twin GET '/api/test/events?type=cost:switch' | jget "sum(1 for e in d if 'itsa-owner-failed' in e['data'])")" -ge 1 ]; }
wait_until handoff_failed || fail "no failed hand-off to the down home was recorded"
# twin goes down before the home is back, so only the restart's own retry can move the ITSA.
daemon_stop twin
daemon_up main
daemon_up twin
kid5_t2() { KID5_T2=$(api twin GET /api/agents | jget "next(a['id'] for a in d if a['name']=='kid5-t2')" 2>/dev/null) && [ -n "$KID5_T2" ]; }
wait_until kid5_t2 || fail "kid5-t2 isn't on twin after the restart: $(api twin GET /api/agents | jget "[a['name'] for a in d]")"
moved5() { [ "$(owner_of "$IT5")" = "$KID5_T2" ]; }
wait_until moved5 || fail "$IT5 is owned by $(owner_of "$IT5") after twin restarted, not kid5-t2"

echo "-- a home that refuses (the successor is archived) is asked once, then dropped, and not seeded again after a restart"
KID6=$(spawn "{\"name\":\"kid6\",\"machine\":\"twin\",\"parent\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid6 didn't spawn"
IT6=$(api main POST /api/itsas "{\"title\":\"Kid6 open\",\"owner\":\"$KID6\",\"status\":\"in_progress\"}" x | jget "d['key']") || fail "no ITSA for kid6"
daemon_stop main
CODE=$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $TWIN_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "{\"agent\":\"kid6\",\"preset\":\"alt\",\"soft_stop_minutes\":0}" "$TWIN_URL/api/cost/switch")
[ "$CODE" = 200 ] || fail "the switch of kid6 answered $CODE: $(cat "$TEST_TMP/body")"
steps6() { api twin GET "/api/test/events?agent=$KID6&type=cost:switch" | jget "sum(1 for e in d if '$1' in e['data'])"; }
failed6() { [ "$(steps6 itsa-owner-failed)" = 1 ]; }
wait_until failed6 || fail "no failed hand-off of kid6 was recorded"
has_kid6_t2() { KID6_T2=$(api twin GET /api/agents | jget "next(a['id'] for a in d if a['name']=='kid6-t2')" 2>/dev/null) && [ -n "$KID6_T2" ]; }
wait_until has_kid6_t2 || fail "kid6-t2 isn't on twin"
api twin POST /api/test/agent "{\"agent\":\"$KID6_T2\",\"lifecycle\":\"archived\"}" x >/dev/null || fail "couldn't archive kid6-t2"
daemon_up main
refused6() { [ "$(steps6 itsa-owner-refused)" = 1 ]; }
wait_until refused6 || fail "the home's refusal for kid6 wasn't recorded"
# A shut-down successor can be resumed, so it still gets the ITSAs. kid7 is switched while the home is down and stays
# pending across twin's restart: its move is the positive sign that the restart's first retry pass ran, and that pass
# would have asked about kid6 first (it is older) had the restart seeded the refused one.
KID7=$(spawn "{\"name\":\"kid7\",\"machine\":\"twin\",\"parent\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid7 didn't spawn"
IT7=$(api main POST /api/itsas "{\"title\":\"Kid7 open\",\"owner\":\"$KID7\",\"status\":\"in_progress\"}" x | jget "d['key']") || fail "no ITSA for kid7"
daemon_stop main
CODE=$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $TWIN_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "{\"agent\":\"kid7\",\"preset\":\"alt\",\"soft_stop_minutes\":0}" "$TWIN_URL/api/cost/switch")
[ "$CODE" = 200 ] || fail "the switch of kid7 answered $CODE: $(cat "$TEST_TMP/body")"
steps7() { api twin GET "/api/test/events?agent=$KID7&type=cost:switch" | jget "sum(1 for e in d if '$1' in e['data'])"; }
failed7() { [ "$(steps7 itsa-owner-failed)" = 1 ]; }
wait_until failed7 || fail "no failed hand-off of kid7 was recorded"
has_kid7_t2() { KID7_T2=$(api twin GET /api/agents | jget "next(a['id'] for a in d if a['name']=='kid7-t2')" 2>/dev/null) && [ -n "$KID7_T2" ]; }
wait_until has_kid7_t2 || fail "kid7-t2 isn't on twin"
api twin POST /api/test/agent "{\"agent\":\"$KID7_T2\",\"lifecycle\":\"shut_down\"}" x >/dev/null || fail "couldn't shut down kid7-t2"
daemon_stop twin
daemon_up main
daemon_up twin
moved7() { [ "$(owner_of "$IT7")" = "$KID7_T2" ]; }
wait_until moved7 || fail "$IT7 is owned by $(owner_of "$IT7"), not its shut-down successor kid7-t2"
# Positive sign that the retry went on past kid7's move: a few more passes finished (each asks every pending one that is due).
PASSES=$(api twin GET /api/test/switch-retries | jget "d['passes']")
passed() { [ "$(api twin GET /api/test/switch-retries | jget "d['passes'] >= $PASSES + 4")" = True ]; }
wait_until passed || fail "the retry passes stopped after the restart"
[ "$(steps6 itsa-owner-refused)" = 1 ] || fail "kid6 was asked again after the restart"
[ "$(owner_of "$IT6")" = "$KID6" ] || fail "$IT6 moved to an archived successor: $(owner_of "$IT6")"

echo "-- with twin down, the answer names it"
daemon_stop twin
sw "$COS_TOKEN" "$COS" kid3
[ "$CODE" = 503 ] || fail "a down peer answered $CODE: $(cat "$TEST_TMP/body")"
grep -q twin "$TEST_TMP/body" || fail "the down peer isn't named: $(cat "$TEST_TMP/body")"
grep -q "no agent" "$TEST_TMP/body" && fail "a down peer read as no agent"
echo "PASS e2e-cost-switch-peer"
