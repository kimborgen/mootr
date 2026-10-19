#!/bin/sh
# Ring reviewer types, free (S-412 step 3): `spawn_agent type: <ring type>` (POST /api/agents)
# starts a ring named NAME with members NAME-1, NAME-2, ... spawned by type, an optional moderator
# NAME-mod, the format and rounds of the type, and the task as the topic. A held member follows
# its own fallback chain. A member that can't start even then makes the ring fall to the type's
# single fallback reviewer, with the members already spawned archived; with no fallback the spawn
# is refused. ring_create (POST /api/rings) takes { type } members and moderator. An explicit
# model is refused. The fake Claude Code and fake Codex stand in. Runs against its own daemon.
set -e

STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
daemon_home main
D="$(mktemp -d "$TEST_TMP/work.XXXX")"
# $1 is extra types as JSON. registry.json is reread on every use.
settings() {
  cat >"$TEST_TMP/main/settings.json" <<JSON
{ "peers": [],
  "cost": { "accounts": {
    "codex-like": { "match": { "harness": "codex" }, "paid": false, "onSubExhausted": "wait" },
    "claude-like": { "match": { "harness": "claude", "model": "claude-opus" }, "paid": false, "onSubExhausted": "wait" } } } }
JSON
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({types:JSON.parse(process.argv[2]||"{}")}))' "$TEST_TMP/main/registry.json" "${1:-}"
}
settings
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
spawn() { human POST /api/agents "$1"; }
sql() { node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.argv[1], { readOnly: true }); const r = d.prepare(process.argv[2]).get(); if (r) console.log(Object.values(r)[0] ?? "");' "$STAM_HOME/stam.db" "$1"; }
typeof() { sql "SELECT type FROM agents WHERE name = '$1'"; }

FUT=$(($(date +%s) + 7200))
reading() { human POST /api/test/cost "{\"action\":\"reading\",\"name\":\"codex\",\"windows\":{\"five_hour\":{\"used_percentage\":$1,\"resets_at\":$FUT}}}" >/dev/null; }
held() { [ "$(sql "SELECT COUNT(*) FROM blockers WHERE account = 'codex-like'")" -ge 1 ]; }
free() { [ "$(sql "SELECT COUNT(*) FROM blockers WHERE account = 'codex-like'")" = 0 ]; }
spawn "{\"name\":\"holder\",\"cwd\":\"$D\",\"harness\":\"codex\"}" >/dev/null
"$STAM" wait holder --until idle --timeout 60 >/dev/null
hold() { reading 100; wait_until held; }
unhold() { reading 10; wait_until free; }

echo "-- 1. the shipped review-ring: a rounds ring of reviewer and reviewer-opus"
R=$(spawn "{\"name\":\"rr1\",\"type\":\"review-ring\",\"cwd\":\"$D\",\"prompt\":\"review the patch\"}")
[ "$(printf %s "$R" | field kind)" = ring ] || fail "not a ring: $R"
[ "$(printf %s "$R" | field ring.name)" = rr1 ] || fail "ring name: $R"
[ -n "$(printf %s "$R" | field ring.id)" ] || fail "no ring id: $R"
[ "$(printf %s "$R" | field members | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(m=>m.name+":"+m.type).join(",")))')" = "rr1-1:reviewer,rr1-2:reviewer-opus" ] || fail "members: $R"
[ "$(sql "SELECT format || '/' || max_rounds || '/' || COALESCE(moderator_id,'none') || '/' || topic || '/' || created_by FROM rings WHERE name = 'rr1'")" = "rounds/3/none/review the patch/human" ] || fail "ring row: $(sql "SELECT format, max_rounds, moderator_id, topic, created_by FROM rings WHERE name = 'rr1'")"
[ "$(typeof rr1-1)" = reviewer ] && [ "$(typeof rr1-2)" = reviewer-opus ] || fail "agent types"
"$STAM" ring rr1 | grep -q '"status": "running"' || fail "ring not running"
OUT=$(spawn "{\"name\":\"rr1b\",\"type\":\"review-ring\",\"cwd\":\"$D\"}")
printf %s "$OUT" | grep -q 'give a prompt' || fail "a ring with no task spawned: $OUT"

echo "-- 2. a moderator by type, and the format, rounds, and decides from the type"
settings '{"fire-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":"reviewer","ring":{"format":"fire","members":["reviewer","reviewer-opus"],"moderator":{"type":"reviewer-opus","decides":true},"maxRounds":2}}}}'
R=$(spawn "{\"name\":\"rr2\",\"type\":\"fire-ring\",\"cwd\":\"$D\",\"prompt\":\"decide it\"}")
[ "$(printf %s "$R" | field moderator.name)" = rr2-mod ] || fail "moderator: $R"
[ "$(printf %s "$R" | field moderator.type)" = reviewer-opus ] || fail "moderator type: $R"
[ "$(sql "SELECT format || '/' || max_rounds || '/' || moderator_decides || '/' || (moderator_id = (SELECT id FROM agents WHERE name = 'rr2-mod')) FROM rings WHERE name = 'rr2'")" = "fire/2/1/1" ] || fail "ring row"
[ "$(typeof rr2-mod)" = reviewer-opus ] || fail "moderator agent type"

