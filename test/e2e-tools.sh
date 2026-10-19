#!/bin/sh
# The MCP tool catalogue, free (no agents, no models): GET /api/tools lists every tool in
# src/mcp.ts's tools array, grouped, with its description and input schema, plus a note about
# harness tools. The decision-steps UI (S-60) reads this shape to pick a trigger, so the test
# also proves the catalogue covers exactly what `stam mcp` advertises over tools/list.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

CAT=$(get /api/tools)

# Every tool carries a name, a description, and an input schema, in one of the named groups.
[ "$(echo "$CAT" | jget "all(t['name'] and t['description'] and isinstance(t['inputSchema'], dict) for g in d['groups'] for t in g['tools'])")" = True ] ||
  fail "a catalog tool is missing its name, description, or inputSchema"
[ "$(echo "$CAT" | jget "sorted({g['name'] for g in d['groups']})")" = "['Agents', 'Cost', 'Events', 'ITSAs', 'Layout', 'Mail', 'Permissions', 'Registry', 'Rings', 'Waits']" ] ||
  fail "the groups aren't the expected set: $(echo "$CAT" | jget "sorted({g['name'] for g in d['groups']})")"

# send_mail: under Mail, with the description and the schema the UI folds open.
echo "$CAT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(next(t for g in d['groups'] if g['name']=='Mail' for t in g['tools'] if t['name']=='send_mail')))" >"$TEST_TMP/send_mail.json"
grep -q "Send mail to one or more agents" "$TEST_TMP/send_mail.json" || fail "send_mail has no description"
[ "$(jget "sorted(d['inputSchema']['required'])" <"$TEST_TMP/send_mail.json")" = "['body', 'to']" ] || fail "send_mail's required arguments are wrong"
[ "$(jget "'to' in d['inputSchema']['properties'] and 'body' in d['inputSchema']['properties']" <"$TEST_TMP/send_mail.json")" = True ] || fail "send_mail's arguments are missing"

# A note about harness tools is present.
[ -n "$(echo "$CAT" | jget "d['harnessTools']['note']")" ] || fail "harnessTools has no note"

# The catalogue is exactly what the MCP server advertises: no tool is listed twice, none is
# missing, and the two agree on every name.
echo "$CAT" | jget "sorted([t['name'] for g in d['groups'] for t in g['tools']])" >"$TEST_TMP/catalog.txt"
[ "$(echo "$CAT" | jget "len([t['name'] for g in d['groups'] for t in g['tools']])")" = "$(echo "$CAT" | jget "len({t['name'] for g in d['groups'] for t in g['tools']})")" ] ||
  fail "a tool appears in more than one group"
LIST=$(STAM_BIN="$STAM" node "$(dirname "$(readlink -f "$0")")/mcp-call.mjs" '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
echo "$LIST" | jget "sorted(t['name'] for t in d['result']['tools'])" >"$TEST_TMP/list.txt"
diff -u "$TEST_TMP/list.txt" "$TEST_TMP/catalog.txt" >/dev/null || fail "the catalogue and tools/list disagree: $(diff "$TEST_TMP/list.txt" "$TEST_TMP/catalog.txt" | tr '\n' ' ')"

echo "PASS e2e-tools"
