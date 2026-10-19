#!/bin/sh
# A spawn on a stopped peer starts it (S-234), free (no models). Two isolated daemons: "main"
# spawns, "twin" is the peer, stopped at the start of each case. The peer's `start` is a fake
# command that counts its runs, waits two seconds, and launches twin's daemon; a flag file makes
# it fail instead. Checks:
#   - a spawn on a peer that answers runs no start
#   - a spawn on a stopped peer runs the start once, then forwards the spawn
#   - two spawns at once on a stopped peer run the start once, and both succeed
#   - a failing start gives an error naming the peer and the command's output, and no agent
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
START="$TEST_TMP/start-twin.sh"
cat >"$START" <<SH
#!/bin/sh
echo run >>"$TEST_TMP/starts"
if [ -f "$TEST_TMP/fail-start" ]; then echo "box: no such machine twin" >&2; exit 3; fi
sleep 2
. "$TEST_TMP/twin/test.env"
"$STAM" daemon start >/dev/null 2>&1 </dev/null
SH
python3 - "$TEST_TMP" "$START" <<'PY'
import json, re, sys
tmp, start = sys.argv[1], sys.argv[2]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
s = json.load(open(f"{tmp}/main/settings.json"))
s["peers"] = [{"name": "twin", "url": env("twin")["STAM_URL"], "token": open(f"{tmp}/twin/token").read().strip(), "start": f"sh {start}"}]
json.dump(s, open(f"{tmp}/main/settings.json", "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
api() {
  curl -s -X "$1" -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "$MAIN_URL$2"
}
starts() { [ -f "$TEST_TMP/starts" ] && wc -l <"$TEST_TMP/starts" || echo 0; }
spawn() { api POST /api/agents "{\"name\":\"$1\",\"machine\":\"twin\",\"cwd\":\"$REPO\",\"type\":\"developer\",\"prompt\":\"Do the thing.\"}"; }
REPO="$TEST_TMP/repo"; git init -q "$REPO" && git -C "$REPO" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

echo "-- a spawn on a peer that answers runs no start"
R=$(spawn kid0) || fail "spawn kid0 failed"
printf "%s" "$R" | jget "d['machine']" | grep -qx twin || fail "kid0 isn't on twin (got: $R)"
[ "$(starts)" = 0 ] || fail "a start ran for a peer that answered"

echo "-- a spawn on a stopped peer starts it once, then forwards"
daemon_stop twin
R=$(spawn kid1) || fail "spawn kid1 failed on a stopped peer (got: $R)"
printf "%s" "$R" | jget "d['machine']" | grep -qx twin || fail "kid1 isn't on twin (got: $R)"
[ "$(starts)" = 1 ] || fail "expected one start, got $(starts)"
on twin "$STAM" ls | grep -q kid1 || fail "twin doesn't run kid1 after the start"

echo "-- two spawns at once run the start once"
daemon_stop twin
spawn kid2 >"$TEST_TMP/kid2.out" &
spawn kid3 >"$TEST_TMP/kid3.out" &
wait
grep -q '"id"' "$TEST_TMP/kid2.out" || fail "kid2 failed: $(cat "$TEST_TMP/kid2.out")"
grep -q '"id"' "$TEST_TMP/kid3.out" || fail "kid3 failed: $(cat "$TEST_TMP/kid3.out")"
[ "$(starts)" = 2 ] || fail "two concurrent spawns ran the start $(($(starts) - 1)) times"

echo "-- a failing start gives a clear error and no agent"
daemon_stop twin
: >"$TEST_TMP/fail-start"
R=$(spawn doomed)
rm -f "$TEST_TMP/fail-start"
printf "%s" "$R" | grep -q "twin is unreachable and didn't start" || fail "no clear error (got: $R)"
printf "%s" "$R" | grep -q "no such machine twin" || fail "the error lacks the start command's output (got: $R)"
[ "$(starts)" = 3 ] || fail "the failing start didn't run once"
daemon_up twin
api GET /api/agents | grep -q doomed && fail "a failed start still created doomed"
echo "PASS e2e-peer-start"
