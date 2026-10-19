#!/bin/sh
# auth.humanStrict across two daemons (S-543): with strict on and auth.legacyPeerToken off at both, main
# relays the human's mail to an agent on twin and a terminal on twin, each with the peer token, so both
# work; the same relays with the shared token and x-stam-local (no peer token) are refused by twin.
# Free: a registered agent and a plain terminal, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    try: s = json.load(open(path))
    except Exception: s = {}
    s["peers"] = [{"name": other, "url": env(other)["STAM_URL"], "token": open(f"{tmp}/{other}/token").read().strip()}]
    s["auth"] = {"humanStrict": True, "legacyPeerToken": False}
    json.dump(s, open(path, "w"), indent=2)
PY
# Each daemon's peer token is created when it starts; the other's settings need it, so start, write, restart.
# The OpenCode server's token is a sha256 in STAM_HOME/opencode-token; a known one lets the test act as it.
OC=oc-test-token
daemon_up main
daemon_up twin
python3 - "$TEST_TMP" <<'PY'
import json, sys
tmp = sys.argv[1]
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"][0]["peerToken"] = open(f"{tmp}/{other}/peer-token").read().strip()
    json.dump(s, open(path, "w"), indent=2)
PY
for d in main twin; do on $d "$STAM" daemon stop >/dev/null 2>&1 || true; done
daemon_up main
daemon_up twin
# The daemon mints the OpenCode server's token when it starts; the test replaces its hash with a known one.
printf '%s' "$(printf '%s' "$OC" | sha256sum | cut -d' ' -f1)" >"$TEST_TMP/main/opencode-token"
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
TWIN_PEER=$(cat "$TEST_TMP/twin/peer-token")
J='content-type: application/json'; KEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
BOB=$(curl -s -X POST -H "authorization: Bearer $TWIN_TOKEN" -H "$J" -H "$KEY" -d '{"name":"bob","role":"test","harness":"claude"}' "$TWIN_URL/api/register" | jget "d['id']")
[ -n "$BOB" ] || fail "bob didn't register on twin"

echo "-- the human's mail to an agent on twin relays with the peer token"
[ "$(code -X POST -H "authorization: Bearer $MAIN_TOKEN" -H "$KEY" -H "$J" -d "{\"from\":\"human\",\"to\":\"$BOB\",\"subject\":\"hi\",\"body\":\"from kim\"}" "$MAIN_URL/api/mail")" = 200 ] || fail "the human's mail to twin was refused: $(cat "$TEST_TMP/body")"
curl -s -H "authorization: Bearer $TWIN_TOKEN" "$TWIN_URL/api/agents/$BOB/inbox" >"$TEST_TMP/inbox"; grep -q "\"subject\":\"hi\"" "$TEST_TMP/inbox" || fail "bob didn't get the mail on twin: $(head -c 400 "$TEST_TMP/inbox")"
FWD="{\"from\":\"human\",\"forwarded\":{\"from_name\":\"kim\"},\"to\":\"$BOB\",\"subject\":\"fwd\",\"body\":\"b\"}"
[ "$(code -X POST -H "authorization: Bearer $TWIN_TOKEN" -H 'x-stam-local: 1' -H "$J" -d "$FWD" "$TWIN_URL/api/mail")" = 403 ] || fail "twin took forwarded human mail from the shared token"
[ "$(code -X POST -H "authorization: Bearer $TWIN_PEER" -H 'x-stam-local: 1' -H "$J" -d "$FWD" "$TWIN_URL/api/mail")" = 200 ] || fail "twin refused forwarded human mail from the peer token: $(cat "$TEST_TMP/body")"

echo "-- a terminal on twin relays through main with the peer token"
SH=$(curl -s -X POST -H "authorization: Bearer $TWIN_TOKEN" -H "$KEY" -H "$J" -d '{}' "$TWIN_URL/api/shells" | jget "d['id']")
[ -n "$SH" ] || fail "no terminal on twin"
up() { _o=$(curl -s -i -m 4 -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' "$@" 2>/dev/null || true); case "$_o" in *' 101 '*) echo yes ;; *) echo no ;; esac; } # gitleaks:allow (RFC 6455's sample nonce)
# Under strict main doesn't relay the human's terminal: it answers 409 naming twin and its origin (S-544).
_o=$(curl -s -i -m 4 -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' -H "$KEY" "$MAIN_URL/api/shells/$SH/tty?machine=twin" 2>/dev/null || true) # gitleaks:allow (RFC 6455's sample nonce)
case "$_o" in *' 409 '*'"machine":"twin"'*'"origin"'*) ;; *) fail "the terminal relay wasn't a 409 naming twin: $_o";; esac
[ "$(up "$TWIN_URL/api/shells/$SH/tty?token=$TWIN_PEER")" = no ] || fail "twin opened a terminal for the peer token under strict"
[ "$(up "$TWIN_URL/api/shells/$SH/tty?token=$TWIN_TOKEN")" = no ] || fail "twin opened a terminal for the shared token under strict"
echo "-- a relayed shell create and a no-by agent control are 403 under strict"
[ "$(code -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H "$J" -d '{"machine":"twin"}' "$MAIN_URL/api/shells")" = 403 ] || fail "the shared token relayed a shell create: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "authorization: Bearer $MAIN_TOKEN" -H "$J" -d '{"child_notices":"none"}' "$MAIN_URL/api/agents/$BOB/set-child-notices")" = 403 ] || fail "a no-by agent control on twin's agent passed: $(cat "$TEST_TMP/body")"
echo "-- a human write from main's page to twin's own origin works end to end; reads and unlisted methods get no CORS"
acao() { tr -d '\r' <"$TEST_TMP/hdr" | sed -n 's/^access-control-allow-origin: //Ip'; }
_c=$(curl -s -m 5 -D "$TEST_TMP/hdr" -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "Origin: $MAIN_URL" -H "$KEY" -H 'x-stam-human: 1' -H "$J" -d '{"child_notices":"none"}' "$TWIN_URL/api/agents/$BOB/set-child-notices")
[ "$_c" = 200 ] || fail "the cross-origin control on twin wasn't 200 ($_c): $(cat "$TEST_TMP/body")"
[ "$(acao)" = "$MAIN_URL" ] || fail "the control's reply allows $(acao), not main's origin"
curl -s -m 5 -D "$TEST_TMP/hdr" -o /dev/null -H "Origin: $MAIN_URL" -H "$KEY" "$TWIN_URL/api/agents" || true
[ -z "$(acao)" ] || fail "a GET from a peer's page got allow-origin $(acao)"
[ "$(curl -s -m 5 -D "$TEST_TMP/hdr" -o /dev/null -w '%{http_code}' -X OPTIONS -H "Origin: $MAIN_URL" -H 'Access-Control-Request-Method: DELETE' "$TWIN_URL/api/agents/$BOB/kill")" = 403 ] || fail "a preflight for an unlisted method was answered"
[ -z "$(acao)" ] || fail "an unlisted method's preflight got allow-origin"

