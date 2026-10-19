#!/bin/sh
# The mail gate for an ITSA post relayed from an agent on a peer (S-983), free (no models). Two
# isolated daemons: "home" is the ITSA home and has the stubbed decisions endpoint, "main" a peer
# with a registered agent. The agent's post to the human goes main -> home as a relayed forward, so
# the gate runs on the home and its refusal comes back to the agent. Checks:
#   - a failing post naming the human is refused through the relay, naming `override`
#   - the same post with an override is delivered, and the home's mail carries the reason
#   - a passing post is delivered with the gate's verdict
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
stub_key home
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$(dirname "$(readlink -f "$0")")/decide-stub.mjs" "$STUB" &
STUB_PID=$!
for _i in $(seq 1 50); do
  [ -s "$STUB/url" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || { echo "FAIL: the stub endpoint didn't start"; exit 1; }
  sleep 0.2
done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d in ("main", "home"):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer("home")] if d == "main" else [peer("main")]
    s.setdefault("itsa", {})["home"] = "home"
    json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
daemon_up home
trap 'kill $STUB_PID 2>/dev/null; stam_test_cleanup' EXIT
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
}
# POST to main, printing the body and then the HTTP code.
raw() { curl -s -w '\n%{http_code}' -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$MAIN_URL$1"; }
code() { printf '%s' "$1" | tail -n 1; }
bodyof() { printf '%s' "$1" | sed '$d'; }
calls() { cat "$STUB/count" 2>/dev/null || echo 0; }

RA=$(api main POST /api/register '{"name":"relayer","role":"test","harness":"claude"}' | jget "d['id']")
LEAD=$(api home POST /api/register '{"name":"lead","role":"test","harness":"claude"}' | jget "d['id']")
KEY=$(api home POST /api/itsas "{\"title\":\"Gate relay\",\"owner\":\"$LEAD\",\"participants\":[\"$RA\"]}" | jget "d['key']")
api home PATCH "/api/itsas/$KEY" "{\"participants\":[\"$RA\"]}" >/dev/null

echo "-- a failing relayed post to the human is refused through the relay"
B=$(calls)
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"$RA\",\"to\":[\"human\"],\"body\":\"MAILCHECK:NO a chatty relayed post.\"}")
[ "$(code "$R")" = 400 ] || fail "the failing relayed post was not refused with 400: $R"
bodyof "$R" | grep -q 'override' || fail "the relayed refusal doesn't mention override: $R"
[ "$(calls)" -gt "$B" ] || fail "the home never asked the decision model"

echo "-- with an override it is delivered, and the home's mail carries the reason"
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"$RA\",\"to\":[\"human\"],\"body\":\"MAILCHECK:NO a chatty relayed post.\",\"override\":\"Needed on the record.\"}")
[ "$(code "$R")" = 200 ] || fail "the relayed override was refused: $R"
api home GET "/api/itsas/$KEY/thread" | grep -q 'Needed on the record.' || fail "the home's mail has no override reason"

echo "-- a passing relayed post is delivered"
R=$(raw "/api/itsas/$KEY/post" "{\"by\":\"$RA\",\"to\":[\"human\"],\"body\":\"TLDR: a concise relayed post that needs an answer.\"}")
[ "$(code "$R")" = 200 ] || fail "a passing relayed post was refused: $R"

echo "PASS e2e-mail-gate-peers"
