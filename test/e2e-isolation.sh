#!/bin/sh
# The test helper (test/lib.sh) itself, free (no agents): variables inherited from a
# parent stam agent or the live daemon don't leak in; two isolated daemons answer as
# themselves on their own ports, homes, and tmux sockets, with no peers;
# and cleanup leaves no daemon, tmux server, OpenCode server, or folder behind.
set -e
if [ "$1" = --child ]; then
  # Pretend to run inside a live stam agent.
  export STAM_URL=http://127.0.0.1:7878 MOOTR_URL=http://127.0.0.1:7878 STAM_PORT=7878 MOOTR_PORT=7878 STAM_TOKEN=leaked MOOTR_TOKEN=leaked STAM_AGENT_ID=aleak MOOTR_AGENT_ID=aleak STAM_HOME="$HOME/.local/share/stam" MOOTR_HOME="$HOME/.local/share/stam" STAM_TMUX_SOCKET=stam MOOTR_TMUX_SOCKET=stam
  . "$(dirname "$(readlink -f "$0")")/lib.sh"
  fail() { echo "FAIL: $1"; exit 1; }
  [ -z "$STAM_AGENT_ID" ] && [ -z "$STAM_TOKEN" ] || fail "inherited agent variables kept"
  [ -z "$MOOTR_HOME" ] && [ -z "$MOOTR_TOKEN" ] || fail "inherited MOOTR_ variables kept"
  # The folder names its owner, the calling agent, and its owner file says so.
  case "$TEST_TMP" in "$STAM_TEST_TMPDIR"/stam-test.aleak.*) ;; *) fail "folder $TEST_TMP doesn't name its owner" ;; esac
  grep -qx "agent=aleak" "$TEST_TMP/owner" && grep -qx "pid=$$" "$TEST_TMP/owner" || fail "owner file: $(cat "$TEST_TMP/owner")"
  isolate
  daemon_home twin
  daemon_up twin
  case "$STAM_URL" in *:7878) fail "main daemon on the live port" ;; esac
  [ "$STAM_TMUX_SOCKET" != stam ] && [ "$STAM_HOME" != "$HOME/.local/share/stam" ] || fail "live socket or home"
  [ "$MOOTR_HOME" = "$STAM_HOME" ] && [ "$MOOTR_PORT" = "$STAM_PORT" ] && [ "$MOOTR_MACHINE" = "$STAM_MACHINE" ] || fail "the MOOTR_ twins differ from the STAM_ names"
  "$STAM" daemon status | grep -q "machine: 'main'" || fail "main daemon"
  on twin "$STAM" daemon status | grep -q "machine: 'twin'" || fail "twin daemon"
  TWIN_URL=$(on twin sh -c 'echo $STAM_URL')
  [ "$TWIN_URL" != "$STAM_URL" ] || fail "same port twice"
  grep -q '"peers": \[\]' "$STAM_HOME/settings.json" || fail "test settings have peers"
  curl -sf -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/agents" | grep -q '^\[\]$' || fail "main daemon has agents"
  # OpenCode's server for this daemon runs on its own port with its own data folder.
  for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$STAM_OPENCODE_PORT/" && break; sleep 0.5; done
  tmux -L "$STAM_TMUX_SOCKET" has-session -t =_opencode 2>/dev/null || fail "no OpenCode server in the test tmux"
  printf '%s\n%s\n%s\n%s\n' "$TEST_TMP" "$STAM_PORT" "$STAM_TMUX_SOCKET" "$STAM_OPENCODE_PORT" >"$2"
  echo "PASS e2e-isolation (child)"
  exit 0
fi

OUT="$(mktemp "${TMPDIR:-/tmp}/stam-isolation-out.XXXXXX")"
# Removed on every way out, a failed check included (S-668).
trap 'rm -f "$OUT"' EXIT
trap 'exit 130' INT TERM HUP
sh "$(readlink -f "$0")" --child "$OUT"
{ read -r tmp; read -r port; read -r sock; read -r ocport; } <"$OUT"
rm -f "$OUT"
fail() { echo "FAIL: $1"; exit 1; }
[ ! -e "$tmp" ] || fail "temp folder $tmp left behind"
curl -s -m 2 "http://127.0.0.1:$port/api/health" >/dev/null && fail "daemon still answering on $port"
curl -s -m 2 "http://127.0.0.1:$ocport/" >/dev/null && fail "OpenCode server still answering on $ocport"
tmux -L "$sock" ls >/dev/null 2>&1 && fail "tmux server $sock still running"
[ ! -e "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$sock" ] || fail "tmux socket $sock left behind"
pgrep -f "$tmp" >/dev/null && fail "processes left: $(pgrep -af "$tmp")"
echo "PASS e2e-isolation"
