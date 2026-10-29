#!/bin/sh
# Only the human writes stam's configuration (S-230), free (no agents, no models): one throwaway
# daemon. The settings, registry and instructions files, the prompt templates, and the agent types
# are written only by the human, the request carrying the test key that stands in for
# `tailscale serve` (trustedHuman). Checks:
#   - an agent's POST (token only) to each guarded route gets 403 and the file or template is unchanged
#   - the web UI's x-stam-human header alone is not the human, so it gets 403 too
#   - the human's POST to each route succeeds and the change is read back
# The chief of staff may ask (S-362): its POST or PATCH of the settings is a 202 and a permission request
# showing a diff (the registry the same way, S-496), the file is unchanged until the human approves it (then it is applied), and a file
# that changed since the ask makes the approval refuse to overwrite. Other agents still get 403.
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/guard.json" <<'EOF3'
{ "turns": [ { "match": "hello", "steps": [ { "reply": "DONE" } ] } ] }
EOF3
fake_claude "$TEST_TMP/guard.json"
# The daemon writes two keys of this file on its own timers: resourceWarn.lastWarned (the sampler, on a loaded
# machine) and retro.lastDigest (the digest's first tick, a minute after a fresh start, since it has none).
# A write in the middle of the checks below reads as a change by the approval (S-3747), so both are off here.
daemon_home main
printf '{ "resourceWarn": { "enabled": false }, "retro": { "digest": { "enabled": false } } }\n' >"$TEST_TMP/main/settings.json"
use main
daemon_up main
fail() { echo "FAIL: $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
TOKEN=$(cat "$STAM_HOME/token")
# code HEADER METHOD PATH BODY: the HTTP status of one request; HEADER is "name:value" or empty.
code() {
  curl -s -o /dev/null -w '%{http_code}' -X "$2" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' ${1:+-H "$1"} ${4:+-d "$4"} "$STAM_URL$3"
}
# The human's request: the test key stands in for tailscale serve.
HUMAN="x-stam-test-human:$STAM_TEST_HUMAN_KEY"
config() { curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/config/$1" | jget "d['text']"; }
template() { curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/templates" | jget "[t['text'] for t in d if t['name']=='$1'][0]"; }

BEFORE_SETTINGS=$(config settings)
BEFORE_REGISTRY=$(config registry)
BEFORE_INSTRUCTIONS=$(config instructions)
BEFORE_TPL=$(template system-prompt)

# 1. An agent can't write any of them, and the web UI's header alone doesn't make it the human.
for H in "" "x-stam-human:1"; do
  [ "$(code "$H" POST /api/config/settings '{"text":"{}"}')" = 403 ] || fail "settings written without the human [$H]"
  [ "$(code "$H" PATCH /api/config/settings '{"patch":{"chiefOfStaff":"x"}}')" = 403 ] || fail "settings patched without the human [$H]"
  [ "$(code "$H" POST /api/config/registry '{"text":"{}"}')" = 403 ] || fail "registry written without the human [$H]"
  [ "$(code "$H" POST /api/config/instructions '{"text":"AGENT RULES"}')" = 403 ] || fail "instructions written without the human [$H]"
  [ "$(code "$H" POST /api/templates/system-prompt '{"text":"AGENT TEMPLATE"}')" = 403 ] || fail "a template written without the human [$H]"
  [ "$(code "$H" POST /api/types/guardx '{"harness":"claude","model":"claude-haiku-5-5"}')" = 403 ] || fail "a type saved without the human [$H]"
  [ "$(code "$H" DELETE /api/types/reviewer '')" = 403 ] || fail "a type removed without the human [$H]"
done
[ "$(config settings)" = "$BEFORE_SETTINGS" ] || fail "settings changed after an agent's refused write"
[ "$(config registry)" = "$BEFORE_REGISTRY" ] || fail "registry changed after an agent's refused write"
[ "$(config instructions)" = "$BEFORE_INSTRUCTIONS" ] || fail "instructions changed after an agent's refused write"
[ "$(template system-prompt)" = "$BEFORE_TPL" ] || fail "the template changed after an agent's refused write"
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/types" | grep -q guardx && fail "a refused type was saved"

# 2. The human's writes go through and are read back.
[ "$(code "$HUMAN" POST /api/config/settings "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$BEFORE_SETTINGS")")" = 200 ] || fail "the human couldn't save settings"
[ "$(code "$HUMAN" POST /api/config/instructions '{"text":"HUMAN RULES"}')" = 200 ] || fail "the human couldn't save instructions"
[ "$(config instructions)" = "HUMAN RULES" ] || fail "the human's instructions didn't read back"
[ "$(code "$HUMAN" POST /api/templates/system-prompt '{"text":"HUMAN TEMPLATE"}')" = 200 ] || fail "the human couldn't save a template"
[ "$(template system-prompt)" = "HUMAN TEMPLATE" ] || fail "the human's template didn't read back"
[ "$(code "$HUMAN" POST /api/types/guardx '{"description":"Guard test.","harness":"claude","model":"claude-haiku-5-5"}')" = 200 ] || fail "the human couldn't save a type"
[ "$(code "$HUMAN" DELETE /api/types/guardx '')" = 200 ] || fail "the human couldn't remove the type"

# 3. The chief of staff asks; the human decides (S-362).
COS="guard-cos-$(date +%s)"
PLAIN="guard-plain-$(date +%s)"
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
"$STAM" spawn "$COS" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
"$STAM" spawn "$PLAIN" --model claude-haiku-5-5 --cwd "$DIR" "Say hello."
for n in "$COS" "$PLAIN"; do "$STAM" wait "$n" --until idle --timeout 60; done
id_of() { curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents" | python3 -c 'import json, sys; print(next(a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]))' "$1"; }
token_of() { tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$(id_of "$1")" STAM_TOKEN 2>/dev/null | cut -d= -f2-; }
COS_ID=$(id_of "$COS")
COS_TOKEN=$(token_of "$COS")
PLAIN_TOKEN=$(token_of "$PLAIN")
[ -n "$COS_TOKEN" ] && [ -n "$PLAIN_TOKEN" ] || fail "an agent has no STAM_TOKEN"
# as TOKEN METHOD PATH BODY: the status and body of a request with an agent's token.
as() { curl -s -w '\n%{http_code}' -X "$2" -H "authorization: Bearer $1" -H 'content-type: application/json' ${4:+-d "$4"} "$STAM_URL$3"; }
[ "$(code "$HUMAN" PATCH /api/config/settings "{\"patch\":{\"chiefOfStaff\":\"$COS_ID\"}}")" = 200 ] || fail "the human couldn't name the chief of staff"
PATCH_A='{"patch":{"guardProbe":"asked"}}'
# A plain agent is refused; the chief of staff gets a 202 and the file stays as it was.
[ "$(as "$PLAIN_TOKEN" PATCH /api/config/settings "$PATCH_A" | tail -1)" = 403 ] || fail "a plain agent's settings patch wasn't refused"
as "$PLAIN_TOKEN" PATCH /api/config/settings "$PATCH_A" | grep -q settings_ask || fail "the 403 doesn't say how to ask (settings_ask)"
[ "$(as "$PLAIN_TOKEN" POST /api/config/settings '{"text":"{}"}' | tail -1)" = 403 ] || fail "a plain agent's settings write wasn't refused"
BASE=$(config settings)
R=$(as "$COS_TOKEN" PATCH /api/config/settings "$PATCH_A")
[ "$(echo "$R" | tail -1)" = 202 ] || fail "the chief of staff's patch wasn't a 202: $R"
REQ=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(config settings)" = "$BASE" ] || fail "settings changed before the human approved"
# The request carries a diff, and no payload leaks through the list.
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/permissions?status=pending" | python3 -c '
import json, sys
r = next(x for x in json.load(sys.stdin) if x["id"] == sys.argv[1])
assert r["action"] == "Change stam settings" and r["agent_id"] == sys.argv[2], r
assert "+  \"guardProbe\": \"asked\"" in r["details"], r["details"]
assert "payload" not in r, r' "$REQ" "$COS_ID" || fail "the settings request is missing its diff"
# Only the human approves: the chief of staff approving its own ask is refused.
[ "$(as "$COS_TOKEN" POST "/api/permissions/$REQ/answer" "{\"approve\":true,\"by\":\"$COS_ID\"}" | tail -1)" != 200 ] || fail "an agent approved a settings change"
[ "$(config settings)" = "$BASE" ] || fail "settings changed by an agent's approval"
ANSWER="$(code 'x-stam-human:1' POST "/api/permissions/$REQ/answer" '{"approve":true,"note":"ok"}')"
[ "$ANSWER" = 200 ] || fail "the human's approval failed: $ANSWER"
config settings | grep -q '"guardProbe": "asked"' || fail "the approved patch wasn't applied"
# A POST whole-file ask, then the file changes before the human answers: the approval refuses to overwrite.
POST_TEXT=$(config settings | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardProbe"] = "stale"; print(json.dumps({"text": json.dumps(s, indent=2) + "\n"}))')
R=$(as "$COS_TOKEN" POST /api/config/settings "$POST_TEXT")
[ "$(echo "$R" | tail -1)" = 202 ] || fail "the chief of staff's write wasn't a 202: $R"
REQ2=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(code "$HUMAN" PATCH /api/config/settings '{"patch":{"guardOther":"human"}}')" = 200 ] || fail "the human's patch failed"
[ "$(code 'x-stam-human:1' POST "/api/permissions/$REQ2/answer" '{"approve":true}')" = 200 ] || fail "answering the stale request failed"
config settings | grep -q '"guardProbe": "asked"' || fail "a stale approval overwrote the file"
config settings | grep -q guardOther || fail "the human's change was lost"
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/permissions" | python3 -c 'import json, sys; r = next(x for x in json.load(sys.stdin) if x["id"] == sys.argv[1]); assert r["status"] == "denied", r' "$REQ2" || fail "a stale approval wasn't recorded as not applied"
# A denial leaves the file alone.
R=$(as "$COS_TOKEN" PATCH /api/config/settings '{"patch":{"guardProbe":"denied"}}')
REQ3=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(code 'x-stam-human:1' POST "/api/permissions/$REQ3/answer" '{"approve":false,"note":"no"}')" = 200 ] || fail "the human's denial failed"
config settings | grep -q '"guardProbe": "denied"' && fail "a denied change was applied"
# No payload (it holds the new settings, secrets included) reaches the thread routes or the human's inbox.
INBOX=$(curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/agents/human/threads?limit=100")
printf %s "$INBOX" | grep -q '"payload"' && fail "the inbox carries a permission payload"
THREAD=$(printf %s "$INBOX" | python3 -c '
import json, sys
def walk(x):
    if isinstance(x, dict):
        if x.get("permission_id") == sys.argv[1]: yield x["thread_id"]
        for v in x.values(): yield from walk(v)
    elif isinstance(x, list):
        for v in x: yield from walk(v)
print(next(walk(json.load(sys.stdin)), ""))' "$REQ")
[ -n "$THREAD" ] || fail "no thread found for the settings request"
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/threads/$THREAD" | grep -q '"payload"' && fail "a thread carries a permission payload"
# Secrets: the redacted text an agent reads, posted back with one change, keeps the real secrets; a new
# secret value shows in the diff as changed, never as a value; a marker with no value behind it is a 400.
python3 - "$STAM_HOME/settings.json" <<'EOF5'
import json, sys
s = json.load(open(sys.argv[1]))
s["peers"] = [{"name": "guard-first", "url": "http://127.0.0.1:8", "token": "FIRSTSECRET-guard"}, {"name": "guard-peer", "url": "http://127.0.0.1:9", "token": "PEERSECRET-guard"}]
s["mcpServers"] = {"m": {"url": "http://127.0.0.1:7/mcp", "headers": {"K": "HDRSECRET-guard"}}}
json.dump(s, open(sys.argv[1], "w"), indent=2)
EOF5
RED=$(as "$COS_TOKEN" GET /api/config/settings | head -1 | jget "d['text']")
echo "$RED" | grep -q PEERSECRET-guard && fail "the chief of staff read a secret"
RED_POST=$(printf %s "$RED" | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardProbe"] = "kept"; print(json.dumps({"text": json.dumps(s)}))')
R=$(as "$COS_TOKEN" POST /api/config/settings "$RED_POST")
[ "$(echo "$R" | tail -1)" = 202 ] || fail "posting the redacted settings wasn't a 202: $R"
REQ4=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(code 'x-stam-human:1' POST "/api/permissions/$REQ4/answer" '{"approve":true}')" = 200 ] || fail "approving the redacted post failed"
config settings | grep -q PEERSECRET-guard || fail "posting the redacted text wiped a secret"
config settings | grep -q '"guardProbe": "kept"' || fail "the redacted post's change wasn't applied"
R=$(as "$COS_TOKEN" PATCH /api/config/settings '{"patch":{"peers":[{"name":"guard-peer","url":"http://127.0.0.1:9","token":"NEWSECRET-guard"}]}}')
REQ5=$(echo "$R" | head -1 | jget "d['requested']")
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/permissions?status=pending" | python3 -c '
import json, sys
r = next(x for x in json.load(sys.stdin) if x["id"] == sys.argv[1])
assert "[redacted: changed]" in r["details"] and "NEWSECRET" not in r["details"] and "PEERSECRET" not in r["details"], r["details"]' "$REQ5" || fail "a changed secret isn't marked in the diff"
code 'x-stam-human:1' POST "/api/permissions/$REQ5/answer" '{"approve":false}' >/dev/null
# Dropping the first peer must not hand the second the first's token (restore matches by name, not position).
DROP=$(printf %s "$RED" | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["peers"] = s["peers"][1:]; print(json.dumps({"text": json.dumps(s)}))')
R=$(as "$COS_TOKEN" POST /api/config/settings "$DROP")
REQ6=$(echo "$R" | head -1 | jget "d['requested']")
code 'x-stam-human:1' POST "/api/permissions/$REQ6/answer" '{"approve":true}' >/dev/null
config settings | python3 -c 'import json, sys; p = json.loads(sys.stdin.read())["peers"]; assert len(p) == 1 and p[0]["token"] == "PEERSECRET-guard", p' || fail "removing the first peer gave the second another's token"
# A secret doesn't follow a changed url, a duplicated name, or a changed MCP server command.
post400() { [ "$(as "$COS_TOKEN" POST /api/config/settings "$(printf %s "$RED" | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); '"$1"'; print(json.dumps({"text": json.dumps(s)}))')" | tail -1)" = 400 ] || fail "$2"; }
post400 's["peers"][-1]["url"] = "http://evil.example:9"' "a peer's token moved to a new url"
post400 's["peers"].append(dict(s["peers"][-1]))' "a duplicated peer name copied its token"
post400 's["mcpServers"]["m"]["url"] = "http://evil.example/mcp"' "an MCP server's headers moved to a new url"
# A new array entry with a marker and no matching name is refused.
GHOST=$(printf %s "$RED" | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["peers"].append({"name": "x", "url": "http://127.0.0.1:9", "token": "[redacted]"}); print(json.dumps({"text": json.dumps(s)}))')
[ "$(as "$COS_TOKEN" POST /api/config/settings "$GHOST" | tail -1)" = 400 ] || fail "a redacted marker with no value wasn't a 400"
[ "$(as "$PLAIN_TOKEN" PATCH /api/config/settings '{"patch":5}' | tail -1)" = 403 ] || fail "a plain agent's bad body wasn't a 403"
python3 -c 'import json; print(json.dumps({"text": "{\"x\":\"" + "a" * 300000 + "\"}"}))' >"$TEST_TMP/big.json"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $COS_TOKEN" -H 'content-type: application/json' -d @"$TEST_TMP/big.json" "$STAM_URL/api/config/settings")" = 400 ] || fail "an oversized settings text wasn't a 400"
# An invalid change is a 400, not a request.
[ "$(as "$COS_TOKEN" POST /api/config/settings '{"text":"not json"}' | tail -1)" = 400 ] || fail "invalid JSON wasn't a 400"
# The other guarded routes stay human-only, even for the chief of staff.
# The registry is an ask too (S-496): 202 and a diff, the file unchanged until the human approves, a stale
# base refused, a denial leaves it alone; a plain agent and invalid JSON are refused.
[ "$(as "$PLAIN_TOKEN" POST /api/config/registry '{"text":"{}"}' | tail -1)" = 403 ] || fail "a plain agent's registry write wasn't refused"
[ "$(as "$COS_TOKEN" POST /api/config/registry '{"text":"not json"}' | tail -1)" = 400 ] || fail "invalid registry JSON wasn't a 400"
REG_BASE=$(config registry)
REG_NEW=$(printf %s "$REG_BASE" | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardReg"] = "asked"; print(json.dumps({"text": json.dumps(s, indent=2) + "\n"}))')
R=$(as "$COS_TOKEN" POST /api/config/registry "$REG_NEW")
[ "$(echo "$R" | tail -1)" = 202 ] || fail "the chief of staff's registry write wasn't a 202: $R"
RREQ=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(config registry)" = "$REG_BASE" ] || fail "the registry changed before the human approved"
curl -s -H "authorization: Bearer $TOKEN" "$STAM_URL/api/permissions?status=pending" | python3 -c '
import json, sys
r = next(x for x in json.load(sys.stdin) if x["id"] == sys.argv[1])
assert r["action"] == "Change stam registry" and "+  \"guardReg\": \"asked\"" in r["details"], r' "$RREQ" || fail "the registry request is missing its diff"
[ "$(as "$COS_TOKEN" POST "/api/permissions/$RREQ/answer" "{\"approve\":true,\"by\":\"$COS_ID\"}" | tail -1)" != 200 ] || fail "an agent approved a registry change"
[ "$(config registry)" = "$REG_BASE" ] || fail "the registry changed by an agent's approval"
[ "$(code 'x-stam-human:1' POST "/api/permissions/$RREQ/answer" '{"approve":true}')" = 200 ] || fail "approving the registry change failed"
config registry | grep -q '"guardReg": "asked"' || fail "the approved registry change wasn't applied"
# Stale: the file changes (the human's write) between the ask and the answer.
R=$(as "$COS_TOKEN" POST /api/config/registry "$(config registry | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardReg"] = "stale"; print(json.dumps({"text": json.dumps(s)}))')")
RREQ2=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(code "$HUMAN" POST /api/config/registry "$(config registry | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardRegHuman"] = 1; print(json.dumps({"text": json.dumps(s)}))')")" = 200 ] || fail "the human's registry write failed"
[ "$(code 'x-stam-human:1' POST "/api/permissions/$RREQ2/answer" '{"approve":true}')" = 200 ] || fail "answering the stale registry request failed"
config registry | grep -q '"guardReg": "asked"' || fail "a stale approval overwrote the registry"
config registry | grep -q guardRegHuman || fail "the human's registry change was lost"
# A denial leaves it alone.
R=$(as "$COS_TOKEN" POST /api/config/registry "$(config registry | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardReg"] = "denied"; print(json.dumps({"text": json.dumps(s)}))')")
RREQ3=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(code 'x-stam-human:1' POST "/api/permissions/$RREQ3/answer" '{"approve":false}')" = 200 ] || fail "denying the registry change failed"
config registry | grep -q '"guardReg": "denied"' && fail "a denied registry change was applied"
# Put the registry back.
[ "$(code "$HUMAN" POST /api/config/registry "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$BEFORE_REGISTRY")")" = 200 ] || fail "restoring the registry failed"
[ "$(as "$COS_TOKEN" POST /api/config/instructions '{"text":"X"}' | tail -1)" = 403 ] || fail "the chief of staff wrote the instructions"
[ "$(as "$COS_TOKEN" POST /api/templates/system-prompt '{"text":"X"}' | tail -1)" = 403 ] || fail "the chief of staff wrote a template"
# 4. The assistant asks the same way (S-362): 202 and a request, the human's approval applies it, a denial
# leaves the file alone, and it can't approve its own ask.
EA="guard-ea-$(date +%s)"
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL/api/agents" \
  -d "{\"name\":\"$EA\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\",\"kind\":\"assistant\",\"prompt\":\"Say hello.\"}" >/dev/null
"$STAM" wait "$EA" --until idle --timeout 60
EA_ID=$(id_of "$EA")
EA_TOKEN=$(token_of "$EA")
[ -n "$EA_TOKEN" ] || fail "the assistant has no STAM_TOKEN"
BASE=$(config settings)
R=$(as "$EA_TOKEN" PATCH /api/config/settings '{"patch":{"guardEa":"patched"}}')
[ "$(echo "$R" | tail -1)" = 202 ] || fail "the assistant's patch wasn't a 202: $R"
EREQ=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(config settings)" = "$BASE" ] || fail "the assistant's patch changed the file before approval"
[ "$(as "$EA_TOKEN" POST "/api/permissions/$EREQ/answer" "{\"approve\":true,\"by\":\"$EA_ID\"}" | tail -1)" != 200 ] || fail "the assistant approved its own ask"
[ "$(config settings)" = "$BASE" ] || fail "the assistant's self-approval changed the file"
[ "$(code 'x-stam-human:1' POST "/api/permissions/$EREQ/answer" '{"approve":true}')" = 200 ] || fail "the human's approval of the assistant's patch failed"
config settings | grep -q '"guardEa": "patched"' || fail "the assistant's approved patch wasn't applied"
POST_EA=$(config settings | python3 -c 'import json, sys; s = json.loads(sys.stdin.read()); s["guardEa"] = "posted"; print(json.dumps({"text": json.dumps(s, indent=2) + "\n"}))')
R=$(as "$EA_TOKEN" POST /api/config/settings "$POST_EA")
[ "$(echo "$R" | tail -1)" = 202 ] || fail "the assistant's write wasn't a 202: $R"
EREQ2=$(echo "$R" | head -1 | jget "d['requested']")
[ "$(config settings | grep -c '"guardEa": "posted"')" = 0 ] || fail "the assistant's write changed the file before approval"
[ "$(code 'x-stam-human:1' POST "/api/permissions/$EREQ2/answer" '{"approve":false,"note":"no thanks"}')" = 200 ] || fail "the human's denial of the assistant's write failed"
config settings | grep -q '"guardEa": "posted"' && fail "a denied assistant write was applied"
"$STAM" events "$EA" 2>/dev/null | grep -q 'permission:answered' || fail "the assistant has no answered event"
python3 - "$STAM_HOME/settings.json" <<'EOF4'
import json, sys
s = json.load(open(sys.argv[1]))
for k in ("guardProbe", "guardOther", "chiefOfStaff", "peers", "mcpServers", "guardEa"): s.pop(k, None)
json.dump(s, open(sys.argv[1], "w"), indent=2)
EOF4

# Put back what the human changed, so the daemon's files match the start.
[ "$(code "$HUMAN" POST /api/config/instructions "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$BEFORE_INSTRUCTIONS")")" = 200 ] || fail "restoring instructions failed"
[ "$(code "$HUMAN" POST /api/templates/system-prompt '{"reset":true}')" = 200 ] || fail "resetting the template failed"
echo "PASS: config guard"
