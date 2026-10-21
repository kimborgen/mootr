#!/bin/sh
# The tmux server dies under a running daemon, free (the fake harnesses: no model, no outside request).
# Without a restart the daemon notices on its own: each running agent on Claude Code, OpenCode, and
# Codex gets exactly one `tmux-lost` and one `recover` event, comes back idle, and takes mail; the
# Claude Code agent answers from its resumed conversation (it mails back a code word it was told
# before). A paused agent stays paused with no `recover`, and answers once unpaused; an agent whose own
# harness exited stays shut down. The daemon's PID never changes. The restart version is
# test/e2e-reboot-fake.sh. Runs against its own daemon (test/lib.sh) and kills only its own tmux
# server. Waits on state (`stam wait`, polls bounded by wait_until), never on a timer. On exit, win or
# lose, the daemon and agents are stopped and the test home removed; a process or tmux server left
# behind fails it.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/tmux-crash.json" <<'EOF'
{ "turns": [
  { "match": "/Remember (\\S+)/", "steps": [
    { "shell": "echo ${1}", "save": { "word": "(\\S+)" } },
    { "reply": "ok" } ] },
  { "match": "/Recall (\\S+)/", "steps": [
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "Re: Recall ${1}", "body": "${word}" } },
    { "reply": "sent" } ] } ],
  "default": { "steps": [ { "reply": "ok" } ] } }
EOF
fake_claude "$TEST_TMP/tmux-crash.json"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
# Recovery waits for the network (src/network-probes.ts); a test home skips the probes, so nothing calls out.
export STAM_TEST_NETWORK_PROBES=none
isolate
SOCK="$STAM_TMUX_SOCKET"
HOME_DIR="$TEST_TMP"
# lib.sh's cleanup stops the daemon and agents and removes the folder; this adds the check that
# nothing it started is left. A failure of the test itself keeps its status.
leftovers() {
  [ -z "$KEEP" ] || return 0
  for g in $PANE_GROUPS; do
    pgrep -g "$g" >/dev/null && { echo "FAIL: processes of pane group $g still run after cleanup:"; ps -o pid,args -g "$g"; return 1; }
  done
  tmux -L "$SOCK" list-sessions >/dev/null 2>&1 && { echo "FAIL: tmux server $SOCK still runs after cleanup"; return 1; }
  pgrep -f "$HOME_DIR/" >/dev/null && { echo "FAIL: processes still name $HOME_DIR after cleanup:"; pgrep -af "$HOME_DIR/"; return 1; }
  [ ! -e "$HOME_DIR" ] || { echo "FAIL: $HOME_DIR not removed after cleanup"; return 1; }
  return 0
}
# Process groups of every agent pane (each harness runs in its own), noted before the crash and before
# cleanup, so a process a pane left behind (a `sleep`, a harness child) is found whatever its command line.
PANE_GROUPS=""
note_panes() {
  for _p in $(tmux -L "$SOCK" list-panes -a -F '#{pane_pid}' 2>/dev/null); do
    PANE_GROUPS="$PANE_GROUPS $(ps -o pgid= -p "$_p" 2>/dev/null | tr -d ' ')"
  done
}
finish() {
  rc=$?
  note_panes
  stam_test_cleanup
  leftovers || rc=1
  exit $rc
}
trap finish EXIT

