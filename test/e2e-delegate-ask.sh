#!/bin/sh
# Delegate-first permission requests (S-432): a delegate ask goes to the parent only (no human mail,
# attention row or badge) and the parent decides it; escalating sends the human one standalone mail
# with the original details and the reason; a delegate ask with no live parent or chief of staff goes
# to the human and says why; a human ask refuses an agent's approval, an agent's denial withdraws the
# human's copy, and the human's approval works. A paused parent or chief of staff isn't live: the ask
# goes to the next in line, then the human. A harness dialog nobody answers within
# settings.dialogEscalateMinutes goes to the human once, naming who it was sent to, and never after an
# escalation or an answer; one whose agent was shut down is withdrawn instead (S-589). A pending
# delegated dialog names who it is with, and `stam permissions` lists it apart until sent on (S-594). Free and no models: registered agents plus the permission and hook
# API, against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$1" -d "$2"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
parent() { api POST "/api/agents/$1/set-parent" "{\"parent\":[\"$2\"]}" >/dev/null; }
ask() { api POST /api/permissions "{\"agent\":\"$1\",\"action\":\"$2\",\"reason\":\"needed for the task\",\"details\":\"rm -rf build/$2\",\"audience\":\"$3\"}" | field '["id"]'; }
answer() { api POST "/api/permissions/$1/answer" "{\"decision\":\"$2\",\"by\":\"$3\",\"note\":\"$4\"}"; }
pstatus() { api GET /api/permissions | python3 -c "import json,sys; print(next(r['status'] for r in json.load(sys.stdin) if r['id']=='$1'))"; }
audience() { api GET /api/permissions | python3 -c "import json,sys; print(next(r['audience'] for r in json.load(sys.stdin) if r['id']=='$1'))"; }
kinds() { api GET "/api/agents/$1/waits" | python3 -c 'import json,sys; print(",".join((w["kind"] or "") + ("/" + w["target"] if w["target"] else "") for w in json.load(sys.stdin)))'; }
detail() { api GET "/api/agents/$1/waits" | python3 -c 'import json,sys; print(" ".join(w["detail"] or "" for w in json.load(sys.stdin)))'; }
badge() { api GET /api/agents | python3 -c "import json,sys; print(next(a.get('pending_requests',0) for a in json.load(sys.stdin) if a['id']=='$1'))"; }
humanpending() { api GET '/api/permissions?status=pending&audience=human' | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
# The human's inbox threads as text, and the number of mails in it whose subject is "Permission: $1".
inbox() { hapi GET '/api/agents/human/threads?limit=100'; }
count() { inbox | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for t in d for m in t['mails'] if m['subject']=='Permission: $1'))"; }
mailbody() { inbox | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(m['body'] for t in d for m in t['mails'] if m['subject']=='Permission: $1'))"; }
notices() { api GET "/api/agents/$1/events" | python3 -c 'import json,sys; print("\n".join(e.get("data") or "" for e in json.load(sys.stdin) if e["type"]=="notice:queued"))'; }
fail() { echo "FAIL: $1"; exit 1; }

P=$(reg boss); C=$(reg kid); L=$(reg loner)
parent "$C" "$P"

