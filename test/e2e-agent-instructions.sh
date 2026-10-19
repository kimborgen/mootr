#!/bin/sh
# The Instructions view's daemon route, free: registers a Claude Code agent and a Codex
# agent in a temp git repo with CLAUDE.md, CLAUDE.local.md, and root and subfolder AGENTS.md,
# and checks each is shown the files its harness loads (in the order it reads them) and told
# about the rest, that the chief of staff gets the chief-of-staff part, that a missing first
# prompt is reported, and that an overridden system-prompt template reorders the parts and
# keeps its extra text. No harness is launched. Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q
printf '# Repo\n\nThe repo codeword is CLAUDEWORD.\n' > "$REPO/CLAUDE.md"
printf '# Local\n\nThe local codeword is LOCALWORD.\n' > "$REPO/CLAUDE.local.md"
# As in this repo: AGENTS.md is a symlink to CLAUDE.md, so Codex and OpenCode load the
# same project rules the harness reads itself.
ln -s CLAUDE.md "$REPO/AGENTS.md"
mkdir -p "$REPO/sub"
printf '# Sub\n\nThe sub codeword is SUBWORD.\n' > "$REPO/sub/AGENTS.md"
printf 'Every agent: the team motto is MOTTOWORD.\n' > "$STAM_HOME/instructions.md"
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$@"; }
reg() { api -X POST "$STAM_URL/api/register" -d "$1"; }
agent_id() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])["id"])' "$1"; }

# A Claude Code agent starts in the repo; a Codex agent starts in the subfolder, where it
# reads the repo's AGENTS.md before the subfolder's. The third is named the chief of staff.
CC_JSON=$(reg "{\"name\":\"ins-cc\",\"harness\":\"claude\",\"cwd\":\"$REPO\",\"role\":\"Claude agent.\"}")
CCID=$(agent_id "$CC_JSON")
reg "{\"name\":\"ins-cx\",\"harness\":\"codex\",\"cwd\":\"$REPO/sub\",\"role\":\"Codex agent.\"}" >/dev/null
reg "{\"name\":\"ins-cos\",\"harness\":\"claude\",\"cwd\":\"$REPO\",\"role\":\"Chief of staff.\"}" >/dev/null
"$STAM" cos ins-cos >/dev/null

# An overridden system-prompt template: extra literal text, reordered placeholders, and a
# trailing literal that carries the id.
mkdir -p "$STAM_HOME/templates"
cat > "$STAM_HOME/templates/system-prompt.md" <<'TPL'
# Working inside stam

EXTRA-LITERAL-{{name}}.

{{human_mail}}

{{role}} then {{org}}

{{instructions}}

TRAILING-LITERAL-{{id}}.
TPL

CC=$(api -X GET "$STAM_URL/api/agents/ins-cc/instructions")
CX=$(api -X GET "$STAM_URL/api/agents/ins-cx/instructions")
COS=$(api -X GET "$STAM_URL/api/agents/ins-cos/instructions")

python3 - "$CC" "$CX" "$COS" "$REPO" "$CCID" <<'PY'
import json, sys
cc, cx, cos = (json.loads(x)["parts"] for x in sys.argv[1:4])
repo, ccid = sys.argv[4], sys.argv[5]
fail = 0
def check(name, ok, detail=""):
    global fail
    if not ok:
        fail = 1
        print(f"FAIL: {name}: {detail}")

labels = lambda parts: [p["label"] for p in parts]
repo_paths = lambda parts: [p["path"] for p in parts if p.get("path") and p["source"] == "repo"]
notes = lambda parts: "\n".join(p["text"] for p in parts if p["label"] == "Instruction files your harness skips")
index = lambda parts, label: next((i for i, p in enumerate(parts) if p["label"] == label), None)

