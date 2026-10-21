#!/bin/sh
# Agent identity (S-238), free: scripted Claude Code agents (test/fake-claude, no model) on their
# own daemon (test/lib.sh). A new agent holds its own token and may act only as itself; a legacy
# caller holds the shared token, which keeps its claims while settings.auth.sharedTokenClaims is
# true, and loses them, except the human's own, once it is false.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/identity.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/identity.json"
isolate
SHARED=$(cat "$STAM_HOME/token")
NEW="e2e-id-new-$(date +%s)"
PEER="e2e-id-peer-$(date +%s)"
MINE="e2e-id-mine-$(date +%s)"
THEIRS="e2e-id-theirs-$(date +%s)"
SIB="e2e-id-sib-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$NEW" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" spawn "$PEER" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" spawn "$MINE" --model claude-haiku-5-5 --cwd "$DIR" --parent "$NEW" "Say hello."
"$STAM" spawn "$THEIRS" --model claude-haiku-5-5 --cwd "$DIR" --parent "$PEER" "Say hello."
"$STAM" spawn "$SIB" --model claude-haiku-5-5 --cwd "$DIR" --parent "$NEW" "Say hello."
for n in "$NEW" "$PEER" "$MINE" "$THEIRS" "$SIB"; do "$STAM" wait "$n" --until idle --timeout 60; done

id_of() {
  curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents" |
    python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$1"
}
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
# The body of a request, for checking what was recorded: body TOKEN METHOD PATH [curl args...]
body() {
  _t=$1
  _m=$2
  _p=$3
  shift 3
  curl -s -X "$_m" -H "authorization: Bearer $_t" "$@" "$STAM_URL$_p"
}

JSON='content-type: application/json'

NEW_ID=$(id_of "$NEW")
PEER_ID=$(id_of "$PEER")
THEIRS_ID=$(id_of "$THEIRS")
NEW_TOKEN=$(token_of "$NEW")
[ -n "$NEW_TOKEN" ] || { echo "FAIL: $NEW has no STAM_TOKEN in its environment"; exit 1; }

# A new agent's token may not claim another agent as mail from, an ITSA by, or control of
# another agent's child: each is a 403.
MAIL_AS_PEER='{"from":"'$PEER'","to":"'$NEW'","subject":"identity","body":"not mine"}'
[ "$(status "$NEW_TOKEN" POST /api/mail -H "$JSON" -d "$MAIL_AS_PEER")" = 403 ] || { echo "FAIL: $NEW sent mail as $PEER"; exit 1; }
ITSA_AS_PEER='{"title":"identity '"$NEW"'","by":"'$PEER'"}'
[ "$(status "$NEW_TOKEN" POST /api/itsas -H "$JSON" -d "$ITSA_AS_PEER")" = 403 ] || { echo "FAIL: $NEW wrote an ITSA as $PEER"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$THEIRS/pause" -H "$JSON" -d '{"by":"'$PEER'"}')" = 403 ] || { echo "FAIL: $NEW controlled $THEIRS as $PEER"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$THEIRS/pause" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW controlled $THEIRS with no claim"; exit 1; }
# workspace_share acts as the owner only (S-896): not as another agent, nor as one's child.
SHARE='{"agent":"'$NEW'","access":"read"}'
[ "$(status "$NEW_TOKEN" POST "/api/agents/$THEIRS/workspace-share" -H "$JSON" -d "$SHARE")" = 403 ] || { echo "FAIL: $NEW shared $THEIRS's workspace"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$MINE/workspace-share" -H "$JSON" -d "$SHARE")" = 403 ] || { echo "FAIL: parent $NEW shared its child's workspace"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$NEW/workspace-share" -H "$JSON" -d "$SHARE")" = 400 ] || { echo "FAIL: $NEW can't reach its own workspace-share route"; exit 1; }
[ "$(status "$NEW_TOKEN" POST /api/mail -H "$JSON" -d '{"from":"human","to":"'$NEW'","subject":"identity","body":"x"}')" = 403 ] || { echo "FAIL: $NEW mailed as the human"; exit 1; }

