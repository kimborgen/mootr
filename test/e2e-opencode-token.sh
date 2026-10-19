#!/bin/sh
# OpenCode server token (S-240), free: the shared OpenCode server runs its agents' `stam mcp`, so
# it holds a token of its own, minted when the server starts. It acts only as OpenCode agents on
# this daemon: a Claude agent, the human, and no claim are each a 403. The shared token keeps
# working, and a daemon started with STAM_TOKEN in its environment still uses its token file.
# The OpenCode server is the fake (test/fake-opencode), its Claude agent the scripted fake.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/oc-token.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/oc-token.json"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
SHARED=$(cat "$STAM_HOME/token")
CL="e2e-oc-claude-$(date +%s)"
OC="e2e-oc-agent-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$CL" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$CL" --until idle --timeout 60
"$STAM" wait "$OC" --until idle --timeout 60

id_of() {
  curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents" |
    python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$1"
}
# The server's token is the STAM_TOKEN in the environment of its tmux session (_opencode).
server_token() {
  tmux -L "$STAM_TMUX_SOCKET" show-environment -t _opencode STAM_TOKEN 2>/dev/null | cut -d= -f2-
}
status() {
  _t=$1
  _m=$2
  _p=$3
  shift 3
  curl -s -o /dev/null -w '%{http_code}' -X "$_m" -H "authorization: Bearer $_t" "$@" "$STAM_URL$_p"
}
body() {
  _t=$1
  _m=$2
  _p=$3
  shift 3
  curl -s -X "$_m" -H "authorization: Bearer $_t" "$@" "$STAM_URL$_p"
}
JSON='content-type: application/json'

CL_ID=$(id_of "$CL")
OC_ID=$(id_of "$OC")
OC_TOKEN=$(server_token)
[ -n "$OC_TOKEN" ] || { echo "FAIL: the OpenCode server has no STAM_TOKEN in its session environment"; exit 1; }
[ "$OC_TOKEN" != "$SHARED" ] || { echo "FAIL: the OpenCode server got the shared token"; exit 1; }

# Only the sha256 is kept, in a file readable by its owner alone.
[ "$(cat "$STAM_HOME/opencode-token")" = "$(printf %s "$OC_TOKEN" | sha256sum | cut -d' ' -f1)" ] || { echo "FAIL: opencode-token isn't the sha256 of the server token"; exit 1; }
[ "$(stat -c %a "$STAM_HOME/opencode-token")" = 600 ] || { echo "FAIL: opencode-token isn't mode 600"; exit 1; }

# The server acts as its OpenCode agent: mail from it, and its own inbox, stream and threads.
OC_MAIL='{"from":"'$OC'","to":"'$CL'","subject":"oc token","body":"as myself"}'
[ "$(status "$OC_TOKEN" POST /api/mail -H "$JSON" -d "$OC_MAIL")" = 200 ] || { echo "FAIL: the OpenCode server can't mail as $OC"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/agents/$OC_ID/inbox")" = 200 ] || { echo "FAIL: the OpenCode server can't read $OC's inbox"; exit 1; }
# A hook from an OpenCode agent's plugin is accepted; a Claude agent's hook path is not.
[ "$(status "$OC_TOKEN" POST "/api/hook/opencode/$OC_ID" -H "$JSON" -d '{}')" != 403 ] || { echo "FAIL: the OpenCode server's hook for $OC was refused"; exit 1; }

# It may not act as a Claude agent, the human, or an unknown name, in a claim or on a path.
CL_MAIL='{"from":"'$CL'","to":"'$OC'","subject":"oc token","body":"as claude"}'
[ "$(status "$OC_TOKEN" POST /api/mail -H "$JSON" -d "$CL_MAIL")" = 403 ] || { echo "FAIL: the OpenCode server mailed as $CL"; exit 1; }
HUMAN_MAIL='{"from":"human","to":"'$OC'","subject":"oc token","body":"as the human"}'
[ "$(status "$OC_TOKEN" POST /api/mail -H "$JSON" -d "$HUMAN_MAIL")" = 403 ] || { echo "FAIL: the OpenCode server mailed as the human"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/mail -H 'x-stam-human: 1' -H "$JSON" -d "$HUMAN_MAIL")" = 403 ] || { echo "FAIL: the OpenCode server passed the human header"; exit 1; }
EMPTY_MAIL='{"from":"","to":"'$OC'","subject":"oc token","body":"empty claim"}'
[ "$(status "$OC_TOKEN" POST /api/mail -H "$JSON" -d "$EMPTY_MAIL")" = 403 ] || { echo "FAIL: the OpenCode server sent with an empty claim"; exit 1; }
UNKNOWN_MAIL='{"from":"e2e-no-such-agent","to":"'$OC'","subject":"oc token","body":"unknown"}'
[ "$(status "$OC_TOKEN" POST /api/mail -H "$JSON" -d "$UNKNOWN_MAIL")" = 403 ] || { echo "FAIL: the OpenCode server named an unknown agent"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/agents/$CL_ID/inbox")" = 403 ] || { echo "FAIL: the OpenCode server read a Claude agent's inbox"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/agents/human/inbox")" = 403 ] || { echo "FAIL: the OpenCode server read the human's inbox"; exit 1; }
[ "$(status "$OC_TOKEN" POST "/api/hook/claude/$CL_ID" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: the OpenCode server reported a hook for a Claude agent"; exit 1; }
[ "$(status "$OC_TOKEN" POST "/api/agents/$CL_ID/pause" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: the OpenCode server paused a Claude agent with no by"; exit 1; }
[ "$(status "$OC_TOKEN" POST "/api/agents/$CL_ID/waits/done" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: the OpenCode server cleared a Claude agent's waits with no claim"; exit 1; }
ITSA_AS_CL='{"title":"oc token '"$OC"'","by":"'$CL'"}'
[ "$(status "$OC_TOKEN" POST /api/itsas -H "$JSON" -d "$ITSA_AS_CL")" = 403 ] || { echo "FAIL: the OpenCode server wrote an ITSA as $CL"; exit 1; }

