#!/bin/sh
# The requirements MCP tools end to end (S-504), free: an agent on the scripted fake Claude Code
# (test/fake-claude, no model) writes a requirement draft with req_create, which reaches the
# human's attention list as an ask; the human approves it there, and the draft is in force; the
# agent then runs req_check on a text with a REQ: stub marker, gets a "likely violates" verdict,
# and waives it with req_waive (S-505: that one false positive is over the precision limit, so the
# requirement drops to observe on its own, with a req:demoted event and the rate in req_get; the
# agent also runs a preview, which records nothing). Also: the tools are listed only while requirements are on, and the
# agent's instructions carry the requirements template only then. The decisions endpoint is the
# stub (test/decide-stub.mjs). One daemon, one agent, no model turns, no spend.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/req-tools.json" <<'EOF2'
{ "agents": { "e2e-req-tools": { "turns": [
  { "match": "write a requirement", "steps": [
    { "mcp": "req_create", "expect": "Created R-1", "save": { "key": "Created (R-[0-9]+)", "created": "(.*)" },
      "args": { "title": "Plain text", "text": "Text shall be plain.", "rationale": "e2e", "verification": ["decision"], "scope": { "subjects": ["manual"] }, "mode": "inform" } },
    { "mcp": "req_get", "expect": "[draft]", "args": { "key": "${key}" } },
    { "reply": "DRAFTED ${key} ${created}" } ] },
  { "match": "check it now", "steps": [
    { "mcp": "req_check", "expect": "likely violates", "save": { "vid": "verdict #([0-9]+)" },
      "args": { "text": "pasted REQ:R-1=violates", "keys": ["R-1"] } },
    { "mcp": "req_waive", "expect": "Waived verdict", "args": { "verdict_id": "${vid}", "kind": "false_positive", "reason": "the stub says so" } },
    { "mcp": "req_get", "expect": "Precision: 1 of its last 1 flags", "args": { "key": "${key}" } },
    { "mcp": "req_check", "expect": "Nothing was recorded", "args": { "keys": ["R-1"], "preview": true } },
    { "mcp": "req_get", "expect": "R-1", "args": { "text": "plain" } },
    { "reply": "CHECKED ${vid}" } ] } ] } } }