# Its own children and its own name still work, and a claim of itself is recorded as itself.
[ "$(status "$NEW_TOKEN" POST "/api/agents/$MINE/pause" -H "$JSON" -d '{}')" != 403 ] || { echo "FAIL: $NEW can't control its own child"; exit 1; }
SELF_MAIL='{"from":"'$NEW'","to":"'$PEER'","subject":"identity","body":"as myself"}'
[ "$(status "$NEW_TOKEN" POST /api/mail -H "$JSON" -d "$SELF_MAIL")" = 200 ] || { echo "FAIL: $NEW can't mail as itself"; exit 1; }
NO_CLAIM='{"to":"'$PEER'","subject":"identity","body":"no from"}'
RECORDED=$(body "$NEW_TOKEN" POST /api/mail -H "$JSON" -d "$NO_CLAIM")
echo "$RECORDED" | grep -q "\"from_id\":\"$NEW_ID\"" || { echo "FAIL: mail with no claim isn't recorded as $NEW: $RECORDED"; exit 1; }
[ "$(status "$NEW_TOKEN" POST /api/itsas -H "$JSON" -d '{"title":"identity self"}')" = 200 ] || { echo "FAIL: $NEW can't create an ITSA as itself"; exit 1; }

# The shared token can't name an agent that has its own token, even while sharedTokenClaims is true (S-545).
LEGACY_MAIL='{"from":"'$PEER'","to":"'$NEW'","subject":"identity","body":"legacy"}'
[ "$(status "$SHARED" POST /api/mail -H "$JSON" -d "$LEGACY_MAIL")" = 403 ] || { echo "FAIL: the shared token named $PEER, which has its own token"; exit 1; }
[ "$(status "$SHARED" POST /api/itsas -H "$JSON" -d "$ITSA_AS_PEER")" = 403 ] || { echo "FAIL: the shared token named $PEER as ITSA by"; exit 1; }

# The shared token can't name an agent that has its own token (S-545): PEER holds one, so the claim is a 403.
# A registered agent gets its own token from /api/register and acts as itself with it.
REG=$(body "$SHARED" POST /api/register -H "$JSON" -d '{"name":"regd","role":"test","token":true}')
REG_ID=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'); REG_TOKEN=$(echo "$REG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
[ "$(status "$REG_TOKEN" POST /api/mail -H "$JSON" -d '{"from":"'$REG_ID'","to":"'$PEER'","subject":"identity","body":"registered"}')" = 200 ] || { echo "FAIL: a registered agent can't mail as itself with its token"; exit 1; }
[ "$(status "$SHARED" POST /api/mail -H "$JSON" -d '{"from":"'$REG_ID'","to":"'$PEER'","subject":"identity","body":"shared"}')" = 403 ] || { echo "FAIL: the shared token named an agent with its own token"; exit 1; }
# An agent without a token (one from before per-agent tokens) can still be named.
curl -sf -X POST -H "authorization: Bearer $SHARED" -H "$JSON" -d "{\"agent\":\"$REG_ID\",\"token\":null}" "$STAM_URL/api/test/agent" >/dev/null
[ "$(status "$SHARED" POST /api/mail -H "$JSON" -d '{"from":"'$REG_ID'","to":"'$PEER'","subject":"identity","body":"legacy"}')" = 200 ] || { echo "FAIL: the shared token can't name an agent without its own token"; exit 1; }
# With sharedTokenClaims off, the shared token can't name an agent, but the human still can: the
# CLI in a plain shell sends no claim, or claims the human.
python3 - "$STAM_HOME/settings.json" <<'EOF2'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s.setdefault("auth", {})["sharedTokenClaims"] = False
json.dump(s, open(p, "w"))
EOF2
[ "$(status "$SHARED" POST /api/mail -H "$JSON" -d "$LEGACY_MAIL")" = 403 ] || { echo "FAIL: the shared token still names an agent as from"; exit 1; }
[ "$(status "$SHARED" POST /api/itsas -H "$JSON" -d "$ITSA_AS_PEER")" = 403 ] || { echo "FAIL: the shared token still names an agent as ITSA by"; exit 1; }
[ "$(status "$SHARED" POST "/api/agents/$PEER/pause" -H "$JSON" -d '{"by":"'$PEER'"}')" = 403 ] || { echo "FAIL: the shared token still names an agent for agent_control"; exit 1; }
[ "$(status "$SHARED" GET /api/agents)" = 200 ] || { echo "FAIL: the shared token can't list agents with no claim"; exit 1; }
[ "$(status "$SHARED" POST /api/mail -H 'x-stam-human: 1' -H "$JSON" -d '{"from":"human","to":"'$PEER'","subject":"identity","body":"from the human"}')" = 200 ] || { echo "FAIL: the human can't mail as the human with the shared token"; exit 1; }
[ "$(status "$SHARED" POST /api/itsas -H 'x-stam-human: 1' -H "$JSON" -d '{"title":"identity human","by":"human"}')" != 403 ] || { echo "FAIL: the human's ITSA claim is refused"; exit 1; }
# A new agent's token is unaffected by the setting.
[ "$(status "$NEW_TOKEN" POST /api/mail -H "$JSON" -d "$SELF_MAIL")" = 200 ] || { echo "FAIL: $NEW lost its own identity with the setting off"; exit 1; }

