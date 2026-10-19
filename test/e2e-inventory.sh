#!/bin/sh
# The inventory route's daemon routes (S-877): registers a Claude Code agent in a temp git repo
# where AGENTS.md is a symlink to CLAUDE.md, then checks /api/agents/:id/inventory and
# /api/types/:type/inventory return every layer in arrival order, split into heading-level blocks
# whose token counts add up and whose hashes are sha256, that the MCP tool schemas are present and
# not just named, that a duplicate-file flag names the twice-seen file, that ?harness= overrides
# the type's harness, and that an unknown type 404s. No harness is launched. Runs against its own
# daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q
printf '# Repo\n\nThe repo codeword is CLAUDEWORD.\n' > "$REPO/CLAUDE.md"
# As in this repo: AGENTS.md is a symlink to CLAUDE.md, so a harness that loads AGENTS.md reads the
# same bytes Claude Code does. The inventory should flag that the file is reached twice.
ln -s CLAUDE.md "$REPO/AGENTS.md"
printf 'Every agent: the team motto is MOTTOWORD.\n' > "$STAM_HOME/instructions.md"
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$@"; }
reg() { api -X POST "$STAM_URL/api/register" -d "$1"; }
agent_id() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$1"; }

CC_JSON=$(reg "{\"name\":\"inv-cc\",\"harness\":\"claude\",\"cwd\":\"$REPO\",\"role\":\"Claude agent.\"}")
CCID=$(agent_id "$CC_JSON")

# The responses are large (every MCP tool schema), so keep them in files rather than argv.
api -X GET "$STAM_URL/api/agents/inv-cc/inventory" > "$TEST_TMP/agent.json"
api -X GET "$STAM_URL/api/types/developer/inventory" > "$TEST_TMP/type.json"
api -X GET "$STAM_URL/api/types/developer/inventory?harness=codex" > "$TEST_TMP/type-codex.json"
curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$STAM_URL/api/types/nope/inventory" > "$TEST_TMP/unknown.code"

curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$STAM_URL/api/types/developer/inventory?harness=nope" > "$TEST_TMP/badharness.code"

python3 - "$TEST_TMP/agent.json" "$TEST_TMP/type.json" "$TEST_TMP/type-codex.json" "$TEST_TMP/unknown.code" "$CCID" "$TEST_TMP/badharness.code" <<'PY'
import json, sys
inv, tinv, ticx = (json.load(open(sys.argv[i])) for i in (1, 2, 3))
t404, ccid = open(sys.argv[4]).read().strip(), sys.argv[5]
want = ["system-prompt", "instruction-files", "first-prompt", "skills", "mcp-instructions", "mcp-tools"]
fail = 0
def check(name, ok, detail=""):
    global fail
    if not ok:
        fail = 1
        print(f"FAIL: {name}: {detail}")

for label, d in (("agent", inv), ("type", tinv)):
    keys = [l["key"] for l in d["layers"]]
    check(f"{label} layers in arrival order", keys == want, keys)
    check(f"{label} totalTokens is the layer sum", d["totalTokens"] == sum(l["tokens"] for l in d["layers"]), d["totalTokens"])
    for l in d["layers"]:
        check(f"{label} layer {l['key']} tokens are its blocks' sum", l["tokens"] == sum(b["tokens"] for b in l["blocks"]), l["tokens"])
        for b in l["blocks"]:
            check(f"{label} block {b['id']} has a sha256 hash", len(b["hash"]) == 64 and all(c in "0123456789abcdef" for c in b["hash"]), b["hash"])
            check(f"{label} block {b['id']} is layer-keyed", b["id"].startswith(l["key"] + ":"), b["id"])
            check(f"{label} block {b['id']} has a token count", b["tokens"] == __import__("math").ceil(len(b["text"]) / 4), b["tokens"])
    tools = next(l for l in d["layers"] if l["key"] == "mcp-tools")
    check(f"{label} mcp-tools has non-zero tokens", tools["tokens"] > 0, tools["tokens"])
    check(f"{label} mcp-tools lists send_mail", any(b["title"] == "send_mail" for b in tools["blocks"]))

check("agent route names the agent", inv.get("agent", {}).get("id") == ccid and inv.get("agent", {}).get("harness") == "claude", inv.get("agent"))
check("type route names the type and its harness", tinv.get("type") == "developer" and tinv.get("harness") == "claude", tinv.get("type"))
check("unknown type 404s", t404 == "404", t404)
check("unknown harness 400s", open(sys.argv[6]).read().strip() == "400")
# Summaries (S-879): no summaries model is set in the test home, so prose blocks are 'off'; an MCP
# tool's JSON schema takes its own description as the summary, state 'source'.
for label, d in (("agent", inv), ("type", tinv)):
    for l in d["layers"]:
        for b in l["blocks"]:
            check(f"{label} block {b['id']} has a summaryState", b.get("summaryState") in ("auto", "pending", "off", "failed", "source"), b.get("summaryState"))
    tools = next(l for l in d["layers"] if l["key"] == "mcp-tools")
    sm = next(b for b in tools["blocks"] if b["title"] == "send_mail")
    check(f"{label} send_mail is summarized from its description", sm["summaryState"] == "source" and json.loads(sm["text"])["description"] == sm["summary"], sm.get("summary"))
    check(f"{label} prose blocks are off with no model", all(b["summaryState"] == "off" for l in d["layers"] if l["key"] != "mcp-tools" for b in l["blocks"]))
check("?harness= overrides the type's harness", ticx.get("harness") == "codex", ticx.get("harness"))
check("a harness that can't load skills is flagged", any(f["kind"] == "skills-unsupported" for f in ticx["flags"]), ticx["flags"])
check("claude's skills are not flagged as unsupported", not any(f["kind"] == "skills-unsupported" for f in tinv["flags"]), tinv["flags"])

sysp = next(l for l in inv["layers"] if l["key"] == "system-prompt")
files = next(l for l in inv["layers"] if l["key"] == "instruction-files")
check("system-prompt holds the all-agents instructions", any("MOTTOWORD" in b["text"] for b in sysp["blocks"]))
check("instruction-files holds the repo file's text", any("CLAUDEWORD" in b["text"] for b in files["blocks"]))
check("duplicate-file flag for the AGENTS.md symlink", any(f["kind"] == "duplicate-file" and f.get("layer") == "instruction-files" for f in inv["flags"]), inv["flags"])

sys.exit(fail)
PY
echo "PASS e2e-inventory"