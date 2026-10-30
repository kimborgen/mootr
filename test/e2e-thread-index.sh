#!/bin/sh
# The thread index (S-4520): GET /api/agents/:box/thread-index lists a mailbox's threads as index rows, no bodies,
# a page at a time, in the same order and split as GET /api/agents/:box/threads, merged from the peers. Two daemons:
# "main", the web's, and "home", which holds its own agent's mail to the human. Free: no models.
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
# An ITSA on home, the ITSA home, for a row's ITSA links.
now = "2026-10-29T00:00:00.000Z"
json.dump({"itsas": [{"id": "ti-i1", "key": "S-91", "kind": "issue", "title": "Index tab", "status": "todo", "created_by": "human", "created_at": now, "updated_at": now}]}, open(f"{tmp}/home/test-seed.json", "w"))
PY
daemon_up main
daemon_up home
trap 'stam_test_cleanup' EXIT
fail() { echo "FAIL: $1"; exit 1; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]??""))' "$1"; }
MAIN_URL=$(on main sh -c 'echo "$STAM_URL"'); MAIN_TOKEN=$(cat "$TEST_TMP/main/token")
HOME_URL=$(on home sh -c 'echo "$STAM_URL"'); HOME_TOKEN=$(cat "$TEST_TMP/home/token")
mget() { curl -sf -H "authorization: Bearer $MAIN_TOKEN" "$MAIN_URL$1"; }
mcode() { curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $MAIN_TOKEN" "$MAIN_URL$1"; }
mpost() { curl -sf -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$2" "$MAIN_URL$1"; }
hpost() { curl -sf -X POST -H "authorization: Bearer $HOME_TOKEN" -H 'content-type: application/json' -d "$2" "$HOME_URL$1"; }
# The thread ids of a /threads list, or of an index page's rows, one per line.
tids() { python3 -c 'import json,sys; d=json.load(sys.stdin); [print(t["thread_id"]) for t in (d["threads"] if isinstance(d, dict) else d)]'; }
# Every index page of a list, followed through next_cursor, as thread ids.
walk() {
  python3 - "$MAIN_URL" "$MAIN_TOKEN" "$1" "$2" <<'PY'
import json, sys, urllib.request
url, token, lst, limit = sys.argv[1:]
cursor, pages = None, 0
while True:
    q = f"{url}/api/agents/human/thread-index?list={lst}&limit={limit}" + (f"&cursor={cursor}" if cursor else "")
    d = json.load(urllib.request.urlopen(urllib.request.Request(q, headers={"authorization": f"Bearer {token}"})))
    for t in d["threads"]: print(t["thread_id"])
    cursor, pages = d["next_cursor"], pages + 1
    if not cursor or pages > 50: break
PY
}
# One row of the active index (or of the list in $2), as JSON, by thread id.
row() { mget "/api/agents/human/thread-index?limit=200&list=${2:-active}" | python3 -c "import json,sys; print(json.dumps(next(t for t in json.load(sys.stdin)['threads'] if t['thread_id'] == '$1')))"; }
key() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }

# Agents on both daemons write to the human: main holds its agent's mail, home holds its own.
mpost /api/test/mail '{"action":"agent","id":"ti-main","name":"Main Helper"}' >/dev/null
hpost /api/test/mail '{"action":"agent","id":"ti-home","name":"Home Helper"}' >/dev/null
hpost /api/test/mail '{"action":"agent","id":"ti-home2","name":"Home Second"}' >/dev/null
for n in 1 2 3; do
  curl -sf -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -d "{\"from\":\"ti-main\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Main $n\",\"body\":\"main body $n\"}" "$MAIN_URL/api/mail" >/dev/null
  hpost /api/mail "{\"from\":\"ti-home\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Home $n\",\"body\":\"home body $n\"}" >/dev/null
done
SPACED=$(hpost /api/mail '{"from":"ti-home","to":["human"],"new_thread":true,"subject":"Spaced","body":"first line\n\n   second   line"}' | field id)
[ -n "$SPACED" ] || fail "home didn't take the spaced mail"

# The index lists what /threads lists, in its order, with no bodies.
mget "/api/agents/human/threads?limit=60" | tids > "$TEST_TMP/threads.txt"
mget "/api/agents/human/thread-index?limit=60" | tids > "$TEST_TMP/index.txt"
[ "$(wc -l < "$TEST_TMP/threads.txt")" -ge 7 ] || fail "main's list lacks the peer's threads: $(cat "$TEST_TMP/threads.txt")"
cmp -s "$TEST_TMP/threads.txt" "$TEST_TMP/index.txt" || fail "the index differs from /threads: $(paste "$TEST_TMP/threads.txt" "$TEST_TMP/index.txt")"
mget "/api/agents/human/thread-index?limit=60" | grep -q '"mails"\|"body"' && fail "the index carries mails or bodies"

# A row holds what the list shows: the peer's mail, its snippet with the whitespace collapsed, unread, sender.
R=$(row "$SPACED")
[ "$(printf "%s\n" "$R" | key snippet)" = "first line second line" ] || fail "the snippet isn't collapsed: $R"
[ "$(printf "%s\n" "$R" | key subject)" = "Spaced" ] || fail "the subject is wrong: $R"
[ "$(printf "%s\n" "$R" | key from_id)" = "ti-home" ] || fail "the sender is wrong: $R"
[ "$(printf "%s\n" "$R" | key unread)" = 1 ] || fail "the unread count is wrong: $R"
[ "$(printf "%s\n" "$R" | key mail_count)" = 1 ] || fail "the mail count is wrong: $R"

# A thread held on both daemons is one row: the human answers home's mail through main.
mpost /api/mail "{\"from\":\"human\",\"to\":[\"ti-home\"],\"reply_to\":\"$SPACED\",\"body\":\"the answer\"}" >/dev/null
R=$(row "$SPACED")
[ "$(printf "%s\n" "$R" | key mail_count)" = 2 ] || fail "the two daemons' mail of one thread isn't one row: $R"
[ "$(printf "%s\n" "$R" | key snippet)" = "the answer" ] || fail "the snippet isn't the last mail's: $R"
[ "$(printf "%s\n" "$R" | key from_id)" = "human" ] || fail "the sender isn't the last mail's: $R"
# Its card is still home's mail to the human (S-4578): that mail's sender and text, line breaks kept.
[ "$(printf "%s\n" "$R" | key card_from_id)" = "ti-home" ] || fail "the card isn't the last mail to the box: $R"
[ "$(printf "%s\n" "$R" | key card_from_name)" = "Home Helper" ] || fail "the card's sender has no name: $R"
printf "%s\n" "$R" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r["card_text"] == "first line\n\n   second   line" and r["box_last_from"] == "human" and r["last_created_at"] == r["last_at"] and r["first_created_at"] < r["last_created_at"] else 1)' || fail "the card's text, box_last_from, last_created_at or first_created_at is wrong: $R"
# What the tab reads (S-4579): the card mail's own subject, the last mail's id, the agents without the human, and
# empty lists, not missing ones, where the thread has no asks or ITSAs.
printf "%s\n" "$R" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r["card_subject"] == "Spaced" and r["last_mail_id"] not in ("", r["thread_id"]) and r["agents"] == ["ti-home"] and r["perms"] == [] and r["itsa_links"] == [] and r["about_itsas"] == [] else 1)' || fail "the tab's fields are wrong: $R"
# A mail about an ITSA, cc another agent on home: the ITSA's link and id, and the agents senders first, then recipients.
ABOUT=$(hpost /api/mail '{"from":"ti-home","to":["human","ti-home2"],"new_thread":true,"subject":"About","body":"about it","itsa":"S-91"}' | field id)
[ -n "$ABOUT" ] || fail "home didn't take the mail about S-91"
R=$(row "$ABOUT")
printf "%s\n" "$R" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r["itsa_links"] == [{"id": "ti-i1", "key": "S-91", "title": "Index tab", "status": "todo"}] and r["about_itsas"] == ["ti-i1"] and r["itsa_chip"] == {"key": "S-91", "title": "Index tab"} and r["agents"] == ["ti-home", "ti-home2"] and r["last_mail_id"] == r["thread_id"] else 1)' || fail "a mail about an ITSA has the wrong tab fields: $R"
# A thread of only the human's own mail (archived until an answer comes): its card speaks for the recipient, with no name.
SENT=$(mpost /api/mail '{"from":"human","to":["ti-main"],"new_thread":true,"subject":"Sent","body":"from me"}' | field thread_id)
R=$(row "$SENT" archived)
[ "$(printf "%s\n" "$R" | key card_from_id)" = "ti-main" ] && [ "$(printf "%s\n" "$R" | key card_from_name)" = None ] || fail "a sent thread's card isn't its recipient's: $R"
[ "$(printf "%s\n" "$R" | key card_text)" = "from me" ] || fail "a sent thread's card text isn't its last mail's: $R"