T=$(date +%s); DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
C="tmc-claude-$T"; O="tmc-opencode-$T"; X="tmc-codex-$T"; P="tmc-paused-$T"; E="tmc-exited-$T"
fail() { echo "FAIL: $1"; "$STAM" ls; exit 1; }
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
count() { "$STAM" events "$1" | grep -c "$2" || true; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
pushes() { count "$1" 'pushed {"mail":true'; }
lost_n() { [ "$(count "$1" ' tmux-lost ')" -ge 1 ]; }
pushed_n() { [ "$(pushes "$1")" -ge "$2" ]; }
pid_gone() { ! kill -0 "$1" 2>/dev/null; }
idle() { "$STAM" wait "$1" --until idle --timeout 60 >/dev/null || { "$STAM" events "$1" | tail -15; fail "$1 not idle"; }; }

"$STAM" spawn "$C" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Tmux crash test agent." "Remember PLUM-$T" >/dev/null
"$STAM" spawn "$P" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Tmux crash test agent." "Remember MOSS-$T" >/dev/null
"$STAM" spawn "$E" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Tmux crash test agent." "Remember REED-$T" >/dev/null
"$STAM" spawn "$O" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" --role "Tmux crash test agent." "Remember FERN-$T" >/dev/null
"$STAM" spawn "$X" --harness codex --model gpt-6-luna --effort low --cwd "$DIR" --role "Tmux crash test agent." >/dev/null
for n in "$C" "$P" "$E" "$O" "$X"; do idle "$n"; done
note_panes

echo "-- before the crash: one agent's harness exits, one is paused, the others get mail"
EID=$(field "$E" id)
pkill -TERM -g "$(tmux -L "$SOCK" list-panes -t "=$EID:" -F '#{pane_pid}')"
"$STAM" wait "$E" --until shut_down --timeout 20 >/dev/null || fail "$E did not shut down"
"$STAM" pause "$P" >/dev/null
for n in "$O" "$X"; do
  "$STAM" mail send --to "$n" --subject "before-$n" "ping" >/dev/null
  wait_until pushed_n "$n" 1
  idle "$n"
  test "$(pushes "$n")" = 1 || fail "$n: $(pushes "$n") mail pushes before the crash"
done

echo "-- the tmux server dies under the running daemon: it notices on its own, no restart"
DPID=$(cat "$STAM_HOME/daemon.pid")
note_panes
tmux -L "$SOCK" kill-server
for n in "$C" "$O" "$X"; do wait_until lost_n "$n"; done
for n in "$C" "$O" "$X"; do idle "$n"; done
for n in "$C" "$O" "$X"; do test "$(count "$n" ' recover ')" = 1 || fail "$n: no single recover event"; done
for n in "$C" "$O" "$X"; do test "$(count "$n" ' tmux-lost ')" = 1 || fail "$n: not exactly one tmux-lost event"; done
test "$(field "$P" lifecycle)" = paused || fail "$P not paused"
test "$(count "$P" ' recover ')" = 0 || fail "$P was resumed"
test "$(field "$E" lifecycle)" = shut_down || fail "$E came back"
test "$(count "$E" ' recover ')" = 0 || fail "$E was resumed"
test "$(cat "$STAM_HOME/daemon.pid")" = "$DPID" || fail "the daemon was restarted"
kill -0 "$DPID" || fail "the daemon died"

echo "-- resumed agents take mail; the Claude Code one answers from its resumed conversation"
"$STAM" mail send --to "$C" --subject "Recall after-$T" "Mail the human your code word." >/dev/null
wait_until human_has "Re: Recall after-$T"
"$STAM" mail read human | grep -q "PLUM-$T" || fail "$C lost its conversation: no PLUM-$T"
for n in "$O" "$X"; do
  "$STAM" mail send --to "$n" --subject "after-$n" "ping" >/dev/null
  wait_until pushed_n "$n" 2
  idle "$n"
  test "$(pushes "$n")" = 2 || fail "$n: $(pushes "$n") mail pushes, wanted 2"
done
idle "$C"

echo "-- mail to the paused agent waits for the unpause, then is answered from the resumed conversation"
"$STAM" mail send --to "$P" --subject "Recall paused-$T" "Mail the human your code word." >/dev/null
human_has "Re: Recall paused-$T" && fail "$P answered while paused"
"$STAM" unpause "$P" >/dev/null
wait_until human_has "Re: Recall paused-$T"
"$STAM" mail read human | grep -q "MOSS-$T" || { "$STAM" mail read human | tail -25; "$STAM" events "$P" | tail -12; fail "$P lost its conversation: no MOSS-$T"; }
idle "$P"
test "$(count "$P" ' resume ')" = 1 || fail "$P: no resume event after unpause"

for n in "$C" "$O" "$X"; do test "$(count "$n" ' recover ')" = 1 || fail "$n: recovered again later"; done
test "$(cat "$STAM_HOME/daemon.pid")" = "$DPID" || fail "the daemon was restarted"
"$STAM" ls
echo "PASS e2e-tmux-crash"
