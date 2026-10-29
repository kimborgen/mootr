#!/bin/sh
# The Needs you list (S-3831), free (no models, no agent turns). Two isolated daemons, "main" and "twin",
# peered. The far agent lives on twin. Permission rows of every kind are seeded straight into twin's
# database (a dialog or a suggested input has no public route to make one), then the test answers, escalates
# and settles them through the routes. Checks:
#   - main lists exactly the expected open and settled asks, by kind, id, state, outcome and count
#   - the settled rows survive a restart of twin (read from the database)
#   - a delegate ask is off the list until it is escalated to the human
#   - a decision about an ITSA in a human status is off main while that ITSA waits, and listed once it leaves
#   - an ITSA's two cycles settle with their own outcomes: withdrawn, then approved
#   - a row held on both daemons shows once, and a settlement on each daemon stays its own row
#   - settled rows older than a day are left out
#   - no secret reaches the list: a sentinel in each kind's action, details, settings payload and input text stays out
#   - an agent's token can't read the list
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_home twin
python3 - "$TEST_TMP" <<'PY'
import json, re, sys
tmp = sys.argv[1]
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, other in (("main", "twin"), ("twin", "main")):
    path = f"{tmp}/{me}/settings.json"
    try:
        s = json.load(open(path))
    except FileNotFoundError:
        s = {}
    s["peers"] = [peer(other)]
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
# api DAEMON METHOD PATH [BODY] [human]: the human's calls carry the x-stam-human header.
api() {
  _url=$MAIN_URL; _tok=$MAIN_TOKEN; [ "$1" = twin ] && { _url=$TWIN_URL; _tok=$TWIN_TOKEN; }
  _human=; [ "$5" = human ] && _human='-H x-stam-human:1'
  curl -s -X "$2" -H "authorization: Bearer $_tok" $_human -H 'content-type: application/json' ${4:+-d "$4"} "$_url$3"
}
FENCE='```'
SECRET=STAM-SENTINEL-SECRET-7f3a # gitleaks:allow

FAR=$(api twin POST /api/register '{"name":"far","role":"test","harness":"claude"}' | jget "d['id']")
NEAR=$(api main POST /api/register '{"name":"near","role":"test","harness":"claude"}' | jget "d['id']")
TWIN_DB=$(find "$TEST_TMP/twin" -name stam.db | head -n 1)
[ -n "$TWIN_DB" ] || fail "twin's database isn't where the test looks"

