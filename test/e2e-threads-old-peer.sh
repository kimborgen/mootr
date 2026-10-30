#!/bin/sh
# The mailbox list with a peer on an older release (S-4520): the peer ignores `light` and `ids` and answers every
# /threads request with its newest `limit` threads whole, as before. Main still lists every thread, and asks that
# peer for a page once, not once per part of 100 ids. Then a peer that answers the light pass but not the page:
# the web's list goes on without its mail, and auto-archive's pass refuses to judge, so a peer's thread is never
# taken for gone. One daemon and a stub peer (node), no models, so it is free.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
PORT=$(free_port)
LOG="$TEST_TMP/stub.log"
FAIL_IDS="$TEST_TMP/stub-fail-ids"
CARD_RELEASE="$TEST_TMP/stub-card-release"
: > "$LOG"
# The stub: 250 threads from its agent to the human, whole, whatever the query asks. With $CARD_RELEASE it answers a
# page's index form (ids with light) as S-4578's release did: two linked ITSAs as key and title only, no attached agents.
node - "$PORT" "$LOG" "$FAIL_IDS" "$CARD_RELEASE" <<'JS' &
const http = require('node:http');
const fs = require('node:fs');
const [port, log, failIds, cardRelease] = process.argv.slice(2);
const links = [{ id: 'opi1', key: 'S-901', title: 'First', status: 'todo', source: 'named' }, { id: 'opi2', key: 'S-902', title: 'Second', status: 'done', source: 'named' }];
const cardForm = (t) => ({ thread_id: t.thread_id, mails: t.mails.map(({ body, attachments, reply_to, ...m }) => ({ ...m, title: null, snippet: body, summary: null, verdict: null, about_itsa: null, itsas: links.map(({ key, title }) => ({ key, title })) })) });
const base = Date.UTC(2026, 9, 1);
const threads = Array.from({ length: 250 }, (_, i) => {
  const id = `op${String(i).padStart(3, '0')}`;
  // op100 to op109 share one time, and the stub lists them by id ascending: an old release has no id tie-break.
  const at = i >= 100 && i < 110 ? base + 100 * 60_000 : base + i * 60_000;
  return { thread_id: id, mails: [{ id, thread_id: id, from_id: 'op-agent', from_name: 'Old Peer', subject: `Old ${i}`, body: i === 248 ? ' \u00a0\f'.repeat(200) + 'hello' : `body ${i}`, created_at: new Date(at).toISOString(), reply_to: null, recipients: [{ id: 'human', read_at: null }], attachments: [] }] };
}).reverse();
threads.splice(140, 10, ...threads.slice(140, 150).reverse());
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
  if (req.method !== 'GET') return send({});
  if (url.pathname === '/api/health') return send({ ok: true, release: null });
  if (url.pathname === '/api/agents/human/threads') {
    fs.appendFileSync(log, url.search + '\n');
    if (url.searchParams.has('ids') && fs.existsSync(failIds)) return req.socket.destroy();
    if (url.searchParams.has('ids') && fs.existsSync(cardRelease)) {
      const ids = new Set(url.searchParams.get('ids').split(','));
      const asked = threads.filter((t) => ids.has(t.thread_id));
      if (url.searchParams.has('light')) return send(asked.map(cardForm));
      return send(asked.map((t) => ({ ...t, mails: t.mails.map((m) => ({ ...m, itsas: links, agents: ['op-helper'] })) })));
    }
    return send(threads.slice(0, Number(url.searchParams.get('limit') ?? 50)));
  }
  send([]);
}).listen(Number(port), '127.0.0.1');
JS
STUB_PID=$!
python3 - "$TEST_TMP" "$PORT" <<'PY'
import json, sys
tmp, port = sys.argv[1:]
path = f"{tmp}/main/settings.json"
s = json.load(open(path))
s["peers"] = [{"name": "oldpeer", "url": f"http://127.0.0.1:{port}", "token": "stub-token"}]
s["mail"] = {"titles": {"model": ""}}
s["decisions"] = {"mailCheck": False}
json.dump(s, open(path, "w"), indent=2)
PY
daemon_up main
trap 'stam_test_cleanup' EXIT
fail() { echo "FAIL: $1"; exit 1; }
h() { (use main && curl -s -X "$1" -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}); }
count() { python3 -c 'import json,sys; print(len(json.load(sys.stdin)))'; }
poll 10 curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || fail "the stub peer didn't start"

