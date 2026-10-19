#!/bin/sh
# GET /api/agents does a bounded amount of database work at 300 agents (S-344): each per-agent read is one
# grouped read for the whole list, not one query per agent. Counts statement executions on a throwaway daemon
# (POST /api/test/statements), and checks the answer still carries each agent's mail, waits and blockers.
# Waits on state, never on time. Free: a throwaway daemon, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
use main
node "$ROOT/test/agents-route-seed.mjs" >/dev/null
daemon_up main
auth="authorization: Bearer $(cat "$STAM_HOME/token")"
fail() { echo "FAIL: $1"; exit 1; }
post() { curl -s -m 60 -H "$auth" -H 'content-type: application/json' -d "$2" "$STAM_URL/api/test/$1"; }

# The daemon's own background work (reconcile, polls) also runs statements while a window is open, so one window can
# hold a burst that is not the request's. The request's cost is the least a window shows over a few windows.
counts=""
for _i in 1 2 3 4 5; do
  post statements '{"action":"start"}' | grep -q '"ok":true' || fail "the statement count didn't start"
  curl -s -m 60 -H "$auth" "$STAM_URL/api/agents" >"$TEST_TMP/agents.json"
  counts="$counts $(post statements '{"action":"stop"}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["statements"])')"
done
statements=$(echo $counts | tr ' ' '\n' | sort -n | head -1)
echo "statement executions per GET /api/agents at 300 agents (5 windows):$counts; least: $statements"
[ "$statements" -le 60 ] || fail "$statements statement executions for one GET /api/agents at 300 agents (at most 60)"

python3 - "$TEST_TMP/agents.json" <<'PY' || fail "the agents list lost data"
import json, sys
agents = {a["id"]: a for a in json.load(open(sys.argv[1]))}
assert len(agents) == 300, len(agents)
assert agents["id-3"]["unread"] == 3, agents["id-3"]["unread"]
assert [w["thread"] for w in agents["id-3"]["waits"] if w["kind"] == "event"] == ["thread-3-0"], agents["id-3"]["waits"]
assert [w["kind"] for w in agents["id-5"]["waits"] if w["kind"] == "timer"] == ["timer"], agents["id-5"]["waits"]
assert len(agents["id-7"]["blockers"]) == 1, agents["id-7"]["blockers"]
assert agents["id-8"]["parents"] == ["id-6"] or set(agents["id-8"]["parents"]) == {"id-6"}, agents["id-8"]["parents"]
assert agents["id-1"]["parents"] == ["id-0"], agents["id-1"]["parents"]
PY
echo "ok: one GET /api/agents at 300 agents runs $statements statement executions and keeps each agent's data"