echo "-- main's /api/machines names twin's origin, computed by main, for the page to send human writes to"
curl -s -H "authorization: Bearer $MAIN_TOKEN" "$MAIN_URL/api/machines" | jget "[m.get('origin') for m in d if m['name']=='twin'][0]" | grep -q "^$TWIN_URL$" || fail "main's machines row for twin has no origin"
echo "-- a peer's page may open a terminal on twin, at twin's own origin; another site may not"
[ "$(up -H "$KEY" -H "Origin: $MAIN_URL" "$TWIN_URL/api/shells/$SH/tty")" = yes ] || fail "twin refused a terminal socket from its peer's page"
[ "$(up -H "$KEY" -H 'Origin: https://evil.example' "$TWIN_URL/api/shells/$SH/tty")" = no ] || fail "twin opened a terminal for another site"
echo "-- main names the origin its page opens twin's terminals at, only under strict"
curl -s -H "authorization: Bearer $MAIN_TOKEN" "$MAIN_URL/api/machines" | jget "[m.get('terminalOrigin') for m in d if m['name']=='twin'][0]" | grep -q "^$TWIN_URL$" || fail "main's machines row for twin has no terminalOrigin"
curl -s -H "authorization: Bearer $MAIN_TOKEN" "$MAIN_URL/api/machines" | jget "[m.get('terminalOrigin') for m in d if m['name']==m['name'] and 'terminalOrigin' in m and m['name']!='twin']" | grep -q '^\[\]$' || fail "main's own row has a terminalOrigin"

echo "-- a cross-site page can't open a terminal with the shared token under strict"
[ "$(up -H "$KEY" -H 'Origin: https://evil.example' "$TWIN_URL/api/shells/$SH/tty?token=$TWIN_TOKEN")" = no ] || fail "a cross-site socket with the shared token opened"

echo "-- the OpenCode server's token can't drive a peer's agent with no by"
OCH="authorization: Bearer $OC"
[ "$(code -X POST -H "$OCH" -H "$J" -d '{}' "$MAIN_URL/api/agents/$BOB/kill")" = 403 ] || fail "the OpenCode token killed twin's agent: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$OCH" -H "$J" -d '{"kind":"x"}' "$MAIN_URL/api/agents/$BOB/waits")" = 403 ] || fail "the OpenCode token added a wait to twin's agent: $(cat "$TEST_TMP/body")"
[ "$(code -X POST -H "$OCH" -H "$J" -d '{"event":"e"}' "$MAIN_URL/api/cost/ack")" = 403 ] || fail "the OpenCode token acked a cost notice: $(cat "$TEST_TMP/body")"
curl -s -o /dev/null -X POST -H "authorization: Bearer $TWIN_TOKEN" -H "$KEY" -H "$J" -d '{}' "$TWIN_URL/api/shells/$SH/kill" || true
echo PASS
