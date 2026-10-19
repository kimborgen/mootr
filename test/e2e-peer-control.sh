#!/bin/sh
# agent_control on an agent of another machine, free (no models), S-410: two isolated daemons,
# "main" holds the chief of staff cos, the assistant ea, and an unrelated stranger; twin holds kid.
# Checks:
#   - the stranger on main can neither shut down nor adopt kid on twin
#   - cos on main adopts kid on twin but can't shut it down
#   - ea on main shuts kid down on twin
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
# control TOKEN BY ID ACTION: an agent on main controls an agent, as agent_control does.
control() {
  curl -s -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"by\":\"$2\"}" "$MAIN_URL/api/agents/$3/$4"
}
WORK="$TEST_TMP/work"; mkdir -p "$WORK"
spawn() { api main POST /api/agents "$1" x | jget "d['id']"; }
COS=$(spawn "{\"name\":\"cos\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "cos didn't spawn"
EA=$(spawn "{\"name\":\"ea\",\"kind\":\"assistant\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "ea didn't spawn"
STRANGER=$(spawn "{\"name\":\"stranger\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "stranger didn't spawn"
KID=$(spawn "{\"name\":\"kid\",\"machine\":\"twin\",\"parent\":\"stranger\",\"cwd\":\"$WORK\",\"prompt\":\"Hi\"}") || fail "kid didn't spawn"
for id in "$COS" "$EA" "$STRANGER"; do wait_until has_token main "$id"; done
COS_TOKEN=$(token_of main "$COS"); EA_TOKEN=$(token_of main "$EA"); STRANGER_TOKEN=$(token_of main "$STRANGER")
parents() { api twin GET /api/agents | jget "' '.join(next(a['parents'] for a in d if a['id']=='$KID'))"; }

echo "-- an unrelated agent on main can neither shut down nor adopt kid"
S=$(spawn "{\"name\":\"other\",\"cwd\":\"$WORK\",\"prompt\":\"Lead\"}") || fail "other didn't spawn"
wait_until has_token main "$S"
OTHER_TOKEN=$(token_of main "$S")
control "$OTHER_TOKEN" "$S" "$KID" shutdown | grep -q 'may control only itself' || fail "an unrelated agent shut kid down"
control "$OTHER_TOKEN" "$S" "$KID" adopt | grep -q 'may control only itself' || fail "an unrelated agent adopted kid"

echo "-- cos adopts kid on twin but can't shut it down"
control "$COS_TOKEN" "$COS" "$KID" shutdown | grep -q 'may control only itself' || fail "cos shut kid down"
R=$(control "$COS_TOKEN" "$COS" "$KID" adopt)
printf "%s" "$R" | grep -q "is now a parent of kid" || fail "cos couldn't adopt kid: $R"
parents | grep -q "$COS" || fail "kid's parents on twin don't include cos: $(parents)"

echo "-- ea shuts kid down on twin"
R=$(control "$EA_TOKEN" "$EA" "$KID" shutdown)
printf "%s" "$R" | grep -q '"error"' && fail "ea couldn't shut kid down: $R"
echo "PASS e2e-peer-control"
