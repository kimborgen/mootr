#!/bin/sh
# S-417 (follow-up to S-387), free (no models, no agent turns). The instruction template of an agent
# type (STAM_HOME/templates/type-NAME.md) lives on the settings home with the type. Two isolated
# daemons: "home", and "peer", whose settings.json names home as its `home`, with a long poll so only
# boot and the push move it. Checks:
#   - a type template saved on the home reaches the peer's /api/templates, and
#     the peer ignores its own file for it
#   - the peer refuses to edit or reset a type template (409 naming the home) and writes nothing
#   - a template that isn't a type's stays per machine
#   - with the home stopped, a restarted peer keeps the cached template
#   - a type removed on the home takes its template from the peer too, and the peer's own file for it goes
#     once the home confirms it gone (S-3079); with the home down, the file stays
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
mkdir -p "$TEST_TMP/peer/templates"
printf 'peer-own template\n' >"$TEST_TMP/peer/templates/type-tester.md"
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

_text() { [ "$(hapi peer GET /api/templates | jget "[t['text'].strip() for t in d if t['name']=='type-tester'][0]")" = "$1" ]; }
_ov() { [ "$(hapi peer GET /api/templates | jget "[t['overridden'] for t in d if t['name']=='type-tester'][0]")" = True ]; }

echo "-- a type and its template saved on the home reach the peer, which ignores its own file"
[ "$(hcode home POST /api/types/tester '{"description":"runs tests","harness":"claude","model":null,"effort":null}')" = 200 ] || fail "the home refused the type"
[ "$(hcode home POST /api/templates/type-tester '{"text":"Home template for testers.\n"}')" = 200 ] || fail "the home refused the template"
wait_until _text "Home template for testers."
wait_until _ov

echo "-- a template edited again on the home follows"
hapi home POST /api/templates/type-tester '{"text":"Second text.\n"}' >/dev/null
wait_until _text "Second text."

echo "-- the peer refuses to edit or reset a type template, and writes nothing"
OUT=$(hapi peer POST /api/templates/type-tester '{"text":"no"}')
[ "$(printf '%s' "$OUT" | jget "d['home'], 'live on home' in d['error']")" = "home True" ] || fail "POST /api/templates on the peer: $OUT"
[ "$(hcode peer POST /api/templates/type-tester '{"text":"no"}')" = 409 ] || fail "edit on the peer isn't a 409"
[ "$(hcode peer POST /api/templates/type-tester '{"reset":true}')" = 409 ] || fail "reset on the peer isn't a 409"
[ "$(cat "$TEST_TMP/peer/templates/type-tester.md")" = "peer-own template" ] || fail "the peer's template file changed"
_text "Second text." || fail "a refused write changed the peer's template"

echo "-- a template that isn't a type's stays on the machine"
[ "$(hcode peer POST /api/templates/mail-to-human '{"text":"local"}')" = 200 ] || fail "the peer refused a non-type template"
hapi peer POST /api/templates/mail-to-human '{"reset":true}' >/dev/null

echo "-- with the home stopped, the restarted peer keeps the cached template"
daemon_stop home
daemon_stop peer
daemon_up peer
_text "Second text." || fail "the peer lost its cached template"
# The home is down, so the peer can't see the type gone: its own type file stays (S-3079).
[ -e "$TEST_TMP/peer/templates/type-tester.md" ] || fail "the peer removed its type file with the home down"

echo "-- a type removed on the home takes its template from the peer"
daemon_up home
[ "$(hcode home DELETE /api/types/tester)" = 200 ] || fail "the home refused the removal"
[ -e "$TEST_TMP/home/templates/type-tester.md" ] && fail "the home kept the template file"
_gone() { [ "$(hapi peer GET /api/templates | jget "any(t['name']=='type-tester' for t in d)")" = False ]; }
_nofile() { [ ! -e "$TEST_TMP/peer/templates/type-tester.md" ]; }
# The cache is what a restarted peer reads, and listTemplates filters by the registry, so _gone alone can't see it.
_cache_gone() { python3 -c "import json,sys; sys.exit('type-tester' in json.load(open(sys.argv[1])).get('templates', {}))" "$TEST_TMP/peer/settings.shared.json"; }
wait_until _gone
wait_until _cache_gone
# The peer's own file for the type goes too, once the home has confirmed the type gone (S-3079).
wait_until _nofile

echo "PASS: type templates home"
