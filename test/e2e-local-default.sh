#!/bin/sh
# Local login is the default for a fresh install (S-2121). A home with no settings.json gets auth.localHuman
# true written, and its own page on 127.0.0.1 logs in with a code root vouched for (here a test folder and
# this user standing in for root, as in e2e-local-human.sh) and approves a permission request. A home whose
# settings.json came before (test/lib.sh writes one, like an install from before S-2121) is pinned to
# auth.localHuman false: the login is off, and the human approves through tailscale serve (the test key
# stands in for it). Both run with auth.humanStrict, so the shared token approves nothing. Free: no agents
# run, no models. A refused token link on the fresh home is told a local login is there (`localLogin`), so its page
# offers one; the pinned home's isn't. `stam web` names the login page first only on the fresh home.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
export STAM_TEST_HUMAN_CODE_DIR="$TEST_TMP/human-codes" STAM_TEST_HUMAN_CODE_ROOT_UID="$(id -u)"
# The login page asks whether this user has passwordless sudo; the test answers, so no test runs sudo (S-2121).
export STAM_TEST_PASSWORDLESS_SUDO=0
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
J='content-type: application/json'
KEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
localhuman() { jget "d.get('auth', {}).get('localHuman')" <"$TEST_TMP/$1/settings.json"; }
# strict HOME: auth.humanStrict on, keeping what the file has.
strict() { python3 - "$TEST_TMP/$1/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
s.setdefault('auth', {}).update({'humanStrict': True})
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
  _a=$(curl -s -X POST -H "authorization: Bearer $(cat "$TEST_TMP/$1/token")" -H "$J" -d "{\"name\":\"asker-$(date +%s%N)\",\"role\":\"developer\",\"harness\":\"claude\"}" "$(url "$1")/api/register" | jget "d['id']")
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
STAM_TEST_PASSWORDLESS_SUDO=1 daemon_up fresh
U=$(url fresh)
[ "$(curl -s "$U/api/human/login" | jget "d['enabled']")" = True ] || fail "login wasn't reported on for a fresh install"
[ "$(curl -s "$U/api/human/login" | jget "d['passwordlessSudo']")" = True ] || fail "login didn't say sudo is passwordless"
# Only a direct loopback request learns it: one a peer forwards (x-stam-local) is told false. Serve's own
# requests come from root's socket, which localDirect refuses too.
[ "$(curl -s -H 'x-stam-local: 1' "$U/api/human/login" | jget "d['passwordlessSudo']")" = False ] || fail "a forwarded request learned whether sudo is passwordless"
# `stam web` names the login page first, and says a token link isn't the human (S-2121).
on fresh "$STAM" web >"$TEST_TMP/web.out"
head -1 "$TEST_TMP/web.out" | grep -q "^http://127.0.0.1:[0-9]*/ .*log in as the human" || fail "stam web didn't name the login page first: $(cat "$TEST_TMP/web.out")"
grep '#token=' "$TEST_TMP/web.out" | grep -q 'not the human' || fail "stam web didn't mark its token link: $(cat "$TEST_TMP/web.out")"
R=$(ask fresh)
[ "$(answer fresh "$R" -H "authorization: Bearer $(cat "$TEST_TMP/fresh/token")")" = 403 ] || fail "the shared token approved under strict: $(cat "$TEST_TMP/body")"
# The page of a `stam web` token link is told a local login is there, so it offers one (S-2121); a CLI call isn't.
[ "$(jget "d.get('localLogin')" <"$TEST_TMP/body")" = True ] || fail "a token link's refusal didn't offer the local login: $(cat "$TEST_TMP/body")"
# The refusal names only the ways this machine has (S-2121): here the login page, and no tailscale serve.
grep -q "through stam's login page at http://127.0.0.1" "$TEST_TMP/body" || fail "the refusal didn't name the login page: $(cat "$TEST_TMP/body")"
grep -qi 'tailscale' "$TEST_TMP/body" && fail "the refusal named tailscale on a machine without serve: $(cat "$TEST_TMP/body")"
code -X POST -H "$J" -H "authorization: Bearer $(cat "$TEST_TMP/fresh/token")" -d '{"approve":true}' "$U/api/permissions/$R/answer" >/dev/null
[ "$(jget "d.get('localLogin')" <"$TEST_TMP/body")" = None ] || fail "a refusal without x-stam-human offered the local login: $(cat "$TEST_TMP/body")"
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
on pinned "$STAM" web >"$TEST_TMP/web.out"
grep -q 'log in as the human' "$TEST_TMP/web.out" && fail "stam web named the login page with it off: $(cat "$TEST_TMP/web.out")"
grep -q 'not the human' "$TEST_TMP/web.out" && fail "stam web marked its token link with login off: $(cat "$TEST_TMP/web.out")"
[ "$(code -X POST -H "$J" -H "origin: $U" -H 'sec-fetch-site: same-origin' -d "{\"secret\":\"$(vouched)\"}" "$U/api/human/login")" = 404 ] || fail "a pinned install's login wasn't 404: $(cat "$TEST_TMP/body")"
R=$(ask pinned)
[ "$(answer pinned "$R" -H "authorization: Bearer $(cat "$TEST_TMP/pinned/token")")" = 403 ] || fail "the shared token approved under strict: $(cat "$TEST_TMP/body")"
[ "$(jget "d.get('localLogin')" <"$TEST_TMP/body")" = None ] || fail "a refusal offered the local login with it off: $(cat "$TEST_TMP/body")"
grep -q 'once local login is on (auth.localHuman in settings.json)' "$TEST_TMP/body" || fail "the refusal with neither way didn't say how to turn local login on: $(cat "$TEST_TMP/body")"
[ "$(answer pinned "$R" -H "$KEY")" = 200 ] || fail "the serve stand-in's approval failed: $(cat "$TEST_TMP/body")"
grep -q approved "$TEST_TMP/body" || fail "the serve stand-in's answer wasn't an approval: $(cat "$TEST_TMP/body")"
# A restart doesn't change the pin. STAM_WEB_ORIGIN stands in for a tailscale serve the daemon found: the
# refusal then names that page, and not the login, which is off (S-2121).
on pinned "$STAM" daemon stop >/dev/null 2>&1 || true
STAM_WEB_ORIGIN=https://pinned.example.com daemon_up pinned
[ "$(localhuman pinned)" = False ] || fail "a restart changed the pin"
R=$(ask pinned)
[ "$(answer pinned "$R" -H "authorization: Bearer $(cat "$TEST_TMP/pinned/token")")" = 403 ] || fail "the shared token approved under strict: $(cat "$TEST_TMP/body")"
grep -q "through stam's page at https://pinned.example.com (tailscale serve)" "$TEST_TMP/body" || fail "the refusal didn't name the serve page: $(cat "$TEST_TMP/body")"
grep -q 'login page' "$TEST_TMP/body" && fail "the refusal named the login page with it off: $(cat "$TEST_TMP/body")"
echo "PASS"
