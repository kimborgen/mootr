#!/bin/sh
# A permission request and the asks its agent adds about it are one item (S-609): an agent's
# wait_for human made while its request is pending with the human is tied to that request (the one
# its note names, the one whose thread it waits in, or, with no thread, the newest), and clears when
# the request is answered; a wait in another thread isn't tied and stays. A note naming only a
# settled request is refused. The agent's decision mail naming a pending request isn't listed apart,
# and it, and one in the request's thread, clear when the request settles. On daemon start, the asks
# left from before (untied waits, decision mails) settle with their request, or are tied to it if it
# is still pending, and a second start changes nothing. Free and no models: registered agents plus
# the permission, wait and mail API, against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$1" -d "$2"; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | field '["id"]'; }
ask() { api POST /api/permissions "{\"agent\":\"$1\",\"action\":\"$2\",\"reason\":\"needed\",\"details\":\"\",\"audience\":\"human\"}" | field '["id"]'; }
# wait_for human as agent $1, with a note and an optional thread; prints the wait's target ("None" if untied).
waitfor() { api POST "/api/agents/$1/waits/declared" "{\"on\":\"human\",\"by\":\"$1\",\"note\":\"$2\"${3:+,\"thread\":\"$3\"}}" | field '["target"]'; }
# The agent's declared waits, as note=target pairs.
declared() { api GET "/api/agents/$1/waits" | python3 -c 'import json,sys; print(" ".join("%s=%s" % (w["detail"], w["target"]) for w in json.load(sys.stdin) if w["source"]=="declared"))'; }
listed() { api GET /api/mail/decisions | field '' | tr -d ' '; }
has() { api GET /api/mail/decisions | grep -q "\"$1\""; }
# The thread of the request's mail to the human.
permthread() { hapi GET '/api/agents/human/threads?limit=100' | python3 -c "import json,sys; print(next(t['thread_id'] for t in json.load(sys.stdin) for m in t['mails'] if m.get('permission_id')=='$1'))"; }
mail() { api POST /api/mail "$1" | field '["id"]'; }
BT='`'
FENCE="${BT}${BT}${BT}"
fail() { echo "FAIL: $1"; exit 1; }

A=$(reg alice)
OTHER=$(mail '{"from":"alice","to":["human"],"subject":"Unrelated question","body":"Which colour?","new_thread":true}')

echo "-- a wait_for human with no thread, while a request is pending, is tied to it"
R1=$(ask "$A" "Commit the rules")
[ "$(waitfor "$A" "auto-mode block on commit")" = "$R1" ] || fail "an untied wait while $R1 is pending: $(declared "$A")"

echo "-- a note that names the request ties to it, even with a newer one pending"
R2=$(ask "$A" "Merge the PR")
[ "$(waitfor "$A" "answer to $R1 (commit)")" = "$R1" ] || fail "a wait naming $R1: $(declared "$A")"
[ "$(waitfor "$A" "merge authorization")" = "$R2" ] || fail "a wait with no thread didn't tie to the newest request: $(declared "$A")"

echo "-- a wait in the request's thread ties to it; one in another thread doesn't"
T2=$(permthread "$R2")
[ "$(waitfor "$A" "in the request thread" "$T2")" = "$R2" ] || fail "a wait in $R2's thread: $(declared "$A")"
[ "$(waitfor "$A" "the colour" "$OTHER")" = None ] || fail "a wait in another thread was tied: $(declared "$A")"

echo "-- a decision mail naming a pending request isn't listed apart; one in the request's thread is its thread's"
D1=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Approve $R1?\",\"body\":\"${FENCE}yesno\nCommit the rules ($R1)?\n${FENCE}\",\"new_thread\":true}")
has "$D1" && fail "a decision mail naming pending $R1 is listed apart"
D2=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Re: merge\",\"body\":\"${FENCE}yesno\nMerge now?\n${FENCE}\",\"reply_to\":\"$T2\"}")
has "$D2" || fail "a decision mail in a request's thread isn't recorded"
D3=$(mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Other pick\",\"body\":\"${FENCE}yesno\nShip?\n${FENCE}\",\"new_thread\":true}")
has "$D3" || fail "an unrelated decision mail isn't listed"

