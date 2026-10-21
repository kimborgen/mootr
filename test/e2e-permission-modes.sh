#!/bin/sh
# Permission mode settings (S-1967), free: Claude agents on the scripted fake (no prompt, so no
# model runs). A new agent takes the settings' mode, an agent's children too, whatever the agent
# asks for; the human's own pick for an agent stays over the settings. A settings change lists the
# running agents still on the old mode, and apply restarts them in place on the new one, keeping
# their session: the fake records the argv each launch got (argv.json, in the agent's folder). A
# switch whose launch fails, at once or at the end of a busy agent's step, puts the old mode back.
set -e
# Settings writes need the trusted human (S-362): the test key stands in for the Tailscale address.
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# A HOLD-TURN prompt holds its turn until release-turn is typed, so an agent is busy when apply runs.
echo '{ "turns": [ { "match": "HOLD-TURN", "steps": [ { "await": "release-turn" }, { "reply": "done" } ] } ] }' >"$TEST_TMP/perm.json"
fake_claude "$TEST_TMP/perm.json"
isolate
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(typeof v==="object"&&v!==null?JSON.stringify(v):v??"")})' "$1"; }
# trusted METHOD PATH [JSON]: as the human trustedHuman proves, which mode switches and apply need.
trusted() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
set_modes() { curl -s -X PATCH -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL/api/config/settings" -d "{\"patch\":{\"permissionModes\":$1}}" >/dev/null; }
spawn() { human POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\"$2}"; }
# The value after an option in the argv the agent's latest launch got.
launch_arg() { python3 -I -c 'import json, sys; a = json.load(open(sys.argv[1])); print(a[a.index(sys.argv[2]) + 1] if sys.argv[2] in a else "")' "$STAM_HOME/agents/$1/argv.json" "$2"; }
has_arg() { python3 -I -c 'import json, sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)' "$STAM_HOME/agents/$1/argv.json" "$2"; }
stale() { human GET /api/permission-modes | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).stale.map(x=>x.name).sort().join(" ")))'; }

# Nothing changes until a mode is set: a new agent runs auto, following the settings.
W=$(spawn w1)
WID=$(echo "$W" | field id)
[ "$(echo "$W" | field permission_mode)" = auto ] || fail "w1 isn't auto: $W"
[ "$(echo "$W" | field permission_source)" = settings ] || fail "w1 doesn't follow the settings"
"$STAM" wait w1 --until idle --timeout 60
[ "$(launch_arg "$WID" --permission-mode)" = auto ] || fail "w1 launched in $(launch_arg "$WID" --permission-mode)"

# The human's own pick stays over the settings.
M=$(spawn m1 ',"permission_mode":"auto"')
[ "$(echo "$M" | field permission_source)" = settings ] || fail "picking the settings' own mode made m1 manual"
D=$(spawn d1 ',"permission_mode":"default"')
DID=$(echo "$D" | field id)
[ "$(echo "$D" | field permission_mode)" = default ] && [ "$(echo "$D" | field permission_source)" = manual ] || fail "d1 isn't a manual default: $D"
"$STAM" wait d1 --until idle --timeout 60
[ "$(launch_arg "$DID" --permission-mode)" = default ] || fail "d1 launched in $(launch_arg "$DID" --permission-mode)"
[ -z "$(stale)" ] || fail "agents listed before any change: $(stale)"

# Bypass for Claude Code: w1 and m1 follow the settings, so they are listed; d1 is the human's.
set_modes '{"harness":{"claude":"bypass","codex":"auto","opencode":"auto"},"types":{}}'
[ "$(stale)" = "m1 w1" ] || fail "stale after the change: '$(stale)'"

# An agent's child takes the settings' mode, whatever the agent asks for.
K=$(as_agent w1 POST /api/agents "{\"by\":\"$WID\",\"name\":\"k1\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"t\",\"permission_mode\":\"auto\"}")
[ "$(echo "$K" | field permission_mode)" = bypass ] && [ "$(echo "$K" | field permission_source)" = settings ] || fail "k1 didn't take the settings' bypass: $K"
# An agent can't switch a mode, nor apply the settings.
as_agent w1 POST /api/permission-modes/apply "{\"by\":\"$WID\"}" | grep -q 'only the human' || fail "an agent applied the settings"

# The shared token with the x-stam-human claim is no proof: it can neither apply nor switch a mode.
human POST /api/permission-modes/apply '{}' | grep -q 'only the human' || fail "a header-only claim applied the settings"
human POST "/api/agents/$WID/permission-mode" '{"mode":"bypass"}' | grep -q 'only the human' || fail "a header-only claim switched a mode"
[ "$(stale)" = "m1 w1" ] || fail "a refused claim changed the stale list: '$(stale)'"

