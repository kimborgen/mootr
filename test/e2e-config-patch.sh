#!/bin/sh
# The human's partial settings change (S-293), free (no agents, no models): one throwaway daemon.
# PATCH /api/config/settings applies a partial object to the file in one step: a top-level key
# replaces, a view record (boardViews, workViews) merges per id (null deletes; fill keeps what's
# there). Checks:
#   - an agent's PATCH gets 403 and the file is unchanged
#   - patches sent at once, each adding its own view, all survive (no lost update)
#   - fill keeps an existing view and adds a missing one; null deletes a view
#   - a patch that isn't an object is refused with 400
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
TOKEN=$(cat "$STAM_HOME/token")
HUMAN="x-stam-test-human:$STAM_TEST_HUMAN_KEY"
# patch HEADER BODY: the HTTP status of one PATCH; HEADER is "name:value" or empty.
patch() {
  curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${1:+-H "$1"} -d "$2" "$STAM_URL/api/config/settings"
}
# boards: the board views the file holds, as JSON.
boards() { curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/config/settings" | python3 -c 'import json,sys; print(json.dumps(json.loads(json.load(sys.stdin)["text"]).get("boardViews", {}), sort_keys=True))'; }

# 1. An agent can't patch the settings, and the file stays as it was.
BEFORE=$(boards)
[ "$(patch "" '{"patch":{"boardViews":{"board:x":{"mode":"status"}}}}')" = 403 ] || fail "an agent's patch was accepted"
[ "$(boards)" = "$BEFORE" ] || fail "the file changed after an agent's refused patch"

# 2. Ten patches at once, each adding its own view, all survive.
i=0
while [ $i -lt 10 ]; do
  ( [ "$(patch "$HUMAN" "{\"patch\":{\"boardViews\":{\"board:$i\":{\"mode\":\"status\"}}}}")" = 200 ] || echo "patch $i refused" > "$STAM_HOME/patch-$i.err" ) &
  i=$((i + 1))
done
wait
[ ! -e "$STAM_HOME"/patch-*.err ] || fail "a patch sent at once was refused: $(cat "$STAM_HOME"/patch-*.err)"
python3 -c 'import json,sys; v=json.loads(sys.argv[1]); assert all("board:%d" % i in v for i in range(10)), v' "$(boards)" || fail "a patch sent at once was lost: $(boards)"

# 3. Fill keeps an existing view and adds a missing one; null deletes a view.
[ "$(patch "$HUMAN" '{"patch":{"boardViews":{"board:0":{"mode":"category"},"board:new":{"mode":"subtree"}}},"fill":true}')" = 200 ] || fail "fill was refused"
python3 -c 'import json,sys; v=json.loads(sys.argv[1]); assert v["board:0"]["mode"]=="status", v; assert v["board:new"]["mode"]=="subtree", v' "$(boards)" || fail "fill replaced an existing view: $(boards)"
[ "$(patch "$HUMAN" '{"patch":{"boardViews":{"board:1":null}}}')" = 200 ] || fail "a null patch was refused"
python3 -c 'import json,sys; v=json.loads(sys.argv[1]); assert "board:1" not in v and "board:new" in v, v' "$(boards)" || fail "null did not delete the view: $(boards)"

# 4. A patch that isn't an object is refused.
[ "$(patch "$HUMAN" '{"patch":"nope"}')" = 400 ] || fail "a patch that isn't an object was accepted"
echo "PASS: config patch"
