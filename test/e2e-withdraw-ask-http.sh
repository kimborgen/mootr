#!/bin/sh
# withdraw_ask through the HTTP route (S-425), free (no models). One isolated daemon. Each call is made
# with the token a real caller holds: an agent's own token, a stranger agent's, and the OpenCode server's.
# Checks:
#   - a stranger agent is refused (403), and its decision mail still waits
#   - the OpenCode server's token, with no named agent, is refused (403)
#   - the OpenCode server acts as its named agent: the sender's parent may withdraw (200), and the human's
#     copy carries who did and why
#   - a decision the human deferred (Decide later) is refused (409) and stays listed, with its copy
#   - the sender's own token withdraws its decision mail (200), and it leaves /api/mail/decisions
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/idle.json" <<'EOF2'
{ "turns": [ { "match": "", "steps": [ { "reply": "OK" } ] } ] }
EOF2
fake_claude "$TEST_TMP/idle.json"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
SHARED=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
# call TOKEN METHOD PATH [BODY] [human]: the body of the answer; `code` the status alone.
call() {
  _h=; [ "$5" = human ] && _h='-H x-stam-human:1'
  curl -s -X "$2" -H "authorization: Bearer $1" $_h -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$3"
}
code() {
  curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$3"
}
id_of() {
  call "$SHARED" GET /api/agents | python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$1"
}
# The STAM_TOKEN in an agent's tmux session; the OpenCode server's is in its _opencode session.
token_of() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-; }
has_token() { [ -n "$(token_of "$1")" ]; }
listed() { call "$SHARED" GET /api/mail/decisions | jget "[x['mail_id'] for x in d].count('$1')"; }

# A manager mails the human directly; any other agent's mail to the human goes to its parent (S-548).
"$STAM" spawn wa-kid --type manager --model claude-opus-5-5 --cwd "$DIR" "Say hello." >/dev/null
"$STAM" spawn wa-stranger --model claude-haiku-5-5 --cwd "$DIR" "Say hello." >/dev/null
"$STAM" spawn wa-oc --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello." >/dev/null
KID=$(id_of wa-kid)
STRANGER=$(id_of wa-stranger)
OC=$(id_of wa-oc)
wait_until has_token "$KID"
wait_until has_token "$STRANGER"
KID_TOKEN=$(token_of "$KID")
STRANGER_TOKEN=$(token_of "$STRANGER")
OC_TOKEN=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t _opencode STAM_TOKEN 2>/dev/null | cut -d= -f2-)
[ -n "$OC_TOKEN" ] || fail "the OpenCode server has no token"
call "$SHARED" POST "/api/agents/$KID/set-parent" "{\"parent\":\"$OC\"}" >/dev/null

# Decision mails from the sender's own token: the first two, and one the human will defer.
PICK='Which one?\n\n```pick\nship\nhold\n```'
# send SUBJECT: the sender's decision mail to the human; sets M and T, its id and thread.
send() {
  _r=$(call "$KID_TOKEN" POST /api/mail "{\"to\":[\"human\"],\"subject\":\"$1\",\"body\":\"$PICK\"}")
  M=$(printf '%s' "$_r" | jget "d.get('id', '')"); T=$(printf '%s' "$_r" | jget "d.get('thread_id', '')")
  [ -n "$M" ] || fail "the mail wasn't sent: $_r"
}
send "Pick one"; M1=$M; T1=$T
send "Pick two"; M2=$M; T2=$T
send "Pick three"; M3=$M
[ "$(listed "$M1")" = 1 ] && [ "$(listed "$M2")" = 1 ] && [ "$(listed "$M3")" = 1 ] || fail "the decision mails aren't listed"

echo "-- a stranger agent is refused, and its mail still waits"
[ "$(code "$STRANGER_TOKEN" POST "/api/mail/$M1/withdraw-ask" '{"note":"x"}')" = 403 ] || fail "a stranger withdrew the ask"
[ "$(listed "$M1")" = 1 ] || fail "a refused ask left the list"

echo "-- the OpenCode server's token needs a named agent"
[ "$(code "$OC_TOKEN" POST "/api/mail/$M1/withdraw-ask" '{"note":"x"}')" = 403 ] || fail "the OpenCode server withdrew with no named agent"
[ "$(listed "$M1")" = 1 ] || fail "the unnamed call left the list"

echo "-- the OpenCode server acts as its named agent: the sender's parent withdraws"
[ "$(code "$OC_TOKEN" POST "/api/mail/$M1/withdraw-ask" "{\"by\":\"$OC\",\"note\":\"answered in the terminal\"}")" = 200 ] || fail "the sender's parent couldn't withdraw through the OpenCode server"
[ "$(listed "$M1")" = 0 ] || fail "the withdrawn ask is still listed"
COPY=$(call "$SHARED" GET "/api/threads/$T1?box=human" | jget "__import__('json').dumps([r for m in d if m['id']=='$M1' for r in m['recipients'] if r['id']=='human'][0])")
printf '%s' "$COPY" | jget "d['withdrawn_note']" | grep -q "Withdrawn by @wa-oc: answered in the terminal" || fail "the note is wrong: $COPY"

echo "-- the human deferred M2 (Decide later): the sender can't withdraw it, and it stays with its copy"
call "$SHARED" POST /api/mail "{\"from\":\"human\",\"to\":[\"$KID\"],\"subject\":\"Re: Pick two\",\"body\":\"Deferring this one: still open, I'll decide later.\",\"reply_to\":\"$M2\"}" human >/dev/null
[ "$(code "$KID_TOKEN" POST "/api/mail/$M2/withdraw-ask" '{"note":"moot"}')" = 409 ] || fail "a deferred decision was withdrawn"
[ "$(listed "$M2")" = 1 ] || fail "the deferred decision left the list"
COPY2=$(call "$SHARED" GET "/api/threads/$T2?box=human" | jget "__import__('json').dumps([r for m in d if m['id']=='$M2' for r in m['recipients'] if r['id']=='human'][0])")
printf '%s' "$COPY2" | jget "d.get('withdrawn_at')" | grep -q None || fail "the deferred copy was withdrawn: $COPY2"

echo "-- the sender's own token withdraws its decision mail"
[ "$(code "$KID_TOKEN" POST "/api/mail/$M3/withdraw-ask" '{"note":"answered in the terminal"}')" = 200 ] || fail "the sender couldn't withdraw its own ask"
[ "$(listed "$M3")" = 0 ] || fail "the sender's withdrawn ask is still listed"

echo "PASS: withdraw-ask over HTTP"