echo "-- an invalid audience is refused, with both values explained"
[ "$(code /api/permissions "{\"agent\":\"$C\",\"action\":\"x\",\"reason\":\"y\",\"audience\":\"boss\"}")" = 400 ] || fail "an invalid audience wasn't a 400"
api POST /api/permissions "{\"agent\":\"$C\",\"action\":\"x\",\"reason\":\"y\",\"audience\":\"boss\"}" | grep -q "'delegate' when your parent" || fail "the refusal doesn't explain the values"

echo "-- an ask without an audience defaults to delegate when the agent has a live parent, and is logged"
R=$(api POST /api/permissions "{\"agent\":\"$C\",\"action\":\"Default to parent\",\"reason\":\"needed\",\"details\":\"\"}" | field '["id"]')
[ "$(audience "$R")" = delegate ] || fail "audience is $(audience "$R")"
[ "$(count 'Default to parent')" = 0 ] || fail "the human got mail for a defaulted delegate ask"
[ "$(kinds "$C")" = "agent/$P" ] || fail "requester waits: $(kinds "$C")"
api GET "/api/agents/$C/events" | grep -q "permission:audience-defaulted" || fail "the default wasn't logged"
answer "$R" deny "$P" "not now" | grep -q denied || fail "the parent's denial failed"

echo "-- an ask without an audience defaults to human when the agent has no live parent or chief of staff"
R=$(api POST /api/permissions "{\"agent\":\"$L\",\"action\":\"Default to human\",\"reason\":\"needed\",\"details\":\"\"}" | field '["id"]')
[ "$(audience "$R")" = human ] || fail "audience is $(audience "$R")"
[ "$(count 'Default to human')" = 1 ] || fail "the human didn't get the defaulted ask"
[ "$(kinds "$L")" = "human/$R" ] || fail "requester waits: $(kinds "$L")"
api GET "/api/agents/$L/events" | grep -q "permission:audience-defaulted" || fail "the default wasn't logged"
hapi POST "/api/permissions/$R/answer" '{"approve":false,"note":"no"}' >/dev/null

echo "-- a delegate ask reaches the parent only: no human mail, row or badge"
R=$(ask "$C" "Delete build" delegate)
[ "$(count 'Delete build')" = 0 ] || fail "the human got mail for a delegate ask"
[ "$(humanpending)" = 0 ] || fail "a delegate ask is in the human's pending list"
[ "$(badge "$C")" = 0 ] || fail "a delegate ask shows a badge"
[ "$(kinds "$C")" = "agent/$P" ] || fail "requester waits: $(kinds "$C")"
[ "$(detail "$C")" = "your parent or the chief of staff" ] || fail "wait detail: $(detail "$C")"
api GET "/api/agents/$P/inbox?limit=20" | grep -q "Permission: Delete build" || fail "the parent didn't get the request mail"
answer "$R" approve "$P" "go ahead" | grep -q approved || fail "the parent's approval was refused"
[ "$(pstatus "$R")" = approved ] || fail "status is $(pstatus "$R")"
[ "$(kinds "$C")" = "" ] || fail "the wait stayed: $(kinds "$C")"
notices "$C" | grep -q "approved" || fail "the requester wasn't told"

echo "-- escalating mails the human one standalone mail, and the ask is then the human's"
R=$(ask "$C" "Spend money" delegate)
[ "$(code "/api/permissions/$R/answer" "{\"decision\":\"escalate\",\"by\":\"$P\",\"note\":\"\"}")" = 409 ] || fail "an escalation without a reason was accepted"
answer "$R" escalate "$P" "costs real money" | grep -q "\"audience\":\"human\"" || fail "escalation didn't make it a human ask"
[ "$(audience "$R")" = human ] || fail "audience is $(audience "$R")"
[ "$(count 'Spend money')" = 1 ] || fail "the human got $(count 'Spend money') mails"
B=$(mailbody 'Spend money')
echo "$B" | grep -q "rm -rf build/Spend money" || fail "the mail lacks the original details"
echo "$B" | grep -q "needed for the task" || fail "the mail lacks the original reason"
echo "$B" | grep -q "@boss escalated this: costs real money" || fail "the mail lacks the escalation line: $B"
[ "$(humanpending)" = 1 ] || fail "the escalated ask isn't in the human's list"
[ "$(badge "$C")" = 1 ] || fail "the escalated ask has no badge"
[ "$(kinds "$C")" = "human/$R" ] || fail "requester waits: $(kinds "$C")"
notices "$C" | grep -q "escalated" || fail "the requester wasn't told of the escalation"
[ "$(code "/api/permissions/$R/answer" "{\"decision\":\"approve\",\"by\":\"$P\",\"note\":\"ok\"}")" = 409 ] || fail "the parent approved a human ask"
answer "$R" approve "$P" ok | grep -q "human's to approve" || fail "the refusal doesn't say to leave it to the human"
hapi POST "/api/permissions/$R/answer" '{"approve":true,"note":"I authorize"}' | grep -q approved || fail "the human's approval failed"
[ "$(pstatus "$R")" = approved ] || fail "status is $(pstatus "$R")"
[ "$(kinds "$C")" = "" ] || fail "the human wait stayed: $(kinds "$C")"

echo "-- a delegate ask with no live parent or chief of staff goes to the human, and says why"
R=$(ask "$L" "Alone" delegate)
[ "$(audience "$R")" = human ] || fail "audience is $(audience "$R")"
[ "$(count 'Alone')" = 1 ] || fail "the human didn't get the ask"
mailbody 'Alone' | grep -q "no parent or chief of staff to decide" || fail "the mail doesn't say why"
[ "$(kinds "$L")" = "human/$R" ] || fail "requester waits: $(kinds "$L")"
hapi POST "/api/permissions/$R/answer" '{"approve":false,"note":"no"}' >/dev/null

echo "-- a human ask: the parent gets a quiet notice, can't approve, and its denial withdraws the human's copy"
R=$(ask "$C" "Push to prod" human)
[ "$(count 'Push to prod')" = 1 ] || fail "the human didn't get the ask"
notices "$P" | grep -q "$R" || fail "the parent wasn't told of the human ask"
api GET "/api/agents/$P/inbox?limit=20" | grep -q "Permission: Push to prod" && fail "the parent got the request as mail"
[ "$(code "/api/permissions/$R/answer" "{\"decision\":\"approve\",\"by\":\"$P\",\"note\":\"ok\"}")" = 409 ] || fail "the parent approved a human ask"
[ "$(pstatus "$R")" = pending ] || fail "the refused approval changed the status"
answer "$R" deny "$P" "not allowed" | grep -q denied || fail "the parent's denial failed"
# The withdrawal runs after the answer returns.
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(count 'Push to prod')" = 0 ] && break; sleep 0.5; done
[ "$(count 'Push to prod')" = 0 ] || fail "the denied ask is still in the human's inbox"
hapi GET '/api/agents/human/threads?limit=100&archived=1' | grep -q "Answered by @boss: denied" || fail "the denial didn't withdraw the human's copy"
R2=$(ask "$C" "Push again" human)
hapi POST "/api/permissions/$R2/answer" '{"approve":true,"note":"I authorize"}' | grep -q approved || fail "the human's approval failed"

echo "-- a paused parent isn't live: the ask goes to the chief of staff, and with it paused too to the human (S-589)"
S=$(reg cos)
setting() { python3 -c 'import json,sys; f=sys.argv[1]; d=json.load(open(f)); d[sys.argv[2]]=json.loads(sys.argv[3]); json.dump(d, open(f,"w"))' "$STAM_HOME/settings.json" "$1" "$2"; }
setting chiefOfStaff '"cos"'
hapi POST "/api/agents/$P/pause" '{}' | grep -q '"paused"' || fail "the parent didn't pause"
R=$(ask "$C" "Parent paused" delegate)
[ "$(audience "$R")" = delegate ] || fail "audience is $(audience "$R")"
[ "$(kinds "$C")" = "agent/$S" ] || fail "with the parent paused, the requester waits on: $(kinds "$C")"
api GET "/api/agents/$S/inbox?limit=20" | grep -q "Permission: Parent paused" || fail "the chief of staff didn't get the ask"
answer "$R" deny "$S" "not now" | grep -q denied || fail "the chief of staff's denial failed"
hapi POST "/api/agents/$S/pause" '{}' | grep -q '"paused"' || fail "the chief of staff didn't pause"
R=$(ask "$C" "All paused" delegate)
[ "$(audience "$R")" = human ] || fail "with everyone paused, audience is $(audience "$R")"
[ "$(count 'All paused')" = 1 ] || fail "the human didn't get the ask"
# A paused parent may still deny what reached it.
answer "$R" deny "$P" "no" | grep -q denied || fail "the paused parent couldn't deny"
hapi POST "/api/agents/$P/unpause" '{}' >/dev/null
hapi POST "/api/agents/$S/unpause" '{}' >/dev/null

echo "-- a dialog nobody answers in time goes to the human once; an escalated or answered one doesn't (S-589)"
dialog() { api POST "/api/hook/claude/$1" "{\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/elsewhere/$2.log\"}}" >/dev/null; }
pdialog() { api GET '/api/permissions?status=pending' | python3 -c "import json,sys; print(next((r['id'] for r in json.load(sys.stdin) if r['agent_id']=='$1' and r['dialog']), ''))"; }
subj() { inbox | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for t in d for m in t['mails'] if m['subject']=='$1'))"; }
K1=$(reg k1); K2=$(reg k2); K3=$(reg k3); K4=$(reg k4)
for k in "$K1" "$K2" "$K3" "$K4"; do parent "$k" "$P"; done
dialog "$K1" one
dialog "$K2" two
dialog "$K4" four
has_dialogs() { [ -n "$(pdialog "$K1")" ] && [ -n "$(pdialog "$K2")" ] && [ -n "$(pdialog "$K4")" ]; }
wait_until has_dialogs
D1=$(pdialog "$K1"); D2=$(pdialog "$K2"); D4=$(pdialog "$K4")
echo "-- a delegated dialog names who it is with, and stam permissions lists it apart (S-594)"
with_of() { api GET '/api/permissions?status=pending' | python3 -c "import json,sys; print(','.join(next(r for r in json.load(sys.stdin) if r['id']=='$1').get('with') or []))"; }
[ "$(with_of "$D1")" = "boss,cos" ] || fail "the delegated dialog is with: $(with_of "$D1")"
subject_of() { api GET '/api/permissions?status=pending' | python3 -c "import json,sys; print(next(r for r in json.load(sys.stdin) if r['id']=='$1').get('subject') or '')"; }
[ "$(subject_of "$D1")" = "k1 asks to use Read: /elsewhere/one.log" ] || fail "the delegated dialog's subject is: $(subject_of "$D1")"
"$STAM" permissions | sed -n '/^With a parent or the chief of staff/,$p' >"$TEST_TMP/with.txt"
grep -q "^$D1 " "$TEST_TMP/with.txt" || fail "stam permissions doesn't list the delegated dialog: $("$STAM" permissions)"
grep -q "with: @boss, @cos" "$TEST_TMP/with.txt" || fail "stam permissions doesn't say who it is with: $(cat "$TEST_TMP/with.txt")"
"$STAM" permissions | sed '/^With a parent/,$d' | grep -q "^$D1 " && fail "the delegated dialog is listed as the human's"
# k4 is shut down with its dialog pending: no hook says so, and nothing is left on screen to answer.
hapi POST "/api/agents/$K4/shutdown" '{"now":true}' >/dev/null
gone4() { [ "$(pstatus "$D4")" = withdrawn ]; }
wait_until gone4
[ "$(audience "$D1")" = delegate ] || fail "the dialog's audience is $(audience "$D1")"
answer "$D1" escalate "$P" "it needs that log" | grep -q '"audience":"human"' || fail "the parent couldn't escalate the dialog"
"$STAM" permissions | sed '/^With a parent/,$d' | grep -q "^$D1 " || fail "the escalated dialog isn't listed as the human's"
"$STAM" permissions | sed -n '/^With a parent/,$p' | grep -q "^$D1 " && fail "the escalated dialog is still listed as with its reviewers"
[ -z "$(with_of "$D1")" ] || fail "the escalated dialog still names reviewers"
# k2 shows no dialog on screen, so the parent's denial closes the request.
answer "$D2" deny "$P" "no" >/dev/null
[ "$(pstatus "$D2")" != pending ] || fail "the answered dialog is still pending"
setting dialogEscalateMinutes 0
# With the chief of staff paused, k3's dialog goes to the parent alone, and the human's mail names only it.
hapi POST "/api/agents/$S/pause" '{}' >/dev/null
dialog "$K3" three
has_d3() { [ -n "$(pdialog "$K3")" ]; }
wait_until has_d3
D3=$(pdialog "$K3")
tohuman() { [ "$(audience "$D3")" = human ]; }
wait_until tohuman
timed() { [ "$(subj 'k3 asks to use Read: /elsewhere/three.log')" = 1 ]; }
wait_until timed
B=$(inbox | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(m['body'] for t in d for m in t['mails'] if m['subject']=='k3 asks to use Read: /elsewhere/three.log'))")
echo "$B" | grep -q "It went to @boss first, and stam's settings send dialogs on without waiting for an answer, so it comes to you" || fail "the timed-out mail doesn't say who it went to: $B"
echo "$B" | grep -q "answer_permission" && fail "the human's mail carries the reviewers' hint"
[ "$(kinds "$K3")" = "human/$D3" ] || fail "the timed-out requester waits on: $(kinds "$K3")"
notices "$K3" | grep -q "escalated to your user by stam" || fail "the requester wasn't told it went to the human"
[ "$(code "/api/permissions/$D3/answer" "{\"decision\":\"escalate\",\"by\":\"$P\",\"note\":\"late\"}")" = 409 ] || fail "the parent escalated a dialog that had timed out"
# The sweep that sent k3's on ran after the escalation and the answer: neither went to the human again.
[ "$(subj 'k1 asks to use Read: /elsewhere/one.log')" = 1 ] || fail "the escalated dialog reached the human $(subj 'k1 asks to use Read: /elsewhere/one.log') times"
[ "$(subj 'k2 asks to use Read: /elsewhere/two.log')" = 0 ] || fail "the answered dialog reached the human"
[ "$(subj 'k3 asks to use Read: /elsewhere/three.log')" = 1 ] || fail "the timed-out dialog reached the human more than once"
api GET "/api/agents/$K1/events" | grep -q '"by":"stam"' && fail "the escalated dialog timed out too"
[ "$(subj 'k4 asks to use Read: /elsewhere/four.log')" = 0 ] || fail "the shut-down agent's dialog reached the human"

echo "PASS e2e-delegate-ask"
