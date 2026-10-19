#!/bin/sh
# `stam spawn` with no NAME, or with --help/-h, prints the spawn usage and spawns nothing (S-189).
# A bare NAME still spawns. Runs against its own throwaway daemon (test/lib.sh). Costs nothing.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
fail() { echo "FAIL: $1"; exit 1; }
# The agent list as stam ls prints it: a spawn would add a row.
agents() { "$STAM" ls; }
BASE=$(agents)

# No arguments: usage on stderr, exit 1, no agent.
out=$("$STAM" spawn 2>&1) && fail "stam spawn with no NAME exited 0"
echo "$out" | grep -q "stam spawn NAME" || fail "no usage for stam spawn: $out"
[ "$(agents)" = "$BASE" ] || fail "stam spawn with no NAME made an agent"

# Options but no NAME: same.
"$STAM" spawn --role "x" >/dev/null 2>&1 && fail "stam spawn --role without NAME exited 0"
[ "$(agents)" = "$BASE" ] || fail "stam spawn --role without NAME made an agent"

# --help and -h: usage on stdout, exit 0, no agent.
for flag in --help -h; do
  out=$("$STAM" spawn "$flag") || fail "stam spawn $flag exited non-zero"
  echo "$out" | grep -q "stam spawn NAME" || fail "no usage for stam spawn $flag: $out"
done
[ "$(agents)" = "$BASE" ] || fail "stam spawn --help made an agent"

echo "PASS e2e-spawn-usage"
