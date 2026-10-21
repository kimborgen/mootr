#!/bin/sh
# A ring reviewer type spawned on a peer (S-412 review), free (no models). Two isolated daemons:
# "main" takes the human's spawn with machine=twin and forwards it; "twin" starts the ring. The
# response is a ring, not an agent: main remembers the ring's members as twin's agents, not the
# ring, and the ring runs on twin.
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
s = json.load(open(f"{tmp}/main/settings.json"))
s["peers"] = [{"name": "twin", "url": env("twin")["STAM_URL"], "token": open(f"{tmp}/twin/token").read().strip()}]
json.dump(s, open(f"{tmp}/main/settings.json", "w"), indent=2)
# The peers know each other, as deployed: twin finds an agent that lives on main.
t = json.load(open(f"{tmp}/twin/settings.json"))
t["peers"] = [{"name": "main", "url": env("main")["STAM_URL"], "token": open(f"{tmp}/main/token").read().strip()}]
json.dump(t, open(f"{tmp}/twin/settings.json", "w"), indent=2)
PY
trap stam_test_cleanup EXIT
daemon_up main
daemon_up twin
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
# get DAEMON PATH: a read of that daemon's API (-f: a failure, or a gate 404, fails here).
get() { curl -sf -H "authorization: Bearer $(cat "$TEST_TMP/$1/token")" "$(on "$1" sh -c 'echo "$STAM_URL"')$2"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
REPO="$TEST_TMP/repo"; git init -q "$REPO" && git -C "$REPO" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

echo "-- a ring spawned on a peer: the ring runs there, its members are remembered here"
R=$(curl -s -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' -d "{\"name\":\"pr\",\"machine\":\"twin\",\"type\":\"review-ring\",\"cwd\":\"$REPO\",\"prompt\":\"review it\"}" "$MAIN_URL/api/agents")
[ "$(printf %s "$R" | jget "d.get('kind')")" = ring ] || fail "not a ring: $R"
[ "$(get twin /api/rings | jget "sum(r['name'] == 'pr' for r in d)")" = 1 ] || fail "no ring on twin"
[ "$(get main /api/rings | jget "len(d)")" = 0 ] || fail "a ring on main"
[ "$(get main /api/test/peer-agents | jget "sum(a['name'] in ('pr-1', 'pr-2') and a['machine'] == 'twin' for a in d)")" = 2 ] || fail "members not remembered as twin's: $(get main /api/test/peer-agents)"
[ "$(get main /api/test/peer-agents | jget "sum(a['name'] == 'pr' for a in d)")" = 0 ] || fail "the ring was remembered as an agent"
echo "-- an agent on main spawns a ring on the peer: the creator resolves through the peer lookup"
CA=$(curl -s -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'x-stam-human: 1' -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' -d "{\"name\":\"boss\",\"cwd\":\"$REPO\",\"harness\":\"claude\"}" "$MAIN_URL/api/agents" | jget "d['id']")
CA_TOKEN=$(on main sh -c 'tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$1" STAM_TOKEN | cut -d= -f2-' _ "$CA")
R=$(curl -s -X POST -H "authorization: Bearer $CA_TOKEN" -H 'content-type: application/json' -d "{\"name\":\"pa\",\"by\":\"$CA\",\"machine\":\"twin\",\"type\":\"review-ring\",\"cwd\":\"$REPO\",\"prompt\":\"review it\"}" "$MAIN_URL/api/agents")
[ "$(printf %s "$R" | jget "d.get('kind')")" = ring ] || fail "an agent's remote ring failed: $R"
[ "$(get twin /api/rings/pa | jget "d['created_by']")" = "$CA" ] || fail "the ring's creator is not the agent: $(get twin /api/rings/pa | jget "d['created_by']")"
[ "$(get twin /api/agents | jget "sum(a['name'] == 'pa-1' and a['parent_id'] == '$CA' for a in d)")" = 1 ] || fail "the member's parent is not the creator"
echo "PASS e2e-ring-peer"
