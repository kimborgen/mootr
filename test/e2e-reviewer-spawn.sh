#!/bin/sh
# Reviewer types at spawn, free (S-360, S-412): a reviewer type spawned alone runs on its own
# target; with its account held it becomes the first free type of its fallback chain (a type on
# the same account is skipped), recorded as the agent's type, with a 'reviewer:fallback' event and
# a note in its brief; an explicit model or harness wins; with no free fallback the held account
# refuses the spawn; a ring type spawns a ring (test/e2e-reviewer-ring.sh) but is refused an explicit model, harness, or preset; and a manager's instructions say the
# configured process. The fake Claude Code and fake Codex stand in, so no model runs.
# Runs against its own daemon (test/lib.sh).
set -e

STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
daemon_home main
D="$(mktemp -d "$TEST_TMP/work.XXXX")"
# $1 is the default reviewer type (reviewer or review-ring); $2 is default or none, the shipped
# reviewer's fallback (reviewer-opus) or no fallback; $3 is extra types as JSON. registry.json is
# reread on every use.
settings() {
  cat >"$TEST_TMP/main/settings.json" <<JSON
{ "peers": [],
  "cost": { "accounts": {
    "codex-like": { "match": { "harness": "codex" }, "paid": false, "onSubExhausted": "wait" },
    "claude-like": { "match": { "harness": "claude", "model": "claude-opus" }, "paid": false, "onSubExhausted": "wait" } } } }
JSON
  STAM_ROOT="$ROOT" node -e 'const [d,fb,out,extra]=process.argv.slice(1);const r={defaultReviewer:d,types:JSON.parse(extra||"{}")};
if(fb==="none")r.types.reviewer={...require(process.env.STAM_ROOT+"/registry/defaults.json").types.reviewer,review:{fallback:null,ring:null}};
require("fs").writeFileSync(out,JSON.stringify(r))' "$1" "$2" "$TEST_TMP/main/registry.json" "${3:-}"
}
settings reviewer default
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
spawn() { human POST /api/agents "$1"; }
trio() { printf %s "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log([a.harness,a.model,a.effort].map((x)=>x??"").join(":"))})'; }
sql() { node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.argv[1], { readOnly: true }); const r = d.prepare(process.argv[2]).get(); if (r) console.log(Object.values(r)[0] ?? "");' "$STAM_HOME/stam.db" "$1"; }
events() { sql "SELECT COUNT(*) FROM events WHERE agent_id = (SELECT id FROM agents WHERE name = '$1') AND type = '$2'"; }

# A codex holder agent carries the window blocker that holds the codex account: a reading of 100%
# through the test hook, the way test/e2e-cost.sh does it (a row written straight into the database
# is cleared by the daemon's own reconciling, and races its writes).
FUT=$(($(date +%s) + 7200))
reading() { human POST /api/test/cost "{\"action\":\"reading\",\"name\":\"codex\",\"windows\":{\"five_hour\":{\"used_percentage\":$1,\"resets_at\":$FUT}}}" >/dev/null; }
held() { [ "$(sql "SELECT COUNT(*) FROM blockers WHERE account = 'codex-like'")" -ge 1 ]; }
free() { [ "$(sql "SELECT COUNT(*) FROM blockers WHERE account = 'codex-like'")" = 0 ]; }
spawn "{\"name\":\"holder\",\"cwd\":\"$D\",\"harness\":\"codex\"}" >/dev/null
"$STAM" wait holder --until idle --timeout 60 >/dev/null
hold() { reading 100; wait_until held; }
unhold() { reading 10; wait_until free; }

echo "-- 1. default: the primary"
R=$(spawn "{\"name\":\"r1\",\"type\":\"reviewer\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(trio "$R")" = "codex:gpt-6.1-sol:low" ] || fail "default reviewer: $(trio "$R") ($R)"
[ "$(events r1 reviewer:fallback)" = 0 ] || fail "primary spawn recorded a fallback"
[ "$(printf %s "$R" | field role)" = reviewer ] || fail "role lost"

echo "-- 2. held primary: the fallback, recorded and said in the brief"
hold
R=$(spawn "{\"name\":\"r2\",\"type\":\"reviewer\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(trio "$R")" = "claude:claude-opus-5-5:medium" ] || fail "fallback reviewer: $(trio "$R") ($R)"
[ "$(events r2 reviewer:fallback)" = 1 ] || fail "no reviewer:fallback event"
printf %s "$R" | field first_prompt | grep -q 'fallback for the reviewer type reviewer.*reviewer-opus: claude claude-opus-5-5 (medium)' || fail "brief doesn't say the fallback: $(printf %s "$R" | field first_prompt)"
[ "$(printf %s "$R" | field type)" = reviewer-opus ] || fail "the fallback agent's type: $(printf %s "$R" | field type)"
printf %s "$R" | field first_prompt | grep -q 'five_hour at 100%' || fail "brief doesn't give the reason"

echo "-- 3. explicit model or harness wins, even with the primary held"
R=$(spawn "{\"name\":\"r3\",\"type\":\"reviewer\",\"cwd\":\"$D\",\"model\":\"claude-sonnet-5-5\",\"harness\":\"claude\"}")
[ "$(trio "$R")" = "claude:claude-sonnet-5-5:" ] || fail "explicit model: $(trio "$R")"
[ "$(events r3 reviewer:fallback)" = 0 ] || fail "explicit spawn recorded a fallback"
unhold
R=$(spawn "{\"name\":\"r4\",\"type\":\"reviewer\",\"cwd\":\"$D\",\"preset\":\"standard\"}")
[ "$(trio "$R")" = "claude:claude-sonnet-5-5:medium" ] || fail "explicit preset: $(trio "$R")"

echo "-- 4. held primary and no fallback: the spawn is refused"
settings reviewer none
hold
OUT=$(spawn "{\"name\":\"r5\",\"type\":\"reviewer\",\"cwd\":\"$D\"}")
printf %s "$OUT" | grep -q "can't spawn r5" || fail "a held reviewer with no fallback spawned: $OUT"
[ -z "$(sql "SELECT id FROM agents WHERE name = 'r5'")" ] || fail "refused reviewer left an agent"
unhold

echo "-- 5. a custom scenario type walks its own chain: a type on the held account is skipped"
SEC='{"sec-mid":{"description":"x","harness":"codex","model":"gpt-6.1-sol","effort":"low","review":{"fallback":"reviewer-opus","ring":null}},"sec-rev":{"description":"x","harness":"codex","model":"gpt-6.1-sol","effort":"high","review":{"fallback":"sec-mid","ring":null}}}'
settings reviewer default "$SEC"
R=$(spawn "{\"name\":\"r6\",\"type\":\"sec-rev\",\"cwd\":\"$D\"}")
[ "$(trio "$R")" = "codex:gpt-6.1-sol:high" ] || fail "free custom type: $(trio "$R")"
hold
R=$(spawn "{\"name\":\"r7\",\"type\":\"sec-rev\",\"cwd\":\"$D\",\"prompt\":\"review it\"}")
[ "$(trio "$R")" = "claude:claude-opus-5-5:medium" ] || fail "two hops: $(trio "$R") ($R)"
[ "$(printf %s "$R" | field type)" = reviewer-opus ] || fail "type after two hops: $(printf %s "$R" | field type)"
SEC1='{"sec-mid":{"description":"x","harness":"codex","model":"gpt-6.1-sol","effort":"low","review":{"fallback":null,"ring":null}},"sec-rev":{"description":"x","harness":"codex","model":"gpt-6.1-sol","effort":"high","review":{"fallback":"sec-mid","ring":null}}}'
settings reviewer default "$SEC1"
OUT=$(spawn "{\"name\":\"r8\",\"type\":\"sec-rev\",\"cwd\":\"$D\"}")
printf %s "$OUT" | grep -q "can't spawn r8" || fail "every type held but it spawned: $OUT"
unhold

echo "-- 6. a ring type is refused an explicit harness, model, or preset"
for X in '"harness":"claude"' '"model":"claude-sonnet-5-5"' '"preset":"standard"'; do
  OUT=$(spawn "{\"name\":\"r10\",\"type\":\"review-ring\",\"cwd\":\"$D\",\"prompt\":\"x\",$X}")
  printf %s "$OUT" | grep -q 'takes no harness, model, or preset' || fail "a ring type spawned with $X: $OUT"
  [ -z "$(sql "SELECT id FROM agents WHERE name LIKE 'r10%'")" ] || fail "refused ring left an agent ($X)"
done

echo "-- 7. the manager's instructions name the process and targets"
settings review-ring default
spawn "{\"name\":\"boss\",\"type\":\"manager\",\"cwd\":\"$D\"}" >/dev/null
human GET /api/agents/boss/instructions | grep -qF 'spawn the default reviewer, `review-ring` (ring,' || fail "no ring default in the manager's instructions"
human GET /api/agents/boss/instructions | grep -qF 'A ring reviewer is spawned with `spawn_agent` `type` like any other' || fail "no ring spawn sentence"
settings reviewer default
human GET /api/agents/boss/instructions | grep -qF 'spawn the default reviewer, `reviewer` (codex gpt-6.1-sol, low)' || fail "no reviewer default after the default changes"
echo "PASS e2e-reviewer-spawn"
