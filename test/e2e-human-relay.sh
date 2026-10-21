#!/bin/sh
# No human over peer relays (S-544, C3a of S-426): two daemons, main and twin, peered; twin is main's
# ITSA home. With auth.humanStrict on at main, a human write for another machine's permission, ITSA,
# or agent is answered 409 naming the machine and its origin, and a human read or a call naming an
# agent (`by`) still relays. With it off, the human write relays as before and main logs a line.
# Free: registered agents, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
conf() { python3 - "$TEST_TMP" "$1" <<'PY'
import json, re, sys
tmp, strict = sys.argv[1], sys.argv[2] == 'true'
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    try: s = json.load(open(path))
    except Exception: s = {}
    s["peers"] = [peer(other)]
    if me == "main":
        s["itsa"] = {**s.get("itsa", {}), "home": "twin"}
        s["auth"] = {**s.get("auth", {}), "humanStrict": strict}
    json.dump(s, open(path, "w"), indent=2)
PY
}
conf true
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
J='content-type: application/json'
KEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
BOB=$(curl -s -X POST -H "authorization: Bearer $TWIN_TOKEN" -H "$J" -H 'x-stam-human: 1' -d '{"name":"bob","role":"test","harness":"claude"}' "$TWIN_URL/api/register" | jget "d['id']")
[ -n "$BOB" ] || fail "bob didn't register on twin"
M="authorization: Bearer $MAIN_TOKEN"
body_has() { grep -q "$1" "$TEST_TMP/body" || fail "$2: $(cat "$TEST_TMP/body")"; }

echo "-- strict on: a human write for another machine is a 409 naming it"
[ "$(code -X POST -H "$M" -H "$KEY" -H "$J" -d '{"approve":true,"machine":"twin","direct":"TypeError: Failed to fetch (origin https://twin.example)"}' "$MAIN_URL/api/permissions/p000000/answer")" = 409 ] || fail "a relayed permission answer wasn't 409: $(cat "$TEST_TMP/body")"
body_has '"machine":"twin"' "the permission 409 doesn't name twin"
[ "$(code -X POST -H "$M" -H "$KEY" -H "$J" -d '{"action":"done"}' "$MAIN_URL/api/itsas/S-1/act")" = 409 ] || fail "a relayed ITSA human act wasn't 409: $(cat "$TEST_TMP/body")"
body_has '"machine":"twin"' "the ITSA 409 doesn't name twin"
body_has '"origin"' "the ITSA 409 has no origin"
[ "$(code -X POST -H "$M" -H "$KEY" -H "$J" -d '{}' "$MAIN_URL/api/agents/$BOB/pause")" = 409 ] || fail "a relayed agent write wasn't 409: $(cat "$TEST_TMP/body")"
body_has '"machine":"twin"' "the agent 409 doesn't name twin"

[ "$(code -X POST -H "$M" -H "$KEY" -H "$J" -d '{"machine":"twin"}' "$MAIN_URL/api/shells")" = 409 ] || fail "a relayed terminal start wasn't 409: $(cat "$TEST_TMP/body")"
body_has '"machine":"twin"' "the terminal 409 doesn't name twin"

echo "-- strict on: non-human relays keep working"
[ "$(code -H "$M" -H "$KEY" "$MAIN_URL/api/agents/$BOB")" = 200 ] || fail "a relayed agent read failed: $(cat "$TEST_TMP/body")"
[ "$(code -H "$M" -H "$KEY" "$MAIN_URL/api/itsas")" = 200 ] || fail "a relayed ITSA read failed: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$M" -H "$J" -d "{\"title\":\"by bob\",\"by\":\"$BOB\"}" "$MAIN_URL/api/itsas")" != 409 ] || fail "a relay naming an agent was a 409"

echo "-- strict off: the human write relays as before, and main logs it"
on main "$STAM" daemon stop >/dev/null 2>&1 || true
conf false
daemon_up main
[ "$(code -X POST -H "$M" -H "$KEY" -H "$J" -H 'x-stam-human: 1' -d '{"title":"relayed"}' "$MAIN_URL/api/itsas")" = 200 ] || fail "a relayed human ITSA create failed with strict off: $(cat "$TEST_TMP/body")"
grep -qF 'off (this was allowed; turning it on would refuse it): relaying' "$TEST_TMP/main/daemon.log" || fail "no relay would-refuse line in main's log"
grep -q 'permission answer relayed after the direct attempt failed: TypeError: Failed to fetch (origin https://twin.example)' "$TEST_TMP/main/daemon.log" || fail "no direct-failure line in main's log"
echo PASS
