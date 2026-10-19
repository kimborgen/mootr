#!/bin/sh
# auth.humanStrict (S-543, C2 of S-426): with it on, the shared token plus x-stam-human is not the
# human. Refused (403): an ITSA human act, an agent kill with no `by`, a wait with no `by`, mail
# `from: human` (also forwarded by the shared token), a thread archive and a spawn with no `by`, a
# permission answer, and a terminal socket opened with ?token=. The test key (stand-in for tailscale
# serve) still passes, a deploy-watch system sender still acts with the shared token (mail and the ITSA
# path), the peer token forwards mail but opens no terminal socket, and a CLI refusal names the web UI.
# auth.legacyPeerToken no longer gates strict (S-1064). With strict off behavior is
# unchanged and the daemon logs a line for each request strict would refuse. Free: registered agents.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# setauth STRICT LEGACY: auth.humanStrict and auth.legacyPeerToken in main's settings.
setauth() { python3 - "$TEST_TMP/main/settings.json" "$1" "$2" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s.setdefault('auth', {}).update({'humanStrict': sys.argv[2] == 'true', 'legacyPeerToken': sys.argv[3] == 'true'})
json.dump(s, open(p, 'w'))
PY
}
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
restart() { on main "$STAM" daemon stop >/dev/null 2>&1 || true; setauth "$1" "$2"; daemon_up main; TOKEN=$(cat "$TEST_TMP/main/token"); }
J='content-type: application/json'
KEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
# upgrade PATH [curl args]: whether a terminal socket upgrade is accepted (a 101), as yes or no.
upgrade() {
  _p=$1; shift
  _o=$(curl -s -i -m 4 -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' "$@" "$URL$_p" 2>/dev/null || true) # gitleaks:allow (RFC 6455's sample nonce)
  case "$_o" in *' 101 '*) echo yes ;; *) echo no ;; esac
}
# checks W: W is 200 with strict not in effect, 403 with it in effect, for the paths the shared token
# plus x-stam-human (or no header at all) used to pass.
checks() {
  W=$1; H1="authorization: Bearer $TOKEN"
  [ "$(code -X POST -H "$H1" -H "$J" -H 'x-stam-human: 1' -d '{"title":"strict probe"}' "$URL/api/itsas")" = "$W" ] || fail "ITSA create as the human wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -H 'x-stam-human: 1' -d "{\"from\":\"human\",\"to\":\"$A\",\"subject\":\"s\",\"body\":\"b\"}" "$URL/api/mail")" = "$W" ] || fail "mail from human wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -d "{\"from\":\"human\",\"forwarded\":{\"from_name\":\"x\"},\"to\":\"$A\",\"subject\":\"s\",\"body\":\"b\"}" "$URL/api/mail")" = "$W" ] || fail "mail from human forwarded by the shared token wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -d '{"kind":"x"}' "$URL/api/agents/$A/waits")" = "$W" ] || fail "a wait with no by wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -d '{}' "$URL/api/agents/$A/threads/t1/archive")" = "$W" ] || [ "$W" = 200 ] || fail "a thread archive with no by wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -d '{"name":"spawned","harness":"none"}' "$URL/api/agents")" = "$W" ] || [ "$W" = 200 ] || fail "a spawn with no by wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -d '{"child_notices":"none"}' "$URL/api/agents/$B2/set-child-notices")" = "$W" ] || fail "agent control with no by wasn't $W: $(cat "$TEST_TMP/body")"
  [ "$(code -X POST -H "$H1" -H "$J" -H 'x-stam-human: 1' -d '{}' "$URL/api/agents/$B/kill")" = "$W" ] || fail "kill with no by wasn't $W: $(cat "$TEST_TMP/body")"
}
setauth false true
daemon_up main
URL=$(on main sh -c 'echo "$STAM_URL"')
TOKEN=$(cat "$TEST_TMP/main/token")
reg() { curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H 'x-stam-human: 1' -d "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" "$URL/api/register" | jget "d['id']"; }
SH=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H 'x-stam-human: 1' -d '{}' "$URL/api/shells" | jget "d['id']")
[ -n "$SH" ] || fail "no terminal started"
A=$(reg alpha); B=$(reg beta); B2=$(reg gamma)
[ -n "$A" ] && [ -n "$B" ] && [ -n "$B2" ] || fail "agents didn't register"
LOG="$TEST_TMP/main/daemon.log"

