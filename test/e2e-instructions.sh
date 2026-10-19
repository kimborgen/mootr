#!/bin/sh
# Instructions and skills reach Claude Code, free: a Claude agent runs on the scripted fake
# (test/fake-claude, no model). The fake records the argv the adapter passed in the agent's
# folder (argv.json), so the test checks stam's inputs to Claude Code: the
# --append-system-prompt-file holds instructions.md (the team motto) and the pointer to the
# subfolder's AGENTS.md, and the --plugin-dir holds the stam-test skill. What a model does with
# them is not checked here (instructions-live, SMOKE).
# Runs against its own daemon (test/lib.sh), whose home gets the skill and instructions.md
# before it starts. Nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
echo '{ "turns": [] }' >"$TEST_TMP/instructions.json"
fake_claude "$TEST_TMP/instructions.json"
daemon_home main; use main
T=$(date +%s); WS="$(mktemp -d "$TEST_TMP/ws.XXXX")"; SKILL="$STAM_HOME/skills/stam-test-$T"
MOTTO="MOTTO-$T"; SUB="service-a/AGENTS.md"

mkdir -p "$WS/service-a" "$SKILL"
printf '# Workspace\n\nThe workspace codeword is ROOTWORD-%s.\n' "$T" > "$WS/CLAUDE.md"
printf '# service-a\n\nThe service-a codeword is SUBWORD-%s.\n' "$T" > "$WS/service-a/AGENTS.md"
printf -- '---\nname: stam-test-%s\ndescription: Gives the stam test phrase. Use when asked for the stam test phrase.\n---\n\nThe stam test phrase is SKILLWORD-%s.\n' "$T" "$T" > "$SKILL/SKILL.md"
printf 'Every agent: the team motto is %s.\n' "$MOTTO" > "$STAM_HOME/instructions.md"
daemon_up main; use main

N="ins-$T"
"$STAM" spawn "$N" --harness claude --model claude-haiku-5-5 --cwd "$WS" "Reply with exactly: ready"
"$STAM" wait "$N" --until idle --timeout 60

ARGV=$(find "$STAM_HOME" -name argv.json | head -1)
[ -n "$ARGV" ] || { echo "FAIL: the fake recorded no argv"; exit 1; }
# The value after an option in the recorded argv.
arg() { python3 -I -c 'import json, sys; a = json.load(open(sys.argv[1])); print(a[a.index(sys.argv[2]) + 1])' "$ARGV" "$1"; }

PROMPT=$(arg --append-system-prompt-file)
grep -q "$MOTTO" "$PROMPT" || { echo "FAIL: the system prompt lacks the motto"; exit 1; }
grep -q "$SUB" "$PROMPT" || { echo "FAIL: the system prompt lacks the pointer to $SUB"; exit 1; }

PLUGIN=$(arg --plugin-dir)
[ -f "$PLUGIN/skills/stam-test-$T/SKILL.md" ] || { echo "FAIL: the plugin lacks the stam-test skill"; exit 1; }

echo "PASS e2e-instructions"
