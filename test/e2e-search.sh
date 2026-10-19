#!/bin/sh
# One search across stam, free (no agents, no models): GET /api/search returns ranked
# results of every kind on one throwaway daemon — agents from the registry, the human's
# mail threads (a body match, not only a subject match), ITSAs on their home daemon, and
# the Settings sections. Checks matching, that a kind is found by a body word, ranking,
# the limit, empty and no-match queries, and that every result carries what opening needs.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# Two registered agents: no process, no spend. One is the exact name a query wants.
LIB=$(post /api/register '{"name":"librarian","role":"indexes every record","harness":"external"}' | jget "d['id']")
post /api/register '{"name":"cataloguer","role":"files the shelves","harness":"external"}' >/dev/null

# The human's mail: one thread matches by body only, one by subject only, one not at all.
post /api/mail "{\"from\":\"$LIB\",\"to\":[\"human\"],\"subject\":\"Weekly digest\",\"body\":\"the search index needs rebuilding over the weekend\",\"new_thread\":true}" >/dev/null
post /api/mail "{\"from\":\"$LIB\",\"to\":[\"human\"],\"subject\":\"Index rotation policy\",\"body\":\"nothing else here\",\"new_thread\":true}" >/dev/null
post /api/mail "{\"from\":\"$LIB\",\"to\":[\"human\"],\"subject\":\"Dinner plans\",\"body\":\"unrelated chatter\"}" >/dev/null

# An ITSA on this daemon (its default home is this machine).
"$STAM" itsa new "Rebuild the search index" >/dev/null

# A word in the mail body and the ITSA title finds agents, mail, and issues together.
get "/api/search?q=index&limit=20" >"$TEST_TMP/all.json"
[ "$(jget "sorted({x['kind'] for x in d})" <"$TEST_TMP/all.json")" = "['agent', 'itsa', 'thread']" ] ||
  fail "one word didn't find an agent, a thread, and an issue: $(jget "sorted({x['kind'] for x in d})" <"$TEST_TMP/all.json")"
# Every result carries an id and a title, and a known kind, so the UI can open it.
[ "$(jget "all(x['id'] and x['title'] and x['kind'] in {'agent','thread','itsa','setting'} for x in d)" <"$TEST_TMP/all.json")" = True ] ||
  fail "a result is missing its id or title"
# An agent result is the one whose role matched; the other agent is not dragged in.
[ "$(jget "[x['id'] for x in d if x['kind']=='agent']" <"$TEST_TMP/all.json")" = "['$LIB']" ] ||
  fail "the agent results aren't the role match alone"
# The thread result is the one matching by body, with a snippet from the body.
jget "[x['snippet'] for x in d if x['kind']=='thread']" <"$TEST_TMP/all.json" | grep -q "index needs rebuilding" ||
  fail "the thread matched by body has no body snippet"

# Ranking: the exact agent name beats the role match, and a prefix beats a mid-word match.
get "/api/search?q=cataloguer" >"$TEST_TMP/name.json"
[ "$(jget "d[0]['kind']" <"$TEST_TMP/name.json")" = agent ] || fail "an exact agent name didn't rank first"
get "/api/search?q=catalog" >"$TEST_TMP/prefix.json"
[ "$(jget "d[0]['kind']" <"$TEST_TMP/prefix.json")" = agent ] || fail "a name prefix didn't rank first"

# Settings: a section by its label, and an instruction item pointing into Instructions.
get "/api/search?q=compaction" >"$TEST_TMP/set.json"
[ "$(jget "d[0]['kind']" <"$TEST_TMP/set.json")" = setting ] || fail "a settings section didn't come back"
[ "$(jget "d[0]['section']" <"$TEST_TMP/set.json")" = context ] || fail "the Compaction result doesn't point at the context section"
get "/api/search?q=mail%20rules" >"$TEST_TMP/item.json"
[ "$(jget "any(x.get('item')=='mail-to-human' and x.get('section')=='instructions' for x in d)" <"$TEST_TMP/item.json")" = True ] ||
  fail "an instruction item doesn't point into the Instructions section"

# The limit is honoured, a query with no match is empty, and an empty query asks nothing.
[ "$(get "/api/search?q=index&limit=1" | jget 'len(d)')" = 1 ] || fail "limit=1 returned more than one result"
[ "$(get "/api/search?q=zzzznomatch" | jget 'len(d)')" = 0 ] || fail "a query with no match returned results"
[ "$(get "/api/search?q=" | jget 'len(d)')" = 0 ] || fail "an empty query returned results"

# A mail full of mail-component and Markdown syntax: its search snippet must come back as
# plain prose, without fence markers, component names, callout tags, HTML, or math.
python3 - "$STAM_URL" "$TOKEN" "$LIB" <<'PY'
import json, sys, urllib.request
url, token, lib = sys.argv[1:4]
body = ("TLDR: inline \\(a^2+b^2\\) then widgetToken here.\n\n"
        "> [!NOTE]\n> a second widgetToken.\n\n"
        "<details><summary>More</summary>\n\n"
        "```decision\nwidgetToken in a fence\n```\n\n</details>")
data = json.dumps({"from": lib, "to": ["human"], "subject": "Syntax soup", "body": body, "new_thread": True}).encode()
req = urllib.request.Request(url + "/api/mail", data=data, headers={"authorization": "Bearer " + token, "content-type": "application/json", "x-stam-human": "1"})
urllib.request.urlopen(req)
PY
SNIP=$(get "/api/search?q=widgetToken" | jget "next(x['snippet'] for x in d if x['kind']=='thread')")
echo "$SNIP" | grep -q widgetToken || fail "the syntax-soup snippet lost its match: $SNIP"
case "$SNIP" in
  *'\('* | *'\)'* | *'$$'* | *'[!'* | *'<details'* | *'</'* | *'decision'* | *'```'* | *'Summary'*)
    fail "the snippet still shows raw syntax: $SNIP" ;;
esac

echo "PASS e2e-search"
