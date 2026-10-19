#!/bin/sh
# A spawn that starts on one machine drops the queued duplicate on its peer (S-2134), free (no models). Two daemons:
# "main" starts the spawn, "twin" has its one developer slot held, so the same-name spawn queues there.
# Checks: the spawn on main starts, and the peer's queued duplicate of the same name from the same caller is gone
# from twin's saved queue; a peer's drop doesn't touch a waiter with another name. A fake `claude` stands in.
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
FAKE="$TEST_TMP/fake-bin"
mkdir -p "$FAKE"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec sleep 600\n' >"$FAKE/claude"
chmod +x "$FAKE/claude"
PATH="$FAKE:$PATH"
export PATH
# A fixed /proc, so the load guard (S-2120) sees a quiet machine on both daemons.
PROC_DIR="$TEST_TMP/proc"
mkdir -p "$PROC_DIR"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n' >"$PROC_DIR/stat"
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       2000000 kB\n' >"$PROC_DIR/meminfo"
printf '0.10 0.10 0.10 1/200 1234\n' >"$PROC_DIR/loadavg"
export STAM_PROC_DIR="$PROC_DIR"
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
    s["developerCap"] = 1
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up twin
use main
MAIN_URL=$STAM_URL
MAIN_TOKEN=$(cat "$STAM_HOME/token")
use twin
TWIN_URL=$STAM_URL
TWIN_TOKEN=$(cat "$STAM_HOME/token")
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
# api URL TOKEN METHOD PATH [BODY]: a human request (the human header and key, so the spawn counts as the human's).
api() {
  curl -s -X "$3" -H "authorization: Bearer $2" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$1$4" ${5:+-d "$5"}
}

echo "-- 1. twin's one developer slot is held"
R=$(api "$TWIN_URL" "$TWIN_TOKEN" POST /api/agents "{\"name\":\"hold\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"name":"hold"' || fail "hold not started on twin: $R"

echo "-- 2. the caller's same-name spawn waits in twin's queue"
BOSS=$(api "$MAIN_URL" "$MAIN_TOKEN" POST /api/register '{"name":"boss","role":"test","harness":"claude"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
# Without the human header, as an agent's spawn: the human skips the cap and the queue.
R=$(curl -s -X POST -H "authorization: Bearer $TWIN_TOKEN" -H 'content-type: application/json' "$TWIN_URL/api/agents" -d "{\"name\":\"dup\",\"type\":\"developer\",\"cwd\":\"$REPO\",\"by\":\"$BOSS\"}")
printf %s "$R" | grep -q '"queued":true' || fail "dup not queued on twin: $R"
grep -q '"name":"dup"' "$TEST_TMP/twin/slot-queue.json" || fail "twin's saved queue lacks dup"

echo "-- 3. the same spawn starts on main, and the drop removes twin's queued dup from its saved queue"
R=$(api "$MAIN_URL" "$MAIN_TOKEN" POST /api/agents "{\"name\":\"dup\",\"type\":\"developer\",\"cwd\":\"$REPO\",\"by\":\"$BOSS\"}")
printf %s "$R" | grep -q '"name":"dup"' || fail "dup not started on main: $R"
twin_lacks_dup() { ! grep -q '"name":"dup"' "$TEST_TMP/twin/slot-queue.json"; }
wait_until twin_lacks_dup
api "$TWIN_URL" "$TWIN_TOKEN" POST /api/agents/hold/shutdown '{"now":true}' >/dev/null
echo "PASS"
