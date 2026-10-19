#!/bin/sh
# stam's own agent view (src/agent-view.ts) with a live OpenCode agent on DeepSeek V4
# Flash (well under a cent): history and paging through the daemon, a prompt sent from
# the view streaming its reply back in growing updates, an interrupt stopping a long
# command, and sends with a forged human header refused. The steps are in
# test/agent-view-live.mjs. Runs against its own daemon (test/lib.sh). Takes about two minutes.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# Calls OpenRouter with a real model (lib.sh): the live test gets the real key.
STAM_TEST_REAL_KEY=1
# Stands in for the human's `tailscale serve` proof (trustedHuman); a forged header isn't.
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
isolate
N="e2e-view-$(date +%s)"; DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$N" --harness opencode --model "${MODEL:-openrouter/~deepseek/deepseek-v4-flash-latest}" --cwd "$DIR" --role "View test agent." \
  "Reply with exactly the word first-reply and nothing else. Use no tools."
"$STAM" wait "$N" --until idle --timeout 150
node "$ROOT/test/agent-view-live.mjs" "$N" || { "$STAM" events "$N" | tail -20; exit 1; }
echo "PASS e2e-agent-view"
