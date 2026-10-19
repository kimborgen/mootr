#!/bin/sh
# Running agents pick up new MCP tools after a deploy (S-178), free: a Claude Code agent on
# the scripted fake starts on release A, where a probe tool doesn't exist. Release B adds it;
# `current` moves to B and the daemon restarts from it, as a deploy does. Without restarting
# the agent, its `stam mcp` (still running from A) loads B's tools and sends
# tools/list_changed, the fake lists again, and the agent gets one notice naming the tool,
# on which it calls it. Releases are copies of this checkout under the test's home.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/script.json" <<'EOF'
{ "turns": [
  { "match": "start", "steps": [
    { "mcp": "release_b_probe", "expect": "No such tool" },
    { "reply": "READY" } ] },
  { "match": "release_b_probe", "steps": [
    { "mcp": "whoami" },
    { "mcp": "release_b_probe", "expect": "probe ok" },
    { "reply": "PROBED" } ] } ] }
EOF
fake_claude "$TEST_TMP/script.json"
daemon_home main
use main
fail() { echo "FAIL: $*"; tail -20 "$STAM_HOME/daemon.log" 2>/dev/null; exit 1; }

R="$STAM_HOME/releases"
mkdir -p "$R/A"
(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf - 2>/dev/null) | tar -xf - -C "$R/A"
cp -a "$ROOT/node_modules" "$R/A/"
cp -a "$R/A" "$R/B"
sed -i "s|^export const tools: Tool\[\] = \[|&\n  { name: 'release_b_probe', group: 'agents', description: 'Added in release B.', inputSchema: { type: 'object', properties: {} }, run: async () => text('probe ok') },|" "$R/B/src/mcp.ts"
grep -q release_b_probe "$R/B/src/mcp.ts" || fail "release B has no probe tool"
ln -s A "$R/current"
STAM="$R/current/bin/stam"
daemon_up main

echo "== an agent on release A"
NAME="e2e-mcp-tools-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "start" >/dev/null
"$STAM" wait "$NAME" --until idle --timeout 60
"$STAM" show "$NAME" | grep -q READY || fail "release A's turn didn't end READY: $("$STAM" show "$NAME" | grep last_message)"

echo "== deploy B: current moves, the daemon restarts from it"
ln -sfn B "$R/current"
daemon_stop main
daemon_up main
probed() { "$STAM" show "$NAME" | grep -q PROBED; }
wait_until probed
"$STAM" events "$NAME" | grep -q "mcp-tools:changed" || fail "no mcp-tools:changed event"
grep -q release_b_probe "$STAM_HOME/mcp-tools.json" || fail "the daemon didn't record B's tools"

"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 10
"$STAM" forget "$NAME" >/dev/null
echo "PASS e2e-mcp-tools"
