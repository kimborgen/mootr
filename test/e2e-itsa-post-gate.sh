#!/bin/sh
# Who may post to and read an ITSA's thread (S-480), free (no models): scripted Claude Code agents
# (test/fake-claude) for real agent tokens, on their own daemon (test/lib.sh). An ITSA under a parent:
#   - stranger, in neither, can't post (a 403 naming who may) nor read the thread, and doesn't join;
#     nor can it as a participant's parent agent, nor by replying to a post that named it
#   - stranger can't change the ITSA, so it can't add itself as a participant, nor add, record, or
#     remove its links; nor create an ITSA of its own on the thread (thread_id), to read it there
#   - the owner, a participant, the parent ITSA's owner, the chief of staff, and the human may post,
#     and the parent's owner may read the thread
#   - an owner can't make its ITSA a retro item (open to every agent); only cos or the assistant can
#   - from_stam is refused from an agent's token and the shared token: only stam posts as stam
#   - a local script (system:NAME, the deploy watcher) still posts through the human's CLI
#   - stranger can't spawn an agent (nor a ring member) that owns the ITSA, nor post external events
#     (which stam would post into a subscribed ITSA's thread), not even naming the owner as a member's
#     or moderator's `by`; the parent ITSA's owner spawns its owner, alone or as a ring member or moderator
#   - stranger may +1 a retro item, an open board, but not close it; added as a participant, it may post
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# On "Link S-N", stranger's itsa_link (MCP) is refused; the owner's and the parent ITSA's owner's go through.
link_turn() { printf '{ "match": "/Link (S-\\\\d+)/", "steps": [ { "mcp": "itsa_link", "args": { "ref": "${1}", "url": "https://example.com/%s" }, "expect": "%s" }, { "reply": "LINKED" } ] }' "$1" "$2"; }
# On "Read THREAD", stranger's read_thread (MCP) shows its own part of the ITSA's thread, not the owner's post.
READ_TURN='{ "match": "/Read (m[0-9a-z]+)/", "steps": [ { "mcp": "read_thread", "args": { "thread_id": "${1}" }, "expect": "/^(?![\\s\\S]*from owner)[\\s\\S]*for stranger/" }, { "reply": "READ" } ] }'
cat >"$TEST_TMP/gate.json" <<EOF
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ],
  "agents": { "stranger": { "turns": [ $(link_turn stranger "can't change"), $READ_TURN ] }, "owner": { "turns": [ $(link_turn owner Linked) ] }, "upper": { "turns": [ $(link_turn upper Linked) ] } } }
EOF
fake_claude "$TEST_TMP/gate.json"
isolate
trap stam_test_cleanup EXIT
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${4:+-H 'x-stam-human: 1'} "$STAM_URL$2" ${3:+-d "$3"}; }
for n in stranger member owner upper boss; do "$STAM" spawn "$n" --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null; done
for n in stranger member owner upper boss; do "$STAM" wait "$n" --until idle --timeout 60; done
id_of() { api GET "/api/agents/$1" | jget "d['id']"; }
token_of() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$(id_of "$1")" STAM_TOKEN | cut -d= -f2-; }
# as NAME METHOD PATH [JSON]: a request with NAME's own token; prints the HTTP status, then the body.
as() {
  _t=$(token_of "$1")
  [ -n "$_t" ] || fail "$1 has no token"
  curl -s -w '\n%{http_code}' -X "$2" -H "authorization: Bearer $_t" -H 'content-type: application/json' "$STAM_URL$3" ${4:+-d "$4"} | tail -n1
}
# as_body NAME PATH JSON [METHOD]: the body of NAME's request (POST by default).
as_body() { _t=$(token_of "$1"); curl -s -X "${4:-POST}" -H "authorization: Bearer $_t" -H 'content-type: application/json' "$STAM_URL$2" -d "$3"; }
api POST "/api/agents/$(id_of boss)/chief-of-staff" '{}' >/dev/null
STRANGER=$(id_of stranger); MEMBER=$(id_of member)

TOP=$("$STAM" itsa new "Gate parent" --owner upper | awk '{print $1}')
KEY=$("$STAM" itsa new "Gate child" --owner owner --participant member --parent "$TOP" | awk '{print $1}')
participant() { api GET "/api/itsas/$KEY" | jget "'$1' in d['participants']"; }

