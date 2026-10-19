# Shared test helper: runs each test against throwaway stam daemons, never the live one.
# Source it from a test (`. "$(dirname "$(readlink -f "$0")")/lib.sh"`), then call
# `isolate`, which starts a daemon with its own home, ports, tmux socket, and machine
# name, and points this shell's STAM_* variables (and so `$STAM`) at it.
#
#   isolate [NAME]      prepare, use, and start one daemon (NAME defaults to main)
#   daemon_home NAME    prepare a daemon's home: settings with no peers, token (and the real
#                       OpenRouter key only when STAM_TEST_REAL_KEY=1, for a live test)
#   daemon_up NAME      start it and wait until it answers
#   use NAME            export its STAM_* variables into this shell
#   on NAME CMD...      run CMD against another daemon, without changing this shell
#   wait_until CMD...   poll CMD until it succeeds (up to 20 s); fail if it never does
#   daemon_stop NAME    stop it and wait until its port is closed
#   fake_claude SCRIPT  Claude Code agents run test/fake-claude with SCRIPT, no model
#                       (docs/testing.md). Every daemon runs the fake by default, so calling it
#                       after `isolate` is safe; a daemon started before it gets no SCRIPT.
#
# On exit every daemon stops, its tmux server and the agents in it are killed, and the
# temporary folder ($TEST_TMP: homes and work folders) is deleted. KEEP=1 keeps them.
# The folder, /tmp/stam-test.OWNER.XXXXXX, names who runs the test (the calling agent's
# STAM_AGENT_ID, or "user"), as do the tmux sockets, and its `owner` file holds that, the
# test shell's PID, and the start time. Cleanup touches only a folder this shell owns;
# never delete another owner's folder, even one that looks left over.
# Before exiting, each daemon prints a line "spend NAME: $X" with its agents' cost today.
# Harness logins stay the user's own (~/.claude, ~/.codex); only stam's state is private.
# STAM_TEST_ROOT overrides the repo root, for a script sourcing this from elsewhere.

ROOT="${STAM_TEST_ROOT:-$(dirname "$(readlink -f "$0")")/..}"
STAM="$ROOT/bin/stam"
LIVE_HOME="$HOME/.local/share/stam"

# Who runs the test, read before the environment is cleaned below: a stam agent's id, or
# "user". It goes into the folder and tmux socket names and an owner file, so agents
# running tests side by side can tell their folders apart and never clean up another's.
STAM_TEST_OWNER=$(printf '%s' "${STAM_AGENT_ID:-user}" | tr -c 'A-Za-z0-9-' '_' | cut -c1-12)

# A test may run inside a stam agent or a Claude Code session: drop everything that
# points at the live daemon or the parent session, so neither the CLI, the test daemon,
# nor the agents it spawns inherit it.
unset STAM_AGENT_ID STAM_AGENT_NAME STAM_URL STAM_TOKEN STAM_USER_STATUSLINE STAM_HOME STAM_PORT \
  STAM_TMUX_SOCKET STAM_MACHINE STAM_BIND STAM_OPENCODE_PORT STAM_AGENTS_SKILLS STAM_CLAUDE_BIN STAM_CODEX_BIN STAM_FAKE_CLAUDE_SCRIPT TMUX TMUX_PANE CLAUDECODE CLAUDE_PID CLAUDE_EFFORT \
  OPENROUTER_API_KEY
