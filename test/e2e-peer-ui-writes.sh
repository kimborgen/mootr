#!/bin/sh
# S-414, free (no models, no agent turns). A peer's web UI writes shared settings, agent types and the
# instructions for all agents straight to the settings home, from the browser, at the home's own web
# origin; the home checks trustedHuman as for its own page. Two isolated daemons: "home" (its web origin
# is its URL, STAM_WEB_ORIGIN) and "peer", whose settings name home as its `home`. The browser is played
# with curl and an Origin header; the test key stands in for tailscale serve. Checks:
#   - the peer's GET /api/config/settings gives the home's web origin (homeWeb)
#   - the home answers a preflight from the peer's UI origin for the shared writes only, and refuses
#     other origins and other routes
#   - a PATCH from the peer's origin as the human changes shared keys on the home, keeps the home's own
#     local keys, and carries Access-Control-Allow-Origin; types and instructions save and delete too
#   - MCP servers, a rebound Host, and writes without the human's proof, from another site, without x-stam-human, or not as JSON, it is refused
#     and writes nothing
#   - the peer's localOnly PATCH writes its local keys and ignores shared ones; /sync fetches the home's copy
#   - with the home stopped the peer still says where the home is, and its own shared writes stay refused
#   - a daemon whose tailscale serve shows up after boot lets a request naming the serve host in
#   - a tailscale that takes 5 s doesn't hold up a token-less request (S-439)
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
save("home", {"resourceWarn": {"enabled": False}, "peers": [peer("peer")], "itsa": {"repos": {"own": "/home-repo"}}, "humanMail": {"when": "necessary"}})
save("peer", {"home": "home", "peers": [peer("home")]})
PY
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
echo "export STAM_WEB_ORIGIN=$(url home)" >>"$TEST_TMP/home/test.env"
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
tok() { cat "$TEST_TMP/$1/token"; }
HOME_URL=$(url home)
PEER_ORIGIN=$(url peer)
hapi() { curl -s -m 5 -X "$2" -H "authorization: Bearer $(tok "$1")" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' ${4:+-d "$4"} "$(url "$1")$3"; }
# ui METHOD PATH BODY [HEADER...]: the peer's page writing to the home: no token, the peer's Origin.
ui() { _m=$1 _p=$2 _b=$3; shift 3; curl -s -m 5 -D "$TEST_TMP/hdr" -o "$TEST_TMP/body" -w '%{http_code}' -X "$_m" -H "Origin: $PEER_ORIGIN" "$@" ${_b:+-d "$_b"} "$HOME_URL$_p"; }
human_ui() { ui "$@" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json'; }
acao() { tr -d '\r' <"$TEST_TMP/hdr" | sed -n 's/^access-control-allow-origin: //Ip'; }
preflight() { curl -s -m 5 -D "$TEST_TMP/hdr" -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $1" -H "Access-Control-Request-Method: $2" -H 'Access-Control-Request-Headers: content-type, x-stam-human' "$HOME_URL$3"; }
home_file() { python3 -c "import json; d=json.load(open('$TEST_TMP/home/settings.json')); print($1)"; }

STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
export STAM_SETTINGS_SYNC_MS=600000
daemon_up home
daemon_up peer

echo "-- the peer's settings name the home's web origin"
_web() { [ "$(hapi peer GET /api/config/settings | jget "d.get('homeWeb')")" = "$HOME_URL" ]; }
wait_until _web
[ "$(hapi home GET /api/config/settings | jget "'homeWeb' in d")" = False ] || fail "the home names a homeWeb for itself"

echo "-- the home answers a preflight from the peer's page for the shared writes only"
[ "$(preflight "$PEER_ORIGIN" PATCH /api/config/settings)" = 204 ] || fail "no preflight for PATCH settings"
[ "$(acao)" = "$PEER_ORIGIN" ] || fail "preflight allow-origin: $(acao)"
tr -d '\r' <"$TEST_TMP/hdr" | grep -qi '^access-control-allow-headers:.*x-stam-human' || fail "preflight doesn't allow x-stam-human"
[ "$(preflight "$PEER_ORIGIN" POST /api/types/x)" = 204 ] || fail "no preflight for a type save"
[ "$(preflight "$PEER_ORIGIN" DELETE /api/types/x)" = 204 ] || fail "no preflight for a type removal"
[ "$(preflight "$PEER_ORIGIN" POST /api/config/instructions)" = 204 ] || fail "no preflight for the instructions"
[ "$(preflight "$PEER_ORIGIN" POST /api/config/registry)" = 403 ] || fail "a preflight for the raw registry was answered"
[ "$(preflight "$PEER_ORIGIN" POST /api/agents)" = 403 ] || fail "a preflight for a spawn was answered"
[ "$(preflight https://evil.example PATCH /api/config/settings)" = 403 ] || fail "a preflight from another site was answered"
[ -z "$(acao)" ] || fail "a refused preflight carries allow-origin"

echo "-- a PATCH from the peer's page as the human changes shared keys only, on the home"
CODE=$(human_ui PATCH /api/config/settings '{"patch":{"humanMail":{"when":"often"},"itsa":{"home":"peer","repos":{},"wip":4},"peers":[]}}')
[ "$CODE" = 200 ] || fail "the home refused the peer page's PATCH: $CODE $(cat "$TEST_TMP/body")"
[ "$(acao)" = "$PEER_ORIGIN" ] || fail "the reply has no allow-origin"
[ "$(home_file "d['humanMail']['when'], d['itsa'].get('wip'), d['itsa']['repos'], len(d['peers']), d.get('itsa', {}).get('home')")" = "often 4 {'own': '/home-repo'} 1 None" ] || fail "the home's settings: $(cat "$TEST_TMP/home/settings.json")"
jget "'peers' in json.loads(d['text'])" <"$TEST_TMP/body" | grep -q False || fail "the reply shows the home's local keys"

echo "-- types and instructions saved from the peer's page land on the home and reach the peer"
[ "$(human_ui POST /api/types/tester '{"description":"runs tests","harness":"claude","model":null,"effort":null}')" = 200 ] || fail "type save: $(cat "$TEST_TMP/body")"
[ "$(human_ui POST /api/config/instructions '{"text":"From the peer page.\n"}')" = 200 ] || fail "instructions save: $(cat "$TEST_TMP/body")"
[ "$(cat "$TEST_TMP/home/instructions.md")" = "From the peer page." ] || fail "the home's instructions.md"
hapi peer POST /api/config/settings/sync >/dev/null
[ "$(hapi peer GET /api/registry | jget "'tester' in d['types']")" = True ] || fail "the peer doesn't have the new type after sync"
[ "$(hapi peer GET /api/config/settings | jget "json.loads(d['text'])['humanMail']['when']")" = often ] || fail "the peer doesn't have the shared change after sync"
[ "$(human_ui DELETE /api/types/tester '')" = 200 ] || fail "type removal: $(cat "$TEST_TMP/body")"

echo "-- refused without the human's proof, from another site, without x-stam-human, or not JSON"
BEFORE=$(cat "$TEST_TMP/home/settings.json")
[ "$(ui PATCH /api/config/settings '{"patch":{"humanMail":{"when":"never"}}}' -H 'x-stam-human: 1' -H 'content-type: application/json')" = 403 ] || fail "a PATCH without the human's proof wasn't refused"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X PATCH -H 'Origin: https://evil.example' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"patch":{"humanMail":{"when":"never"}}}' "$HOME_URL/api/config/settings")" = 403 ] || fail "a PATCH from another site wasn't refused"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://evil.example' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"text":"x"}' "$HOME_URL/api/config/instructions")" = 403 ] || fail "instructions from another site weren't refused"
[ "$(ui PATCH /api/config/settings '{"patch":{"humanMail":{"when":"never"}}}' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json')" = 403 ] || fail "a PATCH without x-stam-human wasn't refused"
[ "$(ui PATCH /api/config/settings '{"patch":{"humanMail":{"when":"never"}}}' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: text/plain')" = 415 ] || fail "a text/plain PATCH wasn't refused"
[ "$(ui POST /api/config/registry '{"text":"{}"}' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json')" = 403 ] || fail "a raw registry write from the peer's page wasn't refused"
[ "$(cat "$TEST_TMP/home/settings.json")" = "$BEFORE" ] || fail "a refused write changed the home's settings"
[ "$(cat "$TEST_TMP/home/instructions.md")" = "From the peer page." ] || fail "a refused write changed the home's instructions"
# Without a token, the tailnet identity alone counts only from the daemon's own page.
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$HOME_URL/api/agents")" = 403 ] || fail "a token-less read from another site wasn't refused"
# DNS rebinding: a token-less request naming another host is refused, even with its own Origin.
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: evil.example:80' -H 'Origin: http://evil.example:80' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$HOME_URL/api/agents")" = 403 ] || fail "a rebound host was accepted"
# MCP servers name commands every machine runs: never from a peer's page.
[ "$(human_ui PATCH /api/config/settings '{"patch":{"mcpServers":{"x":{"command":"true"}}}}')" = 403 ] || fail "mcpServers from the peer's page wasn't refused"
# A token still works from anywhere, as before.
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Origin: https://evil.example' -H "authorization: Bearer $(tok home)" "$HOME_URL/api/agents")" = 200 ] || fail "a token's read with a foreign Origin was refused"

