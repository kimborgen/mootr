#!/bin/sh
# ITSA join rollback, free (S-2441): a spawn whose launch fails after it joined the new agent to ITSAs (`participate`)
# undoes those rows, and a row that was there before the spawn stays. The fake Claude Code stands in for the harness;
# the launch failure comes from the test-only launch-fail hook. Checks:
#   - a failed spawn with participate is refused, and the agent holds no row on either ITSA
#   - a participant added before the spawn stays, and so does the owner
#   - a spawn of the same ITSAs that launches keeps its row
set -e

STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
fake_claude ""
daemon_home main
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# participants KEY: the agent ids on an ITSA, one per line.
participants() { human GET "/api/itsas/$1" | jget "'\n'.join(d['participants'])"; }
# agent NAME: the id of an agent by name.
agent() { human GET "/api/agents/$1" | jget "d['id']"; }
D="$(mktemp -d "$TEST_TMP/work.XXXX")"

human POST /api/register '{"name":"lead","role":"test","harness":"claude"}' >/dev/null
human POST /api/register '{"name":"pre","role":"test","harness":"claude"}' >/dev/null
X=$(human POST /api/itsas '{"title":"Joined one","owner":"lead","status":"in_progress"}' | jget "d['key']")
Y=$(human POST /api/itsas '{"title":"Joined two","owner":"lead","status":"in_progress"}' | jget "d['key']")
PRE=$(agent pre)
LEAD=$(agent lead)
human PATCH "/api/itsas/$X" "{\"participants\":[\"$PRE\",\"$LEAD\"]}" >/dev/null

echo "-- a spawn whose launch fails after its joins is refused, and leaves no row"
human POST /api/test/launch-fail '{"names":["jr-1"]}' >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$STAM_URL/api/agents" -d "{\"name\":\"jr-1\",\"harness\":\"claude\",\"role\":\"test\",\"cwd\":\"$D\",\"participate\":[\"$X\",\"$Y\"]}")
[ "$CODE" -ge 400 ] || fail "a spawn with a failing launch returned $CODE"
J1=$(agent jr-1)
# The undo runs after the refusal, so the rows are polled, not read at once.
absent() { ! participants "$1" | grep -qx "$2"; }
for K in "$X" "$Y"; do wait_until absent "$K" "$J1"; done
participants "$X" | grep -qx "$PRE" || fail "a participant added before the spawn was removed"
participants "$X" | grep -qx "$LEAD" || fail "the owner's row on $X was removed"

echo "-- a spawn of the same ITSAs that launches keeps its row"
human POST /api/test/launch-fail '{"names":[]}' >/dev/null
human POST /api/agents "{\"name\":\"jr-2\",\"harness\":\"claude\",\"role\":\"test\",\"cwd\":\"$D\",\"participate\":[\"$X\"]}" >/dev/null
J2=$(agent jr-2)
participants "$X" | grep -qx "$J2" || fail "a spawn that launched lost its row on $X"
participants "$X" | grep -qx "$PRE" || fail "the pre-existing participant went after the second spawn"
echo "PASS: itsa rollback"
