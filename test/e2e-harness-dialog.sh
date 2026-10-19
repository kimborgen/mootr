#!/bin/sh
# A harness dialog that blocks an agent reaches stam (S-276). Claude Code shows some dialogs
# even in auto mode, such as "Allow this read outside the working directories?", and the
# agent can't answer them itself. Its PermissionRequest hook makes a stam permission request:
# it goes to the agent's parent and the chief of staff first, who deny it or escalate it to the
# human, and to the human straight away when neither is live (S-520). The human's approval types
# Yes into the dialog, its parent's denial types Esc (No) and tells it why, a parent's approval is
# refused, and a dialog answered in the terminal closes it. A
# yes is typed only when the dialog names the request's tool and full target, and it picks a
# one-time yes by its text, never one that keeps allowing; with none, nothing is typed. A deny
# picks "No, and ask again next time" when offered, else Esc (S-320). A newer dialog gets its
# own request, and the same one reported again keeps its request, as does a tool run in
# parallel or the permission_prompt Notification that follows.
# Its settings also allow the test base folder, where test logs live.
# Fake Claude Code (test/fake-claude): no model, free. Waits on state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Turns match in order, and a pushed prompt can carry earlier mails' subjects, so the token a
# later section sends comes before the ones sent earlier.
cat >"$TEST_TMP/dialog.json" <<'EOF2'
{ "turns": [
  { "match": "KIDMENU", "steps": [
    { "permission": "Read", "input": { "file_path": "/elsewhere/menu.png" }, "options": [
      "Yes, and keep allowing any reads outside the working directories",
      "No, and block reads outside the working directories from now on",
      "No, and ask again next time",
      "Yes, but ask again next time" ] },
    { "reply": "MENU-${answer}" } ] },
  { "match": "KIDODD", "steps": [
    { "permission": "Read", "input": { "file_path": "/elsewhere/odd.log" }, "options": ["Yes, and don't ask again for odd.log", "No"] },
    { "reply": "ODD-${answer}" } ] },
  { "match": "KIDBASH", "steps": [
    { "permission": "Bash", "input": { "command": "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa one" } },
    { "reply": "BASH-${answer}" } ] },
  { "match": "KIDREAD", "steps": [
    { "permission": "Read", "input": { "file_path": "/elsewhere/.cache/kid.log" }, "output": "LOGTEXT" },
    { "reply": "READ-${answer}" } ] },
  { "match": "was denied", "steps": [ { "reply": "NOTED: ${prompt}" } ] },
  { "match": "Permission", "steps": [ { "reply": "SEEN" } ] },
  { "match": "Lead", "steps": [ { "reply": "LEADING" } ] } ] }
