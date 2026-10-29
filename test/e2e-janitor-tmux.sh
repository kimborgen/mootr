#!/bin/sh
# Janitor, leaked test tmux servers (S-175 part 2), free (no models): a test tmux server whose
# owner agent is archived is swept, and one whose owner is active and young is kept. A dry run
# reports the sweep and stops nothing. Runs against its own daemon (test/lib.sh); the janitor is
# machine-wide, so a sweep also sees other agents' leftovers, which it sweeps only when they are leaks.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
# The fake Claude Code must be set before the daemon starts, or its agents run the real claude.
daemon_home main
printf '{ "turns": [{ "match": "Stand by.", "steps": [{ "status": { "context_tokens": 0, "output_tokens": 0 } }, { "reply": "ok" }] }] }\n' >"$TEST_TMP/idle.json"
fake_claude "$TEST_TMP/idle.json"
use main
daemon_up main
id() { "$STAM" show "$1" | grep -m1 '"id"' | cut -d'"' -f4; }

# Two agents: keep stays active, zzarch is archived. Their ids name the tmux sockets, as a test's
# socket is named for its owner.
"$STAM" spawn keep --cwd "$TEST_TMP" "Stand by." >/dev/null
"$STAM" wait keep --until idle --timeout 60 >/dev/null
"$STAM" spawn zzarch --cwd "$TEST_TMP" "Stand by." >/dev/null
"$STAM" wait zzarch --until idle --timeout 60 >/dev/null
"$STAM" archive zzarch >/dev/null
KEEP_ID=$(id keep)
ARCH_ID=$(id zzarch)
[ -n "$KEEP_ID" ] && [ -n "$ARCH_ID" ] || fail "no agent ids"

ORPHAN="stam-test-$ARCH_ID-Zz1234-orphan"
YOUNG="stam-test-$KEEP_ID-Kk5678-young"
# Test shells in folders of their own, daemon.sh-style: a shell and the throwaway daemon (a sleep
# with its STAM_HOME) it started. ODIR's owner is archived, KDIR's is active.
ODIR="$STAM_TEST_TMPDIR/stam-test.$ARCH_ID.Sh1234"
KDIR="$STAM_TEST_TMPDIR/stam-test.$KEEP_ID.Kq5678"
HDIR="$STAM_TEST_TMPDIR/stam-test.zzhung.Hh1234"
HSOCK=stam-test-zzhung-Hh1234-hung
HPID=
XDIR="$STAM_TEST_TMPDIR/stam-test.zzrace.Xx1234"
XSOCK=stam-test-zzrace-Xx1234-hung
XPID=
YDIR="$STAM_TEST_TMPDIR/stam-test.zzrace.Yy1234"
YSOCK=stam-test-zzrace-Yy1234-ok
cleanup_socks() {
  tmux -L "$ORPHAN" kill-server 2>/dev/null || true
  tmux -L "$YOUNG" kill-server 2>/dev/null || true
  if [ -n "$HPID" ]; then kill -CONT "$HPID" 2>/dev/null; kill -KILL "$HPID" 2>/dev/null; fi
  [ -n "$HSOCK" ] && tmux -L "$HSOCK" kill-server 2>/dev/null || true
  rm -rf "$HDIR"
  if [ -n "$XPID" ]; then kill -CONT "$XPID" 2>/dev/null; kill -KILL "$XPID" 2>/dev/null; fi
  [ -n "$XSOCK" ] && tmux -L "$XSOCK" kill-server 2>/dev/null || true
  [ -n "$YSOCK" ] && tmux -L "$YSOCK" kill-server 2>/dev/null || true
  rm -rf "$XDIR" "$YDIR"
  # The file goes only once the server is down: kill-server worked, or tmux says no server runs.
  for s in "$ORPHAN" "$YOUNG" "$HSOCK" "$XSOCK" "$YSOCK"; do
    [ -n "$s" ] || continue
    if tmux -L "$s" kill-server 2>/dev/null || timeout 5 tmux -L "$s" ls 2>&1 | grep -q "no server running"; then
      rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$s"
    fi
  done
  for d in "$ODIR" "$KDIR"; do
    [ -f "$d/child" ] && kill "$(cat "$d/child")" 2>/dev/null
    [ -n "$KSHELL" ] && [ "$d" = "$KDIR" ] && kill "$KSHELL" 2>/dev/null
  done
  rm -rf "$ODIR" "$KDIR"
  stam_test_cleanup
}
trap cleanup_socks EXIT
trap 'exit 130' INT TERM HUP

