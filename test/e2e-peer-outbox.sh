#!/bin/sh
# Mail to an agent on a peer that doesn't answer waits in the outbox (S-235), free (no models).
# Two isolated daemons, "main" and "twin", peered, with twin's agent FAR learned by main.
# A throwaway node server stands in for a peer that answers with an error ("fake").
# Checks:
#   - with twin stopped, mail to FAR is queued: the sender gets queued: true, nothing is stored
#   - an agent no peer has still fails on a down peer ("no agent ghost")
#   - a peer that answers 4xx for the mail still fails ("fake: nope") as a 400 refusal (S-590), and is not queued
#   - once twin is back, the queued mail arrives exactly once, and the sender hears mail:delivered_late
#   - a queued mail that the peer refuses (400) is dropped with mail:failed on the sender, and the
#     queued mail behind it to that peer still arrives
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
FAKE_PORT=$(free_port)
cat >"$TEST_TMP/fake.mjs" <<'JS'
import { createServer } from 'node:http';
import { appendFileSync, existsSync } from 'node:fs';
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (code, data) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && req.url === '/api/agents/fxa') return json(200, { id: 'fx1', name: 'fxa', machine: 'fake', lifecycle: 'active', role: 'test', harness: 'claude' });
    if (req.method === 'POST' && req.url === '/api/mail') {
      const subject = JSON.parse(body || '{}').subject;
      const busy = subject === 'flaky' && existsSync(process.argv[5]);
      const code = subject === 'fake' || subject === 'bad' ? 400 : busy ? 503 : 200;
      appendFileSync(process.argv[4], `${subject} ${code}\n`);
      if (code !== 200) return json(code, { error: code === 503 ? 'busy' : 'nope' });
      appendFileSync(process.argv[3], subject + '\n');
      return json(200, { id: 'ok' });
    }
    json(404, { error: 'not found' });
  });
}).listen(Number(process.argv[2]), '127.0.0.1');
JS
fake_up() { node "$TEST_TMP/fake.mjs" "$FAKE_PORT" "$TEST_TMP/fake-log" "$TEST_TMP/fake-attempts" "$TEST_TMP/fake-busy" & FAKE_PID=$!; }
fake_up
trap 'kill $FAKE_PID 2>/dev/null; stam_test_cleanup' EXIT
python3 - "$TEST_TMP" "$FAKE_PORT" <<'PY'
import json, re, sys
tmp, fake_port = sys.argv[1], sys.argv[2]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, others in (("main", [peer("twin"), {"name": "fake", "url": f"http://127.0.0.1:{fake_port}", "token": "x"}]), ("twin", [peer("main")])):
    path = f"{tmp}/{me}/settings.json"
    s = json.load(open(path))
    s["peers"] = others
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

BOSS=$(api main POST /api/register '{"name":"boss","role":"test","harness":"claude"}' | jget "d['id']")
FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")

echo "-- main learns twin's agent"
api main GET /api/agents | jget "[a['id'] for a in d if a['id']=='$FAR'][0]" | grep -qx "$FAR" || fail "main doesn't list far"

echo "-- a peer that answers 4xx still fails, and nothing is queued for it (also teaches main fxa)"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"fxa\"],\"subject\":\"fake\",\"body\":\"x\"}")
printf "%s" "$R" | grep -q "fake: nope" || fail "4xx from a peer didn't fail (got: $R)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -d "{\"from\":\"$BOSS\",\"to\":[\"fxa\"],\"subject\":\"fake\",\"body\":\"x\"}" "$MAIN_URL/api/mail")
[ "$CODE" = 400 ] || fail "a peer's 4xx came back as HTTP $CODE, not 400 (S-590)"

echo "-- with twin stopped, mail to far is queued"
daemon_stop twin
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"far\"],\"subject\":\"outbox one\",\"body\":\"queued body\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "mail to far wasn't queued (got: $R)"
MAIL=$(printf "%s" "$R" | jget "d['id']")
printf "%s" "$R" | jget "d['thread_id']" | grep -q . || fail "queued record has no thread (got: $R)"

