#!/bin/sh
# Local human login (S-613) in headless Chromium against one throwaway daemon (test/lib.sh) with
# auth.localHuman on: a test folder and this user stand in for /run/stam-human and root. The page with no
# token shows the command, refuses before it runs, logs in once the command ran (without sudo), is then the human,
# and logs out from Settings. Phone (360 px) and desktop (1280 px). No model runs, nothing is spent.
#   sh web/check/locallogin.sh OUT_DIR      (SKIP_BUILD=1 reuses web/dist)
set -e
HERE="$(dirname "$(readlink -f "$0")")"
STAM_TEST_ROOT="$(cd "$HERE/../.." && pwd)"
export STAM_TEST_ROOT
OUT="${1:?usage: sh web/check/locallogin.sh OUT_DIR}"
. "$STAM_TEST_ROOT/test/lib.sh"
[ -n "$SKIP_BUILD" ] || (cd "$STAM_TEST_ROOT/web" && npm run build >&2)
daemon_home main
printf '{ "peers": [], "resourceWarn": { "enabled": false }, "auth": { "localHuman": true } }\n' >"$TEST_TMP/main/settings.json"
export STAM_TEST_HUMAN_CODE_DIR="$TEST_TMP/human-codes" STAM_TEST_HUMAN_CODE_ROOT_UID="$(id -u)"
daemon_up main
node "$HERE/locallogin.mjs" "$(on main sh -c 'echo "$STAM_URL"')" "$OUT" || exit 1
