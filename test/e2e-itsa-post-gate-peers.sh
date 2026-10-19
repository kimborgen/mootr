#!/bin/sh
# Who may post to and read an ITSA's thread (S-480) across machines, free (no models). Two isolated
# daemons: "home" is the ITSA home, "main" a peer that proxies ITSA calls there. On main, an OpenCode
# agent (test/fake-opencode, through the OpenCode server's token) and a Claude agent (the scripted
# fake) are in no ITSA. Checks:
#   - the OpenCode server's post, from_stam post, and thread reads, proxied to the home, are refused
#     as its agent's, not taken for main's own call
#   - a Claude agent on main, named in a post on the home, can't reply into the ITSA's thread: the
#     home hears the reply as that agent's and refuses it
#   - spawning on main, stranger can't make its new agent the ITSA's owner (the home refuses it as
#     stranger's), not even as a ring member whose spec names mgr as `by`; mgr, the parent ITSA's
#     owner, can, alone or as its ring's member or moderator
#   - an OpenCode child of a participant on main reads none of the ITSA's thread, raw or by search
#   - the OpenCode server's spawn naming its agent as self or from, with the chief of staff as parent,
#     is checked as its agent and can't take the ITSA
#   - once the human adds the OpenCode agent as a participant, it posts and reads through main
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# On "Link S-N", stranger's itsa_link (MCP, proxied to the home) is refused; mgr's, the parent ITSA's owner, goes through.
link_turn() { printf '{ "turns": [ { "match": "/Link (S-\\\\d+)/", "steps": [ { "mcp": "itsa_link", "args": { "ref": "${1}", "url": "https://example.com/%s" }, "expect": "%s" }, { "reply": "LINKED" } ] } ] }' "$1" "$2"; }
cat >"$TEST_TMP/gate.json" <<EOF
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ],
  "agents": { "stranger": $(link_turn stranger "can't change"), "mgr": $(link_turn mgr Linked) } }