echo "-- 3. ring_create: spawn entries and the moderator by type"
R=$(human POST /api/rings "{\"name\":\"rc1\",\"topic\":\"t\",\"format\":\"debate\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}],\"moderator\":{\"type\":\"reviewer-opus\"},\"moderator_decides\":true}")
[ "$(printf %s "$R" | field name)" = rc1 ] || fail "ring_create: $R"
[ "$(typeof rc1-1)" = reviewer ] && [ "$(typeof rc1-2)" = reviewer-opus ] && [ "$(typeof rc1-mod)" = reviewer-opus ] || fail "ring_create agent types"
[ "$(sql "SELECT format || '/' || moderator_decides FROM rings WHERE name = 'rc1'")" = "debate/1" ] || fail "ring_create ring row"
R=$(human POST /api/rings "{\"name\":\"rc2\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"members\":[\"rc1-1\"],\"spawn\":[{\"type\":\"reviewer-opus\"}],\"moderator\":\"holder\"}")
[ "$(printf %s "$R" | field name)" = rc2 ] || fail "ring_create with an existing moderator: $R"

echo "-- 4. a held member falls back inside its own chain"
hold
R=$(spawn "{\"name\":\"rr3\",\"type\":\"review-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(printf %s "$R" | field kind)" = ring ] || fail "held member: $R"
[ "$(typeof rr3-1)" = reviewer-opus ] || fail "held member's type: $(typeof rr3-1)"
[ "$(sql "SELECT COUNT(*) FROM events WHERE type = 'reviewer:fallback' AND agent_id = (SELECT id FROM agents WHERE name = 'rr3-1')")" = 1 ] || fail "no reviewer:fallback event"

echo "-- 5. a member that can't start: the whole ring falls to the single fallback reviewer"
# solo has no fallback, so with codex held its spawn is refused, after fr-1 (claude) started.
settings '{"solo":{"description":"x","harness":"codex","model":"gpt-6.1-sol","effort":"low","review":{"fallback":null,"ring":null}},"fb-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":"reviewer-opus","ring":{"format":"rounds","members":["reviewer-opus","solo"],"moderator":null,"maxRounds":2}}},"nofb-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":null,"ring":{"format":"rounds","members":["reviewer-opus","solo"],"moderator":null,"maxRounds":2}}}}'
R=$(spawn "{\"name\":\"fr\",\"type\":\"fb-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(printf %s "$R" | field name)" = fr ] || fail "fallback reviewer name: $R"
[ "$(printf %s "$R" | field type)" = reviewer-opus ] || fail "fallback reviewer type: $R"
printf %s "$R" | field warning | grep -q "didn't start.*can't spawn fr-2" || fail "no reason in the warning: $(printf %s "$R" | field warning)"
printf %s "$R" | field first_prompt | grep -q 'review it' || fail "fallback reviewer lost the brief"
[ "$(sql "SELECT COUNT(*) FROM agents WHERE name LIKE 'fr-%' AND lifecycle != 'archived'")" = 0 ] || fail "members left running"
[ "$(sql "SELECT lifecycle FROM agents WHERE name = 'fr-1'")" = archived ] || fail "fr-1 not archived"
[ "$(sql "SELECT COUNT(*) FROM rings WHERE name = 'fr'")" = 0 ] || fail "a ring was left"

