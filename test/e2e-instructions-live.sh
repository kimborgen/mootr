#!/bin/sh
# Instructions and skills across harnesses, live (SMOKE): a real model reads them. Claude Code
# (Haiku) and OpenCode (DeepSeek). The deterministic check of what stam hands Claude Code is
# test/e2e-instructions.sh (free). A workspace with CLAUDE.md at the top and AGENTS.md in a subfolder:
# OpenCode must be told to read the CLAUDE.md, Claude Code the subfolder's AGENTS.md.
# A stam-only skill must reach both harnesses, and instructions.md every agent.
# Runs against its own daemon (test/lib.sh), whose home gets the skill and
# instructions.md before it starts. Costs about $0.05.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Calls OpenRouter with a real model (lib.sh): the live test gets the real key.
STAM_TEST_REAL_KEY=1
daemon_home main; use main
T=$(date +%s); WS="$(mktemp -d "$TEST_TMP/ws.XXXX")"; SKILL="$STAM_HOME/skills/stam-test-$T"
OC="${OC_MODEL:-openrouter/~deepseek/deepseek-v4-flash-latest}"

mkdir -p "$WS/service-a" "$SKILL"
printf '# Workspace\n\nThe workspace codeword is ROOTWORD-%s.\n' "$T" > "$WS/CLAUDE.md"
printf '# service-a\n\nThe service-a codeword is SUBWORD-%s.\n' "$T" > "$WS/service-a/AGENTS.md"
printf -- '---\nname: stam-test-%s\ndescription: Gives the stam test phrase. Use when asked for the stam test phrase.\n---\n\nThe stam test phrase is SKILLWORD-%s.\n' "$T" "$T" > "$SKILL/SKILL.md"
printf 'Every agent: the team motto is MOTTO-%s.\n' "$T" > "$STAM_HOME/instructions.md"
# The Claude Code agent runs the `fast` preset (Haiku), which may not mail the human by default
# (settings.humanMail.models, src/mail.ts humanMailBlock); this home lets it, and skips the mail gate.
printf '{ "peers": [], "humanMail": { "when": "necessary", "models": { "claude-haiku-5-5": true } }, "decisions": { "mailGate": false } }\n' >"$STAM_HOME/settings.json"
daemon_up main  # writes OpenCode's config, which links the new skill

ASK="Answer from your instructions and skills, reading files where they point you: what are (1) the workspace codeword, (2) the service-a codeword, (3) the stam test phrase, and (4) the team motto? Mail all four to human with subject"
"$STAM" spawn "ins-cc-$T" --preset fast --cwd "$WS" "$ASK answers-cc-$T."
"$STAM" spawn "ins-oc-$T" --harness opencode --model "$OC" --cwd "$WS" "$ASK answers-oc-$T."
for i in $(seq 1 60); do
  n=$("$STAM" mail inbox human | grep -c "answers-[co][co]-$T" || true)
  [ "$n" -ge 2 ] && break
  "$STAM" wait "ins-cc-$T" --until never --timeout 3 >/dev/null 2>&1 || true
done
OUT=$("$STAM" mail read human)
fail=0
for h in cc oc; do
  BODY=$(echo "$OUT" | awk "/answers-$h-$T/{f=1} f&&/^## /&&!/answers-$h-$T/{f=0} f")
  for w in ROOTWORD SUBWORD SKILLWORD MOTTO; do echo "$BODY" | grep -q "$w-$T" || { echo "FAIL: $h missed $w"; fail=1; }; done
done
[ $fail = 0 ] && echo "PASS e2e-instructions"
exit $fail
