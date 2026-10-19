#!/bin/sh
# Codex adapter end-to-end test against a live Codex agent on GPT-6-Luna.
# Checks: idle after launch, working -> idle on a mail pushed through the app-server,
# a half-typed draft surviving that push, a reply to the human inbox, bypass mode with
# a restart, a notice during a turn, context size, compaction with instructions, MCP
# reconnect, and shutdown (no app-server left behind) and resume.
# Runs against its own daemon (test/lib.sh). Costs a few cents.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
SOCKET="$STAM_TMUX_SOCKET"
T=$(date +%s)
A="e2e-cx-$T"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
MODEL="${MODEL:-gpt-6-luna}"
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
wait_human() { for i in $(seq 1 40); do human_has "$1" && return 0; sleep 3; done; echo "FAIL: no mail '$1' in the human inbox"; exit 1; }
fail() { echo "FAIL: $1"; exit 1; }

"$STAM" spawn "$A" --harness codex --model "$MODEL" --effort low --cwd "$DIR" --role "Test agent."
"$STAM" wait "$A" --until idle --timeout 60
ID=$("$STAM" show "$A" | grep '"id"' | cut -d'"' -f4)

# A mail to the idle agent starts a turn without typing: a draft in its input survives.
tmux -L "$SOCKET" send-keys -t "=$ID:" -l "draft-$T"
"$STAM" mail send --to "$A" --subject "Ping" "Mail human with subject 'pong-$T' and body 'hello'."
"$STAM" wait "$A" --until working --timeout 30
"$STAM" wait "$A" --until idle --timeout 90
wait_human "pong-$T"
tmux -L "$SOCKET" capture-pane -p -t "=$ID:" | grep -q "draft-$T" || fail "draft lost"
tmux -L "$SOCKET" send-keys -t "=$ID:" C-u
"$STAM" events "$A" | grep -q 'codex:subscribed.*"approvalsReviewer":"auto_review"' || fail "auto mode not applied"

# Bypass mode, as the web UI sets it: the agent restarts with no approvals and no sandbox.
URL="$STAM_URL"
TOKEN=$(cat "$STAM_HOME/token")
curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"mode":"bypass"}' "$URL/api/agents/$ID/permission-mode" >/dev/null
for i in $(seq 1 20); do "$STAM" events "$A" | grep -q 'codex:subscribed.*"approvalPolicy":"never"' && break; sleep 3; done
"$STAM" events "$A" | grep -q 'codex:subscribed.*"approvalPolicy":"never"' || fail "bypass mode not applied"
"$STAM" wait "$A" --until idle --timeout 90

# A mail during a turn arrives as a notice after a tool call.
"$STAM" mail send --to "$A" --subject "Slow task" "Run the shell command 'sleep 3' four times, as four separate shell tool calls one after another, then mail human the word done with subject 'slow-$T'."
"$STAM" wait "$A" --until working --timeout 30
sleep 5
"$STAM" mail send --to "$A" --subject "Extra" "In your mail about the slow task, include the word KIWI-$T."
"$STAM" wait "$A" --until idle --timeout 150
"$STAM" events "$A" | grep -q 'mail:notice' || fail "no in-turn notice"
wait_human "slow-$T"
"$STAM" mail read human | grep -q "KIWI-$T" || fail "notice not acted on"
"$STAM" show "$A" | grep -q '"context_tokens": [0-9]' || fail "no context size"

# Compaction keeps what the instructions ask for; MCP reconnect needs no restart.
"$STAM" compact "$A" "Keep the code word MANGO-$T." | grep -q done || fail "compaction"
"$STAM" events "$A" | grep -q 'codex:compacted' || fail "no compaction event"
"$STAM" reconnect-mcp "$A" | grep -q reconnected || fail "MCP reconnect"

# Shutdown leaves no Codex process behind; resume continues the conversation.
"$STAM" shutdown "$A" >/dev/null
sleep 2
pgrep -f "agents/$ID/codex.sock" >/dev/null && fail "Codex still running after shutdown"
"$STAM" resume "$A" >/dev/null
"$STAM" wait "$A" --until idle --timeout 90
"$STAM" mail send --to "$A" --subject "Memory" "Mail human the code word you were told to keep when compacting, with subject 'mem-$T'."
wait_human "mem-$T"
"$STAM" mail read human | grep -q "MANGO-$T" || fail "compaction lost the code word"

echo "PASS e2e-codex"