# A write whose body isn't a JSON object has no identity to check: a 400, and the target lives
# (S-233 review). Its empty `{}` kill names no agent, so it's a 403.
alive() { curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents/$1" | grep -q '"lifecycle":"active"'; }
for b in '[]' 'null' '"x"' '1'; do
  [ "$(status "$OC_TOKEN" POST "/api/agents/$CL_ID/kill" -H "$JSON" -d "$b")" = 400 ] || { echo "FAIL: the OpenCode server's kill of $CL with body $b wasn't a 400"; exit 1; }
  [ "$(status "$OC_TOKEN" POST "/api/agents/$CL_ID/pause" -H "$JSON" -d "$b")" = 400 ] || { echo "FAIL: the OpenCode server's pause of $CL with body $b wasn't a 400"; exit 1; }
done
alive "$CL_ID" || { echo "FAIL: a non-object body killed or paused $CL"; exit 1; }
[ "$(status "$OC_TOKEN" POST "/api/agents/$CL_ID/kill" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: the OpenCode server's kill of $CL with no claim wasn't a 403"; exit 1; }
alive "$CL_ID" || { echo "FAIL: the OpenCode server's no-claim kill of $CL went through"; exit 1; }

# The server's MCP-shaped tool check and permission request name an OpenCode agent: they work for
# it, and a Claude agent, the human or no one is a 403 (the body's agent is checked by actor()).
CHECK_OC='{"agent":"'$OC'","tool":"whoami","args":{}}'
[ "$(status "$OC_TOKEN" POST /api/steps/check -H "$JSON" -d "$CHECK_OC")" = 200 ] || { echo "FAIL: the OpenCode server's tool check for $OC was refused"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/steps/check -H "$JSON" -d '{"agent":"'$CL'","tool":"whoami","args":{}}')" = 403 ] || { echo "FAIL: the OpenCode server checked a tool for $CL"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/steps/check -H "$JSON" -d '{"agent":"human","tool":"whoami","args":{}}')" = 403 ] || { echo "FAIL: the OpenCode server checked a tool for the human"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/steps/check -H "$JSON" -d '{"tool":"whoami","args":{}}')" = 400 ] || { echo "FAIL: a tool check with no agent wasn't a 400"; exit 1; }
PERM_OC='{"agent":"'$OC'","action":"oc token","reason":"mine","details":"","audience":"human"}'
[ "$(status "$OC_TOKEN" POST /api/permissions -H "$JSON" -d "$PERM_OC")" = 200 ] || { echo "FAIL: the OpenCode server's permission request for $OC was refused"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/permissions -H "$JSON" -d '{"agent":"'$CL'","action":"oc token","reason":"not mine","details":"","audience":"human"}')" = 403 ] || { echo "FAIL: the OpenCode server filed a permission request for $CL"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/permissions -H "$JSON" -d '{"agent":"human","action":"oc token","reason":"not mine","details":"","audience":"human"}')" = 403 ] || { echo "FAIL: the OpenCode server filed a permission request for the human"; exit 1; }

# checkStep fails closed on a 403: the server's token as $CL is refused, so the call doesn't run.
MCP="$(dirname "$(readlink -f "$0")")/mcp-call.mjs"
MCP_CALL='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_mail","arguments":{"to":["'$OC'"],"subject":"fail closed","body":"P=0.1 must not send"}}}'
REFUSED=$(STAM_BIN="$STAM" STAM_TOKEN="$OC_TOKEN" STAM_AGENT_ID="$CL_ID" node "$MCP" "$MCP_CALL")
echo "$REFUSED" | grep -q '"isError":true' && echo "$REFUSED" | grep -q "Refused" || { echo "FAIL: a check refused with 403 let the call run: $REFUSED"; exit 1; }
# The same call as the OpenCode agent's own, with its token, isn't refused: no step is set here, so it runs.
OWN=$(STAM_BIN="$STAM" STAM_TOKEN="$OC_TOKEN" STAM_AGENT_ID="$OC_ID" node "$MCP" "$MCP_CALL")
echo "$OWN" | grep -q '"isError":true' && { echo "FAIL: the OpenCode agent's own allowed call was refused: $OWN"; exit 1; }

