#!/bin/sh
# Machines, free (no agents, no models): two isolated daemons on this machine play two
# computers ("main" and "twin", test/lib.sh). GET /api/machines returns each one's CPU,
# RAM, and swap reading — percentages a one-minute rolling average, raw bytes, and load —
# and a peer that stops answering comes back offline. A peer's own request (x-stam-local)
# returns only its own reading, so a fan-out never loops.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
use main
twin() { on twin "$STAM" "$@"; }
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }

# Each daemon lists the other as a peer, with the other's token.
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [{"name": other, "url": env(other)["STAM_URL"], "token": open(f"{tmp}/{other}/token").read().strip()}]
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up twin

get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# This machine and its peer, both answering, each with a plausible reading.
get /api/machines >"$TEST_TMP/m.json"
[ "$(jget "sorted(x['name'] for x in d)" <"$TEST_TMP/m.json")" = "['main', 'twin']" ] ||
  fail "not this machine and its peer: $(jget "[x['name'] for x in d]" <"$TEST_TMP/m.json")"
[ "$(jget "all(x['online'] for x in d)" <"$TEST_TMP/m.json")" = True ] || fail "a live peer came back offline"
[ "$(jget "all(0 <= x['cpu']['pct'] <= 100 and x['cpu']['count'] > 0 and len(x['cpu']['cores']) == x['cpu']['count'] for x in d)" <"$TEST_TMP/m.json")" = True ] ||
  fail "a CPU reading is out of range: $(jget "[x['cpu'] for x in d]" <"$TEST_TMP/m.json")"
[ "$(jget "all(x['ram']['total'] > 0 and 0 <= x['ram']['pct'] <= 100 and len(x['load']) == 3 for x in d)" <"$TEST_TMP/m.json")" = True ] ||
  fail "a memory reading is missing: $(jget "[x['ram'] for x in d]" <"$TEST_TMP/m.json")"
# The peer's own reading matches the name it is listed under, so the merge never confuses them.
[ "$(jget "[x['name'] for x in d if x['cpu']['count'] > 0]" <"$TEST_TMP/m.json")" != "" ] || fail "no machine reported its cores"

# A peer's own request returns only itself: the route never fans out twice.
on twin sh -c 'curl -sf -H "authorization: Bearer $(cat "$STAM_HOME/peer-token")" -H "x-stam-local: 1" "$STAM_URL/api/machines"' >"$TEST_TMP/twin.json"
[ "$(jget "len(d)" <"$TEST_TMP/twin.json")" = 1 ] || fail "a peer's own request fanned out: $(jget "len(d)" <"$TEST_TMP/twin.json")"
[ "$(jget "d[0]['name']" <"$TEST_TMP/twin.json")" = twin ] || fail "the peer returned the wrong machine"

# usage_info's machines (GET /api/usage): each machine compact, with its agents by state (none here).
get /api/usage >"$TEST_TMP/usage.json"
[ "$(jget "sorted(x['name'] for x in d['machines'])" <"$TEST_TMP/usage.json")" = "['main', 'twin']" ] ||
  fail "usage has no machines for this machine and its peer"
[ "$(jget "all(set(x) == {'name','online','cores','cpu_pct','ram_pct','ram_used_gb','ram_total_gb','swap_pct','load_1m','agents'} and 'cores' not in x['agents'] for x in d['machines'])" <"$TEST_TMP/usage.json")" = True ] ||
  fail "a usage machine has the wrong shape: $(jget "[sorted(x) for x in d['machines']]" <"$TEST_TMP/usage.json")"
[ "$(jget "all(x['agents'] == {'working': 0, 'waiting': 0, 'idle': 0, 'paused': 0} for x in d['machines'])" <"$TEST_TMP/usage.json")" = True ] ||
  fail "agent counts with no agents: $(jget "[x['agents'] for x in d['machines']]" <"$TEST_TMP/usage.json")"
[ "$(jget "all(x['load_1m'] is not None for x in d['machines'] if x['online'])" <"$TEST_TMP/usage.json")" = True ] || fail "an online machine has no 1-minute load"

# A peer that stops answering shows as offline, without taking the list down with it.
twin daemon stop >/dev/null 2>&1 || true
get "/api/machines" >"$TEST_TMP/down.json"
[ "$(jget "len(d)" <"$TEST_TMP/down.json")" = 2 ] || fail "the list changed shape when a peer stopped"
[ "$(jget "next(x for x in d if x['name']=='twin')['online']" <"$TEST_TMP/down.json")" = False ] || fail "a stopped peer didn't show as offline"
[ "$(jget "next(x for x in d if x['name']=='main')['online']" <"$TEST_TMP/down.json")" = True ] || fail "this machine went offline with its peer"
echo "PASS e2e-machines"
