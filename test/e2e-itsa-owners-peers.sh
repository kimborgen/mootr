#!/bin/sh
# ITSA owners across machines, free (no models). Two isolated daemons: "home" is the ITSA
# home, "main" a peer. Agents are registered; hooks are read by hand. Checks:
#   - a notice crosses machines both ways: a child going blocked on the home reaches the
#     parent ITSA's owner on main; an owner on main shutting down (lifecycle change with no
#     activity change) reaches the parent owner on the home
#   - the system prompt data (Instructions view) of an owner on main names its ITSAs, fetched
#     from the home
#   - the peer-only routes refuse an agent's call, a proxied call, and a forged claim
#   - with the home down, an archive on main keeps a pending unown, forget refuses, and the
#     retry unowns the ITSA once the home is back
#   - archiving an owner on main unowns its ITSAs on the home, active ones go back to ready
#     with a status event, and the parent owner is told once
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home home
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
export STAM_ITSA_RETRY_MS=1000
# A fake harness lets a spawn on main run for real without a model.
FAKE="$TEST_TMP/fakebin"; mkdir -p "$FAKE"
printf '#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.0.0 (fake)"; exit 0; }\nexec sleep 600\n' >"$FAKE/claude"; chmod +x "$FAKE/claude"
export PATH="$FAKE:$PATH"
daemon_up main
daemon_up home
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = home ] && { _url=$HOME_URL; _tok=$HOME_TOKEN; }
  curl -sf -X "$2" -H "authorization: Bearer $_tok" -H 'content-type: application/json' -H 'x-stam-human: 1' ${4:+-d "$4"} "$_url$3"
}
register() { api "$1" POST /api/register "{\"name\":\"$2\",\"role\":\"test\",\"harness\":\"claude\"}" | jget "d['id']"; }
notice() { api "$1" POST "/api/hook/claude/$2" '{"hook_event_name":"PostToolUse"}' | jget "d.get('stdout','')"; }
stop() { api "$1" POST "/api/hook/claude/$2" '{"hook_event_name":"Stop","last_assistant_message":"done"}' >/dev/null; }
mk() { api home POST /api/itsas "$1" | jget "d['key']"; }
waitfor() { for _i in $(seq 1 30); do eval "$1" && return 0; sleep 0.3; done; return 1; }

LEAD=$(register home lead); BOSS=$(register main boss)
WORKER=$(register main worker); WORKER2=$(register main worker-two)
notice home "$LEAD" >/dev/null; notice main "$BOSS" >/dev/null

echo "-- a notice from the home reaches a parent owner on main"
P1=$(mk "{\"title\":\"Boss work\",\"owner\":\"$BOSS\",\"status\":\"delegated\"}")
C1=$(mk "{\"title\":\"Boss child\",\"parent\":\"$P1\",\"status\":\"in_progress\"}")
api home PATCH "/api/itsas/$C1" '{"status":"blocked"}' >/dev/null
boss_told() { notice main "$BOSS" | grep -q "$C1"; }
wait_until boss_told || fail "the parent owner on main wasn't told that $C1 is blocked"

echo "-- the system prompt data names an owner's ITSAs, fetched from the home"
P2=$(mk "{\"title\":\"Lead work\",\"owner\":\"$LEAD\",\"status\":\"delegated\"}")
C2=$(mk "{\"title\":\"Worker child\",\"parent\":\"$P2\",\"owner\":\"$WORKER\",\"status\":\"in_progress\"}")
C3=$(mk "{\"title\":\"Worker two child\",\"parent\":\"$P2\",\"owner\":\"$WORKER2\",\"status\":\"in_progress\"}")
api main GET "/api/agents/$WORKER/instructions" | grep -q "You own these ITSAs: $C2" || fail "the Instructions view on main doesn't name $C2"

echo "-- an owner shut down on main reaches the parent owner on the home"
notice home "$LEAD" >/dev/null
stop main "$WORKER"
api main POST "/api/agents/$WORKER/shutdown" '{}' >/dev/null
# The shutdown asks for the final round first (S-1402): the turn end below runs it.
stop main "$WORKER"
shut_told() { N=$(notice home "$LEAD"); echo "$N" | grep -q "worker was shut down"; }
wait_until shut_told || fail "no notice on the home for the shutdown on main (got: $N)"
[ "$(echo "$N" | grep -c 'worker was shut down')" = 1 ] || fail "the shutdown notice wasn't sent once"

