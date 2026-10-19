#!/bin/sh
# S-894: a spawn's `--workspace` and `--standing` options end to end, free: a scripted Claude Code
# agent (test/fake-claude, no model) gets a personal workspace folder under STAM_HOME/workspaces,
# the path and `standing` are stored and shown, archive keeps the folder and its files, and a later
# spawn with `--workspace=NAME` adopts an archived specialist's folder. Runs against its own daemon
# (test/lib.sh).
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/ws.json" <<'EOF2'
{ "default": { "steps": [ { "reply": "DONE" } ] } }
EOF2
fake_claude "$TEST_TMP/ws.json"
isolate
fail() { echo "FAIL: $1"; exit 1; }
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"

echo "== --workspace makes STAM_HOME/workspaces/NAME 0700; --standing is stored"
NAME="e2e-ws-$(date +%s)"
"$STAM" spawn "$NAME" --model claude-haiku-5-5 --workspace --standing --cwd "$DIR" "Note your workspace."
"$STAM" wait "$NAME" --until idle --timeout 60
FOLDER="$STAM_HOME/workspaces/$NAME"
[ -d "$FOLDER" ] || fail "no workspace folder $FOLDER"
[ "$(stat -c %a "$FOLDER")" = 700 ] || fail "workspace folder mode is $(stat -c %a "$FOLDER"), want 700"
SHOW=$("$STAM" show "$NAME")
echo "$SHOW" | grep -q '"standing": 1' || fail "standing is not stored: $SHOW"
echo "$SHOW" | grep -qF "\"personal_workspace\": \"$FOLDER\"" || fail "personal_workspace is not stored: $SHOW"

echo "== archive keeps the folder and everything in it"
printf '# learnings\n' >"$FOLDER/notes.md"
mkdir "$FOLDER/diagrams"
printf 'a flow\n' >"$FOLDER/diagrams/flow.md"
"$STAM" archive "$NAME"
"$STAM" wait "$NAME" --until archived --timeout 30
[ -d "$FOLDER" ] || fail "archive removed the workspace folder"
[ "$(cat "$FOLDER/notes.md")" = "# learnings" ] || fail "archive removed or changed notes.md"
[ "$(cat "$FOLDER/diagrams/flow.md")" = "a flow" ] || fail "archive removed or changed diagrams/flow.md"

echo "== --workspace=NAME adopts the archived folder, keeping its files"
NAME2="e2e-ws2-$(date +%s)"
"$STAM" spawn "$NAME2" --model claude-haiku-5-5 --workspace="$NAME" --cwd "$DIR" "Adopt the workspace."
"$STAM" wait "$NAME2" --until idle --timeout 60
"$STAM" show "$NAME2" | grep -qF "\"personal_workspace\": \"$FOLDER\"" || fail "the string workspace was not adopted"
[ "$(cat "$FOLDER/notes.md")" = "# learnings" ] || fail "the adopted workspace lost notes.md"

echo "== a second live holder of the same workspace is refused (409)"
if "$STAM" spawn "e2e-ws3-$(date +%s)" --model claude-haiku-5-5 --workspace="$NAME" --cwd "$DIR" "Share it." 2>/dev/null; then
  fail "a spawn took a workspace a live agent holds"
fi

echo "PASS e2e-personal-workspace"
