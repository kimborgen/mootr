#!/bin/sh
# ITSAs step 4 end to end, free (no models): owners and spawning. The scripted fake Claude
# Code (test/fake-claude) stands in for the harness, so `spawn --itsa` runs for real but no
# model does; other agents are registered and the PostToolUse hook is read by hand. Checks:
#   - spawn --itsa makes the new agent the owner; its recorded first prompt carries the key,
#     title, summary, body, parent chain, and links; with a caller prompt, both are there
#   - the system prompt names the open ITSAs the agent owns
#   - the parent ITSA's owner gets notices (hook output) when a child enters blocked, a human
#     status, or a closed status; none for a human-owned parent or ownerNotices off
#   - an owner shut down notices the parent owner; archive unowns its ITSAs, active ones go
#     back to ready (itsa_events), and the parent owner is told
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fake_claude ""
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
api() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$STAM_URL$2" ${3:+-d "$3"}; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
notice() { api POST "/api/hook/claude/$1" '{"hook_event_name":"PostToolUse"}' | jget "d.get('stdout','')"; }
mk() { api POST /api/itsas "$1" | jget "d['key']"; }
st() { api PATCH "/api/itsas/$1" "{\"status\":\"$2\"}" >/dev/null; }

LEAD=$(reg lead)
P=$(mk "{\"title\":\"Parent work\",\"owner\":\"lead\",\"status\":\"delegated\"}")
C=$(mk "{\"title\":\"Child work\",\"parent\":\"$P\",\"summary\":\"SUMMARY-X\",\"body\":\"BODY-X\",\"status\":\"ready\",\"links\":[{\"url\":\"https://example.com/l1\",\"system\":\"url\"}]}")
D=$(mk "{\"title\":\"Second child\",\"parent\":\"$P\",\"status\":\"ready\"}")

echo "-- spawn --itsa: owner, first prompt, system prompt"
"$STAM" spawn kid --itsa "$C" --cwd "$TEST_TMP" --role "Owner of the child." >/dev/null
KID=$(api GET /api/agents/kid | jget "d['id']")
[ "$(api GET "/api/itsas/$C" | jget "d['owner']")" = "$KID" ] || fail "kid isn't the owner of $C"
FP=$(api GET /api/agents/kid | jget "d['first_prompt']")
for s in "$C" "Child work" SUMMARY-X BODY-X "$P" "Parent work" "https://example.com/l1"; do
  echo "$FP" | grep -q "$s" || fail "first prompt lacks $s"
done
"$STAM" spawn kid2 --itsa "$D" --cwd "$TEST_TMP" --role "Second." "EXTRA-TASK-TEXT" >/dev/null
KID2=$(api GET /api/agents/kid2 | jget "d['id']")
FP2=$(api GET /api/agents/kid2 | jget "d['first_prompt']")
echo "$FP2" | grep -q "Second child" && echo "$FP2" | grep -q "EXTRA-TASK-TEXT" || fail "the caller prompt and the block aren't both in the first prompt"
SESSION=$(api GET /api/agents/kid | jget "d['session_id']")
api GET "/api/by-session/$SESSION/system" | grep -q "You own these ITSAs: $C" || fail "the system prompt doesn't name the owned ITSA"
"$STAM" spawn bad --itsa NOPE-1 --cwd "$TEST_TMP" --role x >/dev/null 2>&1 && fail "a spawn with an unknown ITSA succeeded"

echo "-- notices to the parent owner"
notice "$LEAD" >/dev/null
st "$C" in_progress
[ -z "$(notice "$LEAD")" ] || fail "an in_progress child noticed the parent owner"
st "$C" blocked
notice "$LEAD" | grep -q "blocked" || fail "no notice for blocked"
st "$C" needs_input
notice "$LEAD" | grep -q "waits on the human" || fail "no notice for a human status"
st "$C" done
notice "$LEAD" | grep -q "closed" || fail "no notice for closed"
api PATCH "/api/itsas/$P" '{"owner":"human"}' >/dev/null
st "$D" blocked
[ -z "$(notice "$LEAD")" ] || fail "a human-owned parent still noticed the old owner"
api PATCH "/api/itsas/$P" "{\"owner\":\"lead\"}" >/dev/null
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s.setdefault("itsa", {})["ownerNotices"] = "off"; json.dump(s, open(sys.argv[1], "w"))
PY
# settings() reads the file on every call, so the write above is in effect as soon as it lands.
st "$D" ready; st "$D" blocked
[ -z "$(notice "$LEAD")" ] || fail "ownerNotices off still sent a notice"
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["itsa"]["ownerNotices"] = "on"; json.dump(s, open(sys.argv[1], "w"))
PY

