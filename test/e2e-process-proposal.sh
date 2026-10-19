#!/bin/sh
# Saving a process as a proposal (S-1084), free: an agent's token reaches the
# validator on POST /api/processes/:id/proposal as that agent (a bad file is a 400; no base is a 400; "by":"human" is a
# 403; x-stam-human doesn't make it the human), and so does the human (nothing is made). Scripted fake Claude Code
# agent against its own daemon (test/lib.sh); no model, no git, no GitHub.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/proposal.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/proposal.json"
isolate
SHARED=$(cat "$STAM_HOME/token")
AGENT="e2e-proposal-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$AGENT" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" wait "$AGENT" --until idle --timeout 60

id_of() {
  curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents" |
    python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$1"
}
AGENT_TOKEN=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$(id_of "$AGENT")" STAM_TOKEN 2>/dev/null | cut -d= -f2-)
[ -n "$AGENT_TOKEN" ] && [ "$AGENT_TOKEN" != "$SHARED" ] || { echo "FAIL: $AGENT has no token of its own"; exit 1; }
# status TOKEN [curl args...]: the HTTP status of the proposal POST.
status() {
  _t=$1
  shift
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $_t" -H 'content-type: application/json' "$@" "$STAM_URL/api/processes/dev-change/proposal"
}
BODY='{"yaml":"not: a process","summary":"x","base":""}'
# An agent's proposal reaches the validator as that agent: a bad file is a 400 (it was a 403 before S-1085).
[ "$(status "$AGENT_TOKEN" -d "$BODY")" = 400 ] || { echo "FAIL: an agent's bad file wasn't refused with 400"; exit 1; }
# An agent without base is refused before anything is made.
# The YAML is valid, so only the base check can refuse it: the answer must be that error, not a validator's.
VALID=$(python3 -c 'import json, sys; print(json.dumps({"yaml": open(sys.argv[1]).read(), "summary": "x"}))' "$(dirname "$(readlink -f "$0")")/../processes/dev-change.yaml")
NOBASE=$(curl -s -w ' %{http_code}' -X POST -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' -d "$VALID" "$STAM_URL/api/processes/dev-change/proposal")
case "$NOBASE" in *"needs base"*" 400") ;; *) echo "FAIL: an agent's valid proposal without base wasn't refused for base: $NOBASE"; exit 1 ;; esac
# An agent can't name the human, nor pass as one with the header.
[ "$(status "$AGENT_TOKEN" -d '{"yaml":"not: a process","summary":"x","base":"","by":"human"}')" = 403 ] || { echo "FAIL: an agent proposed as the human"; exit 1; }
[ "$(status "$AGENT_TOKEN" -H 'x-stam-human: 1' -d "$BODY")" = 400 ] || { echo "FAIL: x-stam-human changed the agent's request"; exit 1; }
NOBASE=$(curl -s -w ' %{http_code}' -X POST -H "authorization: Bearer $AGENT_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' -d "$VALID" "$STAM_URL/api/processes/dev-change/proposal")
case "$NOBASE" in *"needs base"*" 400") ;; *) echo "FAIL: x-stam-human let an agent skip base: $NOBASE"; exit 1 ;; esac
# The human gets as far as the validator without base too.
[ "$(status "$SHARED" -H 'x-stam-human: 1' -d '{"yaml":"not: a process","summary":"x"}')" = 400 ] || { echo "FAIL: the human's bad file wasn't refused with 400"; exit 1; }
echo "PASS e2e-process-proposal"
