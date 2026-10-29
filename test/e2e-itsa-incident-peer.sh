#!/bin/sh
# The incident mark across machines (S-2421), free: a fake `claude` stands in, so no model runs. Two daemons: "home" is
# the ITSA home, with the chief of staff named in settings; "store" is a peer. Checks: an incident spawn on store starts
# when the home says the ITSA is marked, and is refused when the home says it isn't, or when the home can't be reached;
# and a mark set through store's relay by an agent that isn't the chief of staff is refused, and the mark stays.
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
fail() { echo "FAIL: $1"; exit 1; }
trap stam_test_cleanup EXIT
FAKE="$TEST_TMP/fake-bin"
mkdir -p "$FAKE"
printf '#!/bin/sh\n[ "$1" = --version ] && { echo "9.9.9 (Claude Code)"; exit 0; }\nexec sleep 600\n' >"$FAKE/claude"
chmod +x "$FAKE/claude"
PATH="$FAKE:$PATH"
export PATH
# A fixed /proc, so the load guard (S-2120) sees a quiet machine on both daemons.
PROC_DIR="$TEST_TMP/proc"
mkdir -p "$PROC_DIR"
printf 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0 0 0\n' >"$PROC_DIR/stat"
printf 'MemTotal:       16000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:      2000000 kB\nSwapFree:       2000000 kB\n' >"$PROC_DIR/meminfo"
printf '0.10 0.10 0.10 1/200 1234\n' >"$PROC_DIR/loadavg"
export STAM_PROC_DIR="$PROC_DIR"
daemon_home home
daemon_home store
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for d, other in (("home", "store"), ("store", "home")):
    path = f"{tmp}/{d}/settings.json"
    s = json.load(open(path))
    s["peers"] = [peer(other)]
    s.setdefault("itsa", {})["home"] = "home"
    s["chiefOfStaff"] = "cosagent"
    json.dump(s, open(path, "w"), indent=2)
PY
export STAM_PEER_RETRY_MS=500 STAM_PEER_PROBE_MS=500
daemon_up home
daemon_up store
use home
HOME_URL=$STAM_URL
HOME_TOKEN=$(cat "$STAM_HOME/token")
use store
STORE_URL=$STAM_URL
STORE_TOKEN=$(cat "$STAM_HOME/token")
REPO="$(mktemp -d "$TEST_TMP/repo.XXXX")"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
# api URL TOKEN METHOD PATH [BODY]: a human request, which the spawn and the ITSA reads take as the human's.
api() {
  curl -s -X "$3" -H "authorization: Bearer $2" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' "$1$4" ${5:+-d "$5"}
}
# reg URL TOKEN NAME: a registered agent on that daemon, with its own token (S-237); prints its id and token.
reg() { api "$1" "$2" POST /api/register "{\"name\":\"$3\",\"role\":\"test\",\"harness\":\"claude\",\"token\":true}"; }
# patch URL TOKEN BODY: an ITSA PATCH as the caller holding TOKEN, printing the status.
patch() { curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "authorization: Bearer $2" -H 'content-type: application/json' -d "$3" "$1/api/itsas/$K"; }
# patch_body URL TOKEN BODY: the same, printing the reply.
patch_body() { curl -s -X PATCH -H "authorization: Bearer $2" -H 'content-type: application/json' -d "$3" "$1/api/itsas/$K"; }
# mark: the home's incident flag for the ITSA.
mark() { api "$HOME_URL" "$HOME_TOKEN" GET "/api/itsas/$K" | python3 -c 'import json, sys; print(json.load(sys.stdin)["incident"])'; }
# incident URL TOKEN: the incident route's answer for the ITSA (S-3324).
incident() { api "$1" "$2" GET "/api/itsas/$K/incident"; }
started() { api "$STORE_URL" "$STORE_TOKEN" GET /api/agents | grep -q "\"name\":\"$1\""; }
# spawn NAME: an incident spawn on store by the manager's own token, naming the ITSA; prints the reply and the status.
spawn() { curl -s -m 30 -w '\n%{http_code}' -X POST -H "authorization: Bearer $MT" -H 'content-type: application/json' "$STORE_URL/api/agents" -d "{\"name\":\"$1\",\"type\":\"developer\",\"urgent\":\"incident\",\"itsa\":\"$K\",\"cwd\":\"$REPO\",\"by\":\"$MT_ID\"}"; }