# Search by meaning uses the scripted stub embedder in every test daemon (S-141): no model.
export STAM_EMBEDDER=stub
# Enables the test-only cost routes of POST /api/test/cost (src/daemon.ts); only this file sets it.
export STAM_TEST_COST_HOOKS=1
# No test daemon runs the one-time full auto-archive pass (S-637) unless its test sets the delay,
# as e2e-auto-archive-full does. 2^31-1 ms is setTimeout's largest delay; a larger one fires at once.
export STAM_AUTO_ARCHIVE_FULL_DELAY_MS="${STAM_AUTO_ARCHIVE_FULL_DELAY_MS:-2147483647}"
# No test daemon rests an agent for a long wait or idle (S-1982) unless its test opts in, as
# test/rest.test.mjs does; standing agents keep their own rest rule (STAM_STANDING_IDLE_HOURS).
export STAM_REST_ENABLED="${STAM_REST_ENABLED:-0}"
# Claude Code agents run the fake (test/fake-claude) unless this run is a smoke test: run.sh sets
# STAM_TEST_SMOKE for those. It's set here, not per test, so a daemon started before fake_claude
# still spawns the fake, never the real claude (S-176).
[ -n "$STAM_TEST_SMOKE" ] || export STAM_CLAUDE_BIN="$ROOT/test/fake-claude/claude"
# Codex agents run the scripted fake (test/fake-codex) the same way (S-184), so no FREE test reaches
# the real codex, even one that starts a daemon by hand.
[ -n "$STAM_TEST_SMOKE" ] || export STAM_CODEX_BIN="$ROOT/test/fake-codex/codex"
for v in $(env | sed -n 's/^\(CLAUDE_CODE_[A-Z0-9_]*\)=.*/\1/p'); do
  case "$v" in CLAUDE_CODE_OAUTH_TOKEN | CLAUDE_CODE_USE_*) ;; *) unset "$v" ;; esac
done

# Short, under /tmp: Codex's unix sockets live in the home and have a length limit.
. "$ROOT/test/tmpdir.sh"
TEST_TMP="$(mktemp -d "$STAM_TEST_TMPDIR/stam-test.$STAM_TEST_OWNER.XXXXXX")"
printf 'agent=%s\npid=%s\nstarted=%s\n' "$STAM_TEST_OWNER" "$$" "$(date -Is)" >"$TEST_TMP/owner"
# True when this shell created the folder, as its owner file says.
stam_test_owned() { grep -qx "pid=$$" "$TEST_TMP/owner" 2>/dev/null && grep -qx "agent=$STAM_TEST_OWNER" "$TEST_TMP/owner"; }
STAM_TEST_DAEMONS=""
# A run killed hard skips its EXIT trap, and its daemons (setsid, so outside its process group) would live on
# (S-1294): a detached watchdog reaps them once this shell is gone. A clean exit removes the folder first.
[ -n "$KEEP" ] || (setsid sh "$ROOT/test/test-watchdog.sh" "$TEST_TMP" "$$" "$(sed 's/^.*) //' /proc/$$/stat | cut -d' ' -f20)" </dev/null >/dev/null 2>&1 &)

# A free port below the kernel's ephemeral range. Outgoing connections take their local ports
# from that range, so a port picked there can be taken before the daemon binds it, and the CLI
# then fails with "fetch failed" (S-385). Without such a range it falls back to a kernel pick.
free_port() {
  python3 -c '
import random, socket
try:
    lo = int(open("/proc/sys/net/ipv4/ip_local_port_range").read().split()[0])
except Exception:
    lo = 0
for _ in range(200):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", random.randint(10000, lo - 1) if lo > 10000 else 0))
    except OSError:
        continue
    print(s.getsockname()[1])
    break
else:
    raise SystemExit("no free port")
'
}

