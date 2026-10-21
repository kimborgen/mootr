#!/bin/sh
# pr_merge across two daemons (S-2279), free (no models). "home" is the ITSA home with a fake gh and the stub merge
# script (test/pr-merge-stub.mjs); "main" is a peer standing in for storage, where the agents live. Checks:
#   - a peer agent whose ITSA it owns merges through main to the home, and gets the sha by mail on main
#   - a peer agent's own worktree branch opens the merge too (the home asks main who owns the branch)
#   - a stranger is refused through the forward, before the script runs
#   - status through the forward shows the run and its log
#   - a second call while the run holds returns it, and the script ran once
#   - pr_close through the forward: a stranger is refused, the owner closes, a closed PR is left alone
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
S="$TEST_TMP/stub"; mkdir -p "$S" "$TEST_TMP/deploy"
cat >"$S/gh" <<GH
#!/bin/sh
[ "\$1 \$2" = "pr view" ] && exec cat "$S/\$3.json"
[ "\$1 \$2" = "pr close" ] && { echo "\$*" >>"$S/closed"; exit 0; }
exit 1
GH
chmod +x "$S/gh"
cat >>"$TEST_TMP/home/test.env" <<EOF
export STAM_PR_MERGE_SCRIPT='$ROOT/test/pr-merge-stub.mjs' STAM_PR_MERGE_STUB_DIR='$S' STAM_DEPLOY_REPO='$TEST_TMP/deploy' STAM_GATE_LOCK='$TEST_TMP/gate.lock' STAM_PR_MERGE_POLL_MS=200
EOF
python3 - "$TEST_TMP" "$S" <<'PY'
import json, re, sys
tmp, s = sys.argv[1:3]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d in ("main", "home"):
    path = f"{tmp}/{d}/settings.json"
    st = json.load(open(path))
    st["peers"] = [peer("home")] if d == "main" else [peer("main")]
    st["itsa"] = {"home": "home", "repos": {"stam2": f"{tmp}/deploy"}, "prOpen": {"repo": "stam2", "gh": f"{s}/gh", "github": "example/stam"}}
    json.dump(st, open(path, "w"), indent=2)
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
# reg NAME BRANCH: an agent on main with a known token (tok-NAME) and a worktree on BRANCH.
reg() {
  _id=$(api main POST /api/register "{\"name\":\"$1\",\"role\":\"manager\",\"harness\":\"claude\"}" | jget "d['id']")
  tapi main POST /api/test/agent "$(python3 -c '
import json, sys
id, name, branch = sys.argv[1:4]
print(json.dumps({"agent": id, "token": f"tok-{name}", "workspace": json.dumps({"worktree": {"branch": branch, "path": "/tmp/x"}})}))' "$_id" "$1" "$2")" >/dev/null
  echo "$_id"
}
A=$(reg pa stam/pa-own); B=$(reg pb stam/pb-own)
[ -n "$A" ] && [ -n "$B" ] || fail "an agent didn't register"
K=$(api home POST /api/itsas "{\"title\":\"mine\",\"owner\":\"$A\"}" | jget "d['key']")
# pr N ITSA BRANCH MODE: what the fake gh and the stub script answer for PR N.
pr() { printf '{"body":"ITSA: %s\\nGates: tsc\\nDeploy: normal\\n","headRefName":"%s","state":"%s"}' "$2" "$3" "${5:-OPEN}" >"$S/$1.json"; echo "$4" >"$S/$1.mode"; }
pr 21 "$K" stam/elsewhere merge
pr 22 S-99999 stam/pa-own hold
# merge TOKEN PR [STATUS]: the HTTP status of the route on main; the reply is left in $TEST_TMP/body.
merge() {
  curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' "$MAIN_URL/api/pr/${3:-merge}" -d "{\"pr\":$2}"
}
# mailed SUBJECT: A holds a mail whose subject has SUBJECT and whose body names the sha.
mailed() {
  for _t in $(api main GET "/api/agents/$A/inbox?limit=100" | python3 -c 'import json,sys; [print(m["thread_id"]) for m in json.load(sys.stdin) if sys.argv[1] in m["subject"]]' "$1"); do
    api main GET "/api/threads/$_t" | grep -q 0123456789abcdef && return 0
  done
  return 1
}

echo "-- a stranger is refused through the forward, before the script runs"
[ "$(merge tok-pb 21)" = 403 ] || fail "pb merged pa's PR: $(cat "$TEST_TMP/body")"
grep -q "can't merge PR #21: its ITSA $K isn't owned" "$TEST_TMP/body" || fail "the refusal didn't say why: $(cat "$TEST_TMP/body")"
[ ! -f "$S/calls" ] || fail "the script ran for a refused merge"
echo "-- the ITSA's owner on main merges through the home, and gets the sha by mail on main"
[ "$(merge tok-pa 21)" = 200 ] || fail "pa's merge was refused: $(cat "$TEST_TMP/body")"
grep -q '"state":"running"' "$TEST_TMP/body" || fail "no running run: $(cat "$TEST_TMP/body")"
wait_until mailed "PR #21 merged"
echo "-- the owner of the PR's branch on main merges (the home asks main), and a second call gets the running run"
[ "$(merge tok-pa 22)" = 200 ] || fail "pa's own branch was refused: $(cat "$TEST_TMP/body")"
[ "$(merge tok-pa 22)" = 200 ] || fail "the second call failed: $(cat "$TEST_TMP/body")"
grep -q '"already":true' "$TEST_TMP/body" || fail "the second call started another run: $(cat "$TEST_TMP/body")"
echo "-- status through the forward shows the run and its log"
running() { merge tok-pa 22 merge-status >/dev/null; grep -q 'waiting: 2nd in the merge queue' "$TEST_TMP/body"; }
wait_until running
grep -q '"state":"running"' "$TEST_TMP/body" || fail "status: $(cat "$TEST_TMP/body")"
touch "$S/22.release"
wait_until mailed "PR #22 merged"
[ "$(grep -c '^22$' "$S/calls")" = 1 ] || fail "the script ran $(grep -c '^22$' "$S/calls") times for PR 22"
echo "-- pr_close through the forward: a stranger is refused, the owner closes, a closed PR is left alone"
pr 23 "$K" stam/elsewhere merge
pr 24 "$K" stam/elsewhere merge MERGED
close() { curl -s -o "$TEST_TMP/body" -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' "$MAIN_URL/api/pr/close" -d "{\"pr\":$2,\"comment\":\"Superseded by #728\"}"; }
[ "$(close tok-pb 23)" = 403 ] || fail "pb closed pa's PR: $(cat "$TEST_TMP/body")"
grep -q "can't close PR #23" "$TEST_TMP/body" || fail "the close refusal didn't say why: $(cat "$TEST_TMP/body")"
[ ! -f "$S/closed" ] || fail "gh closed a PR for a stranger"
[ "$(close tok-pa 23)" = 200 ] || fail "pa's close was refused: $(cat "$TEST_TMP/body")"
grep -q '"closed":true' "$TEST_TMP/body" || fail "not closed: $(cat "$TEST_TMP/body")"
grep -qx 'pr close 23 --repo example/stam --comment=Superseded by #728' "$S/closed" || fail "gh got: $(cat "$S/closed")"
[ "$(close tok-pa 24)" = 200 ] || fail "closing a merged PR failed: $(cat "$TEST_TMP/body")"
grep -q '"closed":false,"state":"MERGED"' "$TEST_TMP/body" || fail "a merged PR: $(cat "$TEST_TMP/body")"
[ "$(wc -l <"$S/closed")" = 1 ] || fail "gh closed the merged PR too"
echo PASS
