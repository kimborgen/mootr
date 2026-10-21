#!/bin/sh
# One live call to the decision model (settings.decisions.model, microsoft/microsoft-decision-1 through
# OpenRouter), about $0.00001: decide() returns a probability that 7 is prime. A throwaway home, no daemon. In
# `test/run.sh --smoke` only; without a key it skips.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# A live test: it calls OpenRouter, so it gets the real key (lib.sh).
STAM_TEST_REAL_KEY=1
daemon_home main
use main
grep -q "^OPENROUTER_API_KEY=." "$STAM_HOME/opencode.env" 2>/dev/null || { echo "SKIP decide-live: no OpenRouter key"; exit 0; }
node "$(dirname "$(readlink -f "$0")")/decide-live.mjs"
echo "PASS decide-live"