daemon_home() {
  _h="$TEST_TMP/$1"
  mkdir -p "$_h"
  : >"$_h/.stam-test-home" # the marker src/test-env.ts needs before it honours a STAM_TEST_* var (S-634)
  _p=$(free_port)
  _o=$(free_port)
  while [ "$_o" = "$_p" ]; do _o=$(free_port); done
  cat >"$_h/test.env" <<EOF
export STAM_HOME='$_h' STAM_PORT=$_p STAM_URL=http://127.0.0.1:$_p STAM_TMUX_SOCKET=stam-test-$STAM_TEST_OWNER-${TEST_TMP##*.}-$1 STAM_MACHINE=$1 STAM_BIND=127.0.0.1 STAM_OPENCODE_PORT=$_o STAM_AGENTS_SKILLS='$_h/agents-skills'
EOF
  printf '{ "peers": [] }\n' >"$_h/settings.json"
  # The token exists before the daemon starts, so peers can be wired up front.
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(24))' >"$_h/token")
  # The peer token too (S-1064): only it proves a peer, so daemon_up wires it into the other daemons' peers.
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(24))' >"$_h/peer-token")
  # OpenCode: stam's server for this daemon gets its own data folder (sessions, its DB).
  # The real OpenRouter key (the repo's .env, or the live home's opencode.env) goes in only
  # for a live test, which sets STAM_TEST_REAL_KEY=1: any other daemon would call openrouter.ai
  # at boot (credits.ts reads the key from its home). Stub tests use stub_key instead.
  _env=""
  if [ -n "$STAM_TEST_REAL_KEY" ]; then
    # In a git worktree, .git is a file naming MAIN/.git/worktrees/NAME; the main checkout has the .env.
    for f in "$ROOT/.env" "$(sed -n 's|^gitdir: \(.*\)/\.git/worktrees/.*|\1|p' "$ROOT/.git" 2>/dev/null)/.env"; do
      [ -f "$f" ] && _env=$(grep '^OPENROUTER_API_KEY=' "$f" | head -1) && [ -n "$_env" ] && break
    done
    [ -z "$_env" ] && [ -f "$LIVE_HOME/opencode.env" ] && _env=$(cat "$LIVE_HOME/opencode.env")
  fi
  (umask 077 && {
    [ -n "$_env" ] && printf '%s\n' "$_env"
    printf 'XDG_DATA_HOME=%s\n' "$_h/opencode-data"
  } >"$_h/opencode.env")
  STAM_TEST_DAEMONS="$STAM_TEST_DAEMONS $1"
}

# A made-up key for a stub test (its decisions endpoint is STAM_OPENROUTER_URL, never the
# real one), so the daemon takes the path that reads a key. NAME is the daemon, as daemon_home.
stub_key() {
  (umask 077 && printf 'OPENROUTER_API_KEY=test-key\n' >>"$TEST_TMP/$1/opencode.env")
}

use() {
  . "$TEST_TMP/$1/test.env"
  case "$STAM_HOME" in "$LIVE_HOME" | "$LIVE_HOME"/) echo "FAIL: refusing to use the live home" >&2; exit 1 ;; esac
}

on() {
  _d=$1
  shift
  (use "$_d" && "$@")
}

daemon_up() {
  # Refuse to start a test daemon that would run the real claude: only a smoke test may (S-176).
  if [ -z "$STAM_TEST_SMOKE" ] && [ "$STAM_CLAUDE_BIN" != "$ROOT/test/fake-claude/claude" ]; then
    echo "FAIL: daemon $1 would run the real claude ($STAM_CLAUDE_BIN); only --smoke tests may"
    exit 1
  fi
  # The same for codex (S-184).
  if [ -z "$STAM_TEST_SMOKE" ] && [ "$STAM_CODEX_BIN" != "$ROOT/test/fake-codex/codex" ]; then
    echo "FAIL: daemon $1 would run the real codex ($STAM_CODEX_BIN); only --smoke tests may"
    exit 1
  fi
  python3 "$ROOT/test/wire-peer-tokens.py" "$TEST_TMP" "$1" || true
  on "$1" "$STAM" daemon start >/dev/null || { echo "FAIL: daemon $1 didn't start; see $TEST_TMP/$1/daemon.log"; exit 1; }
  # A daemon starting its adapters can be slow to answer while other tests load the machine.
  for _i in 1 2 3 4 5 6 7 8 9 10; do
    on "$1" "$STAM" daemon status 2>/dev/null | grep -q "machine: '$1'" && return 0
    sleep 1
  done
  echo "FAIL: daemon $1 not answering as itself"
  exit 1
}

