#!/bin/sh
# S-390 (S-380 change 2), free (no models, no agent turns). Two isolated daemons: "home", which holds
# the settings, and "peer", whose settings.json names home as its `home`. Checks:
#   - the peer gets the home's shared keys at boot; its own peers and itsa.repos stay its own
#   - only a peer may fetch the shared settings or say they changed (not an agent's token, even with
#     x-stam-local), and only the home serves them
#   - a change on the home reaches the peer through the push, with the poll set long
#   - an invalid settings.json on the home answers 503, and the peer keeps its cache
#   - with the home stopped, the peer boots and answers promptly on its cached copy, logging the
#     outage once; a third daemon ("lone") with no cache runs on the defaults
#   - the home's boot push brings a peer with a long poll up to date when the home comes back
#   - a hand edit on the home (no push) reaches a peer with a short poll
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home home
daemon_home peer
daemon_home lone
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
def save(name, s):
    json.dump(s, open(f"{tmp}/{name}/settings.json", "w"), indent=2)
# No resource warnings: their lastWarned write on the home would push, hiding whether the boot push works.
save("home", {"resourceWarn": {"enabled": False}, "peers": [peer("peer"), peer("lone")], "mail": {"titles": {"model": "home-model-1"}}, "itsa": {"repos": {"h": "/h"}}})
save("peer", {"home": "home", "peers": [peer("home")], "mail": {"titles": {"model": "peer-own"}}, "itsa": {"repos": {"p": "/p"}}})
save("lone", {"home": "home", "peers": [peer("home")]})
PY
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# eff DAEMON EXPR: a value of the daemon's effective settings as it reads them (a test route; EXPR in JS, on s).
eff() { curl -sf -m 5 -H "authorization: Bearer $(tok "$1")" "$(url "$1")/api/test/settings" | node -e "let t = ''; process.stdin.on('data', (c) => (t += c)).on('end', () => { const s = JSON.parse(t); console.log(JSON.stringify($2)); })"; }
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
tok() { cat "$TEST_TMP/$1/token"; }
api() { curl -s -m 5 -X "$2" -H "authorization: Bearer $(tok "$1")" -H 'content-type: application/json' ${4:+-d "$4"} "$(url "$1")$3"; }
# tapi: api for /api/test/* routes; -f fails at the call when the gate answers 404.
tapi() { curl -sf -m 5 -X "$2" -H "authorization: Bearer $(tok "$1")" -H 'content-type: application/json' ${4:+-d "$4"} "$(url "$1")$3"; }
ptok() { cat "$TEST_TMP/$1/peer-token"; }
# A call with x-stam-local is a peer's, so it carries the peer token (S-1064).
code() { _t=$(tok "$1"); case "$3" in *x-stam-local*) _t=$(ptok "$1") ;; esac; curl -s -m 5 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $_t" $3 "$(url "$1")$2"; }

# The human's PATCH on the home carries this test key (see trustedHuman).
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
# A long poll, so only boot and the push can move the peer.
export STAM_SETTINGS_SYNC_MS=600000
daemon_up home
daemon_up peer

echo "-- the peer gets the home's shared keys at boot, and keeps its own local keys"
_model() { [ "$(eff peer s.mail.titles.model)" = "\"$1\"" ]; }
wait_until _model home-model-1
[ "$(eff peer 's.peers.map((p) => p.name)')" = '["home"]' ] || fail "the peer's peers aren't its own: $(eff peer 's.peers')"
[ "$(eff peer '[s.itsa.repos.p, s.itsa.repos.h]')" = '["/p",null]' ] || fail "the peer's itsa.repos aren't its own: $(eff peer s.itsa.repos)"
[ "$(api peer GET /api/config/settings/sync | jget "d['stale'], d['home'], len(d['rev'])")" = "False home 64" ] || fail "sync state: $(api peer GET /api/config/settings/sync)"

echo "-- only a peer fetches the shared settings, and only from the home"
[ "$(code home /api/config/settings/shared)" = 403 ] || fail "a non-peer caller fetched the shared settings"
[ "$(code peer /api/config/settings/shared '-H x-stam-local:1')" = 409 ] || fail "a non-home daemon served shared settings"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $(tok peer)" -H 'content-type: application/json' -d '{}' "$(url peer)/api/config/settings/changed")" = 403 ] || fail "a non-peer said the settings changed"
# An agent's own token, with x-stam-local set, is still not a peer.
AGENT=$(api home POST /api/register '{"name":"tok","role":"test","harness":"claude"}' | jget "d['id']")
AGENT_TOKEN=agent-token-$AGENT
tapi home POST /api/test/agent "{\"agent\":\"$AGENT\",\"token\":\"$AGENT_TOKEN\"}" >/dev/null
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AGENT_TOKEN" "$(url home)/api/agents/$AGENT")" = 200 ] || fail "the agent's token isn't accepted at all"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AGENT_TOKEN" -H 'x-stam-local: 1' "$(url home)/api/config/settings/shared")" = 403 ] || fail "an agent's token fetched the shared settings"
SHARED=$(curl -s -H "authorization: Bearer $(ptok home)" -H 'x-stam-local: 1' "$(url home)/api/config/settings/shared")
[ "$(printf '%s' "$SHARED" | jget "'peers' in d['settings'], 'repos' in d['settings'].get('itsa', {}), d['settings']['mail']")" = "False False {'titles': {'model': 'home-model-1'}}" ] || fail "shared payload: $SHARED"
REV=$(printf '%s' "$SHARED" | jget "d['rev']")
[ "$(curl -s -H "authorization: Bearer $(ptok home)" -H 'x-stam-local: 1' "$(url home)/api/config/settings/shared?rev=$REV" | jget "d.get('unchanged')")" = True ] || fail "the same rev isn't answered unchanged"

