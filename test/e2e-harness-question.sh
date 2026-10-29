#!/bin/sh
# A question dialog, Claude Code's AskUserQuestion, is an ask like any other harness dialog (S-3978).
# Its hook makes a permission request whose mail shows the question and its numbered options. The
# human's choice types that option's number into the dialog, and the agent gets the choice back as the
# tool's answer. A choice the dialog doesn't show, a dialog gone from the screen (answered there, say),
# or a free-text answer types nothing: the request stays pending or closes as 'gone'. A deny types Esc.
# Fake Claude Code (test/fake-claude): no model, free. Waits on state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/question.json" <<'EOF2'
{ "turns": [
  { "match": "QMULTI", "steps": [
    { "ask": "Which folders should the backup include?", "multiSelect": true, "options": ["Alpha", "Beta"] },
    { "reply": "MULTI-${answer}" } ] },
  { "match": "QASK", "steps": [
    { "ask": "Which folder should I use?", "options": ["Alpha", "Beta"] },
    { "reply": "ASKED-${answer}" } ] },
  { "match": "QTWO", "steps": [
    { "ask": "Which folder should I use?", "options": ["Alpha", "Beta"] },
    { "reply": "ASKED-${answer}" } ] },
  { "match": "QTHREE", "steps": [
    { "ask": "Which folder should I use?", "options": ["Alpha", "Beta"] },
    { "reply": "ASKED-${answer}" } ] },
  { "match": "Lead", "steps": [ { "reply": "LEADING" } ] } ] }
EOF2
fake_claude "$TEST_TMP/question.json"
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
aid() { "$STAM" show "$1" | grep -m1 '"id"' | cut -d'"' -f4; }
pending() { api GET '/api/permissions?status=pending' | python3 -c 'import json,sys; print("\n".join(r["id"] for r in json.load(sys.stdin)))'; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
status() { api GET /api/permissions | python3 -c 'import json,sys; print(next(r["status"] for r in json.load(sys.stdin) if r["id"] == sys.argv[1]))' "$1"; }
# The kid's screen: how many times the reply line shows each answer.
picked() { tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -S -300 -t "=$KID:" | grep -c "⎿ $1"; }
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"

"$STAM" spawn lead --cwd "$DIR" "Lead" >/dev/null
"$STAM" wait lead --until idle --timeout 60 >/dev/null
"$STAM" spawn kid --cwd "$DIR" --parent lead "QASK one" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
KID=$(aid kid)
has_one() { [ "$(pending | wc -l)" = 1 ]; }
wait_until has_one
P1=$(pending)

echo "-- the question becomes one request, with its options in the mail"
api GET '/api/permissions?status=pending' | grep -q 'Claude Code asks a question' || fail "the request doesn't name the question as its action"
api GET '/api/permissions?status=pending' | python3 -c 'import json,sys; sys.exit("Which folder" in next(r["action"] for r in json.load(sys.stdin)))' || fail "the request's action carries the question text"
LEAD=$(aid lead)
mailed() { as_agent "$LEAD" GET "/api/agents/$LEAD/threads?limit=20" | grep -q "$P1"; }
wait_until mailed
MAIL=$(as_agent "$LEAD" GET "/api/agents/$LEAD/threads?limit=20")
echo "$MAIL" | grep -q 'asks: Which folder should I use?' || fail "the mail doesn't carry the question: $MAIL"
echo "$MAIL" | grep -q '2. Beta' || fail "the mail doesn't number the options: $MAIL"

echo "-- an option the dialog doesn't show types nothing"
ERR=$(hapi POST "/api/permissions/$P1/answer" '{"approve":true,"note":"Gamma"}')
echo "$ERR" | grep -q "nothing was typed" || fail "a choice the dialog doesn't show was typed: $ERR"
[ "$(status "$P1")" = pending ] || fail "request $P1 is $(status "$P1") after a refused choice"
echo "-- a free-text answer types nothing either"
ERR=$(hapi POST "/api/permissions/$P1/answer" '{"approve":true}')
echo "$ERR" | grep -q "nothing was typed" || fail "an answer with no choice was typed: $ERR"
[ "$(picked 'Alpha')$(picked 'Beta')" = 00 ] || fail "the dialog got an answer before a choice was given"

echo "-- the human's choice types its number into the dialog"
hapi POST "/api/permissions/$P1/answer" '{"approve":true,"note":"Beta"}' | grep -q '"typed":true' || fail "the choice wasn't typed"
"$STAM" wait kid --until idle --timeout 60 >/dev/null
"$STAM" show kid | grep -q 'ASKED-Beta' || fail "the dialog wasn't answered Beta: $("$STAM" show kid)"
[ "$(status "$P1")" = approved ] || fail "request $P1 is $(status "$P1")"

echo "-- a dialog answered in the terminal closes its request, and a later choice types nothing"
"$STAM" mail send --to kid --subject "QTWO two" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P2=$(pending)
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" Enter
withdrawn() { [ "$(status "$P2")" = withdrawn ]; }
wait_until withdrawn
"$STAM" wait kid --until idle --timeout 60 >/dev/null
ERR=$(hapi POST "/api/permissions/$P2/answer" '{"approve":true,"note":"Beta"}' 2>&1 || true)
echo "$ERR" | grep -q "withdrawn\|closed\|nothing was typed" || fail "a choice for a gone dialog didn't say so: $ERR"
[ "$(picked 'Beta')" = 1 ] || fail "a choice typed into a dialog that was gone"
[ "$(picked 'Alpha')" = 1 ] || fail "the terminal's Enter didn't answer Alpha"

echo "-- a deny types Esc, and the agent carries on"
"$STAM" mail send --to kid --subject "QTHREE three" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P3=$(pending)
"$STAM" deny "$P3" >/dev/null
[ "$(status "$P3")" = denied ] || fail "request $P3 is $(status "$P3")"
"$STAM" wait kid --until idle --timeout 60 >/dev/null
echo "-- a multi-select question has no choice: a digit only toggles an option, so nothing is typed"
"$STAM" mail send --to kid --subject "QMULTI four" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P4=$(pending)
ERR=$(hapi POST "/api/permissions/$P4/answer" '{"approve":true,"note":"Alpha"}')
echo "$ERR" | grep -q "nothing was typed" || fail "a choice for a multi-select question was typed: $ERR"
[ "$(status "$P4")" = pending ] || fail "request $P4 is $(status "$P4") after a refused multi-select choice"
"$STAM" deny "$P4" >/dev/null
[ "$(status "$P4")" = denied ] || fail "request $P4 is $(status "$P4")"
"$STAM" wait kid --until idle --timeout 60 >/dev/null
echo "PASS e2e-harness-question"
