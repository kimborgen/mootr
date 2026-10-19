#!/bin/sh
# Waits Claude Code creates, on the scripted fake (test/fake-claude, no model, free): a turn
# that ends with a background job and a one-shot cron in its Stop payload makes the agent
# 'waiting' with a job and a timer wait (source 'hook'). The job ends: Claude Code's
# <task-notification> prompt starts a turn, typed into the pane, and the job's wait clears
# while the timer's remains. The timer fires: a typed 'woke' prompt, whose turn stops with
# nothing open, so the agent is idle with no waits.
# Runs against its own daemon (test/lib.sh). Nothing sleeps for a job or a timer; the checks
# poll the agent's state, bounded.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/waits-claude.json" <<'EOF'
{ "turns": [
  { "match": "waits test", "steps": [
    { "reply": "Started the job and the timer." },
    { "stop": {
        "background_tasks": [ { "id": "bash-job-1", "type": "shell", "status": "running", "description": "sleep 20" } ],
        "session_crons": [ { "id": "cron-1", "schedule": "30 14 * *", "recurring": false, "prompt": "woke" } ] } } ] },
  { "match": "task-notification", "steps": [
    { "reply": "The job finished." },
    { "stop": { "session_crons": [ { "id": "cron-1", "schedule": "30 14 * *", "recurring": false, "prompt": "woke" } ] } } ] },
  { "match": "woke", "steps": [
    { "reply": "Woke up." } ] }
] }
EOF
fake_claude "$TEST_TMP/waits-claude.json"
isolate
N="e2e-waits-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
# The agent's own id is the first "id" in `show` (its waits carry ids too).
id() { "$STAM" show "$1" | grep '"id"' | head -1 | cut -d'"' -f4; }
waits() { "$STAM" show "$N" 2>/dev/null | python3 -c "
import json,sys
a=json.load(sys.stdin)
print(a['activity'], ' '.join(sorted(w['kind']+':'+w['source'] for w in a.get('waits') or [])))"; }
# Polls until the agent's activity and waits read exactly $1 (bounded: 40 checks, half a second apart).
until_waits() {
  for i in $(seq 1 40); do [ "$(waits)" = "$1" ] && return 0; sleep 0.5; done
  echo "FAIL: expected '$1', got '$(waits)'"; "$STAM" events "$N" | tail -20; exit 1
}

"$STAM" spawn "$N" --harness claude --model claude-haiku-5-5 --cwd "$DIR" --role "Waits test agent." "Begin the waits test."

echo "-- the turn ends with a background job and a timer: waiting, with both hook waits"
until_waits "waiting job:hook timer:hook"

echo "-- the job ends: Claude Code's notification prompt is typed in; the job's wait clears, the timer's remains"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$N"):" -l "<task-notification><task-id>bash-job-1</task-id><status>completed</status><summary>Background command \"sleep 20\" completed</summary></task-notification>"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$N"):" Enter
until_waits "waiting timer:hook"

echo "-- the timer fires: its prompt is typed in; the turn stops with nothing open: idle, no waits"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$N"):" -l "woke"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$N"):" Enter
until_waits "idle "

echo "PASS e2e-waits-claude"
