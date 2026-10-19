#!/bin/sh
# Local login is the default for a fresh install (S-2121). A home with no settings.json gets auth.localHuman
# true written, and its own page on 127.0.0.1 logs in with a code root vouched for (here a test folder and
# this user standing in for root, as in e2e-local-human.sh) and approves a permission request. A home whose
# settings.json came before (test/lib.sh writes one, like an install from before S-2121) is pinned to
# auth.localHuman false: the login is off, and the human approves through tailscale serve (the test key
# stands in for it). Both run with auth.humanStrict, so the shared token approves nothing. Free: no agents
# run, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
export STAM_TEST_HUMAN_CODE_DIR="$TEST_TMP/human-codes" STAM_TEST_HUMAN_CODE_ROOT_UID="$(id -u)"
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
J='content-type: application/json'
KEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
localhuman() { jget "d.get('auth', {}).get('localHuman')" <"$TEST_TMP/$1/settings.json"; }
# strict HOME: auth.humanStrict on (legacyPeerToken off, so it takes effect), keeping what the file has.
strict() { python3 - "$TEST_TMP/$1/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('auth', {}).update({'humanStrict': True, 'legacyPeerToken': False})
json.dump(s, open(p, 'w'))
PY
}
# The page's command, as this user (the stand-in for root), under a strict umask that sudo would keep.
umask 077
pair() { python3 -c 'import base64,hashlib,secrets; s=secrets.token_urlsafe(16); print(s, base64.b32encode(hashlib.sha256(s.encode()).digest()[:16]).decode().lower().rstrip("="))'; }
vouched() {
  set -- $(pair)
  /usr/bin/install -d -m 755 "$STAM_TEST_HUMAN_CODE_DIR" "$STAM_TEST_HUMAN_CODE_DIR/$(id -u)" && /usr/bin/install -m 644 /dev/null "$STAM_TEST_HUMAN_CODE_DIR/$(id -u)/$2"
  echo "$1"
}
# ask HOME: a registered agent's permission request for the human; prints its id.
ask() {
  _a=$(curl -s -X POST -H "authorization: Bearer $(cat "$TEST_TMP/$1/token")" -H "$J" -d '{"name":"asker","role":"developer","harness":"claude"}' "$(url "$1")/api/register" | jget "d['id']")
  curl -s -X POST -H "authorization: Bearer $(cat "$TEST_TMP/$1/token")" -H "$J" -d "{\"agent\":\"$_a\",\"action\":\"Merge the PR\",\"reason\":\"needed\",\"details\":\"\",\"audience\":\"human\"}" "$(url "$1")/api/permissions" | jget "d['id']"
}
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
# answer HOME ID HEADER...: approves request ID with the given credentials; prints the HTTP status.
answer() { _h=$1 _id=$2; shift 2; code -X POST -H "$J" -H 'x-stam-human: 1' "$@" -d '{"approve":true}' "$(url "$_h")/api/permissions/$_id/answer"; }

echo "-- a fresh install: local login is on"
daemon_home fresh
rm "$TEST_TMP/fresh/settings.json"
daemon_up fresh
[ "$(localhuman fresh)" = True ] || fail "a fresh install's settings.json doesn't have auth.localHuman true: $(cat "$TEST_TMP/fresh/settings.json")"
on fresh "$STAM" daemon stop >/dev/null 2>&1 || true
strict fresh
daemon_up fresh
U=$(url fresh)
[ "$(curl -s "$U/api/human/login" | jget "d['enabled']")" = True ] || fail "login wasn't reported on for a fresh install"
R=$(ask fresh)
[ "$(answer fresh "$R" -H "authorization: Bearer $(cat "$TEST_TMP/fresh/token")")" = 403 ] || fail "the shared token approved under strict: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$J" -H "origin: $U" -H 'sec-fetch-site: same-origin' -d "{\"secret\":\"$(vouched)\"}" "$U/api/human/login")" = 200 ] || fail "a fresh install's local login failed: $(cat "$TEST_TMP/body")"
S=$(jget "d['token']" <"$TEST_TMP/body")
[ "$(answer fresh "$R" -H "authorization: Bearer $S")" = 200 ] || fail "a local session's approval failed: $(cat "$TEST_TMP/body")"
grep -q approved "$TEST_TMP/body" || fail "a local session's answer wasn't an approval: $(cat "$TEST_TMP/body")"
on fresh "$STAM" daemon stop >/dev/null 2>&1 || true

echo "-- an existing install: pinned off, approves through tailscale serve"
daemon_home pinned
strict pinned
daemon_up pinned
U=$(url pinned)
[ "$(localhuman pinned)" = False ] || fail "an existing install wasn't pinned to auth.localHuman false: $(cat "$TEST_TMP/pinned/settings.json")"
[ "$(curl -s "$U/api/human/login" | jget "d['enabled']")" = False ] || fail "login wasn't reported off for an existing install"
[ "$(code -X POST -H "$J" -H "origin: $U" -H 'sec-fetch-site: same-origin' -d "{\"secret\":\"$(vouched)\"}" "$U/api/human/login")" = 404 ] || fail "a pinned install's login wasn't 404: $(cat "$TEST_TMP/body")"
R=$(ask pinned)
[ "$(answer pinned "$R" -H "authorization: Bearer $(cat "$TEST_TMP/pinned/token")")" = 403 ] || fail "the shared token approved under strict: $(cat "$TEST_TMP/body")"
[ "$(answer pinned "$R" -H "$KEY")" = 200 ] || fail "the serve stand-in's approval failed: $(cat "$TEST_TMP/body")"
grep -q approved "$TEST_TMP/body" || fail "the serve stand-in's answer wasn't an approval: $(cat "$TEST_TMP/body")"
# A restart doesn't change the pin.
on pinned "$STAM" daemon stop >/dev/null 2>&1 || true
daemon_up pinned
[ "$(localhuman pinned)" = False ] || fail "a restart changed the pin"
echo "PASS"
