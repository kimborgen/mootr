#!/bin/sh
# The retro tool (S-158) end to end, free (no agents, no models): registers an agent by hand,
# then runs `stam retro` as that agent (STAM_AGENT_ID) against a throwaway daemon. It files an
# item, searches for it, +1s it, and checks the +1 count through the search, so the daemon
# routes runRetro uses (/api/agents?as=, /api/itsas?participant=, /api/itsas/:id/plus-ones, POST
# /api/itsas with a status, and the post route) are proven on a real daemon. It also acts as the
# OpenCode server (S-796) to prove a +1 counts without ever reading the item's thread. Runs
# against its own daemon (test/lib.sh), cleaned up when it ends.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
T=$(date +%s)
fail() { echo "FAIL: $1"; exit 1; }

TOKEN=$(cat "$STAM_HOME/token")
AID=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"retro-$T\",\"role\":\"retro\",\"harness\":\"external\"}" "$STAM_URL/api/register" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

# File an item as the agent: a backlog-free idea under Retros, with the reporter as participant.
FILED=$(with_agent_id "$AID" "$STAM" retro --kind improve --target waits --title "Idle pane waits" --summary "waits hang on idle panes $T" --details "The wait stalled on an idle pane for ten minutes.")
echo "$FILED" | grep -q '^Filed S-[0-9]* "Idle pane waits" \[idea\] under Retros\.$' || fail "filing said: $FILED"
KEY=$(echo "$FILED" | sed -n 's/^Filed \(S-[0-9]*\).*/\1/p')
"$STAM" itsa show "$KEY" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['kind']=='retro' and d['status']=='idea' and d['title']=='Idle pane waits' and d['summary']=='waits hang on idle panes $T', d; assert '$AID' in d['participants'], d" || fail "the item isn't a retro in idea with the reporter"

# Search finds it, with no +1 yet.
S=$(with_agent_id "$AID" "$STAM" retro --search "idle pane stalled")
echo "$S" | grep -q "^$KEY .* · Kind: improve · 0 +1s · The wait stalled on an idle pane for ten minutes\.$" || fail "search said: $S"

# A +1 from the same agent adds a counted comment; the search shows the count.
P=$(with_agent_id "$AID" "$STAM" retro --plus-one "$KEY" --details "Same on my run.")
echo "$P" | grep -q "^+1 on $KEY .*: 1 +1 now\.$" || fail "+1 said: $P"
S=$(with_agent_id "$AID" "$STAM" retro --search "idle pane stalled")
echo "$S" | grep -q "^$KEY .* · Kind: improve · 1 +1 · The wait stalled on an idle pane for ten minutes\.$" || fail "search after +1 said: $S"

# A +1 on an ITSA that isn't a retro item is refused.
OTHER=$("$STAM" itsa new "not a retro $T" | sed -n 's/^Created \(S-[0-9]*\).*/\1/p')
if with_agent_id "$AID" "$STAM" retro --plus-one "$OTHER" --details "x" 2>/dev/null; then fail "+1 on $OTHER was accepted"; fi

# The OpenCode path (S-796): as the OpenCode server, naming its agent, a +1 counts without ever
# reading the item's thread, which the server may not do (it names no agent on a thread read, and
# the item is not its). The daemon's OpenCode token is a sha256 in $STAM_HOME/opencode-token; a
# known one lets the test act as the server.
OC_TOKEN="oc-retro-$T"
OC_ID=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"retro-oc-$T\",\"role\":\"retro\",\"harness\":\"opencode\"}" "$STAM_URL/api/register" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
OCKEY=$(with_agent_id "$AID" "$STAM" retro --kind idea --summary "an opencode +1 $T" --details "For the OpenCode path." |
  sed -n 's/^Filed \(S-[0-9]*\).*/\1/p')
printf '%s' "$(printf '%s' "$OC_TOKEN" | sha256sum | cut -d' ' -f1)" >"$STAM_HOME/opencode-token"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $OC_TOKEN" "$STAM_URL/api/itsas/$OCKEY/thread")
[ "$CODE" = 403 ] || fail "the OpenCode server read $OCKEY's thread (got $CODE)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $OC_TOKEN" -H 'content-type: application/json' \
  -d "{\"by\":\"$OC_ID\",\"body\":\"+1 from an opencode agent: same here\"}" "$STAM_URL/api/itsas/$OCKEY/post")
[ "$CODE" = 200 ] || fail "the OpenCode server's +1 was refused (got $CODE)"
CNT=$(curl -s -H "authorization: Bearer $OC_TOKEN" "$STAM_URL/api/itsas/$OCKEY/plus-ones" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])')
[ "$CNT" = 1 ] || fail "the OpenCode server read the count as $CNT, not 1"

