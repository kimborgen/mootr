#!/bin/sh
# Voice input's routes on a throwaway daemon, free: no key, so no call leaves the machine.
# Only the human reaches GET /api/voice and POST /api/voice/transcribe: an agent's token and
# forged headers are refused (STAM_TEST_HUMAN_KEY stands in for tailscale serve). Without a key
# the status is false and a clip answers 503, never a model call. Setting voice.env makes the
# status true, read per call, so no restart. The unit test (test/voice.test.mjs) covers the
# transcription itself against a stub.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
daemon_up main
use main
TOKEN=$(cat "$TEST_TMP/main/token")
fail() { echo "FAIL: $1" >&2; exit 1; }
code() { curl -s -o "$TEST_TMP/out" -w '%{http_code}' "$@"; }

[ "$(code -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H "authorization: Bearer $TOKEN" "$STAM_URL/api/voice")" = 200 ] || fail "the human reads the status"
grep -q '"configured":false' "$TEST_TMP/out" || fail "voice is not configured yet: $(cat "$TEST_TMP/out")"
[ "$(code -H "authorization: Bearer $TOKEN" "$STAM_URL/api/voice")" = 403 ] || fail "an agent cannot read the voice status"
[ "$(code -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: audio/webm' --data-binary @- "$STAM_URL/api/voice/transcribe" </dev/null)" = 403 ] || fail "an agent cannot transcribe"
[ "$(code -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H "authorization: Bearer $TOKEN" -H 'content-type: audio/webm' --data-binary 'x' "$STAM_URL/api/voice/transcribe")" = 503 ] || fail "no key, no transcription"
printf 'ELEVENLABS_API_TOKEN=test-not-real\n' >"$TEST_TMP/main/voice.env"
chmod 600 "$TEST_TMP/main/voice.env"
[ "$(code -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H "authorization: Bearer $TOKEN" "$STAM_URL/api/voice")" = 200 ] || fail "the status again"
grep -q '"configured":true' "$TEST_TMP/out" || fail "a key makes voice configured"
! grep -q 'test-not-real' "$TEST_TMP/out" || fail "the key leaked into the status"
echo "PASS voice routes"
