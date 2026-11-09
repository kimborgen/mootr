#!/bin/sh
# GET /api/agents does a bounded amount of database work at 300 agents (S-344): each per-agent read is one
# grouped read for the whole list, not one query per agent. Counts statement executions on a throwaway daemon
# (POST /api/test/statements), and checks the answer still carries each agent's mail, waits and blockers, and leaves
# out the spawn brief (first_prompt is null, S-3808) that the agent's own detail still gives. Without `state` or `ids`
# it lists live agents only (S-3816).
# Waits on state, never on time. Free: a throwaway daemon, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
use main
daemon_up main
auth="authorization: Bearer $(cat "$STAM_HOME/token")"
fail() { echo "FAIL: $1"; exit 1; }
post() { curl -sf -m 60 -H "$auth" -H 'content-type: application/json' -d "$2" "$STAM_URL/api/test/$1"; }
post seed-agents '{"count":300}' >/dev/null
# A spawn brief: the list sends it as null (S-3808), the detail keeps it.
post agent '{"agent":"id-3","first_prompt":"the whole spawn brief"}' >/dev/null
# A stopped and an archived agent: only `state` or `ids` lists them (S-3816).
post agent '{"agent":"id-10","lifecycle":"shut_down"}' >/dev/null
post agent '{"agent":"id-11","lifecycle":"archived"}' >/dev/null

# The daemon's own background work (reconcile, polls) also runs statements while a window is open, so one window can
# hold a burst that is not the request's. The request's cost is the least a window shows over a few windows.
counts=""
for _i in 1 2 3 4 5; do
  post statements '{"action":"start"}' | grep -q '"ok":true' || fail "the statement count didn't start"
  curl -sf -m 60 -H "$auth" "$STAM_URL/api/agents?state=all" >"$TEST_TMP/agents.json"
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
assert all(a["first_prompt"] is None for a in agents.values()), "the list carries first_prompt"
PY
curl -sf -m 60 -H "$auth" "$STAM_URL/api/agents/id-3" | grep -q '"first_prompt":"the whole spawn brief"' || fail "the agent detail lost first_prompt"

# The default list is live agents only; state and ids ask for the others (S-3816).
ids() { curl -sf -m 60 -H "$auth" "$STAM_URL/api/agents$1" | python3 -c 'import json, sys; print(" ".join(sorted(a["id"] for a in json.load(sys.stdin) if a["id"] in ("id-9", "id-10", "id-11"))))'; }
[ "$(ids '')" = "id-9" ] || fail "the default list isn't live agents only: $(ids '')"
[ "$(ids '?state=stopped,archived')" = "id-10 id-11" ] || fail "state=stopped,archived: $(ids '?state=stopped,archived')"
[ "$(ids '?ids=id-11,ag-10')" = "id-10 id-11" ] || fail "ids by id and name: $(ids '?ids=id-11,ag-10')"
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 60 -H "$auth" "$STAM_URL/api/agents?state=gone")" = 400 ] || fail "an unknown state isn't refused"

# A peer's busy sweep asks fields=peer (S-4913): the same agents, with only what it keeps, from a handful of reads.
# Only a peer daemon's own call gets it: its token with x-stam-local, no agent forwarded, and no q, role or as.
peer_auth="authorization: Bearer $(cat "$STAM_HOME/peer-token")"
code() { curl -s -o /dev/null -w "%{http_code}" -m 60 "$@"; }
[ "$(code -H "$auth" "$STAM_URL/api/agents?state=all&fields=peer")" = 403 ] || fail "fields=peer is served to the owner token"
[ "$(code -H "$peer_auth" "$STAM_URL/api/agents?state=all&fields=peer")" = 403 ] || fail "fields=peer is served without x-stam-local"
[ "$(code -H "$peer_auth" -H "x-stam-local: 1" -H "x-stam-agent: id-3" "$STAM_URL/api/agents?state=all&fields=peer")" = 403 ] || fail "fields=peer is served to a forwarded agent"
for extra in "q=nonexistent" "role=dev" "as=id-3"; do
  [ "$(code -H "$peer_auth" -H "x-stam-local: 1" "$STAM_URL/api/agents?state=all&fields=peer&$extra")" = 400 ] || fail "fields=peer with $extra is not refused"
done
counts=""
for _i in 1 2 3; do
  post statements '{"action":"start"}' | grep -q '"ok":true' || fail "the statement count didn't start"
  curl -sf -m 60 -H "$peer_auth" -H "x-stam-local: 1" "$STAM_URL/api/agents?state=all&fields=peer" >"$TEST_TMP/peer.json"
  counts="$counts $(post statements '{"action":"stop"}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["statements"])')"
done
peer_statements=$(echo $counts | tr ' ' '\n' | sort -n | head -1)
echo "statement executions per GET /api/agents?state=all&fields=peer at 300 agents (3 windows):$counts; least: $peer_statements"
[ "$peer_statements" -le 10 ] || fail "$peer_statements statement executions for the peer fields (at most 10)"
# The full list read right after, so both see the same state.
curl -sf -m 60 -H "$auth" "$STAM_URL/api/agents?state=all" >"$TEST_TMP/full.json"
python3 - "$TEST_TMP/full.json" "$TEST_TMP/peer.json" <<'PY' || fail "the peer fields differ from the full list"
import json, sys
full = {a["id"]: a for a in json.load(open(sys.argv[1]))}
peer = {a["id"]: a for a in json.load(open(sys.argv[2]))}
assert set(peer) == set(full), (len(full), len(peer))
assert {"id-10", "id-11"} <= set(peer), "stopped and archived agents are listed"
keys = {"id", "name", "machine", "lifecycle", "activity", "parent_id", "paused_by", "parents", "pending_requests", "waits"}
for id, p in peer.items():
    f = full[id]
    assert set(p) == keys, sorted(p)
    for k in ("name", "machine", "lifecycle", "activity", "parent_id", "paused_by", "pending_requests"):
        assert p[k] == f[k], (id, k, p[k], f[k])
    assert sorted(p["parents"]) == sorted(f["parents"]), (id, p["parents"], f["parents"])
    assert sorted(w["id"] for w in p["waits"]) == sorted(w["id"] for w in f["waits"]), (id, p["waits"])
assert any(p["waits"] for p in peer.values()), "some agent has waits"
PY
echo "ok: one GET /api/agents at 300 agents runs $statements statement executions and keeps each agent's data; the peer fields run $peer_statements"
