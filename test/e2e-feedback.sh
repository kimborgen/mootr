#!/bin/sh
# The feedback tool (S-156) end to end, free: an agent on the scripted fake (test/fake-claude, no
# model) calls the `feedback` MCP tool twice with the same tool and summary. The first call files a
# backlog ITSA under the standing Feedback parent and mails the chief of staff; the second becomes a
# comment on that ITSA. The script checks the tree and the comment through `stam itsa`, and the
# chief of staff's mail through `stam events`. Runs against its own throwaway daemon (test/lib.sh).
# The turn is in the script below; nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/feedback.json" <<'EOF2'
{ "agents": { "e2e-feedback": { "turns": [
  { "match": "file feedback", "steps": [
    { "mcp": "feedback", "expect": "Filed S-", "save": { "key": "Filed (S-[0-9]+)" },
      "args": { "kind": "bug", "summary": "send_mail drops reply_to", "details": "Expected reply_to to join the thread; it started a new one.", "tool": "send_mail" } },
    { "mcp": "feedback", "expect": "Already reported as S-", "args": { "kind": "bug", "summary": "Send mail drops: reply to", "details": "Hit it again on a second mail.", "tool": "send_mail" } },
    { "reply": "${result}" } ] } ] },
  "e2e-feedback-cos": { "turns": [ { "match": "ok", "steps": [ { "reply": "ok" } ] } ] } } }
EOF2
fake_claude "$TEST_TMP/feedback.json"
isolate
NAME="e2e-feedback"
COS="e2e-feedback-cos"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
fail() { echo "FAIL: $1"; exit 1; }

"$STAM" spawn "$COS" --cwd "$DIR" "ok"
"$STAM" wait "$COS" --until idle --timeout 60
"$STAM" cos "$COS" >/dev/null

"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Call the feedback MCP tool (file feedback) for the two reports the script gives you, then reply with the exact text of the second result."
"$STAM" wait "$NAME" --until idle --timeout 60

# The agent went through the MCP tool, not around it.
"$STAM" events "$NAME" | grep -q "mcp__stam__feedback" || fail "the agent never called feedback"

# One report, one Feedback parent: the first call filed it, the second commented on it.
KEY=$("$STAM" itsa ls "send_mail drops reply_to" | awk '{print $1; exit}')
[ -n "$KEY" ] || fail "the report ITSA is missing"
"$STAM" itsa show "$KEY" >"$TEST_TMP/report.json"
python3 - "$TEST_TMP/report.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d['status'] == 'backlog', d['status']
assert d['kind'] == 'feedback-report', d['kind']
assert 'Kind: bug' in d['body'] and 'Tool: send_mail' in d['body'], d['body']
assert any(p['title'] == 'Feedback' for p in d['parent_chain']), d['parent_chain']
print(f"report {d['key']} under {[p['title'] for p in d['parent_chain']]}")
PY
COUNT=$("$STAM" itsa ls "send_mail drops" | grep -c "^S-" || true)
[ "$COUNT" = "1" ] || fail "expected one report for the repeat, found $COUNT"
"$STAM" itsa thread "$KEY" >"$TEST_TMP/thread.txt" 2>&1
grep -q "Reported again by" "$TEST_TMP/thread.txt" || { cat "$TEST_TMP/thread.txt"; fail "the repeat did not land as a comment on $KEY"; }

# The chief of staff got the one mail.
"$STAM" events "$COS" | grep -q "mail:received" || fail "the chief of staff got no mail"

# The agent's reply carried the duplicate's answer back to it.
"$STAM" show "$NAME" | grep -q "Already reported as $KEY" || fail "the agent's reply doesn't mention $KEY"

for a in "$NAME" "$COS"; do
  "$STAM" kill "$a" >/dev/null
  "$STAM" wait "$a" --until shut_down --timeout 20
  "$STAM" forget "$a" >/dev/null
done
echo "PASS e2e-feedback"
