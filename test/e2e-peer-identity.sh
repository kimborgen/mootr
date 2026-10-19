#!/bin/sh
# An agent's identity across two machines, free (no models), S-239: two isolated daemons, "main"
# and "twin", peered. Agents are spawned on each (scripted, no model) and hold their own tokens.
# Checks:
#   - alice on main, with its own token, mails as itself to bob on twin (works), and as bob (403)
#   - the parent pa on main reads its child kid's inbox on twin; the unrelated stranger on main
#     gets 403; the shared token (a legacy caller) still reads it
#   - twin trusts the forwarded identity only from a peer: an agent token that names another agent
#     in x-stam-agent gets no more than its own, and a peer that names stranger gets 403
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    # The peer token (S-545) is made ahead of the daemon, which keeps an existing file.
    pt = f"{tmp}/{name}/peer-token"
    open(pt, "w").write(f"peer-token-{name}")
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip(), "peerToken": f"peer-token-{name}"}
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer(other)]
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
# api DAEMON METHOD PATH [BODY] [human]: with the shared token, the human header only when asked.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${5:+-H 'x-stam-human: 1'} ${4:+-d "$4"} "$_url$3"
}
# status TOKEN METHOD URL [curl args...]: the HTTP status of one request.
status() {
  _t=$1; _m=$2; _u=$3; shift 3
  curl -s -o /dev/null -w '%{http_code}' -X "$_m" -H "authorization: Bearer $_t" "$@" "$_u"
}
# The agent's own token, read from its daemon's tmux environment: token_of DAEMON ID
token_of() {
  on "$1" sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$2"
}
has_token() { [ -n "$(token_of "$1" "$2")" ]; }

BOSS=$(api main POST /api/register '{"name":"boss","role":"test","harness":"claude"}' x | jget "d['id']")
WORK="$TEST_TMP/work"; mkdir -p "$WORK"
spawn() { api "$1" POST /api/agents "$2" x | jget "d['id']"; }
ALICE=$(spawn main "{\"name\":\"alice\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}") || fail "alice didn't spawn"
STRANGER=$(spawn main "{\"name\":\"stranger\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}") || fail "stranger didn't spawn"
PA=$(spawn main "{\"name\":\"pa\",\"cwd\":\"$WORK\",\"parent\":\"boss\",\"prompt\":\"Say hello.\"}") || fail "pa didn't spawn"
BOB=$(spawn twin "{\"name\":\"bob\",\"machine\":\"twin\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}") || fail "bob didn't spawn"
KID=$(spawn twin "{\"name\":\"kid\",\"machine\":\"twin\",\"parent\":\"pa\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}") || fail "kid didn't spawn"
# main lists twin's agents by asking twin, which can answer late while it launches two agents.
kid_parent() { [ "$(api main GET /api/agents | jget "([a['parent_id'] for a in d if a['id']=='$KID'] or [''])[0]")" = "$PA" ]; }
wait_until kid_parent || fail "kid's parent on twin isn't pa"
for pair in "main $ALICE" "main $STRANGER" "main $PA" "twin $BOB" "twin $KID"; do
  set -- $pair
  wait_until has_token "$1" "$2"
done
ALICE_TOKEN=$(token_of main "$ALICE"); STRANGER_TOKEN=$(token_of main "$STRANGER")
PA_TOKEN=$(token_of main "$PA"); KID_TOKEN=$(token_of twin "$KID")
[ -n "$ALICE_TOKEN" ] && [ -n "$KID_TOKEN" ] || fail "an agent has no token"
SHARED_MAIN=$MAIN_TOKEN; SHARED_TWIN=$TWIN_TOKEN

JSON='content-type: application/json'
MAIL_AS_SELF="{\"from\":\"$ALICE\",\"to\":\"$BOB\",\"subject\":\"identity\",\"body\":\"from alice\"}"
MAIL_AS_BOB="{\"from\":\"$BOB\",\"to\":\"$ALICE\",\"subject\":\"identity\",\"body\":\"claiming bob\"}"

echo "-- an agent on main mails as itself to bob on twin, and as bob (403)"
[ "$(status "$ALICE_TOKEN" POST "$MAIN_URL/api/mail" -H "$JSON" -d "$MAIL_AS_SELF")" = 200 ] || fail "alice can't mail bob as itself"
[ "$(status "$ALICE_TOKEN" POST "$MAIN_URL/api/mail" -H "$JSON" -d "$MAIL_AS_BOB")" = 403 ] || fail "alice mailed as bob"

echo "-- a parent on main reads its child's inbox on twin; an unrelated agent is refused"
INBOX="/api/agents/$KID/inbox"
[ "$(status "$PA_TOKEN" GET "$MAIN_URL$INBOX")" = 200 ] || fail "pa can't read kid's inbox on twin"
[ "$(status "$STRANGER_TOKEN" GET "$MAIN_URL$INBOX")" = 403 ] || fail "stranger read kid's inbox on twin"
[ "$(status "$SHARED_MAIN" GET "$MAIN_URL$INBOX")" = 200 ] || fail "the shared token (legacy) can't read kid's inbox through main"

