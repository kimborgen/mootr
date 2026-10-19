#!/bin/sh
# Auto-archive across peers (S-637), free (no models). Two isolated daemons, "main" (the ITSA home)
# and "twin", peered. A thread about a closed ITSA, read by the human, is archived by main's pass on
# main and, through the peer route, on twin, whose archive state is its own. A thread the human
# took back (unarchived) on twin stays there when main's pass archives it.
set -e
export STAM_AUTO_ARCHIVE_QUIET_MS=0
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
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up twin
trap stam_test_cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }
# NAME METHOD PATH [BODY]: a request to that daemon, as the human.
h() { (use "$1" && curl -s -X "$2" -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$3" ${4:+-d "$4"}); }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
archived() { h "$1" GET '/api/agents/human/threads?limit=100&archived=1' | grep -q "\"thread_id\":\"$2\""; }

A=$(h main POST /api/register '{"name":"alice","role":"alice","harness":"claude"}' | field '["id"]')
KEY=$(on main "$STAM" itsa new "Peers e2e" --owner alice --status in_progress | awk '{print $1}')
T=$(h main POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Done\",\"body\":\"Shipped.\",\"itsa\":\"$KEY\",\"new_thread\":true}" | field '["id"]')
h main POST /api/agents/human/read "{\"ids\":[\"$T\"]}" >/dev/null
h main PATCH "/api/itsas/$KEY" "{\"status\":\"done\",\"by\":\"$A\"}" >/dev/null

echo "-- main's pass archives the thread on main and on twin"
h main POST /api/mail/resolved '{"dry":false}' | grep -q "\"$T\"" || fail "main's pass didn't archive $T"
archived main "$T" || fail "not archived on main"
archived twin "$T" || fail "not archived on twin"

echo "-- a thread the human took back on twin stays there when main's pass archives it"
K2=$(on main "$STAM" itsa new "Peers e2e 2" --owner alice --status in_progress | awk '{print $1}')
T2=$(h main POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Done 2\",\"body\":\"Shipped.\",\"itsa\":\"$K2\",\"new_thread\":true}" | field '["id"]')
h main POST /api/agents/human/read "{\"ids\":[\"$T2\"]}" >/dev/null
h main PATCH "/api/itsas/$K2" "{\"status\":\"done\",\"by\":\"$A\"}" >/dev/null
# Archived and taken back on twin by the human, before main's pass sees it.
h twin POST "/api/agents/human/threads/$T2/archive" '{}' >/dev/null
h twin POST "/api/agents/human/threads/$T2/unarchive" '{}' >/dev/null
h main POST /api/mail/resolved '{"dry":false}' | grep -q "\"$T2\"" || fail "main's pass didn't archive $T2"
archived main "$T2" || fail "$T2 not archived on main"
archived twin "$T2" && fail "main's pass archived $T2 on twin after the human took it back there"

echo "ok: auto-archive-peers"
