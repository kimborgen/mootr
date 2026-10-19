#!/bin/sh
# The verdict relay over two daemons, free (no models), S-1061: "home" is the ITSA home, with a stub gh that
# records every call; "main" is a peer standing in for storage, where the reviewers live. Checks:
#   - the shared token with forged x-stam-local and x-stam-agent headers is refused (403) by main and by
#     home, and gh is never called
#   - a reviewer's own token on main is forwarded over the peer token, and posts as that reviewer
#   - an OpenCode server naming its agent with `by` posts as that agent, and without `by` is refused
#   - a head that moved is refused (409) and nothing is posted
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
REPO=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
G="$TEST_TMP/gh"; mkdir -p "$G"
HEAD=1234567890abcdef1234567890abcdef12345678
MOVED=abcdef1234567890abcdef1234567890abcdef12
cat >"$G/gh" <<GH
#!/bin/sh
echo "\$*" >>"$G/calls"
case "\$1 \$2" in "pr view") echo "{\"headRefOid\":\"$HEAD\"}" ;; esac
GH
chmod +x "$G/gh"
printf '%s' peer-token-main >"$TEST_TMP/main/peer-token"
printf '%s' peer-token-home >"$TEST_TMP/home/peer-token"
python3 - "$TEST_TMP" "$REPO" "$G" <<'PY'
import json, re, sys
tmp, repo, g = sys.argv[1:4]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name, other_pt):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip(), "peerToken": other_pt}
for d in ("main", "home"):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer("home", "peer-token-home")] if d == "main" else [peer("main", "peer-token-main")]
    s["itsa"] = {"home": "home", "repos": {"stam2": repo}, "prOpen": {"repo": "stam2", "storage": "", "origin": "origin", "gh": f"{g}/gh", "github": "example/stam"}}
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up home
printf '%s' "$(printf '%s' oc-test-token | sha256sum | cut -d' ' -f1)" >"$TEST_TMP/main/opencode-token"
trap stam_test_cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
}
# reg DAEMON NAME [HARNESS]: a registered agent with a known token (tok-NAME); prints its id.
reg() {
  _id=$(api "$1" POST /api/register "{\"name\":\"$2\",\"role\":\"reviewer\",\"harness\":\"${3:-claude}\"}" | jget "d['id']")
  python3 - "$TEST_TMP/$1" "$_id" "$2" <<'PY'
import hashlib, sqlite3, sys, glob
home, id, name = sys.argv[1:4]
db = sqlite3.connect(glob.glob(f"{home}/*.db")[0], timeout=10)
db.execute("UPDATE agents SET token_hash = ? WHERE id = ?", (hashlib.sha256(f"tok-{name}".encode()).hexdigest(), id))
db.commit()
PY
  echo "$_id"
}
A=$(reg main pa)
[ -n "$A" ] || fail "an agent didn't register"
# verdict URL TOKEN PR HEAD VERDICT [BY] [HEADER]: the status of the route; the reply is in $TEST_TMP/body.
verdict() {
  curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $2" ${7:+-H "$7"} -H 'content-type: application/json' "$1/api/pr/review" \
    -d "{\"pr\":$3,\"verdict\":\"$5\",\"summary\":\"Checked.\",\"head\":\"$4\"${6:+,\"by\":\"$6\"}}"
}
calls() { cat "$G/calls" 2>/dev/null || true; }

echo "-- the shared token with forged headers is refused, and gh is never called"
rm -f "$G/calls"
[ "$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-local: 1' -H "x-stam-agent: $A" -H 'content-type: application/json' "$MAIN_URL/api/pr/review" -d "{\"pr\":42,\"verdict\":\"approve\",\"summary\":\"Forged.\",\"head\":\"$HEAD\"}")" = 403 ] || fail "main didn't refuse the forged agent: $(cat "$TEST_TMP/body")"
[ "$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $HOME_TOKEN" -H 'x-stam-local: 1' -H "x-stam-agent: $A" -H 'content-type: application/json' "$HOME_URL/api/pr/review" -d "{\"pr\":42,\"verdict\":\"approve\",\"summary\":\"Forged.\",\"head\":\"$HEAD\"}")" = 403 ] || fail "home didn't refuse the forged agent: $(cat "$TEST_TMP/body")"
[ -z "$(calls)" ] || fail "gh was called for a forged verdict: $(calls)"

echo "-- a reviewer's own token on main is forwarded over the peer token, and posts as that reviewer"
[ "$(verdict "$MAIN_URL" tok-pa 42 "$HEAD" approve)" = 200 ] || fail "the reviewer's verdict was refused: $(cat "$TEST_TMP/body")"
calls | grep -qF "Review ($A): approve. Checked." || fail "the comment didn't name the reviewer: $(calls)"

echo "-- an OpenCode server naming its agent with by posts as that agent; without by it is refused"
O=$(reg main oc opencode)
[ "$(verdict "$MAIN_URL" oc-test-token 42 "$HEAD" request_changes "$O")" = 200 ] || fail "the OpenCode verdict was refused: $(cat "$TEST_TMP/body")"
calls | grep -qF "Review ($O): request_changes. Checked." || fail "the OpenCode comment didn't name its agent: $(calls)"
[ "$(verdict "$MAIN_URL" oc-test-token 42 "$HEAD" approve)" = 403 ] || fail "an OpenCode verdict without by wasn't refused"

echo "-- a moved head is refused (409) and nothing is posted"
rm -f "$G/calls"
[ "$(verdict "$MAIN_URL" tok-pa 42 "$MOVED" approve)" = 409 ] || fail "a moved head wasn't refused: $(cat "$TEST_TMP/body")"
calls | grep -qF 'pr comment' && fail "a comment was posted for a moved head" || true
echo PASS