# seed twin's permission rows: seed ID AGENT KIND STATUS AUDIENCE ACTION DECIDED_HOURS_AGO
seed() {
  python3 - "$TWIN_DB" "$@" <<'PY'
import sqlite3, sys
from datetime import datetime, timedelta, timezone
db, rid, agent, kind, status, audience, action, hours = sys.argv[1:9]
now = datetime.now(timezone.utc)
decided = None if status in ("pending", "held") else (now - timedelta(hours=float(hours))).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
created = (now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
con = sqlite3.connect(db, timeout=10)
con.execute("""INSERT INTO permission_requests (id, agent_id, action, reason, details, status, decided_by, note, created_at, decided_at,
  kind, dialog, payload, audience, text, sha256, expires_at, session_id, home_thread, home_itsa, home_override)
  VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)""",
  (rid, agent, action, "a reason", "details " + "STAM-SENTINEL-SECRET-7f3a", status, created, decided,
   kind, 1 if kind == "dialog" else 0, '{"tier":"x","secret":"STAM-SENTINEL-SECRET-7f3a"}' if kind == "settings" else None, # gitleaks:allow
   audience, "typed text STAM-SENTINEL-SECRET-7f3a" if kind == "input" else None,
   "0" * 64 if kind == "input" else None, (now + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z") if kind == "input" else None))
con.commit()
PY
}
# Copies rows of table $1 where $2 (args $3...) from twin's database into main's, the way a copy sits on both daemons.
# Columns in $4 (comma list) are left out, so the copy takes its own autoincrement id on main.
copy_rows() {
  python3 - "$TWIN_DB" "$(find "$TEST_TMP/main" -name stam.db | head -n 1)" "$1" "$2" "$3" "$4" <<'PY'
import sqlite3, sys
src, dst, table, where, arg, skip = sys.argv[1:7]
a = sqlite3.connect(src)
cols = [d[1] for d in a.execute(f"PRAGMA table_info({table})") if d[1] not in skip.split(",")]
rows = a.execute(f"SELECT {', '.join(cols)} FROM {table} WHERE {where}", (arg,)).fetchall()
b = sqlite3.connect(dst, timeout=10)
b.executemany(f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", rows)
b.commit()
PY
}

echo "-- seed every kind on twin: open, settled, a delegate ask, and one older than a day"
seed pOPENREQ "$FAR" request pending human "clear the cache $SECRET" 0
seed pOPENDLG "$FAR" dialog pending human "Trust this folder?" 0
seed pOPENSET "$FAR" settings pending human "change the tier" 0
seed pOPENINP "$FAR" input pending human "type the reply" 0
seed pDELEG "$FAR" request pending delegate "delegated ask" 0
seed pDENIED "$FAR" request denied human "old denial" 1
seed pTYPED "$FAR" input approved human "typed box" 2
seed pEXPIRED "$FAR" input expired human "expired box" 3
seed pFAILED "$FAR" input failed human "failed box" 4
seed pWITHDRAWN "$FAR" request withdrawn human "withdrawn ask" 5
seed pOLD "$FAR" request denied human "a day old" 25

echo "-- a delegate ask is off the list until it is escalated to the human"
_absent() { [ "$(api main GET /api/asks | jget "len([x for x in d if x['key'] == 'request:pDELEG'])")" = 0 ]; }
wait_until _absent || fail "a delegate ask is on the list before it is escalated"
# Escalation is the reviewer's act (only a reviewing agent may escalate, and the human may not), and its one stored
# effect is the audience moving to the human (escalatePermissionRequest). The test writes that effect directly.
python3 - "$TWIN_DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=10)
con.execute("UPDATE permission_requests SET audience = 'human' WHERE id = 'pDELEG' AND status = 'pending' AND audience = 'delegate'")
con.commit()
PY
_present() { [ "$(api main GET /api/asks | jget "len([x for x in d if x['key'] == 'request:pDELEG' and x['state'] == 'open'])")" = 1 ]; }
wait_until _present || fail "an escalated delegate ask is not on the list"

echo "-- a decision about an ITSA homed on main, in a human status, is off both lists while the ITSA waits"
R=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Pick a release\",\"body\":\"Which?\n\n${FENCE}pick\nbilling\nsearch\n${FENCE}\"}")
MOPEN=$(printf '%s' "$R" | jget "d['id']")
ITSA_A=$(on main "$STAM" itsa new "Held on main" --owner near --status in_progress | awk '{print $1}')
ITSA_A_ID=$(api main GET "/api/itsas/$ITSA_A" | jget "(d.get('itsa') or d)['id']")
# twin can't link an ITSA it doesn't hold, so the decision is made on main, about the ITSA main homes, and its mail
# and decision rows are copied to twin: twin holds the decision too, and only the other home's ITSA can hold it.
R=$(api main POST /api/mail "{\"from\":\"$NEAR\",\"to\":[\"human\"],\"subject\":\"Ship it\",\"body\":\"${FENCE}yesno\nship?\n${FENCE}\",\"itsa\":\"$ITSA_A\"}")
MHELD=$(printf '%s' "$R" | jget "d['id']")
python3 - "$(find "$TEST_TMP/main" -name stam.db | head -n 1)" "$TWIN_DB" "$MHELD" <<'PY'
import sqlite3, sys
src, dst, mid = sys.argv[1:4]
a = sqlite3.connect(src); b = sqlite3.connect(dst, timeout=10)
cols = [d[1] for d in a.execute("PRAGMA table_info(mail)")]
row = a.execute(f"SELECT {', '.join(cols)} FROM mail WHERE id = ?", (mid,)).fetchone()
b.execute(f"INSERT OR IGNORE INTO mail ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", row)
b.execute("INSERT OR IGNORE INTO decision_mails (mail_id, thread_id) SELECT id, thread_id FROM mail WHERE id = ?", (mid,))
b.commit()
PY
api main POST "/api/itsas/$ITSA_A/post" "{\"by\":\"$NEAR\",\"body\":\"Done: ready to look at.\"}" >/dev/null
api main PATCH "/api/itsas/$ITSA_A" "{\"status\":\"needs_review\",\"by\":\"$NEAR\"}" >/dev/null
# The ITSA row is listed once on each entry daemon, homed on main; the decision, held on twin, is listed on neither.
_itsa_open() { [ "$(api "$1" GET /api/asks | jget "[x['machine'] for x in d if x['kind'] == 'itsa' and x['state'] == 'open' and x['itsa_id'] == '$ITSA_A_ID']")" = "['main']" ]; }
wait_until _itsa_open main || fail "main doesn't list the ITSA waiting on the human, homed on main"
wait_until _itsa_open twin || fail "twin doesn't list the ITSA waiting on the human, homed on main"
for _d in main twin; do
  [ "$(api "$_d" GET /api/asks | jget "len([x for x in d if x['key'] == 'decision:$MHELD'])")" = 0 ] || fail "$_d lists a decision held by an ITSA waiting on the human"
done

echo "-- an ITSA's two cycles settle with their own outcomes: withdrawn, then approved"
ITSA_B=$(on twin "$STAM" itsa new "Two cycles on twin" --owner far --status in_progress | awk '{print $1}')
ITSA_B_ID=$(api twin GET "/api/itsas/$ITSA_B" | jget "(d.get('itsa') or d)['id']")
api twin POST "/api/itsas/$ITSA_B/post" "{\"by\":\"$FAR\",\"body\":\"Done.\"}" >/dev/null
api twin PATCH "/api/itsas/$ITSA_B" "{\"status\":\"needs_review\",\"by\":\"$FAR\"}" >/dev/null
api twin PATCH "/api/itsas/$ITSA_B" "{\"status\":\"in_progress\",\"by\":\"$FAR\"}" >/dev/null
api twin POST "/api/itsas/$ITSA_B/post" "{\"by\":\"$FAR\",\"body\":\"Again: ready.\"}" >/dev/null
api twin PATCH "/api/itsas/$ITSA_B" "{\"status\":\"needs_review\",\"by\":\"$FAR\"}" >/dev/null
REV=$(api twin GET "/api/itsas/$ITSA_B" | jget "d['rev']")
api twin POST "/api/itsas/$ITSA_B/act" "{\"action\":\"approve\",\"if_rev\":\"$REV\"}" human >/dev/null
echo "-- two cycles of one ITSA at the same instant still settle as two rows"
python3 - "$TWIN_DB" "$ITSA_B_ID" <<'PY'
import json, sqlite3, sys
from datetime import datetime, timedelta, timezone
db, itsa = sys.argv[1:3]
con = sqlite3.connect(db, timeout=10)
ids = [r[0] for r in con.execute("SELECT id, data FROM itsa_events WHERE itsa_id = ? AND type = 'status' ORDER BY id", (itsa,)) if json.loads(r[1] or '{}').get('from') == 'needs_review']
if len(ids) != 2: raise SystemExit(f"expected two cycles, got {ids}")
ts = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
con.executemany("UPDATE itsa_events SET ts = ? WHERE id = ?", [(ts, i) for i in ids])
con.commit()
PY
api main PATCH "/api/itsas/$ITSA_A" "{\"status\":\"in_progress\",\"by\":\"$NEAR\"}" >/dev/null
# Once the ITSA leaves its human status, the decision comes back on both daemons, each as its own copy: main's row
# is main's, twin's row is twin's (a copy that is open on both is one row per daemon's own list).
_held_back() { [ "$(api "$1" GET /api/asks | jget "[x['machine'] for x in d if x['key'] == 'decision:$MHELD' and x['state'] == 'open']")" = "['$1']" ]; }
wait_until _held_back main || fail "main doesn't list the decision once its ITSA leaves the human status"
wait_until _held_back twin || fail "twin doesn't list the decision once its ITSA leaves the human status"

echo "-- the human answers a decision on twin and on main, and each daemon's settlement stays its own row"
api twin POST /api/mail "{\"from\":\"human\",\"to\":[\"$FAR\"],\"subject\":\"Re: Pick a release\",\"body\":\"billing\",\"reply_to\":\"$MOPEN\"}" human >/dev/null
R=$(api main POST /api/mail "{\"from\":\"$NEAR\",\"to\":[\"human\"],\"subject\":\"Main's own\",\"body\":\"${FENCE}pick\nbilling\nsearch\n${FENCE}\"}")
MMAIN=$(printf '%s' "$R" | jget "d['id']")
api main POST /api/mail "{\"from\":\"human\",\"to\":[\"$NEAR\"],\"subject\":\"Re: Main's own\",\"body\":\"billing\",\"reply_to\":\"$MMAIN\"}" human >/dev/null
echo "-- a stale open copy of a decision on main doesn't outshine its settlement on twin: each entry daemon shows it once, settled"
R=$(api twin POST /api/mail "{\"from\":\"$FAR\",\"to\":[\"human\"],\"subject\":\"Stale copy\",\"body\":\"${FENCE}pick\nbilling\nsearch\n${FENCE}\"}")
MSW=$(printf '%s' "$R" | jget "d['id']")
api twin POST /api/mail "{\"from\":\"human\",\"to\":[\"$FAR\"],\"subject\":\"Re: Stale copy\",\"body\":\"billing\",\"reply_to\":\"$MSW\"}" human >/dev/null
copy_rows mail "id = ?" "$MSW" ""
python3 - "$(find "$TEST_TMP/main" -name stam.db | head -n 1)" "$MSW" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1], timeout=10)
con.execute("INSERT OR IGNORE INTO decision_mails (mail_id, thread_id) SELECT id, thread_id FROM mail WHERE id = ?", (sys.argv[2],))
con.commit()
PY
_once() { [ "$(api "$1" GET /api/asks | jget "[x['state'] for x in d if x['key'] == 'decision:$MSW']")" = "['settled']" ]; }
wait_until _once main || fail "main doesn't show the settled decision once"
wait_until _once twin || fail "twin doesn't show the settled decision once"
echo "-- answering the open permission and the open decision on twin settles them"
api twin POST "/api/permissions/pOPENREQ/answer" '{"approve":false,"note":"no"}' human >/dev/null

echo "-- copies of one settled permission and one settled decision sit on main too: each shows once"
copy_rows permission_requests "id = ?" pTYPED ""
copy_rows mail "id = ?" "$MOPEN" ""
copy_rows comms_events "kind = 'decision' AND ref = ?" "$MOPEN" "id"

echo "-- a restart of twin keeps every settled row"
daemon_stop twin
daemon_up twin
TWIN_URL=$(on twin sh -c 'echo "$STAM_URL"')

echo "-- main lists exactly the expected asks, once each, with no secret and nothing older than a day"
EXPECTED='[
 ["request","pOPENREQ","settled","denied"],
 ["dialog","pOPENDLG","open",null],
 ["settings","pOPENSET","open",null],
 ["input","pOPENINP","open",null],
 ["request","pDELEG","open",null],
 ["request","pDENIED","settled","denied"],
 ["input","pTYPED","settled","typed"],
 ["input","pEXPIRED","settled","expired"],
 ["input","pFAILED","settled","failed"],
 ["request","pWITHDRAWN","settled","withdrawn"],
 ["decision","'"$MOPEN"'","settled","answered"],
 ["decision","'"$MHELD"'","open",null],
 ["decision","'"$MMAIN"'","settled","answered"],
 ["decision","'"$MSW"'","settled","answered"],
 ["itsa","'"$ITSA_A_ID"'","settled","withdrawn"],
 ["itsa","'"$ITSA_B_ID"'","settled","withdrawn"],
 ["itsa","'"$ITSA_B_ID"'","settled","approved"]
]'
api main GET /api/asks > "$TEST_TMP/asks.json"
python3 - "$TEST_TMP/asks.json" "$EXPECTED" "$SECRET" <<'PY' || fail "the list doesn't match the expected asks (see $TEST_TMP/asks.json)"
import json, sys
raw, expected, secret = open(sys.argv[1]).read(), json.loads(sys.argv[2]), sys.argv[3]
rows = json.loads(raw)
if secret in raw: raise SystemExit("a secret reached the list")
for r in rows:
    if not isinstance(r, dict): raise SystemExit(f"a row is not an object: {r}")
got = sorted(
    (r["kind"], r["itsa_id"] if r["kind"] == "itsa" else (r["key"].split(":", 1)[1].split("@")[0] if r["kind"] == "decision" else r["key"].split(":", 1)[1]), r["state"], r["outcome"])
    for r in rows)
want = sorted((k, i, s, o) for k, i, s, o in expected)
if len(got) != len(want): raise SystemExit(f"count {len(got)} != {len(want)}: {got}")
if got != want: raise SystemExit(f"rows differ:\n got {got}\nwant {want}")
# the open asks are oldest first, then the settled ones newest first
open_ = [r["since"] for r in rows if r["state"] == "open"]
settled = [r["settled_at"] for r in rows if r["state"] == "settled"]
if open_ != sorted(open_): raise SystemExit("open asks are not oldest first")
if settled != sorted(settled, reverse=True): raise SystemExit("settled asks are not newest first")
for r in rows:
    if r["kind"] in ("request", "dialog", "settings", "input") and r["what"] not in ("Permission request", "Harness dialog", "Settings change", "Suggested input"):
        raise SystemExit(f"a permission row shows its text: {r['what']}")
PY

echo "-- an agent's token can't read the list"
AGENT_TOKEN=$(api main POST /api/register '{"name":"ghost","role":"test","harness":"claude","token":true}' | jget "d['token']")
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AGENT_TOKEN" "$MAIN_URL/api/asks")" = 403 ] || fail "an agent's token read the list"

echo "PASS: needs-you asks"
