#!/bin/sh
# S-349, free: the banners tick makes one tmux call for all agents, and captures a pane only after its window had output
# or its front pane changed. A throwaway daemon starts with 200 archived agents and 30 idle Claude Code agents whose
# terminals (plain tmux sessions) stay quiet, plus a few that show menus. A tmux wrapper on the daemon's PATH logs every
# tmux call. Each quiet pane is captured once; over the next ticks no tmux call names one. Then, each dismissed:
# a menu shown later; a menu configured later on a pane that showed it all along; a menu in a pane brought to the
# front. A session replaced while its capture is in flight gets no keys meant for the old one. Last, an agent that
# works while its capture is in flight, then goes idle with no new output, still has its menu dismissed.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
ARCHIVED=200 LIVE=30
MENU_TEXT='Teach auto mode about your environment?'
daemon_home banners
SEED="$TEST_TMP/seed-banners.mjs"
cat >"$SEED" <<'JS'
const db = await import(process.env.ROOT + '/src/db.ts');
db.open();
const agent = (id, lifecycle) => {
  db.createAgent({ id, name: id, role: 'dev', machine: 'banners', harness: 'claude', model: null, effort: null, cwd: '/tmp', parent_id: null, session_id: null });
  db.updateAgent(id, { lifecycle, activity: 'idle', workspace: '/tmp' });
};
if (process.env.ACT) db.updateAgent(process.env.ONE, { activity: process.env.ACT });
else if (process.env.ONE) agent(process.env.ONE, 'active');
else {
  for (let i = 0; i < Number(process.env.ARCHIVED); i++) agent(`arch-${i}`, 'archived');
  for (let i = 0; i < Number(process.env.LIVE); i++) agent(`live-${i}`, 'active');
  for (const id of ['menu-1', 'theme-1', 'win-1']) agent(id, 'active');
}
JS
ROOT="$ROOT" ARCHIVED=$ARCHIVED LIVE=$LIVE STAM_HOME="$TEST_TMP/banners" node "$SEED"
# The wrapper logs each tmux call. While the hold file exists, a capture reads the screen, says so (the started file),
# and answers only once the hold file is gone: a slow tmux, for a session replaced in between.
REAL_TMUX=$(command -v tmux)
WRAP="$TEST_TMP/tmux-wrap"; mkdir -p "$WRAP"; LOG="$TEST_TMP/tmux-calls.log"
SHOW="$TEST_TMP/show-menu" HOLD="$TEST_TMP/hold" STARTED="$TEST_TMP/started" KEYS="$TEST_TMP/keys"
cat >"$WRAP/tmux" <<'SH'
#!/bin/sh
echo "$*" >>"@LOG@"
case "$*" in *capture-pane*)
  if [ -e "@HOLD@" ]; then
    out=$("@TMUX@" "$@"); touch "@STARTED@"
    while [ -e "@HOLD@" ]; do sleep 0.1; done
    printf '%s\n' "$out"; exit 0
  fi ;;