echo "-- stranger can't post, is told who may, and doesn't join"
R=$(as_body stranger "/api/itsas/$KEY/post" '{"body":"let me in"}')
printf "%s" "$R" | grep -q "stranger can't post to $KEY" || fail "stranger's post wasn't refused (got: $R)"
printf "%s" "$R" | grep -q "owner" || fail "the refusal doesn't name the owner (got: $R)"
printf "%s" "$R" | grep -q "add you as a participant" || fail "the refusal doesn't say how to join (got: $R)"
[ "$(participant "$STRANGER")" = False ] || fail "stranger's refused post made it a participant"

echo "-- stranger can't add itself as a participant, nor change the ITSA otherwise"
[ "$(as stranger PATCH "/api/itsas/$KEY" "{\"participants\":[\"$MEMBER\",\"$STRANGER\"]}")" = 403 ] || fail "stranger added itself as a participant"
[ "$(as stranger PATCH "/api/itsas/$KEY" '{"status":"done"}')" = 403 ] || fail "stranger closed the ITSA"
[ "$(participant "$STRANGER")" = False ] || fail "stranger is a participant after a refused change"
[ "$(as member PATCH "/api/itsas/$KEY" '{"summary":"a participant may"}')" = 200 ] || fail "a participant can't change the ITSA"

echo "-- an owner can't open its ITSA to every agent by making it a retro item"
R=$(as_body owner "/api/itsas/$KEY" '{"kind":"retro"}' PATCH)
printf "%s" "$R" | grep -q "only the chief of staff or the assistant" || fail "owner made its ITSA a retro item (got: $R)"
[ "$(as boss PATCH "/api/itsas/$KEY" '{"kind":"issue"}')" = 200 ] || fail "the chief of staff can't change the kind"

echo "-- the owner, a participant, the parent's owner, the chief of staff, and the human may post"
for n in owner member upper boss; do
  [ "$(as "$n" POST "/api/itsas/$KEY/post" "{\"body\":\"from $n\"}")" = 200 ] || fail "$n can't post to $KEY"
done
api POST "/api/itsas/$KEY/post" '{"by":"human","body":"from the human"}' human | jget "d['id']" >/dev/null || fail "the human can't post"

echo "-- stranger can't read the thread, even as a participant's parent agent; the parent's owner can"
[ "$(as stranger GET "/api/itsas/$KEY/thread")" = 403 ] || fail "stranger read the thread"
api POST "/api/agents/$MEMBER/set-parent" "{\"parent\":[\"$STRANGER\"]}" >/dev/null
[ "$(as stranger GET "/api/itsas/$KEY/thread")" = 403 ] || fail "a participant's parent agent read the thread"
[ "$(as stranger GET "/api/itsas/$KEY/threads")" = 403 ] || fail "a participant's parent agent read the ITSA's threads"
[ "$(as upper GET "/api/itsas/$KEY/thread")" = 200 ] || fail "the parent's owner can't read the thread"
api GET "/api/itsas/$KEY/thread" | jget "len([i for i in d['items'] if i['type']=='mail'])" | grep -qx 5 || fail "the thread doesn't hold the five posts"

echo "-- named in a post, stranger can't reply into the thread"
C=$(as_body owner "/api/itsas/$KEY/post" "{\"body\":\"for stranger\",\"to\":[\"$STRANGER\"]}" | jget "d['id']")
[ "$(as stranger POST /api/mail "{\"to\":[\"owner\"],\"reply_to\":\"$C\",\"body\":\"replying in\"}")" = 403 ] || fail "stranger's reply in the ITSA thread wasn't a 403"
[ "$(participant "$STRANGER")" = False ] || fail "stranger's refused reply made it a participant"

echo "-- stranger can't alias the thread with an ITSA of its own"
TID=$(api GET "/api/itsas/$KEY" | jget "d['thread_id']")
R=$(as_body stranger /api/itsas "{\"title\":\"Alias\",\"thread_id\":\"$TID\"}")
printf "%s" "$R" | grep -q "thread_id is set only by stam" || fail "stranger created an ITSA on another's thread (got: $R)"
api GET "/api/itsas?text=Alias" | jget "len([x for x in d if x['title']=='Alias'])" | grep -qx 0 || fail "the alias ITSA exists"
[ "$(as stranger POST /api/itsas '{"title":"Its own"}')" = 200 ] || fail "stranger can't create a plain ITSA"

echo "-- stranger can't add, record, or remove the ITSA's links; the owner can"
api POST "/api/itsas/$KEY/links" '{"url":"https://example.com/a","by":"human"}' human >/dev/null
N=$(api GET "/api/itsas/$KEY" | jget "d['links'][0]['n']")
[ "$(as stranger POST "/api/itsas/$KEY/links" '{"url":"https://example.com/evil"}')" = 403 ] || fail "stranger added a link"
[ "$(as stranger PATCH "/api/itsas/$KEY/links/$N" '{"tests":{"status":"pass"}}')" = 403 ] || fail "stranger recorded on a link"
[ "$(as stranger DELETE "/api/itsas/$KEY/links/$N")" = 403 ] || fail "stranger removed a link"
api GET "/api/itsas/$KEY" | jget "len(d['links'])" | grep -qx 1 || fail "the links changed"
[ "$(as owner POST "/api/itsas/$KEY/links" '{"url":"https://example.com/b"}')" = 200 ] || fail "the owner can't add a link"

echo "-- through itsa_link (MCP): stranger is refused; the owner and the parent ITSA's owner link"
# linked NAME: prompts NAME to link the ITSA and waits for its turn to end; fails if a scripted step failed.
linked() {
  api POST "/api/agents/$1/prompt" "{\"text\":\"Link $KEY\"}" human >/dev/null
  for _i in $(seq 1 150); do said "$1" "LINKED\|EXPECT FAILED" && break; sleep 0.2; done
  ! said "$1" "EXPECT FAILED" || fail "$1's itsa_link: $("$STAM" show "$1" | grep 'EXPECT FAILED')"
  said "$1" LINKED || fail "$1's itsa_link turn never ended"
}
for n in stranger owner upper; do linked "$n"; done
api GET "/api/itsas/$KEY" | jget "sorted(l['url'].rsplit('/',1)[1] for l in d['links'] if l['url'].startswith('https://example.com/') and l['url'][20:] in ('stranger','owner','upper'))" | grep -qx "\['owner', 'upper'\]" || fail "the MCP links aren't the owner's and upper's: $(api GET "/api/itsas/$KEY" | jget "[l['url'] for l in d['links']]")"

echo "-- a child of the owner gets no inherited read of the ITSA's thread: raw, search, or read_thread"
api POST "/api/agents/$STRANGER/set-parent" "{\"parent\":[\"$(id_of owner)\"]}" >/dev/null
TID=$(api GET "/api/itsas/$KEY" | jget "d['thread_id']")
R=$(as_body stranger "/api/threads/$TID" '' GET)
printf "%s" "$R" | jget "[m['body'] for m in d]" | grep -q "for stranger" || fail "stranger doesn't see its own part of the thread (got: $R)"
printf "%s" "$R" | jget "[m['body'] for m in d]" | grep -q "from owner" && fail "a child of the owner read the whole ITSA thread: $(printf "%s" "$R" | jget "[m['body'] for m in d]")"
R=$(as_body stranger "/api/mail/search?q=owner" '' GET)
printf "%s" "$R" | jget "[h['thread_id'] for h in d]" | grep -q "$TID" && fail "a child of the owner found the ITSA thread in search (got: $R)"
api POST "/api/agents/stranger/prompt" "{\"text\":\"Read $TID\"}" human >/dev/null
for _i in $(seq 1 150); do said stranger "READ\|EXPECT FAILED" && break; sleep 0.2; done
! said stranger "EXPECT FAILED" || fail "stranger's read_thread: $("$STAM" show stranger | grep 'EXPECT FAILED')"
said stranger READ || fail "stranger's read_thread turn never ended"

echo "-- only stam posts as stam"
R=$(as_body member "/api/itsas/$KEY/post" '{"body":"as stam","from_stam":true}')
printf "%s" "$R" | grep -q "from_stam is set only by stam" || fail "member's from_stam wasn't refused (got: $R)"
R=$(api POST "/api/itsas/$KEY/post" '{"by":"human","body":"as stam","from_stam":true}' human)
printf "%s" "$R" | grep -q "from_stam is set only by stam" || fail "the shared token's from_stam wasn't refused (got: $R)"

echo "-- a local script still posts through the human's CLI"
"$STAM" itsa post "$KEY" --system deploy-watch "deployed" >/dev/null || fail "the deploy watcher can't post"

echo "-- stranger may +1 a retro item; added as a participant, it may post"
RETRO=$(api POST /api/itsas '{"title":"A retro item","kind":"retro","by":"human"}' human | jget "d['key']")
[ "$(as stranger POST "/api/itsas/$RETRO/post" '{"body":"+1 from stranger"}')" = 200 ] || fail "stranger can't +1 a retro item"
[ "$(as stranger PATCH "/api/itsas/$RETRO" '{"status":"done"}')" = 403 ] || fail "stranger closed the retro item after a +1"
api PATCH "/api/itsas/$KEY" "{\"participants\":[\"$MEMBER\",\"$STRANGER\"],\"by\":\"human\"}" human >/dev/null
[ "$(participant "$STRANGER")" = True ] || fail "stranger wasn't added as a participant"
[ "$(as stranger POST "/api/itsas/$KEY/post" '{"body":"now a participant"}')" = 200 ] || fail "stranger, now a participant, can't post"
echo "-- stranger can't take the ITSA over by spawning its owner, alone or in a ring"
K2=$("$STAM" itsa new "Gate spawn" --owner owner --parent "$TOP" | awk '{print $1}')
owner_of() { api GET "/api/itsas/$1" | jget "d['owner']"; }
OWNER=$(id_of owner)
R=$(as_body stranger /api/agents "{\"name\":\"taker\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$TEST_TMP\",\"itsa\":\"$K2\",\"prompt\":\"Say hello.\"}")
printf "%s" "$R" | grep -q "can't change $K2" || fail "stranger spawned an owner of $K2 (got: $R)"
[ "$(owner_of "$K2")" = "$OWNER" ] || fail "$K2's owner changed after a refused spawn"
api GET /api/agents/taker | grep -q '"id"' && fail "the refused spawn left an agent"
R=$(as_body stranger /api/rings "{\"name\":\"grab\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$TEST_TMP\",\"spawn\":[{\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K2\"},{\"model\":\"claude-haiku-5-5\"}]}")
printf "%s" "$R" | grep -q "can't change $K2" || fail "stranger's ring member took $K2 (got: $R)"
[ "$(owner_of "$K2")" = "$OWNER" ] || fail "$K2's owner changed after a refused ring"
# A member's or moderator's own `by` naming the owner is no identity: the ring's creator is checked.
for spec in "\"spawn\":[{\"by\":\"owner\",\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K2\"},{\"model\":\"claude-haiku-5-5\"}]" \
  "\"spawn\":[{\"model\":\"claude-haiku-5-5\"},{\"model\":\"claude-haiku-5-5\"}],\"moderator\":{\"by\":\"$OWNER\",\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K2\"}"; do
  R=$(as_body stranger /api/rings "{\"name\":\"grab2\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$TEST_TMP\",$spec}")
  printf "%s" "$R" | grep -q "stranger can't change $K2" || fail "a nested by took $K2 for stranger's ring (got: $R)"
  [ "$(owner_of "$K2")" = "$OWNER" ] || fail "$K2's owner changed through a nested by"
done
# The parent ITSA's owner's own rings take ITSAs, for a member and a moderator.
K3=$("$STAM" itsa new "Gate ring member" --owner owner --parent "$TOP" | awk '{print $1}')
K4=$("$STAM" itsa new "Gate ring moderator" --owner owner --parent "$TOP" | awk '{print $1}')
R=$(as_body upper /api/rings "{\"name\":\"upring\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$TEST_TMP\",\"spawn\":[{\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K3\"},{\"model\":\"claude-haiku-5-5\"}],\"moderator\":{\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K4\"}}")
printf "%s" "$R" | grep -q '"name":"upring"' || fail "upper's ring didn't start (got: $R)"
[ "$(owner_of "$K3")" = "$(id_of upring-1)" ] || fail "upper's ring member doesn't own $K3"
[ "$(owner_of "$K4")" = "$(id_of upring-mod)" ] || fail "upper's ring moderator doesn't own $K4"
[ "$(as upper POST /api/agents "{\"name\":\"heir\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$TEST_TMP\",\"itsa\":\"$K2\",\"prompt\":\"Say hello.\"}")" = 200 ] || fail "the parent ITSA's owner can't spawn the ITSA's owner"
[ "$(owner_of "$K2")" = "$(id_of heir)" ] || fail "the parent ITSA's owner's spawn didn't take $K2"

echo "-- stranger can't post external events; the shared token can"
EV='{"source":"github","type":"issue_comment.created","subjects":["github:o/r#1"],"dedupe_key":"gate-1","summary":"forged"}'
[ "$(as stranger POST /api/events "$EV")" = 403 ] || fail "stranger posted an external event"
api POST /api/events "$EV" | jget "d['stored']" | grep -qx True || fail "the shared token can't post an event"

echo "PASS: only an ITSA's owner, participants, parent owners, the chief of staff, the assistant, and the human post to it"