# The shared token can't name an agent that has its own token (S-545), but reads without a claim as before.
[ "$(status "$SHARED" POST /api/mail -H "$JSON" -d "$CL_MAIL")" = 403 ] || { echo "FAIL: the shared token named $CL, which has its own token"; exit 1; }
[ "$(status "$SHARED" GET "/api/agents/$CL_ID/inbox")" = 200 ] || { echo "FAIL: the shared token can't read $CL's inbox"; exit 1; }

# A restarted daemon with STAM_TOKEN in its environment still uses its token file (S-240): the
# shared token stays the file's, and a token from the environment is not accepted.
daemon_stop main
# The daemon inherits STAM_TOKEN. The CLI's own health check sends the same variable, so it reports
# the daemon as not answering; the daemon is up, and is checked below with its token file.
export STAM_TOKEN="e2e-env-token-$$"
on main "$STAM" daemon start >/dev/null 2>&1 || true
unset STAM_TOKEN
up_check() { on main "$STAM" daemon status 2>/dev/null | grep -q "machine: 'main'"; }
wait_until up_check
[ "$(cat "$STAM_HOME/token")" = "$SHARED" ] || { echo "FAIL: the daemon rewrote its token file"; exit 1; }
[ "$(status "$SHARED" GET /api/agents)" = 200 ] || { echo "FAIL: the daemon ignored its token file when STAM_TOKEN was set"; exit 1; }
[ "$(status e2e-env-token-$$ GET /api/agents)" = 401 ] || { echo "FAIL: the daemon accepted the STAM_TOKEN from its environment"; exit 1; }
# The server kept running with its token through the restart, so its hash is still in the file.
[ "$(status "$OC_TOKEN" GET "/api/agents/$OC_ID/inbox")" = 200 ] || { echo "FAIL: the OpenCode server's token stopped working after a daemon restart"; exit 1; }

# Mail reads (S-259): the OpenCode server names the box it reads, and it must be an OpenCode agent.
# Without a box, a Claude agent's box, or the human's, it's a 403.
OC_THREAD=$(body "$OC_TOKEN" POST /api/mail -H "$JSON" -d '{"from":"'$OC'","to":"'$CL'","subject":"oc box","body":"scoped"}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["thread_id"])')
[ "$(status "$OC_TOKEN" GET "/api/mail/search?q=scoped")" = 403 ] || { echo "FAIL: the OpenCode server searched mail with no box"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/mail/search?box=$CL_ID&q=scoped")" = 403 ] || { echo "FAIL: the OpenCode server searched a Claude agent's mail"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/mail/search?box=human&q=scoped")" = 403 ] || { echo "FAIL: the OpenCode server searched the human's mail"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/mail/search?box=$OC_ID&q=scoped")" = 200 ] || { echo "FAIL: the OpenCode server can't search its own box"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/threads/$OC_THREAD")" = 403 ] || { echo "FAIL: the OpenCode server read a thread with no box"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/threads/$OC_THREAD?box=$CL_ID")" = 403 ] || { echo "FAIL: the OpenCode server read a Claude agent's part of a thread"; exit 1; }
[ "$(status "$OC_TOKEN" GET "/api/threads/$OC_THREAD?box=$OC_ID")" = 200 ] || { echo "FAIL: the OpenCode server can't read its own part of a thread"; exit 1; }
[ "$(status "$SHARED" GET "/api/mail/search?box=$CL_ID&q=scoped")" = 200 ] || { echo "FAIL: the shared token can't search a Claude agent's mail"; exit 1; }

# Settings (S-259): the OpenCode server reads them redacted and can't write them.
python3 - "$STAM_HOME/settings.json" <<'EOF4'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s["peers"] = [{"name": "oc-peer", "url": "http://127.0.0.1:9", "token": "PEERSECRET-opencode"}]
json.dump(s, open(p, "w"))
EOF4
OC_SETTINGS=$(body "$OC_TOKEN" GET /api/config/settings)
echo "$OC_SETTINGS" | grep -q 'PEERSECRET-opencode' && { echo "FAIL: the OpenCode server read a peer's token"; exit 1; }
[ "$(status "$OC_TOKEN" POST /api/config/settings -H "$JSON" -d '{"text":"{}"}')" = 403 ] || { echo "FAIL: the OpenCode server wrote the settings"; exit 1; }
body "$SHARED" GET /api/config/settings | grep -q 'PEERSECRET-opencode' || { echo "FAIL: the shared token can't read the peer's token"; exit 1; }

echo "PASS e2e-opencode-token"
