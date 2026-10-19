#!/bin/sh
# Cross-machine test: two isolated daemons on this machine play two computers ("main"
# and "twin", each with its own home, port, and tmux socket; see test/lib.sh). Checks the
# merged agent list, spawning on the other machine, mail both ways, the merged human
# inbox, and the relayed terminal. The agents are Claude Code on the scripted fake
# (test/fake-claude): no model, no network, free.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/peers.json" <<'EOF'
{ "turns": [
  { "match": "from the human: ask", "steps": [
    { "mcp": "read_mail", "save": { "b": "Ask the agent (\\S+) by mail" }, "expect": "by mail" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["${b}"], "subject": "color question", "body": "What is the team's favorite color? Question from ${self}." } },
    { "reply": "Asked." } ] },
  { "match": "color question", "steps": [
    { "mcp": "read_mail", "save": { "asker": "Question from ([a-z0-9]+)" }, "expect": "favorite color" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["${asker}"], "subject": "color answer", "body": "The team's favorite color is TEAL." } },
    { "reply": "Answered." } ] },
  { "match": "color answer", "steps": [
    { "mcp": "read_mail", "expect": "TEAL" },
    { "mcp": "send_mail", "expect": "Sent", "args": { "to": ["human"], "subject": "color", "new_thread": true, "body": "${result}" } },
    { "reply": "Mailed the human." } ] }
] }
EOF
# Before both daemons start, so each inherits the fake.
fake_claude "$TEST_TMP/peers.json"
daemon_home main
daemon_home twin
use main
T=$(date +%s); A="peer-a-$T"; B="peer-b-$T"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
twin() { on twin "$STAM" "$@"; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }

# Each daemon lists the other as a peer, with the other's token.
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [{"name": other, "url": env(other)["STAM_URL"], "token": open(f"{tmp}/{other}/token").read().strip()}]
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up twin

"$STAM" spawn "$B" --machine twin --model claude-haiku-5-5 --cwd "$DIR" --role "Knows that the team's favorite color is TEAL."
"$STAM" spawn "$A" --model claude-sonnet-5-5 --cwd "$DIR" --role "Test agent on the main machine."
"$STAM" ls | grep "$B" | grep -q twin || { echo "FAIL: twin agent missing from merged list"; exit 1; }
"$STAM" wait "$B" --until idle --timeout 60; "$STAM" wait "$A" --until idle --timeout 60

"$STAM" mail send --to "$A" --subject "ask" "Ask the agent $B by mail what the team's favorite color is. When it answers, mail the color to human with subject 'color'."
# The answer reaches the human inbox across the two daemons; bounded check of that state.
for i in $(seq 1 60); do human_has "color" && break; sleep 0.5; done
human_has "color" || { echo "FAIL: no cross-machine answer"; exit 1; }
"$STAM" mail read human | grep -q "TEAL" || { echo "FAIL: no cross-machine answer"; exit 1; }
"$STAM" wait "$A" --until idle --timeout 60 >/dev/null
twin mail inbox "$B" | grep -q . || { echo "FAIL: twin agent got no mail"; exit 1; }

node "$ROOT/test/web-tty.mjs" "$("$STAM" show "$B" | grep '"id"' | head -1 | cut -d'"' -f4)" --output-only | grep -q PASS || { echo "FAIL: relayed terminal"; exit 1; }
# The human's default view of the twin's agent (S-82) stays on the daemon the web talks to,
# which lists it with the twin's agents; the twin keeps none.
BID=$("$STAM" show "$B" | grep '"id"' | head -1 | cut -d'"' -f4)
curl -sf -X PUT -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"view":"conversation"}' "$STAM_URL/api/agents/$BID/default-view" >/dev/null || { echo "FAIL: setting a peer agent's default view"; exit 1; }
curl -sf -H "authorization: Bearer $(cat "$STAM_HOME/token")" "$STAM_URL/api/agents" | python3 -c "import json,sys; a=[x for x in json.load(sys.stdin) if x['id']=='$BID']; sys.exit(0 if a and a[0].get('default_view')=='conversation' else 1)" || { echo "FAIL: a peer agent's default view didn't stay on this daemon"; exit 1; }
echo "PASS e2e-peers"
