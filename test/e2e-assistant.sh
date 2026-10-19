#!/bin/sh
# The executive assistant acts for the human on every agent, free (agents start with no
# prompt, so no model runs): it spawns under any parent or none, renames, reparents, and
# controls agents outside its tree; other agents keep their limits; and only the human
# sets permission modes, for the assistant too.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fake_claude ""
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
# human METHOD PATH [JSON] and agent METHOD PATH [JSON]: the web UI, and an agent's own calls.
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
agent() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
spawn() { human POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\"$2}" | field id; }

EA=$(spawn ea ',"kind":"assistant"')
WORKER=$(spawn worker)
KID=$(spawn kid ",\"parent\":\"$WORKER\"")
[ -n "$EA" ] && [ -n "$WORKER" ] && [ -n "$KID" ] || fail "spawn: $EA $WORKER $KID"

# Another agent can't rename, reparent, or control outside its tree, and spawns only its own children.
as_agent "$WORKER" POST "/api/agents/$KID/rename" "{\"by\":\"$WORKER\",\"name\":\"x\"}" | grep -q 'only the human and the assistant' || fail "worker renamed its child"
as_agent "$WORKER" POST "/api/agents/$EA/set-visibility" "{\"by\":\"$WORKER\",\"visibility\":{\"reach\":\"all\"}}" | grep -q 'may control only' || fail "worker controlled a non-child"
P=$(as_agent "$WORKER" POST /api/agents "{\"by\":\"$WORKER\",\"parent\":\"$EA\",\"name\":\"sneak\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"t\"}" | field parent_id)
[ "$P" = "$WORKER" ] || fail "worker's spawn landed under $P, not itself"

# The assistant controls agents outside its tree, renames, and reparents.
as_agent "$EA" POST "/api/agents/$KID/set-visibility" "{\"by\":\"$EA\",\"visibility\":{\"reach\":\"tree\"}}" | grep -q 'visibility set' || fail "assistant can't control a non-child"
as_agent "$EA" POST "/api/agents/$KID/rename" "{\"by\":\"$EA\",\"name\":\"demo-kid\"}" | grep -q 'kid is now demo-kid' || fail "assistant rename"
[ "$(human GET /api/agents/demo-kid | field id)" = "$KID" ] || fail "renamed agent not found by its new name"
as_agent "$EA" POST "/api/agents/$KID/set-parent" "{\"by\":\"$EA\",\"parent\":\"none\"}" | grep -q 'top-level' || fail "assistant set-parent none"
[ -z "$(human GET "/api/agents/$KID" | field parent_id)" ] || fail "still has a parent"
as_agent "$EA" POST "/api/agents/$KID/set-parent" "{\"by\":\"$EA\",\"parent\":\"$WORKER\"}" | grep -q 'reports to worker' || fail "assistant set-parent worker"

# The assistant spawns top-level and under others, never in bypass.
TOP=$(as_agent "$EA" POST /api/agents "{\"by\":\"$EA\",\"parent\":null,\"name\":\"top\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"t\",\"permission_mode\":\"bypass\"}")
[ -z "$(echo "$TOP" | field parent_id)" ] || fail "assistant's top-level spawn has a parent"
[ "$(echo "$TOP" | field permission_mode)" = auto ] || fail "assistant spawned in bypass"
UNDER=$(as_agent "$EA" POST /api/agents "{\"by\":\"$EA\",\"parent\":\"$WORKER\",\"name\":\"under\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"t\"}" | field parent_id)
[ "$UNDER" = "$WORKER" ] || fail "assistant's spawn under worker landed under $UNDER"
as_agent "$EA" POST "/api/agents/$WORKER/permission-mode" "{\"by\":\"$EA\",\"mode\":\"bypass\"}" | grep -q 'only the human' || fail "assistant set a permission mode"

# The assistant kills and forgets.
as_agent "$EA" POST /api/agents/top/kill "{\"by\":\"$EA\"}" | grep -q stopped || fail "assistant kill"
as_agent "$EA" POST /api/agents/top/forget "{\"by\":\"$EA\"}" | grep -q 'forgot top' || fail "assistant forget"

# The human's message carries the same system notes as mail from the human (S-1474): what the main world showed and, when
# sent without a pick, the routing note. The fake records the prompt it was typed in its transcript.
prompt_got() {
  python3 -c '
import json, sys
for line in open(sys.argv[1]):
  try: row = json.loads(line)
  except ValueError: continue
  c = row.get("message", {}).get("content")
  if row.get("type") == "user" and isinstance(c, str): print(c)
' "$("$STAM" show "$1" | grep -m1 '"transcript_path"' | cut -d'"' -f4)" | tr '\n' ' ' | grep -qs "$2"
}
human POST /api/assistant/message '{"text":"hello ea","looking_at":"  Usage \n\n tokens  "}' >/dev/null
wait_until prompt_got ea 'hello ea .*\[stam: The human was looking at: Usage tokens (may or may not be relevant)\.\]'
human POST /api/assistant/message '{"text":"second ea","looking_at":"Mail","routing_uncertain":true}' >/dev/null
wait_until prompt_got ea 'second ea .*\[stam: Routing was uncertain: .*\] .*\[stam: The human was looking at: Mail (may or may not be relevant)\.\]'
human POST /api/assistant/message '{"text":"third ea","looking_at":"   "}' >/dev/null
wait_until prompt_got ea 'third ea'
prompt_got ea 'third ea .*looking at' && fail "a blank looking_at added a note"
echo "PASS e2e-assistant"