echo "-- strict off: the old rule stands, and the log names what strict would refuse"
checks 200
grep -q 'auth.humanStrict would refuse: POST /api/itsas ' "$LOG" || fail "no would-refuse line for the ITSA create"
[ "$(grep -c 'would refuse: POST /api/itsas ' "$LOG")" = 1 ] || fail "the would-refuse line wasn't logged once"
grep -q 'would refuse: forwarded mail from the human, not from a peer' "$LOG" || fail "no line for forwarded mail from the human"
grep -q 'would refuse: waits with no by' "$LOG" || fail "no line for a wait with no by (sent without x-stam-human)"
grep -q 'would refuse: agent control with no by' "$LOG" || fail "no line for agent control with no by"
grep -q 'would refuse: thread archive with no by' "$LOG" || fail "no line for a thread archive with no by"
grep -q 'would refuse: spawn with no by' "$LOG" || fail "no line for a spawn with no by"
upgrade "/api/shells/$SH/tty?token=$TOKEN" >/dev/null
grep -q 'would refuse: terminal socket opened with ?token=' "$LOG" || fail "no line for a terminal socket opened with ?token="
# A token-less answer from a browser that serve didn't vouch for is refused, and the log says which check failed (S-426).
[ "$(code -X POST -H 'origin: https://other.example' -H "$J" -H 'x-stam-human: 1' -d '{"approve":true}' "$URL/api/permissions/p000000/answer")" = 401 ] || fail "a token-less permission answer wasn't 401"
grep -q 'direct request refused: POST /api/permissions/:id/answer origin=https://other.example: ' "$LOG" || fail "no log line for the refused direct answer"

