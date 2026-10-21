#!/bin/sh
# Suggested harness input (S-422): a Claude Code agent suggests one exact line for its own input
# (suggest_input), and only the human, as trustedHuman proves it, approves it; stam then types it
# as written (double spaces, a leading "! ", a trailing ";") and presses Enter. Refused, with
# nothing typed: the agent's own token, another agent's, the parent's `by`, the assistant's, the
# shared token with x-stam-human, a forged Tailscale-User-Login from loopback (401, no token), an answer a peer
# forwarded, `stam authorize`, a wrong text_sha256, a replay, and an expired suggestion. A denial
# types nothing; a newer suggestion withdraws the older one; a draft in the box holds the approval
# without touching the draft, as a busy agent does, and it is typed once the box is free; a held
# approval that expires types nothing and tells the human. Typing never submits anything but the
# text: a completion menu under the box gets one Esc, or the text is erased; a suggestion replaced
# or expired while stam types it, or a harness session changed after the approval, is erased
# before Enter; and a submitted prompt other than the text is told to the human. Codex and
# OpenCode agents are refused.
# Fake Claude Code (test/fake-claude): no model, free. Waits on state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/suggest.json" <<'EOF2'
{ "turns": [
  { "match": "KIDSUGGEST", "steps": [
    { "mcp": "suggest_input", "args": { "text": "! echo  two  spaces;", "reason": "the test needs it" }, "expect": "/Suggestion p[0-9a-f]+ sent/" },
    { "reply": "SUGGESTED" } ] },
  { "match": "KIDHOLD", "steps": [ { "await": "RELEASE" }, { "reply": "RELEASED" } ] },
  { "match": "Lead", "steps": [ { "reply": "LEADING" } ] } ],
  "rewrite": { "REWRITEME": "rewritten" } }
EOF2
fake_claude "$TEST_TMP/suggest.json"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
# A `hold` file here stops stam's typing right before Enter, so a test can act mid-typing.
BARRIER="$TEST_TMP/barrier"
mkdir -p "$BARRIER"
STAM_TEST_INPUT_BARRIER=$BARRIER
export STAM_TEST_INPUT_BARRIER
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
# expire ID: a suggestion's expiry moved back (a test route, -f: a gate 404 fails here).
expire() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"id\":\"$1\",\"expires_at\":\"2000-01-01T00:00:00.000Z\"}" "$STAM_URL/api/test/permission" >/dev/null; }
# test_agent AGENT FIELD VALUE: a test-route write of one agent field (-f: a gate 404 fails here).
test_agent() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"agent\":\"$1\",\"$2\":\"$3\"}" "$STAM_URL/api/test/agent" >/dev/null; }
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
spawn() { human POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\"$2}" | field id; }
token_of() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-; }
# code TOKEN METHOD PATH JSON [curl args]: the HTTP status; the body goes to $TEST_TMP/body.
code() {
  _t=$1 _m=$2 _p=$3 _d=$4
  shift 4
  curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X "$_m" ${_t:+-H "authorization: Bearer $_t"} -H 'content-type: application/json' "$@" "$STAM_URL$_p" ${_d:+-d "$_d"}
}
req() { human GET /api/permissions | python3 -c 'import json,sys; r=next(r for r in json.load(sys.stdin) if r["id"]==sys.argv[1]); print(r[sys.argv[2]])' "$1" "$2"; }
newest() { human GET '/api/permissions?status=pending' | python3 -c 'import json,sys; print(next(r["id"] for r in json.load(sys.stdin) if r["kind"]=="input"))'; }
sha() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
HUMANKEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
approve() { code "$TOKEN" POST "/api/permissions/$1/answer" "{\"approve\":true,\"text_sha256\":\"$2\"}" -H "$HUMANKEY"; }
typed() { cat "$STAM_HOME/agents/$1/typed.jsonl" 2>/dev/null | wc -l; }
# The last input the fake took from its pane is exactly TEXT.
last_typed() { python3 -c 'import json,sys; l=open(sys.argv[1]).read().splitlines(); sys.exit(0 if l and json.loads(l[-1])==sys.argv[2] else 1)' "$STAM_HOME/agents/$1/typed.jsonl" "$2"; }
suggest() { code "$1" POST /api/suggest-input "{\"text\":\"$2\",\"reason\":\"test\"}"; }
input_line() { tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -t "=$1:" | grep '^❯' | tail -n1; }

