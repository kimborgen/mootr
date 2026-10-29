#!/bin/sh
# The comms stats route (S-3826), free (no models): a scripted Claude Code agent (test/fake-claude) gives a real
# agent token, on its own daemon (test/lib.sh).
#   - GET /api/stats/comms refuses an agent's token (403); the shared token is served, as for the other views of what
#     waits on the human. A chief of staff's or the assistant's token is an agent token and takes the same check.
#   - the CLI is served counts, days is clamped to 1-30, and a marker in a mail's subject and body never appears
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/cs.json" <<'EOT'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOT
fake_claude "$TEST_TMP/cs.json"
daemon_home main
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $1" "$STAM_URL$2"; }
"$STAM" spawn amy --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
"$STAM" wait amy --until idle --timeout 60
AMY=$(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/amy" | jget "d['id']")
AT=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$AMY" STAM_TOKEN | cut -d= -f2-)
[ -n "$AT" ] || fail "amy has no token"

echo "-- an agent's token is refused; the shared token is served (the CLI uses it)"
[ "$(code "$AT" /api/stats/comms)" = 403 ] || fail "amy's token wasn't refused"
[ "$(code "$TOKEN" /api/stats/comms)" = 200 ] || fail "the shared token wasn't served"

echo "-- days is clamped, a delivery is counted, and no mail text appears"
"$STAM" mail send --to amy --subject "subject ZXQ-SECRET-MARKER" "body ZXQ-SECRET-MARKER" >/dev/null || fail "the mail wasn't sent"
OUT=$("$STAM" stats comms --json --days 999)
[ "$(echo "$OUT" | jget "d['days']")" = 30 ] || fail "days wasn't clamped to 30"
[ "$("$STAM" stats comms --json --days 0 | jget "d['days']")" = 1 ] || fail "days wasn't clamped to 1"
[ "$(echo "$OUT" | jget "sum(x['total'] for x in d['deliveries'] if x['id'] == '$AMY')")" -ge 1 ] || fail "amy has no delivery counted"
case "$OUT" in *ZXQ-SECRET-MARKER*) fail "a marker string leaked" ;; esac
"$STAM" itsa new "comms stats ITSA" --status needs_input >/dev/null || fail "the ITSA wasn't created"
TABLE=$("$STAM" stats comms) || fail "the table form failed"
case "$TABLE" in *"Comms stats, last 7 days"*"IN STATUS MIN"*) ;; *) fail "the table form lacks its title or the IN STATUS MIN column: $TABLE" ;; esac
case "$TABLE" in *amy*) ;; *) fail "the table form lacks amy's delivery row" ;; esac
case "$TABLE" in *"Waits on the human closed"*"Decisions:"*"Escalations to the human"*) ;; *) fail "the table form lacks the answer-time lines: $TABLE" ;; esac
[ "$(echo "$OUT" | jget "d['answers']['decisions']['answered']")" = 0 ] || fail "the stats lack answers.decisions"
case "$TABLE" in *ZXQ-SECRET-MARKER*) fail "a marker string leaked into the table" ;; esac
echo "PASS"
