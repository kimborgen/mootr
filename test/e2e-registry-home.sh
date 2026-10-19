#!/bin/sh
# S-387 (follow-up to S-380), free (no models, no agent turns). The user registry and the instructions
# for all agents live on the settings home, as the shared settings do. Two isolated daemons: "home",
# and "peer", whose settings.json names home as its `home`, with a long poll so only boot and the
# push move it. Checks:
#   - a type saved on the home (POST /api/types/x) reaches the peer's /api/registry through the push
#   - instructions posted on the home reach the peer's agents, and the peer's GET of both files
#   - the peer refuses to change types, the registry, or the instructions (409 naming the home), and
#     writes nothing
#   - a type removed on the home goes from the peer too
#   - with the home stopped, the peer keeps the cached registry and instructions
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home home
daemon_home peer
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
def save(name, s):
    json.dump(s, open(f"{tmp}/{name}/settings.json", "w"), indent=2)
save("home", {"resourceWarn": {"enabled": False}, "peers": [peer("peer")]})
save("peer", {"home": "home", "peers": [peer("home")]})
PY
# The peer's own files, which it must not use once it has the home's copy, nor overwrite.
printf '%s\n' '{"types":{"peer-own":{"description":"peer only","harness":"claude","model":null,"effort":null}}}' >"$TEST_TMP/peer/registry.json"
printf 'peer-own instructions\n' >"$TEST_TMP/peer/instructions.md"
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
tok() { cat "$TEST_TMP/$1/token"; }
# hapi DAEMON METHOD PATH [BODY]: a call as the human (see trustedHuman).
hapi() { curl -s -m 5 -X "$2" -H "authorization: Bearer $(tok "$1")" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' ${4:+-d "$4"} "$(url "$1")$3"; }
hcode() { curl -s -m 5 -o /dev/null -w '%{http_code}' -X "$2" -H "authorization: Bearer $(tok "$1")" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' ${4:+-d "$4"} "$(url "$1")$3"; }

STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
export STAM_SETTINGS_SYNC_MS=600000
daemon_up home
daemon_up peer

_types() { [ "$(hapi peer GET /api/registry | jget "sorted(k for k in d['types'] if k.startswith(('tester', 'peer-own')))")" = "$1" ]; }
echo "-- at boot the peer reads the home's (empty) registry, not its own"
wait_until _types "[]"

echo "-- a type saved on the home reaches the peer through the push"
[ "$(hcode home POST /api/types/tester '{"description":"runs tests","harness":"claude","model":null,"effort":null}')" = 200 ] || fail "the home refused the type"
wait_until _types "['tester']"
[ "$(hapi peer GET /api/config/registry | jget "list(json.loads(d['text'])['types']), d['home']")" = "['tester'] home" ] || fail "the peer's GET of the registry: $(hapi peer GET /api/config/registry)"

echo "-- instructions posted on the home reach the peer's agents"
[ "$(hcode home POST /api/config/instructions '{"text":"Say hello from the home.\n"}')" = 200 ] || fail "the home refused the instructions"
AGENT=$(hapi peer POST /api/register '{"name":"reader","role":"test","harness":"claude"}' | jget "d['id']")
_instr() { hapi peer GET "/api/agents/$AGENT/instructions" | grep -q 'Say hello from the home.'; }
wait_until _instr
hapi peer GET "/api/agents/$AGENT/instructions" | grep -q 'peer-own instructions' && fail "the peer's agent got the peer's own instructions"
[ "$(hapi peer GET /api/config/instructions | jget "d['text'].strip()")" = "Say hello from the home." ] || fail "the peer's GET of the instructions: $(hapi peer GET /api/config/instructions)"

echo "-- the peer refuses to change types, the registry, or the instructions, and writes nothing"
REG_BEFORE=$(cat "$TEST_TMP/peer/registry.json")
OUT=$(hapi peer POST /api/types/x '{"description":"no","harness":"claude"}')
[ "$(printf '%s' "$OUT" | jget "d['home'], 'live on home' in d['error']")" = "home True" ] || fail "POST /api/types on the peer: $OUT"
[ "$(hcode peer POST /api/types/x '{"description":"no","harness":"claude"}')" = 409 ] || fail "POST /api/types on the peer isn't a 409"
[ "$(hcode peer DELETE /api/types/tester)" = 409 ] || fail "DELETE /api/types on the peer isn't a 409"
[ "$(hcode peer POST /api/config/registry '{"text":"{}"}')" = 409 ] || fail "POST /api/config/registry on the peer isn't a 409"
[ "$(hcode peer POST /api/config/instructions '{"text":"x"}')" = 409 ] || fail "POST /api/config/instructions on the peer isn't a 409"
[ "$(cat "$TEST_TMP/peer/registry.json")" = "$REG_BEFORE" ] || fail "the peer's registry.json changed"
[ "$(cat "$TEST_TMP/peer/instructions.md")" = "peer-own instructions" ] || fail "the peer's instructions.md changed"
_types "['tester']" || fail "a refused write changed the peer's types"

echo "-- a type removed on the home goes from the peer too"
hapi home POST /api/types/tester2 '{"description":"second","harness":"claude","model":null,"effort":null}' >/dev/null
wait_until _types "['tester', 'tester2']"
[ "$(hcode home DELETE /api/types/tester2)" = 200 ] || fail "the home refused the removal"
wait_until _types "['tester']"

echo "-- with the home stopped, the peer keeps the cached registry and instructions"
daemon_stop home
daemon_stop peer
daemon_up peer
_types "['tester']" || fail "the peer lost its cached registry: $(hapi peer GET /api/registry | jget "list(d['types'])")"
_instr || fail "the peer lost its cached instructions"

echo "PASS: registry home"
