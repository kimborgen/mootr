#!/bin/sh
# stam's own agent view (src/agent-view.ts) with its Claude Code part (src/adapters/claude-view.ts)
# on a fake Claude Code (test/fake-claude): a turn runs a Bash tool then replies, and the view's
# history shows the prompt, the tool part with its output, and the reply. Deterministic: no model.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/claude-view.json" <<'JSON'
{ "turns": [
  { "match": "echo hi", "steps": [
    { "tool": "Bash", "input": { "command": "echo hi" }, "output": "hi" },
    { "reply": "DONE" } ] } ] }
JSON
fake_claude "$TEST_TMP/claude-view.json"
isolate
NAME="e2e-cv-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Run the shell command 'echo hi', then reply with exactly DONE."
"$STAM" wait "$NAME" --until idle --timeout 60
ID=$("$STAM" show "$NAME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
TOKEN=$(cat "$STAM_HOME/token")
curl -s -m 10 -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/$ID/view/history?limit=50" >"$TEST_TMP/history.json"
python3 - "$TEST_TMP/history.json" <<'PY' || { echo "FAIL: the view's history is wrong"; cat "$TEST_TMP/history.json"; exit 1; }
import json, sys
msgs = json.load(open(sys.argv[1]))["messages"]
user = [m for m in msgs if m["role"] == "user"]
assert any("echo hi" in p.get("text", "") for m in user for p in m["parts"]), "no user prompt"
tools = [p for m in msgs for p in m["parts"] if p["type"] == "tool"]
assert any(t["name"] == "Bash" and t["output"] == "hi" and t["status"] == "done" for t in tools), "no Bash tool with its output"
assert any(p["type"] == "text" and p["text"] == "DONE" for m in msgs if m["role"] == "assistant" for p in m["parts"]), "no DONE reply"
PY
echo "PASS e2e-claude-view"