# Pages of two follow each other through the cursor: every thread once, in the list's order.
mget "/api/agents/human/threads?limit=60" | tids > "$TEST_TMP/threads.txt"
walk active 2 > "$TEST_TMP/walk.txt"
cmp -s "$TEST_TMP/threads.txt" "$TEST_TMP/walk.txt" || fail "paging through the cursor differs from /threads: $(paste "$TEST_TMP/threads.txt" "$TEST_TMP/walk.txt")"
[ "$(mget "/api/agents/human/thread-index?limit=200" | key next_cursor)" = None ] || fail "a page holding the whole list has a next cursor"

# Mail between page reads: the next page goes on from the cursor's place in the order, not from where its thread is
# now. Four new threads, the newest of the list, read two at a time; the second page must be the other two.
W=""
for n in 1 2 3 4; do W="$W $(hpost /api/mail "{\"from\":\"ti-home\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Walk $n\",\"body\":\"w\"}" | field id)"; done
P1=$(mget "/api/agents/human/thread-index?limit=2")
C1=$(printf "%s\n" "$P1" | key next_cursor)
ANCHOR=$(printf "%s\n" "$P1" | tids | tail -1)
rest() { for t in $W; do printf "%s\n" "$P1" | tids | grep -qx "$t" || echo "$t"; done | sort | tr '\n' ' '; }
REST=$(rest)
# New mail on the cursor's thread moves it to the top: the next page doesn't repeat the row above it.
hpost /api/mail "{\"from\":\"ti-home\",\"to\":[\"human\"],\"reply_to\":\"$ANCHOR\",\"body\":\"again\"}" >/dev/null
[ "$(mget "/api/agents/human/thread-index?limit=2&cursor=$C1" | tids | sort | tr '\n' ' ')" = "$REST" ] || fail "after mail on the cursor's thread, the next page isn't the rows below it: $(mget "/api/agents/human/thread-index?limit=2&cursor=$C1" | tids | tr '\n' ' ') vs $REST"
# A burst of threads newer than the whole list, more than the page's read holds, doesn't end the list early.
for n in 1 2 3 4 5 6; do hpost /api/mail "{\"from\":\"ti-home\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Burst $n\",\"body\":\"b\"}" >/dev/null; done
[ "$(mget "/api/agents/human/thread-index?limit=2&cursor=$C1" | tids | sort | tr '\n' ' ')" = "$REST" ] || fail "after a burst of new threads, the next page isn't the rows below the cursor: $(mget "/api/agents/human/thread-index?limit=2&cursor=$C1" | tids | tr '\n' ' ') vs $REST"