PEER_TWIN=$(cat "$TEST_TMP/twin/peer-token")
echo "-- twin honours a forwarded identity only from a peer, proved by its peer token (S-1064)"
# A peer's request names the agent it acts for: pa may read kid, stranger may not.
[ "$(status "$PEER_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $PA")" = 200 ] || fail "twin refused a peer's forwarded pa"
[ "$(status "$PEER_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $STRANGER")" = 403 ] || fail "twin let a peer's forwarded stranger read kid"
# An agent token can't set local, so a claimed x-stam-agent is ignored on main: stranger stays stranger.
[ "$(status "$STRANGER_TOKEN" GET "$MAIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $PA")" = 403 ] || fail "a stranger's token claimed pa through x-stam-agent"
# The identity a peer forwards is checked against the body too: it can't mail as another agent.
[ "$(status "$PEER_TWIN" POST "$TWIN_URL/api/mail" -H "$JSON" -H 'x-stam-local: 1' -H "x-stam-agent: $ALICE" -d "$MAIL_AS_BOB")" = 403 ] || fail "a forwarded alice mailed as bob"

echo "-- the shared token can't forward an agent, on any route, while the legacy path is on (S-1064)"
FORGE="-H x-stam-local:1 -H x-stam-agent:$PA -H x-stam-agent-boss:1 -H x-stam-agent-assistant:1"
# shellcheck disable=SC2086
{
[ "$(status "$SHARED_TWIN" GET "$TWIN_URL$INBOX" $FORGE)" = 403 ] || fail "forged agent read an inbox"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/mail" -H "$JSON" $FORGE -d "{\"from\":\"$PA\",\"to\":\"$KID\",\"subject\":\"forged\",\"body\":\"x\"}")" = 403 ] || fail "forged agent sent mail"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/itsas/S-1/set" -H "$JSON" $FORGE -d "{\"by\":\"$PA\",\"status\":\"done\"}")" = 403 ] || fail "forged agent set an ITSA"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/agents" -H "$JSON" $FORGE -d "{\"by\":\"$PA\",\"name\":\"forged\",\"cwd\":\"$WORK\",\"prompt\":\"x\"}")" = 403 ] || fail "forged agent spawned"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/agents/$KID/control" -H "$JSON" $FORGE -d "{\"by\":\"$PA\",\"action\":\"pause\"}")" = 403 ] || fail "forged agent controlled an agent"
}
# x-stam-local alone is no better: it would skip the identity check on body by/from and make the caller the chief of staff.
[ "$(status "$SHARED_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1')" = 403 ] || fail "the shared token with x-stam-local alone was accepted"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/agents/$KID/pause" -H "$JSON" -H 'x-stam-local: 1' -d "{\"by\":\"$PA\"}")" = 403 ] || fail "the shared token with x-stam-local paused kid as pa"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/mail" -H "$JSON" -H 'x-stam-local: 1' -d "{\"from\":\"$PA\",\"to\":\"$KID\",\"subject\":\"forged\",\"body\":\"x\"}")" = 403 ] || fail "the shared token with x-stam-local mailed as pa"
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/agents/$KID/kill" -H "$JSON" -H 'x-stam-local: 1' -d '{}')" = 403 ] || fail "the shared token with x-stam-local and no by killed kid"

echo "-- twin lets a forwarded assistant rename an agent, but not a forwarded boss or stranger (S-321)"
RENAME="{\"by\":\"$ALICE\",\"name\":\"kid2\"}"
[ "$(status "$PEER_TWIN" POST "$TWIN_URL/api/agents/$KID/rename" -H "$JSON" -H 'x-stam-local: 1' -H "x-stam-agent: $ALICE" -d "$RENAME")" = 403 ] || fail "twin let a forwarded stranger rename"
[ "$(status "$PEER_TWIN" POST "$TWIN_URL/api/agents/$KID/rename" -H "$JSON" -H 'x-stam-local: 1' -H "x-stam-agent: $ALICE" -H 'x-stam-agent-boss: 1' -d "$RENAME")" = 403 ] || fail "twin let a forwarded chief of staff rename"
[ "$(status "$PEER_TWIN" POST "$TWIN_URL/api/agents/$KID/rename" -H "$JSON" -H 'x-stam-local: 1' -H "x-stam-agent: $ALICE" -H 'x-stam-agent-boss: 1' -H 'x-stam-agent-assistant: 1' -d "$RENAME")" = 200 ] || fail "twin refused a forwarded assistant's rename"

