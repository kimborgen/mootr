#!/bin/sh
# Mail titles across peers (S-297), free: a stubbed model endpoint, no agent turns. Two isolated
# daemons, "main" (titles on) and "twin" (titles off), peered. The daemon a mail starts on asks
# for its title once, and the recipient's copy on the other daemon gets that title without a
# second call:
#   - a mail from main's boss to twin's far: far's inbox and read_mail on twin carry the title
#   - with twin stopped, the mail waits in main's outbox; the title rides on the queued forward,
#     so once twin is back far's copy has it
#   - with main stopped, the thread on twin still shows both titles
#   - a mail also to the human gets a one-line summary (S-1001), and far's copy on twin has it
#   - the stub was asked exactly once per mail
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
stub_key main
stub_key twin
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$ROOT/test/decide-stub.mjs" "$STUB" &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null; stam_test_cleanup' EXIT
for _i in $(seq 1 50); do [ -s "$STUB/url" ] && break; sleep 0.2; done
[ -s "$STUB/url" ] || { echo "FAIL: the stub endpoint didn't start"; exit 1; }
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, other, model in (("main", "twin", "stub/title-model"), ("twin", "main", "")):
    path = f"{tmp}/{me}/settings.json"
    try:
        s = json.load(open(path))
    except FileNotFoundError:
        s = {}
    s["peers"] = [peer(other)]
    s["mail"] = {"titles": {"model": model}}
    s["decisions"] = {"mailCheck": False}
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_OUTBOX_MS=300
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  curl -s -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
calls() { cat "$STUB/titles" 2>/dev/null || echo 0; }
# The title of mail $2 in far's inbox on twin, "" while it has none.
far_title() { api twin GET "/api/agents/far/inbox?unread=0&limit=20" | jget "next((m.get('title') or '' for m in d if m['id']=='$1'), '')"; }

BOSS=$(api main POST /api/register '{"name":"boss","role":"test","harness":"claude"}' | jget "d['id']")
api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' >/dev/null
api main GET /api/agents | jget "[a['name'] for a in d]" | grep -q "far" || fail "main doesn't list far"

echo "-- a mail to an agent on the peer: the recipient's copy gets the title"
M1=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\",\"human\"],\"subject\":\"Deploy the build today\",\"body\":\"x\",\"new_thread\":true}" | jget "d['id']")
_t1() { [ "$(far_title "$M1")" = "Deploy the build" ]; }
wait_until _t1 || fail "far's copy on twin has no title (got '$(far_title "$M1")')"
api twin POST /api/agents/far/read "{\"ids\":[\"$M1\"]}" | jget "d[0].get('title')" | grep -qx "Deploy the build" || fail "read_mail on twin doesn't carry the title"
far_summary() { api twin GET "/api/agents/far/inbox?unread=0&limit=20" | jget "next((m.get('summary') or '' for m in d if m['id']=='$1'), '')"; }
_s1() { [ "$(far_summary "$M1")" = "Summary of Deploy the build today" ]; }
wait_until _s1 || fail "far's copy on twin has no summary (got '$(far_summary "$M1")')"
[ "$(calls)" = 1 ] || fail "expected one model call, got $(calls)"

echo "-- with twin stopped, the title rides on the queued forward"
daemon_stop twin
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"Token lifetime question here\",\"body\":\"y\",\"reply_to\":\"$M1\"}")
M2=$(printf "%s" "$R" | jget "d['id']")
printf "%s" "$R" | jget "d.get('queued')" | grep -qx True || fail "the mail to far wasn't queued (got: $R)"
main_title() { api main GET "/api/threads/$M1" | jget "next((m.get('title') or '' for m in d if m['id']=='$M2'), '')"; }
_t2main() { [ "$(main_title)" = "Token lifetime question" ]; }
wait_until _t2main || fail "main's copy got no title (got '$(main_title)')"
daemon_up twin
_t2() { [ "$(far_title "$M2")" = "Token lifetime question" ]; }
wait_until _t2 || fail "the queued mail reached twin without its title (got '$(far_title "$M2")')"

echo "-- with main stopped, the thread on twin still shows both titles"
daemon_stop main
api twin GET "/api/threads/$M1" | jget "sorted(m.get('title') or '' for m in d)" | grep -qx "\['Deploy the build', 'Token lifetime question'\]" || fail "twin's thread is missing titles: $(api twin GET "/api/threads/$M1")"
[ "$(calls)" = 2 ] || fail "expected one model call per mail, got $(calls)"
echo "PASS: mail titles reach the peer"
