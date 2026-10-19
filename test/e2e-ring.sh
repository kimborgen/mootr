#!/bin/sh
# Ring test, free: rounds and fire rings whose members and moderator run on the scripted fake
# (test/fake-claude, no model). Checks: a rounds ring that ends by agreement (both members agree
# in round 2), a rounds ring that ends after its 2 rounds without agreement, and a fire ring
# whose moderator decides. The members and the moderator answer from the script with ring_submit
# and ring_decide; the ring id comes from the "(ring: ID)" line of each ring prompt.
# Runs against its own daemon (test/lib.sh). Nothing waits on a timer: the checks poll state.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
T=$(date +%s); AGREE="ring-agree-$T"; LIMIT="ring-limit-$T"; FIRE="ring-fire-$T"; MOD="mod-$T"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
# Each turn matches the ring prompt of one ring and round; the regex groups are the ring id.
sed "s/@T@/$T/g" >"$TEST_TMP/ring.json" <<'EOF2'
{ "turns": [
  { "match": "/Ring .ring-agree-@T@. [(]rounds[)], round 1 of at most 2[.].*[(]ring: ([^)]+)[)]/s", "steps": [
    { "mcp": "ring_submit", "expect": "Submitted", "args": { "ring": "${1}", "text": "Name it Swarmyard.", "agree": false } },
    { "reply": "Submitted." } ] },
  { "match": "/Ring .ring-agree-@T@. [(]rounds[)], round 2 of at most 2[.].*[(]ring: ([^)]+)[)]/s", "steps": [
    { "mcp": "ring_submit", "expect": "Submitted", "args": { "ring": "${1}", "text": "Swarmyard, agreed.", "agree": true } },
    { "reply": "Submitted." } ] },
  { "match": "/Ring .ring-limit-@T@. .*[(]ring: ([^)]+)[)]/s", "steps": [
    { "mcp": "ring_submit", "expect": "Submitted", "args": { "ring": "${1}", "text": "I still disagree.", "agree": false } },
    { "reply": "Submitted." } ] },
  { "match": "/Ring .ring-fire-@T@. [(]fire[)].*[(]ring: ([^)]+)[)]/s", "steps": [
    { "mcp": "ring_submit", "expect": "Submitted", "args": { "ring": "${1}", "text": "Write it in TypeScript.", "agree": false } },
    { "reply": "Submitted." } ] },
  { "match": "/You moderate ring .ring-fire-@T@..*[(]ring: ([^)]+)[)]/s", "steps": [
    { "mcp": "ring_decide", "expect": "ended", "args": { "ring": "${1}", "continue": false, "text": "Decision: TypeScript." } },
    { "reply": "Decided." } ] }
] }
EOF2
fake_claude "$TEST_TMP/ring.json"
isolate

ring_done() { "$STAM" ring "$1" | grep -q '"status": "done"'; }
human_has() { "$STAM" mail inbox human | grep -q "$1"; }
# `mail read` returns only unread mail, so each check keeps its read in MAIL.
# Bounded: each try is a state check, so a finished ring is seen as soon as it is.
poll() { n=$1; shift; while [ "$n" -gt 0 ]; do "$@" && return 0; n=$((n - 1)); done; return 1; }
fail() { echo "FAIL: $1"; "$STAM" ring "$2" || true; exit 1; }

# Rounds, ends by agreement in round 2.
"$STAM" ring "$AGREE" --format rounds --spawn fast,fast --rounds 2 --cwd "$DIR" \
  "Name one short, memorable name for a tool that runs many coding agents at once."
poll 400 ring_done "$AGREE" || fail "ring $AGREE not done" "$AGREE"
poll 100 human_has "Ring $AGREE ended" || fail "no mail for $AGREE" "$AGREE"
MAIL=$("$STAM" mail read human)
echo "$MAIL" | grep -q "after round 2: all members agreed" || fail "$AGREE did not end by agreement in round 2" "$AGREE"

# Rounds, no agreement: ends after its 2 rounds.
"$STAM" ring "$LIMIT" --format rounds --spawn fast,fast --rounds 2 --cwd "$DIR" \
  "Pick a language for the orchestrator. Agree only once you are both sure."
poll 400 ring_done "$LIMIT" || fail "ring $LIMIT not done" "$LIMIT"
poll 100 human_has "Ring $LIMIT ended" || fail "no mail for $LIMIT" "$LIMIT"
MAIL=$("$STAM" mail read human)
echo "$MAIL" | grep -q "after round 2: the last round ended" || fail "$LIMIT did not end after 2 rounds" "$LIMIT"

# Fire with a moderator who decides.
"$STAM" spawn "$MOD" --preset fast --cwd "$DIR" --role "Ring moderator."
"$STAM" wait "$MOD" --until idle --timeout 60
"$STAM" ring "$FIRE" --format fire --spawn fast,fast --moderator "$MOD" --decide --rounds 2 --cwd "$DIR" \
  "Should a small team write its agent orchestrator in TypeScript or Python? One short paragraph each."
poll 400 ring_done "$FIRE" || fail "ring $FIRE not done" "$FIRE"
poll 100 human_has "Ring $FIRE ended" || fail "no mail for $FIRE" "$FIRE"
MAIL=$("$STAM" mail read human)
echo "$MAIL" | grep -q "Moderator's decision" || fail "no moderator decision" "$FIRE"
echo "$MAIL" | grep -q "Decision: TypeScript." || fail "decision text not mailed" "$FIRE"

echo "PASS e2e-ring"