# The activity by query is a grouping, not an identity: an agent's token may read it.
[ "$(status "$NEW_TOKEN" GET "/api/activity?by=model")" = 200 ] || { echo "FAIL: $NEW's token can't group activity by model"; exit 1; }
# Subscriptions name the actor in the by query: another agent's is refused, its own works.
[ "$(status "$NEW_TOKEN" GET "/api/subscriptions?by=$PEER")" = 403 ] || { echo "FAIL: $NEW listed $PEER's subscriptions"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/subscriptions?by=$NEW")" = 200 ] || { echo "FAIL: $NEW can't list its own subscriptions"; exit 1; }
# A tool check and a permission request name their agent in the body: only as itself.
CHECK_AS_PEER='{"agent":"'$PEER'","tool":"Bash","args":{"command":"echo hi"}}'
[ "$(status "$NEW_TOKEN" POST /api/steps/check -H "$JSON" -d "$CHECK_AS_PEER")" = 403 ] || { echo "FAIL: $NEW ran a tool check as $PEER"; exit 1; }
CHECK_AS_SELF='{"agent":"'$NEW'","tool":"Bash","args":{"command":"echo hi"}}'
[ "$(status "$NEW_TOKEN" POST /api/steps/check -H "$JSON" -d "$CHECK_AS_SELF")" = 200 ] || { echo "FAIL: $NEW's own tool check was refused"; exit 1; }
# With no agent named, the token's own agent checks (S-271); a check naming the human is refused.
CHECK_NO_AGENT='{"tool":"Bash","args":{"command":"echo hi"}}'
[ "$(status "$NEW_TOKEN" POST /api/steps/check -H "$JSON" -d "$CHECK_NO_AGENT")" = 200 ] || { echo "FAIL: $NEW's tool check with no agent named was refused"; exit 1; }
[ "$(status "$NEW_TOKEN" POST /api/steps/check -H "$JSON" -d '{"agent":"human","tool":"Bash","args":{}}')" = 403 ] || { echo "FAIL: $NEW ran a tool check as the human"; exit 1; }
PERM_AS_PEER='{"agent":"'$PEER'","action":"identity","reason":"not mine","details":"","audience":"human"}'
[ "$(status "$NEW_TOKEN" POST /api/permissions -H "$JSON" -d "$PERM_AS_PEER")" = 403 ] || { echo "FAIL: $NEW filed a permission request as $PEER"; exit 1; }
PERM_AS_SELF='{"agent":"'$NEW'","action":"identity","reason":"mine","details":"","audience":"human"}'
[ "$(status "$NEW_TOKEN" POST /api/permissions -H "$JSON" -d "$PERM_AS_SELF")" = 200 ] || { echo "FAIL: $NEW's own permission request was refused"; exit 1; }

