#!/bin/sh
# ITSAs step 2, the MCP tools themselves, free (no agents, no models): drives `stam mcp`
# over stdio against a throwaway daemon and checks the tool behaviour a live run can't pin
# down: itsa_create makes the creator a participant only when it owns the ITSA, itsa_get keeps the body and shows each
# child's roll-up, and itsa_list's `mine` keeps the caller's owner and participant filters
# (the owner is always a participant, so `mine` adds participant=me, intersecting when the
# caller named another participant), and an archived owner still shows by name (S-3816). Runs against its own daemon
# (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
T=$(date +%s)
ANAME="tools-$T"
ONAME="other-$T"
fail() { echo "FAIL: $1"; exit 1; }

# Register two agents: the caller and another agent, for the `mine` filters.
TOKEN=$(cat "$STAM_HOME/token")
reg() {
  curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$1" "$STAM_URL/api/register" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
}
AID=$(reg "{\"name\":\"$ANAME\",\"role\":\"caller\",\"harness\":\"external\"}")
OID=$(reg "{\"name\":\"$ONAME\",\"role\":\"other\",\"harness\":\"external\"}")

# One tool call as agent $1: prints the result text, and fails on an error result.
mcp() {
  STAM_BIN="$STAM" STAM_AGENT_ID="$1" node "$ROOT/test/mcp-call.mjs" \
    "$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$2" "$3")" |
    python3 -c 'import json,sys
m = json.load(sys.stdin); r = m.get("result", {})
t = r.get("content", [{}])[0].get("text", "")
if r.get("isError"): sys.stderr.write(t + "\n"); sys.exit(1)
print(t)'
}
key() { python3 -c 'import re,sys; m = re.search(r"Created (\S+)", sys.stdin.read()); print(m.group(1) if m else "")'; }

# The creator isn't a participant of an ITSA it hands on or leaves ownerless (S-586)...
R=$(mcp "$AID" itsa_create "{\"title\":\"Root\",\"kind\":\"project\",\"body\":\"HELLO-BODY-$T\"}" | key)
[ "$R" = "S-1" ] || fail "the first key is $R, not S-1"
"$STAM" itsa show "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$AID' not in d['participants'], d['participants']" || fail "the creator joined an ITSA with no owner"
# ...yet the creator keeps the right to change it (S-586 review: edit rights come from creating it).
mcp "$AID" itsa_set "{\"ref\":\"$R\",\"summary\":\"creator edit\"}" >/dev/null || fail "the creator of an ownerless ITSA can't change it"
# ...but is one when it owns it.
OWNED=$(mcp "$AID" itsa_create "{\"title\":\"Own root\",\"kind\":\"project\",\"owner\":\"$AID\"}" | key)
"$STAM" itsa show "$OWNED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$AID' in d['participants'], d['participants']" || fail "the creator isn't a participant of its own ITSA"

# itsa_get keeps the body, and shows each child's roll-up (one child line, one root line).
C=$(mcp "$AID" itsa_create "{\"title\":\"Child\",\"parent\":\"$R\"}" | key)
mcp "$AID" itsa_create "{\"title\":\"Grand\",\"parent\":\"$C\"}" >/dev/null
G=$(mcp "$AID" itsa_get "{\"ref\":\"$R\"}")
echo "$G" | grep -q "HELLO-BODY-$T" || fail "itsa_get dropped the body"
[ "$(echo "$G" | grep -c 'roll-up:')" = 2 ] || fail "itsa_get didn't show the child's roll-up"

# An ITSA the other agent owns but the caller takes part in, and one the caller isn't in.
O=$(mcp "$OID" itsa_create "{\"title\":\"OtherWork\",\"owner\":\"$ONAME\",\"participants\":[\"$ANAME\"]}" | key)
P=$(mcp "$OID" itsa_create "{\"title\":\"OthersOnly\",\"owner\":\"$ONAME\"}" | key)

# mine alone returns the caller's own work.
M=$(mcp "$AID" itsa_list '{"mine":true}')
echo "$M" | grep -q "$OWNED" || fail "mine didn't return the caller's own ITSA"

# mine + owner keeps the owner filter: the caller's own ITSA (owner=other? no) is not leaked,
# and the one the caller takes part in is returned.
L=$(mcp "$AID" itsa_list "{\"mine\":true,\"owner\":\"$ONAME\"}")
echo "$L" | grep -q "$O" || fail "mine+owner lost the ITSA the caller takes part in"
echo "$L" | grep -q "$R" && fail "mine overwrote the caller's owner filter"
echo "$L" | grep -q "$P" && fail "mine+owner leaked an ITSA the caller isn't in"

# mine + participant intersects the two participants.
I=$(mcp "$AID" itsa_list "{\"mine\":true,\"participant\":\"$ONAME\"}")
echo "$I" | grep -q "$O" || fail "mine+participant lost the shared ITSA"
echo "$I" | grep -q "$R" && fail "mine+participant returned an ITSA the other participant isn't in"
echo "$I" | grep -q "$P" && fail "mine+participant didn't require the caller to take part"

# An owner's name resolves after it is archived: the tools ask the list for those ids in any state (S-3816).
curl -sf -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"agent\":\"$OID\",\"lifecycle\":\"archived\"}" "$STAM_URL/api/test/agent" >/dev/null || fail "couldn't archive the other agent"
mcp "$AID" itsa_get "{\"ref\":\"$O\"}" | grep -qx "owner: $ONAME" || fail "itsa_get lost the archived owner's name"

echo "PASS e2e-itsa-tools"
