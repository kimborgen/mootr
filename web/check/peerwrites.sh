#!/bin/sh
# A peer's Settings page writes shared settings straight to the settings home (S-414), in headless
# Chromium against two throwaway daemons (test/lib.sh): "home", whose web origin is its own URL, and
# "peer", whose settings name home as its `home`. The page runs on the peer's origin and saves to the
# home's, cross-origin, as the real UI does; the test key stands in for tailscale serve. No agent runs,
# nothing is spent, and lib.sh stops both daemons on exit.
#   sh web/check/peerwrites.sh OUT_DIR      (SKIP_BUILD=1 reuses web/dist)
set -e
HERE="$(dirname "$(readlink -f "$0")")"
STAM_TEST_ROOT="$(cd "$HERE/../.." && pwd)"
export STAM_TEST_ROOT
OUT="${1:?usage: sh web/check/peerwrites.sh OUT_DIR}"
. "$STAM_TEST_ROOT/test/lib.sh"
[ -n "$SKIP_BUILD" ] || (cd "$STAM_TEST_ROOT/web" && npm run build >&2)
daemon_home home
daemon_home peer
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
json.dump({"resourceWarn": {"enabled": False}, "peers": [peer("peer")], "humanMail": {"when": "necessary"}}, open(f"{tmp}/home/settings.json", "w"), indent=2)
json.dump({"home": "home", "peers": [peer("home")]}, open(f"{tmp}/peer/settings.json", "w"), indent=2)
PY
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
echo "export STAM_WEB_ORIGIN=$(url home)" >>"$TEST_TMP/home/test.env"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
export STAM_SETTINGS_SYNC_MS=600000
daemon_up home
daemon_up peer
node "$HERE/peerwrites.mjs" "$(url peer)" "$(cat "$TEST_TMP/peer/token")" "$(url home)" "$(cat "$TEST_TMP/home/token")" "$STAM_TEST_HUMAN_KEY" "$OUT"
