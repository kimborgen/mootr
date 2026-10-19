#!/bin/sh
# The transcript wait behind said (test/lib.sh, S-1333), free and no daemon: transcript_said matches
# only the assistant's text, so a pattern in a prompt or a tool result doesn't count as a reply.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $*"; exit 1; }
T="$TEST_TMP/said.jsonl"
cat >"$T" <<'EOF'
{"type":"user","message":{"role":"user","content":"Reply with PROMPT-ONLY"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo TOOL-ONLY"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"TOOL-ONLY"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"LINKED"}]}}
EOF
transcript_said "$T" LINKED || fail "the assistant's text didn't match"
transcript_said "$T" "LINKED\|EXPECT FAILED" || fail "an alternation didn't match the assistant's text"
transcript_said "$T" PROMPT-ONLY && fail "a prompt matched"
transcript_said "$T" TOOL-ONLY && fail "a tool result matched"
transcript_said "$T" MISSING && fail "a missing pattern matched"
printf '%s\n' '{"type":"user","message":{"role":"user","content":"ONLY-PROMPT"}}' >"$TEST_TMP/prompt.jsonl"
transcript_said "$TEST_TMP/prompt.jsonl" ONLY-PROMPT && fail "a prompt-only transcript matched"
echo "PASS e2e-said"
