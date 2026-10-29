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
# get PATH: a read of the daemon's API (-f: a failure, or a gate 404, fails here). pyj EXPR: EXPR over the JSON on stdin, as d.
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
pyj() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# agent NAME FIELD: a field of the agent with that name, empty when there is none.
agent() { get "/api/agents?state=all" | pyj "next((a['$2'] for a in d if a['name'] == '$1'), '')"; }
# live PREFIX: how many agents whose name starts with PREFIX are not archived.
live_prefix() { get "/api/agents?state=all" | pyj "sum(a['name'].startswith('$1') and a['lifecycle'] != 'archived' for a in d)"; }
# ring NAME FIELD: a field of the ring, empty when there is none.
ring_field() { curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/rings/$1" | pyj "'' if 'error' in d or d.get('$2') is None else d['$2']"; }
ring_count() { get /api/rings | pyj "sum(r['name'] == '$1' for r in d)"; }
codex_blockers() { get "/api/test/blockers" | pyj "sum(b['account'] == 'codex-like' for b in d)"; }
typeof() { agent "$1" type; }

FUT=$(($(date +%s) + 7200))
reading() { human POST /api/test/cost "{\"action\":\"reading\",\"name\":\"codex\",\"windows\":{\"five_hour\":{\"used_percentage\":$1,\"resets_at\":$FUT}}}" >/dev/null; }
held() { [ "$(codex_blockers)" -ge 1 ]; }
free() { [ "$(codex_blockers)" = 0 ]; }
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
[ "$(ring_field rr1 format)/$(ring_field rr1 max_rounds)/$(ring_field rr1 moderator_id | sed 's/^$/none/')/$(ring_field rr1 topic)/$(ring_field rr1 created_by)" = "rounds/3/none/review the patch/human" ] || fail "ring row: $(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/rings/rr1")"
[ "$(typeof rr1-1)" = reviewer ] && [ "$(typeof rr1-2)" = reviewer-opus ] || fail "agent types"
"$STAM" ring rr1 | grep -q '"status": "running"' || fail "ring not running"
OUT=$(spawn "{\"name\":\"rr1b\",\"type\":\"review-ring\",\"cwd\":\"$D\"}")
printf %s "$OUT" | grep -q 'give a prompt' || fail "a ring with no task spawned: $OUT"

echo "-- 1b. each member starts on its type's brief, the task as its topic and the ring's steps, delivered once (S-3926)"
# The list sends first_prompt as null (S-3808); the detail has it.
brief() { get "/api/agents/$(agent "$1" id)" | pyj "d.get('first_prompt') or ''"; }
events() { get "/api/test/events?agent=$(agent "$1" id)&type=$2"; }
delivered() { [ "$(events "$1" first-prompt:delivered | pyj "len(d)")" -ge 1 ]; }
for M in rr1-1 rr1-2; do
  B=$(brief $M)
  printf %s "$B" | grep -q '^Review: review the patch' || fail "$M has no type brief: $B"
  printf %s "$B" | grep -q 'member of ring rr1' || fail "$M's brief lacks the ring's steps: $B"
  ! printf %s "$B" | grep -q 'give your verdict with the `pr_review` tool' || fail "$M's brief has it post its own verdict: $B"
  [ "$(events $M spawn | pyj "json.loads(d[0]['data'])['prompt']")" = True ] || fail "$M spawned without a prompt"
  [ "$(events $M first-prompt:pending | pyj "len(d)")" = 1 ] || fail "$M's first prompt isn't recorded as pending"
  wait_until delivered "$M"
  [ "$(events $M first-prompt:delivered | pyj "len(d)")" = 1 ] || fail "$M's first prompt went in more than once"
done

echo "-- 2. a moderator by type, and the format, rounds, and decides from the type"
settings '{"fire-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":"reviewer","ring":{"format":"fire","members":["reviewer","reviewer-opus"],"moderator":{"type":"reviewer-opus","decides":true},"maxRounds":2}}}}'
R=$(spawn "{\"name\":\"rr2\",\"type\":\"fire-ring\",\"cwd\":\"$D\",\"prompt\":\"decide it\"}")
[ "$(printf %s "$R" | field moderator.name)" = rr2-mod ] || fail "moderator: $R"
[ "$(printf %s "$R" | field moderator.type)" = reviewer-opus ] || fail "moderator type: $R"
[ "$(ring_field rr2 format)/$(ring_field rr2 max_rounds)/$(ring_field rr2 moderator_decides)/$([ "$(ring_field rr2 moderator_id)" = "$(agent rr2-mod id)" ] && echo 1)" = "fire/2/1/1" ] || fail "ring row"
[ "$(typeof rr2-mod)" = reviewer-opus ] || fail "moderator agent type"

