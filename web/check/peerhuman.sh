#!/bin/sh
# The human's writes for a peer machine's agent, from the page of a daemon that doesn't relay them
# (auth.humanStrict, S-544): headless Chromium against two throwaway daemons (test/lib.sh): "main", the
# page's daemon (strict on, legacyPeerToken off, far as its ITSA home), and "far", which holds an agent
# with permission requests and an ITSA waiting on the human. The page answers each on far's own origin,
# cross-origin, with no token; the test key stands in for tailscale serve on both. No model runs, nothing
# is spent, and lib.sh stops both daemons on exit.
#   sh web/check/peerhuman.sh OUT_DIR      (SKIP_BUILD=1 reuses web/dist)
set -e
HERE="$(dirname "$(readlink -f "$0")")"
STAM_TEST_ROOT="$(cd "$HERE/../.." && pwd)"
export STAM_TEST_ROOT
OUT="${1:?usage: sh web/check/peerhuman.sh OUT_DIR}"
. "$STAM_TEST_ROOT/test/lib.sh"
[ -n "$SKIP_BUILD" ] || (cd "$STAM_TEST_ROOT/web" && npm run build >&2)
daemon_home main
daemon_home far
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
# far is the ITSA home and so the settings home: main syncs legacyPeerToken off; humanStrict is local, so both set it.
json.dump({"resourceWarn": {"enabled": False}, "peers": [peer("far")], "itsa": {"home": "far"}, "auth": {"humanStrict": True}}, open(f"{tmp}/main/settings.json", "w"), indent=2)
json.dump({"resourceWarn": {"enabled": False}, "peers": [peer("main")], "itsa": {"home": "far"}, "auth": {"humanStrict": True, "legacyPeerToken": False}}, open(f"{tmp}/far/settings.json", "w"), indent=2)
PY
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
daemon_up main
daemon_up far
# Each daemon's peer token is made at its first start; the other's settings need it (strict needs legacyPeerToken off).
python3 - "$TEST_TMP" <<'PY'
import json, sys
tmp = sys.argv[1]
for me, other in (("main", "far"), ("far", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"][0]["peerToken"] = open(f"{tmp}/{other}/peer-token").read().strip()
    json.dump(s, open(path, "w"), indent=2)
PY
for d in main far; do on $d "$STAM" daemon stop >/dev/null 2>&1 || true; done
daemon_up main
daemon_up far
node "$HERE/peerhuman.mjs" "$(url main)" "$(cat "$TEST_TMP/main/token")" "$(url far)" "$(cat "$TEST_TMP/far/token")" "$STAM_TEST_HUMAN_KEY" "$OUT" || { rc=$?; [ -z "$DEBUG" ] || tail -25 "$TEST_TMP/main/daemon.log"; exit $rc; }