echo "-- the peer's localOnly PATCH writes its local keys and ignores shared ones"
OUT=$(hapi peer PATCH /api/config/settings '{"patch":{"itsa":{"home":"home","repos":{"p":"/peer-repo"},"wip":9},"humanMail":{"when":"never"}},"localOnly":true}')
python3 -c "import json; d=json.load(open('$TEST_TMP/peer/settings.json')); assert d['itsa']['repos']=={'p':'/peer-repo'}, d; assert d.get('humanMail', {}).get('when') != 'never', d" || fail "the peer's file after localOnly: $OUT"
[ "$(home_file "d['humanMail']['when']")" = often ] || fail "a peer's localOnly PATCH reached the home"
[ "$(hapi peer PATCH /api/config/settings '{"patch":{"humanMail":{"when":"never"}}}' | jget "d.get('home')")" = home ] || fail "the peer's plain shared PATCH isn't refused naming the home"

echo "-- the peer's page can't write to the peer as if it were the home"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $HOME_URL" -H 'Access-Control-Request-Method: PATCH' "$PEER_ORIGIN/api/config/settings")" = 403 ] || fail "the peer answered a preflight from the home's origin"

echo "-- the human's writes for a machine's own agents are answered on any daemon, from a peer's page (S-544)"
# The home's page writing straight to the peer, a daemon that is not the settings home.
pui() { _m=$1 _p=$2 _b=$3; shift 3; curl -s -m 5 -D "$TEST_TMP/hdr" -o "$TEST_TMP/body" -w '%{http_code}' -X "$_m" -H "Origin: $HOME_URL" "$@" ${_b:+-d "$_b"} "$PEER_ORIGIN$_p"; }
ppre() { curl -s -m 5 -D "$TEST_TMP/hdr" -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $1" -H "Access-Control-Request-Method: $2" -H 'Access-Control-Request-Headers: content-type, x-stam-human' "$PEER_ORIGIN$3"; }
for r in "POST /api/permissions/p1/answer" "POST /api/itsas/S-1/act" "PATCH /api/itsas/S-1" "POST /api/agents/a1/kill" "POST /api/agents/a1/prompt"; do
  set -- $r
  [ "$(ppre "$HOME_URL" "$1" "$2")" = 204 ] || fail "no preflight on the peer for $r"
  [ "$(acao)" = "$HOME_URL" ] || fail "preflight allow-origin for $r: $(acao)"
done
for r in "POST /api/agents" "POST /api/mail" "PATCH /api/config/settings" "POST /api/shells"; do
  set -- $r
  [ "$(ppre "$HOME_URL" "$1" "$2")" = 403 ] || fail "the peer answered a preflight for $r"
done
[ "$(ppre https://evil.example POST /api/agents/a1/kill)" = 403 ] || fail "a preflight from another site was answered"
KID=$(hapi peer POST /api/register '{"name":"kid","role":"test","harness":"claude"}' | jget "d['id']")
[ -n "$KID" ] || fail "no agent on the peer"
CTRL='{"child_notices":"none"}'
[ "$(pui POST "/api/agents/$KID/set-child-notices" "$CTRL" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: application/json')" = 200 ] || fail "the human's control from the home's page was refused: $(cat "$TEST_TMP/body")"
[ "$(acao)" = "$HOME_URL" ] || fail "the control's reply has no allow-origin"
[ "$(pui POST "/api/agents/$KID/set-child-notices" "$CTRL" -H 'x-stam-human: 1' -H 'content-type: application/json')" = 403 ] || fail "a control without the human's proof wasn't refused"
[ "$(pui POST "/api/agents/$KID/set-child-notices" "$CTRL" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json')" = 403 ] || fail "a control without x-stam-human wasn't refused"
[ "$(pui POST "/api/agents/$KID/set-child-notices" "$CTRL" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -H 'content-type: text/plain')" = 415 ] || fail "a text/plain control wasn't refused"

echo "-- with the home stopped, the peer keeps the home's web origin"
daemon_stop home
daemon_stop peer
daemon_up peer
[ "$(hapi peer GET /api/config/settings | jget "d.get('homeWeb'), d['stale']")" = "$HOME_URL True" ] || fail "the peer lost homeWeb: $(hapi peer GET /api/config/settings | jget "d.get('homeWeb')")"

echo "-- a tailscale serve found after boot lets the human's page in, with no restart"
# A fake tailscale on PATH whose serve config appears only once the file is written.
daemon_home solo
mkdir -p "$TEST_TMP/fakebin"
cat >"$TEST_TMP/fakebin/tailscale" <<'SH'
#!/bin/sh
[ "$1 $2" = "serve status" ] || exit 1
[ -f "$FAKE_TS_SERVE" ] && cat "$FAKE_TS_SERVE" || echo '{}'
SH
chmod +x "$TEST_TMP/fakebin/tailscale"
echo "export PATH='$TEST_TMP/fakebin':\"\$PATH\" FAKE_TS_SERVE='$TEST_TMP/solo/serve.json' STAM_WEB_RETRY_MS=500" >>"$TEST_TMP/solo/test.env"
daemon_up solo
SOLO_URL=$(url solo)
SOLO_PORT=${SOLO_URL##*:}
served() { curl -s -m 5 -o /dev/null -w '%{http_code}' -H 'Host: solo.example.com' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$SOLO_URL/api/agents"; }
[ "$(served)" = 403 ] || fail "a host the daemon doesn't know yet was let in"
printf '{"Web":{"solo.example.com:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}\n' "$SOLO_PORT" >"$TEST_TMP/solo/serve.json"
_in() { [ "$(served)" = 200 ]; }
wait_until _in
daemon_stop solo

echo "-- a tailscale that takes 5 s doesn't hold up a token-less request"
# S-439: only `serve status` is slow (tailscale's owner lookup at boot is not under test). Discovery runs
# in the background, so a request reads the last result and never waits on tailscale.
daemon_home slow
mkdir -p "$TEST_TMP/slowbin"
printf '#!/bin/sh\n[ "$1 $2" = "serve status" ] && exec sleep 5\necho {}\n' >"$TEST_TMP/slowbin/tailscale"
chmod +x "$TEST_TMP/slowbin/tailscale"
echo "export PATH='$TEST_TMP/slowbin':\"\$PATH\" STAM_WEB_RETRY_MS=500" >>"$TEST_TMP/slow/test.env"
daemon_up slow
SLOW_URL=$(url slow)
READ=$(curl -s -m 5 -o /dev/null -w '%{http_code} %{time_total}' -H "Host: 127.0.0.1:${SLOW_URL##*:}" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" "$SLOW_URL/api/agents")
[ "${READ%% *}" = 200 ] || fail "the token-less GET isn't answered: $READ"
python3 -c "import sys; sys.exit(0 if float('${READ##* }') < 1 else 1)" || fail "a token-less GET took ${READ##* } s behind a slow tailscale"
daemon_stop slow

echo "PASS: peer ui writes"
