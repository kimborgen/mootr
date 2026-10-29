#!/bin/sh
# S-1400, free (the fake Claude Code): a reboot that finds an agent still marked 'starting' resumes it like the
# others. Two agents come back after a simulated reboot (daemon stopped, the DB row of one left 'starting' and
# long past its creation, tmux server killed, daemon started): each gets one `recover` event and goes idle; the
# starting one is not marked never started. A paused agent stays paused and a shut-down one stays shut down.
# Runs against its own daemon (test/lib.sh). Waits on state, never on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/rs.json" <<'EOT'
{ "turns": [], "default": { "steps": [ { "reply": "ok" } ] } }
EOT
fake_claude "$TEST_TMP/rs.json"
export STAM_TEST_NETWORK_PROBES=none
isolate
trap stam_test_cleanup EXIT
T=$(date +%s); DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
A="rs-idle-$T"; S="rs-starting-$T"; P="rs-paused-$T"; E="rs-exited-$T"
fail() { echo "FAIL: $1"; "$STAM" ls; exit 1; }
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
count() { "$STAM" events "$1" | grep -c "$2" || true; }
pid_gone() { ! kill -0 "$1" 2>/dev/null; }
idle() { "$STAM" wait "$1" --until idle --timeout 60 >/dev/null || { "$STAM" events "$1" | tail -15; fail "$1 not idle"; }; }
for n in "$A" "$S" "$P" "$E"; do
  "$STAM" spawn "$n" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Reboot test agent." "hello" >/dev/null
done
for n in "$A" "$S" "$P" "$E"; do idle "$n"; done
EID=$(field "$E" id)
pkill -TERM -g "$(tmux -L "$STAM_TMUX_SOCKET" list-panes -t "=$EID:" -F '#{pane_pid}')"
"$STAM" wait "$E" --until shut_down --timeout 20 >/dev/null || fail "$E did not shut down"
"$STAM" pause "$P" >/dev/null
SID=$(field "$S" id)
OLD_PID=$(cat "$STAM_HOME/daemon.pid")
daemon_stop main
wait_until pid_gone "$OLD_PID"
# The row a reboot can leave: still starting, created long before.
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1] + "/stam.db");
const old = new Date(Date.now() - 3 * 3600_000).toISOString();
db.prepare("UPDATE agents SET activity = ?, created_at = ? WHERE id = ?").run("starting", old, process.argv[2]);' "$STAM_HOME" "$SID"
tmux -L "$STAM_TMUX_SOCKET" kill-server
daemon_up main
for n in "$A" "$S"; do idle "$n"; done
for n in "$A" "$S"; do test "$(count "$n" ' recover ')" = 1 || fail "$n: no single recover event"; done
"$STAM" events "$S" | grep -q 'starting:dead' && fail "$S was marked never started"
test "$(field "$S" lifecycle)" = active || fail "$S is $(field "$S" lifecycle), not active"
test "$(field "$P" lifecycle)" = paused || fail "$P not paused"
test "$(count "$P" ' recover ')" = 0 || fail "$P was resumed"
test "$(field "$E" lifecycle)" = shut_down || fail "$E came back"
test "$(count "$E" ' recover ')" = 0 || fail "$E was resumed"
# The server dies under a running daemon while a spawn's first prompt is still undelivered: the prompt is
# delivered again with a fresh launch, not a bare resume that loses the task.
F="rs-firstprompt-$T"
"$STAM" spawn "$F" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Reboot test agent." "hello" >/dev/null
idle "$F"
FID=$(field "$F" id)
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1] + "/stam.db");
const id = process.argv[2];
db.prepare("DELETE FROM events WHERE agent_id = ? AND type IN (?, ?)").run(id, "first-prompt:delivered", "first-prompt:pending");
db.prepare("INSERT INTO events (agent_id, type, ts) VALUES (?, ?, ?)").run(id, "first-prompt:pending", new Date().toISOString());
db.prepare("UPDATE agents SET activity = ?, first_prompt = ? WHERE id = ?").run("starting", "hello", id);' "$STAM_HOME" "$FID"
tmux -L "$STAM_TMUX_SOCKET" kill-server
fp_recovered() { "$STAM" events "$F" | grep -q 'first-prompt:recover'; }
wait_until fp_recovered
idle "$F"
test "$(count "$F" ' recover ')" = 0 || fail "$F was resumed bare, losing its first prompt"
echo "PASS e2e-reboot-starting"
