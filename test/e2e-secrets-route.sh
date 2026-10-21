#!/bin/sh
# S-2114, free (no models, no agent turns). The secret store's routes on one daemon:
#   - the key in opencode.env is imported at start into secrets.json, mode 600
#   - the human's PUT sets a secret, GET lists names and the last 4 only, DELETE removes it
#   - no route returns a value: not GET, PUT (a malformed body too) or DELETE, nor the daemon log
#   - an agent's token, the OpenCode server's token, and the shared token without the human get 403
#     on every secret route, and nothing changes
#   - the daemon's own environment never holds a secret
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
IMPORTED=sk-imported-abcdefgh-1111
SET=sk-set-by-human-ijklmn-2222
daemon_home main
(umask 077 && printf 'OPENROUTER_API_KEY=%s\n' "$IMPORTED" >>"$TEST_TMP/main/opencode.env")
daemon_up main
H="$TEST_TMP/main"
URL=$(on main sh -c 'echo "$STAM_URL"'); TOKEN=$(cat "$H/token")
J='content-type: application/json'
# req TOKEN [HUMAN] METHOD PATH [BODY]: prints the status; the body is in $TEST_TMP/body.
req() {
  _t=$1; _hk=$2; shift 2
  curl -s -m 10 -o "$TEST_TMP/body" -w '%{http_code}' -X "$1" -H "authorization: Bearer $_t" ${_hk:+-H "x-stam-test-human: $_hk"} -H "$J" ${3:+-d "$3"} "$URL$2"
}
human() { req "$TOKEN" "$STAM_TEST_HUMAN_KEY" "$@"; }
# no_value: the last response holds neither secret's value.
no_value() { ! grep -q -e "$IMPORTED" -e "$SET" -e "${SET%-*}" "$TEST_TMP/body" || fail "$1 returned a value: $(cat "$TEST_TMP/body")"; }

echo "-- opencode.env imports at start into a mode-600 secrets.json"
wait_until test -f "$H/secrets.json"
[ "$(stat -c %a "$H/secrets.json")" = 600 ] || fail "secrets.json is mode $(stat -c %a "$H/secrets.json")"
[ "$(human GET /api/secrets)" = 200 ] || fail "the human's GET was refused: $(cat "$TEST_TMP/body")"
no_value GET
jget "sorted(s['name'] for s in d['secrets'])" <"$TEST_TMP/body" | grep -qx "\['openrouter', 'openrouter-agent'\]" || fail "the import isn't listed: $(cat "$TEST_TMP/body")"
jget "[s['last4'] for s in d['secrets'] if s['name']=='openrouter'][0]" <"$TEST_TMP/body" | grep -qx 1111 || fail "no last 4"

echo "-- the human sets, lists and deletes a secret; no response holds a value"
[ "$(human PUT /api/secrets/openai-main "{\"value\":\"$SET\",\"provider\":\"openai\"}")" = 200 ] || fail "PUT refused: $(cat "$TEST_TMP/body")"
no_value PUT
jget "d['last4'], d['provider']" <"$TEST_TMP/body" | grep -qx '2222 openai' || fail "PUT info wrong: $(cat "$TEST_TMP/body")"
[ "$(stat -c %a "$H/secrets.json")" = 600 ] || fail "secrets.json lost mode 600 on write"
grep -q "$SET" "$H/secrets.json" || fail "the value isn't stored"
[ "$(human GET /api/secrets)" = 200 ] && no_value GET
[ "$(human PUT /api/secrets/Bad..Name '{"value":"x"}')" = 400 ] || fail "a bad name wasn't a 400"
# A malformed body is a 400 with a fixed message: the parse error would quote the key.
[ "$(human PUT /api/secrets/openai-main "{\"value\":\"$SET\"")" = 400 ] || fail "a malformed body wasn't a 400: $(cat "$TEST_TMP/body")"
no_value "a malformed PUT"

echo "-- agents, the OpenCode server and the shared token without the human get 403"
REG=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -d '{"name":"probe","role":"test","harness":"claude"}' "$URL/api/register")
AID=$(printf '%s' "$REG" | jget "d['id']")
curl -sf -X POST -H "authorization: Bearer $TOKEN" -H "$J" -d "{\"agent\":\"$AID\",\"token\":\"agent-token-$AID\"}" "$URL/api/test/agent" >/dev/null
OC=oc-test-token
printf '%s' "$(printf '%s' "$OC" | sha256sum | cut -d' ' -f1)" >"$H/opencode-token"
BEFORE=$(cat "$H/secrets.json")
for who in "agent-token-$AID" "$OC" "$TOKEN"; do
  for r in "GET /api/secrets" "PUT /api/secrets/openai-main" "PUT /api/secrets/new-one" "POST /api/secrets/openai-main/test" "DELETE /api/secrets/openai-main"; do
    set -- $r
    s=$(req "$who" "" "$1" "$2" '{"value":"sk-agent-wrote-this-3333"}')
    [ "$s" = 403 ] || fail "$1 $2 with ${who%%-*}... got $s: $(cat "$TEST_TMP/body")"
    no_value "$1 $2"
  done
done
[ "$(cat "$H/secrets.json")" = "$BEFORE" ] || fail "a refused request changed secrets.json"
# Test (S-2115) is human-only too; a secret no provider uses has nothing to be tested against.
[ "$(human POST /api/secrets/openai-main/test '{}')" = 400 ] || fail "a test with no provider wasn't a 400: $(cat "$TEST_TMP/body")"
no_value "a test"
[ "$(human POST /api/secrets/nobody/test '{"provider":"openrouter"}')" = 404 ] || fail "a test of a missing secret wasn't a 404"
[ "$(human DELETE /api/secrets/openai-main)" = 200 ] || fail "the human's DELETE was refused: $(cat "$TEST_TMP/body")"
no_value DELETE
[ "$(human DELETE /api/secrets/openai-main)" = 404 ] || fail "a second DELETE wasn't a 404"
! grep -q "$SET" "$H/secrets.json" || fail "the deleted value is still stored"

echo "-- neither the daemon's environment nor its log holds a secret"
PID=$(cat "$H/daemon.pid")
! tr '\0' '\n' <"/proc/$PID/environ" | grep -q -e "$IMPORTED" -e "$SET" || fail "the daemon's environment holds a secret"
! grep -q -e "$IMPORTED" -e "$SET" "$H/daemon.log" || fail "the daemon log holds a secret"
echo "PASS: secrets-route"
