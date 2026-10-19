#!/bin/sh
# Agent types, free: the shipped types are in the registry; a type added through the API
# gets its own instructions template; spawning by type (HTTP as the human, as an agent, and
# `stam spawn --type`) sets harness, model, effort, role, visibility, child notices, and the
# rendered brief, with explicit fields winning; the Instructions view shows the type's part;
# removing a shipped type masks it and removing a user type drops its template. A fake
# `claude` on PATH stands in for Claude Code, so no model runs even with a first prompt.
# Runs against its own daemon (test/lib.sh).
set -e
# The human is the request carrying the test key (standing in for tailscale serve): only the human writes types and templates.
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
FAKE="$TEST_TMP/fake-bin"
mkdir -p "$FAKE"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec sleep 600\n' >"$FAKE/claude"
chmod +x "$FAKE/claude"
PATH="$FAKE:$PATH"
export PATH
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
agent() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }

# Shipped types match the current model rules.
REG=$(human GET /api/registry)
for t in developer:claude:claude-haiku-5-5: reviewer:codex:gpt-6.1-sol:low manager:claude:claude-opus-5-5:medium coordinator:claude:claude-sonnet-5-5: advisor:claude:claude-fable-5-1:medium retro-steward:claude:claude-sonnet-5-5:; do
  name=${t%%:*}; rest=${t#*:}; h=${rest%%:*}; rest=${rest#*:}; e=${rest##*:}; m=${rest%:*}
  got="$(printf %s "$REG" | field "types.$name.harness"):$(printf %s "$REG" | field "types.$name.model"):$(printf %s "$REG" | field "types.$name.effort")"
  [ "$got" = "$h:$m:$e" ] || fail "shipped type $name is $got, not $h:$m:$e"
done
"$STAM" registry | grep -q '^  reviewer .*codex/gpt-6.1-sol (low)' || fail "stam registry doesn't list the reviewer type"
human GET /api/templates | grep -q '"name":"type-manager"' || fail "no type-manager template"

# A user type with every optional field; its instructions template starts empty.
human POST /api/types/tester '{"description":"Writes tests.","harness":"claude","model":"claude-haiku-5-5","effort":"low","child_notices":"none","visibility":{"reach":"tree"},"brief":"Do: {{task}} | parent={{parent}} | ticket={{ticket}} | type={{type}}"}' >/dev/null
[ "$(code POST /api/types/bad '{"harness":"nope"}')" = 400 ] || fail "a type with an unknown harness was accepted"
[ "$(human GET /api/templates | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.name==="type-tester");console.log(t?JSON.stringify(t.text):"missing")})')" = '""' ] || fail "type-tester template not listed empty"
human POST /api/templates/type-tester '{"text":"TESTER-RULES for {{name}}."}' >/dev/null

# The type composer (S-892): the catalog of blocks, then off and order saved by the human only.
CAT=$(human GET /api/blocks/composing)
FIRST=$(printf %s "$CAT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s).blocks;console.log(b.filter(x=>x.template==="system-prompt").map(x=>x.id).slice(0,2).reverse().join(" "))})')
set -- $FIRST
[ -n "$2" ] || fail "no composing blocks in the catalog: $CAT"
[ "$(code POST /api/types/tester "{\"description\":\"Writes tests.\",\"harness\":\"claude\",\"blocks\":{\"off\":[\"$1\"],\"order\":[\"$1\",\"$2\"]}}")" = 200 ] || fail "the human could not save blocks"
[ "$(human GET /api/registry | field types.tester.blocks.off)" = "[\"$1\"]" ] || fail "off not saved: $(human GET /api/registry | field types.tester.blocks)"
[ "$(agent POST /api/types/tester "{\"description\":\"Writes tests.\",\"harness\":\"claude\",\"blocks\":{\"off\":[\"$2\"]}}" | field error)" != "" ] || fail "an agent saved a type's blocks"
[ "$(human GET /api/registry | field types.tester.blocks.off)" = "[\"$1\"]" ] || fail "an agent changed the blocks"
[ "$(code POST /api/types/tester '{"harness":"claude","blocks":{"order":["nope"]}}')" = 400 ] || fail "an unknown block in order was accepted"

# Per-type skills (S-891): an unknown skill is a 400, a skill attaches and shows in the skill list, and an agent can't save it.
[ "$(code POST /api/types/tester '{"description":"Writes tests.","harness":"claude","skills":["no-such-skill"]}')" = 400 ] || fail "an unknown skill was accepted"
SK=$(human GET /api/skills | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s)[0]||{}).name||""))')
if [ -n "$SK" ]; then
  [ "$(code POST /api/types/tester "{\"description\":\"Writes tests.\",\"harness\":\"claude\",\"skills\":[\"$SK\"]}")" = 200 ] || fail "the human could not attach a skill"
  [ "$(human GET /api/registry | field types.tester.skills)" = "[\"$SK\"]" ] || fail "skills not saved"
  human GET /api/skills | grep -q '"attachedTo":\["tester"\]' || fail "the skill list doesn't say it is attached to tester"
  [ "$(agent POST /api/types/tester '{"description":"x","harness":"claude","skills":[]}' | field error)" != "" ] || fail "an agent saved a type's skills"
  [ "$(human GET /api/registry | field types.tester.skills)" = "[\"$SK\"]" ] || fail "an agent changed the skills"
fi
human POST /api/types/tester '{"description":"Writes tests.","harness":"claude","model":"claude-haiku-5-5","effort":"low","child_notices":"none","visibility":{"reach":"tree"},"brief":"Do: {{task}} | parent={{parent}} | ticket={{ticket}} | type={{type}}"}' >/dev/null

# The human spawns a manager by type alone: the type's preset and role, no prompt.
BOSS=$(human POST /api/agents "{\"name\":\"boss\",\"type\":\"manager\",\"cwd\":\"$DIR\"}")
[ "$(printf %s "$BOSS" | field type):$(printf %s "$BOSS" | field harness):$(printf %s "$BOSS" | field model):$(printf %s "$BOSS" | field effort):$(printf %s "$BOSS" | field role)" = "manager:claude:claude-opus-5-5:medium:manager" ] || fail "manager spawn: $BOSS"
[ -z "$(printf %s "$BOSS" | field first_prompt)" ] || fail "manager without a task got a brief"

# The manager spawns a tester with a task and a brief variable.
T=$(as_agent boss POST /api/agents "{\"name\":\"t1\",\"type\":\"tester\",\"by\":\"boss\",\"cwd\":\"$DIR\",\"prompt\":\"write tests\",\"brief_vars\":{\"ticket\":\"T-7\"}}")
[ "$(printf %s "$T" | field first_prompt)" = "Do: write tests | parent=boss | ticket=T-7 | type=tester" ] || fail "brief: $(printf %s "$T" | field first_prompt)"
[ "$(printf %s "$T" | field model):$(printf %s "$T" | field effort):$(printf %s "$T" | field child_notices)" = "claude-haiku-5-5:low:none" ] || fail "tester preset: $T"
[ "$(printf %s "$T" | field visibility)" = '{"reach":"tree"}' ] || fail "tester visibility: $(printf %s "$T" | field visibility)"
[ "$(printf %s "$T" | field parent_id)" = "$(printf %s "$BOSS" | field id)" ] || fail "tester not under boss"

# Its Instructions view has the type's part, editable as the type's template.
human GET /api/agents/t1/instructions | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).parts.find(x=>x.origin==="type-tester");process.exit(p&&p.label==="Type: tester"&&p.text.includes("TESTER-RULES for t1.")?0:1)})' || fail "no type part in t1's instructions"
human GET /api/agents/boss/instructions | grep -q 'Your type: manager' || fail "no manager instructions in boss's instructions"