echo "-- answering the request clears the waits and decision mails tied to it, and nothing else"
hapi POST "/api/permissions/$R1/answer" '{"approve":true,"note":"ok"}' | grep -q approved || fail "the human's approval failed"
D="$(declared "$A")"
case "$D" in *"=$R1"*) fail "a wait tied to $R1 is left after its answer: $D" ;; esac
case "$D" in *"merge authorization=$R2"*) ;; *) fail "a wait tied to pending $R2 went with $R1: $D" ;; esac
has "$D1" && fail "the decision mail naming $R1 is listed after its answer"
hapi POST "/api/permissions/$R2/answer" '{"approve":false,"note":"not yet"}' | grep -q denied || fail "the human's denial failed"
[ "$(declared "$A")" = "the colour=None" ] || fail "waits left after both answers: $(declared "$A")"
has "$D2" && fail "the decision mail in $R2's thread is listed after its denial"
has "$D3" || fail "an unrelated decision mail went with the requests"

echo "-- a note naming only a settled request is refused, with no thread to wait in"
[ "$(code "/api/agents/$A/waits/declared" "{\"on\":\"human\",\"by\":\"$A\",\"note\":\"answer to $R1\"}")" = 400 ] || fail "a wait on settled $R1 wasn't refused: $(cat "$TEST_TMP/body")"
grep -q "already approved" "$TEST_TMP/body" || fail "the refusal doesn't say why: $(cat "$TEST_TMP/body")"
[ "$(waitfor "$A" "follow-up on $R1" "$OTHER")" = None ] || fail "a wait in a thread naming settled $R1 was refused or tied"
[ "$(waitfor "$A" "a plain reply")" = None ] || fail "a wait with no request pending was tied"

echo "-- on start, the asks left from before settle with their request, or tie to it while pending"
B=$(reg bob)
S1=$(ask "$B" "Old settled ask")
S2=$(ask "$B" "Old pending ask")
S3=$(ask "$B" "Old withdrawn ask")
# A decision mail naming S1, sent while it was pending, from an older daemon that didn't hide it.
DS=$(mail "{\"from\":\"bob\",\"to\":[\"human\"],\"subject\":\"About $S1\",\"body\":\"${FENCE}yesno\nGo ($S1)?\n${FENCE}\",\"new_thread\":true}")
daemon_stop main
python3 - "$STAM_HOME/stam.db" "$B" "$S1" "$S2" "$S3" "$DS" <<'EOF'
import sqlite3, sys
db, b, s1, s2, s3, ds = sys.argv[1:]
c = sqlite3.connect(db)
w = "INSERT INTO waits (id, agent_id, kind, target, detail, since, source, data) VALUES (?, ?, 'human', NULL, ?, ?, 'declared', ?)"
# Waits an older daemon left untied: the times put each in its request's pending window.
c.execute("UPDATE permission_requests SET created_at = '2026-10-14T06:00:00.000Z' WHERE id IN (?, ?, ?)", (s1, s2, s3))
c.execute("UPDATE permission_requests SET status = 'approved', decided_by = 'human', decided_at = '2026-10-14T06:30:00.000Z' WHERE id = ?", (s1,))
c.execute("UPDATE permission_requests SET status = 'withdrawn', decided_at = '2026-10-14T06:30:00.000Z' WHERE id = ?", (s3,))
c.execute(w, ('wstale1', b, 'answer to ' + s1, '2026-10-14T06:10:00.000Z', '{"on":"human"}'))
c.execute(w, ('wstale3', b, 'about ' + s3, '2026-10-14T06:10:00.000Z', '{"on":"human"}'))
c.execute(w, ('wtie', b, 'auto-mode block', '2026-10-14T06:40:00.000Z', '{"on":"human"}'))
c.execute(w, ('wkeep', b, 'colour pick', '2026-10-14T06:40:00.000Z', '{"on":"human","thread":"mnothere"}'))
c.execute("UPDATE mail SET created_at = '2026-10-14T06:20:00.000Z' WHERE id = ?", (ds,))
c.commit()
EOF
daemon_up main
D="$(declared "$B")"
case "$D" in *"answer to $S1"* | *"about $S3"*) fail "a wait on a settled request survived the start: $D" ;; esac
case "$D" in *"auto-mode block=$S2"*) ;; *) fail "an untied wait while $S2 is pending wasn't tied: $D" ;; esac
case "$D" in *"colour pick=None"*) ;; *) fail "a wait in another thread was touched: $D" ;; esac
has "$DS" && fail "a decision mail about settled $S1 survived the start"
BEFORE="$(declared "$B") $(listed)"
daemon_stop main
daemon_up main
[ "$(declared "$B") $(listed)" = "$BEFORE" ] || fail "a second start changed something: $BEFORE -> $(declared "$B") $(listed)"

echo "ok: permission-asks"
