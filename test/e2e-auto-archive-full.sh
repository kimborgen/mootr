#!/bin/sh
# The one-time full auto-archive pass (S-637, cos): the first start with the code archives every
# resolved thread, before the cutoff too, and records in kv that it is done; a later start doesn't
# run it again. Free and no models: one isolated daemon (test/lib.sh), no delay and no quiet period.
set -e
export STAM_AUTO_ARCHIVE_QUIET_MS=0 STAM_AUTO_ARCHIVE_FULL_DELAY_MS=0
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate
TOKEN=$(cat "$STAM_HOME/token")
api() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
hapi() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
kv() { python3 -c "import sqlite3,sys; r=sqlite3.connect(sys.argv[1]).execute('SELECT value FROM kv WHERE key=?',(sys.argv[2],)).fetchone(); print(r[0] if r else '')" "$STAM_HOME/stam.db" "$1"; }
done_flag() { [ -n "$(kv autoArchive.fullPassDone3)" ]; }
runs() { grep -c 'auto-archive full pass:' "$TEST_TMP/main/daemon.log" || true; }
archived() { hapi GET '/api/agents/human/threads?limit=100&archived=1' | grep -q "\"thread_id\":\"$1\""; }
fail() { echo "FAIL: $1"; exit 1; }

echo "-- the first start runs the full pass once and records it"
wait_until done_flag
[ "$(runs)" = 1 ] || fail "full pass lines after the first start: $(runs)"

# A resolved thread from before the cutoff, which only a full pass takes in.
A=$(api POST /api/register '{"name":"alice","role":"alice","harness":"claude"}' | field '["id"]')
KEY=$("$STAM" itsa new "Full pass e2e" --owner alice --status in_progress | awk '{print $1}')
T=$(api POST /api/mail "{\"from\":\"alice\",\"to\":[\"human\"],\"subject\":\"Done\",\"body\":\"Shipped.\",\"itsa\":\"$KEY\",\"new_thread\":true}" | field '["id"]')
hapi POST /api/agents/human/read "{\"ids\":[\"$T\"]}" >/dev/null
api PATCH "/api/itsas/$KEY" "{\"status\":\"done\",\"by\":\"$A\"}" >/dev/null
python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE kv SET value='99999999999999' WHERE key='autoArchive.since'\"); c.commit()" "$STAM_HOME/stam.db"

echo "-- a later start doesn't run it again"
daemon_stop main
daemon_up main
api POST /api/mail/resolved '{"dry":false}' >/dev/null
archived "$T" && fail "a later start ran the full pass again, or the cutoff let $T in"

echo "-- with the flag gone, the next start's full pass archives the thread from before the cutoff"
daemon_stop main
python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"DELETE FROM kv WHERE key='autoArchive.fullPassDone3'\"); c.commit()" "$STAM_HOME/stam.db"
daemon_up main
wait_until done_flag
wait_until archived "$T"
[ "$(runs)" = 2 ] || fail "full pass ran $(runs) times over three starts; want 2"

echo "ok: auto-archive-full"