# Acting as another agent's mailbox, stream, threads, or waits (S-242): an agent's token may act as
# itself, as an ancestor of the agent (its parent, or further up), or as the chief of staff and the
# assistant. A sibling or an unrelated agent gets a 403, and so does a child reading its parent.
MINE_ID=$(id_of "$MINE")
MINE_TOKEN=$(token_of "$MINE")
SIB_ID=$(id_of "$SIB")
[ "$(status "$NEW_TOKEN" GET "/api/agents/$NEW_ID/inbox")" = 200 ] || { echo "FAIL: $NEW can't read its own inbox"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$MINE_ID/inbox")" = 200 ] || { echo "FAIL: parent $NEW can't read its child's inbox"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$PEER_ID/inbox")" = 403 ] || { echo "FAIL: $NEW read $PEER's inbox"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$THEIRS_ID/inbox")" = 403 ] || { echo "FAIL: $NEW read the inbox of $PEER's child"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/human/inbox")" = 403 ] || { echo "FAIL: $NEW read the human's inbox"; exit 1; }
SIB_TOKEN=$(token_of "$SIB")
[ "$(status "$SIB_TOKEN" GET "/api/agents/$MINE_ID/inbox")" = 403 ] || { echo "FAIL: a sibling read $MINE's inbox"; exit 1; }

[ "$(status "$MINE_TOKEN" GET "/api/agents/$NEW_ID/inbox")" = 403 ] || { echo "FAIL: a child read its parent's inbox"; exit 1; }
[ "$(status "$MINE_TOKEN" GET "/api/agents/$MINE_ID/inbox")" = 200 ] || { echo "FAIL: $MINE can't read its own inbox"; exit 1; }
# Marking mail read, the stream, and threads: another agent's are a 403, its own work.
[ "$(status "$NEW_TOKEN" POST "/api/agents/$PEER_ID/read" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW marked $PEER's mail read"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$NEW_ID/read" -H "$JSON" -d '{}')" = 200 ] || { echo "FAIL: $NEW can't mark its own mail read"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$PEER_ID/stream" -m 2)" = 403 ] || { echo "FAIL: $NEW opened $PEER's stream"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$NEW_ID/stream" -m 2)" = 200 ] || { echo "FAIL: $NEW can't open its own stream"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$PEER_ID/threads")" = 403 ] || { echo "FAIL: $NEW listed $PEER's threads"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/agents/$NEW_ID/threads")" = 200 ] || { echo "FAIL: $NEW can't list its own threads"; exit 1; }
# Waits: declaring one for another agent is a 403; its own (and its child's, as a parent) work.
WAIT_FOR_PEER='{"on":"agent","target":"'$PEER_ID'"}'
[ "$(status "$NEW_TOKEN" POST "/api/agents/$PEER_ID/waits/wake" -H "$JSON" -d '{"in_minutes":5}')" = 403 ] || { echo "FAIL: $NEW set a timer for $PEER"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$PEER_ID/waits/done" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW cleared a wait of $PEER"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$MINE_ID/waits/declared" -H "$JSON" -d '{"on":"human","note":"child"}')" = 200 ] || { echo "FAIL: parent $NEW can't declare a wait for its child"; exit 1; }
# Hook and status reports name the agent in the path: another agent's are a 403.
[ "$(status "$NEW_TOKEN" POST "/api/hook/claude/$PEER_ID" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW reported a hook for $PEER"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/statusline/claude/$PEER_ID" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW reported a statusline for $PEER"; exit 1; }
# A parent may not report its child's hook either: the harness reports only its own agent.
[ "$(status "$NEW_TOKEN" POST "/api/hook/claude/$MINE_ID" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW reported a hook for its child $MINE"; exit 1; }

# The shared token keeps reading and acting as any agent: the CLI and legacy callers.
[ "$(status "$SHARED" GET "/api/agents/$PEER_ID/inbox")" = 200 ] || { echo "FAIL: the shared token can't read $PEER's inbox"; exit 1; }
[ "$(status "$SHARED" POST "/api/agents/$PEER_ID/read" -H "$JSON" -d '{}')" = 200 ] || { echo "FAIL: the shared token can't mark $PEER's mail read"; exit 1; }
[ "$(status "$SHARED" POST "/api/agents/$PEER_ID/waits/declared" -H "$JSON" -d '{"on":"human","note":"shared"}')" = 200 ] || { echo "FAIL: the shared token can't declare a wait for $PEER"; exit 1; }

