#!/bin/sh
# Milestone 1 end to end, free: a Claude Code agent on the scripted fake (test/fake-claude,
# no model). Spawns an agent, checks its turn runs (prompt, a tool use, Stop) and leaves it
# idle with a context size and its last message, then kills it.
# Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/m1.json" <<'EOF'
{ "turns": [
  { "match": "echo hi", "steps": [
    { "tool": "Bash", "input": { "command": "echo hi" }, "output": "hi" },
    { "reply": "DONE" } ] } ] }
EOF
fake_claude "$TEST_TMP/m1.json"
isolate
NAME="e2e-m1-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Run the shell command 'echo hi', then reply with exactly DONE."
"$STAM" wait "$NAME" --until idle --timeout 60
EVENTS=$("$STAM" events "$NAME")
for e in UserPromptSubmit PreToolUse PostToolUse Stop; do
  echo "$EVENTS" | grep -q "hook:$e" || { echo "FAIL: no $e event"; exit 1; }
done
"$STAM" show "$NAME" | grep -q '"context_tokens": [0-9]' || { echo "FAIL: no context size"; exit 1; }
"$STAM" show "$NAME" | grep -q 'DONE' || { echo "FAIL: last message isn't DONE"; exit 1; }
"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 10
"$STAM" forget "$NAME" >/dev/null
echo "PASS e2e-m1"
