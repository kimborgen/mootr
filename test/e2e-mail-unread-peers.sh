#!/bin/sh
# Mark unread across peers (S-2246): a thread held only on the peer "home" is marked unread through
# "main", the web's daemon. Main doesn't hold the mail, so it asks home, a verified peer (its token
# and x-stam-local), which marks it. Before the fix this 403'd and the result came back empty. Free:
# two isolated daemons, no models.
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
daemon_up main
daemon_up home
trap 'stam_test_cleanup' EXIT
fail() { echo "FAIL: $1"; exit 1; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]??""))' "$1"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")

# An agent on home sends the human a mail, so the thread lives on home only.
curl -sf -X POST -H "authorization: Bearer $HOME_TOKEN" -H 'content-type: application/json' -d '{"action":"agent","id":"un-peer","name":"Peer Helper"}' "$HOME_URL/api/test/mail" >/dev/null
TID=$(curl -sf -X POST -H "authorization: Bearer $HOME_TOKEN" -H 'content-type: application/json' -d '{"from":"un-peer","to":["human"],"new_thread":true,"subject":"Peer unread","body":"x"}' "$HOME_URL/api/mail" | field id)
[ -n "$TID" ] || fail "home didn't take the mail"
curl -sf -X POST -H "authorization: Bearer $HOME_TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "{\"ids\":[\"$TID\"]}" "$HOME_URL/api/agents/human/read" >/dev/null
home_unread() { curl -sf -H "authorization: Bearer $HOME_TOKEN" "$HOME_URL/api/threads/$TID" | python3 -c 'import json,sys; print(sum(1 for m in json.load(sys.stdin) for r in m["recipients"] if r["id"] == "human" and not r["read_at"]))'; }
[ "$(home_unread)" = 0 ] || fail "reading on home didn't mark the mail read"

# Main doesn't hold the thread, so it asks home, and home marks it.
OUT=$(curl -sf -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "{\"ids\":[\"$TID\"]}" "$MAIN_URL/api/agents/human/threads/$TID/unread")
echo "$OUT" | grep -q "\"$TID\"" || fail "main didn't report the peer's mail as marked: $OUT"
[ "$(home_unread)" = 1 ] || fail "home still holds the mail read after main's request"

# Without the human's header main refuses, and home isn't asked.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -d "{\"ids\":[\"$TID\"]}" "$MAIN_URL/api/agents/human/threads/$TID/unread")
[ "$CODE" = 403 ] || fail "main without x-stam-human wasn't refused with 403, got $CODE"
echo "mail-unread-peers: ok"