echo "-- owner stops: shutdown notices, archive unowns"
st "$D" in_progress
notice "$LEAD" >/dev/null
# End a turn by hand, in case the fake's first turn hasn't, so shutdown can proceed.
api POST "/api/hook/claude/$KID2" '{"hook_event_name":"Stop","last_assistant_message":"done"}' >/dev/null
# Both are async: poll for the state each one leaves behind.
shut_notice() { notice "$LEAD" | grep -q "kid2 was shut down"; }
"$STAM" shutdown kid2 >/dev/null
wait_until shut_notice || fail "no notice for the owner's shutdown"
unowned_ready() { [ "$(api GET "/api/itsas/$D" | jget "d['owner']")" = None ] && [ "$(api GET "/api/itsas/$D" | jget "d['status']")" = ready ]; }
"$STAM" archive kid2 >/dev/null
wait_until unowned_ready || fail "archive didn't unown $D and return the active ITSA to ready"
api GET "/api/itsas/$D" | jget "len(d['children'])" >/dev/null
N=$(notice "$LEAD")
echo "$N" | grep -q "unowned" || fail "no notice for the archived owner's ITSA"
[ "$(echo "$N" | grep -c unowned)" = 1 ] || fail "the unowned notice wasn't batched into one"
"$STAM" itsa show "$D" | grep -q "ready" || fail "itsa show lost the status"

echo "-- every agent in an ITSA: a spawn without itsa joins its parent's open ITSA"
# lead owns P (delegated, open): a child spawned with no --itsa joins as a participant. The
# join is fired off without awaiting the spawn, so poll for it to land.
"$STAM" spawn part --parent lead --cwd "$TEST_TMP" --role "Joiner." >/dev/null
PART=$(api GET /api/agents/part | jget "d['id']")
SESSION_P=$(api GET /api/agents/part | jget "d['session_id']")
waitfor() { for _i in $(seq 1 30); do eval "$1" && return 0; sleep 0.3; done; return 1; }
waitfor "api GET '/api/itsas/$P' | jget \"d['participants']\" | grep -q '$PART'" || fail "part didn't join lead's ITSA $P"
# The participation shows in the system prompt (OpenCode's system endpoint) and the view.
waitfor "api GET '/api/by-session/$SESSION_P/system' | grep -q 'You participate in these ITSAs: $P'" || fail "the system prompt doesn't name the participated ITSA"
waitfor "api GET '/api/agents/$PART/instructions' | grep -q 'You participate in these ITSAs: $P'" || fail "the Instructions view doesn't name the participated ITSA"

