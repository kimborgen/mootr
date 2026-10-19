#!/bin/sh
# S-398 (S-380 change 3), free (no models, no agent turns). Two isolated daemons: "home", which holds
# the settings, and "peer", whose settings.json names home as its `home`. Shared settings are edited
# on the home only: a non-home daemon writes its local keys and refuses the rest. Checks:
#   - the human's PATCH of a shared key on the peer gets 409 naming the home; neither file changes
#   - a PATCH of local keys on the peer is written there and doesn't reach the home
#   - a mixed itsa patch (repos and keyPrefix) gets 409, and nothing of it is written
#   - a `fill` patch (a browser's views moving in) that adds no view id succeeds; one that adds an id
#     the home lacks gets 409
#   - GET on the peer shows the merged text with local, home and stale; a POST of that text back with
#     only a local edit works, and one with a shared edit gets 409
#   - the home refuses the shared token with x-stam-local and x-stam-human, as before (S-230)
#   - the chief of staff's ask about a shared key on the peer gets 409 and makes no request; its ask
#     about a local key is made, and the human's approval writes it on the peer only; its POST of its
#     own redacted GET with a local edit is an ask, not a 409, and its approval keeps the secrets
#   - setSetting on the peer writes resourceWarn.lastWarned locally without a warning, drops a
#     shared key with one, and the home's file doesn't change
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
save("home", {"resourceWarn": {"enabled": False}, "peers": [peer("peer")], "mail": {"titles": {"model": "m1"}}, "itsa": {"keyPrefix": "H", "repos": {"h": "/h"}}, "debug": {"stallMs": 100}, "mcpServers": {"probe": {"command": "true", "env": {"K": "SECRET-1"}}}, "boardViews": {"v1": {"name": "one"}}})
save("peer", {"home": "home", "peers": [peer("home")], "itsa": {"repos": {"p": "/p"}}})
PY
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# eff DAEMON EXPR: a value of the daemon's settings() as its daemon reads them (EXPR in JS, on s).
eff() { on "$1" node --input-type=module -e "const { settings } = await import('$ROOT/src/settings.ts'); const s = settings(); console.log(JSON.stringify($2));" 2>/dev/null; }
# file DAEMON EXPR: a value of the daemon's settings.json as written (EXPR in Python, on s).
file() { python3 -c "import json,sys; s=json.load(open(sys.argv[1])); print(json.dumps($2))" "$TEST_TMP/$1/settings.json"; }
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
tok() { cat "$TEST_TMP/$1/token"; }
api() { curl -s -m 5 -X "$2" -H "authorization: Bearer $(tok "$1")" -H 'content-type: application/json' ${4:+-d "$4"} "$(url "$1")$3"; }
# human DAEMON METHOD PATH BODY: the human's request (the test key stands in for tailscale serve);
# prints the body, then the status on its own line.
human() { curl -s -m 15 -w '\n%{http_code}' -X "$2" -H "authorization: Bearer $(tok "$1")" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' -d "$4" "$(url "$1")$3"; }
status() { printf '%s\n' "$1" | tail -1; }
body() { printf '%s\n' "$1" | head -n -1; }
# agent_token DAEMON NAME: registers an agent there and prints its id and the token it now holds.
agent_token() {
  id=$(api "$1" POST /api/register "{\"name\":\"$2\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']")
  on "$1" node --input-type=module -e "
    const { DatabaseSync } = await import('node:sqlite'); const { createHash } = await import('node:crypto');
    new DatabaseSync(process.env.STAM_HOME + '/stam.db').prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(createHash('sha256').update('agent-token-$id').digest('hex'), '$id');" 2>/dev/null
  echo "$id agent-token-$id"
}
snapshot() { HOME_FILE=$(cat "$TEST_TMP/home/settings.json"); PEER_FILE=$(cat "$TEST_TMP/peer/settings.json"); }
unchanged() {
  [ "$(cat "$TEST_TMP/home/settings.json")" = "$HOME_FILE" ] || fail "$1: the home's file changed"
  [ "$(cat "$TEST_TMP/peer/settings.json")" = "$PEER_FILE" ] || fail "$1: the peer's file changed"
}
# refused RESPONSE: a 409 whose body names the home.
refused() { [ "$(status "$1")" = 409 ] && body "$1" | jget "d['home']" | grep -qx home && body "$1" | grep -q "live on home"; }

STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
export STAM_SETTINGS_SYNC_MS=600000
daemon_up home
daemon_up peer
_model() { [ "$(eff peer s.mail.titles.model)" = "\"$1\"" ]; }
wait_until _model m1

echo "-- a shared PATCH on the peer gets 409 naming the home, and nothing is written"
snapshot
R=$(human peer PATCH /api/config/settings '{"patch":{"mail":{"titles":{"model":"m2"}}}}')
refused "$R" || fail "a shared patch on the peer wasn't a 409 naming the home: $R"
unchanged "a shared patch"
_model m1 || fail "the peer's settings changed"

echo "-- a local PATCH on the peer is written there only"
R=$(human peer PATCH /api/config/settings '{"patch":{"debug":{"stallMs":250},"itsa":{"repos":{"p2":"/p2"}}}}')
[ "$(status "$R")" = 200 ] || fail "the peer refused a local patch: $R"
[ "$(body "$R" | jget "json.loads(d['text'])['debug']['stallMs'], json.loads(d['text'])['mail']['titles']['model']")" = "250 m1" ] || fail "the answer isn't the merged text: $R"
[ "$(file peer "[s['debug']['stallMs'], s['itsa']['repos']]")" = '[250, {"p2": "/p2"}]' ] || fail "the peer's file: $(file peer s)"
[ "$(cat "$TEST_TMP/home/settings.json")" = "$HOME_FILE" ] || fail "a local patch reached the home"
[ "$(eff peer '[s.debug.stallMs, s.itsa.keyPrefix, s.itsa.repos.p2]')" = '[250,"H","/p2"]' ] || fail "the peer's merged settings: $(eff peer s.itsa)"

echo "-- a mixed itsa PATCH gets 409, and nothing of it is written"
snapshot
R=$(human peer PATCH /api/config/settings '{"patch":{"itsa":{"keyPrefix":"P","repos":{"p3":"/p3"}}}}')
refused "$R" || fail "a mixed patch wasn't a 409: $R"
unchanged "a mixed patch"

echo "-- a fill PATCH succeeds unless it adds a view id the home lacks"
snapshot
R=$(human peer PATCH /api/config/settings '{"patch":{"boardViews":{"v1":{"name":"browser copy"}},"mail":{"titles":{"model":"ignored"}}},"fill":true}')
[ "$(status "$R")" = 200 ] || fail "a no-op fill on the peer failed: $R"
unchanged "a no-op fill"
R=$(human peer PATCH /api/config/settings '{"patch":{"boardViews":{"v2":{"name":"two"}}},"fill":true}')
refused "$R" || fail "a fill adding a view id wasn't a 409: $R"
unchanged "a fill adding a view id"

echo "-- GET on the peer shows the merged text, local, home and stale; a POST round-trips local edits only"
G=$(api peer GET /api/config/settings)
[ "$(printf '%s' "$G" | jget "d['home'], d['stale'], 'itsa.repos' in d['local'], 'peers' in d['local']")" = "home False True True" ] || fail "GET on the peer: $G"
[ "$(printf '%s' "$G" | jget "json.loads(d['text'])['mail']['titles']['model'], json.loads(d['text'])['itsa']")" = "m1 {'keyPrefix': 'H', 'repos': {'p2': '/p2'}}" ] || fail "GET text isn't merged: $G"
[ "$(api home GET /api/config/settings | jget "sorted(d)")" = "['fetchedAt', 'home', 'local', 'stale', 'text']" ] || fail "the home's GET changed shape"
[ "$(api home GET /api/config/settings | jget "d['home'] + str(d['stale'])")" = "homeFalse" ] || fail "the home's GET doesn't name the home"
# post_body PYTHON: the GET's text with PYTHON applied to it (on s), as a POST body.
post_body() { printf '%s' "$G" | python3 -c '
import json, sys
s = json.loads(json.load(sys.stdin)["text"])
exec(sys.argv[1])
print(json.dumps({"text": json.dumps(s, indent=2)}))' "$1"; }
R=$(human peer POST /api/config/settings "$(post_body 's["debug"]["stallMs"] = 300')")
[ "$(status "$R")" = 200 ] || fail "the POST of the merged text with a local edit failed: $R"
[ "$(file peer "[s['debug']['stallMs'], s['itsa']['repos']]")" = '[300, {"p2": "/p2"}]' ] || fail "the POST's local part on the peer: $(file peer s)"
[ "$(cat "$TEST_TMP/home/settings.json")" = "$HOME_FILE" ] || fail "a local POST reached the home"
snapshot
R=$(human peer POST /api/config/settings "$(post_body 's["debug"]["stallMs"] = 310; s["mail"]["titles"]["model"] = "m4"')")
refused "$R" || fail "a POST with a shared edit wasn't a 409: $R"
unchanged "a POST with a shared edit"

echo "-- the home refuses the shared token claiming the human through a peer's headers"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $(tok home)" -H 'x-stam-local: 1' -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"patch":{"mail":{"titles":{"model":"bad"}}}}' "$(url home)/api/config/settings")" = 403 ] || fail "the home took a forwarded-human write"
unchanged "a forwarded-human write"

echo "-- the chief of staff's ask on the peer: 409 for a shared key, made for a local one"
set -- $(agent_token peer cos)
COS_ID=$1 COS_TOKEN=$2
# chiefOfStaff is shared, so it is named on the home; the peer reads it from its cache.
[ "$(status "$(human home PATCH /api/config/settings "{\"patch\":{\"chiefOfStaff\":\"$COS_ID\"}}")")" = 200 ] || fail "the human couldn't name the chief of staff on the home"
_cos() { [ "$(eff peer s.chiefOfStaff)" = "\"$COS_ID\"" ]; }
wait_until _cos
G=$(api peer GET /api/config/settings)
snapshot
as_cos() { curl -s -m 5 -w '\n%{http_code}' -X "$1" -H "authorization: Bearer $COS_TOKEN" -H 'content-type: application/json' -d "$3" "$(url peer)$2"; }
pending() { api peer GET "/api/permissions?status=pending" | jget "len(d)"; }
R=$(as_cos PATCH /api/config/settings '{"patch":{"mail":{"titles":{"model":"m3"}}}}')
refused "$R" || fail "the chief of staff's shared ask wasn't a 409: $R"
R=$(as_cos POST /api/config/settings "$(post_body 's["mail"]["titles"]["model"] = "m3"')")
refused "$R" || fail "the chief of staff's shared POST ask wasn't a 409: $R"
[ "$(pending)" = 0 ] || fail "a shared ask was made"
unchanged "a shared ask"
R=$(as_cos PATCH /api/config/settings '{"patch":{"debug":{"stallMs":350},"itsa":{"repos":{"ask":"/ask"}}}}')
[ "$(status "$R")" = 202 ] || fail "the chief of staff's local ask wasn't a 202: $R"
REQ=$(body "$R" | jget "d['requested']")
# The diff the human approves shows only what the peer will write: not itsa's shared keys going away.
api peer GET "/api/permissions?status=pending" | python3 -c '
import json, sys
d = next(x for x in json.load(sys.stdin) if x["id"] == sys.argv[1])["details"]
assert "+    \"stallMs\": 350" in d and "\"ask\": \"/ask\"" in d, d
assert not any("keyPrefix" in l for l in d.splitlines() if l.startswith("-")), d' "$REQ" || fail "the ask's diff shows more than the local change"
unchanged "a local ask before approval"
[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $(tok peer)" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"approve":true}' "$(url peer)/api/permissions/$REQ/answer")" = 200 ] || fail "the human's approval failed"
[ "$(file peer "[s['debug']['stallMs'], s['itsa']['repos']]")" = '[350, {"ask": "/ask"}]' ] || fail "the approved local change wasn't written: $(file peer s)"
[ "$(cat "$TEST_TMP/home/settings.json")" = "$HOME_FILE" ] || fail "the approved local change reached the home"
api peer GET /api/permissions | jget "next(x for x in d if x['id'] == '$REQ')['status']" | grep -qx approved || fail "the ask isn't recorded as approved"
# The chief of staff's GET is redacted; its POST of that text with a local edit is still local.
RG=$(curl -s -m 5 -H "authorization: Bearer $COS_TOKEN" "$(url peer)/api/config/settings")
printf '%s' "$RG" | grep -q SECRET-1 && fail "the chief of staff read a secret"
RBODY=$(printf '%s' "$RG" | python3 -c '
import json, sys
s = json.loads(json.load(sys.stdin)["text"])
s["itsa"]["repos"] = {"cos": "/cos"}
print(json.dumps({"text": json.dumps(s, indent=2)}))')
# rg_body PYTHON: cos's redacted GET with PYTHON applied (on s), as a POST body.
rg_body() { printf '%s' "$RG" | python3 -c '
import json, sys
s = json.loads(json.load(sys.stdin)["text"])
exec(sys.argv[1])
print(json.dumps({"text": json.dumps(s, indent=2)}))' "$1"; }
R=$(as_cos POST /api/config/settings "$(rg_body 's["itsa"]["repos"] = {"cos": "/cos"}; s["mail"]["titles"]["model"] = "m9"')")
refused "$R" || fail "the chief of staff's redacted POST with a shared edit wasn't a 409: $R"
R=$(as_cos POST /api/config/settings "$(rg_body 's["mcpServers"]["probe"]["command"] = "other"')")
[ "$(status "$R")" = 400 ] || fail "a changed command keeping a redacted env wasn't a 400: $R"
[ "$(pending)" = 0 ] || fail "a refused redacted POST made an ask"
PEER_TOKEN_BEFORE=$(file peer "s['peers'][0]['token']")
R=$(as_cos POST /api/config/settings "$RBODY")
[ "$(status "$R")" = 202 ] || fail "the chief of staff's redacted round-trip wasn't an ask: $R"
REQ=$(body "$R" | jget "d['requested']")
[ "$(curl -s -m 15 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $(tok peer)" -H 'x-stam-human: 1' -H 'content-type: application/json' -d '{"approve":true}' "$(url peer)/api/permissions/$REQ/answer")" = 200 ] || fail "approving the redacted round-trip failed"
[ "$(file peer "s['itsa']['repos']")" = '{"cos": "/cos"}' ] || fail "the redacted round-trip's local edit wasn't written: $(file peer s)"
[ "$(file peer "s['peers'][0]['token']")" = "$PEER_TOKEN_BEFORE" ] || fail "the approval wrote a redacted peer token"
[ "$(cat "$TEST_TMP/home/settings.json")" = "$HOME_FILE" ] || fail "the redacted round-trip reached the home"

echo "-- setSetting on the peer writes local parts only"
snapshot
on peer node --input-type=module -e "
  const { settings, setSetting } = await import('$ROOT/src/settings.ts');
  setSetting('resourceWarn', { ...settings().resourceWarn, lastWarned: { cpu: 123 } });
  setSetting('chiefOfStaff', 'someone-else');" 2>"$TEST_TMP/setsetting.err"
[ "$(file peer "s['resourceWarn']['lastWarned']")" = '{"cpu": 123}' ] || fail "resourceWarn.lastWarned wasn't written on the peer: $(file peer s)"
[ "$(file peer "s.get('chiefOfStaff')")" = "$(printf '%s' "$PEER_FILE" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin).get('chiefOfStaff')))")" ] || fail "a shared setSetting wrote the peer's file"
grep -q "chiefOfStaff is shared and lives on home" "$TEST_TMP/setsetting.err" || fail "the dropped shared setSetting wasn't warned: $(cat "$TEST_TMP/setsetting.err")"
grep -q "resourceWarn" "$TEST_TMP/setsetting.err" && fail "resourceWarn bookkeeping warned: $(cat "$TEST_TMP/setsetting.err")"
[ "$(cat "$TEST_TMP/home/settings.json")" = "$HOME_FILE" ] || fail "setSetting on the peer touched the home's file"

echo "PASS: settings writes"
