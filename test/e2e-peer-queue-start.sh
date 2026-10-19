#!/bin/sh
# Direct mail queued for a stopped peer starts it (S-245), free (no models). Two isolated daemons:
# "main" sends, "twin" is the peer, stopped in each case. twin's `start` is a fake command that
# counts its runs, waits a second, and launches twin's daemon. Checks:
#   - mail from stranger (no relation to far) to far queues without starting twin and logs the skip (S-1473)
#   - mail from boss (far's parent) to far (a twin agent, named directly) queues, starts twin once, and is delivered once
#   - a broadcast (to all) on a stopped twin queues nothing and starts nothing
#   - stam's own mail (from_stam) to far queues without starting twin
#   - direct mail to a shut-down twin agent queues without starting twin
#   - direct mail to an archived twin agent fails with "no agent old" (as S-235) and doesn't start twin
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
START="$TEST_TMP/start-twin.sh"
cat >"$START" <<EOF
#!/bin/sh
echo run >>"$TEST_TMP/starts"
sleep 1
. "$TEST_TMP/twin/test.env"
"$STAM" daemon start >/dev/null 2>&1 </dev/null
EOF
python3 - "$TEST_TMP" "$START" <<'PY'
import json, re, sys
tmp, start = sys.argv[1], sys.argv[2]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
s = json.load(open(f"{tmp}/main/settings.json"))
s["peers"] = [{"name": "twin", "url": env("twin")["STAM_URL"], "token": open(f"{tmp}/twin/token").read().strip(), "start": f"sh {start}"}]
json.dump(s, open(f"{tmp}/main/settings.json", "w"), indent=2)
PY
export STAM_OUTBOX_MS=300
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"'); TWIN_TOKEN=$(cat "$TEST_TMP/twin/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN
  if [ "$1" = twin ]; then _url=$TWIN_URL; _tok=$TWIN_TOKEN; shift; fi
  curl -s -X "$1" -H "authorization: Bearer $_tok" -H 'content-type: application/json' ${3:+-d "$3"} "$_url$2"
}
starts() { [ -f "$TEST_TMP/starts" ] && wc -l <"$TEST_TMP/starts" || echo 0; }
arrivals() { api twin GET "/api/agents/$FAR/inbox?unread=0" | jget "len([m for m in d if m['subject']=='$1'])"; }

BOSS=$(api POST /api/register '{"name":"boss","role":"test","harness":"claude"}' | jget "d['id']")
STRANGER=$(api POST /api/register '{"name":"stranger","role":"test","harness":"claude"}' | jget "d['id']")
FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")
OLD=$(api twin POST /api/register '{"name":"old","role":"test","harness":"claude"}' | jget "d['id']")
GONE=$(api twin POST /api/register '{"name":"gone","role":"test","harness":"claude"}' | jget "d['id']")
api twin POST "/api/agents/$FAR/adopt" "{\"parent\":\"$BOSS\",\"remoteParent\":true}" >/dev/null
echo "-- main learns twin's agents"
api GET /api/agents | jget "[a['id'] for a in d if a['id']=='$FAR'][0]" | grep -qx "$FAR" || fail "main doesn't list far"
api GET /api/agents | jget "[a['id'] for a in d if a['id']=='$OLD'][0]" | grep -qx "$OLD" || fail "main doesn't list old"
api GET /api/agents | jget "[a['id'] for a in d if a['id']=='$GONE'][0]" | grep -qx "$GONE" || fail "main doesn't list gone"

echo "-- old is archived and gone is shut down on twin, and main learns both"
api twin POST "/api/agents/$OLD/shutdown" '{"now":true}' >/dev/null
api twin POST "/api/agents/$OLD/archive" '{}' >/dev/null
api twin POST "/api/agents/$GONE/shutdown" '{"now":true}' >/dev/null
api GET /api/agents >/dev/null
api GET /api/agents | jget "len([a for a in d if a['id']=='$OLD' and a['lifecycle']=='archived'])" | grep -qx 1 || fail "main doesn't see old archived"
api GET /api/agents | jget "len([a for a in d if a['id']=='$GONE' and a['lifecycle']=='shut_down'])" | grep -qx 1 || fail "main doesn't see gone shut down"

echo "-- a broadcast to a stopped twin queues nothing and starts nothing"
daemon_stop twin
R=$(api POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"all\"],\"subject\":\"broadcast\",\"body\":\"x\"}")
printf "%s" "$R" | jget "'queued' in d" | grep -qx False || fail "broadcast was queued (got: $R)"
[ "$(starts)" = 0 ] || fail "a broadcast started twin"

echo "-- stam's own mail to far queues without starting twin"
R=$(api POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"stam notice\",\"body\":\"x\",\"from_stam\":true}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "stam mail to far wasn't queued (got: $R)"
sleep 2
[ "$(starts)" = 0 ] || fail "stam mail started twin"

echo "-- direct mail from a stranger (not far's ancestor) queues without starting twin, and logs why"
R=$(api POST /api/mail "{\"from\":\"$STRANGER\",\"to\":[\"far\"],\"subject\":\"stranger\",\"body\":\"x\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "stranger mail to far wasn't queued (got: $R)"
sleep 2
[ "$(starts)" = 0 ] || fail "a stranger's mail started twin"
grep -q "peer:start twin: not started: mail from stranger" "$TEST_TMP/main/daemon.log" || fail "no not-started log line"

echo "-- direct mail from boss to far starts twin once, and is delivered once"
R=$(api POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"direct one\",\"body\":\"x\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "direct mail to far wasn't queued (got: $R)"
for i in $(seq 1 120); do [ "$(arrivals "direct one")" -ge 1 ] && break; sleep 0.5; done
[ "$(starts)" = 1 ] || fail "expected one start, got $(starts)"
grep -q "peer:start twin: queued mail from boss" "$TEST_TMP/main/daemon.log" || fail "no peer:start log line"
sleep 2
[ "$(arrivals "direct one")" = 1 ] || fail "direct one arrived $(arrivals "direct one") times"
[ "$(starts)" = 1 ] || fail "a second start ran ($(starts))"

echo "-- twin is stopped again; direct mail to the shut-down gone agent queues without starting twin"
daemon_stop twin
R=$(api POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"gone\"],\"subject\":\"to gone\",\"body\":\"x\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "mail to gone wasn't queued (got: $R)"
sleep 2
[ "$(starts)" = 1 ] || fail "mail to a shut-down agent started twin ($(starts) starts)"

echo "-- direct mail to the archived old agent fails with no agent old, and doesn't start twin"
R=$(api POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"old\"],\"subject\":\"to old\",\"body\":\"x\"}")
printf "%s" "$R" | grep -q "no agent old" || fail "mail to archived old didn't fail (got: $R)"
sleep 2
[ "$(starts)" = 1 ] || fail "mail to an archived agent started twin ($(starts) starts)"
echo "PASS e2e-peer-queue-start"