# Explicit fields win over the type; another harness drops the type's model.
O=$(human POST /api/agents "{\"name\":\"t2\",\"type\":\"tester\",\"cwd\":\"$DIR\",\"model\":\"claude-sonnet-5-5\",\"effort\":\"high\",\"role\":\"Special.\",\"child_notices\":\"turn\"}")
[ "$(printf %s "$O" | field model):$(printf %s "$O" | field effort):$(printf %s "$O" | field role):$(printf %s "$O" | field child_notices)" = "claude-sonnet-5-5:high:Special.:turn" ] || fail "overrides: $O"
D=$(human POST /api/agents "{\"name\":\"t3\",\"type\":\"reviewer\",\"harness\":\"claude\",\"cwd\":\"$DIR\"}")
[ "$(printf %s "$D" | field harness):$(printf %s "$D" | field model)" = "claude:" ] || fail "reviewer on claude kept the type's model: $D"

# The CLI spawns by type with --var.
"$STAM" spawn t4 --type tester --var ticket=T-9 --cwd "$DIR" --parent boss "cli task" >/dev/null
[ "$("$STAM" show t4 | field first_prompt)" = "Do: cli task | parent=boss | ticket=T-9 | type=tester" ] || fail "cli brief: $("$STAM" show t4 | field first_prompt)"
[ "$(code POST /api/agents "{\"name\":\"t5\",\"type\":\"nope\",\"cwd\":\"$DIR\"}")" = 400 ] || fail "unknown type accepted"

# Removing types: a shipped one is masked in registry.json, a user one deleted with its template.
human DELETE /api/types/retro-steward >/dev/null
[ -z "$(human GET /api/registry | field types.retro-steward)" ] || fail "retro-steward still listed after removal"
grep -q '"retro-steward": null' "$STAM_HOME/registry.json" || fail "shipped retro-steward not masked"
human GET /api/templates | grep -q '"name":"type-retro-steward"' && fail "removed retro-steward's template still listed"
# Reviewer types (S-412): the default reviewer and a type another names can't be removed.
[ "$(human GET /api/registry | field defaultReviewer)" = reviewer ] || fail "no default reviewer in the registry"
[ "$(human GET /api/registry | field types.review-ring.review.ring.format)" = rounds ] || fail "review-ring missing"
[ "$(code DELETE /api/types/reviewer)" = 409 ] || fail "removed the default reviewer"
[ "$(code DELETE /api/types/reviewer-opus)" = 409 ] || fail "removed a fallback another type names"
human POST /api/types/fb '{"description":"x","harness":"claude","review":{"fallback":"nope","ring":null}}' | grep -q 'not a reviewer type' || fail "bad fallback accepted"
human DELETE /api/types/tester >/dev/null
[ ! -e "$STAM_HOME/templates/type-tester.md" ] || fail "tester's template left behind"
[ "$(code DELETE /api/types/tester)" = 404 ] || fail "removing a missing type didn't 404"
echo "PASS e2e-agent-types"
