#!/bin/sh
# `stam forget` end to end, free: a scripted Claude Code agent (test/fake-claude, no model) is
# killed, then forgotten. The CLI must print the name the daemon forgot (S-71: it printed
# "forgot undefined", because the agent-control route answers with {agent, result}).
# Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/forget.json" <<'EOF2'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF2
fake_claude "$TEST_TMP/forget.json"
isolate
NAME="e2e-forget-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" wait "$NAME" --until idle --timeout 60
"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 20
OUT=$("$STAM" forget "$NAME")
[ "$OUT" = "forgot $NAME" ] || { echo "FAIL: stam forget printed '$OUT', want 'forgot $NAME'"; exit 1; }
"$STAM" show "$NAME" >/dev/null 2>&1 && { echo "FAIL: $NAME is still in the registry"; exit 1; }
echo "PASS e2e-forget"
