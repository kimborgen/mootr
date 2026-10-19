#!/bin/sh
# Local human login (S-613): with auth.localHuman on, a page's secret whose name root vouched for with
# coreutils (`install -d -m 755 DIR DIR/UID && install -m 644 /dev/null DIR/UID/NAME`; here a test folder and this user standing in for root)
# logs stam's own page on 127.0.0.1 in as the human. Checked: off by default (login 404, no folder given); a
# login without stam's Origin, from another port, or cross-site is refused; the name alone, a made-up secret,
# and a reused one are refused; a session passes humanOnly and human writes, with auth.humanStrict too;
# the shared token and x-stam-human still don't; a session token sent as a peer's relay (x-stam-local) isn't
# the human; it opens a terminal socket; logout and turning the setting off end it. Free: no agents, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
export STAM_TEST_HUMAN_CODE_DIR="$TEST_TMP/human-codes" STAM_TEST_HUMAN_CODE_ROOT_UID="$(id -u)"
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# setauth LOCAL STRICT: auth.localHuman and auth.humanStrict (with legacyPeerToken off, so strict takes effect).
setauth() { python3 - "$TEST_TMP/main/settings.json" "$1" "$2" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s.setdefault('auth', {}).update({'localHuman': sys.argv[2] == 'true', 'humanStrict': sys.argv[3] == 'true', 'legacyPeerToken': sys.argv[3] != 'true'})
json.dump(s, open(p, 'w'))
PY
}
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
# pair: a fresh secret and its name (the first 128 bits of its SHA-256, base32), as the login page draws them.
pair() { python3 -c 'import base64,hashlib,secrets; s=secrets.token_urlsafe(16); print(s, base64.b32encode(hashlib.sha256(s.encode()).digest()[:16]).decode().lower().rstrip("="))'; }
# The page's command, as this user (the stand-in for root), under a strict umask that sudo would keep.
umask 077
mint() { /usr/bin/install -d -m 755 "$STAM_TEST_HUMAN_CODE_DIR" "$STAM_TEST_HUMAN_CODE_DIR/$(id -u)" && /usr/bin/install -m 644 /dev/null "$STAM_TEST_HUMAN_CODE_DIR/$(id -u)/$1"; }
# vouched: a secret root vouched for.
vouched() { set -- $(pair); mint "$2" >/dev/null; echo "$1"; }
J='content-type: application/json'
daemon_up main
URL=$(on main sh -c 'echo "$STAM_URL"')
TOKEN=$(cat "$TEST_TMP/main/token")
O="origin: $URL"
login() { code -X POST -H "$J" -H "$O" -H 'sec-fetch-site: same-origin' -d "{\"secret\":\"$1\"}" "$URL/api/human/login"; }
upgrade() {
  _o=$(curl -s -i -m 4 -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' -H "$O" "$URL$1" 2>/dev/null || true) # gitleaks:allow (RFC 6455's sample nonce)
  case "$_o" in *' 101 '*) echo yes ;; *) echo no ;; esac
}

echo "-- off by default"
[ "$(curl -s "$URL/api/human/login" | jget "d['enabled']")" = False ] || fail "login wasn't reported off"
[ "$(login "$(vouched)")" = 404 ] || fail "a login with the setting off wasn't 404: $(cat "$TEST_TMP/body")"

