#!/bin/sh
# The user's free-text cost instructions, free: they reach the chief of staff's template
# and the system prompt of every manager (an agent with children), and summary()/usage_info
# carries them as `instructions`; nothing of it appears when the setting is empty. Registers
# agents only, so no harness is launched and nothing is spent. Runs on its own daemon (test/lib.sh).
set -e
# The human is the request carrying the test key (standing in for tailscale serve): only the human writes settings.
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$@"; }
reg() { api -X POST "$STAM_URL/api/register" -d "$1"; }
field() { python3 -c 'import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])' "$1" "$2"; }

TEXT='COSTWORDS: never extra credits on Claude or Codex; OpenRouter is an experiment.'

# The chief of staff, a manager (an agent with a child), and a plain agent with none.
COS=$(field "$(reg "{\"name\":\"ci-cos\",\"harness\":\"claude\",\"cwd\":\"/tmp\",\"role\":\"Chief of staff.\"}")" id)
MGR=$(field "$(reg "{\"name\":\"ci-mgr\",\"harness\":\"claude\",\"cwd\":\"/tmp\",\"role\":\"Manager.\"}")" id)
KID=$(field "$(reg "{\"name\":\"ci-kid\",\"harness\":\"claude\",\"cwd\":\"/tmp\",\"role\":\"Child.\"}")" id)
PLAIN=$(field "$(reg "{\"name\":\"ci-plain\",\"harness\":\"claude\",\"cwd\":\"/tmp\",\"role\":\"Plain agent.\"}")" id)
"$STAM" cos ci-cos >/dev/null
api -X POST "$STAM_URL/api/agents/$KID/set-parent" -d "{\"parent\":\"$MGR\"}" >/dev/null

# Set the instructions through the Settings route, the way the web UI does: load the
# settings, set cost.instructions, and save the whole object back.
setcost() {
  api "$STAM_URL/api/config/settings" | python3 -c '
import json, sys
s = json.loads(json.load(sys.stdin)["text"])
s.setdefault("cost", {})["instructions"] = sys.argv[1]
print(json.dumps({"text": json.dumps(s)}))
' "$1"
}
api -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -X POST "$STAM_URL/api/config/settings" -d "$(setcost "$TEXT")" >/dev/null

python3 - "$TEXT" \
  "$(api "$STAM_URL/api/agents/$COS/instructions")" \
  "$(api "$STAM_URL/api/agents/$MGR/instructions")" \
  "$(api "$STAM_URL/api/agents/$PLAIN/instructions")" \
  "$(api "$STAM_URL/api/usage")" <<'PY'
import json, sys
text = sys.argv[1]
cos, mgr, plain, usage = (json.loads(x) for x in sys.argv[2:6])
fail = 0
def check(name, ok, detail=""):
    global fail
    if not ok:
        fail = 1
        print(f"FAIL: {name}: {detail}")

cos_parts, mgr_parts, plain_parts = cos["parts"], mgr["parts"], plain["parts"]
# The chief of staff gets it in its own template.
check("chief of staff carries the instructions", any(p.get("origin") == "chief-of-staff" and text in p["text"] for p in cos_parts))
# A manager (an agent with children) gets a Cost section that also names usage_info.
cost = [p for p in mgr_parts if p["label"] == "Cost"]
check("manager gets one Cost section", len(cost) == 1, [p["label"] for p in mgr_parts])
check("the Cost section carries the instructions", bool(cost) and text in cost[0]["text"])
check("the Cost section names usage_info", bool(cost) and "usage_info" in cost[0]["text"])
# A plain agent (no children) gets none of it.
check("plain agent gets no Cost section", all(text not in p["text"] for p in plain_parts))
# usage_info and summary() carry it as `instructions`.
check("summary carries the instructions", usage.get("instructions") == text, usage.get("instructions"))
sys.exit(fail)
PY

# Empty: the section and the summary field go away.
api -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -X POST "$STAM_URL/api/config/settings" -d "$(setcost '')" >/dev/null
python3 - \
  "$(api "$STAM_URL/api/agents/$COS/instructions")" \
  "$(api "$STAM_URL/api/agents/$MGR/instructions")" \
  "$(api "$STAM_URL/api/usage")" <<'PY'
import json, sys
text = 'COSTWORDS'
cos, mgr, usage = (json.loads(x) for x in sys.argv[1:4])
fail = 0
def check(name, ok, detail=""):
    global fail
    if not ok:
        fail = 1
        print(f"FAIL: {name}: {detail}")

check("empty: nothing reaches the chief of staff", all(text not in p["text"] for p in cos["parts"]))
check("empty: no Cost section for the manager", all(p["label"] != "Cost" and text not in p["text"] for p in mgr["parts"]))
check("empty: summary instructions is empty", usage.get("instructions") == "", usage.get("instructions"))
sys.exit(fail)
PY

echo "PASS e2e-cost-instructions"