echo "-- 3. ring_create: spawn entries and the moderator by type"
R=$(human POST /api/rings "{\"name\":\"rc1\",\"topic\":\"t\",\"format\":\"debate\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}],\"moderator\":{\"type\":\"reviewer-opus\"},\"moderator_decides\":true}")
[ "$(printf %s "$R" | field name)" = rc1 ] || fail "ring_create: $R"
[ "$(typeof rc1-1)" = reviewer ] && [ "$(typeof rc1-2)" = reviewer-opus ] && [ "$(typeof rc1-mod)" = reviewer-opus ] || fail "ring_create agent types"
[ "$(ring_field rc1 format)/$(ring_field rc1 moderator_decides)" = "debate/1" ] || fail "ring_create ring row"
brief rc1-1 | grep -q '^Review: t' || fail "a ring_create member has no type brief: $(brief rc1-1)"
brief rc1-mod | grep -q 'moderator of ring rc1' || fail "the ring_create moderator lacks the ring's steps: $(brief rc1-mod)"
R=$(human POST /api/rings "{\"name\":\"rc2\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"members\":[\"rc1-1\"],\"spawn\":[{\"type\":\"reviewer-opus\"}],\"moderator\":\"holder\"}")
[ "$(printf %s "$R" | field name)" = rc2 ] || fail "ring_create with an existing moderator: $R"

echo "-- 4. a held member falls back inside its own chain"
hold
R=$(spawn "{\"name\":\"rr3\",\"type\":\"review-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(printf %s "$R" | field kind)" = ring ] || fail "held member: $R"
[ "$(typeof rr3-1)" = reviewer-opus ] || fail "held member's type: $(typeof rr3-1)"
[ "$(get "/api/test/events?agent=$(agent rr3-1 id)&type=reviewer:fallback" | pyj "len(d)")" = 1 ] || fail "no reviewer:fallback event"

echo "-- 5. a member that can't start: the whole ring falls to the single fallback reviewer"
# solo has no fallback, so with codex held its spawn is refused, after fr-1 (claude) started.
settings '{"solo":{"description":"x","harness":"codex","model":"gpt-6.1-sol","effort":"low","review":{"fallback":null,"ring":null}},"fb-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":"reviewer-opus","ring":{"format":"rounds","members":["reviewer-opus","solo"],"moderator":null,"maxRounds":2}}},"nofb-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":null,"ring":{"format":"rounds","members":["reviewer-opus","solo"],"moderator":null,"maxRounds":2}}}}'
R=$(spawn "{\"name\":\"fr\",\"type\":\"fb-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(printf %s "$R" | field name)" = fr ] || fail "fallback reviewer name: $R"
[ "$(printf %s "$R" | field type)" = reviewer-opus ] || fail "fallback reviewer type: $R"
printf %s "$R" | field warning | grep -q "didn't start.*can't spawn fr-2" || fail "no reason in the warning: $(printf %s "$R" | field warning)"
printf %s "$R" | field first_prompt | grep -q 'review it' || fail "fallback reviewer lost the brief"
[ "$(live_prefix fr-)" = 0 ] || fail "members left running"
[ "$(agent fr-1 lifecycle)" = archived ] || fail "fr-1 not archived: $(agent fr-1 lifecycle)/$(agent fr-1 activity)/$(agent fr-1 activity_detail); $(events fr-1 % | pyj "[e['type'] for e in d]")"
[ "$(ring_count fr)" = 0 ] || fail "a ring was left"