echo "-- the shared token can't name an agent on the peer either (S-545)"
# main remembered kid (twin's) when it listed agents; kid holds its own token, so a claim of it is a 403.
[ "$(status "$SHARED_MAIN" POST "$MAIN_URL/api/mail" -H "$JSON" -d "{\"from\":\"$KID\",\"to\":\"$PA\",\"subject\":\"identity\",\"body\":\"claiming kid\"}")" = 403 ] || fail "the shared token on main named kid, an agent on twin"

echo "-- the peer token, not the shared token, proves a peer (S-545)"
[ "$(status "$PEER_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $PA")" = 200 ] || fail "twin refused the peer token's forwarded pa"
[ "$(status "$PEER_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $STRANGER")" = 403 ] || fail "twin let the peer token forward stranger"
python3 - "$TEST_TMP/twin/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
s.setdefault("auth", {})["legacyPeerToken"] = False
json.dump(s, open(sys.argv[1], "w"), indent=2)
PY
# auth.legacyPeerToken no longer matters (S-1064): turned off or not, the shared token with the peer headers is refused.
[ "$(status "$SHARED_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $STRANGER")" = 403 ] || fail "the shared token with x-stam-agent still acted as stranger"
[ "$(status "$SHARED_TWIN" GET "$TWIN_URL/api/config/settings/shared" -H 'x-stam-local: 1')" = 403 ] || fail "the shared token with x-stam-local reached a peer-only route"
[ "$(status "$PEER_TWIN" GET "$TWIN_URL$INBOX" -H 'x-stam-local: 1' -H "x-stam-agent: $STRANGER")" = 403 ] || fail "the peer token lost its forwarding with the legacy path off"
# main forwards pa to twin with its peer token (twin's legacy path is off): pa still reads kid.
[ "$(status "$PA_TOKEN" GET "$MAIN_URL$INBOX")" = 200 ] || fail "main can't forward pa to twin with the peer token"
# A forwarded assistant (S-321) comes only from a peer: with the legacy path off, the shared token with the
# same headers is a plain CLI caller that can't name alice, and the peer token still carries it.
[ "$(status "$SHARED_TWIN" POST "$TWIN_URL/api/agents/$KID/rename" -H "$JSON" -H 'x-stam-local: 1' -H "x-stam-agent: $ALICE" -H 'x-stam-agent-boss: 1' -H 'x-stam-agent-assistant: 1' -d "$RENAME")" = 403 ] || fail "the shared token with the assistant headers still renamed"
[ "$(status "$PEER_TWIN" POST "$TWIN_URL/api/agents/$KID/rename" -H "$JSON" -H 'x-stam-local: 1' -H "x-stam-agent: $ALICE" -H 'x-stam-agent-boss: 1' -H 'x-stam-agent-assistant: 1' -d "{\"by\":\"$ALICE\",\"name\":\"kid3\"}")" = 200 ] || fail "the peer token's forwarded assistant couldn't rename"

echo "-- a box on the peer is authorized before anything is read here (S-263)"
# BCHILD is a child of pa, on twin. It mails agent c on main, so main holds a local copy of the mail
# (stored with its recipient). Only then can a refused read show that main didn't return it.
C=$(spawn main "{\"name\":\"c\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}") || fail "c didn't spawn"
BCHILD=$(spawn twin "{\"name\":\"bchild\",\"machine\":\"twin\",\"parent\":\"pa\",\"cwd\":\"$WORK\",\"prompt\":\"Say hello.\"}") || fail "bchild didn't spawn"
wait_until has_token twin "$BCHILD"
BCHILD_TOKEN=$(token_of twin "$BCHILD")
SENT=$(curl -s -X POST -H "authorization: Bearer $BCHILD_TOKEN" -H "$JSON" -d "{\"from\":\"$BCHILD\",\"to\":\"$C\",\"subject\":\"s263\",\"body\":\"s263secret\"}" "$TWIN_URL/api/mail")
THREAD=$(printf '%s' "$SENT" | jget "d['thread_id']") || fail "bchild's mail to c wasn't sent"
SEARCH="/api/mail/search?box=$BCHILD&q=s263secret"
# Main holds the copy: pa, the parent, finds it locally.
PA_HITS=$(curl -s -H "authorization: Bearer $PA_TOKEN" "$MAIN_URL$SEARCH" | jget "len(d)") || fail "pa's search failed"
[ "$PA_HITS" -ge 1 ] || fail "main holds no local copy of bchild's mail"
[ "$(status "$STRANGER_TOKEN" GET "$MAIN_URL$SEARCH")" = 403 ] || fail "stranger searched bchild's mail through main"
[ "$(status "$STRANGER_TOKEN" GET "$MAIN_URL/api/threads/$THREAD?box=$BCHILD")" = 403 ] || fail "stranger read bchild's thread through main"
[ "$(status "$ALICE_TOKEN" GET "$MAIN_URL$SEARCH")" = 403 ] || fail "alice searched bchild's mail through main"
[ "$(status "$PA_TOKEN" GET "$MAIN_URL/api/threads/$THREAD?box=$BCHILD")" = 200 ] || fail "pa can't read bchild's thread"
[ "$(status "$SHARED_MAIN" GET "$MAIN_URL$SEARCH")" = 200 ] || fail "the shared token can't search bchild's mail"

echo "ok: peer identity"
