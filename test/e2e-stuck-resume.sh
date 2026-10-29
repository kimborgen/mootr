#!/bin/sh
# S-3250, free: a Claude Code agent's compaction relaunches it with a promptless resume, which only
# its SessionStart hook took out of 'starting'. A daemon restart seconds after that resume lost the
# hook, and the agent sat 'starting / resuming' for hours with its mail unread (azyk7, 05:26Z).
# Here the fake holds the resumed launch (fake-start-hold) while the daemon restarts, then loses its
# SessionStart (fake-drop-session-start): the restarted daemon settles the agent at its prompt, and
# it answers mail. Then the same loss with no restart: the agent settles once its launch is done.
# The stuck-start watchdog is off (stuckStartMinutes 0), so only the settle can recover it.
# Claude Code agents on the scripted fake (test/fake-claude, no model). Runs against its own daemon
# (test/lib.sh). Nothing waits on a timer: the checks poll state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/stuck-resume.json" <<'EOF2'
{ "turns": [
  { "match": "Reply with exactly: ready", "steps": [ { "reply": "ready" } ] },
  { "match": "from the human: ping", "steps": [
    { "mcp": "read_mail" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "pong", "new_thread": true, "body": "pong" } },
    { "reply": "Mailed the human." } ] }
] }
EOF2
fake_claude "$TEST_TMP/stuck-resume.json"
isolate
printf '%s\n' '{"idleCompaction":{"enabled":false},"stuckStartMinutes":0}' >"$STAM_HOME/settings.json"
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
count() { "$STAM" events "$1" --limit 200 | grep -c "$2" || true; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
resumes() { count "$N" ' resume '; }
resuming() { test "$(field "$N" activity)" = starting && test "$(field "$N" activity_detail)" = resuming && test "$(resumes)" -gt "$1"; }
settled() { test "$(field "$N" activity)" = idle && test "$(count "$N" 'starting:settled')" -ge "$1"; }
dropped() { test ! -e "$STAM_HOME/fake-drop-session-start"; }

N="e2e-sr-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$N" --model claude-sonnet-5-5 --cwd "$DIR" --role "Stuck resume test agent." "Reply with exactly: ready"
"$STAM" wait "$N" --until idle --timeout 90

echo "-- a compaction's resume, its SessionStart lost across a daemon restart"
before=$(resumes)
touch "$STAM_HOME/fake-start-hold" "$STAM_HOME/fake-drop-session-start"
"$STAM" compact "$N" >"$TEST_TMP/compact.out" 2>&1 || { echo "FAIL: compact: $(cat "$TEST_TMP/compact.out")"; exit 1; }
poll 1100 resuming "$before" || { echo "FAIL: $N never showed resuming: $(field "$N" activity) $(field "$N" activity_detail)"; exit 1; }
daemon_stop main
rm -f "$STAM_HOME/fake-start-hold"
# The harness comes up while the daemon is down, its SessionStart lost.
wait_until dropped
daemon_up main
poll 800 settled 1 || { echo "FAIL: $N stuck after the restart: $(field "$N" activity) $(field "$N" activity_detail); events: $("$STAM" events "$N" | tail -5)"; exit 1; }
"$STAM" mail send --to "$N" --subject ping "ping" >/dev/null
poll 400 human_has "pong" || { echo "FAIL: $N didn't answer mail after the resume"; exit 1; }

echo "-- the same loss with the daemon up"
before=$(resumes)
touch "$STAM_HOME/fake-drop-session-start"
"$STAM" compact "$N" >"$TEST_TMP/compact.out" 2>&1 || { echo "FAIL: compact: $(cat "$TEST_TMP/compact.out")"; exit 1; }
landed() { test "$(resumes)" -gt "$before"; }
poll 400 landed || { echo "FAIL: no second resume"; exit 1; }
poll 800 settled 2 || { echo "FAIL: $N stuck with the daemon up: $(field "$N" activity) $(field "$N" activity_detail)"; exit 1; }
dropped || { echo "FAIL: the SessionStart was not dropped"; exit 1; }
echo "PASS e2e-stuck-resume"