echo "-- 6. no fallback: the spawn is refused, nothing is left"
OUT=$(spawn "{\"name\":\"nf\",\"type\":\"nofb-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
printf %s "$OUT" | grep -q "can't start ring nf.*no fallback" || fail "no refusal: $OUT"
[ "$(live_prefix nf)" = 0 ] || fail "members left running"
unhold

echo "-- 7. an explicit model, harness, or preset is refused"
for X in '"model":"claude-sonnet-5-5"' '"harness":"claude"' '"preset":"standard"'; do
  OUT=$(spawn "{\"name\":\"rx\",\"type\":\"review-ring\",\"cwd\":\"$D\",\"prompt\":\"x\",$X}")
  printf %s "$OUT" | grep -q 'takes no harness, model, or preset' || fail "spawned with $X: $OUT"
  [ "$(get "/api/agents?state=all" | pyj "sum(a['name'].startswith('rx') for a in d)")" = 0 ] || fail "left an agent ($X)"
done
echo "-- 8. a member or moderator whose launch fails after its row exists is archived"
launchfail() { human POST /api/test/launch-fail "{\"names\":$1}" >/dev/null; }
live() { live_prefix "${1%\%}"; }
launchfail '["lf-2"]'
OUT=$(human POST /api/rings "{\"name\":\"lf\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}]}")
printf %s "$OUT" | grep -q 'launch of lf-2 failed' || fail "member launch failure not reported: $OUT"
[ "$(live 'lf-%')" = 0 ] || fail "member launch failure left agents running"
[ "$(agent lf-2 lifecycle)" = archived ] || fail "lf-2 not archived"
[ "$(ring_count lf)" = 0 ] || fail "a ring was left (member)"
launchfail '["lm-mod"]'
OUT=$(human POST /api/rings "{\"name\":\"lm\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}],\"moderator\":{\"type\":\"reviewer-opus\"}}")
printf %s "$OUT" | grep -q 'launch of lm-mod failed' || fail "moderator launch failure not reported: $OUT"
[ "$(live 'lm-%')" = 0 ] || fail "moderator launch failure left agents running"
[ "$(agent lm-mod lifecycle)" = archived ] || fail "lm-mod not archived"
[ "$(ring_count lm)" = 0 ] || fail "a ring was left (moderator)"
launchfail '[]'
# A name that is already taken is refused, and that agent is left alone.
spawn "{\"name\":\"tk-2\",\"cwd\":\"$D\",\"harness\":\"claude\"}" >/dev/null
OUT=$(human POST /api/rings "{\"name\":\"tk\",\"topic\":\"t\",\"format\":\"rounds\",\"cwd\":\"$D\",\"spawn\":[{\"type\":\"reviewer\"},{\"type\":\"reviewer-opus\"}]}")
printf %s "$OUT" | grep -q 'tk-2 is taken' || fail "a taken name was not refused: $OUT"
[ "$(live 'tk-2')" = 1 ] || fail "the colliding agent was archived"
[ "$(agent tk-1 lifecycle)" = archived ] || fail "tk-1 not archived"
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
[ "$(ring_count cx)" = 0 ] || fail "a ring was left"
echo "-- 10. a ring spawned with itsa: members and moderator join as participants, the owner stays (S-501)"
settings '{"fire-ring":{"description":"x","harness":"","model":null,"effort":null,"review":{"fallback":"reviewer","ring":{"format":"fire","members":["reviewer","reviewer-opus"],"moderator":{"type":"reviewer-opus","decides":true},"maxRounds":2}}}}'
spawn "{\"name\":\"io\",\"cwd\":\"$D\",\"harness\":\"claude\"}" >/dev/null
IK=$(human POST /api/itsas '{"title":"Ring target","owner":"io"}' | field key)
[ -n "$IK" ] || fail "no ITSA created"
R=$(spawn "{\"name\":\"ri\",\"type\":\"fire-ring\",\"cwd\":\"$D\",\"prompt\":\"review it\",\"itsa\":\"$IK\"}")
[ "$(printf %s "$R" | field kind)" = ring ] || fail "not a ring: $R"
X=$(human GET "/api/itsas/$IK")
[ "$(printf %s "$X" | field owner)" = "$(agent io id)" ] || fail "the ring took the owner: $X"
for N in ri-1 ri-2 ri-mod; do
  printf %s "$X" | grep -q "$(agent $N id)" || fail "$N is no participant: $X"
done
R=$(spawn "{\"name\":\"rs\",\"type\":\"reviewer\",\"cwd\":\"$D\",\"prompt\":\"review it\",\"itsa\":\"$IK\"}")
X=$(human GET "/api/itsas/$IK")
[ "$(printf %s "$X" | field owner)" = "$(agent io id)" ] || fail "a single reviewer took the owner: $X"
printf %s "$X" | grep -q "$(agent rs id)" || fail "rs is no participant: $X"
echo "PASS e2e-reviewer-ring"