# The system prompt and the all-agents instructions are present, from their templates.
check("system prompt literal part", any(p.get("origin") == "system-prompt" and "Working inside stam" in p["text"] for p in cc))
check("all-agents instructions part", any(p.get("origin") == "instructions" and "MOTTOWORD" in p["text"] for p in cc))

# The mail part says how the request reached the agent decides how to answer it: mail from
# the user is answered by mail, a short request typed in gets its answer in the chat.
mail = next((p for p in cc if p["label"] == "Mail to your user"), None)
check("the mail part answers a mailed request by mail", mail is not None and "only by mail" in mail["text"] and "reply_to" in mail["text"], (mail or {}).get("text", "")[:200])
check("the mail part answers a short typed request in the chat", mail is not None and "chat" in mail["text"])

# Claude Code loads CLAUDE.md and CLAUDE.local.md itself, and is pointed at AGENTS.md.
check("claude loads CLAUDE.md", any(p.endswith("/CLAUDE.md") for p in repo_paths(cc)), repo_paths(cc))
check("claude loads CLAUDE.local.md", any(p.endswith("/CLAUDE.local.md") for p in repo_paths(cc)), repo_paths(cc))
check("claude does not load AGENTS.md", not any(p.endswith("AGENTS.md") for p in repo_paths(cc)), repo_paths(cc))
check("claude told about AGENTS.md", "AGENTS.md" in notes(cc) and "sub/AGENTS.md" in notes(cc), notes(cc))

# Codex loads AGENTS.md itself, from the git root down to its folder, and is told about
# the CLAUDE files.
cx_repo = repo_paths(cx)
root_i = next((i for i, p in enumerate(cx_repo) if p == repo + "/AGENTS.md"), None)
sub_i = next((i for i, p in enumerate(cx_repo) if p.endswith("/sub/AGENTS.md")), None)
check("codex loads the root then the subfolder AGENTS.md", root_i is not None and sub_i is not None and root_i < sub_i, cx_repo)
check("codex does not load CLAUDE.md", not any(p.endswith("CLAUDE.md") for p in cx_repo), cx_repo)
check("codex told about CLAUDE.md", "CLAUDE.md" in notes(cx), notes(cx))
# The root AGENTS.md is a symlink to CLAUDE.md (this repo's pattern): Codex is shown the
# CLAUDE.md rules through it, so it and OpenCode read the same file Claude Code does.
root_agents = next((p for p in cx if p.get("path") == repo + "/AGENTS.md"), None)
check("codex's AGENTS.md part resolves the symlink to the CLAUDE.md text", root_agents is not None and "CLAUDEWORD" in root_agents["text"], root_agents)

# A registered agent has no recorded first prompt: the part says so.
check("missing first prompt is reported", any(p["label"] == "First prompt" and "Not recorded" in p["text"] for p in cc), labels(cc))

# The chief of staff gets the chief-of-staff paragraph, editable as its template; a plain
# agent's org part is not that template.
cos_org = [p for p in cos if p["label"] == "Org"]
check("chief of staff org part", len(cos_org) == 1 and cos_org[0].get("origin") == "chief-of-staff" and "chief of staff" in cos_org[0]["text"])
check("chief of staff standing rules", "Delegate; don't do the work" in cos_org[0]["text"] and "Schedule; don't start everything" in cos_org[0]["text"])
check("plain agent org is not the cos template", all(p.get("origin") != "chief-of-staff" for p in cc if p["label"] == "Org"))

# The override: its extra text shows, the reordered placeholders follow it, and its
# trailing literal (with the id) comes last.
check("override literal text shown", any("EXTRA-LITERAL-ins-cc" in p["text"] for p in cc))
check("override reorders the mail part before the role", index(cc, "Mail to your user") < index(cc, "Role"), labels(cc))
check("override trailing literal shown last", any(f"TRAILING-LITERAL-{ccid}" in p["text"] for p in cc))
check("override keeps the org part", "Org" in labels(cc))

sys.exit(fail)
PY
echo "PASS e2e-agent-instructions"
