#!/bin/sh
# Cancel of a queued spawn across machines (S-2579), free (no models). Two daemons: "main" is where the caller runs,
# "twin" holds the queue entry (its one developer slot is held). Checks: a cancel from main removes twin's entry;
# a caller that isn't the spawner, its parent, or the boss is refused and the entry stays; a peer that is down gives
# an error naming it, not "no queued spawn"; a cancel racing the slot grant gives exactly one outcome.
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
api() {
  curl -s -X "$3" -H "authorization: Bearer $2" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$1$4" ${5:+-d "$5"}
}
# register NAME: prints "ID TOKEN" of a new agent on main.
register() { api "$MAIN_URL" "$MAIN_TOKEN" POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\",\"token\":true}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["id"], d["token"])'; }
# cancel TOKEN NAME: prints "CODE BODY" of an agent's cancel through main.
cancel() { curl -s -w ' %{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' "$MAIN_URL/api/slot-queue/$2/cancel" -d '{}'; }
# queue NAME: queues a developer spawn on twin as BOSS (its slot is held, so it waits).
# QBY is the caller it is queued for (default boss). Twin must queue it before it has met the agent through a cancel, or its shared token can't name the agent.
queue() {
  R=$(curl -s -X POST -H "authorization: Bearer $TWIN_TOKEN" -H 'content-type: application/json' "$TWIN_URL/api/agents" -d "{\"name\":\"$1\",\"type\":\"developer\",\"cwd\":\"$REPO\",\"by\":\"${QBY:-$BOSS}\"}")
  printf %s "$R" | grep -q '"queued":true' || fail "$1 not queued on twin: $R"
}
queued_on_twin() { grep -q "\"name\":\"$1\"" "$TEST_TMP/twin/slot-queue.json"; }
started_on_twin() { api "$TWIN_URL" "$TWIN_TOKEN" GET /api/agents | grep -q "\"name\":\"$1\""; }

set -- $(register boss)
BOSS=$1 BOSS_TOKEN=$2
set -- $(register other)
OTHER_TOKEN=$2

echo "-- 1. twin's one developer slot is held, and boss queues dev1 behind it"
R=$(api "$TWIN_URL" "$TWIN_TOKEN" POST /api/agents "{\"name\":\"hold\",\"type\":\"developer\",\"cwd\":\"$REPO\"}")
printf %s "$R" | grep -q '"name":"hold"' || fail "hold not started on twin: $R"
queue dev1

echo "-- 2. an agent that isn't the spawner is refused, and the entry stays"
R=$(cancel "$OTHER_TOKEN" dev1)
case "$R" in *" 403") ;; *) fail "another agent's cancel not a 403: $R" ;; esac
queued_on_twin dev1 || fail "the refused cancel removed dev1"

echo "-- 3. the spawner cancels from main: the entry leaves twin's saved queue, and dev1 never starts"
R=$(cancel "$BOSS_TOKEN" dev1)
case "$R" in *" 200") ;; *) fail "the spawner's cancel from main not a 200: $R" ;; esac
printf %s "$R" | grep -q '"machine":"twin"' || fail "the reply doesn't name twin: $R"
queued_on_twin dev1 && fail "twin's saved queue still holds dev1"
R=$(cancel "$BOSS_TOKEN" dev1)
case "$R" in *" 404") ;; *) fail "a second cancel not a 404: $R" ;; esac

echo "-- 3b. the OpenCode server cancels only as the agent it names: a stranger gets 403, no agent is refused, the spawner gets 200"
OCTOKEN=ocserver-test-token
python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest(), end="")' "$OCTOKEN" >"$TEST_TMP/main/opencode-token"
oc_register() { api "$MAIN_URL" "$MAIN_TOKEN" POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"opencode\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
OCA=$(oc_register ocspawner)
OCB=$(oc_register ocstranger)
QBY=$OCA
queue ocjob
oc_cancel() { curl -s -w ' %{http_code}' -X POST -H "authorization: Bearer $OCTOKEN" -H 'content-type: application/json' "$MAIN_URL/api/slot-queue/ocjob/cancel" -d "$1"; }
R=$(oc_cancel '{}')
case "$R" in *" 403") ;; *) fail "an OpenCode cancel naming no agent not a 403: $R" ;; esac
R=$(oc_cancel "{\"by\":\"$OCB\"}")
case "$R" in *" 403") ;; *) fail "an unrelated OpenCode agent's cancel not a 403: $R" ;; esac
queued_on_twin ocjob || fail "a refused OpenCode cancel removed ocjob"
R=$(oc_cancel "{\"by\":\"$OCA\"}")
case "$R" in *" 200") ;; *) fail "the OpenCode spawner's cancel not a 200: $R" ;; esac
queued_on_twin ocjob && fail "ocjob is still saved on twin"

echo "-- 4. a name queued nowhere is a 404 that says so"
R=$(cancel "$BOSS_TOKEN" nosuch)
case "$R" in *"no queued spawn named nosuch"*" 404") ;; *) fail "unknown name: $R" ;; esac

echo "-- 5. a cancel racing the slot grant gives exactly one outcome: cancelled and never started, or started and refused"
HOLDER=hold
for n in 1 2 3 4 5; do
  set -- $(register "racer$n")
  QBY=$1
  queue "race$n"
  (cancel "$2" "race$n" >"$TEST_TMP/race$n.out") &
  api "$TWIN_URL" "$TWIN_TOKEN" POST "/api/agents/$HOLDER/shutdown" '{"now":true}' >/dev/null
  wait
  OUT=$(cat "$TEST_TMP/race$n.out")
  case "$OUT" in
    *" 200")
      sleep 1
      started_on_twin "race$n" && fail "race$n was cancelled and also started: $OUT"
      queued_on_twin "race$n" && fail "race$n was cancelled but is still saved: $OUT"
      HOLDER="holder$n"
      api "$TWIN_URL" "$TWIN_TOKEN" POST /api/agents "{\"name\":\"$HOLDER\",\"type\":\"developer\",\"cwd\":\"$REPO\"}" >/dev/null
      ;;
    *" 409" | *" 404") wait_until started_on_twin "race$n"; HOLDER="race$n" ;;
    *) fail "race$n gave neither outcome: $OUT" ;;
  esac
done

echo "-- 6. a peer that is down is named in the error, not reported as not queued"
set -- $(register latecomer)
QBY=$1 LATE_TOKEN=$2
queue late
daemon_stop twin
R=$(cancel "$LATE_TOKEN" late)
case "$R" in *" 502") ;; *) fail "down peer not a 502: $R" ;; esac
printf %s "$R" | grep -q 'twin' || fail "the error doesn't name twin: $R"
printf %s "$R" | grep -q 'no queued spawn' && fail "a down peer was reported as not queued: $R"
echo "PASS"
