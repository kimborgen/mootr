#!/bin/sh
# OpenCode asks (S-3980), free: a permission.asked on an OpenCode agent's session is an ask, answered through the
# server's permission reply endpoint; a reply made in the TUI closes it. The OpenCode server is the fake
# (test/fake-opencode), which lists the permission and tells of it on its stream. Its metadata holds a fake key that
# no request, mail or event may keep. Runs on either daemon (STAM_DAEMON=go for the Go one, S-4237).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"
isolate
SHARED=$(cat "$STAM_HOME/token")
OC="e2e-oc-ask-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$OC" --harness opencode --model openrouter/~deepseek/deepseek-v4-flash-latest --cwd "$DIR" "Say hello."
"$STAM" wait "$OC" --until idle --timeout 60

api() {
  curl -s -X "$1" -H "authorization: Bearer $SHARED" ${3:+-H x-stam-human:1} -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$2"
}
fake() { curl -s -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/$1"; }
SID=$(api GET /api/agents | python3 -c 'import json, sys; print(next(a["session_id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$OC")
[ -n "$SID" ] || { echo "FAIL: $OC has no session"; exit 1; }
LEAK=sk-or-v1-e2e-fake-leak

# pending PERMISSION: the id of the pending request whose details name the permission, "" for none.
pending() {
  api GET '/api/permissions?status=pending' | python3 -c '
import json, sys
print(next((r["id"] for r in json.load(sys.stdin) if json.loads(r.get("details") or "{}").get("permission") == sys.argv[1]), ""))' "$1"
}
status_of() { api GET /api/permissions | python3 -c 'import json, sys; print(next((r["status"] for r in json.load(sys.stdin) if r["id"] == sys.argv[1]), ""))' "$1"; }
await() {
  _i=0
  until eval "$2"; do
    _i=$((_i + 1))
    [ $_i -lt 150 ] || { echo "FAIL: timed out waiting for $1"; exit 1; }
    sleep 0.2
  done
}

ask() { fake ask '{"session":"'"$SID"'","id":"'"$1"'","action":"shell","resources":["make test"],"metadata":{"key":"'$LEAK'"}}' >/dev/null; }

echo "-- the ask is raised once, with its permission and session, and the human's yes is sent as once"
ask per_e2e_yes
await "the ask" '[ -n "$(pending per_e2e_yes)" ]'
ask per_e2e_yes
REQ=$(pending per_e2e_yes)
DETAILS=$(api GET /api/permissions | python3 -c 'import json, sys; print(next(r["details"] for r in json.load(sys.stdin) if r["id"] == sys.argv[1]))' "$REQ")
[ "$DETAILS" = '{"tool":"shell","input":{"command":"make test"},"action":"shell","permission":"per_e2e_yes","session":"'"$SID"'"}' ] || { echo "FAIL: details $DETAILS"; exit 1; }
OUT=$(api POST "/api/permissions/$REQ/answer" human '{"approve":true}')
echo "$OUT" | grep -q '"status":"approved"' || { echo "FAIL: the human's yes: $OUT"; exit 1; }
REPLIES=$(curl -s "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/replies")
[ "$REPLIES" = '{"data":[{"session":"'"$SID"'","permission":"per_e2e_yes","decision":"once"}]}' ] || { echo "FAIL: replies $REPLIES"; exit 1; }
[ "$(api GET /api/permissions | python3 -c 'import json, sys; print(sum(1 for r in json.load(sys.stdin) if "per_e2e_yes" in (r.get("details") or "")))')" = 1 ] || { echo "FAIL: the duplicate event made a second request"; exit 1; }

echo "-- a reply made in the TUI closes the ask"
ask per_e2e_tui
await "the second ask" '[ -n "$(pending per_e2e_tui)" ]'
REQ2=$(pending per_e2e_tui)
fake replied '{"session":"'"$SID"'","id":"per_e2e_tui"}' >/dev/null
await "the ask closed" '[ "$(status_of "$REQ2")" = withdrawn ]'

echo "-- the human's yes to a permission replied meanwhile is gone, and nothing is sent"
ask per_e2e_late
await "the third ask" '[ -n "$(pending per_e2e_late)" ]'
REQ3=$(pending per_e2e_late)
# Replied without telling the stream: the listing no longer has it.
fake drop '{"session":"'"$SID"'","id":"per_e2e_late"}' >/dev/null
OUT=$(api POST "/api/permissions/$REQ3/answer" human '{"approve":true}')
echo "$OUT" | grep -q "no longer shows this dialog" || { echo "FAIL: the late answer: $OUT"; exit 1; }
[ "$(status_of "$REQ3")" = withdrawn ] || { echo "FAIL: the late answer left $(status_of "$REQ3")"; exit 1; }
REPLIES=$(curl -s "http://127.0.0.1:$STAM_OPENCODE_PORT/__fake/replies")
[ "$REPLIES" = '{"data":[{"session":"'"$SID"'","permission":"per_e2e_yes","decision":"once"}]}' ] || { echo "FAIL: replies $REPLIES"; exit 1; }

echo "-- the event's metadata and the server's password reached nothing stam keeps"
if grep -rqa -e "$LEAK" "$STAM_HOME"/stam.db*; then echo "FAIL: the fake key reached the database"; exit 1; fi
PW=$(cat "$STAM_HOME/opencode-password")
[ -n "$PW" ] || { echo "FAIL: no OpenCode password"; exit 1; }
if grep -rqa -e "$PW" "$STAM_HOME"/stam.db* "$STAM_HOME"/*.log 2>/dev/null; then echo "FAIL: the server's password reached the database or a log"; exit 1; fi
echo PASS
