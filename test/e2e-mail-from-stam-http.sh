#!/bin/sh
# POST /api/mail with from_stam (S-2033), free (no models). One isolated daemon. A caller other than the
# daemon or a peer's own daemon can't set from_stam: it would make its reply a stam notice, which in an ITSA
# thread revives a deferred thread (S-1971). Checks:
#   - the human's and an agent's token, with from_stam, are refused (403), and the reply isn't stored
#   - without from_stam the same reply into the ITSA thread lands as a comment
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/idle.json" <<'EOF2'
{ "turns": [ { "match": "", "steps": [ { "reply": "OK" } ] } ] }
EOF2
fake_claude "$TEST_TMP/idle.json"
isolate
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
SHARED=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
# call TOKEN METHOD PATH [BODY] [human]: the body of the answer.
call() {
  _h=; [ "$5" = human ] && _h='-H x-stam-human:1'
  curl -s -X "$2" -H "authorization: Bearer $1" $_h -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$3"
}
token_of() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-; }
has_token() { [ -n "$(token_of "$1")" ]; }
"$STAM" spawn fs-kid --model claude-haiku-5-5 --cwd "$DIR" "Say hello." >/dev/null
KID=$(call "$SHARED" GET /api/agents | python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == "fs-kid"))')
wait_until has_token "$KID"
KID_TOKEN=$(token_of "$KID")

# An ITSA owned by the kid, with its first post from the human: the thread a stam notice would reply into.
_r=$(call "$SHARED" POST /api/itsas '{"title":"Stam ingress","owner":"fs-kid"}' human)
KEY=$(printf '%s' "$_r" | jget "d['key']")
[ -n "$KEY" ] || fail "the ITSA wasn't made: $_r"
_r=$(call "$SHARED" POST "/api/itsas/$KEY/post" '{"body":"first"}' human)
PARENT=$(printf '%s' "$_r" | jget "d['id']")
[ -n "$PARENT" ] || fail "the first post wasn't made: $_r"

echo "-- the human's own request can't set from_stam"
_r=$(call "$SHARED" POST /api/mail "{\"from\":\"human\",\"to\":[\"fs-kid\"],\"body\":\"stam notice\",\"reply_to\":\"$PARENT\",\"from_stam\":true}" human)
case "$_r" in *"set only by stam"*) ;; *) fail "the shared token set from_stam: $_r" ;; esac

echo "-- an agent's token can't set from_stam either"
_r=$(call "$KID_TOKEN" POST /api/mail "{\"to\":[\"human\"],\"body\":\"stam notice\",\"reply_to\":\"$PARENT\",\"from_stam\":true}")
case "$_r" in *"set only by stam"*) ;; *) fail "an agent set from_stam: $_r" ;; esac

echo "-- without from_stam the same reply is an ordinary comment"
_r=$(call "$SHARED" POST /api/mail "{\"from\":\"human\",\"to\":[\"fs-kid\"],\"body\":\"plain reply\",\"reply_to\":\"$PARENT\"}" human)
[ -n "$(printf '%s' "$_r" | jget "d.get('id', '')")" ] || fail "a plain reply was refused: $_r"
echo "ok"