echo "-- an old peer's threads are all listed, and it is asked for the page once"
: > "$LOG"
N=$(h GET '/api/agents/human/threads?limit=250' | count)
[ "$N" = 250 ] || fail "main listed $N of the old peer's 250 threads"
IDS=$(grep -c 'ids=' "$LOG" || true)
[ "$IDS" = 1 ] || fail "the old peer was asked for the page $IDS times, not once: $(cat "$LOG")"
grep -q 'light=1' "$LOG" || fail "the light pass didn't ask the peer: $(cat "$LOG")"
h GET '/api/agents/human/threads?limit=250' | grep -q '"body":"body 7"' || fail "the old peer's page came without its bodies"

echo "-- the thread index pages through an old peer's threads, ten of them tied and listed out of order"
h GET '/api/agents/human/threads?limit=250' | python3 -c 'import json,sys; [print(t["thread_id"]) for t in json.load(sys.stdin)]' > "$TEST_TMP/op-threads.txt"
python3 - "$(on main sh -c 'echo "$STAM_URL"')" "$(cat "$TEST_TMP/main/token")" <<'PY' > "$TEST_TMP/op-walk.txt"
import json, sys, urllib.request
url, token = sys.argv[1:]
cursor = None
for _ in range(200):
    q = f"{url}/api/agents/human/thread-index?limit=3" + (f"&cursor={cursor}" if cursor else "")
    d = json.load(urllib.request.urlopen(urllib.request.Request(q, headers={"authorization": f"Bearer {token}", "x-stam-human": "1"})))
    for t in d["threads"]: print(t["thread_id"])
    cursor = d["next_cursor"]
    if not cursor: break
PY
[ "$(wc -l < "$TEST_TMP/op-threads.txt")" = 250 ] || fail "main didn't list the old peer's 250 threads"
cmp -s "$TEST_TMP/op-threads.txt" "$TEST_TMP/op-walk.txt" || fail "paging the old peer's threads three at a time differs from /threads: $(diff "$TEST_TMP/op-threads.txt" "$TEST_TMP/op-walk.txt" | head -20)"

echo "-- the thread index takes an old peer's snippet and card from its whole mail"
h GET '/api/agents/human/thread-index?limit=200' | python3 -c "import json,sys; r=[t for t in json.load(sys.stdin)['threads'] if t['thread_id'] == 'op249']; sys.exit(0 if r and r[0]['snippet'] == 'body 249' and r[0]['card_text'] == 'body 249' and r[0]['from_name'] == r[0]['card_from_name'] == 'Old Peer' and r[0]['card_subject'] == 'Old 249' and r[0]['last_mail_id'] == 'op249' and r[0]['agents'] == ['op-agent'] and r[0]['perms'] == [] else 1)" || fail "the index row of an old peer's thread has no snippet, card or tab fields from its mail"

h GET '/api/agents/human/thread-index?limit=200' | python3 -c "import json,sys; r=[t for t in json.load(sys.stdin)['threads'] if t['thread_id'] == 'op248']; sys.exit(0 if r and r[0]['snippet'] == 'hello' and r[0]['card_text'] == 'hello' else 1)" || fail "an old peer's body isn't cut from its first character that isn't whitespace, as a new peer's is"

echo "-- a peer on S-4578's release: its index form lacks attached agents and ITSA ids, so the page comes whole"
touch "$CARD_RELEASE"
: > "$LOG"
h GET '/api/agents/human/thread-index?limit=5' | python3 -c "import json,sys; r=[t for t in json.load(sys.stdin)['threads'] if t['thread_id'] == 'op249']; sys.exit(0 if r and r[0]['itsa_links'] == [{'id': 'opi1', 'key': 'S-901', 'title': 'First', 'status': 'todo'}, {'id': 'opi2', 'key': 'S-902', 'title': 'Second', 'status': 'done'}] and r[0]['agents'] == ['op-helper', 'op-agent'] and r[0]['itsa_chip'] == {'key': 'S-901', 'title': 'First'} else 1)" || fail "a card-release peer's thread lost its ITSA links or attached agents: $(h GET '/api/agents/human/thread-index?limit=5')"
grep 'ids=' "$LOG" | grep -qv 'light=1' || fail "the card-release peer wasn't asked for the page whole: $(cat "$LOG")"
rm -f "$CARD_RELEASE"

echo "-- a peer that answers the light pass but not the page"
touch "$FAIL_IDS"
CODE=$(use main && curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'x-stam-human: 1' "$STAM_URL/api/agents/human/threads?limit=60")
[ "$CODE" = 200 ] || fail "the web's list failed when the peer didn't answer for its page: $CODE"
OUT=$(h POST /api/mail/resolved '{"dry":true}')
echo "$OUT" | grep -q "didn't answer for the page" || fail "auto-archive judged threads without the peer's page: $OUT"
echo "threads-old-peer: ok"