# Archive and permission state: an archived thread moves to the archived list; a pending ask shows on its row.
FIRST=$(head -1 "$TEST_TMP/threads.txt")
mpost "/api/agents/human/threads/$FIRST/archive" '{}' >/dev/null
mget "/api/agents/human/thread-index?limit=60" | tids | grep -qx "$FIRST" && fail "an archived thread is still in the active index"
mget "/api/agents/human/thread-index?list=archived&limit=60" | tids | grep -qx "$FIRST" || fail "the archived index lacks the archived thread"
mpost /api/permissions '{"agent":"ti-main","action":"Run the index check","reason":"because","details":"none","audience":"human"}' >/dev/null
mget "/api/agents/human/thread-index?limit=60" | python3 -c "import json,sys; rows=json.load(sys.stdin)['threads']; sys.exit(0 if any(r['ask'] == 'pending' and r['subject'].startswith('Permission: ') and len(r['perms']) == 1 and r['perms'][0]['id'] and r['perms'][0]['placed'] is False for r in rows) else 1)" || fail "the pending ask's row has no ask state or perms"

# The archived list pages through every archived thread, even with more active threads newer than all of them:
# five threads archived, then twelve newer ones, read ten at a time.
OLDT=""
for n in 1 2 3 4 5; do OLDT="$OLDT $(hpost /api/mail "{\"from\":\"ti-home\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"Old $n\",\"body\":\"o\"}" | field id)"; done
for t in $OLDT; do mpost "/api/agents/human/threads/$t/archive" '{}' >/dev/null; done
for n in $(seq 1 12); do hpost /api/mail "{\"from\":\"ti-home\",\"to\":[\"human\"],\"new_thread\":true,\"subject\":\"New $n\",\"body\":\"n\"}" >/dev/null; done
walk archived 10 > "$TEST_TMP/archived.txt"
for t in $OLDT $FIRST; do grep -qx "$t" "$TEST_TMP/archived.txt" || fail "paging the archived list missed $t: $(cat "$TEST_TMP/archived.txt")"; done
[ "$(sort "$TEST_TMP/archived.txt" | uniq -d)" = "" ] || fail "paging the archived list gave a thread twice"