# The final round (S-159) stores the effort split as a retro_final event on the agent, and no ITSA.
F=$(with_agent_id "$AID" "$STAM" retro --final --effort reading=50,implementing=30,testing=20)
echo "$F" | grep -q "^Recorded the final retro round for $AID: reading 50%, implementing 30%, testing 20%\.$" || fail "final said: $F"
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/$AID/events" |
  python3 -c "import json,sys; ev=[e for e in json.load(sys.stdin) if e['type']=='retro_final']; assert len(ev)==1, ev; d=json.loads(ev[0]['data']); assert d['effort']=={'reading':50,'implementing':30,'testing':20}, d; assert d['model'] is None or isinstance(d['model'], str), d" || fail "the final round isn't stored as an event"
if with_agent_id "$AID" "$STAM" retro --final --effort napping=10 2>/dev/null; then fail "an unknown effort area was accepted"; fi

# The weekly digest (S-161): a second item, a chief of staff named, and the digest sent now. Its mail
# to the chief of staff lists both items with their +1 counts; a second send finds nothing new.
FILED2=$(with_agent_id "$AID" "$STAM" retro --kind improve --target waits --evidence gate --summary "waits stall on closed panes $T" --details "A second item.")
KEY2=$(echo "$FILED2" | sed -n 's/^Filed \(S-[0-9]*\).*/\1/p')
# A third item with no evidence and no +1: the digest counts it and doesn't list it (S-1230).
FILED3=$(with_agent_id "$AID" "$STAM" retro --kind improve --target src/retro-digest.ts --summary "a quiet idea $T" --details "No evidence, no +1.")
KEY3=$(echo "$FILED3" | sed -n 's/^Filed \(S-[0-9]*\).*/\1/p')
COS="cos-$T"
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"$COS\",\"role\":\"chief-of-staff\",\"harness\":\"external\"}" "$STAM_URL/api/register" >/dev/null
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' \
  -d "{\"agent\":\"$COS\"}" "$STAM_URL/api/chief-of-staff" >/dev/null
COS_ID=$(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents" | python3 -c "import json,sys; print([a['id'] for a in json.load(sys.stdin) if a['name']=='$COS'][0])")
D=$("$STAM" retro --digest)
echo "$D" | grep -q "^Mailed the retro digest to $COS\.$" || fail "digest said: $D"
python3 - "$STAM_URL" "$TOKEN" "$COS_ID" "$KEY" "$KEY2" "$KEY3" <<'PY' || fail "the digest mail doesn't list both items with their counts, or lists the item with no evidence and no +1"
import json, re, sys, urllib.request
url, token, cos, key, key2, key3 = sys.argv[1:]
def get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(url + path, headers={"authorization": "Bearer " + token})))
mails = [m for m in get(f"/api/agents/{cos}/inbox?unread=0") if m["subject"].startswith("Retro digest: ")]
assert len(mails) == 1, mails
thread = get(f"/api/threads/{mails[0]['thread_id']}?box={cos}")
body = next(m["body"] for m in thread if m["id"] == mails[0]["id"])
assert re.search(rf"{key} \(1 \+1\)", body), body
assert re.search(rf"{key2} \(0 \+1s\)", body), body
assert re.search(r"^- 1 more item without evidence or \+1s: improve 1\.$", body, re.M), body
assert key3 not in body, body
PY
D=$("$STAM" retro --digest)
echo "$D" | grep -q "^No retro digest sent: nothing new since the last digest\.$" || fail "a second digest said: $D"

# The epic retro offer (S-163): a project with work under it, filed on by three agents, prints the
# offer when it is closed through the CLI. No account is known to the test daemon, so the share is
# unknown and the offer is the solo retro.
PROJ=$("$STAM" itsa new "epic $T" --kind project | sed -n 's/^\(S-[0-9]*\).*/\1/p')
WORK=$("$STAM" itsa new "work under the epic $T" --parent "$PROJ" | sed -n 's/^\(S-[0-9]*\).*/\1/p')
for n in 2 3; do
  OTHER_ID=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"name\":\"retro-$T-$n\",\"role\":\"retro\",\"harness\":\"external\"}" "$STAM_URL/api/register" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  "$STAM" itsa set "$WORK" --participant "$OTHER_ID" >/dev/null
  with_agent_id "$OTHER_ID" "$STAM" retro --kind idea --summary "epic idea $n $T" --details "Filed under the epic." >/dev/null
done
"$STAM" itsa set "$WORK" --participant "$AID" >/dev/null
with_agent_id "$AID" "$STAM" retro --kind idea --summary "epic idea 1 $T" --details "Filed under the epic." >/dev/null
CLOSED=$("$STAM" itsa set "$PROJ" --status done)
echo "$CLOSED" | grep -q "^# Epic retro$" || fail "closing the epic didn't print the offer: $CLOSED"
echo "$CLOSED" | grep -q "^$PROJ closed with 3 retro items from several reporters" || fail "the offer doesn't count 3 items: $CLOSED"
echo "$CLOSED" | grep -q "Write the epic retro yourself" || fail "the offer isn't the solo retro: $CLOSED"

echo "PASS: retro e2e"
