#!/bin/sh
# ITSA fields from the agent side, free (S-367): an agent on the scripted fake (no model) uses
# the itsa_fields MCP tool (list, create, update, order, remove) and itsa_set with fields, then
# reads them in itsa_get and itsa_list. The script then checks `stam itsa field ...` and
# `stam itsa set --field` as the human, and that the agent's work shows in the daemon.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/fields.json" <<'JSON'
{ "agents": { "e2e-fields-agent": { "turns": [
  { "match": "use the fields tools", "steps": [
    { "mcp": "itsa_fields", "expect": "No fields", "args": {} },
    { "mcp": "itsa_fields", "expect": "created stage", "args": { "action": "create", "key": "stage", "label": "Stage", "type": "choice", "options": [{ "value": "dev" }, { "value": "live" }], "description": "Where the work stands" } },
    { "mcp": "itsa_fields", "expect": "created note", "args": { "action": "create", "key": "note", "label": "Note", "type": "text" } },
    { "mcp": "itsa_fields", "expect": "updated note", "args": { "action": "update", "field": "note", "label": "Remark" } },
    { "mcp": "itsa_fields", "expect": "reordered", "args": { "action": "order", "order": ["note", "stage"] } },
    { "mcp": "itsa_create", "expect": "Created S-", "save": { "k": "Created (S-[0-9]+)" }, "args": { "title": "Fielded e2e", "owner": "${name}" } },
    { "mcp": "itsa_set", "expect": "fields", "args": { "ref": "${k}", "fields": { "stage": "dev", "note": "hello" } } },
    { "mcp": "itsa_get", "expect": "stage=dev", "args": { "ref": "${k}" } },
    { "mcp": "itsa_list", "expect": "note=hello", "args": { "mine": true } },
    { "mcp": "itsa_fields", "expect": "removed note", "args": { "action": "remove", "field": "note" } },
    { "reply": "${k}" } ] } ] } } }
JSON
fake_claude "$TEST_TMP/fields.json"
isolate
NAME="e2e-fields-agent"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
fail() { echo "FAIL: $1"; exit 1; }

"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Please use the fields tools."
"$STAM" wait "$NAME" --until idle --timeout 60
for t in itsa_fields itsa_set itsa_get itsa_list; do
  "$STAM" events "$NAME" | grep -q "mcp__stam__$t" || fail "the agent never called $t"
done
"$STAM" itsa field ls | grep -q "^stage .*choice .*Stage (dev|live) — Where the work stands" || fail "stage is missing or wrong: $("$STAM" itsa field ls)"
"$STAM" itsa field ls | grep -q "^note" && fail "note wasn't removed"

echo "-- CLI as the human"
"$STAM" itsa field new pr "Pull request" --type link --description "The branch's PR" | grep -q "^pr " || fail "field new"
"$STAM" itsa field set pr --label "PR link" | grep -q "PR link" || fail "field set"
"$STAM" itsa field order pr stage | head -1 | grep -q "^pr " || fail "field order"
K=$("$STAM" itsa ls "Fielded e2e" | awk '{print $1; exit}')
"$STAM" itsa set "$K" --field pr=https://example.com/pr/1 --field stage=live | grep -q "fields: .* -> pr=https://example.com/pr/1 stage=live$" || fail "set --field reply isn't key=value pairs (S-2786)"
"$STAM" itsa show "$K" | python3 -c "import json,sys; d=json.load(sys.stdin)['fields']; assert d=={'pr':'https://example.com/pr/1','stage':'live'}, d" || fail "values not stored"
"$STAM" itsa set "$K" --field stage= | grep -q "fields: stage=live -> stage=(none)$" || fail "a cleared field reply isn't stage=(none) (S-2786)"
"$STAM" itsa show "$K" | python3 -c "import json,sys; d=json.load(sys.stdin)['fields']; assert 'stage' not in d, d" || fail "key= didn't clear"
echo "-- values are typed by the field: a text field keeps 007 as a string, a number field takes a number"
"$STAM" itsa field new ver Version --type text >/dev/null
"$STAM" itsa field new size Size --type number >/dev/null
"$STAM" itsa set "$K" --field ver=007 --field size=3 >/dev/null || fail "typed set"
"$STAM" itsa show "$K" | python3 -c "import json,sys; d=json.load(sys.stdin)['fields']; assert d['ver']=='007' and d['size']==3, d" || fail "ver/size not typed"
"$STAM" itsa set "$K" --field ver=123 >/dev/null
"$STAM" itsa show "$K" | python3 -c "import json,sys; d=json.load(sys.stdin)['fields']; assert d['ver']=='123', d" || fail "a text field got a number"
"$STAM" itsa set "$K" --field size=abc >/dev/null 2>"$TEST_TMP/err" && fail "a non-number was accepted"
grep -q "isn't one" "$TEST_TMP/err" || fail "no clear error for a non-number: $(cat "$TEST_TMP/err")"
"$STAM" itsa field rm pr | grep -q removed || fail "field rm"

"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 20
"$STAM" forget "$NAME" >/dev/null
echo "PASS e2e-itsa-fields-agent"
