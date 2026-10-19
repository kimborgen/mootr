#!/bin/sh
# The human's reply to a thread a system sender (system:NAME, the deploy watcher) wrote in (S-542),
# free (no models). The web UI named the script as a recipient; the daemon answered 500 ("no agent
# system:deploy-watch"), which the web outbox retries, so the reply sat on "retrying". Registered
# agents on one daemon, mail driven through the API:
#   - in an ITSA's thread, a reply naming an agent and system:deploy-watch reaches the agent
#   - in a plain thread, a reply naming system:deploy-watch beside an agent reaches the agent
#   - a reply whose only recipient is a script, or that names an agent nobody has, is a 400
#     (final: the outbox shows its reason) and stores nothing
#   - the human's reply to a forgotten agent, in a plain or an ITSA thread, is a 400 whose reason
#     names the agent and says what to do (it was "no agent ID", or a 500 in an ITSA thread)
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
trap stam_test_cleanup EXIT
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${4:+-H 'x-stam-human: 1'} "$STAM_URL$2" ${3:+-d "$3"}; }
# status METHOD PATH JSON: the HTTP status of a request as the human.
status() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$STAM_URL$2" -d "$3"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
fail() { echo "FAIL: $1"; exit 1; }
# got THREAD BOX TEXT: whether THREAD holds a mail with body TEXT that BOX received.
got() { api GET "/api/threads/$1" | jget "any(m['body']=='$3' and any(r['id']=='$2' for r in m['recipients']) for m in d)"; }

REQ=$(reg requirements)
KEY=$("$STAM" itsa new "Deploy drain" --owner requirements | awk '{print $1}')
"$STAM" itsa post "$KEY" --system deploy-watch "deployed" >/dev/null || fail "the deploy watcher can't post"
TID=$(api GET "/api/itsas/$KEY" | jget "d['thread_id']")
LAST=$(api GET "/api/itsas/$KEY/thread" | jget "[i for i in d['items'] if i['type']=='mail'][-1]['mail']['id']")

echo "-- in an ITSA's thread, a reply naming the script still reaches the agent"
C=$(status POST /api/mail "{\"from\":\"human\",\"to\":[\"$REQ\",\"system:deploy-watch\"],\"reply_to\":\"$LAST\",\"body\":\"itsa reply\"}")
[ "$C" = 200 ] || fail "the reply in the ITSA thread got $C: $(cat "$TEST_TMP/body")"
jget "d['thread_id']" <"$TEST_TMP/body" | grep -qx "$TID" || fail "the reply left the ITSA's thread: $(cat "$TEST_TMP/body")"
[ "$(got "$TID" "$REQ" "itsa reply")" = True ] || fail "requirements didn't get the reply in the ITSA thread"

echo "-- in a plain thread, a reply naming the script beside an agent reaches the agent"
M=$("$STAM" mail send --system deploy-watch --to requirements --subject "Deploy drain" "draining" | awk '{print $2}')
[ -n "$M" ] || fail "the deploy watcher can't mail"
C=$(status POST /api/mail "{\"from\":\"human\",\"to\":[\"system:deploy-watch\",\"$REQ\"],\"reply_to\":\"$M\",\"body\":\"plain reply\"}")
[ "$C" = 200 ] || fail "the reply in the plain thread got $C: $(cat "$TEST_TMP/body")"
[ "$(got "$M" "$REQ" "plain reply")" = True ] || fail "requirements didn't get the reply in the plain thread"

echo "-- a reply to the script alone, or to nobody known, is a 400 and stores nothing"
C=$(status POST /api/mail "{\"from\":\"human\",\"to\":[\"system:deploy-watch\"],\"reply_to\":\"$M\",\"body\":\"to the script\"}")
[ "$C" = 400 ] || fail "a reply to the script alone got $C, not 400: $(cat "$TEST_TMP/body")"
grep -q "no recipients" "$TEST_TMP/body" || fail "the 400 doesn't say why: $(cat "$TEST_TMP/body")"
C=$(status POST /api/mail "{\"from\":\"human\",\"to\":[\"nobody-here\"],\"reply_to\":\"$M\",\"body\":\"to nobody\"}")
[ "$C" = 400 ] || fail "a reply to an unknown agent got $C, not 400: $(cat "$TEST_TMP/body")"
grep -q "nobody-here no longer exists" "$TEST_TMP/body" || fail "the 400 doesn't name the agent: $(cat "$TEST_TMP/body")"
api GET "/api/threads/$M" | jget "[m['body'] for m in d]" | grep -q "to the script\|to nobody" && fail "a refused reply was stored"

echo "-- a reply to a forgotten agent names it and says what to do, in a plain and an ITSA thread"
GONE=$(reg gone)
api POST /api/mail "{\"from\":\"$GONE\",\"to\":[\"$REQ\"],\"subject\":\"Hello\",\"body\":\"hi\",\"new_thread\":true}" >/dev/null
G=$(api POST /api/mail "{\"from\":\"human\",\"to\":[\"$GONE\"],\"subject\":\"State\",\"body\":\"over to you\",\"new_thread\":true}" human | jget "d['id']")
GKEY=$("$STAM" itsa new "Gone owner" --owner requirements --participant gone | awk '{print $1}')
GP=$(api POST "/api/itsas/$GKEY/post" '{"by":"human","body":"over to you both"}' human | jget "d['id']")
api POST "/api/agents/$GONE/kill" '{}' >/dev/null
api POST "/api/agents/$GONE/forget" '{}' | grep -q forgot || fail "gone wasn't forgotten"
WANT="gone no longer exists. Reply to someone else, or copy your text."
for parent in "$G" "$GP"; do
  C=$(status POST /api/mail "{\"from\":\"human\",\"to\":[\"$GONE\"],\"reply_to\":\"$parent\",\"body\":\"still there?\"}")
  [ "$C" = 400 ] || fail "a reply to forgotten gone (in reply to $parent) got $C, not 400: $(cat "$TEST_TMP/body")"
  grep -qF "$WANT" "$TEST_TMP/body" || fail "the 400 doesn't say what to do: $(cat "$TEST_TMP/body")"
done

echo "PASS: a reply naming a system sender reaches the agents; one with nobody to reach is a 400 that says why"