# A restart that fails puts the old mode back, so w1 stays listed for a retry.
"$STAM" wait k1 --until idle --timeout 60
"$STAM" wait m1 --until idle --timeout 60
human POST /api/test/launch-fail '{"names":["w1"]}' >/dev/null
F=$(trusted POST /api/permission-modes/apply '{}')
echo "$F" | field skipped | grep -q 'launch of w1 failed' || fail "w1's failed launch isn't reported: $F"
[ "$(human GET "/api/agents/$WID" | field permission_mode)" = auto ] || fail "a failed restart kept w1's new mode"
case " $(stale) " in *" w1 "*) ;; *) fail "w1 left the stale list after its restart failed: '$(stale)'" ;; esac
human GET /api/permission-modes | grep -q '"failed":"test: launch of w1 failed"' || fail "the stale list doesn't say w1's switch failed"
human POST /api/test/launch-fail '{"names":[]}' >/dev/null

# Apply retries: w1 comes back on bypass, its session resumed.
A=$(trusted POST /api/permission-modes/apply '{}')
echo "$A" | field applied | grep -q w1 || fail "apply didn't switch w1: $A"
w1_bypass() { [ "$(launch_arg "$WID" --permission-mode)" = bypassPermissions ] && has_arg "$WID" --resume; }
wait_until w1_bypass
"$STAM" wait w1 --until idle --timeout 60
[ "$(human GET "/api/agents/$WID" | field permission_mode)" = bypass ] || fail "w1's mode isn't bypass"
[ -z "$(stale)" ] || fail "agents still listed after apply: $(stale)"

# A manual switch makes w1 the human's, so a later change leaves it alone; 'settings' hands it back.
trusted POST "/api/agents/$WID/permission-mode" '{"mode":"auto"}' >/dev/null
[ "$(human GET "/api/agents/$WID" | field permission_source)" = manual ] || fail "a manual switch didn't make w1 manual"
set_modes '{"harness":{"claude":"default","codex":"auto","opencode":"auto"},"types":{}}'
case " $(stale) " in *" w1 "*) fail "a manual w1 is listed" ;; esac
"$STAM" wait w1 --until idle --timeout 60
R=$(trusted POST "/api/agents/$WID/permission-mode" '{"mode":"settings"}')
[ "$(echo "$R" | field agent.permission_mode)" = default ] && [ "$(echo "$R" | field agent.permission_source)" = settings ] || fail "'settings' didn't hand w1 back: $R"

# Each settings change is logged with its actor.
EV=$(curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL/api/test/events?agent=human&type=permission-modes" | python3 -c 'import json,sys; print(sum(json.loads(e["data"]).get("by") == "human" for e in json.load(sys.stdin)))')
[ "$EV" = 2 ] || fail "logged $EV settings changes, not 2"
# Every switch of w1 names who made it: the failed one, apply, manual, and back to the settings.
BY=$(curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL/api/test/events?agent=$WID&type=permission-mode%25" | python3 -c 'import json,sys; print(" ".join(e["type"] + ":" + json.loads(e["data"])["by"] for e in json.load(sys.stdin)))')
[ "$BY" = "permission-mode:human permission-mode:failed:human permission-mode:human permission-mode:applied:human permission-mode:human permission-mode:human" ] || fail "switch events and their actors: $BY"
# A busy agent's switch waits for its step; a launch that fails then puts the old mode back too,
# unless the human picked a mode for it meanwhile (b2), which stays.
B=$(spawn b1 ',"prompt":"HOLD-TURN"')
BID=$(echo "$B" | field id)
B2=$(spawn b2 ',"prompt":"HOLD-TURN"')
B2ID=$(echo "$B2" | field id)
"$STAM" wait b1 --until working --timeout 60
"$STAM" wait b2 --until working --timeout 60
set_modes '{"harness":{"claude":"auto","codex":"auto","opencode":"auto"},"types":{}}'
human POST /api/test/launch-fail '{"names":["b1","b2"]}' >/dev/null
P=$(trusted POST /api/permission-modes/apply '{}')
echo "$P" | grep -q '"name":"b1","mode":"auto","result":"waiting for b1' || fail "b1's switch didn't wait for its step: $P"
echo "$P" | grep -q '"name":"b2","mode":"auto","result":"waiting for b2' || fail "b2's switch didn't wait for its step: $P"
trusted POST "/api/agents/$B2ID/permission-mode" '{"mode":"auto"}' >/dev/null
release() { tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$1:" -l "release-turn"; tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$1:" Enter; }
release "$BID"
release "$B2ID"
down() { [ "$(human GET "/api/agents/$1" | field lifecycle)" = shut_down ]; }
wait_until down "$BID"
wait_until down "$B2ID"
[ "$(human GET "/api/agents/$BID" | field permission_mode)" = default ] || fail "b1's failed deferred restart kept its new mode"
human GET /api/permission-modes | grep -q '"name":"b1".*"failed":"test: launch of b1 failed"' || fail "b1 isn't listed as a failed switch: $(human GET /api/permission-modes)"
[ "$(human GET "/api/agents/$B2ID" | field permission_mode)" = auto ] && [ "$(human GET "/api/agents/$B2ID" | field permission_source)" = manual ] || fail "b2's manual pick was undone by the failed restart"
case " $(stale) " in *" b2 "*) fail "a manual b2 is listed" ;; esac
human POST /api/test/launch-fail '{"names":[]}' >/dev/null

echo PASS
