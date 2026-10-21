#!/bin/sh
# API contract (S-2388), free: starts a throwaway daemon (test/lib.sh), spawns two scripted fake
# Claude Code agents so the agent list has rows, and validates the answers of every route in
# api/openapi.yaml with ajv (test/openapi-contract.mjs). Black-box over HTTP; no model.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/contract.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/contract.json"
isolate
NAME="e2e-contract-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" wait "$NAME" --until idle --timeout 60
# A second agent: a standing child with an effort, so the nullable and optional columns carry values.
CHILD="e2e-contract-child-$(date +%s)"
"$STAM" spawn "$CHILD" --model claude-haiku-5-5 --effort low --cwd "$DIR" --parent "$NAME" --standing "Say hello."
"$STAM" wait "$CHILD" --until idle --timeout 60
node "$ROOT/test/openapi-contract.mjs" || { echo "FAIL e2e-openapi-contract"; exit 1; }
for n in "$CHILD" "$NAME"; do
  "$STAM" kill "$n" >/dev/null
  "$STAM" wait "$n" --until shut_down --timeout 10
done
echo "PASS e2e-openapi-contract"