EOF2
fake_claude "$TEST_TMP/dialog.json"
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
aid() { "$STAM" show "$1" | grep -m1 '"id"' | cut -d'"' -f4; }
# Pending requests of either audience: `stam permissions` lists only the human's, and a dialog goes to the parent first.
pending() { api GET '/api/permissions?status=pending' | python3 -c 'import json,sys; print("\n".join(r["id"] for r in json.load(sys.stdin)))'; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
audience() { api GET /api/permissions | python3 -c 'import json,sys; print(next(r["audience"] for r in json.load(sys.stdin) if r["id"] == sys.argv[1]))' "$1"; }
status() { api GET /api/permissions | python3 -c 'import json,sys; print(next(r["status"] for r in json.load(sys.stdin) if r["id"] == sys.argv[1]))' "$1"; }
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"

"$STAM" spawn lead --cwd "$DIR" "Lead" >/dev/null
"$STAM" wait lead --until idle --timeout 60 >/dev/null
LEAD=$(aid lead)

echo "-- the dialog becomes one permission request, mailed to the parent first, not the human (S-520)"
"$STAM" spawn kid --cwd "$DIR" --parent lead "KIDREAD one" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
has_one() { [ "$(pending | wc -l)" = 1 ]; }
wait_until has_one
P1=$(pending)
api GET '/api/permissions?status=pending' | grep -q 'allow Read' || fail "the request doesn't name the tool: $(api GET '/api/permissions?status=pending')"
api GET '/api/permissions?status=pending' | grep -q 'kid.log' || fail "the request doesn't show the path"
mailed() { as_agent "$LEAD" GET "/api/agents/$LEAD/threads?limit=20" | grep -q "$P1"; }
wait_until mailed
[ "$(audience "$P1")" = delegate ] || fail "the dialog's audience is $(audience "$P1")"
hapi GET '/api/agents/human/threads?limit=100' | grep -q "$P1" && fail "the human got mail for a dialog the parent can decide"
MAIL=$(as_agent "$LEAD" GET "/api/agents/$LEAD/threads?limit=20")
echo "$MAIL" | grep -q 'wants to use Read' || fail "the dialog mail doesn't say in a line what the agent wants: $MAIL"
printf '%s' "$MAIL" | python3 -c 'import sys; sys.exit("```bash\n/elsewhere/.cache/kid.log\n```" not in sys.stdin.read().replace("\\n", "\n"))' || fail "the dialog mail doesn't show the target in its own block"
echo "$MAIL" | grep -q 'Who has looked' || fail "the dialog mail doesn't say who looked"
echo "$MAIL" | grep -q 'stam authorize' && fail "the dialog mail still carries the agent hint"
echo "$MAIL" | grep -q "came to @lead first" || fail "the parent's mail doesn't say it came to it first"
echo "$MAIL" | grep -q "answer_permission.*$P1" || fail "the parent's mail doesn't say how to answer"
printf '%s' "$MAIL" | python3 -c 'import json,sys; t=json.load(sys.stdin); bodies=[m.get("body","") for x in t for m in x.get("mails",[])]; sys.exit(any("\"tool\"" in b for b in bodies) or not any("kid.log" in b for b in bodies))' || fail "the dialog mail body shows raw JSON"

python3 -c 'import json,sys; sys.exit(sys.argv[2] not in json.load(open(sys.argv[1]))["permissions"]["additionalDirectories"])' "$STAM_HOME/agents/$(aid kid)/claude-settings.json" "$STAM_TEST_TMPDIR" || fail "the test folder isn't an allowed directory"

echo "-- a parent can't approve it but escalates it; the human's approval types Yes"
as_agent "$LEAD" POST "/api/permissions/$P1/answer" "{\"approve\":true,\"by\":\"$LEAD\"}" | grep -q 'escalate it to the human' || fail "the parent approved a dialog"
as_agent "$LEAD" POST "/api/permissions/$P1/answer" "{\"decision\":\"escalate\",\"by\":\"$LEAD\",\"note\":\"it needs that log\"}" | grep -q '"audience":"human"' || fail "the parent couldn't escalate the dialog"
hapi GET '/api/agents/human/threads?limit=100' | grep -q "@lead looked first and sent it on to you: it needs that log" || fail "the human didn't get the escalated dialog"
hapi GET '/api/agents/human/threads?limit=100' | grep -q 'kid asks to use Read: /elsewhere/.cache/kid.log' || fail "the escalated dialog mail doesn't read like the dialog mail"
"$STAM" authorize "$P1" >/dev/null
"$STAM" wait kid --until idle --timeout 60 >/dev/null
"$STAM" show kid | grep -q 'READ-Yes' || fail "the dialog wasn't answered Yes"
[ "$(status "$P1")" = approved ] || fail "request $P1 is $(status "$P1")"
api GET "/api/agents/$(aid kid)/waits" | grep -q "$P1" && fail "the approved request still holds a wait"

echo "-- the parent's denial types No, and the kid hears why"
"$STAM" mail send --to kid --subject "KIDREAD two" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P2=$(pending)
as_agent "$LEAD" POST "/api/permissions/$P2/answer" "{\"approve\":false,\"by\":\"$LEAD\",\"note\":\"keep logs in ./tmp\"}" | grep -q '"denied"' || fail "the parent couldn't deny"
noted() { "$STAM" show kid | grep -q "NOTED: .*keep logs in ./tmp"; }
wait_until noted
[ "$(status "$P2")" = denied ] || fail "request $P2 is $(status "$P2")"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- a dialog answered in the terminal closes its request"
"$STAM" mail send --to kid --subject "KIDREAD three" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P3=$(pending)
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(aid kid):" Enter
withdrawn() { [ "$(status "$P3")" = withdrawn ]; }
wait_until withdrawn
"$STAM" wait kid --until idle --timeout 60 >/dev/null
[ -z "$(pending)" ] || fail "requests left pending: $(pending)"

echo "-- the same dialog reported again, across a daemon restart too, keeps one request"
"$STAM" mail send --to kid --subject "KIDREAD five" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P5=$(pending)
KID=$(aid kid)
READ='{"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/elsewhere/.cache/kid.log"}}'
api POST "/api/hook/claude/$KID" "$READ" >/dev/null
daemon_stop main
daemon_up main
api POST "/api/hook/claude/$KID" "$READ" >/dev/null
[ "$(pending)" = "$P5" ] || fail "a repeated hook made another request: $(pending)"

echo "-- a newer dialog gets its own request, and a yes types nothing unless the dialog names it exactly"
# Same file name in another folder: the Read dialog on screen is for /elsewhere/.cache/kid.log.
api POST "/api/hook/claude/$KID" '{"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/other/kid.log"}}' >/dev/null
[ "$(status "$P5")" = withdrawn ] || fail "the replaced request $P5 is $(status "$P5")"
P6=$(pending)
[ -n "$P6" ] && [ "$P6" != "$P5" ] || fail "the new dialog has no request of its own: $P6"
"$STAM" authorize "$P6" 2>&1 | grep -q 'nothing was typed' || fail "a yes for /other/kid.log went into the dialog for /elsewhere/.cache/kid.log"
[ "$(status "$P6")" = pending ] || fail "the refused request $P6 is $(status "$P6")"
"$STAM" show kid | grep -q '"activity": "blocked"' || fail "the Read dialog was answered"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" Escape
"$STAM" wait kid --until idle --timeout 60 >/dev/null
[ "$(status "$P6")" = withdrawn ] || fail "the request $P6 outlived its dialog: $(status "$P6")"

echo "-- a command sharing a long prefix is another dialog too"
"$STAM" mail send --to kid --subject "KIDBASH one" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
api POST "/api/hook/claude/$KID" '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa two"}}' >/dev/null
P7=$(pending)
"$STAM" authorize "$P7" 2>&1 | grep -q 'nothing was typed' || fail "a yes for another command went into the dialog"
"$STAM" show kid | grep -q '"activity": "blocked"' || fail "the Bash dialog was answered"
# A harness session starting (a resume, say) ends the dialogs of the one before.
SID=$("$STAM" show kid | grep -m1 '"session_id"' | cut -d'"' -f4)
api POST "/api/hook/claude/$KID" "{\"hook_event_name\":\"SessionStart\",\"source\":\"resume\",\"session_id\":\"$SID\"}" >/dev/null
[ "$(status "$P7")" = withdrawn ] || fail "a new session left request $P7 $(status "$P7")"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" Escape
bashed() { "$STAM" show kid | grep -q '"last_message": "BASH-'; }
wait_until bashed

echo "-- a dialog with no one-time yes can't be approved from stam"
"$STAM" mail send --to kid --subject "KIDODD one" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P4=$(pending)
"$STAM" authorize "$P4" 2>&1 | grep -q 'nothing was typed' || fail "an approval was typed into a dialog with only a lasting yes"
[ "$(status "$P4")" = pending ] || fail "request $P4 is $(status "$P4") after a refused approval"
"$STAM" deny "$P4" >/dev/null
[ "$(status "$P4")" = denied ] || fail "request $P4 is $(status "$P4") after a denial"
# The denial's notice reaches the kid.
delivered() { "$STAM" events kid | awk '/notice:queued/ { q = NR } /pushed/ { p = NR } END { exit !(p > q) }'; }
wait_until delivered
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- Claude Code's real menu: a parallel tool and the Notification keep the request"
"$STAM" mail send --to kid --subject "KIDMENU one" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P8=$(pending)
# Another Read the model ran in parallel starts and ends while the dialog waits, then Claude
# Code's permission_prompt Notification for the same dialog arrives.
api POST "/api/hook/claude/$KID" '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/elsewhere/other.png"}}' >/dev/null
api POST "/api/hook/claude/$KID" '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/elsewhere/other.png"}}' >/dev/null
api POST "/api/hook/claude/$KID" '{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"Claude needs your permission"}' >/dev/null
[ "$(pending)" = "$P8" ] || fail "the Read request $P8 didn't survive a parallel tool and the Notification: $(pending)"
"$STAM" show kid | grep -q '"activity": "blocked"' || fail "a parallel tool unblocked the kid while its dialog waits"
echo "-- the human's yes picks the one-time yes, never the one that keeps allowing"
"$STAM" authorize "$P8" >/dev/null
# The fake logs the option the dialog closed with as "⎿ OPTION".
picked() { tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -S -300 -t "=$KID:" | grep -c "⎿ $1"; }
yes_once() { [ "$(picked 'Yes, but ask again next time')" = 1 ]; }
wait_until yes_once
[ "$(picked 'Yes, and keep allowing')" = 0 ] || fail "the yes kept allowing reads"
[ "$(status "$P8")" = approved ] || fail "request $P8 is $(status "$P8")"
"$STAM" wait kid --until idle --timeout 60 >/dev/null
echo "-- a deny picks No, and ask again next time"
"$STAM" mail send --to kid --subject "KIDMENU two" "again" >/dev/null
"$STAM" wait kid --until blocked --timeout 60 >/dev/null
wait_until has_one
P9=$(pending)
ESCS=$(picked cancelled)
"$STAM" deny "$P9" >/dev/null
no_once() { [ "$(picked 'No, and ask again next time')" = 1 ]; }
wait_until no_once
[ "$(picked cancelled)" = "$ESCS" ] || fail "the deny was Esc, though the dialog offers No, and ask again"
[ "$(status "$P9")" = denied ] || fail "request $P9 is $(status "$P9")"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- with no live parent or chief of staff, the dialog goes straight to the human"
"$STAM" spawn loner --cwd "$DIR" "KIDREAD alone" >/dev/null
"$STAM" wait loner --until blocked --timeout 60 >/dev/null
wait_until has_one
P10=$(pending)
[ "$(audience "$P10")" = human ] || fail "the loner's dialog's audience is $(audience "$P10")"
tohuman() { hapi GET '/api/agents/human/threads?limit=100' | grep -q "$P10"; }
wait_until tohuman
"$STAM" deny "$P10" >/dev/null
[ "$(status "$P10")" = denied ] || fail "request $P10 is $(status "$P10")"
echo "PASS e2e-harness-dialog"
