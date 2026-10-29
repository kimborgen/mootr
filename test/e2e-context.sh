#!/bin/sh
# Context management test, free: Claude Code agents on the scripted fake (test/fake-claude, no
# model). A `status` step reports the context size, so the thresholds are crossed at known points.
# Lowers the thresholds in its test daemon's settings.json.
# Covers: a threshold notice; forced compaction at the enforcement threshold, once (the agent is
# still above the tiny thresholds right after compaction, which mustn't compact it again);
# compact_self with instructions and a prompt after; and idle compaction.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer: the checks poll state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# The statusline gate skips a report equal to the last within 10 s (S-2126), so each turn reports a
# size of its own: the thresholds are re-read only when a report is processed.
# The summary of a compaction is the /compact text: the resumed session repeats it as ${summary}.
cat >"$TEST_TMP/context.json" <<'EOF2'
{ "turns": [
  { "match": "Reply with exactly: ready", "steps": [
    { "status": { "context_tokens": 50000, "context_window": 200000 } },
    { "reply": "ready" } ] },
  { "match": "from the human: hello", "steps": [
    { "mcp": "read_mail" },
    { "status": { "context_tokens": 50001 } },
    { "reply": "hello" } ] },
  { "match": "from the human: again", "steps": [
    { "mcp": "read_mail" },
    { "status": { "context_tokens": 50000 } },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "again", "body": "The word again." } },
    { "reply": "Mailed the human." } ] },
  { "match": "from the human: compact", "steps": [
    { "mcp": "read_mail" },
    { "mcp": "compact_self", "args": { "instructions": "Keep the word TULIP", "prompt_after": "Mail human the word you were told to keep, with subject kept" } },
    { "reply": "Asked to compact." } ] },
  { "match": "Mail human the word you were told to keep", "steps": [
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "kept", "new_thread": true, "body": "${summary}" } },
    { "reply": "Mailed the human." } ] }
] }
EOF2
fake_claude "$TEST_TMP/context.json"
isolate
set_settings() { printf '%s\n' "$1" > "$STAM_HOME/settings.json"; }
N="e2e-ctx-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
events_has() { "$STAM" events "$N" | grep -q "$1"; }
# `mail read` returns only unread mail, so each check keeps its read in MAIL.

set_settings '{"context":{"warnTokens":1000,"instructTokens":100000000,"enforceTokens":200000000},"idleCompaction":{"enabled":false}}'
"$STAM" spawn "$N" --harness claude --model claude-sonnet-5-5 --cwd "$DIR" --role "Context test agent." "Reply with exactly: ready"
# No `--until working` wait: the fake's first turn ends in well under the wait's one-second poll,
# so a working state is never seen. The threshold event below is what shows the turn ran.
"$STAM" wait "$N" --until idle --timeout 90

echo "-- warning notice"
poll 60 events_has 'context:threshold' || { echo "FAIL: no threshold event"; exit 1; }
poll 60 events_has 'pushed' || { echo "FAIL: notice not delivered"; exit 1; }
"$STAM" wait "$N" --until idle --timeout 90

echo "-- forced compaction"
# Every threshold is below the agent's size even right after compaction: its size is 50000 here.
set_settings '{"context":{"warnTokens":1000,"instructTokens":2000,"enforceTokens":3000},"idleCompaction":{"enabled":false}}'
"$STAM" mail send --to "$N" --subject "hello" "Reply with exactly: hello"
poll 60 events_has 'enforcement threshold' || { echo "FAIL: no forced compaction"; exit 1; }
poll 60 events_has 'compaction:measured' || { echo "FAIL: size after compaction never measured"; exit 1; }
"$STAM" wait "$N" --until idle --timeout 180

echo "-- no forced compaction again"
"$STAM" mail send --to "$N" --subject "again" "Mail human the word again. Then end your turn."
poll 60 human_has "again" || { echo "FAIL: no mail after compaction"; exit 1; }
"$STAM" wait "$N" --until idle --timeout 90
measured=$("$STAM" events "$N" | sed -n 's/.*compaction:measured {"tokens":\([0-9]*\)}.*/\1/p' | head -1)
echo "size after compaction: ${measured:-none}"
[ "${measured:-0}" -gt 0 ] || { echo "FAIL: size after compaction measured as ${measured:-nothing}"; exit 1; }
forced=$("$STAM" events "$N" | grep -c 'context:threshold {"level":3' || true)
[ "$forced" = 1 ] || { echo "FAIL: forced compaction fired $forced times"; exit 1; }

echo "-- compact_self"
set_settings '{"context":{"warnTokens":1000,"instructTokens":100000000,"enforceTokens":200000000},"idleCompaction":{"enabled":false}}'
# A request right after a compaction is dropped (S-273) until the dedupe window ends. The test sends it
# again each time the daemon logs it dropped, so it waits on that event, not on a time.
dropped() { "$STAM" events "$N" | grep -c 'compact:dropped' || true; }
sent=0
until human_has "kept"; do
  [ "$sent" -lt 20 ] || { echo "FAIL: no mail after compact_self"; exit 1; }
  before=$(dropped)
  "$STAM" mail send --to "$N" --subject "compact" "Call the stam compact_self tool with instructions 'Keep the word TULIP' and prompt_after 'Mail human the word you were told to keep, with subject kept'. Then end your turn."
  sent=$((sent + 1))
  # Settled when the agent's mail is kept or its request was logged dropped.
  settled() { human_has "kept" || [ "$(dropped)" -gt "$before" ]; }
  poll 80 settled || { echo "FAIL: compact_self neither accepted nor dropped"; exit 1; }
done
MAIL=$("$STAM" mail read human)
echo "$MAIL" | grep -q "TULIP" || { echo "FAIL: word lost in compaction"; exit 1; }
events_has '"reason":"requested by the agent"' || { echo "FAIL: no compaction event"; exit 1; }
"$STAM" wait "$N" --until idle --timeout 90

echo "-- idle compaction"
set_settings '{"context":{"warnTokens":100000000,"instructTokens":100000001,"enforceTokens":100000002},"idleCompaction":{"enabled":true,"idleMinutes":0.1,"growthTokens":-1000000,"minTokens":1000}}'
poll 400 events_has 'context:idle-compaction' || { echo "FAIL: no idle compaction"; exit 1; }
"$STAM" wait "$N" --until idle --timeout 180

echo "PASS e2e-context"
