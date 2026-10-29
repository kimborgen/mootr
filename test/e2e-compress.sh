#!/bin/sh
# The daemon compresses its JSON API responses and the web UI's static files when the client
# takes them (src/compress.ts), and sends them as they are when it doesn't. Free: a throwaway
# daemon, no agent, no model. The static check needs the web UI built (web/dist). A remote run's
# own tree (git's files only, so no build) gets one here: STAM_TEST_BUILD_WEB, which
# the remote runner sets to that tree. Anywhere else a missing build fails, so a shared or live
# checkout's web/dist is never emptied by a test.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main; use main
daemon_up main
URL=$(sh -c 'echo "$STAM_URL"'); TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
# get NAME URL [CURL ARGS]: the response's headers and body, into files named by NAME.
get() { _n=$1; _u=$2; shift 2; curl -s -D "$TEST_TMP/h.$_n" -o "$TEST_TMP/b.$_n" -H "authorization: Bearer $TOKEN" "$@" "$_u"; }
encoded() { grep -qi "^content-encoding: $2" "$TEST_TMP/h.$1"; }
# A JSON body that clears the 1 KB floor: the tool catalog.
API="$URL/api/tools"
get api-br "$API" -H 'accept-encoding: gzip, br'
get api-gz "$API" -H 'accept-encoding: gzip'
get api-id "$API" -H 'accept-encoding: identity'
encoded api-br br || fail "JSON not brotli when br is accepted: $(cat "$TEST_TMP/h.api-br")"
encoded api-gz gzip || fail "JSON not gzip when only gzip is accepted"
grep -qi '^content-encoding' "$TEST_TMP/h.api-id" && fail "JSON compressed although identity was asked for"
grep -qi '^vary: accept-encoding' "$TEST_TMP/h.api-id" || fail "JSON response lacks vary: accept-encoding"
[ "$(wc -c <"$TEST_TMP/b.api-br")" -lt "$(wc -c <"$TEST_TMP/b.api-id")" ] || fail "brotli body isn't smaller than the plain one"
# The decoded body is the same JSON either way.
curl -s --compressed -H "authorization: Bearer $TOKEN" "$API" -o "$TEST_TMP/json-dec"
cmp -s "$TEST_TMP/json-dec" "$TEST_TMP/b.api-id" || fail "decoded JSON differs from the plain body"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$TEST_TMP/b.api-id" || fail "plain body isn't JSON"
# A static asset: the hashed JS bundle, compressed when asked, plain when not, same bytes from the cache.
JS=$(ls "$ROOT/web/dist/assets/"*.js 2>/dev/null | head -1)
if [ -z "$JS" ]; then
  { [ -n "$STAM_TEST_BUILD_WEB" ] && [ "$(readlink -f "$STAM_TEST_BUILD_WEB")" = "$(readlink -f "$ROOT")" ]; } ||
    fail "no web/dist build; run npm run build in web/ first"
  [ -x "$ROOT/web/node_modules/.bin/vite" ] || fail "no web/dist build, and no web/node_modules to build one"
  (cd "$ROOT/web" && ./node_modules/.bin/vite build --logLevel error >&2) || fail "building web/dist failed"
  JS=$(ls "$ROOT/web/dist/assets/"*.js 2>/dev/null | head -1)
  [ -n "$JS" ] || fail "the build left no web/dist/assets/*.js"
fi
A="$URL/web/assets/$(basename "$JS")"
get js-br "$A" -H 'accept-encoding: br, gzip'
get js-br2 "$A" -H 'accept-encoding: br, gzip'
get js-id "$A" -H 'accept-encoding: identity'
encoded js-br br || fail "JS not brotli when br is accepted"
cmp -s "$TEST_TMP/b.js-br" "$TEST_TMP/b.js-br2" || fail "a cached asset's bytes changed"
grep -qi '^content-encoding' "$TEST_TMP/h.js-id" && fail "JS compressed although identity was asked for"
cmp -s "$TEST_TMP/b.js-id" "$JS" || fail "plain JS differs from the file"
curl -s --compressed "$A" -o "$TEST_TMP/js-dec"
cmp -s "$TEST_TMP/js-dec" "$JS" || fail "decoded JS differs from the file"
# A tiny body (under 1 KB, a 404 here) is sent plain even when compression is accepted.
get tiny "$URL/api/nope-nothing" -H 'accept-encoding: br'
grep -qi '^content-encoding' "$TEST_TMP/h.tiny" && fail "a tiny error body was compressed"
echo "PASS compress: JSON and static assets compressed on request, plain otherwise"
