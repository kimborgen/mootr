#!/bin/sh
# What pr_open may push, across two daemons and an OpenCode caller (S-581), free (no models). "home" is
# the ITSA home with throwaway git repos and a fake gh; "main" is a peer standing in for storage, where
# the agents below live (registered, with a known token and worktree branch). Checks:
#   - a peer agent pushes its own branch and a child's, through main to the home; another peer agent's
#     branch is refused (the home never sees main's agents' worktrees; main's answer rides in a header)
#   - the OpenCode server naming its agent is judged as that agent, not as the shared token
#   - a stolen link: linking another agent's branch to one's own ITSA is refused, and a link made by the
#     human doesn't open the push either; a branch no agent owns passes through a participating ITSA
#   - a home agent can't push a peer agent's branch (the home asks main), and an agent's own token
#     can't send the scope header itself
#   - the shared token pushes any branch
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
G="$TEST_TMP/git"; mkdir -p "$G/bin"
git_() { git -c user.name=test -c user.email=test@example.com "$@"; }
git_ init -q --bare -b main "$G/origin.git"; git_ init -q --bare -b main "$G/storage.git"
git_ init -q -b main "$G/seed"; echo one >"$G/seed/a.txt"; git_ -C "$G/seed" add .; git_ -C "$G/seed" commit -q -m main
git_ -C "$G/seed" push -q "$G/origin.git" main
for b in home-own peer-own peer-child peer-other oc-own free; do git_ -C "$G/seed" push -q "$G/storage.git" "main:refs/heads/stam/$b"; done
git_ clone -q "$G/origin.git" "$G/work"; git_ -C "$G/work" remote add storage "$G/storage.git"
cat >"$G/bin/gh" <<'GH'
#!/bin/sh
case "$1 $2" in "pr list") echo '[]' ;; "pr create") echo https://github.com/example/stam/pull/7 ;; esac
GH
chmod +x "$G/bin/gh"
python3 - "$TEST_TMP" "$G" <<'PY'
import json, re, sys
tmp, g = sys.argv[1:3]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d in ("main", "home"):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer("home")] if d == "main" else [peer("main")]
    s["itsa"] = {"home": "home", "repos": {"stam2": f"{g}/work"}, "prOpen": {"repo": "stam2", "storage": "storage", "origin": "origin", "gh": f"{g}/bin/gh", "github": "example/stam"}}
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up home
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
# reg DAEMON NAME BRANCH PARENT: a registered agent with a known token (tok-NAME) and a worktree on BRANCH.
reg() {
  _id=$(api "$1" POST /api/register "{\"name\":\"$2\",\"role\":\"developer\",\"harness\":\"${5:-claude}\"${4:+,\"parent\":\"$4\"}}" | jget "d['id']")
  tapi "$1" POST /api/test/agent "$(python3 -c '
import json, sys
id, name, branch, parent = sys.argv[1:5]
b = {"agent": id, "token": f"tok-{name}", "workspace": json.dumps({"worktree": {"branch": branch, "path": "/tmp/x"}}) if branch else None}
if parent: b["parent"] = parent
print(json.dumps(b))' "$_id" "$2" "$3" "$4")" >/dev/null
  echo "$_id"
}
printf '%s' "$(printf '%s' oc-test-token | sha256sum | cut -d' ' -f1)" >"$TEST_TMP/main/opencode-token"
A=$(reg main pa stam/peer-own); B=$(reg main pb stam/peer-other); C=$(reg main pc stam/peer-child "$A"); H=$(reg home hh stam/home-own); O=$(reg main oc stam/oc-own "" opencode)
[ -n "$A" ] && [ -n "$B" ] && [ -n "$C" ] && [ -n "$H" ] && [ -n "$O" ] || fail "an agent didn't register"
BODY='ITSA: S-1\nGates: tsc\nDeploy: normal\n\nx\n'
# push URL TOKEN BRANCH [BY]: the HTTP status of pr_open's route; the reply is left in $TEST_TMP/body.
push() {
  curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $2" -H 'content-type: application/json' "$1/api/pr/open" \
    -d "{\"branch\":\"$3\",\"title\":\"t\",\"body\":\"$(printf '%b' "$BODY" | sed ':a;N;$!ba;s/\n/\\n/g')\"${4:+,\"by\":\"$4\"}}"
}
ok() { [ "$(push "$@")" = 200 ] || fail "$3 was refused for $2: $(cat "$TEST_TMP/body")"; }
no() { [ "$(push "$@")" = 403 ] || fail "$3 wasn't refused for $2: $(cat "$TEST_TMP/body")"; grep -q "can't push $3" "$TEST_TMP/body" || fail "the refusal didn't name the branch: $(cat "$TEST_TMP/body")"; }

echo "-- a peer agent pushes its own branch and a child's, through main to the home"
ok "$MAIN_URL" tok-pa stam/peer-own
ok "$MAIN_URL" tok-pa stam/peer-child
echo "-- another peer agent's branch is refused"
no "$MAIN_URL" tok-pa stam/peer-other
no "$MAIN_URL" tok-pc stam/peer-own
echo "-- the OpenCode server is judged as the agent it names"
ok "$MAIN_URL" oc-test-token stam/oc-own "$O"
no "$MAIN_URL" oc-test-token stam/peer-own "$O"
echo "-- a stolen link: pa links pb's branch to its own ITSA; the link and the push are refused"
K=$(api home POST /api/itsas "{\"title\":\"mine\",\"owner\":\"$A\"}" | jget "d['key']")
[ "$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H 'authorization: Bearer tok-pa' -H 'content-type: application/json' "$MAIN_URL/api/itsas/$K/links" -d '{"system":"branch","external_id":"stam/peer-other","repo":"stam2","url":""}')" = 403 ] || fail "pa linked pb's branch: $(cat "$TEST_TMP/body")"
api home POST "/api/itsas/$K/links" '{"system":"branch","external_id":"stam/peer-other","repo":"stam2","url":""}' >/dev/null
no "$MAIN_URL" tok-pa stam/peer-other
echo "-- a branch no agent owns passes through a participating ITSA, not through a stranger's"
[ "$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H 'authorization: Bearer tok-pa' -H 'content-type: application/json' "$MAIN_URL/api/itsas/$K/links" -d '{"system":"branch","external_id":"stam/free","repo":"stam2","url":""}')" = 200 ] || fail "pa couldn't link a free branch: $(cat "$TEST_TMP/body")"
ok "$MAIN_URL" tok-pa stam/free
no "$MAIN_URL" tok-pb stam/free
echo "-- a home agent can't push a peer agent's branch, and its own token can't send the scope header"
no "$HOME_URL" tok-hh stam/peer-own
ok "$HOME_URL" tok-hh stam/home-own
[ "$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H 'authorization: Bearer tok-hh' -H 'x-stam-branch-scope: tree' -H 'content-type: application/json' "$HOME_URL/api/pr/open" -d '{"branch":"stam/peer-own","title":"t","body":"ITSA: S-1\nGates: tsc\nDeploy: normal\n"}')" = 403 ] || fail "the scope header from an agent token passed"
echo "-- the shared token pushes any branch"
[ "$(curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $HOME_TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$HOME_URL/api/pr/open" -d '{"branch":"stam/peer-other","title":"t","body":"ITSA: S-1\nGates: tsc\nDeploy: normal\n"}')" = 200 ] || fail "the shared token was refused: $(cat "$TEST_TMP/body")"
echo "-- the scope route answers only a peer"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'authorization: Bearer tok-pa' "$MAIN_URL/api/pr/branch-scope?agent=$A&branch=stam/free")" = 403 ] || fail "an agent token read the scope route"
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $MAIN_TOKEN" "$MAIN_URL/api/pr/branch-scope?agent=$A&branch=stam/free")" = 403 ] || fail "the shared token read the scope route"
echo "-- with main down, a peer that does not answer is not an owner (S-1477): the refusal is rule 2, not a peer-down one"
on main "$STAM" daemon stop >/dev/null 2>&1 || true
[ "$(push "$HOME_URL" tok-hh stam/free)" = 403 ] || fail "the push passed with a peer down: $(cat "$TEST_TMP/body")"
grep -q "didn't answer" "$TEST_TMP/body" && fail "a down peer still blocked the check: $(cat "$TEST_TMP/body")"
grep -q "rule 2" "$TEST_TMP/body" || fail "expected rule 2's refusal: $(cat "$TEST_TMP/body")"
echo PASS