echo "-- an agent no peer has still fails on a down peer"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"ghost\"],\"subject\":\"ghost\",\"body\":\"x\"}")
printf "%s" "$R" | grep -q "no agent ghost" || fail "unknown agent didn't fail (got: $R)"

echo "-- fake is down: two mails to fxa are queued; the first is refused once it is up"
kill $FAKE_PID; wait $FAKE_PID 2>/dev/null || true
for SUBJ in bad good; do
  R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"fxa\"],\"subject\":\"$SUBJ\",\"body\":\"x\"}")
  printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "mail $SUBJ to fxa wasn't queued (got: $R)"
done
fake_up
sleep 1
echo "-- twin is back: the queued mail arrives exactly once"
daemon_up twin
arrived() { [ "$(api twin GET "/api/agents/$FAR/inbox?unread=0" | jget "len([m for m in d if m['subject']=='outbox one'])")" -ge 1 ]; }
for i in $(seq 1 120); do arrived && break; sleep 0.5; done
arrived || fail "the queued mail never arrived on twin"
sleep 2
N=$(api twin GET "/api/agents/$FAR/inbox?unread=0" | jget "len([m for m in d if m['subject']=='outbox one'])")
[ "$N" = 1 ] || fail "far got the mail $N times"
[ "$(api twin GET "/api/agents/$FAR/inbox?unread=0" | jget "[m for m in d if m['subject']=='outbox one'][0]['id']")" = "$MAIL" ] || fail "the delivered mail has another id than $MAIL"
api main GET "/api/agents/$BOSS/events" | grep -q "mail:delivered_late" || fail "boss didn't hear mail:delivered_late"
refused() { api main GET "/api/agents/$BOSS/events" | grep -q "mail:failed"; }
for i in $(seq 1 120); do refused && break; sleep 0.5; done
refused || fail "the refused mail never reached the sender as mail:failed"
for i in $(seq 1 120); do grep -qx good "$TEST_TMP/fake-log" 2>/dev/null && break; sleep 0.5; done
grep -qx good "$TEST_TMP/fake-log" || fail "the mail behind the refused one never reached fake"
grep -qx bad "$TEST_TMP/fake-log" && fail "the refused mail reached fake"

echo "-- a peer answering 503 keeps the mail; a mail sent meanwhile waits behind it"
kill $FAKE_PID; wait $FAKE_PID 2>/dev/null || true
: >"$TEST_TMP/fake-busy"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"fxa\"],\"subject\":\"flaky\",\"body\":\"x\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "flaky mail wasn't queued (got: $R)"
fake_up
for i in $(seq 1 120); do grep -qx "flaky 503" "$TEST_TMP/fake-attempts" 2>/dev/null && break; sleep 0.5; done
grep -qx "flaky 503" "$TEST_TMP/fake-attempts" || fail "fake never answered the flaky mail with 503"
R=$(api main POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"fxa\"],\"subject\":\"after\",\"body\":\"x\"}")
printf "%s" "$R" | jget "d['queued']" | grep -qx True || fail "a mail sent behind a 503 went out ahead (got: $R)"
rm -f "$TEST_TMP/fake-busy"
for i in $(seq 1 120); do grep -qx after "$TEST_TMP/fake-log" 2>/dev/null && break; sleep 0.5; done
[ "$(grep -cx flaky "$TEST_TMP/fake-log")" = 1 ] || fail "flaky was delivered $(grep -cx flaky "$TEST_TMP/fake-log") times"
[ "$(grep -cx after "$TEST_TMP/fake-log")" = 1 ] || fail "after was delivered $(grep -cx after "$TEST_TMP/fake-log") times"
[ "$(tail -2 "$TEST_TMP/fake-log" | tr "\n" " ")" = "flaky after " ] || fail "flaky didn't come before after (log ends: $(tail -2 "$TEST_TMP/fake-log" | tr "\n" " "))"
echo "PASS e2e-peer-outbox"
