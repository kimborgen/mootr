#!/bin/sh
# The Files API (S-1525), free: two daemons that are peers, no models. Checks, through the HTTP routes:
#   - the human lists and reads a file in a configured root (files.roots), and gets the roots with no path
#   - an agent's own token gets 403; so does a bad path (outside the root, `..`, a symlink out, a denied name)
#   - Range answers 206
#   - host=twin from main is forwarded over the peer token as the human, Range included
#   - POST /api/machines/NAME/start: 403 for an agent, 404 for an unknown machine, {ok:true} for a running peer
#   - with twin stopped, host=twin answers 503 {state:"stopped", host} at once, and reads again once it is back
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_PEER_PROBE_MS=300 STAM_PEER_CHECK_MS=300
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
HKEY=$STAM_TEST_HUMAN_KEY
daemon_home main
daemon_home twin
mkdir -p "$TEST_TMP/mainfiles" "$TEST_TMP/twinfiles" "$TEST_TMP/secret"
printf 'hello from main' >"$TEST_TMP/mainfiles/a.txt"
printf 'hello from twin' >"$TEST_TMP/twinfiles/b.txt"
mkdir -p "$TEST_TMP/twinfiles/many"
for i in $(seq 1 80); do : >"$TEST_TMP/twinfiles/many/a-file-with-a-long-name-$i.txt"; done
printf 'SECRET=1' >"$TEST_TMP/mainfiles/.env"
printf 'nope' >"$TEST_TMP/secret/s.txt"
ln -s "$TEST_TMP/secret" "$TEST_TMP/mainfiles/out"
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = [{"name": other, "url": env(other)["STAM_URL"], "token": open(f"{tmp}/{other}/token").read().strip()}]
    s["files"] = {"roots": [f"{tmp}/{me}files"]}
    json.dump(s, open(path, "w"), indent=2)
PY
printf '%s\n' '{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }' >"$TEST_TMP/files.json"
fake_claude "$TEST_TMP/files.json"
daemon_up main
daemon_up twin
trap stam_test_cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
# get PATH [curl args]: as the human (the web UI's token and x-stam-human); prints the status, then the body.
get() { _p=$1; shift; curl -s -w '\n%{http_code}' -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' "$@" "$MAIN_URL$_p"; }
code() { get "$@" | tail -n1; }
body() { get "$@" | sed '$d'; }
enc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
M="$TEST_TMP/mainfiles"

body "/api/files/list" | grep -q "mainfiles" || fail "no path should list the roots"
[ "$(body "/api/files/list?path=$(enc "$M")" | python3 -c 'import json,sys; print(",".join(e["name"]+":"+e["kind"] for e in json.load(sys.stdin)["entries"]))')" = "a.txt:file,out:symlink" ] || fail "listing differs (.env must be hidden)"
[ "$(body "/api/files/read?path=$(enc "$M/a.txt")")" = "hello from main" ] || fail "read a.txt"
[ "$(code "/api/files/read?path=$(enc "$M/a.txt")" -H 'range: bytes=0-4')" = 206 ] || fail "Range isn't 206"
[ "$(body "/api/files/read?path=$(enc "$M/a.txt")" -H 'range: bytes=6-9')" = "from" ] || fail "Range bytes"
curl -s -D - -o /dev/null -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' "$MAIN_URL/api/files/read?path=$(enc "$M/a.txt")" | grep -qi "^content-security-policy: default-src 'none'" || fail "CSP header missing"
for p in "$M/.env" "$TEST_TMP/secret/s.txt" "$M/out/s.txt" "$M/../secret/s.txt"; do
  [ "$(code "/api/files/read?path=$(enc "$p")")" = 403 ] || fail "$p wasn't refused with 403"
done
[ "$(code "/api/files/read?path=$(enc "$M/missing")")" = 404 ] || fail "a missing file isn't 404"

# An agent's own token is no human, whatever x-stam-human says.
on main "$STAM" spawn kid --model claude-haiku-5-5 --cwd "$TEST_TMP" "Say hello." >/dev/null
on main "$STAM" wait kid --until idle --timeout 60
KID=$(on main sh -c 'id=$("$1" show kid | grep -m1 "\"id\"" | cut -d\" -f4); tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$id" STAM_TOKEN | cut -d= -f2-' _ "$STAM")
[ -n "$KID" ] || fail "no agent token"
for path in "/api/files/list" "/api/files/read?path=$(enc "$M/a.txt")"; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KID" -H 'x-stam-human: 1' "$MAIN_URL$path")" = 403 ] || fail "an agent token got $path"
done

# Another host is forwarded as the human.
T="$TEST_TMP/twinfiles"
[ "$(body "/api/files/read?host=twin&path=$(enc "$T/b.txt")")" = "hello from twin" ] || fail "forwarded read"
[ "$(body "/api/files/read?host=twin&path=$(enc "$T/b.txt")" -H 'range: bytes=11-14')" = "twin" ] || fail "forwarded Range"
[ "$(code "/api/files/read?host=twin&path=$(enc "$M/a.txt")")" = 403 ] || fail "twin served a path outside its roots"
[ "$(code "/api/files/read?host=nowhere&path=$(enc "$T/b.txt")")" = 404 ] || fail "an unknown host isn't 404"
# A listing over 1 KB forwarded from a peer arrives whole (the peer may compress it).
[ "$(body "/api/files/list?host=twin&path=$(enc "$T/many")" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["entries"]))')" = 80 ] || fail "forwarded listing truncated"
# An agent can't borrow the forwarding either.
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $KID" "$MAIN_URL/api/files/read?host=twin&path=$(enc "$T/b.txt")")" = 403 ] || fail "an agent read twin's files"

# Starting a machine (the Files world's Start button, S-1526): human only; an unknown machine is 404; a running peer is {ok:true}.
post() { _p=$1; shift; curl -s -w '\n%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$@" "$MAIN_URL$_p"; }
[ "$(post /api/machines/twin/start -H "authorization: Bearer $KID" -H 'x-stam-human: 1' | tail -n1)" = 403 ] || fail "an agent started a machine"
[ "$(post /api/machines/nowhere/start -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $HKEY" | tail -n1)" = 404 ] || fail "starting an unknown machine isn't 404"
post /api/machines/twin/start -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $HKEY" | head -n1 | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True' || fail "starting a running peer isn't {ok:true}"

# A stopped peer answers at once with its state.
daemon_stop twin
out=$(body "/api/files/read?host=twin&path=$(enc "$T/b.txt")")
[ "$(code "/api/files/read?host=twin&path=$(enc "$T/b.txt")")" = 503 ] || fail "a stopped peer isn't 503"
echo "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["state"]=="stopped" and d["host"]=="twin", d' || fail "stopped state body: $out"
daemon_up twin
wait_until sh -c "[ \"\$(curl -s -H 'authorization: Bearer $MAIN_TOKEN' -H 'x-stam-human: 1' '$MAIN_URL/api/files/read?host=twin&path=$(enc "$T/b.txt")')\" = 'hello from twin' ]"
echo "files: ok"