echo "-- on: who may log in"
setauth true false
[ "$(curl -s "$URL/api/human/login" | jget "d['enabled']")" = True ] || fail "login wasn't reported on"
[ "$(curl -s "$URL/api/human/login" | jget "d['dir']")" = "$STAM_TEST_HUMAN_CODE_DIR/$(id -u)" ] || fail "login didn't name this user's folder"
set -- $(pair); C=$1; N=$2
mint "$N"
[ "$(login "$N")" = 403 ] || fail "the name alone (what the terminal shows) logged in"
[ "$(code -X POST -H "$J" -d "{\"secret\":\"$C\"}" "$URL/api/human/login")" = 403 ] || fail "a login with no Origin wasn't 403"
PORT2=$(echo "$URL" | sed 's/.*://'); PORT2=$((PORT2 + 1))
[ "$(code -X POST -H "$J" -H "origin: http://127.0.0.1:$PORT2" -d "{\"secret\":\"$C\"}" "$URL/api/human/login")" = 403 ] || fail "a login from another port wasn't 403"
[ "$(code -X POST -H "$J" -H "$O" -H 'sec-fetch-site: same-site' -d "{\"secret\":\"$C\"}" "$URL/api/human/login")" = 403 ] || fail "a same-site (not same-origin) login wasn't 403"
[ "$(code -X POST -H 'content-type: text/plain' -H "$O" -d "{\"secret\":\"$C\"}" "$URL/api/human/login")" = 415 ] || fail "a login that isn't JSON wasn't 415"
[ "$(login AAAAAAAAAAAAAAAAAAAAAA)" = 403 ] || fail "a made-up secret wasn't 403"
[ "$(login "$C")" = 200 ] || fail "the vouched-for secret didn't log in: $(cat "$TEST_TMP/body")"
S=$(jget "d['token']" <"$TEST_TMP/body")
[ "$(login "$C")" = 403 ] || fail "a reused code wasn't 403"
grep -q 'local human login: a session started' "$TEST_TMP/main/daemon.log" || fail "the login wasn't logged"
grep -q 'local human login refused: that login was already used' "$TEST_TMP/main/daemon.log" || fail "the refusal wasn't logged"

echo "-- the session is the human; the shared token isn't"
[ "$(code -H "authorization: Bearer $S" "$URL/api/voice")" = 200 ] || fail "a session didn't pass humanOnly: $(cat "$TEST_TMP/body")"
[ "$(code -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' "$URL/api/voice")" = 403 ] || fail "the shared token passed humanOnly"
grep -q "login page at http://127.0.0.1" "$TEST_TMP/body" || fail "the refusal doesn't name local login: $(cat "$TEST_TMP/body")"
[ "$(code -H "authorization: Bearer $S" -H 'x-stam-local: 1' "$URL/api/voice")" = 401 ] || fail "a session sent as a peer's relay wasn't refused"
[ "$(code -X POST -H "authorization: Bearer $S" -H "$J" -d '{"title":"no header"}' "$URL/api/itsas")" = 403 ] || fail "a session write without x-stam-human wasn't 403"
SH=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H 'x-stam-human: 1' -d '{}' "$URL/api/shells" | jget "d['id']")
tkt() { curl -s -X POST -H "authorization: Bearer $S" -H "$J" -H 'x-stam-human: 1' -d "{\"kind\":\"tty\",\"path\":\"$1\"}" "$URL/api/tickets" | jget "d['ticket']"; }
TTY="/api/shells/$SH/tty"
[ "$(upgrade "$TTY?token=$S")" = no ] || fail "a session in ?token= opened a terminal socket"
[ "$(upgrade "$TTY")" = no ] || fail "a socket with no ticket or token opened"
T=$(tkt "$TTY")
[ "$(upgrade "$TTY?ticket=$T")" = yes ] || fail "a session's ticket didn't open a terminal socket"
[ "$(upgrade "$TTY?ticket=$T")" = no ] || fail "a ticket opened a second socket"
[ "$(upgrade "/api/shells/other/tty?ticket=$(tkt "$TTY")")" = no ] || fail "a ticket opened another path's socket"
[ "$(code -X POST -H "authorization: Bearer $S" -H "$J" -H 'x-stam-human: 1' -d '{"kind":"nope","path":"x"}' "$URL/api/tickets")" = 400 ] || fail "a ticket for an unknown kind wasn't 400"
[ "$(code -X POST -H "authorization: Bearer $TOKEN" -H "$J" -d "{\"kind\":\"tty\",\"path\":\"$TTY\"}" "$URL/api/tickets")" = 403 ] || fail "a ticket for a caller that isn't the human wasn't 403"

echo "-- with auth.humanStrict in effect"
setauth true true
[ "$(code -X POST -H "authorization: Bearer $S" -H "$J" -H 'x-stam-human: 1' -d '{"title":"local human act"}' "$URL/api/itsas")" = 200 ] || fail "a session's ITSA create under strict wasn't 200: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H 'x-stam-human: 1' -d '{"title":"cli act"}' "$URL/api/itsas")" = 403 ] || fail "the shared token's ITSA create under strict wasn't 403"

echo "-- logout, and the setting off, end sessions"
[ "$(code -X POST -H "authorization: Bearer $S" -H "$J" -H "$O" -d '{}' "$URL/api/human/logout")" = 200 ] || fail "logout failed: $(cat "$TEST_TMP/body")"
[ "$(code -H "authorization: Bearer $S" "$URL/api/voice")" = 401 ] || fail "a session after logout wasn't 401"
[ "$(login "$(vouched)")" = 200 ] || fail "a second login failed: $(cat "$TEST_TMP/body")"
S=$(jget "d['token']" <"$TEST_TMP/body")
setauth false true
[ "$(code -H "authorization: Bearer $S" "$URL/api/voice")" = 401 ] || fail "a session with the setting off wasn't 401"
setauth true true
[ "$(code -H "authorization: Bearer $S" "$URL/api/voice")" = 401 ] || fail "a session came back when the setting came back on"
on main "$STAM" shell kill "$SH" >/dev/null 2>&1 || true
echo "PASS"
