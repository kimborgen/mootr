#!/bin/sh
# Under auth.humanStrict (S-544) the 409 for the human's answer to another machine's permission request
# names the machine that holds it, not the first peer: main has two peers, "alpha" first and "beta" second,
# the request is on beta. Main asks each peer as a non-human; a peer without the request says so before
# any auth check. With `by: "human"` the answer finds the same holder. Free: registered agent, no models.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home alpha
daemon_home beta
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
def save(name, s):
    path = f"{tmp}/{name}/settings.json"
    try: cur = json.load(open(path))
    except Exception: cur = {}
    cur.update(s)
    json.dump(cur, open(path, "w"), indent=2)
save("main", {"peers": [peer("alpha"), peer("beta")], "auth": {"humanStrict": True, "legacyPeerToken": False}})
save("alpha", {"peers": [peer("main")]})
save("beta", {"peers": [peer("main")]})
PY
daemon_up main
daemon_up alpha
daemon_up beta
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
url() { on "$1" sh -c 'echo "$STAM_URL"'; }
MAIN_URL=$(url main); BETA_URL=$(url beta); BETA_TOKEN=$(cat "$TEST_TMP/beta/token")
J='content-type: application/json'; KEY="x-stam-test-human: $STAM_TEST_HUMAN_KEY"
code() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' "$@"; }
AG=$(curl -s -X POST -H "authorization: Bearer $BETA_TOKEN" -H "$J" -H 'x-stam-human: 1' -d '{"name":"bob","role":"test","harness":"claude"}' "$BETA_URL/api/register" | jget "d['id']")
P=$(curl -s -X POST -H "authorization: Bearer $BETA_TOKEN" -H "$J" -d "{\"agent\":\"$AG\",\"action\":\"Read\",\"reason\":\"probe\",\"audience\":\"human\"}" "$BETA_URL/api/permissions" | jget "d['id']")
[ -n "$P" ] || fail "no permission request on beta"
for BY in '' ',"by":"human"'; do
  [ "$(code -X POST -H "$KEY" -H 'x-stam-human: 1' -H "$J" -d "{\"approve\":true$BY}" "$MAIN_URL/api/permissions/$P/answer")" = 409 ] || fail "the answer wasn't 409 (by: ${BY:-none}): $(cat "$TEST_TMP/body")"
  grep -q '"machine":"beta"' "$TEST_TMP/body" || fail "the 409 doesn't name beta, the holder (by: ${BY:-none}): $(cat "$TEST_TMP/body")"
done
[ "$(curl -s -H "authorization: Bearer $BETA_TOKEN" "$BETA_URL/api/permissions" | jget "next(r['status'] for r in d if r['id']=='$P')")" = pending ] || fail "the request was answered"
echo PASS
