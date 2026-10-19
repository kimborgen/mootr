#!/bin/sh
# S-1378: /api/archive-children is peer-only, free (agents start with no prompt, so no model
# runs). One test daemon: an agent's own token, the shared token, and the shared token with
# x-stam-local are refused; the peer token with x-stam-local runs the cascade over the children
# of a parent id the daemon does not hold, and answers 400 without parent ids.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fake_claude ""
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
PEER=$(cat "$STAM_HOME/peer-token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
WORKER=$(human POST /api/agents "{\"name\":\"worker\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\"}" | field id)
[ -n "$WORKER" ] || fail "spawn"
# A child of a parent id this daemon has no agent for: what a peer's manager leaves behind.
KID=$(human POST /api/agents "{\"name\":\"kid\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\",\"parent\":\"$WORKER\"}" | field id)
[ -n "$KID" ] || fail "spawn kid"
BODY="{\"parents\":[\"no-such-manager\"],\"fallback\":[]}"
code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' $2 -d "$3" "$STAM_URL/api/archive-children"; }
AGENT_TOKEN=$(agent_token worker)
[ "$(code "$AGENT_TOKEN" '' "$BODY")" = 403 ] || fail "an agent token reached the route"
[ "$(code "$AGENT_TOKEN" '-H x-stam-local:1' "$BODY")" = 403 ] || fail "an agent token with x-stam-local reached the route"
[ "$(code "$TOKEN" '' "$BODY")" = 403 ] || fail "the shared token reached the route"
[ "$(code "$TOKEN" '-H x-stam-local:1' "$BODY")" = 403 ] || fail "the shared token with x-stam-local reached the route"
[ "$(code "$PEER" '-H x-stam-local:1' '{"fallback":[]}')" = 400 ] || fail "a peer call without parents was not a 400"
[ "$(code "$PEER" '-H x-stam-local:1' "$BODY")" = 200 ] || fail "the peer token was refused"
# A live local parent is skipped: its child stays.
[ "$(code "$PEER" '-H x-stam-local:1' "{\"parents\":[\"$WORKER\"],\"fallback\":[]}")" = 200 ] || fail "the peer call naming a live parent failed"
[ "$(human GET "/api/agents/$KID" | field lifecycle)" = active ] || fail "a refused or empty call changed a child"
echo "PASS e2e-archive-cascade-route"