EOF
fake_claude "$TEST_TMP/gate.json"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
daemon_home main
daemon_home home
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d in ("main", "home"):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer("home")] if d == "main" else [peer("main")]
    s.setdefault("itsa", {})["home"] = "home"
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up home
trap stam_test_cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
# api DAEMON METHOD PATH [JSON]: the human's call.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
}
# as TOKEN METHOD PATH [JSON]: the HTTP status of a call to main with TOKEN.
as() { curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} "$MAIN_URL$3"; }
as_body() { curl -s -X "$2" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} "$MAIN_URL$3"; }
main_env() { on main sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$1"; }

DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
on main "$STAM" spawn oc --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello." >/dev/null
on main "$STAM" spawn stranger --model claude-haiku-5-5 --cwd "$DIR" "Say hello." >/dev/null
on main "$STAM" wait oc --until idle --timeout 60
on main "$STAM" spawn mgr --model claude-haiku-5-5 --cwd "$DIR" "Say hello." >/dev/null
on main "$STAM" wait stranger --until idle --timeout 60
on main "$STAM" wait mgr --until idle --timeout 60
MGR=$(api main GET /api/agents/mgr | jget "d['id']")
OC=$(api main GET /api/agents/oc | jget "d['id']"); STRANGER=$(api main GET /api/agents/stranger | jget "d['id']")
OC_TOKEN=$(main_env _opencode); ST_TOKEN=$(main_env "$STRANGER")
[ -n "$OC_TOKEN" ] && [ -n "$ST_TOKEN" ] || fail "missing a token (OpenCode server or stranger)"
LEAD=$(api home POST /api/register '{"name":"lead","role":"test","harness":"claude"}' | jget "d['id']")
TOP=$(api home POST /api/itsas "{\"title\":\"Gate parent\",\"owner\":\"$MGR\"}" | jget "d['key']")
KEY=$(api home POST /api/itsas "{\"title\":\"Gate on the home\",\"owner\":\"$LEAD\",\"parent\":\"$TOP\"}" | jget "d['key']")
participant() { api home GET "/api/itsas/$KEY" | jget "'$1' in d['participants']"; }

echo "-- the OpenCode server, through main, is refused as its agent"
R=$(as_body "$OC_TOKEN" POST "/api/itsas/$KEY/post" "{\"by\":\"$OC\",\"body\":\"let me in\"}")
printf "%s" "$R" | grep -q "can't post to $KEY" || fail "oc's proxied post wasn't refused (got: $R)"
[ "$(as "$OC_TOKEN" POST "/api/itsas/$KEY/post" "{\"by\":\"$OC\",\"body\":\"as stam\",\"from_stam\":true}")" = 403 ] || fail "oc's proxied from_stam post wasn't refused"
[ "$(as "$OC_TOKEN" GET "/api/itsas/$KEY/thread?as=$OC")" = 403 ] || fail "oc read the thread through main"
[ "$(as "$OC_TOKEN" GET "/api/itsas/$KEY/thread")" = 403 ] || fail "the OpenCode server read the thread naming no agent"
[ "$(as "$OC_TOKEN" PATCH "/api/itsas/$KEY" "{\"by\":\"$OC\",\"participants\":[\"$OC\"]}")" = 403 ] || fail "oc added itself as a participant through main"
[ "$(participant "$OC")" = False ] || fail "oc became a participant"

echo "-- named in a post on the home, stranger on main can't reply into the thread"
api home POST "/api/itsas/$KEY/post" "{\"by\":\"$LEAD\",\"body\":\"for stranger\",\"to\":[\"$STRANGER\"]}" >/dev/null
C=""
for _i in $(seq 1 30); do
  C=$(api main GET "/api/agents/$STRANGER/inbox?unread=0&limit=20" | jget "next((m['id'] for m in d if m.get('from_id')=='$LEAD'), '')")
  [ -n "$C" ] && break
  sleep 0.3
done
[ -n "$C" ] || fail "the post never reached stranger on main"
R=$(as_body "$ST_TOKEN" POST /api/mail "{\"to\":[\"lead\"],\"reply_to\":\"$C\",\"body\":\"replying in\"}")
printf "%s" "$R" | grep -q "can't post to $KEY" || fail "stranger's reply from main wasn't refused (got: $R)"
[ "$(participant "$STRANGER")" = False ] || fail "stranger's refused reply made it a participant"

echo "-- through itsa_link (MCP) on main: stranger is refused; mgr, the parent ITSA's owner, links"
# said NAME PATTERN: NAME's transcript on main holds PATTERN. Test/lib.sh's said reads the local daemon, which here is
# home, not the main daemon that runs the agents, so this reads main's transcript path through `on` (S-1302, S-1333).
said() { transcript_said "$(on main "$STAM" show "$1" | grep -m1 '"transcript_path"' | cut -d'"' -f4)" "$2"; }
linked() {
  api main POST "/api/agents/$1/prompt" "{\"text\":\"Link $KEY\"}" >/dev/null
  for _i in $(seq 1 150); do said "$1" "LINKED\|EXPECT FAILED" && break; sleep 0.2; done
  ! said "$1" "EXPECT FAILED" || fail "$1's itsa_link: $(on main "$STAM" show "$1" | grep 'EXPECT FAILED')"
  said "$1" LINKED || fail "$1's itsa_link turn never ended"
}
linked stranger; linked mgr
[ "$(api home GET "/api/itsas/$KEY" | jget "[l['url'] for l in d['links']]")" = "['https://example.com/mgr']" ] || fail "the home's links aren't mgr's alone: $(api home GET "/api/itsas/$KEY" | jget "d['links']")"

echo "-- on main, an OpenCode child of a participant gets no inherited read of the ITSA's thread"
api home PATCH "/api/itsas/$KEY" "{\"participants\":[\"$STRANGER\"]}" >/dev/null
api main POST "/api/agents/$OC/set-parent" "{\"parent\":[\"$STRANGER\"]}" >/dev/null
api home POST "/api/itsas/$KEY/post" '{"by":"human","body":"secret from the human"}' >/dev/null
TID=$(api home GET "/api/itsas/$KEY" | jget "d['thread_id']")
copied() { api main GET "/api/agents/$STRANGER/inbox?unread=0&limit=50" | jget "any(m.get('thread_id')=='$TID' and m['from_id']=='human' for m in d)" | grep -qx True; }
for _i in $(seq 1 30); do copied && break; sleep 0.3; done
copied || fail "the human's post never reached stranger on main"
R=$(as_body "$OC_TOKEN" GET "/api/threads/$TID?box=$OC")
printf "%s" "$R" | grep -q "secret from the human" && fail "an OpenCode child of a participant read the ITSA thread on main (got: $R)"
R=$(as_body "$OC_TOKEN" GET "/api/mail/search?box=$OC&q=secret")
printf "%s" "$R" | grep -q "$TID" && fail "an OpenCode child of a participant found the ITSA thread in search on main (got: $R)"

echo "-- added by the human, the OpenCode agent posts and reads through main"
api home PATCH "/api/itsas/$KEY" "{\"participants\":[\"$OC\"]}" >/dev/null
[ "$(as "$OC_TOKEN" POST "/api/itsas/$KEY/post" "{\"by\":\"$OC\",\"body\":\"now a participant\"}")" = 200 ] || fail "oc, a participant, can't post through main"
[ "$(as "$OC_TOKEN" GET "/api/itsas/$KEY/thread?as=$OC")" = 200 ] || fail "oc, a participant, can't read the thread through main"
echo "-- a spawn on main can't take the ITSA over; mgr's can"
owner_of() { api home GET "/api/itsas/$KEY" | jget "d['owner']"; }
R=$(as_body "$ST_TOKEN" POST /api/agents "{\"name\":\"taker\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"itsa\":\"$KEY\",\"prompt\":\"Say hello.\"}")
printf "%s" "$R" | grep -q "can't change $KEY" || fail "stranger's spawn on main took $KEY (got: $R)"
[ "$(owner_of)" = "$LEAD" ] || fail "$KEY's owner changed after a refused spawn"
R=$(as_body "$ST_TOKEN" POST /api/rings "{\"name\":\"grab\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$DIR\",\"spawn\":[{\"by\":\"$MGR\",\"model\":\"claude-haiku-5-5\",\"itsa\":\"$KEY\"},{\"model\":\"claude-haiku-5-5\"}]}")
printf "%s" "$R" | grep -q "can't change $KEY" || fail "a nested by naming mgr took $KEY for stranger's ring on main (got: $R)"
[ "$(owner_of)" = "$LEAD" ] || fail "$KEY's owner changed through a nested by"
# The OpenCode server naming its agent as self or from, with the chief of staff as the parent, is
# checked as its agent: the parent isn't who asks. On the home (its own spawn) and on main.
home_env() { on home sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN 2>/dev/null | cut -d= -f2-' _ "$1"; }
on home "$STAM" spawn oc2 --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello." >/dev/null
on home "$STAM" wait oc2 --until idle --timeout 60
OC2=$(api home GET /api/agents/oc2 | jget "d['id']"); OC2_TOKEN=$(home_env _opencode)
[ -n "$OC2_TOKEN" ] || fail "the home's OpenCode server has no token"
for d in main home; do
  B=$(api $d POST /api/register "{\"name\":\"boss-$d\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']")
  api $d POST "/api/agents/$B/chief-of-staff" '{}' >/dev/null
  K5=$(api home POST /api/itsas "{\"title\":\"Not oc's ($d)\",\"owner\":\"$LEAD\"}" | jget "d['key']")
  if [ $d = home ]; then T=$OC2_TOKEN; A=$OC2; U=$HOME_URL; else T=$OC_TOKEN; A=$OC; U=$MAIN_URL; fi
  for who in self from; do
    R=$(curl -s -X POST -H "authorization: Bearer $T" -H 'content-type: application/json' "$U/api/agents" -d "{\"$who\":\"$A\",\"parent\":\"$B\",\"name\":\"octake-$d-$who\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"itsa\":\"$K5\",\"prompt\":\"Say hello.\"}")
    printf "%s" "$R" | grep -q "can't change $K5" || fail "the OpenCode server's spawn on $d naming $who took $K5 (got: $R)"
    [ "$(api home GET "/api/itsas/$K5" | jget "d['owner']")" = "$LEAD" ] || fail "$K5's owner changed through the OpenCode server's spawn on $d naming $who"
  done
done
MGR_TOKEN=$(main_env "$MGR")
# mgr's own ring on main takes ITSAs on the home, for a member and a moderator.
K3=$(api home POST /api/itsas "{\"title\":\"Ring member\",\"owner\":\"$LEAD\",\"parent\":\"$TOP\"}" | jget "d['key']")
K4=$(api home POST /api/itsas "{\"title\":\"Ring moderator\",\"owner\":\"$LEAD\",\"parent\":\"$TOP\"}" | jget "d['key']")
R=$(as_body "$MGR_TOKEN" POST /api/rings "{\"name\":\"mring\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$DIR\",\"spawn\":[{\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K3\"},{\"model\":\"claude-haiku-5-5\"}],\"moderator\":{\"model\":\"claude-haiku-5-5\",\"itsa\":\"$K4\"}}")
printf "%s" "$R" | grep -q '"name":"mring"' || fail "mgr's ring on main didn't start (got: $R)"
[ "$(api home GET "/api/itsas/$K3" | jget "d['owner']")" = "$(api main GET /api/agents/mring-1 | jget "d['id']")" ] || fail "mgr's ring member doesn't own $K3"
[ "$(api home GET "/api/itsas/$K4" | jget "d['owner']")" = "$(api main GET /api/agents/mring-mod | jget "d['id']")" ] || fail "mgr's ring moderator doesn't own $K4"
[ "$(as "$MGR_TOKEN" POST /api/agents "{\"name\":\"heir\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"itsa\":\"$KEY\",\"prompt\":\"Say hello.\"}")" = 200 ] || fail "mgr can't spawn $KEY's owner from main"
[ "$(owner_of)" = "$(api main GET /api/agents/heir | jget "d['id']")" ] || fail "mgr's spawn didn't take $KEY"

echo "PASS: the ITSA home checks a proxied OpenCode agent and a remote reply like a local agent"