EOF2
fake_claude "$TEST_TMP/req-tools.json"
daemon_home main
stub_key main
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$(dirname "$(readlink -f "$0")")/decide-stub.mjs" "$STUB" &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null; stam_test_cleanup' EXIT
for _i in $(seq 1 50); do [ -s "$STUB/url" ] && break; sleep 0.2; done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
daemon_up main
use main
NAME="e2e-req-tools"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
get() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
post() { curl -sf -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$STAM_URL$1"; }
listed() { get /api/tools | python3 -c 'import json,sys; names=[t["name"] for g in json.load(sys.stdin)["groups"] for t in g["tools"]]; print(" ".join(sorted(n for n in names if n.startswith("req_"))))'; }

# Off (the default): the daemon lists no req_* tool, and the answer to the gate route is false.
[ -z "$(listed)" ] || fail "req_* tools listed while requirements are off: $(listed)"
[ "$(get /api/req-enabled | python3 -c 'import json,sys; print(json.load(sys.stdin)["enabled"])')" = False ] || fail "req-enabled isn't false"

# Turn it on.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s['requirements'] = {'enabled': True, 'approval': 'human', 'keyPrefix': 'R', 'dailyCapUsd': 1, 'demoteMinFlags': 1, 'defaultThreshold': 0.8, 'defaultMode': 'observe'}
json.dump(s, open(p, 'w'), indent=2)
PY
[ "$(listed)" = "req_check req_create req_get req_set req_waive" ] || fail "the req_* tools aren't all listed: $(listed)"

# The agent writes a draft.
"$STAM" spawn "$NAME" --model claude-opus-5-5 --cwd "$DIR" "Use the req_* MCP tools to write a requirement as a draft, then reply." >/dev/null
"$STAM" wait "$NAME" --until idle --timeout 60
"$STAM" show "$NAME" | grep -q "DRAFTED R-1" || fail "the agent didn't draft R-1"
[ "$(get /api/requirements/R-1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" = draft ] || fail "R-1 isn't a draft"

# The draft is an ask in the human's attention list, with no other mail mechanism.
ASK=$(get /api/itsas/attention | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["kind"]=="requirement-approval"]; print(r[0]["key"] if r else "")')
[ -n "$ASK" ] || fail "the draft isn't in the attention list: $("$STAM" show "$NAME" | grep -i "DRAFTED")"
get /api/itsas/attention | grep -q "R-1" || fail "the ask doesn't name R-1"

# The human approves it there: the requirement is in force and the ask closes.
post "/api/itsas/$ASK/act" '{"action":"approve","text":""}' >/dev/null
i=0
while [ "$(get /api/requirements/R-1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" != in_force ]; do
  i=$((i + 1)); [ "$i" -gt 100 ] && fail "R-1 didn't go in force after the approval"; sleep 0.2
done
i=0
while [ "$(get "/api/itsas/$ASK" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" != done ]; do
  i=$((i + 1)); [ "$i" -gt 100 ] && fail "the approval ask didn't close"; sleep 0.2
done

# The agent checks a text with the stub marker, then waives the verdict.
post /api/mail "{\"from\":\"human\",\"to\":[\"$NAME\"],\"new_thread\":true,\"subject\":\"check it now\",\"body\":\"go\"}" >/dev/null
i=0
until said "$NAME" "CHECKED"; do
  i=$((i + 1)); [ "$i" -gt 300 ] && fail "the agent didn't finish the check: $("$STAM" show "$NAME" | grep last_message)"; sleep 0.2
done
get /api/requirements/R-1 | python3 -c '
import json, sys
d = json.load(sys.stdin)
v = d["verdicts"]
assert len(v) == 1 and v[0]["verdict"] == "violates", v
' || fail "the stored verdict isn't a violation"
WAIVERS=$(python3 - "$STAM_HOME" <<'PY'
import sqlite3, sys, glob
db = sqlite3.connect(sys.argv[1] + "/stam.db")
print(db.execute("select count(*) from req_waivers where kind = 'false_positive' and reason = 'the stub says so'").fetchone()[0])
PY
)
[ "$WAIVERS" = 1 ] || fail "the waiver wasn't stored ($WAIVERS)"
# The false positive demoted the requirement; the preview recorded nothing (still one verdict).
get /api/requirements/R-1 | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["mode"] == "observe", d["mode"]
p = d["precision"]
assert (p["violates"], p["false_positives"], p["rate"]) == (1, 1, 1.0), p
assert d["verdicts"][0]["waiver"]["kind"] == "false_positive", d["verdicts"]
assert len(d["verdicts"]) == 1, d["verdicts"]
' || fail "R-1 wasn't demoted to observe with its precision shown"
DEMOTED=$(python3 - "$STAM_HOME" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1] + "/stam.db")
print(db.execute("select count(*) from events where type = 'req:demoted'").fetchone()[0])
PY
)
[ "$DEMOTED" = 1 ] || fail "no req:demoted event ($DEMOTED)"
# API level, with the body the MCP shim sends (an agent's `by` beside the fields): under `any`
# approval an agent moves a draft to in force by naming its rev, and not without it; under `human`
# approval it can't reword a requirement that is in force.
python3 - "$STAM_HOME/settings.json" any <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s['requirements']['approval'] = sys.argv[2]
json.dump(s, open(p, 'w'), indent=2)
PY
# These calls act as the agent, so they carry its own token: the shared token can't name an agent that has one.
AGENT_ID=$(get /api/agents | python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$NAME")
AGENT_TOKEN=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$AGENT_ID" STAM_TOKEN | cut -d= -f2-)
[ -n "$AGENT_TOKEN" ] || fail "no token in $NAME's session"
agent_patch() { curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
R2=$(curl -sf -X POST -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' -d "{\"by\":\"$NAME\",\"title\":\"Api level\",\"text\":\"Api shall hold.\",\"verification\":[\"decision\"]}" "$STAM_URL/api/requirements" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
[ "$(agent_patch "/api/requirements/$R2" "{\"status\":\"in_force\",\"by\":\"$NAME\"}")" = 403 ] || fail "an agent moved a draft to in force without naming its rev"
REV=$(get "/api/requirements/$R2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["rev"])')
[ "$(agent_patch "/api/requirements/$R2" "{\"status\":\"in_force\",\"ifRev\":$REV,\"by\":\"$NAME\"}")" = 200 ] || fail "an MCP-shaped approval (status, ifRev, by) was refused"
python3 - "$STAM_HOME/settings.json" human <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s['requirements']['approval'] = sys.argv[2]
json.dump(s, open(p, 'w'), indent=2)
PY
post_code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $AGENT_TOKEN" -H 'content-type: application/json' -d "$2" "$STAM_URL$1"; }
[ "$(post_code /api/requirements "{\"by\":\"$NAME\",\"title\":\"Straight in\",\"status\":\"in_force\"}")" = 403 ] || fail "an agent created a requirement straight in force"
[ "$(agent_patch "/api/requirements/$R2" "{\"text\":\"Reworded by an agent.\",\"by\":\"$NAME\"}")" = 403 ] || fail "an agent reworded a requirement in force"
[ "$(get "/api/requirements/$R2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["text"])')" = "Api shall hold." ] || fail "the text of a requirement in force changed"
for tool in req_create req_get req_check req_waive; do
  "$STAM" events "$NAME" | grep -q "mcp__stam__$tool" || fail "the agent never called $tool"
done

"$STAM" kill "$NAME" >/dev/null
"$STAM" wait "$NAME" --until shut_down --timeout 20
"$STAM" forget "$NAME" >/dev/null
echo "PASS e2e-req-tools"
