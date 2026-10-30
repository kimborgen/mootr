#!/bin/sh
# Milestone 2 end to end, free: two Claude Code agents on the scripted fake (test/fake-claude,
# no model). Checks: a push to an idle agent, agent-to-agent mail (A asks B by send_mail, B
# answers, A mails the human), the reply in the human inbox, a half-typed draft in B's input
# surviving the push, and a mail during a turn arriving as an in-turn notice (mail:notice)
# after a tool call, which A then reads and mails on.
# Runs against its own daemon (test/lib.sh). The turns are in the script below; nothing waits
# on a timer except bounded checks of state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/m2.json" <<'EOF'
{ "turns": [
  { "match": "/Ask (\\S+)/", "steps": [
    { "mcp": "read_mail", "expect": "by mail" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["${1}"], "subject": "fruit question", "body": "Question from ${self}: what is the team's favorite fruit this week?" } },
    { "reply": "Asked." } ] },
  { "match": "fruit question", "steps": [
    { "mcp": "read_mail", "save": { "asker": "\\(([a-z0-9]+)\\)" }, "expect": "favorite fruit" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["${asker}"], "subject": "fruit answer", "body": "The team's favorite fruit this week is DURIAN." } },
    { "reply": "Answered." } ] },
  { "match": "fruit answer", "steps": [
    { "mcp": "read_mail", "expect": "DURIAN" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "fruit", "new_thread": true, "body": "${result}" } },
    { "reply": "Mailed the human." } ] },
  { "match": "Slow task", "steps": [
    { "mcp": "read_mail", "expect": "sleep 3" },
    { "tool": "Bash", "input": { "command": "sleep 3" }, "output": "" },
    { "await": "gate-m2" },
    { "tool": "Bash", "input": { "command": "sleep 3" }, "output": "" },
    { "mcp": "read_mail", "expect": "KIWI" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "slow", "new_thread": true, "body": "${result}" } },
    { "reply": "Mailed the human." } ] }
] }
EOF
fake_claude "$TEST_TMP/m2.json"
isolate
T=$(date +%s)
A="e2e-a-$T"; B="e2e-b-$T"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
id() { "$STAM" show "$1" | grep '"id"' | cut -d'"' -f4; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
pane() { tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -t "=$(id "$1"):"; }

"$STAM" spawn "$B" --harness claude --model claude-haiku-5-5 --cwd "$DIR" --role "Fruit expert. Knows that the team's favorite fruit this week is DURIAN."
"$STAM" spawn "$A" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Test agent."
"$STAM" wait "$A" --until idle --timeout 60
"$STAM" wait "$B" --until idle --timeout 60

# A half-typed draft in B's input box must survive the push.
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$B"):" -l "draft-m2"

"$STAM" mail send --to "$A" --subject "Ask $B" "Ask the agent $B by mail what the team's favorite fruit is this week. When it answers, mail the fruit to human with subject 'fruit'."
# The reply reaches the human inbox after B's answer; no state marks that moment, so check a bounded number of times.
for i in $(seq 1 60); do human_has "fruit" && break; sleep 0.5; done
human_has "fruit" || { echo "FAIL: no reply in the human inbox"; exit 1; }
"$STAM" mail read human | grep -q "DURIAN" || { echo "FAIL: wrong fruit"; exit 1; }
"$STAM" wait "$B" --until idle --timeout 60
# The redraw of the idle input line follows B's Stop, so check a bounded number of times.
for i in $(seq 1 20); do pane "$B" | grep -q "draft-m2" && break; sleep 0.5; done
pane "$B" | grep -q "draft-m2" || { echo "FAIL: draft lost"; exit 1; }

# A mail during a turn arrives as a notice after a tool call. The mail goes once the turn holds
# at its await (the fake prints "waiting for input" there): sent while A is merely working, it
# could land before the turn's read_mail, which would read it, leaving no notice due (S-4480).
"$STAM" mail send --to "$A" --subject "Slow task" "Run the Bash command 'sleep 3', then wait for the next message, then mail human the result with subject 'slow'."
"$STAM" wait "$A" --until working --timeout 60
for i in $(seq 1 60); do pane "$A" | grep -q "waiting for input" && break; sleep 0.5; done
pane "$A" | grep -q "waiting for input" || { echo "FAIL: slow task never reached its await"; exit 1; }
"$STAM" mail send --to "$A" --subject "Extra" "In your mail about the slow task, include the word KIWI."
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$A"):" -l "gate-m2"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(id "$A"):" Enter
"$STAM" wait "$A" --until idle --timeout 60
"$STAM" events "$A" | grep -q 'mail:notice' || { echo "FAIL: no in-turn notice"; exit 1; }
human_has "slow" || { echo "FAIL: notice not acted on"; exit 1; }
"$STAM" mail read human | grep -q "KIWI" || { echo "FAIL: notice content not in the reply"; exit 1; }

echo "PASS e2e-m2"