CREG=$(reg "$HOME_URL" "$HOME_TOKEN" cosagent)
CT=$(printf %s "$CREG" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
MREG=$(reg "$STORE_URL" "$STORE_TOKEN" mgr)
MT=$(printf %s "$MREG" | python3 -c 'import json, sys; print(json.load(sys.stdin)["token"])')
MT_ID=$(printf %s "$MREG" | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')
# The manager on store owns the ITSA, so a refusal below is the mark's rule and not the ITSA's permissions.
K=$(api "$HOME_URL" "$HOME_TOKEN" POST /api/itsas "{\"title\":\"Outage\",\"owner\":\"$MT_ID\"}" | python3 -c 'import json, sys; print(json.load(sys.stdin)["key"])')

echo "-- 1. the chief of staff marks the ITSA on the home"
[ "$(patch "$HOME_URL" "$CT" '{"incident":true}')" = 200 ] || fail "the chief of staff couldn't set the mark on the home"
[ "$(mark)" = 1 ] || fail "the mark didn't stick on the home"

echo "-- 2. a relayed caller that isn't the chief of staff can't clear the mark, with or without a forged by"
R=$(patch_body "$STORE_URL" "$MT" '{"incident":false}')
printf %s "$R" | grep -q 'marks an ITSA as an incident' || fail "a relayed agent cleared the mark: $R"
[ "$(patch "$STORE_URL" "$MT" '{"incident":false,"by":"cosagent"}')" = 403 ] || fail "a relayed agent with a forged by cleared the mark"
[ "$(mark)" = 1 ] || fail "a refused relayed clear took the mark off"

echo "-- 2b. with the mark standing, an incident spawn on store starts"
R=$(spawn inc1)
printf %s "$R" | grep -q '"name":"inc1"' || fail "a marked incident spawn on store was refused: $R"

echo "-- 2c. the incident route (S-3324) says marked on the home and, by asking the home, on store; the CLI says the same"
incident "$HOME_URL" "$HOME_TOKEN" | grep -q '"marked":true' || fail "the home's incident route didn't say marked"
incident "$STORE_URL" "$STORE_TOKEN" | grep -q '"marked":true' || fail "store's incident route didn't say marked"
on home "$ROOT/bin/stam" itsa incident "$K" | grep -q '"marked":true' || fail "stam itsa incident didn't say marked"

echo "-- 3. an unmarked ITSA refuses an incident spawn on store"
[ "$(patch "$HOME_URL" "$CT" '{"incident":false}')" = 200 ] || fail "the chief of staff couldn't clear the mark for step 3"
[ "$(mark)" = 0 ] || fail "the mark didn't clear for step 3"
R=$(spawn inc2)
[ "$(printf %s "$R" | tail -1)" = 403 ] || fail "an unmarked incident spawn on store started: $R"
incident "$HOME_URL" "$HOME_TOKEN" | grep -q '"marked":false' || fail "the incident route said marked for a cleared mark"
on home "$ROOT/bin/stam" itsa incident "$K" | grep -q '"marked":false' || fail "stam itsa incident said marked for a cleared mark"
printf %s "$R" | grep -q 'ITSA home did not answer yes' || fail "the refusal doesn't say why: $R"
started inc2 && fail "inc2 started"

echo "-- 4. an unreachable home refuses an incident spawn on store, and the spawn doesn't hang"
[ "$(patch "$HOME_URL" "$CT" '{"incident":true}')" = 200 ] || fail "the chief of staff couldn't re-mark the ITSA for step 4"
daemon_stop home
R=$(spawn inc3)
[ "$(printf %s "$R" | tail -1)" = 403 ] || fail "an incident spawn started with the home unreachable: $R"
started inc3 && fail "inc3 started"
! incident "$STORE_URL" "$STORE_TOKEN" | grep -q '"marked":true' || fail "store's incident route said marked with the home unreachable (S-3324 fails closed)"
echo "PASS"
