#!/bin/sh
# The PR diff API's routes (S-1530), free: two daemons that are peers, no models, temp git repos (a bare origin
# with a refs/pull/7/head ref made locally). Checks, through the HTTP routes:
#   - the human reads the file list and a file on the ITSA home
#   - an agent's own token gets 403, whatever x-stam-human says, on both routes, here and through the forward
#   - a daemon that isn't the ITSA home (itsa.home = main) forwards both routes to the home as the human
#   - an unknown repo is 404 with a JSON message; a denied path is 403
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_PEER_PROBE_MS=300 STAM_PEER_CHECK_MS=300
daemon_home main
daemon_home twin
G="$TEST_TMP/git"
mkdir -p "$G"
git_() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }
git_ init -q --bare -b main "$G/origin.git"
git_ init -q -b main "$G/work"
printf 'one\n' >"$G/work/a.txt"
printf 'S=1\n' >"$G/work/.env"
git_ -C "$G/work" add -A
git_ -C "$G/work" commit -q -m base
git_ -C "$G/work" remote add origin "$G/origin.git"
git_ -C "$G/work" push -q origin main
git_ -C "$G/work" checkout -q -b pr
printf 'one\ntwo\n' >"$G/work/a.txt"
printf 'S=2\n' >"$G/work/.env"
git_ -C "$G/work" commit -q -am pr
git_ -C "$G/work" push -q origin pr:refs/pull/7/head
git_ clone -q "$G/origin.git" "$G/checkout"
python3 - "$TEST_TMP" "$G/checkout" <<'PY'
import json, re, sys
tmp, checkout = sys.argv[1:3]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [{"name": other, "url": env(other)["STAM_URL"], "token": open(f"{tmp}/{other}/token").read().strip()}]
    s["itsa"] = {**s.get("itsa", {}), "home": "main", "repos": {"app": checkout}}
    json.dump(s, open(path, "w"), indent=2)
PY
printf '%s\n' '{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }' >"$TEST_TMP/diff.json"
fake_claude "$TEST_TMP/diff.json"
daemon_up main
daemon_up twin
trap stam_test_cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
# hget URL TOKEN PATH [curl args]: as the human (the web UI's token and x-stam-human); prints the body, then the status.
hget() { _u=$1; _t=$2; _p=$3; shift 3; curl -s -w '\n%{http_code}' -H "authorization: Bearer $_t" -H 'x-stam-human: 1' "$@" "$_u$_p"; }
code() { hget "$@" | tail -n1; }
body() { hget "$@" | sed '$d'; }
for side in "$MAIN_URL $MAIN_TOKEN" "$TWIN_URL $TWIN_TOKEN"; do
  set -- $side
  [ "$(body "$1" "$2" "/api/diff?repo=app&pr=7" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(sorted(f["path"]+":"+f["status"]+":"+str(f.get("denied","")) for f in d["files"])))')" = ".env:modified:True,a.txt:modified:" ] || fail "file list through $1"
  [ "$(body "$1" "$2" "/api/diff/file?repo=app&pr=7&path=a.txt&side=head")" = "$(printf 'one\ntwo')" ] || fail "head file through $1"
  [ "$(body "$1" "$2" "/api/diff/file?repo=app&pr=7&path=a.txt&side=base")" = "one" ] || fail "base file through $1"
  [ "$(code "$1" "$2" "/api/diff/file?repo=app&pr=7&path=.env&side=head")" = 403 ] || fail ".env wasn't 403 through $1"
  [ "$(code "$1" "$2" "/api/diff?repo=nope&pr=7")" = 404 ] || fail "an unknown repo isn't 404 through $1"
  body "$1" "$2" "/api/diff?repo=nope&pr=7" | grep -q '"error"' || fail "no JSON error through $1"
  [ "$(code "$1" "$2" "/api/diff?repo=app&pr=99")" = 404 ] || fail "an unknown PR isn't 404 through $1"
done
curl -s -D - -o /dev/null -H "authorization: Bearer $TWIN_TOKEN" -H 'x-stam-human: 1' "$TWIN_URL/api/diff/file?repo=app&pr=7&path=a.txt" | grep -qi "^content-security-policy: default-src 'none'" || fail "CSP header lost in the forward"

# An agent's own token is no human, whatever x-stam-human says.
on main "$STAM" spawn kid --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on main "$STAM" wait kid --until idle --timeout 60
KID=$(on main sh -c 'id=$("$1" show kid | grep -m1 "\"id\"" | cut -d\" -f4); tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$id" STAM_TOKEN | cut -d= -f2-' _ "$STAM")
[ -n "$KID" ] || fail "no agent token"
for u in "$MAIN_URL"; do
  for path in "/api/diff?repo=app&pr=7" "/api/diff/file?repo=app&pr=7&path=a.txt"; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KID" -H 'x-stam-human: 1' "$u$path")" = 403 ] || fail "an agent token got $path from $u"
  done
done
echo "diff-api-route: ok"
