#!/bin/sh
# The palette's search by meaning (S-143), free (no model): GET /api/search ranks the human's mail
# threads and ITSAs by meaning, with a query worded differently from their subjects and titles, and
# returns both kinds in one list. With search.embedder 'off' the same route answers by keyword only.
# Runs on a throwaway daemon (test/lib.sh) with the stub embedder (STAM_EMBEDDER=stub), so no model runs.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# The query shares stems with the mail body and the ITSA body only; neither title nor subject has them.
Q="keeps redirecting users"

LIB=$(post /api/register '{"name":"librarian","role":"keeps the records","harness":"external"}' | jget "d['id']")
MAIL=$(post /api/mail "{\"from\":\"$LIB\",\"to\":[\"human\"],\"subject\":\"Sign-in bounce\",\"body\":\"users keep getting redirected back to the sign-in page after logout\",\"new_thread\":true}" | jget "d.get('thread_id') or d['id']")
post /api/mail "{\"from\":\"$LIB\",\"to\":[\"human\"],\"subject\":\"Dinner plans\",\"body\":\"unrelated chatter about the weekend\",\"new_thread\":true}" >/dev/null
ITSA=$(post /api/itsas '{"by":"human","title":"Login regression","summary":"Sign-in breaks for returning people","body":"Users keep getting redirected back to the sign-in page after logout; the session cookie is dropped."}' | jget "d['id']")
[ -n "$MAIL" ] && [ -n "$ITSA" ] || fail "creating the mail or the ITSA"

# Both kinds by meaning: wait on the results, not a timer, until the new text is indexed.
found() { get "/api/search?q=$(printf '%s' "$Q" | sed 's/ /%20/g')&limit=10" | jget "any(x['kind']=='thread' and x['id']=='$MAIL' for x in d) and any(x['kind']=='itsa' and x['id']=='$ITSA' for x in d)" | grep -q True; }
wait_until found

OUT=$(get "/api/search?q=$(printf '%s' "$Q" | sed 's/ /%20/g')&limit=10")
# The meaning hits carry their ranking and a snippet that reads as text (the mail's excerpt, the ITSA's summary or body).
echo "$OUT" | jget "[x['by'] for x in d if x['kind'] in ('thread','itsa')]" | grep -q "'meaning'" || fail "the meaning hits aren't tagged by meaning: $OUT"
echo "$OUT" | jget "[x['snippet'] for x in d if x['kind']=='thread'][0]" | grep -q "redirected back" || fail "the mail hit's snippet doesn't read as its text"
echo "$OUT" | jget "[x['meta'] for x in d if x['kind']=='itsa'][0]" | grep -q "· " || fail "the ITSA hit's meta isn't KEY · status"
# Scores stay within 0 to 1 per kind, so the top of each kind reaches the list.
echo "$OUT" | jget "all(0 <= x['score'] <= 1 for x in d if x['kind'] in ('thread','itsa'))" | grep -q True || fail "a meaning score is outside 0 to 1"

# With search.embedder 'off' the same route answers by keyword only: the meaning query finds nothing.
unset STAM_EMBEDDER
daemon_home off
node -e 'const f=process.argv[1];const s=JSON.parse(require("fs").readFileSync(f,"utf8"));s.search={embedder:"off"};require("fs").writeFileSync(f,JSON.stringify(s,null,2))' "$TEST_TMP/off/settings.json"
daemon_up off
use off
TOKEN=$(cat "$STAM_HOME/token")
LIB=$(post /api/register '{"name":"librarian","role":"keeps the records","harness":"external"}' | jget "d['id']")
post /api/mail "{\"from\":\"$LIB\",\"to\":[\"human\"],\"subject\":\"Sign-in bounce\",\"body\":\"users keep getting redirected back to the sign-in page after logout\",\"new_thread\":true}" >/dev/null
post /api/itsas '{"by":"human","title":"Login regression","body":"Users keep getting redirected back to the sign-in page after logout."}' >/dev/null
[ "$(get "/api/search?q=$(printf '%s' "$Q" | sed 's/ /%20/g')&limit=10" | jget "len([x for x in d if x['kind'] in ('thread','itsa')])")" = 0 ] ||
  fail "with the embedder off, the meaning query still matched mail or ITSAs"
# A word in the mail body finds it by keyword, tagged as keyword.
get "/api/search?q=sign-in&limit=10" | jget "[x['by'] for x in d if x['kind']=='thread'][0]" | grep -q keyword ||
  fail "with the embedder off, the keyword search didn't find the mail by keyword"
export STAM_EMBEDDER=stub
use main
echo "PASS e2e-search-meaning"
