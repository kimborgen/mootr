#!/bin/sh
# Resource warnings, free (no model): a throwaway daemon reads a fixed /proc (STAM_PROC_DIR)
# where the load is 9 on 2 cores, so the 5-minute load is across its line of 2 per core. The chief
# of staff gets one mail for it, and no second one on the next samples, since the repeat is 30 minutes.
# A restart of the daemon keeps that repeat too: the last mail time is in settings, not in memory.
# Then no agent is active (the chief of staff is archived), the load recovers and crosses again
# inside those 30 minutes, and no second mail goes out: a kind that mailed stays quiet for the
# repeat interval even through a recovery.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
PROC_DIR="$TEST_TMP/proc"
mkdir -p "$PROC_DIR"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n' >"$PROC_DIR/stat"
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       2000000 kB\n' >"$PROC_DIR/meminfo"
printf '9.00 8.00 7.00 1/200 1234\n' >"$PROC_DIR/loadavg"

daemon_home main
printf '{ "peers": [], "chiefOfStaff": "cos" }\n' >"$TEST_TMP/main/settings.json"
printf '{ "turns": [] }\n' >"$TEST_TMP/warn.json"
fake_claude "$TEST_TMP/warn.json"
use main
export STAM_PROC_DIR="$PROC_DIR"
daemon_up main

"$STAM" spawn cos --cwd "$TEST_TMP" "Stand by."
"$STAM" wait cos --until idle --timeout 60

wait_until sh -c "\"$STAM\" mail inbox cos | grep -q 'Resource warning on main: CPU load'" || fail "the chief of staff got no CPU warning: $("$STAM" mail inbox cos)"
[ "$("$STAM" mail inbox cos | grep -c 'Resource warning')" = 1 ] || fail "the warning mailed more than once"
# It comes from the system sender, never from an agent that stands in (S-1145).
"$STAM" mail inbox cos | grep 'Resource warning' | grep -q ' system:resources ' || fail "the warning is not from system:resources: $("$STAM" mail inbox cos)"

# No running agent: archive the chief of staff, let the load recover, and cross again.
"$STAM" archive cos >/dev/null
TOKEN=$(cat "$STAM_HOME/token")
cat >"$TEST_TMP/load0.py" <<'EOF'
import json, sys
d = json.load(sys.stdin)[0]
sys.exit(0 if d['load'][0] < float(sys.argv[1]) else 1)
EOF
sampled() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL/api/machines" | python3 "$TEST_TMP/load0.py" "$1"; }
crossed() { ! sampled 1; }
printf '0.10 0.10 0.10 1/200 1234\n' >"$PROC_DIR/loadavg"
wait_until sampled 1 || fail "the low load never sampled"
printf '9.00 8.00 7.00 1/200 1234\n' >"$PROC_DIR/loadavg"
# The sampler judges a sample in the same tick that publishes it, so once the high load shows, its
# decision has run. The kind is inside its repeat interval, so the mail count must not move.
wait_until crossed || fail "the crossing never sampled"
[ "$("$STAM" mail inbox cos | grep -c 'Resource warning')" = 1 ] || fail "a recovered kind mailed again inside the repeat interval: $("$STAM" mail inbox cos)"
# A daemon restart keeps the repeat (S-196): the new daemon judges the high load in its first tick,
# inside the interval since the last mail, and mails nothing.
daemon_stop main
daemon_up main
wait_until crossed || fail "the restarted daemon never sampled the high load"
[ "$("$STAM" mail inbox cos | grep -c 'Resource warning')" = 1 ] || fail "a restart mailed a kind inside its repeat interval: $("$STAM" mail inbox cos)"
echo "PASS e2e-resource-warn"