echo "== a leaked server under the archived owner, and a live one under the active owner"
tmux -L "$ORPHAN" new-session -d -s orphan 'sleep 300'
tmux -L "$YOUNG" new-session -d -s young 'sleep 300'

echo "== a test shell under each owner: the archived owner's is swept, the active owner's is kept"
for d in "$ODIR" "$KDIR"; do mkdir -p "$d/home"; done
sh -c 'env STAM_HOME="$1/home" MOOTR_HOME="$1/home" sleep 300 & echo $! >"$1/child"; wait' sh "$ODIR" &
OSHELL=$!
sh -c 'env STAM_HOME="$1/home" MOOTR_HOME="$1/home" sleep 300 & echo $! >"$1/child"; wait' sh "$KDIR" &
KSHELL=$!
for _i in $(seq 1 40); do [ -s "$ODIR/child" ] && [ -s "$KDIR/child" ] && break; sleep 0.1; done
OCHILD=$(cat "$ODIR/child")
# The owner file is written last: until then the janitor keeps the folder (no owner file).
printf 'agent=%s\npid=%s\nstarted=%s\n' "$ARCH_ID" "$OSHELL" "$(date -Is)" >"$ODIR/owner"
printf 'agent=%s\npid=%s\nstarted=%s\n' "$KEEP_ID" "$KSHELL" "$(date -Is)" >"$KDIR/owner"

echo "== a dry run reports the orphan and stops nothing"
"$STAM" janitor --dry-run >"$TEST_TMP/dry.out" 2>&1 || fail "janitor --dry-run: $(cat "$TEST_TMP/dry.out")"
grep -q "would clean tmux $ORPHAN" "$TEST_TMP/dry.out" || fail "the dry run didn't see the archived owner's server: $(cat "$TEST_TMP/dry.out")"
grep -q "$YOUNG" "$TEST_TMP/dry.out" && fail "the dry run would sweep the active owner's young server"
grep -q "would clean daemon $OSHELL (test shell)" "$TEST_TMP/dry.out" || fail "the dry run didn't see the archived owner's test shell: $(cat "$TEST_TMP/dry.out")"
grep -q "kept $KDIR: test shell $KSHELL is alive" "$TEST_TMP/dry.out" || fail "the dry run didn't keep the active owner's test shell: $(cat "$TEST_TMP/dry.out")"
kill -0 "$OSHELL" 2>/dev/null || fail "the dry run stopped the archived owner's test shell"
[ -d "$ODIR" ] || fail "the dry run removed the archived owner's folder"
tmux -L "$ORPHAN" ls >/dev/null 2>&1 || fail "the dry run stopped the orphan server"