LEAD=$(spawn lead ',"prompt":"Lead"')
EA=$(spawn ea ',"kind":"assistant"')
"$STAM" wait lead --until idle --timeout 60 >/dev/null
KID=$(spawn kid ",\"parent\":\"$LEAD\",\"prompt\":\"KIDSUGGEST\"")
# A pending suggestion is a human wait, so the kid ends its turn waiting, not idle.
suggested() { "$STAM" show kid | grep -q 'SUGGESTED\|FAKE-CLAUDE'; }
wait_until suggested
"$STAM" show kid | grep -q SUGGESTED || fail "suggest_input from the MCP tool: $("$STAM" show kid | grep -m1 'FAKE-CLAUDE' || true)"
KT=$(token_of "$KID")
LT=$(token_of "$LEAD")
ET=$(token_of "$EA")
[ -n "$KT" ] && [ -n "$LT" ] && [ -n "$ET" ] || fail "agent tokens: '$KT' '$LT' '$ET'"
LEAD_TYPED=$(typed "$LEAD")

echo "-- the suggestion is a permission request of kind input, mailed to the human and the parent"
T1='! echo  two  spaces;'
P1=$(newest)
[ "$(req "$P1" text)" = "$T1" ] || fail "stored text: '$(req "$P1" text)'"
[ "$(req "$P1" sha256)" = "$(sha "$T1")" ] || fail "sha256"
[ "$(req "$P1" agent_name)" = kid ] && [ "$(req "$P1" machine)" = main ] || fail "agent and machine: $(req "$P1" agent_name) $(req "$P1" machine)"
[ -n "$(req "$P1" expires_at)" ] || fail "no expires_at"
mailed() { "$STAM" mail inbox lead | grep -q 'Input for kid'; }
wait_until mailed
human GET "/api/agents/human/inbox?unread=0" | grep -q 'two  spaces' || fail "the human's mail doesn't show the exact text"

echo "-- bad text is refused"
[ "$(suggest "$KT" 'a\nb')" = 400 ] || fail "a newline was accepted"
[ "$(suggest "$KT" 'a\tb')" = 400 ] || fail "a tab was accepted"
[ "$(suggest "$KT" 'a\u001b[2Jb')" = 400 ] || fail "an escape was accepted"
[ "$(suggest "$KT" '  ')" = 400 ] || fail "empty text was accepted"
[ "$(suggest "$KT" "$(python3 -c 'print("x"*2001)')")" = 400 ] || fail "2001 characters were accepted"
[ "$(suggest "$TOKEN" 'echo hi')" = 403 ] || fail "the shared token suggested input"
[ "$(req "$P1" status)" = pending ] || fail "a refused suggestion withdrew $P1"

