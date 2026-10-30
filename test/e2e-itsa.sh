#!/bin/sh
# ITSAs step 1 end to end, free (no agents, no models): two isolated daemons play two
# machines ("main" and "home"); main stores no ITSAs and proxies every /api/itsas call to
# its home peer. Through the CLI and the HTTP API: a three-level tree, readable keys,
# status validation, roll-ups in `show`, reparent cycle refusal, links (add, list, remove),
# a clear error when the home machine isn't a configured peer, and an agent registered on
# the other machine that owns and edits an ITSA (the home resolves remote ids and names
# through its peers, and the agent's CLI sends `by`).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
# main lists home as a peer and names it the ITSA home; home is its own home.
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
use main
T=$(date +%s)
TOKEN=$(cat "$STAM_HOME/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"')
HOME_TOKEN=$(cat "$TEST_TMP/home/token")
fail() { echo "FAIL: $1"; exit 1; }

get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
apost() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
patch() { curl -sf -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
del() { curl -sf -X DELETE -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$STAM_URL$1" >/dev/null; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
new() { "$STAM" itsa new "$@" | awk '{print $1}'; }

# A tree three levels deep, keys from the settings prefix and one counter.
R=$(new "Root $T")
M=$(new "Mid $T" --parent "$R")
L=$(new "Leaf $T" --parent "$M" --status in_progress)
[ "$R" = "S-1" ] || fail "first key is $R, not S-1"
[ "$M" = "S-2" ] && [ "$L" = "S-3" ] || fail "keys are not sequential: $R $M $L"

# Status validation on create (and on set).
"$STAM" itsa new "Bad $T" --status nope >/dev/null 2>&1 && fail "an unknown status was accepted on create"
"$STAM" itsa set "$L" --status nope >/dev/null 2>&1 && fail "an unknown status was accepted on set"

# `show` returns the parent chain, the roll-up of the children, and each child's roll-up.
"$STAM" itsa show "$L" >"$TEST_TMP/leaf.json"
[ "$(jget "len(d['parent_chain'])" <"$TEST_TMP/leaf.json")" = 2 ] || fail "leaf parent chain is not root, mid"
[ "$(jget "d['parent_chain'][0]['key']" <"$TEST_TMP/leaf.json")" = "$R" ] || fail "parent chain is not root first"
"$STAM" itsa show "$R" >"$TEST_TMP/root.json"
[ "$(jget "d['rollup']['backlog']" <"$TEST_TMP/root.json")" = 1 ] || fail "root roll-up doesn't count mid in backlog"
[ "$(jget "d['children'][0]['rollup']['active']" <"$TEST_TMP/root.json")" = 1 ] || fail "mid's roll-up doesn't count the active leaf"

# Reparenting refuses a cycle, and leaves the parent unchanged.
"$STAM" itsa set "$R" --parent "$L" >/dev/null 2>&1 && fail "a reparent cycle was accepted"
[ "$(jget "d['parent_id']" <"$TEST_TMP/root.json")" = None ] || fail "the root gained a parent"
"$STAM" itsa set "$L" --parent "$R" >/dev/null || fail "a legal reparent failed"
[ "$("$STAM" itsa show "$L" | jget "len(d['parent_chain'])")" = 1 ] || fail "reparent didn't move the leaf"

# Links: add, list, remove, through the CLI and the API.
"$STAM" itsa link "$L" "https://example.com/pr/$T" --system github --external-id 7 >/dev/null
[ "$("$STAM" itsa show "$L" | jget "d['links'][0]['url']")" = "https://example.com/pr/$T" ] || fail "the CLI link is missing"
[ "$("$STAM" itsa show "$L" | jget "d['links'][0]['external_id']")" = 7 ] || fail "the link's external id is missing"
"$STAM" itsa link "$L" --remove 1 >/dev/null
[ "$("$STAM" itsa show "$L" | jget "len(d['links'])")" = 0 ] || fail "the CLI link wasn't removed"

# A participants-only change is reported by the CLI, not as "nothing changed".
"$STAM" itsa set "$L" --participant human | grep -q "^$L: participants:" || fail "itsa set didn't report a participants-only change"

# The HTTP API: create, get by key, patch, list by parent, link add/remove.
A=$(post /api/itsas "{\"title\":\"Api $T\",\"parent\":\"$R\"}" | jget "d['key']")
[ "$(get "/api/itsas/$A" | jget "d['key']")" = "$A" ] || fail "GET by key failed"
patch "/api/itsas/$A" '{"status":"ready"}' >/dev/null
[ "$(get "/api/itsas/$A" | jget "d['status']")" = ready ] || fail "PATCH status failed"
[ "$(get "/api/itsas?parent=$R" | jget "len(d)")" = 3 ] || fail "list by parent isn't mid, leaf, and api"
[ "$(get "/api/itsas?status=in_progress" | jget "len(d)")" = 1 ] || fail "list by status isn't the leaf"
[ "$(get "/api/itsas?text=Root%20$T" | jget "len(d)")" = 1 ] || fail "list by text isn't the root"
post "/api/itsas/$A/links" "{\"url\":\"https://example.com/i/$T\",\"system\":\"linear\"}" >/dev/null
[ "$(get "/api/itsas/$A" | jget "d['links'][0]['system']")" = linear ] || fail "POST link failed"
del "/api/itsas/$A/links/1"
[ "$(get "/api/itsas/$A" | jget "len(d['links'])")" = 0 ] || fail "DELETE link failed"

# An action without an actor is refused; a missing ITSA is 404.
[ "$(apost /api/itsas "{\"title\":\"No actor $T\"}")" = 403 ] || fail "a create without an actor wasn't refused"
[ "$(code /api/itsas/S-999)" = 404 ] || fail "an unknown ITSA wasn't 404"

# The ITSA lives on the home daemon, not on main.
[ "$(curl -sf -H "authorization: Bearer $HOME_TOKEN" "$HOME_URL/api/itsas" | jget "len(d)")" = 4 ] || fail "the home daemon doesn't hold the ITSAs"
[ "$(get /api/itsas | jget "len(d)")" = 4 ] || fail "main's proxied list doesn't match"

# An agent registered on the other machine (main) owns and edits an ITSA on the home
# daemon: the home resolves remote ids and names through its peers, and the agent's CLI
# sends `by` so its mutations aren't refused as anonymous.
WID=$(post /api/register "{\"name\":\"worker-$T\",\"role\":\"remote worker\",\"harness\":\"external\"}" | jget "d['id']")
WK=$("$STAM" itsa new "Remote-owned $T" --owner "worker-$T" | awk '{print $1}')
[ "$(get "/api/itsas/$WK" | jget "d['owner']")" = "$WID" ] || fail "a remote owner name didn't resolve to its id"
with_agent_id "$WID" "$STAM" itsa set "$WK" --status in_progress >/dev/null || fail "the remote agent couldn't edit its ITSA"
[ "$(get "/api/itsas/$WK" | jget "d['status']")" = in_progress ] || fail "the remote agent's change didn't stick"
with_agent_id "$WID" "$STAM" itsa link "$WK" "https://example.com/remote/$T" >/dev/null || fail "the remote agent couldn't add a link"
with_agent_id "$WID" "$STAM" itsa link "$WK" --remove 1 >/dev/null || fail "the remote agent couldn't remove a link"
[ "$(get "/api/itsas/$WK" | jget "len(d['links'])")" = 0 ] || fail "the remote agent's link removal didn't stick"
# A link's `system` is its kind, not a system sender (S-482): an agent's github link works and is the
# agent's, and the human's github link is the human's, not system:github.
with_agent_id "$WID" "$STAM" itsa link "$WK" "https://example.com/gh/$T" --system github --external-id 9 >/dev/null || fail "the remote agent's github link was refused"
[ "$(get "/api/itsas/$WK" | jget "d['links'][0]['system']")" = github ] || fail "the remote agent's github link isn't recorded"
[ "$(get "/api/itsas/$WK" | jget "[e['actor'] for e in d['events'] if e['type']=='link.added'][0]")" = "$WID" ] || fail "the remote agent's link isn't its own"
HN=$("$STAM" itsa link "$L" "https://example.com/gh-human/$T" --system github --external-id 8 | awk '{print $2}' | tr -d :)
[ "$("$STAM" itsa show "$L" | jget "[e['actor'] for e in d['events'] if e['type']=='link.added'][0]")" = human ] || fail "the human's github link isn't recorded as the human"
"$STAM" itsa link "$L" --remove "$HN" >/dev/null

# A home machine that isn't a configured peer gives a clear error.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["itsa"]["home"] = "nowhere"; json.dump(s, open(sys.argv[1], "w"), indent=2)
PY
[ "$(code /api/itsas)" = 503 ] || fail "an unknown home didn't answer 503"
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/itsas" | grep -q "not a configured peer" || fail "the unknown-home error isn't clear"

echo "PASS e2e-itsa"