esac
exec "@TMUX@" "$@"
SH
sed -i "s|@LOG@|$LOG|; s|@HOLD@|$HOLD|g; s|@STARTED@|$STARTED|; s|@TMUX@|$REAL_TMUX|g" "$WRAP/tmux"
chmod +x "$WRAP/tmux"
use banners
t() { tmux -L "$STAM_TMUX_SOCKET" "$@"; }
# The terminals exist before the daemon starts, so its first reconcile finds them running.
i=0; while [ $i -lt $LIVE ]; do t new-session -d -s "live-$i" 'sleep 600'; i=$((i + 1)); done
t new-session -d -s menu-1 "while [ ! -e '$SHOW' ]; do sleep 0.2; done; echo '$MENU_TEXT'; exec cat"
t new-session -d -s theme-1 "echo 'Pick a theme'; exec cat"
# win-1's window has two panes; the menu will show in the one behind.
t new-session -d -s win-1 'exec cat'
t split-window -t =win-1: 'exec cat'
PATH="$WRAP:$PATH" daemon_up banners
events_has() { "$STAM" events "$1" | grep -q "$2"; }
dismissed() { events_has "$1" 'banner:dismissed'; }
captures() { grep -c "capture-pane -p -t %" "$LOG" || true; }
# Every quiet pane, win-1's front one, and theme-1 looked at once: 32 captures.
# Each pane once: a pane captured twice must not count for the one not yet looked at.
looked() { test "$(grep -o "capture-pane -p -t %[0-9]*" "$LOG" | sort -u | wc -l)" -ge $((LIVE + 2)); }
wait_until looked
# From here, three more batched calls (at most two of them reconcile's) span a banners tick, and no tmux call may name
# or capture a quiet agent's pane. (At start the daemon sizes every window once.)
from=$(($(wc -l <"$LOG") + 1))
ticks() { grep -c 'list-panes -a' "$LOG" || true; }
seen=$(ticks)
more() { test "$(ticks)" -ge $((seen + 3)); }
wait_until more
# The stagger (banner-stagger.ts) may still be looking at the last panes, so a capture of a pane's first look is fine.
# A capture of a pane already looked at before this window is not.
before=$(head -n $((from - 1)) "$LOG" | grep -o 'capture-pane -p -t %[0-9]*' | sort -u)
calls=$(tail -n +"$from" "$LOG" | grep -o 'capture-pane -p -t %[0-9]*' | grep -cxF "$before" || true)
test "$calls" = 0 || { echo "FAIL: $calls captures of panes already looked at"; exit 1; }
test "$(tail -n +"$from" "$LOG" | grep -c 'live-' || true)" = 0 || { echo "FAIL: tmux calls named quiet panes after their first look"; exit 1; }
test "$(grep -c 'arch-' "$LOG" || true)" = 0 || { echo "FAIL: tmux calls for archived agents"; exit 1; }
dismissed win-1 && { echo "FAIL: win-1's menu was dismissed while behind another window"; exit 1; }
dismissed theme-1 && { echo "FAIL: theme-1 dismissed before its banner was configured"; exit 1; }
# New output on a pane that was looked at: the menu shows, and the next tick dismisses it.
touch "$SHOW"
wait_until dismissed menu-1
# A banner added to the settings, on a pane with no new output.
node -e 'const fs = require("fs"); const f = process.argv[1]; const s = JSON.parse(fs.readFileSync(f, "utf8"));
s.banners = [{ harness: "claude", match: "Teach auto mode about your environment\\?", keys: ["Escape"] }, { harness: "claude", match: "Pick a theme", keys: ["Escape"] }];
fs.writeFileSync(f, JSON.stringify(s, null, 2))' "$STAM_HOME/settings.json"
wait_until dismissed theme-1
# The menu shows in win-1's back pane, so the window had output. Once the front pane was looked at after that, the
# back pane comes to the front: tmux keeps the window's #{window_activity} as it was, and only the front pane changed.
t send-keys -t =win-1:0.0 "$MENU_TEXT" Enter
c=$(captures)
relooked() { test "$(captures)" -gt "$c"; }
wait_until relooked
seen=$(ticks)
wait_until more
dismissed win-1 && { echo "FAIL: win-1's menu was dismissed while behind another pane"; exit 1; }
t select-pane -t =win-1:0.0
wait_until dismissed win-1
# menu-2 shows the menu; its capture is held, the session is replaced by one that records its keys, then the capture
# answers with the old screen. The keys must not reach the new session.
touch "$HOLD"
t new-session -d -s menu-2 "echo '$MENU_TEXT'; exec cat"
ROOT="$ROOT" ONE=menu-2 STAM_HOME="$TEST_TMP/banners" node "$SEED"
held() { test -e "$STARTED"; }
wait_until held
t kill-session -t =menu-2
: >"$KEYS"
t new-session -d -s menu-2 "stty raw -echo; exec cat >'$KEYS'"
rm "$HOLD"
seen=$(ticks)
wait_until more
test ! -s "$KEYS" || { echo "FAIL: keys for the replaced session reached the new one: $(od -c "$KEYS" | head -2)"; exit 1; }
dismissed menu-2 && { echo "FAIL: menu-2 dismissed though its session was replaced"; exit 1; }
# work-1 shows the menu; while its capture is held it starts working, so that look doesn't count.
rm -f "$STARTED"; touch "$HOLD"
t new-session -d -s work-1 "echo '$MENU_TEXT'; exec cat"
ROOT="$ROOT" ONE=work-1 STAM_HOME="$TEST_TMP/banners" node "$SEED"
wait_until held
ROOT="$ROOT" ONE=work-1 ACT=working STAM_HOME="$TEST_TMP/banners" node "$SEED"
rm "$HOLD"
seen=$(ticks)
wait_until more
dismissed work-1 && { echo "FAIL: work-1 dismissed while working"; exit 1; }
ROOT="$ROOT" ONE=work-1 ACT=idle STAM_HOME="$TEST_TMP/banners" node "$SEED"
wait_until dismissed work-1
echo "PASS"