echo "-- a change on the home reaches the peer through the push"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $(tok home)" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' -d '{"patch":{"mail":{"titles":{"model":"home-model-2"}}}}' "$(url home)/api/config/settings")" = 200 ] || fail "the home refused the patch"
wait_until _model home-model-2
[ "$(eff peer '[s.itsa.repos.p, s.itsa.repos.h]')" = '["/p",null]' ] || fail "the push changed the peer's itsa.repos"

echo "-- an invalid settings.json on the home answers 503, and the peer keeps its cache"
cp "$TEST_TMP/home/settings.json" "$TEST_TMP/home-settings.good"
printf '{ not json' >"$TEST_TMP/home/settings.json"
[ "$(code home /api/config/settings/shared '-H x-stam-local:1')" = 503 ] || fail "the home didn't answer 503 on an invalid file: $(code home /api/config/settings/shared '-H x-stam-local:1')"
# The home's push, as the home sends it, makes the peer fetch now.
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $(ptok peer)" -H 'x-stam-local: 1' -H 'content-type: application/json' -d '{"rev":"new"}' "$(url peer)/api/config/settings/changed")" = 200 ] || fail "the peer refused the home's push"
_failed() { api peer GET /api/config/settings/sync | jget "d['lastError'] or ''" | grep -q 503; }
wait_until _failed
_model home-model-2 || fail "the peer lost its cache on the home's invalid file: $(eff peer s.mail.titles.model)"
mv "$TEST_TMP/home-settings.good" "$TEST_TMP/home/settings.json"

echo "-- with the home stopped, the peer boots promptly on its cached copy"
outages() { grep -c "can't fetch the shared settings" "$TEST_TMP/peer/daemon.log"; }
BEFORE=$(outages)
daemon_stop home
daemon_stop peer
export STAM_SETTINGS_SYNC_MS=300
T0=$(date +%s)
daemon_up peer
[ "$(code peer /api/health)" = 200 ] || fail "the peer doesn't answer /api/health with its home down"
[ $(($(date +%s) - T0)) -le 6 ] || fail "the peer took $(($(date +%s) - T0)) s to boot with its home down"
_model home-model-2 || fail "the peer lost its cached value: $(eff peer s.mail.titles.model)"
_stale() { api peer GET /api/config/settings/sync | jget "d['stale'] and bool(d['lastError'])" | grep -qx True; }
wait_until _stale

echo "-- with no cache and the home down, a daemon runs on the defaults"
daemon_up lone
[ "$(code lone /api/health)" = 200 ] || fail "lone doesn't answer /api/health"
[ "$(eff lone s.mail.titles.model)" = '""' ] || fail "lone isn't on the default: $(eff lone s.mail.titles.model)"
[ ! -f "$TEST_TMP/lone/settings.shared.json" ] || fail "lone wrote a cache with its home down"
# The peer has polled the down home several times by now (every 300 ms).
[ "$(outages)" = $((BEFORE + 1)) ] || fail "the outage isn't logged once over several polls: $(($(outages) - BEFORE))"

echo "-- the home's boot push brings a peer with a long poll up to date"
# The peer restarts with a long poll while the home is down, so only the home's push can reach it.
daemon_stop peer
export STAM_SETTINGS_SYNC_MS=600000
daemon_up peer
wait_until _stale
edit_home() {
  python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); s["mail"]["titles"]["model"] = sys.argv[2]; json.dump(s, open(sys.argv[1], "w"), indent=2)' "$TEST_TMP/home/settings.json" "$1"
}
edit_home home-model-3
daemon_up home
wait_until _model home-model-3
_fresh() { api peer GET /api/config/settings/sync | jget "d['stale']" | grep -qx False; }
wait_until _fresh
grep -q "settings sync: home reached again" "$TEST_TMP/peer/daemon.log" || fail "the peer didn't log the home coming back"
_lone() { [ "$(eff lone s.mail.titles.model)" = "\"$1\"" ]; }
wait_until _lone home-model-3

echo "-- a hand edit on the home, which pushes nothing, reaches a peer on the poll"
edit_home home-model-4
wait_until _lone home-model-4
_model home-model-3 || fail "the long-poll peer changed without a push: $(eff peer s.mail.titles.model)"

echo "PASS: settings sync"
