#!/bin/sh
# S-273, free: a reconcile tick makes no tmux call for an archived agent. A throwaway daemon starts with 200 archived
# agents that have workspaces, a tmux server that holds a session of its own, and one active agent with no session.
# A tmux wrapper on the daemon's PATH logs every tmux call. The first reconcile marks the active agent lost, and that
# event is the state that says the first tick is over; by then the log must hold no call for an archived agent.
# S-345: then 30 live agents and one whose pane is dead join. A tick makes one tmux call for all of them: the dead one
# exits, the live ones stay active, and no tmux call names a live agent. A batched call that fails without saying the
# server is gone, or lists no panes while sessions exist, changes no agent.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
ARCHIVED=200
daemon_home quiet
# The archived agents and the marker are seeded before the daemon starts (test-seed.json, read once at startup by a
# test daemon), so the first tick finds them.
node -e '
const agent = (id, lifecycle) => ({ agent: id, create: { machine: "quiet" }, lifecycle, activity: "idle", workspace: "/tmp" });
const agents = [];
for (let i = 0; i < Number(process.argv[1]); i++) agents.push(agent(`arch-${i}`, "archived"));
agents.push(agent("marker-1", "active"));
console.log(JSON.stringify({ agents }));' $ARCHIVED >"$TEST_TMP/quiet/test-seed.json"
# The wrapper logs each tmux call's arguments, then runs the real tmux. While the flag file exists, the next
# list-panes -a fails with an error that isn't "no server", and takes the flag away; the same for the empty flag,
# except that the call succeeds with no output.
REAL_TMUX=$(command -v tmux)
WRAP="$TEST_TMP/tmux-wrap"; mkdir -p "$WRAP"; LOG="$TEST_TMP/tmux-calls.log"; FAIL="$TEST_TMP/fail-once"; EMPTY="$TEST_TMP/empty-once"
cat >"$WRAP/tmux" <<EOF
#!/bin/sh
echo "\$*" >>"$LOG"
case "\$*" in *"list-panes -a"*)
  if [ -e "$FAIL" ]; then rm -f "$FAIL"; echo "lost server reply" >&2; exit 1; fi
  if [ -e "$EMPTY" ]; then rm -f "$EMPTY"; exit 0; fi ;;
esac
exec "$REAL_TMUX" "\$@"
EOF
chmod +x "$WRAP/tmux"
# The seeded home is started by hand (isolate would prepare the home again): the seed is in place before the first tick.
use quiet
PATH="$WRAP:$PATH" daemon_up quiet
# A tmux server with a session of its own, so the daemon's reconcile sees a live server.
on quiet tmux -L "$STAM_TMUX_SOCKET" new-session -d -s keeper 'sleep 600'
events_has() { "$STAM" events "$1" | grep -q "$2"; }
poll() { n=$1; shift; while [ "$n" -gt 0 ]; do "$@" && return 0; n=$((n - 1)); done; return 1; }
poll 400 events_has marker-1 'tmux-lost' || { echo "FAIL: the first reconcile tick never ran"; exit 1; }
calls=$(grep -c 'arch-' "$LOG" || true)
test "$calls" = 0 || { echo "FAIL: $calls tmux calls for archived agents in one reconcile tick"; grep 'arch-' "$LOG" | head -5; exit 1; }
# S-345: live sessions for 30 agents, and one whose harness already exited (its pane stays, dead).
LIVE=30
on quiet tmux -L "$STAM_TMUX_SOCKET" set-option -g remain-on-exit on
i=0; while [ $i -lt $LIVE ]; do on quiet tmux -L "$STAM_TMUX_SOCKET" new-session -d -s "live-$i" 'sleep 600'; i=$((i + 1)); done
on quiet tmux -L "$STAM_TMUX_SOCKET" new-session -d -s gone-1 'true'
# Working, so no other loop (banners, stale turns) looks at their terminals.
node -e '
const agent = (id, activity) => ({ agent: id, create: { machine: "quiet" }, lifecycle: "active", activity, workspace: "/tmp" });
const bodies = [];
for (let i = 0; i < Number(process.argv[1]); i++) bodies.push(agent(`live-${i}`, "working"));
bodies.push(agent("gone-1", "idle"));
for (const b of bodies) console.log(JSON.stringify(b));' $LIVE | while read -r body; do
  curl -sf -X POST -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'content-type: application/json' -d "$body" "$STAM_URL/api/test/agent" >/dev/null
done
wait_until events_has gone-1 ' exited'
# One more whole tick after that: two more batched calls (each tick makes one).
ticks() { grep -c 'list-panes -a' "$LOG" || true; }
seen=$(ticks)
more() { test "$(ticks)" -ge $((seen + 2)); }
wait_until more
calls=$(grep -c 'live-' "$LOG" || true)
test "$calls" = 0 || { echo "FAIL: $calls tmux calls for live agents; reconcile should make one call per tick"; grep 'live-' "$LOG" | head -5; exit 1; }
field() { "$STAM" show "$1" | grep "\"$2\"" | head -1 | sed 's/.*: //; s/^"//; s/",*$//; s/,$//'; }
i=0; while [ $i -lt $LIVE ]; do
  test "$(field "live-$i" lifecycle)" = active || { echo "FAIL: live-$i is $(field "live-$i" lifecycle)"; exit 1; }
  i=$((i + 1))
done
test "$(field gone-1 activity_detail)" = "harness exited" || { echo "FAIL: gone-1: $(field gone-1 activity_detail)"; exit 1; }
# One batched call fails, then one lists nothing; those ticks and the next (which starts once the last bad one is
# over) leave every agent as it was: no tmux-lost, exited, or recover event, and every live agent still active.
for flag in "$FAIL" "$EMPTY"; do
  seen=$(ticks)
  touch "$flag"
  taken() { test ! -e "$flag"; }
  wait_until taken
  wait_until more
done
i=0; while [ $i -lt $LIVE ]; do
  test "$(field "live-$i" lifecycle)" = active || { echo "FAIL: after a bad tmux call live-$i is $(field "live-$i" lifecycle): $(field "live-$i" activity_detail)"; exit 1; }
  "$STAM" events "live-$i" | grep -E ' (tmux-lost|exited|recover)' && { echo "FAIL: a bad tmux call changed live-$i"; exit 1; }
  i=$((i + 1))
done
echo "PASS"