echo "-- only trustedHuman approves; every other caller is refused and nothing is typed"
BEFORE=$(typed "$KID")
S1=$(sha "$T1")
BODY="{\"approve\":true,\"text_sha256\":\"$S1\"}"
[ "$(code "$KT" POST "/api/permissions/$P1/answer" "$BODY")" = 403 ] || fail "the agent's own token approved: $(cat "$TEST_TMP/body")"
[ "$(code "$LT" POST "/api/permissions/$P1/answer" "$BODY")" = 403 ] || fail "another agent's token approved"
[ "$(code "$LT" POST "/api/permissions/$P1/answer" "{\"approve\":true,\"by\":\"$LEAD\",\"text_sha256\":\"$S1\"}")" = 403 ] || fail "the parent approved"
[ "$(code "$ET" POST "/api/permissions/$P1/answer" "{\"approve\":true,\"by\":\"$EA\",\"text_sha256\":\"$S1\"}")" = 403 ] || fail "the assistant approved"
[ "$(code "$TOKEN" POST "/api/permissions/$P1/answer" "$BODY" -H 'x-stam-human: 1')" = 403 ] || fail "the shared token with x-stam-human approved"
[ "$(code "$TOKEN" POST "/api/permissions/$P1/answer" "$BODY" -H 'x-stam-test-human: wrong')" = 403 ] || fail "a wrong test key approved"
OWNER=$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["User"][str(s["Self"]["UserID"])]["LoginName"])' 2>/dev/null || true)
if [ -n "$OWNER" ]; then
  [ "$(code "" POST "/api/permissions/$P1/answer" "$BODY" -H "tailscale-user-login: $OWNER" -H 'x-forwarded-for: 192.0.2.9')" = 401 ] || fail "a forged Tailscale-User-Login from loopback approved: $(cat "$TEST_TMP/body")"
  [ "$(code "$TOKEN" POST "/api/permissions/$P1/answer" "$BODY" -H "tailscale-user-login: $OWNER" -H 'x-stam-human: 1')" = 403 ] || fail "the shared token with the owner's login approved"
else
  echo "   (no Tailscale owner on this machine: the forged-login check is the shared-token one only)"
fi
[ "$(code "$(cat "$STAM_HOME/peer-token")" POST "/api/permissions/$P1/answer" "$BODY" -H 'x-stam-local: 1' -H "$HUMANKEY")" = 409 ] || fail "a peer-forwarded approval wasn't a 409"
grep -q 'on main' "$TEST_TMP/body" || fail "the 409 doesn't name the machine: $(cat "$TEST_TMP/body")"
"$STAM" authorize "$P1" >/dev/null 2>&1 && fail "stam authorize approved suggested input"
[ "$(approve "$P1" "$(sha 'something else')")" = 409 ] || fail "a wrong text_sha256 approved"
[ "$(code "$TOKEN" POST "/api/permissions/$P1/answer" '{"approve":true}' -H "$HUMANKEY")" = 409 ] || fail "a missing text_sha256 approved"
[ "$(req "$P1" status)" = pending ] || fail "$P1 is $(req "$P1" status) after the refusals"
[ "$(typed "$KID")" = "$BEFORE" ] || fail "something was typed into kid"

echo "-- the human's approval types the exact text, then Enter; a replay is refused"
[ "$(approve "$P1" "$S1")" = 200 ] || fail "the human's approval: $(cat "$TEST_TMP/body")"
field outcome <"$TEST_TMP/body" | grep -qx typed || fail "outcome: $(cat "$TEST_TMP/body")"
wait_until last_typed "$KID" "$T1"
# A bash-mode command is checked in the transcript, after Enter: the fake records it as Claude Code does.
bash_seen() { "$STAM" events kid | grep -q "input:submitted.*$P1.*transcript"; }
wait_until bash_seen
[ "$(req "$P1" status)" = approved ] || fail "$P1 is $(req "$P1" status)"
[ "$(approve "$P1" "$S1")" = 409 ] || fail "a replay was accepted"
[ "$(typed "$LEAD")" = "$LEAD_TYPED" ] || fail "the lead's pane was typed into"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- a denial types nothing; a newer suggestion withdraws the older"
T2='echo denied'
[ "$(suggest "$KT" "$T2")" = 200 ] || fail "suggest: $(cat "$TEST_TMP/body")"
P2=$(field id <"$TEST_TMP/body")
[ "$(code "$LT" POST "/api/permissions/$P2/answer" "{\"approve\":false,\"by\":\"$LEAD\",\"note\":\"no\"}")" = 200 ] || fail "the parent couldn't deny: $(cat "$TEST_TMP/body")"
[ "$(req "$P2" status)" = denied ] || fail "$P2 is $(req "$P2" status)"
[ "$(approve "$P2" "$(sha "$T2")")" = 409 ] || fail "a denied suggestion was approved"
suggest "$KT" 'echo old' >/dev/null
P3=$(field id <"$TEST_TMP/body")
suggest "$KT" 'echo new' >/dev/null
P4=$(field id <"$TEST_TMP/body")
[ "$(req "$P3" status)" = withdrawn ] || fail "the older suggestion $P3 is $(req "$P3" status)"
[ "$(approve "$P3" "$(sha 'echo old')")" = 409 ] || fail "a withdrawn suggestion was approved"

echo "-- an expired suggestion is refused"
expire "$P4"
[ "$(approve "$P4" "$(sha 'echo new')")" = 409 ] || fail "an expired suggestion was approved"
[ "$(req "$P4" status)" = expired ] || fail "$P4 is $(req "$P4" status)"
"$STAM" wait kid --until idle --timeout 60 >/dev/null
[ "$(typed "$KID")" = "$(($BEFORE + 1))" ] || fail "denied, withdrawn, or expired text was typed"

echo "-- a draft in the box holds the approval and stays; it is typed once the box is free"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l 'my draft'
has_draft() { input_line "$KID" | grep -q 'my draft'; }
wait_until has_draft
T5='echo   after  draft'
suggest "$KT" "$T5" >/dev/null
P5=$(field id <"$TEST_TMP/body")
[ "$(approve "$P5" "$(sha "$T5")")" = 200 ] || fail "approve: $(cat "$TEST_TMP/body")"
field outcome <"$TEST_TMP/body" | grep -qx held || fail "outcome with a draft: $(cat "$TEST_TMP/body")"
[ "$(req "$P5" status)" = held ] || fail "$P5 is $(req "$P5" status)"
[ "$(input_line "$KID")" = '❯ my draft' ] || fail "the draft changed: '$(input_line "$KID")'"
echo "-- a second tap on a held approval is the held state, not an error (S-524)"
[ "$(approve "$P5" "$(sha "$T5")")" = 200 ] || fail "repeat approve: $(cat "$TEST_TMP/body")"
field outcome <"$TEST_TMP/body" | grep -qx held || fail "repeat outcome: $(cat "$TEST_TMP/body")"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace
wait_until last_typed "$KID" "$T5"
[ "$(req "$P5" status)" = approved ] || fail "$P5 is $(req "$P5" status)"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- a busy agent's approval is held and typed at its next idle"
"$STAM" mail send --to kid --subject KIDHOLD "hold" >/dev/null
"$STAM" wait kid --until working --timeout 60 >/dev/null
T6='echo busy'
suggest "$KT" "$T6" >/dev/null
P6=$(field id <"$TEST_TMP/body")
[ "$(approve "$P6" "$(sha "$T6")")" = 200 ] && field outcome <"$TEST_TMP/body" | grep -qx held || fail "busy outcome: $(cat "$TEST_TMP/body")"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l RELEASE
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" Enter
wait_until last_typed "$KID" "$T6"
[ "$(req "$P6" status)" = approved ] || fail "$P6 is $(req "$P6" status)"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- busy, then a draft: the agent's box gets one text-specific notice, and it is typed once the box is empty (S-524)"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l 'late draft'
has_late() { input_line "$KID" | grep -q 'late draft'; }
wait_until has_late
# The agent counts as working when the approval comes, and a Stop hook then says it is idle: the box holds the human's draft by then.
test_agent "$KID" activity working
T6B='echo busy then draft'
suggest "$KT" "$T6B" >/dev/null
P6B=$(field id <"$TEST_TMP/body")
[ "$(approve "$P6B" "$(sha "$T6B")")" = 200 ] && field outcome <"$TEST_TMP/body" | grep -qx held || fail "busy outcome: $(cat "$TEST_TMP/body")"
[ "$("$STAM" events kid | grep 'input:held' | grep -c 'late draft')" = 0 ] || fail "a draft notice came while the agent was busy"
human POST "/api/hook/claude/$KID" '{"hook_event_name":"Stop"}' >/dev/null
told_late() { "$STAM" events kid | grep 'input:held' | grep -q 'late draft'; }
wait_until told_late
[ "$(req "$P6B" status)" = held ] || fail "$P6B is $(req "$P6B" status) with a draft in the box"
[ "$(input_line "$KID")" = '❯ late draft' ] || fail "the draft changed: '$(input_line "$KID")'"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace
human POST "/api/hook/claude/$KID" '{"hook_event_name":"Stop"}' >/dev/null
wait_until last_typed "$KID" "$T6B"
[ "$("$STAM" events kid | grep 'input:held' | grep -c 'late draft')" = 1 ] || fail "the draft notice went out more than once"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- a held approval that expires types nothing and tells the human"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l 'draft2'
has_draft2() { input_line "$KID" | grep -q 'draft2'; }
wait_until has_draft2
T7='echo never'
suggest "$KT" "$T7" >/dev/null
P7=$(field id <"$TEST_TMP/body")
approve "$P7" "$(sha "$T7")" >/dev/null
[ "$(req "$P7" status)" = held ] || fail "$P7 is $(req "$P7" status)"
N=$(typed "$KID")
expire "$P7"
[ "$(approve "$P7" "$(sha "$T7")")" = 409 ] || fail "a repeat tap on an expired held approval: $(cat "$TEST_TMP/body")"
expired() { [ "$(req "$P7" status)" = expired ]; }
wait_until expired
told() { human GET "/api/agents/human/inbox?unread=0" | grep -q 'expired untyped'; }
wait_until told
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" BSpace BSpace BSpace BSpace BSpace BSpace
[ "$(typed "$KID")" = "$N" ] || fail "an expired held approval was typed"

at_barrier() { [ -e "$BARRIER/at" ]; }
empty_box() { [ "$(input_line "$KID")" = '❯' ] || [ "$(input_line "$KID")" = '❯ ' ]; }
# approve_bg ID SHA: the human's approval, in the background (it returns once typing ends).
approve_bg() { approve "$1" "$2" >"$TEST_TMP/bg.code" & BG=$!; }

echo "-- a completion menu under the box gets one Esc; one that stays means nothing is sent"
N=$(typed "$KID")
suggest "$KT" '/re' >/dev/null
P8=$(field id <"$TEST_TMP/body")
[ "$(approve "$P8" "$(sha '/re')")" = 200 ] && field outcome <"$TEST_TMP/body" | grep -qx typed || fail "/re: $(cat "$TEST_TMP/body")"
wait_until last_typed "$KID" '/re'
"$STAM" wait kid --until idle --timeout 60 >/dev/null
# A thumbs-up with a skin tone and an e with a combining accent: one backspace each, as Claude Code deletes.
GRAPHEMES='see 👍🏽 é @@file'
suggest "$KT" "$GRAPHEMES" >/dev/null
P9=$(field id <"$TEST_TMP/body")
[ "$(approve "$P9" "$(sha "$GRAPHEMES")")" = 200 ] && field outcome <"$TEST_TMP/body" | grep -qx failed || fail "a menu Esc doesn't close was sent: $(cat "$TEST_TMP/body")"
[ "$(req "$P9" status)" = failed ] || fail "$P9 is $(req "$P9" status)"
wait_until empty_box
[ "$(typed "$KID")" = "$(($N + 1))" ] || fail "the menu's item was submitted"

echo "-- a submitted prompt other than the text is told to the human"
suggest "$KT" 'echo REWRITEME' >/dev/null
P10=$(field id <"$TEST_TMP/body")
approve "$P10" "$(sha 'echo REWRITEME')" >/dev/null
mismatch() { human GET "/api/agents/human/inbox?unread=0" | grep -q 'submitted something else'; }
wait_until mismatch
"$STAM" wait kid --until idle --timeout 60 >/dev/null
# A bash-mode command whose transcript record isn't the text, too.
suggest "$KT" '! echo REWRITEME' >/dev/null
approve "$(field id <"$TEST_TMP/body")" "$(sha '! echo REWRITEME')" >/dev/null
mismatch2() { [ "$(human GET "/api/agents/human/inbox?unread=0" | grep -o 'submitted something else' | wc -l)" -ge 2 ]; }
wait_until mismatch2
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- a suggestion replaced while stam types it is erased before Enter"
N=$(typed "$KID")
suggest "$KT" 'echo replaced' >/dev/null
P11=$(field id <"$TEST_TMP/body")
touch "$BARRIER/hold"
rm -f "$BARRIER/at"
approve_bg "$P11" "$(sha 'echo replaced')"

wait_until at_barrier
suggest "$KT" 'echo replacement' >/dev/null
P12=$(field id <"$TEST_TMP/body")
rm "$BARRIER/hold"
wait "$BG"
[ "$(cat "$TEST_TMP/bg.code")" = 200 ] && field outcome <"$TEST_TMP/body" | grep -qx cancelled || fail "replaced mid-typing: $(cat "$TEST_TMP/bg.code") $(cat "$TEST_TMP/body")"
[ "$(req "$P11" status)" = withdrawn ] || fail "$P11 is $(req "$P11" status)"
wait_until empty_box

echo "-- a suggestion that expires while stam types it is erased before Enter"
touch "$BARRIER/hold"
rm -f "$BARRIER/at"
approve_bg "$P12" "$(sha 'echo replacement')"
wait_until at_barrier
expire "$P12"
rm "$BARRIER/hold"
wait "$BG"
field outcome <"$TEST_TMP/body" | grep -qx cancelled || fail "expired mid-typing: $(cat "$TEST_TMP/body")"
[ "$(req "$P12" status)" = expired ] || fail "$P12 is $(req "$P12" status)"
wait_until empty_box
[ "$(typed "$KID")" = "$N" ] || fail "a replaced or expired suggestion was submitted"

echo "-- an approval held across a harness session change is never typed"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l 'draft3'
has_draft3() { input_line "$KID" | grep -q 'draft3'; }
wait_until has_draft3
suggest "$KT" 'echo old session' >/dev/null
P13=$(field id <"$TEST_TMP/body")
approve "$P13" "$(sha 'echo old session')" >/dev/null
[ "$(req "$P13" status)" = held ] || fail "$P13 is $(req "$P13" status)"
human POST "/api/hook/claude/$KID" '{"hook_event_name":"SessionStart","source":"clear","session_id":"another-session"}' >/dev/null
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" BSpace BSpace BSpace BSpace BSpace BSpace
session_expired() { [ "$(req "$P13" status)" = expired ]; }
wait_until session_expired
# The second "expired untyped" mail to the human (the first was the held approval's expiry above).
session_told() { [ "$(human GET "/api/agents/human/inbox?unread=0" | grep -o 'expired untyped' | wc -l)" -ge 2 ]; }
wait_until session_told
[ "$(typed "$KID")" = "$N" ] || fail "an approval was typed into another session"

echo "-- text in an idle agent's box that matches the start of the suggestion is the human's: kept, the agent told what to clear (S-524)"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l 'echo release'
has_rel() { input_line "$KID" | grep -q 'echo release'; }
wait_until has_rel
TR='echo release build now'
suggest "$KT" "$TR" >/dev/null
PR=$(field id <"$TEST_TMP/body")
approve "$PR" "$(sha "$TR")" >/dev/null
[ "$(req "$PR" status)" = held ] || fail "$PR is $(req "$PR" status) with a matching draft"
[ "$(input_line "$KID")" = '❯ echo release' ] || fail "a matching draft was changed: '$(input_line "$KID")'"
told_box() { "$STAM" events kid | grep 'input:held' | grep -q 'echo release'; }
wait_until told_box
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace BSpace
wait_until last_typed "$KID" "$TR"
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- stam's own leftover from a partial erase is cleared exactly once the box is free; a human's edit of it is not (S-534)"
DROP="$STAM_HOME/agents/$KID/drop-bs"
leave_ech() {
  # An approval replaced while stam types it is erased, but three backspaces do nothing: 'ech' stays.
  echo 3 >"$DROP"
  suggest "$KT" "$1" >/dev/null
  _a=$(field id <"$TEST_TMP/body")
  touch "$BARRIER/hold"
  rm -f "$BARRIER/at"
  approve_bg "$_a" "$(sha "$1")"
  wait_until at_barrier
  suggest "$KT" "$2" >/dev/null
  PNEW=$(field id <"$TEST_TMP/body")
  rm "$BARRIER/hold"
  wait "$BG"
  has_ech() { [ "$(input_line "$KID")" = '❯ ech' ]; }
  wait_until has_ech
}
N=$(typed "$KID")
leave_ech 'echo replaced two' 'echo after leftover'
# Busy, then idle: the box holds stam's own 'ech', which is cleared; then the text is typed.
test_agent "$KID" activity working
approve "$PNEW" "$(sha 'echo after leftover')" >/dev/null
[ "$(req "$PNEW" status)" = held ] || fail "$PNEW is $(req "$PNEW" status) while busy"
[ "$(input_line "$KID")" = '❯ ech' ] || fail "the leftover changed while busy: '$(input_line "$KID")'"
human POST "/api/hook/claude/$KID" '{"hook_event_name":"Stop"}' >/dev/null
wait_until last_typed "$KID" 'echo after leftover'
[ "$(req "$PNEW" status)" = approved ] || fail "$PNEW is $(req "$PNEW" status) after the leftover was cleared"
"$STAM" events kid | grep -q 'input:cleared' || fail "no input:cleared event"
"$STAM" wait kid --until idle --timeout 60 >/dev/null
N=$(typed "$KID")

# The human adds to the leftover: it is now their draft, kept, and the held card names it.
leave_ech 'echo replaced three' 'echo human edit'
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" -l 'o'
has_echo() { [ "$(input_line "$KID")" = '❯ echo' ]; }
wait_until has_echo
[ "$(approve "$PNEW" "$(sha 'echo human edit')")" = 200 ] && field outcome <"$TEST_TMP/body" | grep -qx held && field why <"$TEST_TMP/body" | grep -qx draft || fail "an edited leftover: $(cat "$TEST_TMP/body")"
[ "$(input_line "$KID")" = '❯ echo' ] || fail "the human's edit was changed: '$(input_line "$KID")'"
[ "$(req "$PNEW" note)" = 'box:echo' ] || fail "the held card's box text: '$(req "$PNEW" note)'"
[ "$(typed "$KID")" = "$N" ] || fail "something was typed over the human's edit"
tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$KID:" BSpace BSpace BSpace BSpace
wait_until last_typed "$KID" 'echo human edit'
"$STAM" wait kid --until idle --timeout 60 >/dev/null

echo "-- Codex and OpenCode agents are refused"
CX=$(spawn cx)
"$STAM" wait cx --until idle --timeout 60 >/dev/null
CT=$(token_of "$CX")
for h in codex opencode; do
  test_agent "$CX" harness "$h"
  [ "$(suggest "$CT" 'echo hi')" = 403 ] || fail "$h suggested input: $(cat "$TEST_TMP/body")"
  grep -q "Claude Code" "$TEST_TMP/body" && grep -q "$h" "$TEST_TMP/body" || fail "the $h refusal doesn't say why: $(cat "$TEST_TMP/body")"
done
test_agent "$CX" harness claude

echo "PASS e2e-suggest-input"
