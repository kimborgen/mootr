#!/bin/sh
# Prompts stay off command lines, for all three harnesses. Every process on the machine
# sees command lines (`ps`), and a broad `pkill -f PATTERN` matches them: an agent once
# killed another agent's Claude Code because that agent's first prompt named a path.
# Spawns a Claude Code, an OpenCode, and a Codex agent with a prompt holding a unique
# marker and a role (part of the system prompt) holding another, then resumes and
# restarts each with notes holding more. A remote MCP server's header value is another
# marker (settings.mcpServers): it must reach the server through the app-server's
# environment, never a command line (see codex.ts). A sampler reads `ps -eo args` five
# times a second the whole time; no command line may contain a marker. Each agent still
# acts on its prompt, its system prompt, and both notes.
# Talks to its daemon over HTTP, since the CLI's own arguments would hold the prompt.
# Runs against its own daemon (test/lib.sh). Costs about $0.05.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# A live test: it calls OpenRouter, so it gets the real key (lib.sh).
STAM_TEST_REAL_KEY=1
T=$(date +%s)
daemon_home main; use main
HM="ARGVHEADER$T$$"
# The agents mail the human: this home lets Claude Haiku do it (the defaults keep it from, settings.humanMail.models,
# src/mail.ts humanMailBlock) and skips the mail gate.
printf '{\n  "peers": [],\n  "humanMail": { "when": "necessary", "models": { "claude-haiku-5-5": true } },\n  "decisions": { "mailGate": false },\n  "mcpServers": { "argv-mcp": { "url": "http://127.0.0.1:9/mcp", "headers": { "Authorization": "Bearer %s" } } }\n}\n' "$HM" >"$STAM_HOME/settings.json"
daemon_up main
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
fail() { echo "FAIL: $1"; "$STAM" ls; exit 1; }
[ -f "$STAM_HOME/opencode.env" ] || fail "no OpenRouter key for OpenCode (OPENROUTER_API_KEY in the repo's .env)"

# Markers: unique to this run, so nothing else on the machine has them on its command line.
PM="ARGVPROMPT$T$$"; RM="ARGVROLE$T$$"; NM="ARGVNOTE$T$$"; SM="ARGVRESTART$T$$"
PAT="$TEST_TMP/argv-patterns"; HITS="$TEST_TMP/argv-hits"; SNAP="$TEST_TMP/argv-ps"
# grep reads the patterns from a file, so its own command line holds none of them.
# The role marker stands for the system prompt, which holds the role: generic text from
# the template could match agents of the live system started before this fix.
printf '%s\n' "$PM" "$RM" "$NM" "$SM" "$HM" >"$PAT"
: >"$HITS"
(while [ -f "$PAT" ]; do
  ps -eo pid,args >"$SNAP" 2>/dev/null && grep -F -f "$PAT" "$SNAP" >>"$HITS" || true
  sleep 0.2
done) &
SAMPLER=$!
trap 'rm -f "$PAT"; kill $SAMPLER 2>/dev/null || true; stam_test_cleanup' EXIT

printf 'authorization: Bearer %s\n' "$(cat "$STAM_HOME/token")" >"$TEST_TMP/auth"
# POST PATH JSON: the JSON goes in a file, so curl's command line holds only its name.
post() {
  printf '%s' "$2" >"$TEST_TMP/body.json"
  curl -sf -X POST -H @"$TEST_TMP/auth" -H 'content-type: application/json' --data-binary @"$TEST_TMP/body.json" "$STAM_URL$1" >/dev/null || fail "POST $1"
}
INBOX="$TEST_TMP/inbox"
# Waits for a mail to the human whose subject is $1 (compared in the shell, not on grep's command line).
wait_subject() {
  for i in $(seq 1 60); do
    "$STAM" mail inbox human >"$INBOX"
    case "$(cat "$INBOX")" in *"$1"*) return 0 ;; esac
    sleep 3
  done
  fail "no mail to the human with subject $2"
}
only_mail="Use only the stam send_mail tool, no other tool."

A_claude="argv-claude-$T"; A_opencode="argv-opencode-$T"; A_codex="argv-codex-$T"
M_claude="claude-haiku-5-5"; M_opencode="openrouter/~deepseek/deepseek-v4-flash-latest"; M_codex="gpt-6-luna"
H="claude opencode codex"
name() { eval echo "\$A_$1"; }

echo "-- spawn with a prompt"
for h in $H; do
  eval m="\$M_$h"
  effort=""; [ "$h" = codex ] && effort=',"effort":"low"'
  post /api/agents "{\"name\":\"$(name "$h")\",\"harness\":\"$h\",\"model\":\"$m\"$effort,\"cwd\":\"$DIR\",\"role\":\"Test agent $RM-$h\",\"prompt\":\"Mail human with subject '$PM-$h'. As the body, write your stam role exactly as your instructions state it, and nothing else. $only_mail\"}"
done
for h in $H; do wait_subject "$PM-$h" "prompt ($h)"; done
"$STAM" mail read human >"$TEST_TMP/bodies"
for h in $H; do
  case "$(cat "$TEST_TMP/bodies")" in *"$RM-$h"*) ;; *) fail "$h didn't state its role: no system prompt" ;; esac
done
echo "all three acted on their prompt and system prompt"

echo "-- resume with a note"
for h in $H; do "$STAM" wait "$(name "$h")" --until idle --timeout 120; done
for h in $H; do post "/api/agents/$(name "$h")/shutdown" '{"now":true}'; done
for h in $H; do "$STAM" wait "$(name "$h")" --until shut_down --timeout 20; done
for h in $H; do post "/api/agents/$(name "$h")/resume" "{\"note\":\"Mail human with subject '$NM-$h' and the body ok. $only_mail\"}"; done
for h in $H; do wait_subject "$NM-$h" "resume note ($h)"; done
echo "all three acted on their resume note"

echo "-- restart with a reason"
for h in $H; do "$STAM" wait "$(name "$h")" --until idle --timeout 120; done
for h in $H; do post "/api/agents/$(name "$h")/restart" "{\"reason\":\"test: mail human with subject '$SM-$h' and the body ok, using only the stam send_mail tool\"}"; done
for h in $H; do wait_subject "$SM-$h" "restart note ($h)"; done
echo "all three acted on their restart note"

rm -f "$PAT"
sleep 0.5
if [ -s "$HITS" ]; then
  echo "command lines holding a prompt or the system prompt:"
  sort -u "$HITS" | cut -c1-300
  fail "prompts on command lines"
fi
echo "no command line held a prompt or the system prompt"
echo "PASS e2e-argv"