# A write whose body isn't a JSON object has no identity to check, so an agent's token gets a 400
# before anything resolves it, and the target lives (S-233 review). An empty body is still `{}`.
# The control routes' `{}` from another agent's token is a 403: its by is the caller, not the human.
alive() { curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents/$1" | grep -q '"lifecycle":"active"'; }
for b in '[]' 'null' '"x"' '1'; do
  for act in pause kill; do
    [ "$(status "$NEW_TOKEN" POST "/api/agents/$PEER_ID/$act" -H "$JSON" -d "$b")" = 400 ] || { echo "FAIL: $NEW's $act of $PEER with body $b wasn't a 400"; exit 1; }
  done
done
alive "$PEER_ID" || { echo "FAIL: a non-object body killed or paused $PEER"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$PEER_ID/kill" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW's kill of $PEER with no claim wasn't a 403"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$PEER_ID/pause" -H "$JSON" -d '{}')" = 403 ] || { echo "FAIL: $NEW's pause of $PEER with no claim wasn't a 403"; exit 1; }
alive "$PEER_ID" || { echo "FAIL: $NEW's no-claim kill of $PEER went through"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$NEW_ID/pause" -H "$JSON" -d '[]')" = 400 ] || { echo "FAIL: $NEW's own pause with an array body wasn't a 400"; exit 1; }
[ "$(status "$NEW_TOKEN" POST "/api/agents/$NEW_ID/pause" -H "$JSON" -d '{}')" != 403 ] || { echo "FAIL: $NEW can't pause itself with an empty body"; exit 1; }

# A session's notice and compaction instructions belong to its agent: another agent's are a 403,
# and draining them (the GET consumes) doesn't happen; its own, and the shared token's, work.
session_of() {
  curl -s -H "authorization: Bearer $SHARED" "$STAM_URL/api/agents/$1" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("session_id") or "")'
}
PEER_SESSION=$(session_of "$PEER_ID")
NEW_SESSION=$(session_of "$NEW_ID")
[ -n "$PEER_SESSION" ] && [ -n "$NEW_SESSION" ] || { echo "FAIL: the agents have no session ids"; exit 1; }
for r in notice compact-instructions; do
  [ "$(status "$NEW_TOKEN" GET "/api/by-session/$PEER_SESSION/$r")" = 403 ] || { echo "FAIL: $NEW read $PEER's $r by session"; exit 1; }
  [ "$(status "$NEW_TOKEN" GET "/api/by-session/$NEW_SESSION/$r")" = 200 ] || { echo "FAIL: $NEW can't read its own $r by session"; exit 1; }
done
[ "$(status "$NEW_TOKEN" GET "/api/by-session/$PEER_SESSION/system")" = 403 ] || { echo "FAIL: $NEW read $PEER's system prompt by session"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/by-session/$NEW_SESSION/system")" = 200 ] || { echo "FAIL: $NEW can't read its own system prompt by session"; exit 1; }
[ "$(status "$SHARED" GET "/api/by-session/$PEER_SESSION/notice")" = 200 ] || { echo "FAIL: the shared token can't read a session's notice"; exit 1; }

