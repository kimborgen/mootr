#!/bin/sh
# The verdict relay over two daemons, free (no models), S-1061: "home" is the ITSA home, with a stub gh that
# records every call; "main" is a peer standing in for storage, where the reviewers live. Checks:
#   - the shared token with forged x-stam-local and x-stam-agent headers is refused (403) by main and by
#     home, and gh is never called
#   - a reviewer's own token on main is forwarded over the peer token, and posts as that reviewer
#   - an OpenCode server naming its agent with `by` posts as that agent, and without `by` is refused
#   - a head that moved is refused (409) and nothing is posted
#   - who may post (S-1065): a forwarded reviewer, chief of staff and assistant (unknown to the home) post, a forwarded
#     developer and the owner of the PR's branch are refused (403) before gh posts, and a local agent's forged
#     review-role headers are ignored
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
case "\$1 \$2" in "pr view") case "\$*" in *headRefName*) echo "{\"headRefName\":\"\$(cat "$G/branch" 2>/dev/null || echo stam/someone-else)\"}" ;; *) echo "{\"headRefOid\":\"$HEAD\"}" ;; esac ;; "api "*) echo '{}' ;; esac
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
    if d == "home": s["chiefOfStaff"] = "pcos"
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
# tapi: api for /api/test/* routes; -f fails at the call when the gate answers 404.
tapi() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  curl -sf -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
}
# reg DAEMON NAME [HARNESS] [TYPE] [KIND]: a registered agent with a known token (tok-NAME); prints its id.
reg() {
  _id=$(api "$1" POST /api/register "{\"name\":\"$2\",\"role\":\"reviewer\",\"harness\":\"${3:-claude}\"}" | jget "d['id']")
  tapi "$1" POST /api/test/agent "{\"agent\":\"$_id\",\"token\":\"tok-$2\"${4:+,\"type\":\"$4\"}${5:+,\"kind\":\"$5\"}}" >/dev/null
  echo "$_id"
}
A=$(reg main pa claude reviewer)
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
O=$(reg main oc opencode reviewer)
[ "$(verdict "$MAIN_URL" oc-test-token 42 "$HEAD" request_changes "$O")" = 200 ] || fail "the OpenCode verdict was refused: $(cat "$TEST_TMP/body")"
calls | grep -qF "Review ($O): request_changes. Checked." || fail "the OpenCode comment didn't name its agent: $(calls)"
[ "$(verdict "$MAIN_URL" oc-test-token 42 "$HEAD" approve)" = 403 ] || fail "an OpenCode verdict without by wasn't refused"

echo "-- a moved head is refused (409) and nothing is posted"
rm -f "$G/calls"
[ "$(verdict "$MAIN_URL" tok-pa 42 "$MOVED" approve)" = 409 ] || fail "a moved head wasn't refused: $(cat "$TEST_TMP/body")"
calls | grep -qF 'pr comment' && fail "a comment was posted for a moved head" || true

echo "-- who may post (S-1065): a forwarded chief of staff and assistant, unknown to the home, post; a forwarded developer does not"
rm -f "$G/calls"
reg main pcos claude cos >/dev/null
[ "$(api main GET /api/chief-of-staff | jget "d['chiefOfStaff']")" = pcos ] || fail "main doesn't know pcos as its chief of staff: $(api main GET /api/chief-of-staff)"
[ "$(verdict "$MAIN_URL" tok-pcos 42 "$HEAD" approve)" = 200 ] || fail "a forwarded chief of staff was refused: $(cat "$TEST_TMP/body")"
reg main passt claude developer assistant >/dev/null
[ "$(verdict "$MAIN_URL" tok-passt 42 "$HEAD" approve)" = 200 ] || fail "a forwarded assistant was refused: $(cat "$TEST_TMP/body")"
D=$(reg main pdev claude developer)
rm -f "$G/calls"
[ "$(verdict "$MAIN_URL" tok-pdev 42 "$HEAD" approve)" = 403 ] || fail "a forwarded developer wasn't refused: $(cat "$TEST_TMP/body")"
calls | grep -qF 'pr comment' && fail "a comment was posted for a developer" || true

echo "-- the owner of the PR's branch is refused, forwarded and local"
reg main pself claude reviewer >/dev/null
echo stam/pself >"$G/branch"
[ "$(verdict "$MAIN_URL" tok-pself 42 "$HEAD" approve)" = 403 ] || fail "a forwarded owner wasn't refused: $(cat "$TEST_TMP/body")"
grep -qF 'own PR' "$TEST_TMP/body" || fail "the refusal didn't say why: $(cat "$TEST_TMP/body")"
rm -f "$G/branch"

echo "-- a local agent on the home sending review headers is ignored: the home's own facts decide"
reg home hdev claude developer >/dev/null
[ "$(verdict "$HOME_URL" tok-hdev 42 "$HEAD" approve '' 'x-stam-review-role: manager')" = 403 ] || fail "a forged role header was honoured: $(cat "$TEST_TMP/body")"
reg home hrev claude reviewer >/dev/null
[ "$(verdict "$HOME_URL" tok-hrev 42 "$HEAD" approve)" = 200 ] || fail "a local reviewer was refused: $(cat "$TEST_TMP/body")"
echo PASS