echo "== the sweep stops the archived owner's server and keeps the active one"
"$STAM" janitor >"$TEST_TMP/sweep.out" 2>&1 || fail "janitor: $(cat "$TEST_TMP/sweep.out")"
grep -q "cleaned tmux $ORPHAN" "$TEST_TMP/sweep.out" || fail "the sweep didn't clean the orphan server: $(cat "$TEST_TMP/sweep.out")"
grep -q "cleaned daemon $OSHELL (test shell)" "$TEST_TMP/sweep.out" || fail "the sweep didn't stop the archived owner's test shell: $(cat "$TEST_TMP/sweep.out")"
wait "$OSHELL" 2>/dev/null || true
kill -0 "$OSHELL" 2>/dev/null && fail "the archived owner's test shell still runs"
kill -0 "$OCHILD" 2>/dev/null && fail "the archived owner's test daemon still runs"
[ ! -e "$ODIR" ] || fail "the archived owner's folder survived"
kill -0 "$KSHELL" 2>/dev/null || fail "the sweep stopped the active owner's test shell"
[ -d "$KDIR" ] || fail "the sweep removed the active owner's folder"
tmux -L "$ORPHAN" ls >/dev/null 2>&1 && fail "the orphan tmux server still runs"
tmux -L "$YOUNG" ls >/dev/null 2>&1 || fail "the sweep stopped the active owner's server"
"$STAM" daemon status | grep -q "machine: 'main'" || fail "the sweep stopped the live test daemon"

echo "== the sweep logged a janitor event"
curl -sf -m 5 -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/test/events?type=janitor" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' | grep -qx '[1-9][0-9]*' || fail "no janitor event was logged"

echo "== a tmux server that never answers is skipped: the sweep finishes, the daemon answers meanwhile"
# A dead owner's folder whose test server is stopped (SIGSTOP): every tmux call to it hangs.
mkdir -p "$HDIR"
sh -c 'exit 0' & HDEAD=$!
wait "$HDEAD" 2>/dev/null || true
printf 'agent=zzhung\npid=%s\nstarted=%s\n' "$HDEAD" "$(date -Is)" >"$HDIR/owner"
tmux -L "$HSOCK" new-session -d -s hung 'sleep 300'
HPID=$(tmux -L "$HSOCK" display-message -p '#{pid}')
kill -STOP "$HPID"
AUTH="authorization: Bearer $(cat "$STAM_HOME/token")"
hung_sweep() {
  curl -s -m 30 -H "$AUTH" -H 'content-type: application/json' -d "{\"only\":[\"$HDIR\"]}" "$STAM_URL/api/janitor"
}
hung_sweep >"$TEST_TMP/hung.json" &
HSWEEP=$!
# The sweep is blocked while a tmux client for the hung socket is in flight (it can't finish
# before that client's timeout), so the daemon must answer while the sweep is still running.
for _i in $(seq 1 200); do
  ps -eo args= | grep -F "tmux -L $HSOCK" | grep -qv grep && break
  sleep 0.05
done
ps -eo args= | grep -F "tmux -L $HSOCK" | grep -qv grep || fail "the sweep never reached the hung server"
kill -0 "$HSWEEP" 2>/dev/null || fail "the sweep ended before it reached the hung server"
curl -sf -m 2 -H "$AUTH" "$STAM_URL/api/health" >/dev/null || fail "/api/health didn't answer while the sweep waited on the hung server"
wait "$HSWEEP" || fail "the sweep failed: $(cat "$TEST_TMP/hung.json")"

python3 - "$TEST_TMP/hung.json" "$HSOCK" "$HDIR" <<'EOF' || fail "the sweep didn't skip the hung server: $(cat "$TEST_TMP/hung.json")"
import json, sys
r = json.load(open(sys.argv[1])); sock, folder = sys.argv[2], sys.argv[3]
assert not [a for a in r["actions"] if a["target"] == sock], "it cleaned the hung server"
assert [k for k in r["kept"] if k["path"] == sock and "did not answer" in k["why"]], "the hung server wasn't kept"
assert [k for k in r["kept"] if k["path"] == folder], "its folder wasn't kept"
EOF
kill -0 "$HPID" 2>/dev/null || fail "the sweep killed the stopped server"
[ -d "$HDIR" ] || fail "the sweep removed the folder of a server that didn't answer"