echo "-- strict on, legacyPeerToken off: the shared token with x-stam-human is not the human"
restart true false
checks 403
grep -q 'auth.humanStrict refuses: POST /api/itsas ' "$LOG" || fail "strict on: no refuses line for the ITSA create: $(grep humanStrict "$LOG")"
H1="authorization: Bearer $TOKEN"
[ "$(code -X POST -H "$KEY" -H "$J" -H 'x-stam-human: 1' -H "$H1" -d '{"title":"strict probe"}' "$URL/api/itsas")" = 200 ] || fail "the test key's ITSA create was refused: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$KEY" -H "$J" -H 'x-stam-human: 1' -H "$H1" -d "{\"from\":\"human\",\"to\":\"$A\",\"subject\":\"s\",\"body\":\"b\"}" "$URL/api/mail")" = 200 ] || fail "the test key's mail from human was refused: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$KEY" -H "$J" -H "$H1" -d '{"name":"spawned2","harness":"claude"}' "$URL/api/agents")" = 200 ] || fail "the test key's spawn was refused: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$H1" -H "$J" -H 'x-stam-human: 1' -d '{"approve":true}' "$URL/api/permissions/p000000/answer")" = 403 ] || fail "a permission answer via x-stam-human wasn't 403: $(cat "$TEST_TMP/body")"
# The deploy watcher's system sender passes with the shared token, on mail and on the ITSA path; no other does.
[ "$(code -X POST -H "$H1" -H "$J" -d "{\"system\":\"deploy-watch\",\"to\":\"$A\",\"subject\":\"s\",\"body\":\"b\"}" "$URL/api/mail")" = 200 ] || fail "the deploy watcher's system mail was refused: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$H1" -H "$J" -d "{\"system\":\"someone-else\",\"to\":\"$A\",\"subject\":\"s\",\"body\":\"b\"}" "$URL/api/mail")" = 403 ] || fail "another system sender mailed"
[ "$(code -X POST -H "$H1" -H "$J" -d '{"body":"deployed","as_system":"deploy-watch"}' "$URL/api/itsas/S-1/post")" = 200 ] || fail "the deploy watcher's ITSA post was refused: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$H1" -H "$J" -d '{"body":"x","as_system":"someone-else"}' "$URL/api/itsas/S-1/post")" = 403 ] || fail "another system sender posted to an ITSA"
# The peer token forwards mail from the human; the shared token with x-stam-local does not.
PEERTOKEN=$(cat "$TEST_TMP/main/peer-token")
FWD="{\"from\":\"human\",\"forwarded\":{\"from_name\":\"kim\"},\"to\":\"$A\",\"subject\":\"fwd\",\"body\":\"b\"}"
[ "$(code -X POST -H "authorization: Bearer $PEERTOKEN" -H 'x-stam-local: 1' -H "$J" -d "$FWD" "$URL/api/mail")" = 200 ] || fail "mail forwarded with the peer token was refused: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$H1" -H 'x-stam-local: 1' -H "$J" -d "$FWD" "$URL/api/mail")" = 403 ] || fail "mail forwarded by the shared token with x-stam-local passed"
# Terminal sockets: the test key opens one; ?token= with the shared or the peer token does not (S-638).
[ "$(upgrade "/api/shells/$SH/tty?token=$PEERTOKEN")" = no ] || fail "the peer token opened a terminal socket under strict"
[ "$(upgrade "/api/shells/$SH/tty" -H "$KEY")" = yes ] || fail "the test key didn't open a terminal socket"
[ "$(upgrade "/api/shells/$SH/tty?token=$TOKEN")" = no ] || fail "?token= opened a terminal socket under strict"
# A ticket (S-742) carries the human's proof: bought with the test key it opens a socket, bought with the shared token it isn't sold.
TT=$(curl -s -X POST -H "$KEY" -H "$J" -H 'x-stam-human: 1' -d "{\"kind\":\"tty\",\"path\":\"/api/shells/$SH/tty\"}" "$URL/api/tickets" | jget "d['ticket']")
[ "$(upgrade "/api/shells/$SH/tty?ticket=$TT" -H "$KEY")" = yes ] || fail "a human's ticket didn't open a terminal socket under strict"
[ "$(code -X POST -H "$H1" -H "$J" -H 'x-stam-human: 1' -d "{\"kind\":\"tty\",\"path\":\"/api/shells/$SH/tty\"}" "$URL/api/tickets")" = 403 ] || fail "the shared token bought a ticket under strict"
# The CLI as the human gets a refusal that names the web UI.
OUT=$(on main "$STAM" authorize p000000 2>&1 || true)
case "$OUT" in *"answer from stam's web UI"*) ;; *) fail "the CLI's refusal doesn't name the web UI: $OUT";; esac

echo "-- strict off: ?token= still opens a terminal socket, and the CLI's refusals don't name the web UI"
restart false true
[ "$(upgrade "/api/shells/$SH/tty?token=$TOKEN")" = yes ] || fail "?token= didn't open a terminal socket with strict off"
[ "$(upgrade "/api/shells/$SH/tty?token=$PEERTOKEN")" = yes ] || fail "the peer token didn't open a terminal socket with strict off"
OUT=$(on main "$STAM" authorize p000000 2>&1 || true)
case "$OUT" in *"answer from stam's web UI"*) fail "the CLI named the web UI with strict off: $OUT";; esac
curl -s -o /dev/null -X POST -H "$KEY" -H "$J" -H "authorization: Bearer $TOKEN" -d '{}' "$URL/api/shells/$SH/kill" || true
echo PASS