# ITSA threads (S-269, S-480): an agent reads the mail threads about an ITSA only as one it belongs
# to: a participant (or its owner), or the owner of an ancestor ITSA. A participant's parent or child
# agent, a sibling, or an unrelated agent is a 403. The shared token reads any.
PEER_TOKEN=$(token_of "$PEER")
mk_itsa() {
  body "$SHARED" POST /api/itsas -H 'x-stam-human: 1' -H "$JSON" -d '{"title":"identity '"$1"' '"$(date +%s%N)"'","by":"human","participants":["'"$2"'"]'"${3:+,$3}"'}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])'
}
ITSA_MINE=$(mk_itsa mine "$MINE_ID")
ITSA_NEW=$(mk_itsa new "$NEW_ID")
ITSA_TOP=$(mk_itsa top "$SIB_ID" '"owner":"'"$PEER_ID"'"')
ITSA_UNDER=$(mk_itsa under "$SIB_ID" '"parent":"'"$ITSA_TOP"'"')
threads_status() {
  for p in "/api/threads/about/$1" "/api/itsas/$1/threads"; do
    status "$2" GET "$p"; echo
  done
}
# The participant reads it; its parent (NEW of MINE), a sibling, and an unrelated agent don't.
[ "$(threads_status "$ITSA_MINE" "$MINE_TOKEN" | sort -u)" = 200 ] || { echo "FAIL: a participant of $ITSA_MINE was refused"; exit 1; }
for t in "$NEW_TOKEN" "$SIB_TOKEN" "$PEER_TOKEN"; do
  [ "$(threads_status "$ITSA_MINE" "$t" | sort -u)" = 403 ] || { echo "FAIL: a participant's parent, a sibling, or an unrelated agent read the threads of $ITSA_MINE"; exit 1; }
done
# A participant's child (MINE, child of NEW) doesn't read an ITSA that NEW takes part in.
[ "$(threads_status "$ITSA_NEW" "$MINE_TOKEN" | sort -u)" = 403 ] || { echo "FAIL: a participant's child read the threads of $ITSA_NEW"; exit 1; }
# The owner of an ancestor ITSA (PEER of ITSA_TOP) reads the child ITSA.
[ "$(threads_status "$ITSA_UNDER" "$PEER_TOKEN" | sort -u)" = 200 ] || { echo "FAIL: the owner of a parent ITSA was refused the threads of $ITSA_UNDER"; exit 1; }
[ "$(threads_status "$ITSA_UNDER" "$MINE_TOKEN" | sort -u)" = 403 ] || { echo "FAIL: an unrelated agent read the threads of $ITSA_UNDER"; exit 1; }
[ "$(threads_status "$ITSA_MINE" "$SHARED" | sort -u)" = 200 ] || { echo "FAIL: the shared token can't read the threads of an ITSA"; exit 1; }

# Mail reads (S-259): the box query names whose mail is read. An agent reads its own box by default,
# its child's (an ancestor), and never another agent's or the human's; the shared token reads any.
MAIL_THREAD=$(body "$NEW_TOKEN" POST /api/mail -H "$JSON" -d '{"to":"'$PEER'","subject":"box scope","body":"scoped"}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["thread_id"])')
[ "$(status "$NEW_TOKEN" GET "/api/mail/search?box=$PEER_ID&q=scoped")" = 403 ] || { echo "FAIL: $NEW searched $PEER's mail"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/mail/search?box=$PEER&q=scoped")" = 403 ] || { echo "FAIL: $NEW searched $PEER's mail by name"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/mail/search?box=human&q=scoped")" = 403 ] || { echo "FAIL: $NEW searched the human's mail"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/mail/search?q=scoped")" = 200 ] || { echo "FAIL: $NEW's search with no box isn't its own"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/mail/search?box=$NEW_ID&q=scoped")" = 200 ] || { echo "FAIL: $NEW can't search its own box"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/mail/search?box=$MINE_ID&q=scoped")" = 200 ] || { echo "FAIL: parent $NEW can't search its child's box"; exit 1; }
[ "$(status "$SHARED" GET "/api/mail/search?box=$PEER_ID&q=scoped")" = 200 ] || { echo "FAIL: the shared token can't search $PEER's mail"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/threads/$MAIL_THREAD?box=$PEER_ID")" = 403 ] || { echo "FAIL: $NEW read $PEER's part of a thread"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/threads/$MAIL_THREAD?box=human")" = 403 ] || { echo "FAIL: $NEW read the human's part of a thread"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/threads/$MAIL_THREAD")" = 200 ] || { echo "FAIL: $NEW can't read its own part of a thread with no box"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/threads/$MAIL_THREAD?box=$NEW_ID")" = 200 ] || { echo "FAIL: $NEW can't read its own box of a thread"; exit 1; }
[ "$(status "$SHARED" GET "/api/threads/$MAIL_THREAD")" = 200 ] || { echo "FAIL: the shared token can't read a thread with no box"; exit 1; }
# The human's palette search (/api/search) finds the human's mail for the CLI, and no agent's token
# gets any of it.
[ "$(status "$NEW_TOKEN" GET "/api/search?q=scoped")" = 200 ] || { echo "FAIL: $NEW's palette search failed"; exit 1; }
[ "$(body "$NEW_TOKEN" GET "/api/search?q=scoped" | grep -c '"kind":"thread"')" = 0 ] || { echo "FAIL: $NEW's palette search found the human's mail"; exit 1; }

