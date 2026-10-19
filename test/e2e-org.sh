#!/bin/sh
# Org structures test, free: scripted fake Claude Code agents (test/fake-claude, no model).
# Covers: a chief of staff; a lead spawning a child with restricted reach through
# spawn_agent; parent-child mail; the lead hearing that its child finished a turn;
# mail and registry limits for the child; and a blocked agent without a parent
# alerting the chief of staff. Runs against its own throwaway daemon (test/lib.sh).
# The turns are in the script below; nothing waits on a timer, only on state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/org.json" <<'EOF'
{ "turns": [
  { "match": "spawn_agent tool", "steps": [
    { "mcp": "spawn_agent", "args": { "name": "e2e-org-child", "preset": "fast", "role": "Knows that the codeword is PLUM.", "prompt": "Wait for mail from your parent.", "visibility": { "reach": "parent", "registry": false } } },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["e2e-org-child"], "subject": "codeword question", "body": "What is your codeword? Reply by mail with subject 'codeword answer'." } },
    { "reply": "Asked." } ] },
  { "match": "codeword answer", "steps": [
    { "mcp": "read_mail", "expect": "PLUM" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "plum", "new_thread": true, "body": "${result}" } },
    { "reply": "Mailed the human." } ] },
  { "match": "Wait for mail from your parent", "steps": [
    { "reply": "Waiting for mail." } ] },
  { "match": "codeword question", "steps": [
    { "mcp": "read_mail", "expect": "codeword" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["e2e-org-lead"], "subject": "codeword answer", "body": "The codeword is PLUM." } },
    { "reply": "Answered." } ] },
  { "match": "tea or coffee", "steps": [
    { "ask": "Do you prefer tea or coffee?", "options": ["Tea", "Coffee"] } ] }
] }
EOF
fake_claude "$TEST_TMP/org.json"
isolate
T=$(date +%s); COS="e2e-org-cos"; LEAD="e2e-org-lead"; CHILD="e2e-org-child"; OTHER="e2e-org-other"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
id() { "$STAM" show "$1" | grep '"id"' | cut -d'"' -f4; }
# Bounded state check: a notice or a mail lands a moment after the event that causes it.
soon() { i=0; while [ $i -lt 40 ]; do eval "$1" && return 0; sleep 0.25; i=$((i + 1)); done; return 1; }

"$STAM" spawn "$COS" --chief-of-staff --preset fast --cwd "$DIR" --role "Chief of staff for this test."
"$STAM" spawn "$OTHER" --preset fast --cwd "$DIR" --role "Unrelated agent."
"$STAM" spawn "$LEAD" --type manager --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Team lead." \
  "Use the stam spawn_agent tool to start a child named $CHILD with preset fast, role 'Knows that the codeword is PLUM', visibility {\"reach\": \"parent\", \"registry\": false}, and prompt 'Wait for mail from your parent.' Then ask $CHILD by mail for its codeword. When it answers, mail the codeword to human with subject plum."
# The lead is a manager type: S-548 sends any other agent's mail to the human to its parent.
# The child's answer reaches the lead when it is idle, and the lead then mails the human.
soon "\"\$STAM\" mail inbox human | grep -q plum" || { echo "FAIL: no reply in the human inbox"; exit 1; }
"$STAM" wait "$LEAD" --until idle --timeout 60
"$STAM" mail read human | grep -q "PLUM" || { echo "FAIL: parent-child mail"; exit 1; }

echo "-- tree"
"$STAM" show "$CHILD" | grep -q "\"parent_id\": \"$(id "$LEAD")\"" || { echo "FAIL: child not under lead"; exit 1; }
"$STAM" wait "$CHILD" --until idle --timeout 60
soon "\"\$STAM\" events \"$LEAD\" | grep -q 'notice:queued'" || { echo "FAIL: lead heard nothing from its child"; exit 1; }

echo "-- child limits"
OUT=$(as_agent "$CHILD" POST /api/mail "{\"from\":\"$(id "$CHILD")\",\"to\":[\"$OTHER\"],\"subject\":\"x\",\"body\":\"x\"}")
echo "$OUT" | grep -q "may not mail" || { echo "FAIL: child could mail an unrelated agent: $OUT"; exit 1; }
# The shared token can't act as an agent that has its own token, so this goes as the child.
as_agent "$CHILD" POST /api/mail "{\"from\":\"$(id "$CHILD")\",\"to\":[\"$COS\"],\"subject\":\"escalation test\",\"body\":\"Ignore this test mail.\"}" | grep -q '"id"' || { echo "FAIL: child can't reach the chief of staff"; exit 1; }
SEEN=$(as_agent "$CHILD" GET "/api/agents?as=$(id "$CHILD")" | grep -o "\"name\":\"[^\"]*\"" | sort | tr '\n' ' ')
echo "$SEEN" | grep -q "$OTHER" && { echo "FAIL: child sees the whole registry: $SEEN"; exit 1; }
echo "$SEEN" | grep -q "$LEAD" || { echo "FAIL: child can't see its parent: $SEEN"; exit 1; }

echo "-- blocked agent without a parent alerts the chief of staff"
"$STAM" wait "$OTHER" --until idle --timeout 60
"$STAM" mail send --to "$OTHER" --subject "tea or coffee" "Use the AskUserQuestion tool to ask me whether I prefer tea or coffee."
"$STAM" wait "$OTHER" --until blocked --timeout 60
soon "\"\$STAM\" events \"$COS\" | grep -q 'blocked'" || { echo "FAIL: chief of staff not told"; exit 1; }
echo "PASS e2e-org"