echo "-- spawn with participate: the child joins as a participant, the owner stays (S-2424)"
PJ=$(mk "{\"title\":\"Joined work\",\"owner\":\"lead\",\"status\":\"delegated\"}")
api POST /api/agents "{\"name\":\"joiner\",\"role\":\"Commenter.\",\"harness\":\"claude\",\"cwd\":\"$TEST_TMP\",\"participate\":[\"$PJ\"]}" >/dev/null || fail "a spawn with participate was refused"
JOINER=$(api GET /api/agents/joiner | jget "d['id']")
[ "$(api GET "/api/itsas/$PJ" | jget "d['owner']")" = "$LEAD" ] || fail "the participate spawn changed the owner of $PJ"
api GET "/api/itsas/$PJ" | jget "d['participants']" | grep -q "$JOINER" || fail "joiner isn't a participant of $PJ"
echo "-- participate: the spawner is the calling agent, and must be a member (S-2424)"
PM=$(mk "{\"title\":\"Manager work\",\"owner\":\"lead\",\"status\":\"delegated\"}")
"$STAM" spawn mgr --itsa "$PM" --cwd "$TEST_TMP" --role "Owns the manager work." >/dev/null
"$STAM" spawn auth --cwd "$TEST_TMP" --role "Not a member." >/dev/null
MGR=$(api GET /api/agents/mgr | jget "d['id']")
AUTH=$(api GET /api/agents/auth | jget "d['id']")
agent_token() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN | cut -d= -f2-; }
MGR_TOKEN=$(agent_token "$MGR")
AUTH_TOKEN=$(agent_token "$AUTH")
[ -n "$MGR_TOKEN" ] && [ -n "$AUTH_TOKEN" ] || fail "an agent has no STAM_TOKEN in its environment"
# The HTTP status of a POST with an agent's own token, without the human header.
agent_post() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' "$STAM_URL$2" -d "$3"; }
N0=$(api GET /api/agents | jget "len(d)")
[ "$(agent_post "$AUTH_TOKEN" /api/agents "{\"name\":\"refused\",\"role\":\"x\",\"harness\":\"claude\",\"cwd\":\"$TEST_TMP\",\"participate\":[\"$PM\"]}")" = 403 ] || fail "a non-member's spawn with participate, naming no by, wasn't refused"
[ "$(agent_post "$AUTH_TOKEN" /api/agents "{\"name\":\"refused\",\"role\":\"x\",\"harness\":\"claude\",\"cwd\":\"$TEST_TMP\",\"by\":\"$MGR\",\"participate\":[\"$PM\"]}")" = 403 ] || fail "a non-member naming a member as by wasn't refused"
api GET /api/agents/refused >/dev/null 2>&1 && fail "a refused participate spawn left an agent behind"
[ "$(api GET /api/agents | jget "len(d)")" = "$N0" ] || fail "a refused participate spawn changed the agent count"
case "$(agent_post "$MGR_TOKEN" /api/agents "{\"name\":\"kidp\",\"role\":\"Joins the manager work.\",\"harness\":\"claude\",\"cwd\":\"$TEST_TMP\",\"by\":\"$MGR\",\"participate\":[\"$PM\"]}")" in
  2??) ;;
  *) fail "the owner's spawn with participate was refused" ;;
esac
KIDP=$(api GET /api/agents/kidp | jget "d['id']")
[ "$(api GET "/api/itsas/$PM" | jget "d['owner']")" = "$MGR" ] || fail "the participate spawn changed the owner of $PM"
api GET "/api/itsas/$PM" | jget "d['participants']" | grep -q "$KIDP" || fail "kidp isn't a participant of $PM"
[ "$(agent_post "$AUTH_TOKEN" /api/itsas/may-participate "{\"itsa\":\"$PM\",\"agent\":\"$MGR\"}")" = 403 ] || fail "an agent reached the peer-only may-participate route"

api POST /api/agents "{\"name\":\"nojoin\",\"role\":\"x\",\"harness\":\"claude\",\"cwd\":\"$TEST_TMP\",\"participate\":[\"NOPE-98\"]}" >/dev/null && fail "a spawn with an unknown participate ITSA succeeded"
api GET /api/agents/nojoin >/dev/null 2>&1 && fail "a refused participate spawn left an agent behind"

echo "-- a parent with no ITSA, or no parent, doesn't block the spawn"
reg nobody >/dev/null
"$STAM" spawn orphan --parent nobody --cwd "$TEST_TMP" --role "No ITSA." >/dev/null || fail "a spawn under a parent with no ITSA was blocked"
"$STAM" spawn top --cwd "$TEST_TMP" --role "Top level." >/dev/null || fail "a top-level spawn was blocked"

echo "-- the API flag says whether an agent is in any open ITSA"
ORG=$(api GET /api/agents/orphan | jget "d['id']")
TOP=$(api GET /api/agents/top | jget "d['id']")
flag() { api GET /api/agents | jget "[a['in_itsa'] for a in d if a['id']=='$1'][0]"; }
waitfor "[ \"\$(flag '$PART')\" = True ]" || fail "part should be marked as in an ITSA"
[ "$(flag "$ORG")" = False ] || fail "orphan should not be in any ITSA"
[ "$(flag "$TOP")" = False ] || fail "top should not be in any ITSA"
# With ITSAs not required, nothing is marked.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s.setdefault("itsa", {})["required"] = False; json.dump(s, open(sys.argv[1], "w"))
PY
[ "$(flag "$ORG")" = True ] || fail "required off still marked orphan as outside an ITSA"
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["itsa"]["required"] = True; json.dump(s, open(sys.argv[1], "w"))
PY
[ "$(flag "$ORG")" = False ] || fail "required on should mark orphan again"

echo "PASS e2e-itsa-owners"