echo "-- 6. no fallback: the spawn is refused, nothing is left"
OUT=$(spawn "{\"name\":\"nf\",\"type\":\"nofb-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
printf %s "$OUT" | grep -q "can't start ring nf.*no fallback" || fail "no refusal: $OUT"
[ "$(sql "SELECT COUNT(*) FROM agents WHERE name LIKE 'nf%' AND lifecycle != 'archived'")" = 0 ] || fail "members left running"
unhold

echo "-- 7. an explicit model, harness, or preset is refused"
for X in '"model":"claude-sonnet-5-5"' '"harness":"claude"' '"preset":"standard"'; do
  OUT=$(spawn "{\"name\":\"rx\",\"type\":\"review-ring\",\"cwd\":\"$D\",\"prompt\":\"x\",$X}")
  printf %s "$OUT" | grep -q 'takes no harness, model, or preset' || fail "spawned with $X: $OUT"
  [ -z "$(sql "SELECT id FROM agents WHERE name LIKE 'rx%'")" ] || fail "left an agent ($X)"
done
echo "-- 8. a member or moderator whose launch fails after its row exists is archived"
launchfail() { human POST /api/test/launch-fail "{\"names\":$1}" >/dev/null; }
live() { sql "SELECT COUNT(*) FROM agents WHERE name LIKE '$1' AND lifecycle != 'archived'"; }
launchfail '["lf-2"]'
OUT=$(human POST /api/rings "{\"name\":\"lf\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}]}")
printf %s "$OUT" | grep -q 'launch of lf-2 failed' || fail "member launch failure not reported: $OUT"
[ "$(live 'lf-%')" = 0 ] || fail "member launch failure left agents running"
[ "$(sql "SELECT lifecycle FROM agents WHERE name = 'lf-2'")" = archived ] || fail "lf-2 not archived"
[ "$(sql "SELECT COUNT(*) FROM rings WHERE name = 'lf'")" = 0 ] || fail "a ring was left (member)"
launchfail '["lm-mod"]'
OUT=$(human POST /api/rings "{\"name\":\"lm\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}],\"moderator\":{\"type\":\"reviewer-opus\"}}")
printf %s "$OUT" | grep -q 'launch of lm-mod failed' || fail "moderator launch failure not reported: $OUT"
[ "$(live 'lm-%')" = 0 ] || fail "moderator launch failure left agents running"
[ "$(sql "SELECT lifecycle FROM agents WHERE name = 'lm-mod'")" = archived ] || fail "lm-mod not archived"
[ "$(sql "SELECT COUNT(*) FROM rings WHERE name = 'lm'")" = 0 ] || fail "a ring was left (moderator)"
launchfail '[]'
# A name that is already taken is refused, and that agent is left alone.
spawn "{\"name\":\"tk-2\",\"cwd\":\"$D\",\"harness\":\"claude\"}" >/dev/null
OUT=$(human POST /api/rings "{\"name\":\"tk\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}]}")
printf %s "$OUT" | grep -q 'tk-2 is taken' || fail "a taken name was not refused: $OUT"
[ "$(live 'tk-2')" = 1 ] || fail "the colliding agent was archived"
[ "$(sql "SELECT lifecycle FROM agents WHERE name = 'tk-1'")" = archived ] || fail "tk-1 not archived"
# 9. Cleanup archives only the agents the ring itself created, never one that took a member's
# name while the ring's spawn awaited. The first entry's ITSA lookup is held until the colliding
# agent exists (synchronized on the gate's waiting count, no sleeps), then fails.
echo "-- 9. a name taken during the spawn is never archived by the ring's cleanup"
gate() { human POST /api/test/itsa-gate "{\"action\":\"$1\"}"; }
gate_waiting() { [ "$(gate status | python3 -c 'import json,sys; print(json.load(sys.stdin)["waiting"])')" = 1 ]; }
gate hold >/dev/null
human POST /api/rings "{\"name\":\"cx\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\",\"itsa\":\"S-999999\"}]}" >"$TEST_TMP/cx.out" &
RINGPID=$!
wait_until gate_waiting
spawn "{\"name\":\"cx-1\",\"cwd\":\"$D\",\"harness\":\"claude\"}" >/dev/null
gate release >/dev/null
wait $RINGPID
[ -s "$TEST_TMP/cx.out" ] && ! grep -q '"cx"' "$TEST_TMP/cx.out" || fail "the ring did not fail: $(cat "$TEST_TMP/cx.out")"
[ "$(live 'cx-1')" = 1 ] || fail "the ring's cleanup archived an agent it did not create"
[ "$(sql "SELECT COUNT(*) FROM rings WHERE name = 'cx'")" = 0 ] || fail "a ring was left"
echo "-- 10. a ring spawned with itsa: members and moderator join as participants, the owner stays (S-501)"
settings '{"fire-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":"reviewer","ring":{"format":"fire","members":["reviewer","reviewer-opus"],"moderator":{"type":"reviewer-opus","decides":true},"maxRounds":2}}}}'
spawn "{\"name\":\"io\",\"cwd\":\"$D\",\"harness\":\"claude\"}" >/dev/null
IK=$(human POST /api/itsas '{"title":"Ring target","owner":"io"}' | field key)
[ -n "$IK" ] || fail "no ITSA created"
R=$(spawn "{\"name\":\"ri\",\"type\":\"fire-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\",\"itsa\":\"$IK\"}")
[ "$(printf %s "$R" | field kind)" = ring ] || fail "not a ring: $R"
X=$(human GET "/api/itsas/$IK")
[ "$(printf %s "$X" | field owner)" = "$(sql "SELECT id FROM agents WHERE name = 'io'")" ] || fail "the ring took the owner: $X"
for N in ri-1 ri-2 ri-mod; do
  printf %s "$X" | grep -q "$(sql "SELECT id FROM agents WHERE name = '$N'")" || fail "$N is no participant: $X"
done
R=$(spawn "{\"name\":\"rs\",\"type\":\"reviewer\",\"cwd\":\"$D\",\"prompt\":\"review it\",\"itsa\":\"$IK\"}")
X=$(human GET "/api/itsas/$IK")
[ "$(printf %s "$X" | field owner)" = "$(sql "SELECT id FROM agents WHERE name = 'io'")" ] || fail "a single reviewer took the owner: $X"
printf %s "$X" | grep -q "$(sql "SELECT id FROM agents WHERE name = 'rs'")" || fail "rs is no participant: $X"
echo "PASS e2e-reviewer-ring"
