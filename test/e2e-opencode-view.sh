#!/bin/sh
# An OpenCode agent's view (src/adapters/opencode-view.ts; Go: go/internal/agentview/opencode.go), free: a long transcript
# paged older three times through the server's cursor, a prompt and a permission reply sent from the view and an interrupt,
# a live reply streamed back, and sends with a forged human header refused. The OpenCode server is the fake
# (test/fake-opencode). The steps are in test/opencode-view-fake.mjs. Runs on either daemon (STAM_DAEMON=go for the Go one).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
# Stands in for the human's `tailscale serve` proof (trustedHuman); a forged header isn't.
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
isolate
OC="e2e-oc-view-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$OC" --until idle --timeout 60
SHARED=$(cat "$STAM_HOME/token")
SID=$(curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents" | python3 -c 'import json, sys; print(next(a["session_id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$OC")
[ -n "$SID" ] || { echo "FAIL: $OC has no session"; exit 1; }
node "$ROOT/test/opencode-view-fake.mjs" "$OC" "$SID" || { "$STAM" events "$OC" | tail -20; exit 1; }
echo "PASS e2e-opencode-view"