# wait_until CMD...: polls CMD (a command or a function of the test) until it succeeds, up to
# 20 s, so a test waits on state, not on the clock. It fails the test if CMD never succeeds.
wait_until() {
  for _i in $(seq 1 100); do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; done
  "$@" >/dev/null 2>&1 && return 0
  echo "FAIL: timed out waiting for: $*"
  exit 1
}

# transcript_said FILE PATTERN: the assistant's text in the JSONL transcript FILE holds PATTERN (grep syntax). Only
# assistant text blocks count, so a prompt or a tool result that holds PATTERN doesn't match.
transcript_said() {
  python3 -c '
import json, sys
for line in open(sys.argv[1]):
  try: row = json.loads(line)
  except ValueError: continue
  if row.get("type") != "assistant": continue
  for block in row["message"]["content"]:
    if block.get("type") == "text": print(block["text"])
' "$1" | grep -qs "$2"
}

# said NAME PATTERN: NAME's transcript holds PATTERN. Its transcript keeps every turn's text, where `show` keeps only the
# last message, which a turn woken by mail the script's own turn sent can replace (S-1302, S-1333).
said() { transcript_said "$("$STAM" show "$1" | grep -m1 '"transcript_path"' | cut -d'"' -f4)" "$2"; }

# agent_token REF: the agent's own token, from its tmux environment (REF is its id or name); it waits for the launch.
agent_token() {
  _aid=$("$STAM" show "$1" 2>/dev/null | grep -m1 '"id"' | cut -d'"' -f4)
  for _i in $(seq 1 40); do
    _t=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$_aid" STAM_TOKEN 2>/dev/null | cut -d= -f2-)
    [ -n "$_t" ] && { echo "$_t"; return 0; }
    sleep 0.25
  done
  return 1
}

# as_agent REF METHOD PATH [BODY]: a request with the agent's own token (the shared token can't name an
# agent that has one, S-545), in the current daemon. REF is the agent's id or name; it waits for the
# launch to put the token in the agent's tmux environment.
as_agent() {
  _atok=$(agent_token "$1")
  _am=$2 _ap=$3
  shift 3
  curl -s -X "$_am" -H "authorization: Bearer $_atok" -H 'content-type: application/json' "$STAM_URL$_ap" ${1:+-d "$1"}
}

# daemon_stop NAME: stops it and waits until its port no longer answers, so a restart doesn't race
# the old process still holding the port.
daemon_stop() {
  on "$1" "$STAM" daemon stop >/dev/null
  _url=$(on "$1" sh -c 'echo "$STAM_URL"')
  _down() { ! curl -s -m 2 -o /dev/null "$_url/"; }
  wait_until _down || { echo "FAIL: daemon $1 still answers after stop"; exit 1; }
}

fake_claude() {
  export STAM_CLAUDE_BIN="$ROOT/test/fake-claude/claude" STAM_FAKE_CLAUDE_SCRIPT="$1"
}

isolate() {
  daemon_home "${1:-main}"
  use "${1:-main}"
  daemon_up "${1:-main}"
}

stam_test_cleanup() {
  set +e
  # The decide stub a test started in the background (STUB_PID): killed by pid on any exit.
  case "${STUB_PID:-}" in '' | *[!0-9]*) ;; *) kill "$STUB_PID" 2>/dev/null ;; esac
  for d in $STAM_TEST_DAEMONS; do
    [ -f "$TEST_TMP/$d/test.env" ] || continue
    (
      use "$d"
      auth="authorization: Bearer $(cat "$STAM_HOME/token")"
      spend=$(curl -s -m 3 -H "$auth" "$STAM_URL/api/usage?days=1" |
        python3 -c 'import json, sys; print(json.load(sys.stdin)["today"]["cost_usd"] or 0)' 2>/dev/null)
      # A test whose dollars are a stub's, not a provider's, sets STAM_TEST_SPEND_STUBBED: run.sh reads the
      # "spend" line, so it reports $0; the ledger keeps the rows and "stubbed spend" shows the figure.
      if [ -n "$STAM_TEST_SPEND_STUBBED" ]; then
        echo "stubbed spend $d: \$${spend:-0}"
        echo "spend $d: \$0"
      else
        echo "spend $d: \$${spend:-0}"
      fi
      [ -n "$KEEP" ] && exit 0
      # Codex's launch script, TUI, and app-server outlive the hangup that killing the
      # tmux server sends: stam kills each agent's process group first, then the daemon
      # stops, and each pane left (such as the OpenCode server) gets its group killed.
      for id in $(curl -s -m 5 -H "$auth" "$STAM_URL/api/agents" |
        python3 -c 'import json, os, sys; [print(a["id"]) for a in json.load(sys.stdin) if a.get("machine") == os.environ["STAM_MACHINE"] and a.get("lifecycle") == "active"]' 2>/dev/null); do
        "$STAM" kill "$id" >/dev/null 2>&1
      done
      "$STAM" daemon stop >/dev/null 2>&1
      # Stop it by PID as well: `daemon stop` can miss (a missing pid file, or a test that
      # was killed hard). Its pid file names the daemon; TERM stops it, KILL finishes.
      dpid=$(cat "$STAM_HOME/daemon.pid" 2>/dev/null)
      case "$dpid" in '' | *[!0-9]*) dpid= ;; esac
      [ -n "$dpid" ] && kill -s TERM "$dpid" 2>/dev/null
      pids=$(tmux -L "$STAM_TMUX_SOCKET" list-panes -a -F '#{pane_pid}' 2>/dev/null)
      tmux -L "$STAM_TMUX_SOCKET" kill-server 2>/dev/null
      # Only real pane pids: `kill -- -1` would signal every process of this user. A group still
      # alive after the wait on TERM gets KILL (a fake agent can outlive it).
      panes=
      for p in $pids; do
        case $p in '' | *[!0-9]* | 0 | 1) continue ;; esac
        panes="$panes $p"
        kill -s TERM -- "-$p" 2>/dev/null
      done
      for _i in 1 2 3 4 5 6 7 8 9 10; do
        alive=
        for p in $panes; do kill -0 "$p" 2>/dev/null && alive=1; done
        [ -z "$alive" ] && break
        sleep 0.2
      done
      for p in $panes; do kill -0 "$p" 2>/dev/null && kill -s KILL -- "-$p" 2>/dev/null; done
      for _i in 1 2 3 4 5 6 7 8 9 10; do
        [ -z "$dpid" ] && break
        kill -0 "$dpid" 2>/dev/null || break
        sleep 0.2
      done
      [ -n "$dpid" ] && kill -s KILL "$dpid" 2>/dev/null
      rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$STAM_TMUX_SOCKET"
    )
  done
  [ -n "$KEEP" ] && { echo "kept $TEST_TMP (daemons still running)"; return; }
  stam_test_owned || { echo "not deleting $TEST_TMP: its owner file names someone else"; return; }
  # A hook for test/e2e-kill-hard.sh: it names a file outside the folder, which cleanup creates here and then holds, so
  # the test can KILL the run at this boundary, after the daemons stop and before the folder goes.
  [ -z "$STAM_TEST_SWEEP_HOLD" ] || { : >"$STAM_TEST_SWEEP_HOLD"; sleep 60; }
  # Anything still naming the folder (a Codex app-server's socket, say) goes last.
  for _i in 1 2 3 4 5; do pgrep -f "$TEST_TMP/" >/dev/null || break; sleep 1; done
  pkill -KILL -f "$TEST_TMP/" 2>/dev/null
  # The watchdog stays until the folder is gone, so a KILL anywhere in this cleanup still gets reaped.
  _wd=$(cat "$TEST_TMP/watchdog.pid" 2>/dev/null)
  rm -rf "$TEST_TMP"
  case "$_wd" in '' | *[!0-9]*) ;; *) kill "$_wd" 2>/dev/null ;; esac
}
trap 'stam_test_cleanup' EXIT
trap 'exit 130' INT TERM HUP