echo "== once the server answers again, the next sweep cleans it"
kill -CONT "$HPID" || fail "couldn't resume the hung server"
hung_sweep >"$TEST_TMP/hung2.json" || fail "the second sweep failed"
python3 - "$TEST_TMP/hung2.json" "$HSOCK" "$HDIR" <<'EOF' || fail "the second sweep didn't clean the resumed server: $(cat "$TEST_TMP/hung2.json")"
import json, sys
r = json.load(open(sys.argv[1])); sock, folder = sys.argv[2], sys.argv[3]
assert [a for a in r["actions"] if a["target"] == sock and a["kind"] == "tmux"], "it didn't clean the server"
assert not [k for k in r["kept"] if k["path"] in (sock, folder)], "it still kept the server or its folder"
EOF
[ ! -e "$HDIR" ] || fail "the folder survived the next sweep"
tmux -L "$HSOCK" ls >/dev/null 2>&1 && fail "the resumed server still runs"
HPID=

echo "== two overlapping sweeps: the dry run waits for the real one, and the leftover is cleaned once"
# Sweep A is held on a stopped server (X) for at least its timeout; dry-run B comes in meanwhile.
# B must run after A, so it finds Y already gone: nothing to report, and one janitor event for Y.
for d in "$XDIR" "$YDIR"; do
  mkdir -p "$d"
  sh -c 'exit 0' & p=$!
  wait "$p" 2>/dev/null || true
  printf 'agent=zzrace\npid=%s\nstarted=%s\n' "$p" "$(date -Is)" >"$d/owner"
done
tmux -L "$XSOCK" new-session -d -s hung 'sleep 300'
XPID=$(tmux -L "$XSOCK" display-message -p '#{pid}')
kill -STOP "$XPID"
tmux -L "$YSOCK" new-session -d -s ok 'sleep 300'
curl -s -m 30 -H "$AUTH" -H 'content-type: application/json' -d "{\"only\":[\"$XDIR\",\"$YDIR\"]}" "$STAM_URL/api/janitor" >"$TEST_TMP/race-a.json" &
RACE_A=$!
for _i in $(seq 1 200); do
  ps -eo args= | grep -F "tmux -L $XSOCK" | grep -qv grep && break
  sleep 0.05
done
ps -eo args= | grep -F "tmux -L $XSOCK" | grep -qv grep || fail "sweep A never reached the stopped server"
curl -s -m 30 -H "$AUTH" -H 'content-type: application/json' -d "{\"dry_run\":true,\"only\":[\"$YDIR\"]}" "$STAM_URL/api/janitor" >"$TEST_TMP/race-b.json"
wait "$RACE_A" || fail "sweep A failed"

python3 - "$TEST_TMP/race-a.json" "$TEST_TMP/race-b.json" "$XSOCK" "$YSOCK" "$YDIR" <<'EOF' || fail "the overlapping sweeps disagreed: A $(cat "$TEST_TMP/race-a.json") B $(cat "$TEST_TMP/race-b.json")"
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2])); xs, ys, yd = sys.argv[3], sys.argv[4], sys.argv[5]
assert [k for k in a["kept"] if k["path"] == xs and "did not answer" in k["why"]], "A didn't skip the stopped server"
cleaned = [x for x in a["actions"] if x["target"] == ys and x["kind"] == "tmux"]
assert len(cleaned) == 1, f"A cleaned {ys} {len(cleaned)} times"
assert b["dryRun"] is True, "B wasn't a dry run"
assert b["actions"] == [], f"the dry run after a real sweep still reported {b['actions']}"
EOF
[ ! -e "$YDIR" ] || fail "the leftover folder survived the real sweep"
tmux -L "$YSOCK" ls >/dev/null 2>&1 && fail "the leftover server still runs"
curl -sf -m 5 -H "$AUTH" "$STAM_URL/api/test/events?type=janitor" | python3 -c 'import json,sys; print(sum(sys.argv[1] in (e["data"] or "") for e in json.load(sys.stdin)))' "$YSOCK" | grep -qx 1 || fail "the leftover was logged other than once"
kill -CONT "$XPID" 2>/dev/null
XPID=

echo "PASS e2e-janitor-tmux"
