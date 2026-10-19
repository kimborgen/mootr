#!/bin/sh
# ITSAs step 2 end to end, free: an agent on the scripted fake (test/fake-claude, no model)
# uses the itsa_* MCP tools (not the CLI) to create a root ITSA of kind project, two children,
# move one child to done, and list its work. The script checks through `stam itsa` that the
# tree exists with the right shape, and through `stam events` that the agent actually called the
# MCP tools. Runs against its own throwaway daemon (test/lib.sh). The turn is in the script
# below; nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/itsa-mcp.json" <<'EOF'
{ "agents": { "e2e-itsa-mcp": { "turns": [
  { "match": "itsa_create a root ITSA", "steps": [
    { "mcp": "itsa_create", "expect": "Created S-", "save": { "root": "Created (S-[0-9]+)" },
      "args": { "title": "Root e2e-itsa-mcp", "kind": "project", "owner": "${name}" } },
    { "mcp": "itsa_create", "expect": "Created S-", "save": { "childA": "Created (S-[0-9]+)" },
      "args": { "title": "Child A e2e-itsa-mcp", "owner": "${name}", "parent": "${root}" } },
    { "mcp": "itsa_create", "expect": "Created S-", "save": { "childB": "Created (S-[0-9]+)" },
      "args": { "title": "Child B e2e-itsa-mcp", "owner": "${name}", "parent": "${root}" } },
    { "mcp": "itsa_set", "expect": "done", "args": { "ref": "${childA}", "status": "done" } },
    { "mcp": "itsa_list", "expect": "${root}", "args": { "mine": true } },
    { "reply": "${result}" } ] } ] } } }
EOF
fake_claude "$TEST_TMP/itsa-mcp.json"
isolate
NAME="e2e-itsa-mcp"
T="e2e-itsa-mcp"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
fail() { echo "FAIL: $1"; exit 1; }

"$STAM" spawn "$NAME" --model claude-haiku-5-5 --cwd "$DIR" "Use the itsa_* MCP tools only (not the CLI or the HTTP API) to do exactly this, passing owner: \"$NAME\" on every creation so the ITSAs are yours:
1. itsa_create a root ITSA titled 'Root $T' with kind project and owner \"$NAME\". Note the key it returns.
2. itsa_create two children of that root (parent: the key from step 1), titled 'Child A $T' and 'Child B $T', each with owner \"$NAME\".
3. itsa_set the 'Child A $T' ITSA to status done.
4. itsa_list with mine=true, then reply with the exact text it returned.
Create nothing else."

"$STAM" wait "$NAME" --until idle --timeout 60

# The agent went through the MCP tools, not around them.
for tool in itsa_create itsa_set itsa_list; do
  "$STAM" events "$NAME" | grep -q "mcp__stam__$tool" || fail "the agent never called $tool"
done

# The tree exists: a root of kind project with two children, exactly one of them done.
ROOT=$("$STAM" itsa ls "$T" | awk -v t="Root $T" '$0 ~ t {print $1; exit}')
[ -n "$ROOT" ] || fail "the root ITSA is missing"
"$STAM" itsa show "$ROOT" >"$TEST_TMP/root.json"
python3 - "$TEST_TMP/root.json" "$T" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = sys.argv[2]
assert d['kind'] == 'project', f"kind is {d['kind']}"
kids = d['children']
assert len(kids) == 2, f"root has {len(kids)} children"
assert sorted(k['title'] for k in kids) == sorted([f'Child A {t}', f'Child B {t}']), [k['title'] for k in kids]
assert sorted(k['status'] for k in kids) == ['backlog', 'done'], [k['status'] for k in kids]
print(f"root {d['key']} with children {[k['key'] for k in kids]}")
PY

# The agent's reply carried the list back to it.
"$STAM" show "$NAME" | grep -q "$ROOT" || fail "the agent's reply doesn't mention the root key"

"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 20
"$STAM" forget "$NAME" >/dev/null
echo "PASS e2e-itsa-mcp"