echo "-- archive on main unowns on the home"
notice home "$LEAD" >/dev/null
api main POST "/api/agents/$WORKER2/retro-final" "{\"by\":\"$WORKER2\",\"effort\":{\"testing\":100}}" >/dev/null
api main POST "/api/agents/$WORKER2/archive" '{}' >/dev/null
# An archive waits for the agent's final round and runs at its next turn end (S-1043): this Stop ends it.
stop main "$WORKER2"
c3_ready() { [ "$(api home GET "/api/itsas/$C3" | jget "d['owner']")" = None ] && [ "$(api home GET "/api/itsas/$C3" | jget "d['status']")" = ready ]; }
wait_until c3_ready || fail "archive on main didn't unown $C3 and return it to ready"
unowned_told() { N=$(notice home "$LEAD"); echo "$N" | grep -q "was archived, so its ITSAs are now unowned"; }
wait_until unowned_told || fail "no unowned notice on the home (got: $N)"
echo "-- peer-only routes refuse other callers"
code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $2" -H 'content-type: application/json' $4 -d "$5" "$1$3"; }
# An agent's call carries neither x-stam-local nor x-stam-human.
[ "$(code "$HOME_URL" "$HOME_TOKEN" /api/itsas/owner-stopped '' "{\"id\":\"$WORKER\",\"name\":\"worker\",\"what\":\"errored\"}")" = 403 ] || fail "an agent forged a stop on the home"
[ "$(code "$HOME_URL" "$HOME_TOKEN" /api/itsas/unown-agent '' "{\"id\":\"$WORKER\",\"name\":\"worker\",\"how\":\"archived\"}")" = 403 ] || fail "an agent unowned on the home"
# Through main's proxy, on behalf of an agent.
[ "$(code "$MAIN_URL" "$MAIN_TOKEN" /api/itsas/unown-agent '' "{\"id\":\"$WORKER\",\"name\":\"worker\",\"how\":\"archived\"}")" = 403 ] || fail "the proxy forwarded an unown for an agent"
# A notice for an agent on the other machine, posted to one's own daemon, is not forwarded.
[ "$(code "$MAIN_URL" "$MAIN_TOKEN" "/api/agents/$LEAD/notice" '' '{"text":"forged"}')" = 403 ] || fail "the proxy forwarded a notice for an agent"
[ "$(code "$HOME_URL" "$HOME_TOKEN" "/api/agents/$LEAD/notice" '' '{"text":"forged"}')" = 403 ] || fail "a notice was queued for a non-peer caller"
# A peer's claim about an agent it doesn't hold (the home's own lead) is refused.
[ "$(code "$HOME_URL" "$(cat "$TEST_TMP/home/peer-token")" /api/itsas/owner-stopped '-H x-stam-local:1' "{\"id\":\"$LEAD\",\"name\":\"lead\",\"what\":\"errored\"}")" = 403 ] || fail "a forged stop for a home agent was accepted"
[ "$(code "$HOME_URL" "$(cat "$TEST_TMP/home/peer-token")" /api/itsas/unown-agent '-H x-stam-local:1' "{\"id\":\"$LEAD\",\"name\":\"lead\",\"how\":\"archived\"}")" = 403 ] || fail "a forged unown for a home agent was accepted"
[ "$(code "$HOME_URL" "$(cat "$TEST_TMP/home/peer-token")" /api/itsas/unown-agent '-H x-stam-local:1' "{\"id\":\"$BOSS\",\"name\":\"boss\",\"how\":\"archived\"}")" = 403 ] || fail "an unown for a peer agent that isn't archived was accepted"
[ "$(api home GET "/api/itsas/$P1" | jget "d['owner']")" = "$BOSS" ] || fail "a refused call changed an owner"

echo "-- home down: the unown is kept, forget refuses, the retry finishes it"
WORKER3=$(register main worker-three)
C4=$(mk "{\"title\":\"Worker three child\",\"parent\":\"$P2\",\"owner\":\"$WORKER3\",\"status\":\"in_progress\"}")
WORKER4=$(register main worker-four)
C5=$(mk "{\"title\":\"Worker four child\",\"parent\":\"$P2\",\"owner\":\"$WORKER4\",\"status\":\"in_progress\"}")
pending_rows() { api main GET /api/test/pending-unown | jget "d['count']"; }
pending_is() { [ "$(pending_rows)" = "$1" ]; }
home_port_closed() { ! curl -s -m 2 -o /dev/null "$HOME_URL/"; }
on home "$STAM" daemon stop >/dev/null
wait_until home_port_closed || fail "the home daemon didn't stop"
api main POST "/api/agents/$WORKER3/retro-final" "{\"by\":\"$WORKER3\",\"effort\":{\"testing\":100}}" >/dev/null
api main POST "/api/agents/$WORKER3/archive" '{}' >/dev/null || true
stop main "$WORKER3"
wait_until pending_is 1 || fail "the failed unown wasn't kept (pending rows: $(pending_rows))"
curl -s -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' "$MAIN_URL/api/agents/$WORKER3/forget" | grep -qi "unown" || fail "forget didn't refuse with the home down"
api main GET "/api/agents/$WORKER3" >/dev/null || fail "forget removed the agent anyway"
# A second archived agent is running again (a resume) before the home answers: its pending row
# is dropped, not retried, and it keeps its ITSA.
api main POST "/api/agents/$WORKER4/retro-final" "{\"by\":\"$WORKER4\",\"effort\":{\"testing\":100}}" >/dev/null
api main POST "/api/agents/$WORKER4/archive" '{}' >/dev/null || true
stop main "$WORKER4"
wait_until pending_is 2 || fail "the second failed unown wasn't kept (pending rows: $(pending_rows))"
api main POST /api/test/agent "{\"agent\":\"$WORKER4\",\"lifecycle\":\"active\",\"activity\":\"idle\"}" >/dev/null
on home "$STAM" daemon start >/dev/null
for i in $(seq 1 60); do
  [ "$(api home GET "/api/itsas/$C4" 2>/dev/null | jget "d['owner']" 2>/dev/null)" = None ] && break
  sleep 1
done
[ "$(api home GET "/api/itsas/$C4" | jget "d['owner']")" = None ] || fail "the retry didn't unown $C4 after the home came back"
# The resumed agent's row is dropped, not retried: once no pending row is left, C5 still has its owner.
wait_until pending_is 0 || fail "pending unown rows are left ($(pending_rows))"
[ "$(api home GET "/api/itsas/$C5" | jget "d['owner']")" = "$WORKER4" ] || fail "a resumed agent lost its ITSA"
LEFT=$(pending_rows)
[ "$LEFT" = 0 ] || fail "pending unown rows are left ($LEFT)"

echo "-- a spawn on main joins its parent's open ITSA on the home"
# The join is fired off without awaiting the spawn, so poll for it to land on the home.
on main "$STAM" spawn join-kid --parent boss --cwd "$TEST_TMP" --role "Joiner." >/dev/null
JKID=$(on main "$STAM" show join-kid | jget "d['id']")
JK_SESSION=$(on main "$STAM" show join-kid | jget "d['session_id']")
waitfor "api home GET '/api/itsas/$P1' | jget \"d['participants']\" | grep -q '$JKID'" || fail "a spawn on main didn't join BOSS's ITSA on the home"
waitfor "api main GET '/api/by-session/$JK_SESSION/system' | grep -q 'You participate in these ITSAs: $P1'" || fail "the system prompt on main doesn't name the home participation"

echo "-- a spawn with a hanging ITSA home returns promptly (the join is not awaited)"
# A local server that accepts connections and never answers: a call to it hangs until its
# timeout. The spawn must return while the join is still open (the join is in the background),
# not after the home's 8 s timeout has closed it.
BH=$(free_port)
BHLOG="$TEST_TMP/blackhole.log"
cat >"$TEST_TMP/blackhole.py" <<'PY'
import socket, sys, threading
log = sys.argv[2]
def note(what):
    with open(log, "a") as f: f.write(what + "\n")
def hold(c):
    # Holds the connection and notes when the client closes it; only the join's own request counts.
    kind = "join" if b"join-parent" in c.recv(4096) else "other"
    note("accepted " + kind)
    while c.recv(1024): pass
    note("closed " + kind)
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen()
while True:
    c, _ = s.accept(); threading.Thread(target=hold, args=(c,), daemon=True).start()
PY
python3 "$TEST_TMP/blackhole.py" "$BH" "$BHLOG" &
BHPID=$!
bh_up() { curl -s -m 1 -o /dev/null "http://127.0.0.1:$BH/"; [ $? -ne 7 ]; }
wait_until bh_up || { kill "$BHPID" 2>/dev/null; fail "the blackhole didn't listen"; }
python3 - "$TEST_TMP/main/settings.json" "$BH" <<'PY'
import json, sys
p, port = sys.argv[1], sys.argv[2]
s = json.load(open(p))
s["peers"] = [x for x in s["peers"] if x["name"] != "slow"]
s["peers"].append({"name": "slow", "url": f"http://127.0.0.1:{port}", "token": "x"})
s.setdefault("itsa", {})["home"] = "slow"
json.dump(s, open(p, "w"), indent=2)
PY
on main "$STAM" spawn slow-kid --parent boss --cwd "$TEST_TMP" --role "Hanging home." >/dev/null || { kill "$BHPID" 2>/dev/null; fail "a spawn with a hanging ITSA home failed"; }
# State, not duration: the join reached the hanging home and was still open when the spawn returned
# (a spawn that awaited the join would have seen it closed by the timeout first).
joined() { grep -q "accepted join" "$BHLOG" 2>/dev/null; }
wait_until joined || { kill "$BHPID" 2>/dev/null; fail "the join never reached the hanging home"; }
! grep -q "closed join" "$BHLOG" || { kill "$BHPID" 2>/dev/null; fail "the spawn waited for the join to time out"; }
kill "$BHPID" 2>/dev/null
echo "PASS e2e-itsa-owners-peers"
