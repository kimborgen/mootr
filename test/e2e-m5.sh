#!/bin/sh
# Milestone 5 lifecycle test on the scripted fake Claude Code (test/fake-claude, no model).
# Covers: worktree workspace with a committed file, restart while idle, restart while working
# (a pending restart, held until the turn ends), pause and unpause, shutdown and resume with
# the conversation intact (the resumed agent recalls a word saved earlier), and archive
# removing the worktree but keeping the branch. Turns hold with `await` steps, released by typing
# into the pane, so no check depends on timing. Runs against its own daemon (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
T=$(date +%s); N="e2e-life-$T"
# The script's word and mail tokens are this run's $T; the quoted heredoc keeps ${word} literal.
cat >"$TEST_TMP/m5.json" <<'EOF2'
{ "turns": [
  { "match": "from memory", "steps": [
    { "mcp": "send_mail", "args": { "to": ["human"], "subject": "memory-TOKEN", "body": "${word}" } },
    { "reply": "done" } ] },
  { "match": "notes.txt", "steps": [
    { "shell": "printf 'ORCHID-TOKEN\\n' > notes.txt && git add notes.txt && git -c user.name=fake -c user.email=fake@example.com commit -qm 'Add notes' && cat notes.txt", "save": { "word": "(ORCHID-[0-9]+)" } },
    { "reply": "done" } ] },
  { "match": "HOLD-SLOW", "steps": [
    { "await": "release-slow" },
    { "mcp": "send_mail", "args": { "to": ["human"], "subject": "slept-TOKEN", "body": "slept" } },
    { "reply": "done" } ] },
  { "match": "(test restart)", "steps": [
    { "await": "release-restart" },
    { "reply": "back" } ] }
] }
EOF2
sed -i "s/TOKEN/$T/g" "$TEST_TMP/m5.json"
fake_claude "$TEST_TMP/m5.json"
isolate
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q && git -C "$REPO" -c user.name=stam-test -c user.email=test@example.invalid commit -q --allow-empty -m init
field() { "$STAM" show "$N" | grep "\"$1\"" | head -1 | sed 's/.*: //; s/[",]//g'; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
# Types a line into the agent's pane, as a human would: the prompt an `await` step takes.
type_into() { tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(field id):" -l "$1"; tmux -L "$STAM_TMUX_SOCKET" send-keys -t "=$(field id):" Enter; }

"$STAM" spawn "$N" --model claude-sonnet-5-5 --cwd "$REPO" --worktree --role "Lifecycle test agent." \
  "Create the file notes.txt containing the word ORCHID-$T, commit it with git, then reply done."
"$STAM" wait "$N" --until idle --timeout 60
WT=$(field cwd); test -f "$WT/notes.txt" || { echo "FAIL: no notes.txt in worktree $WT"; exit 1; }
git -C "$WT" log --oneline -1 | grep -q 'Add notes' || { echo "FAIL: notes.txt not committed"; exit 1; }

echo "-- restart while idle"
"$STAM" restart "$N" "test restart"
"$STAM" wait "$N" --until working --timeout 60
type_into "release-restart"
"$STAM" wait "$N" --until idle --timeout 90

echo "-- restart while working waits for the turn to end"
type_into "HOLD-SLOW-$T"
"$STAM" wait "$N" --until working --timeout 60
"$STAM" restart "$N" "test restart while working" | grep -q "waiting for" || { echo "FAIL: restart didn't wait"; exit 1; }
"$STAM" events "$N" | grep -q '"type":"restart"' || { echo "FAIL: no pending restart recorded"; exit 1; }
type_into "release-slow"
"$STAM" wait "$N" --until idle --timeout 90
human_has "slept-$T" || { echo "FAIL: slow turn didn't finish"; exit 1; }

echo "-- pause and unpause"
"$STAM" pause "$N"; test "$(field lifecycle)" = paused || { echo "FAIL: not paused"; exit 1; }
"$STAM" unpause "$N"; test "$(field lifecycle)" = active || { echo "FAIL: not active"; exit 1; }
"$STAM" wait "$N" --until idle --timeout 90

echo "-- shutdown and resume keep the conversation"
"$STAM" shutdown "$N"; "$STAM" wait "$N" --until shut_down --timeout 10
"$STAM" resume "$N" "Mail human the word you wrote into notes.txt, from memory, without reading any file, with subject 'memory-$T'."
"$STAM" wait "$N" --until idle --timeout 90
human_has "memory-$T" || { echo "FAIL: no reply after resume"; exit 1; }
"$STAM" mail read human | grep -q "ORCHID-$T" || { echo "FAIL: conversation not resumed"; exit 1; }

echo "-- archive removes the worktree"
"$STAM" archive "$N"; "$STAM" wait "$N" --until archived --timeout 10
test ! -d "$WT" || { echo "FAIL: worktree still there"; exit 1; }
git -C "$REPO" branch | grep -q "stam/$N" || { echo "FAIL: branch removed"; exit 1; }

"$STAM" forget "$N" >/dev/null
echo "PASS e2e-m5"
