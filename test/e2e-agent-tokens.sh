#!/bin/sh
# Per-agent daemon tokens (S-237), free: scripted Claude Code agents (test/fake-claude, no model)
# against their own daemon (test/lib.sh). Each launch gives an agent its own STAM_TOKEN, stored
# only as a sha256 in the daemon. The shared token (the CLI's and the human's) still works, and
# an agent's token never gets the human's powers, whatever x-stam-human says. A relaunch rotates
# the token, so the old one stops working. The legacy caller here holds the shared token, as an
# agent launched before this change does.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/tokens.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/tokens.json"
isolate
SHARED=$(cat "$STAM_HOME/token")
NEW="e2e-tok-new-$(date +%s)"
PEER="e2e-tok-peer-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NEW" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" spawn "$PEER" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" wait "$NEW" --until idle --timeout 60
"$STAM" wait "$PEER" --until idle --timeout 60

id_of() {
  curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents" |
    python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$1"
}
# The STAM_TOKEN in an agent's tmux session environment, the one its processes read.
token_of() {
  tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$(id_of "$1")" STAM_TOKEN 2>/dev/null | cut -d= -f2-
}
# The HTTP status of a request with the given bearer token: status TOKEN METHOD PATH [curl args...]
status() {
  _t=$1
  _m=$2
  _p=$3
  shift 3
  curl -s -o /dev/null -w '%{http_code}' -X "$_m" -H "authorization: Bearer $_t" "$@" "$STAM_URL$_p"
}

NEW_TOKEN=$(token_of "$NEW")
[ -n "$NEW_TOKEN" ] || { echo "FAIL: $NEW has no STAM_TOKEN in its environment"; exit 1; }
[ "$NEW_TOKEN" != "$SHARED" ] || { echo "FAIL: $NEW got the shared token"; exit 1; }
# The daemon keeps only the hash: the plain token is in no file of its home.
TAR=$(curl -sf -H "authorization: Bearer $SHARED" "$STAM_URL/api/test/token-at-rest?token=$NEW_TOKEN")
[ "$TAR" = '{"plain":false,"hashed":true}' ] || { echo "FAIL: the agent token isn't stored only as a hash: $TAR"; exit 1; }

# The legacy caller (shared token) lists agents but can't name one with its own token (S-545); the new agent reaches the daemon.
[ "$(status "$SHARED" GET /api/agents)" = 200 ] || { echo "FAIL: the shared token can't list agents"; exit 1; }
[ "$(status "$NEW_TOKEN" GET /api/agents)" = 200 ] || { echo "FAIL: $NEW's token can't list agents"; exit 1; }
MAIL='{"from":"'$NEW'","to":"'$PEER'","subject":"tokens","body":"from the new agent"}'
[ "$(status "$NEW_TOKEN" POST /api/mail -H 'content-type: application/json' -d "$MAIL")" = 200 ] || { echo "FAIL: $NEW can't send mail"; exit 1; }
LEGACY_MAIL='{"from":"'$PEER'","to":"'$NEW'","subject":"tokens","body":"from the shared token"}'
[ "$(status "$SHARED" POST /api/mail -H 'content-type: application/json' -d "$LEGACY_MAIL")" = 403 ] || { echo "FAIL: the shared token named an agent that has its own token"; exit 1; }

# An agent's token with x-stam-human: 1 gets no human power. Typing into an agent is the human's.
[ "$(status "$NEW_TOKEN" POST "/api/agents/$NEW/prompt" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"text":"x"}')" = 403 ] || { echo "FAIL: $NEW's token passed as the human"; exit 1; }
[ "$(status "$SHARED" POST "/api/agents/$NEW/prompt" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"text":"x"}')" != 403 ] || { echo "FAIL: the shared token lost the human's power"; exit 1; }

# A wrong token is refused.
[ "$(status not-a-token GET /api/agents)" = 401 ] || { echo "FAIL: a wrong token wasn't refused with 401"; exit 1; }

# A relaunch rotates the token: the old one stops working, the new one works.
"$STAM" restart "$NEW" "e2e token rotation" >/dev/null
rotated() { _cur=$(token_of "$NEW"); [ -n "$_cur" ] && [ "$_cur" != "$NEW_TOKEN" ]; }
wait_until rotated
NEXT_TOKEN=$(token_of "$NEW")
[ "$(status "$NEW_TOKEN" GET /api/agents)" = 401 ] || { echo "FAIL: the token from before the relaunch still works"; exit 1; }
[ "$(status "$NEXT_TOKEN" GET /api/agents)" = 200 ] || { echo "FAIL: the token from the relaunch doesn't work"; exit 1; }

# No agent route serves the stored hash (S-2519): the list, the detail, and the token holder's own view.
HASH=$(printf %s "$NEXT_TOKEN" | sha256sum | cut -d' ' -f1)
for path in /api/agents "/api/agents/$NEW"; do
  for tok in "$SHARED" "$NEXT_TOKEN"; do
    body=$(curl -s -H "authorization: Bearer $tok" "$STAM_URL$path")
    case "$body" in *token_hash*|*"$HASH"*) echo "FAIL: GET $path leaks the token hash"; exit 1 ;; esac
  done
done

echo "PASS e2e-agent-tokens"
