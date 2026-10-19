#!/bin/sh
# Terminal size, free: a real-terminal `stam attach` must not change the size of a window
# that a web viewer is attached to, and with no web viewer it fits its own terminal.
# A web viewer opens the agent's terminal (test/term-web.mjs, as TermSession does); a CLI
# client (test/term-cli.mjs, `stam attach` in a PTY) attaches and types. Covered: a first
# viewer with no size (0x0) takes the default size; with a web viewer, the window stays at
# the web size, and a window made later is manual too; with no web
# viewer a new attach fits its 80x24 terminal; and after the daemon crashes with a web
# viewer attached, the restarted daemon resets the window so the attach fits again.
# Runs against its own daemon and tmux socket (test/lib.sh); the test waits on state.
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/size.json" <<'EOF2'
{ "turns": [
  { "match": "say hi", "steps": [ { "reply": "DONE" } ] } ] }
EOF2
fake_claude "$TEST_TMP/size.json"
isolate
"$STAM" spawn worker --cwd "$TEST_TMP" "Say hi, then reply with exactly DONE."
"$STAM" wait worker --until idle --timeout 60
ID=$("$STAM" show worker | grep '"id"' | head -1 | cut -d'"' -f4)
[ -n "$ID" ] || { echo "FAIL: no agent id"; exit 1; }
SOCK="$STAM_TMUX_SOCKET"
tm() { tmux -L "$SOCK" "$@"; }
size() { tm display -p -t "=$ID:$1" '#{window_width}x#{window_height}' 2>/dev/null; }
mode() { tm show-options -wAv -t "=$ID:$1" window-size 2>/dev/null; }
clients() { tm list-clients -t "=$ID" 2>/dev/null | wc -l; }
# The window the session shows: the current one, which a CLI attach sizes (window 1 after step 3).
is_size() { [ "$(tm display -p -t "=$ID:" '#{window_width}x#{window_height}')" = "$1" ]; }
is_mode() { [ "$(mode 0)" = "$1" ]; }
clients_ge() { [ "$(clients)" -ge "$1" ]; }
clients_eq() { [ "$(clients)" -eq "$1" ]; }
pane_has() { tm capture-pane -p -t "=$ID:" | grep -q "$1"; }

# 0. A first viewer with no size (0x0) takes the default 100x30, not the session's 200x50.
node "$ROOT/test/term-web.mjs" "$ID" 0 0 >"$TEST_TMP/web0.log" 2>&1 &
WEB0=$!
wait_until grep -q open "$TEST_TMP/web0.log"
wait_until is_size 100x30
kill "$WEB0" 2>/dev/null
wait "$WEB0" 2>/dev/null
wait_until clients_eq 0
echo "PASS: a 0x0 first viewer sizes the window to the default"

# 1. A web viewer opens at 120x40 and the window takes that size, manual.
node "$ROOT/test/term-web.mjs" "$ID" 120 40 >"$TEST_TMP/web.log" 2>&1 &
WEB=$!
wait_until grep -q open "$TEST_TMP/web.log"
wait_until is_size 120x40
wait_until is_mode manual

# 2. A real-terminal CLI attach at 80x24 types a key; the window keeps the web size.
mkfifo "$TEST_TMP/keys"
node "$ROOT/test/term-cli.mjs" "$ID" 80 24 "$STAM" <"$TEST_TMP/keys" >"$TEST_TMP/cli.log" 2>&1 &
CLI=$!
exec 3>"$TEST_TMP/keys"
wait_until clients_ge 2
printf 'zq7k' >&3
wait_until pane_has zq7k
is_size 120x40 || { echo "FAIL: window is $(size 0) with a CLI client at 80x24 typing, want 120x40"; exit 1; }
echo "PASS: web viewer keeps 120x40 with a CLI client attached and typing"

# 3. A window a human makes later, while a web viewer is attached, is manual too.
tm new-window -t "=$ID:"
wait_until test "$(mode 1)" = manual
echo "PASS: a window made later is manual too"

# 4. The daemon crashes with the web viewer attached. The restarted daemon resets the
#    windows, so an attach with no web viewer fits its 80x24 terminal.
exec 3>&-
kill "$CLI" 2>/dev/null
wait "$CLI" 2>/dev/null
dpid=$(cat "$STAM_HOME/daemon.pid")
kill -s KILL "$dpid"
wait_until clients_eq 0
daemon_up main
wait_until is_mode latest
[ -z "$(tm show-hooks -t "$ID" 2>/dev/null | grep window-size)" ] || { echo "FAIL: hook left after restart"; exit 1; }
mkfifo "$TEST_TMP/keys2"
node "$ROOT/test/term-cli.mjs" "$ID" 80 24 "$STAM" <"$TEST_TMP/keys2" >"$TEST_TMP/cli2.log" 2>&1 &
CLI2=$!
exec 4>"$TEST_TMP/keys2"
wait_until clients_eq 1
wait_until is_size 80x24
echo "PASS: after a crash and restart, a CLI attach fits its 80x24 terminal"
exec 4>&-
kill "$CLI2" 2>/dev/null
wait "$CLI2" 2>/dev/null
kill "$WEB" 2>/dev/null
wait "$WEB" 2>/dev/null
