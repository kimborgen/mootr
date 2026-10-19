#!/bin/sh
# Settings › Mail to you, per model, end to end (free, no models): one isolated daemon with a
# parent (boss) and a child on claude-haiku-5-5, which is off by default. Checks:
#   - a plain child's mail to the human is rerouted to its parent (S-548); a manager child's is refused and names its parent; mail to its parent works
#   - the child's ITSA move to needs_input is refused, and an ITSA created as needs_input is too
#   - request_permission still reaches the human, and a model missing from the map may mail
#   - with humanMail.models set to true for the model, the mail and the ITSA move go through
set -e
# The human is the request carrying the test key, which stands in for tailscale serve: only the human writes settings.
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
api() {
  curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"
}
# human_api METHOD PATH [BODY]: a call as the human (the test key), for the routes only the human writes.
human_api() {
  curl -sf -X "$1" -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' ${3:+-d "$3"} "$STAM_URL$2"
}
# call METHOD PATH BODY: the status code, then the response body.
call() {
  curl -s -w '\n%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$3" "$STAM_URL$2" | python3 -c 'import sys; t=sys.stdin.read(); b,_,c=t.rpartition("\n"); print(c, b)'
}
register() { api POST /api/register "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\"$2}" | jget "d['id']"; }

BOSS=$(register boss "")
HK=$(register haiku ",\"model\":\"claude-haiku-5-5\"")
api POST "/api/agents/$HK/adopt" "{\"parent\":\"$BOSS\"}" >/dev/null || fail "adopt failed"

# 0. A plain child's mail to the human is rerouted to its parent (S-548), whatever its model.
R=$(call POST /api/mail "{\"from\":\"$HK\",\"to\":[\"human\"],\"subject\":\"Reroute\",\"body\":\"Finished.\"}")
echo "$R" | grep -q "^200 \|^201 " || fail "a plain child's mail to the human wasn't rerouted: $R"
echo "$R" | grep -q "Meant for your user" || fail "the rerouted mail isn't marked for the parent: $R"

# A manager may mail the human directly, so only it meets the per-model block (S-139) that follows.
node --no-warnings -e '
const { DatabaseSync } = require("node:sqlite");
new DatabaseSync(process.argv[1]).prepare("UPDATE agents SET type = ? WHERE id = ?").run("manager", process.argv[2]);' "$STAM_HOME/stam.db" "$HK"

# 1. The child's mail to the human is refused, naming its parent; mail to its parent works.
R=$(call POST /api/mail "{\"from\":\"$HK\",\"to\":[\"human\"],\"subject\":\"Done\",\"body\":\"Finished.\"}")
echo "$R" | grep -q "^400 \|^500 " || fail "the child's mail to the human wasn't refused: $R"
echo "$R" | grep -q "runs claude-haiku-5-5, which may not mail your user" || fail "the refusal doesn't say why: $R"
echo "$R" | grep -q "Mail your parent (boss)" || fail "the refusal doesn't name the parent: $R"
R=$(call POST /api/mail "{\"from\":\"$HK\",\"to\":[\"$BOSS\"],\"subject\":\"Done\",\"body\":\"Finished.\"}")
echo "$R" | grep -q "^200 \|^201 " || fail "mail to its parent failed: $R"

# 2. ITSA moves to a status that waits on the human are refused: a move, and a create.
KEY=$("$STAM" itsa new "Haiku e2e" --owner haiku --status in_progress | awk '{print $1}')
R=$(call PATCH "/api/itsas/$KEY" "{\"status\":\"needs_input\",\"by\":\"$HK\"}")
echo "$R" | grep -q "may not" || fail "the child's move to needs_input wasn't refused: $R"
echo "$R" | grep -q "Hand it to your parent (boss)" || fail "the ITSA refusal doesn't name the parent: $R"
R=$(call POST /api/itsas "{\"title\":\"Haiku create\",\"status\":\"needs_input\",\"by\":\"$HK\"}")
echo "$R" | grep -q "may not" || fail "the child's create as needs_input wasn't refused: $R"
api GET "/api/itsas/$KEY" | jget "d['status']" | grep -q in_progress || fail "a refused move changed the status"

# 2b. In an ITSA thread the child's comment still lands and reaches its parent, but not the human.
api PATCH "/api/itsas/$KEY" "{\"participants\":[\"$BOSS\"],\"by\":\"$HK\"}" >/dev/null || fail "adding the parent as a participant failed"
R=$(call POST "/api/itsas/$KEY/post" "{\"by\":\"$HK\",\"body\":\"Thread-only update.\",\"to\":[\"human\"]}")
echo "$R" | grep -q "^200 \|^201 " || fail "a comment in the ITSA thread was refused: $R"
api GET "/api/itsas/$KEY/thread" | python3 -c '
import json, sys
d = json.load(sys.stdin)
m = [i["mail"] for i in d["items"] if i["type"] == "mail" and i["mail"]["body"] == "Thread-only update."][0]
ids = [r["id"] for r in m["recipients"]]
sys.exit(0 if "human" not in ids and "'"$BOSS"'" in ids else 1)
' || fail "the thread comment went to the human, or not to the parent"

# 3. request_permission still reaches the human.
R=$(call POST /api/permissions "{\"agent\":\"$HK\",\"action\":\"Run the tests\",\"reason\":\"Needed\",\"details\":\"\",\"audience\":\"human\"}")
echo "$R" | grep -q "^200 \|^201 " || fail "request_permission was refused: $R"

# 4. A model missing from the map may mail the human.
R=$(call POST /api/mail "{\"from\":\"$BOSS\",\"to\":[\"human\"],\"subject\":\"Plan\",\"body\":\"Ready.\"}")
echo "$R" | grep -q "^200 \|^201 " || fail "a manager on an unlisted model was refused: $R"

# 4b. A file that names only other models keeps Haiku off: the defaults fill in the rest.
human_api POST /api/config/settings '{"text":"{\"humanMail\":{\"when\":\"necessary\",\"models\":{\"claude-sonnet-5-5\":false}}}"}' >/dev/null || fail "saving the partial map failed"
R=$(call POST /api/mail "{\"from\":\"$HK\",\"to\":[\"human\"],\"subject\":\"Done\",\"body\":\"Finished.\"}")
echo "$R" | grep -q "may not mail your user" || fail "a partial models map let Haiku mail the human: $R"

# 5. Flipping the model on lets the child mail the human and move the ITSA.
human_api POST /api/config/settings "$(api GET /api/config/settings | python3 -c '
import json, sys
s = json.loads(json.load(sys.stdin)["text"])
s["humanMail"]["models"]["claude-haiku-5-5"] = True
print(json.dumps({"text": json.dumps(s, indent=2) + "\n"}))')" >/dev/null || fail "saving the setting failed"
R=$(call POST /api/mail "{\"from\":\"$HK\",\"to\":[\"human\"],\"subject\":\"Done\",\"body\":\"Finished.\"}")
echo "$R" | grep -q "^200 \|^201 " || fail "with the setting on, the child's mail to the human was refused: $R"
api POST "/api/itsas/$KEY/post" "{\"by\":\"$HK\",\"body\":\"Need a decision.\"}" >/dev/null
R=$(call PATCH "/api/itsas/$KEY" "{\"status\":\"needs_input\",\"by\":\"$HK\"}")
echo "$R" | grep -q "^200 " || fail "with the setting on, the move to needs_input was refused: $R"

echo "PASS: mail-models"
