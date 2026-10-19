#!/bin/sh
# Child-turn notices: the per-parent childNotices setting. Free and no models: it
# registers agents and drives their activity through the Claude hook endpoint, so no
# harness runs. Covers "turn" (a notice every turn), "tree-idle" (quiet while a
# grandchild works, one notice when the whole subtree goes quiet), "none", that a blocked
# child always notifies, a pending permission, a descendant erroring, a daemon restart,
# and a diamond with a "turn" and a "tree-idle" parent. Runs against its own daemon
# (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
reg() { api POST /api/register "{\"name\":\"$1\",\"role\":\"$1\",\"harness\":\"claude\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
hook() { api POST "/api/hook/claude/$1" "$2" >/dev/null; }
work() { hook "$1" '{"hook_event_name":"UserPromptSubmit"}'; }
finish() { hook "$1" "{\"hook_event_name\":\"Stop\",\"last_assistant_message\":\"$2\"}"; }
notices() { "$STAM" child-notices "$1" "$2" >/dev/null; }
# set-parent takes the parent list already quoted for JSON, e.g. parent C '"P"' or '"P1","P2"'.
parent() { api POST "/api/agents/$1/set-parent" "{\"parent\":[$2]}" >/dev/null; }
# How many "child finished its turn" notices this agent has been sent.
turns() { api GET "/api/agents/$1/events" | python3 -c 'import json,sys; print(sum(e["type"]=="notice:queued" and "finished its turn" in (e.get("data") or "") for e in json.load(sys.stdin)))'; }
# How many "is blocked" notices this agent has been sent.
blocked() { api GET "/api/agents/$1/events" | python3 -c 'import json,sys; print(sum(e["type"]=="notice:queued" and "is blocked" in (e.get("data") or "") for e in json.load(sys.stdin)))'; }
fail() { echo "FAIL: $1"; exit 1; }

PARENT=$(reg parent); CHILD=$(reg child); GRAND=$(reg grand)
parent "$CHILD" "\"$PARENT\""; parent "$GRAND" "\"$CHILD\""

echo "-- tree-idle (the default): quiet while a grandchild works, one notice when it is idle"
work "$CHILD"; work "$GRAND"
finish "$CHILD" "waiting for my child"
[ "$(turns "$PARENT")" = 0 ] || fail "parent was told while the grandchild still worked"
finish "$GRAND" "grandchild done"
[ "$(turns "$PARENT")" = 1 ] || fail "parent wasn't told once (got $(turns "$PARENT"))"
api GET "/api/agents/$PARENT/events" | grep -q "agent child finished its turn" || fail "the notice doesn't name the idle child"
[ "$(turns "$CHILD")" = 1 ] || fail "the child wasn't told about the grandchild"

echo "-- turn: a notice every turn"
notices "$PARENT" turn
work "$CHILD"; finish "$CHILD" "second turn"
work "$CHILD"; finish "$CHILD" "third turn"
[ "$(turns "$PARENT")" = 3 ] || fail "turn mode didn't notify per turn (got $(turns "$PARENT"))"

echo "-- none: quiet, but a blocked child still notifies"
notices "$PARENT" none
work "$CHILD"; finish "$CHILD" "fourth turn"
[ "$(turns "$PARENT")" = 3 ] || fail "none still sent a finished-turn notice"
hook "$CHILD" '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}'
[ "$(blocked "$PARENT")" -ge 1 ] || fail "a blocked child didn't notify a parent set to none"

echo "-- control follows the tree: a child can't set its parent's notices, a parent can set its child's"
api POST "/api/agents/$PARENT/set-child-notices" "{\"child_notices\":\"none\",\"by\":\"$CHILD\"}" | grep -q "may control only itself" || fail "a child could change its parent's child notices"
api POST "/api/agents/$CHILD/set-child-notices" "{\"child_notices\":\"tree-idle\",\"by\":\"$PARENT\"}" | grep -q "child notices set to tree-idle" || fail "a parent couldn't set its child's child notices"

echo "-- an unresolved permission request holds the subtree busy until it is answered"
P2=$(reg parent2); C2=$(reg child2); G2=$(reg grand2)
parent "$C2" "\"$P2\""; parent "$G2" "\"$C2\""
work "$G2"; finish "$G2" "grandchild done"                    # G2 idle and announced
RIQ=$(api POST /api/permissions "{\"agent\":\"$G2\",\"action\":\"run it\",\"reason\":\"test\",\"audience\":\"human\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
work "$C2"; finish "$C2" "waiting on a permission"
[ "$(turns "$P2")" = 0 ] || fail "parent was told while a descendant's permission was pending"
"$STAM" authorize "$RIQ" ok >/dev/null
[ "$(turns "$P2")" = 1 ] || fail "answering the permission didn't release the ancestor (got $(turns "$P2"))"

echo "-- a descendant that errors releases the ancestor"
P3=$(reg parent3); C3=$(reg child3); G3=$(reg grand3)
parent "$C3" "\"$P3\""; parent "$G3" "\"$C3\""
work "$G3"
work "$C3"; finish "$C3" "waiting for my child"
[ "$(turns "$P3")" = 0 ] || fail "parent was told while the grandchild worked"
hook "$G3" '{"hook_event_name":"StopFailure","error":"boom"}'
[ "$(turns "$P3")" = 1 ] || fail "an errored descendant didn't release the ancestor (got $(turns "$P3"))"

echo "-- a daemon restart doesn't lose a deferred notice"
P4=$(reg parent4); C4=$(reg child4); G4=$(reg grand4)
parent "$C4" "\"$P4\""; parent "$G4" "\"$C4\""
work "$G4"
work "$C4"; finish "$C4" "waiting for my child"
daemon_stop main; daemon_up main
finish "$G4" "grandchild done"
[ "$(turns "$P4")" = 1 ] || fail "a restart lost the deferred notice (got $(turns "$P4"))"

echo "-- a diamond: a child with a tree-idle parent and a turn parent"
DP=$(reg dparent); TP=$(reg tparent); DC=$(reg dchild)
parent "$DC" "\"$DP\",\"$TP\""
notices "$DP" tree-idle; notices "$TP" turn
work "$DC"; finish "$DC" "diamond turn"
[ "$(turns "$DP")" = 1 ] || fail "the tree-idle parent wasn't told once (got $(turns "$DP"))"
[ "$(turns "$TP")" = 1 ] || fail "the turn parent wasn't told once (got $(turns "$TP"))"
work "$DC"; finish "$DC" "diamond second turn"
[ "$(turns "$DP")" = 2 ] || fail "the tree-idle parent wasn't told on the second turn"
[ "$(turns "$TP")" = 2 ] || fail "the turn parent wasn't told per turn (got $(turns "$TP"))"

echo "PASS e2e-child-notices"
