#!/bin/sh
# The away digest's routes (S-2821), free (no models): a scripted Claude Code agent (test/fake-claude) gives a real
# agent token, on its own daemon (test/lib.sh).
#   - all three routes (POST /api/presence, GET /api/digest, POST /api/digest/dismiss) are human-only: the shared
#     token and an agent's token get 403; the human (the test header) is served
#   - the presence after a gap opens an away window (settings.digest.awayMinutes 0 here), GET reads it, dismissal marks it
#   - the window and its dismissal survive a daemon restart
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/digest.json" <<'EOT'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOT
fake_claude "$TEST_TMP/digest.json"
daemon_home main
python3 - "$TEST_TMP" <<'PY'
import json, sys
path = f"{sys.argv[1]}/main/settings.json"
s = json.load(open(path))
s["digest"] = {"awayMinutes": 0}
json.dump(s, open(path, "w"), indent=2)
PY
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $2" -H 'content-type: application/json' "$STAM_URL$3"; }
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"; }
humanCode() { curl -s -o /dev/null -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"; }
"$STAM" spawn amy --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait amy --until idle --timeout 60
AMY=$(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/amy" | jget "d['id']")
AT=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$AMY" STAM_TOKEN | cut -d= -f2-)
[ -n "$AT" ] || fail "amy has no token"

echo "-- the shared token and an agent's token are refused on every digest route"
for r in "POST /api/presence" "GET /api/digest" "POST /api/digest/dismiss"; do
  set -- $r
  [ "$(code "$1" "$TOKEN" "$2")" = 403 ] || fail "the shared token wasn't refused on $1 $2"
  [ "$(code "$1" "$AT" "$2")" = 403 ] || fail "amy's token wasn't refused on $1 $2"
done

echo "-- the human's presence opens an away window after a gap; GET reads it; dismissal marks it"
[ "$(human POST /api/presence | jget "d['window']")" = None ] || fail "the first presence opened a window"
[ "$(human POST /api/presence | jget "d['window'] is not None")" = True ] || fail "a presence after a gap opened no window"
[ "$(human GET /api/digest | jget "d['window'] is not None and d['dismissedAt'] is None")" = True ] || fail "GET /api/digest has no open window"
UNTIL=$(human GET /api/digest | jget "d['window']['until']")
[ "$(humanCode POST /api/digest/dismiss '{}')" = 400 ] || fail "a dismissal without until wasn't refused with 400"
[ "$(human POST /api/digest/dismiss '{"until":"1970-01-01T00:00:00.000Z"}' | jget "d['dismissed']")" = False ] || fail "a stale until dismissed the window"
DISMISSED=$(human POST /api/digest/dismiss "{\"until\":\"$UNTIL\"}" | jget "d['dismissedAt']")
[ -n "$DISMISSED" ] || fail "dismissal returned no dismissedAt"
[ "$(human GET /api/digest | jget "d['dismissedAt']")" = "$DISMISSED" ] || fail "GET doesn't show the dismissal"

echo "-- the window and its dismissal survive a daemon restart"
BEFORE=$(human GET /api/digest | jget "d['window']['until'] + '|' + d['dismissedAt']")
daemon_stop main
daemon_up main
AFTER=$(human GET /api/digest | jget "d['window']['until'] + '|' + d['dismissedAt']")
[ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] || fail "the window or its dismissal changed on restart ($BEFORE vs $AFTER)"
echo "PASS"
