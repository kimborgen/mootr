#!/bin/sh
# Harness guard (S-176, S-184), free (no model): a daemon started before fake_claude still spawns the
# fake Claude Code, never the real claude, and a Codex agent spawns the scripted fake Codex, never the
# real codex. The agents' processes are the fakes (test/fake-claude/claude, test/fake-codex/codex), and
# no real claude or codex runs for this test; the spend is $0.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }

echo "== the daemon starts before fake_claude is called"
isolate main
fake_claude "$TEST_TMP/idle.json"
printf '{ "turns": [] }\n' >"$TEST_TMP/idle.json"

echo "== an agent spawned on that daemon runs the fake"
"$STAM" spawn guard --cwd "$TEST_TMP" "Stand by." >/dev/null
"$STAM" wait guard --until idle --timeout 60 >/dev/null
# The fake's argv names this test's folder (its settings file lives there); a real claude would too.
procs=$(ps -eo args= | grep -F "$TEST_TMP/")
echo "$procs" | grep -F "$ROOT/test/fake-claude/claude" >/dev/null || fail "no fake Claude Code runs for this test: $procs"
echo "$procs" | grep -E '^claude( |$)' >/dev/null && fail "a real claude runs for this test: $procs"

echo "== a codex agent spawned on that daemon runs the scripted fake, not the real codex"
# The machine's own Codex (its managed app-server, say) runs outside this test, so the check is on
# the codex processes that start after the spawn: none may be the real binary.
codex_real_pids() { ps -eo pid=,args= | grep -E '(^|/)codex( |$)' | grep -F -v "$ROOT/test/fake-codex/" | awk '{print $1}'; }
before=$(codex_real_pids | tr '\n' ' ')
"$STAM" spawn guard-cx --harness codex --model gpt-6.1-sol --effort low --cwd "$TEST_TMP" "Stand by." >/dev/null
codex_fake_runs() { ps -eo args= | grep -F "$ROOT/test/fake-codex/" >/dev/null; }
wait_until codex_fake_runs
for p in $(codex_real_pids); do
  case " $before " in *" $p "*) ;; *) fail "a real codex starts for this test: $(ps -o args= -p "$p")" ;; esac
done

echo "== no model was called, so the spend is \$0"
auth="authorization: Bearer $(cat "$STAM_HOME/token")"
spend=$(curl -s -m 5 -H "$auth" "$STAM_URL/api/usage?days=1" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["today"]["cost_usd"] or 0)')
[ "$spend" = "0" ] || fail "the spend is \$$spend, not \$0"

echo "PASS e2e-harness-guard"