# Settings (S-259): an agent reads them redacted, the shared token reads them whole, and no agent
# may write them (main's humanOnly). The peer's token and an MCP header are secrets here.
python3 - "$STAM_HOME/settings.json" <<'EOF4'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s["peers"] = [{"name": "secret-peer", "url": "http://127.0.0.1:9", "token": "PEERSECRET-identity"}]
s["mcpServers"] = {"remote-secret": {"url": "http://127.0.0.1:9/mcp", "headers": {"X-Api-Key": "HDRSECRET-identity"}, "auth": {"type": "oauth", "clientSecret": "CLIENTSECRET-identity"}}}
json.dump(s, open(p, "w"))
EOF4
AS_NEW=$(body "$NEW_TOKEN" GET /api/config/settings | python3 -c 'import json, sys; print(json.load(sys.stdin)["text"])')
printf %s "$AS_NEW" | grep -q 'PEERSECRET-identity\|HDRSECRET-identity\|CLIENTSECRET-identity' && { echo "FAIL: an agent read a secret in the settings"; exit 1; }
printf %s "$AS_NEW" | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); assert s["peers"][0]["token"] == "[redacted]" and s["peers"][0]["name"] == "secret-peer"; assert s["mcpServers"]["remote-secret"]["headers"]["X-Api-Key"] == "[redacted]"; assert s["mcpServers"]["remote-secret"]["auth"]["clientSecret"] == "[redacted]"' || { echo "FAIL: the redacted settings lost their shape or still hold a secret: $AS_NEW"; exit 1; }
SHARED_TEXT=$(body "$SHARED" GET /api/config/settings | python3 -c 'import json, sys; print(json.load(sys.stdin)["text"])')
printf %s "$SHARED_TEXT" | grep -q 'PEERSECRET-identity' || { echo "FAIL: the shared token can't read the peer's token"; exit 1; }
printf %s "$SHARED_TEXT" | grep -q 'HDRSECRET-identity' || { echo "FAIL: the shared token can't read an MCP header"; exit 1; }
[ "$(status "$NEW_TOKEN" GET "/api/config/registry")" = 200 ] || { echo "FAIL: $NEW can't read the registry"; exit 1; }
SETTINGS_TEXT=$(body "$SHARED" GET /api/config/settings | python3 -c 'import json, sys; print(json.load(sys.stdin)["text"])')
# An agent's write of the settings (chiefOfStaff set to itself) is a 403, and the file is unchanged.
SELF_COS=$(printf %s "$SETTINGS_TEXT" | python3 -c 'import json, sys; s = json.load(sys.stdin); s["chiefOfStaff"] = sys.argv[1]; print(json.dumps({"text": json.dumps(s, indent=2)}))' "$NEW")
[ "$(status "$NEW_TOKEN" POST /api/config/settings -H "$JSON" -d "$SELF_COS")" = 403 ] || { echo "FAIL: $NEW wrote the settings"; exit 1; }
[ "$(body "$SHARED" GET /api/config/settings | python3 -c 'import json, sys; print(json.loads(json.load(sys.stdin)["text"]).get("chiefOfStaff") != sys.argv[1])' "$NEW")" = True ] || { echo "FAIL: $NEW became the chief of staff through the settings"; exit 1; }

echo "PASS e2e-agent-identity"
