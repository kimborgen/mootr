#!/bin/sh
# The retro loop (S-206) end to end, free: the fake Claude Code (test/fake-claude) plays the retro
# steward, so no model runs. Three retro items are filed and the digest is sent; stam spawns the
# steward (a child of the chief of staff, in a worktree of its repo) with the items in its brief.
# The scripted steward files one proposal ITSA under Retros answering all three and moves it to
# needs_approval. The steward can't apply it yet (the gate); the human approves from the act route,
# the steward hears it and moves it to ready_to_merge; release closes it as done, and the three
# items close. A second digest spawns no second steward while the first one lives.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
T=$(date +%s)
cat >"$TEST_TMP/steward.json" <<'EOF'
{ "agents": { "retro-steward": { "turns": [
  { "match": "/under (S-\\d+), bundling[\\s\\S]*?- (S-\\d+) [\\s\\S]*?- (S-\\d+) [\\s\\S]*?- (S-\\d+) /", "steps": [
    { "mcp": "itsa_create", "args": { "title": "Instruction edits from the retro digest", "kind": "proposal", "parent": "${1}", "owner": "retro-steward", "status": "in_progress",
      "body": "Answers: ${2}, ${3}, ${4}\n\n- type-developer: say where the test daemon lives.\n\n```diff\n-old\n+new\n```" }, "save": { "pkey": "(S-\\d+)" } },
    { "mcp": "itsa_set", "args": { "ref": "${pkey}", "status": "ready_to_merge" }, "expect": "hasn't approved" },
    { "mcp": "itsa_post", "args": { "itsa": "${pkey}", "body": "One edit to type-developer. Approve to apply." } },
    { "mcp": "itsa_set", "args": { "ref": "${pkey}", "status": "needs_approval" }, "expect": "needs_approval" },
    { "reply": "PROPOSED" } ] },
  { "match": "/Your user approved (S-\\d+)/", "steps": [
    { "mcp": "itsa_set", "args": { "ref": "${1}", "status": "ready_to_merge" }, "expect": "ready_to_merge" },
    { "reply": "APPLIED" } ] } ] } } }
EOF
fake_claude "$TEST_TMP/steward.json"
isolate
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
api() { curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${4:+-H 'x-stam-human: 1'} "$STAM_URL$2" ${3:+-d "$3"}; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"external\",\"cwd\":\"$2\"}" | jget "d['id']"; }

# The chief of staff works in a git repo; the steward gets a worktree of it.
REPO="$TEST_TMP/repo"
git init -q "$REPO" && git -C "$REPO" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
COS_ID=$(reg cos "$REPO")
api POST /api/chief-of-staff '{"agent":"cos"}' human >/dev/null
AID=$(reg "reporter-$T" "$TEST_TMP")
REL=$(reg release "$TEST_TMP")

KEYS=""
for n in 1 2 3; do
  F=$(with_agent_id "$AID" "$STAM" retro --kind instruction --target type-developer --title "Item $n" --summary "item $n $T" --details "Scenario $n.")
  KEYS="$KEYS $(echo "$F" | sed -n 's/^Filed \(S-[0-9]*\).*/\1/p')"
done

echo "-- the digest spawns one steward, a child of cos in a worktree, with the items"
"$STAM" retro --digest | grep -q "^Mailed the retro digest to cos\.$" || fail "the digest wasn't sent"
for i in $(seq 100); do api GET /api/agents/retro-steward >/dev/null 2>&1 && break; sleep 0.1; done
S=$(api GET /api/agents/retro-steward) || fail "no steward was spawned"
printf %s "$S" | jget "d['type'], d['parent_id'], d['model'], d['cwd']" | grep -q "^retro-steward $COS_ID claude-sonnet-5-5 .*/worktrees/repo-retro-steward$" || fail "steward: $(printf %s "$S" | jget "d['type'], d['parent_id'], d['model'], d['cwd']")"
for k in $KEYS; do printf %s "$S" | jget "d['first_prompt']" | grep -q "^- $k \[instruction, 0 +1s\] evidence: .* — Item" || fail "the brief lacks $k"; done

echo "-- the steward files one proposal in needs_approval; the gate held it back from ready_to_merge"
"$STAM" wait retro-steward --until idle --timeout 60
P=$(api GET "/api/itsas?kind=proposal" | jget "' '.join(x['key'] for x in d)")
[ "$(echo "$P" | wc -w)" = 1 ] || fail "proposals: $P"
api GET "/api/itsas/$P" | jget "d['status']" | grep -q "^needs_approval$" || fail "$P isn't in needs_approval"
"$STAM" show retro-steward | grep -q "FAKE-CLAUDE EXPECT FAILED" && fail "a scripted step failed: $("$STAM" show retro-steward | grep EXPECT)"

echo "-- an agent request can't act as the human or record an action"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"by":"human","status":"in_progress","action":"approve"}' "$STAM_URL/api/itsas/$P")
[ "$CODE" = 403 ] || fail "an agent's PATCH as the human got $CODE"
api PATCH "/api/itsas/$P" "{\"by\":\"$REL\",\"status\":\"in_progress\",\"action\":\"approve\"}" >/dev/null || fail "the release PATCH failed"
api PATCH "/api/itsas/$P" "{\"by\":\"$REL\",\"status\":\"ready_to_merge\"}" >/dev/null 2>&1 && fail "a forged action approved $P"
# Back to needs_approval (the human), for the real Approve.
api PATCH "/api/itsas/$P" '{"status":"needs_approval"}' human >/dev/null

echo "-- approve: the steward moves it on; release closes it; the items close"
REV=$(api GET "/api/itsas/$P" | jget "d['rev']")
api POST "/api/itsas/$P/act" "{\"action\":\"approve\",\"text\":\"\",\"if_rev\":\"$REV\"}" human >/dev/null || fail "approve failed"
for i in $(seq 100); do [ "$(api GET "/api/itsas/$P" | jget "d['status']")" = ready_to_merge ] && break; sleep 0.1; done
[ "$(api GET "/api/itsas/$P" | jget "d['status']")" = ready_to_merge ] || fail "the steward didn't apply $P after Approve"
api PATCH "/api/itsas/$P" "{\"status\":\"done\",\"by\":\"$REL\"}" >/dev/null || fail "release couldn't close $P"
for k in $KEYS; do
  for i in $(seq 50); do [ "$(api GET "/api/itsas/$k" | jget "d['status']")" = done ] && break; sleep 0.1; done
  [ "$(api GET "/api/itsas/$k" | jget "d['status']")" = done ] || fail "$k didn't close with $P"
done

echo "-- a second digest spawns no second steward while the first lives"
with_agent_id "$AID" "$STAM" retro --kind improve --target type-developer --summary "item 4 $T" --details "Scenario 4." >/dev/null
"$STAM" retro --digest >/dev/null
api GET /api/agents/retro-steward-2 >/dev/null 2>&1 && fail "a second steward was spawned"

echo "PASS: retro loop e2e"
