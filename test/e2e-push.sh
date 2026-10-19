#!/bin/sh
# Phone notifications (Web Push) end to end, with a stub push service: device storage and
# kinds, what pushes (mail to the human and permission requests, never agent-to-agent mail),
# the encrypted payloads and VAPID signatures, expired subscriptions, and tests. Only the
# human through `tailscale serve` manages devices: an agent's token and forged headers are
# refused (STAM_TEST_HUMAN_KEY stands in for serve). Two peered daemons, main and far: far's
# mail to the human reaches main's devices by id, checked with far; forged and repeated
# relays push nothing; an answer for far's request goes to far. Registered agents with no
# harness, so it is free.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home far
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d, other in (("main", "far"), ("far", "main")):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer(other)]
    json.dump(s, open(path, "w"), indent=2)
PY
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
daemon_up main
daemon_up far
use main
FAR_URL=$(on far sh -c 'echo "$STAM_URL"') FAR_HOME="$TEST_TMP/far" node "$(dirname "$(readlink -f "$0")")/push-helper.mjs"