# A deferred thread is on the deferred list, not the active one; `with` keeps the threads with that agent.
DEF=$(echo $OLDT | cut -d' ' -f1)
mpost "/api/agents/human/threads/$DEF/defer" '{}' >/dev/null
mget "/api/agents/human/thread-index?list=deferred" | tids | grep -qx "$DEF" || fail "the deferred index lacks the deferred thread"
mget "/api/agents/human/thread-index?limit=200" | tids | grep -qx "$DEF" && fail "a deferred thread is still in the active index"
mget "/api/agents/human/thread-index?limit=200&with=ti-main" | python3 -c "import json,sys; rows=json.load(sys.stdin)['threads']; sys.exit(0 if rows and all(r['subject'].startswith(('Main ', 'Permission: ')) for r in rows) else 1)" || fail "with= kept threads without that agent"

# Two threads at one time, read one a page, the first archived between the reads: the second isn't skipped.
X=$(hpost /api/mail '{"from":"ti-home","to":["human"],"new_thread":true,"subject":"Tie 1","body":"t"}' | field id)
Y=$(hpost /api/mail '{"from":"ti-home","to":["human"],"new_thread":true,"subject":"Tie 2","body":"t"}' | field id)
for t in $X $Y; do hpost /api/test/mail "{\"action\":\"set-time\",\"mail\":\"$t\",\"at\":\"2099-01-01T00:00:00.000Z\"}" >/dev/null; done
P1=$(mget "/api/agents/human/thread-index?limit=1")
TOP=$(printf "%s\n" "$P1" | tids)
OTHER=$([ "$TOP" = "$X" ] && echo "$Y" || echo "$X")
[ "$TOP" = "$X" ] || [ "$TOP" = "$Y" ] || fail "the tied threads aren't the top of the list: $TOP"
mpost "/api/agents/human/threads/$TOP/archive" '{}' >/dev/null
[ "$(mget "/api/agents/human/thread-index?limit=1&cursor=$(printf "%s\n" "$P1" | key next_cursor)" | tids)" = "$OTHER" ] || fail "the thread tied with an archived cursor thread was skipped"

# More threads at one time than a page's read holds, in a mailbox with nothing archived or deferred to pad it: read
# one a page, every thread comes once.
mpost /api/test/mail '{"action":"agent","id":"ti-tie","name":"Tie Box"}' >/dev/null
for n in 1 2 3 4; do
  T=$(curl -sf -X POST -H "authorization: Bearer $MAIN_TOKEN" -H 'content-type: application/json' -d "{\"from\":\"ti-main\",\"to\":[\"ti-tie\"],\"new_thread\":true,\"subject\":\"Tied $n\",\"body\":\"t\"}" "$MAIN_URL/api/mail" | field id)
  mpost /api/test/mail "{\"action\":\"set-time\",\"mail\":\"$T\",\"at\":\"2099-02-01T00:00:00.000Z\"}" >/dev/null
done
python3 - "$MAIN_URL" "$MAIN_TOKEN" <<'PY' > "$TEST_TMP/tied.txt"
import json, sys, urllib.request
url, token = sys.argv[1:]
get = lambda q: json.load(urllib.request.urlopen(urllib.request.Request(url + q, headers={"authorization": f"Bearer {token}"})))
cursor = None
for _ in range(10):
    d = get("/api/agents/ti-tie/thread-index?limit=1" + (f"&cursor={cursor}" if cursor else ""))
    for t in d["threads"]: print(t["thread_id"])
    cursor = d["next_cursor"]
    if not cursor: break
PY
mget "/api/agents/ti-tie/threads?limit=60" | tids > "$TEST_TMP/tied-threads.txt"
[ "$(wc -l < "$TEST_TMP/tied-threads.txt")" = 4 ] || fail "the tie box doesn't hold its four threads: $(cat "$TEST_TMP/tied-threads.txt")"
cmp -s "$TEST_TMP/tied-threads.txt" "$TEST_TMP/tied.txt" || fail "paging four tied threads one at a time differs from /threads: $(paste "$TEST_TMP/tied-threads.txt" "$TEST_TMP/tied.txt")"

# Bad input is refused, not read as the first page.
[ "$(mcode "/api/agents/human/thread-index?cursor=$(printf '{"at":"x","t":"y","n":100000000}' | base64 -w0 | tr '+/' '-_' | tr -d '=')")" = 400 ] || fail "a cursor past the row bound wasn't refused with 400"
[ "$(mcode "/api/agents/human/thread-index?cursor=nope")" = 400 ] || fail "a bad cursor wasn't refused with 400"
[ "$(mcode "/api/agents/human/thread-index?list=all")" = 400 ] || fail "a bad list wasn't refused with 400"
[ "$(mcode "/api/agents/human/thread-index?limit=0")" = 400 ] || fail "a zero limit wasn't refused with 400"
echo "thread-index: ok"
