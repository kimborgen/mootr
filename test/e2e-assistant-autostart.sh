#!/bin/sh
# The daemon starts the assistant at boot when none exists (S-2144, settings assistant.autostart):
# a fresh home gets exactly one, a restart doesn't add a second, an archived or stopped one isn't
# revived, autostart off starts none, and a peer (not the settings home) starts none. Agents run the fake Claude Code, so no model runs.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fake_claude ""
# test/lib.sh turns autostart off for every test daemon; this test turns it on.
export STAM_ASSISTANT_AUTOSTART=1
fail() { echo "FAIL: $1"; exit 1; }
count() { curl -s -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/agents?state=all" | python3 -c 'import json,sys; print(sum(1 for a in json.load(sys.stdin) if a.get("kind")=="assistant"))'; }

# A fresh home: one assistant after start.
isolate
wait_until sh -c '[ "$(curl -s -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/agents" | grep -c "\"kind\":\"assistant\"")" -ge 1 ]'
[ "$(count)" = 1 ] || fail "fresh home: $(count) assistants, want 1"

# A restart doesn't start a second.
daemon_stop main
daemon_up main
sleep 2
[ "$(count)" = 1 ] || fail "after restart: $(count) assistants, want 1"

# A stopped assistant isn't replaced: it still counts as the one.
curl -s -X POST -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'x-stam-human: 1' "$STAM_URL/api/agents/assistant/kill" >/dev/null || true
daemon_stop main
daemon_up main
sleep 2
[ "$(count)" = 1 ] || fail "after stop and restart: $(count) assistants, want 1"

# autostart off: a fresh home gets none.
daemon_home off
printf '{ "peers": [], "assistant": { "autostart": false } }\n' >"$TEST_TMP/off/settings.json"
use off
daemon_up off
sleep 2
[ "$(count)" = 0 ] || fail "autostart off: $(count) assistants, want 0"
# A peer (its settings home is another machine) starts none: the home's assistant is not in its database.
daemon_home peer
printf '{ "peers": [], "home": "elsewhere" }\n' >"$TEST_TMP/peer/settings.json"
use peer
daemon_up peer
sleep 2
[ "$(count)" = 0 ] || fail "peer: $(count) assistants, want 0"
echo "PASS"
