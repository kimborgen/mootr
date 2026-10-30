#!/bin/sh
# Requirements over HTTP, free: off by default every route answers 404 and the request is
# answered before any proxying (the ITSA home is pointed at a machine that isn't a peer, which a
# proxied request would answer 503); enabled, create/get/list/patch and links work; and an
# agent's identity reaches the approval rule through the API (its PATCH to in_force is refused
# under the default human approval). Throwaway daemon (test/lib.sh), no agents, no model turns.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
fail() { echo "FAIL: $1"; exit 1; }
# The shared token is the human's with x-stam-human, or, with `by`, the agent it names (the CLI's
# own rule; settings.auth.sharedTokenClaims is on by default).
human() { curl -s -o "$TEST_TMP/out" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' -d "$3" "$STAM_URL$2"; }
call() { curl -s -o "$TEST_TMP/out" -w '%{http_code}' -X "$1" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$3" "$STAM_URL$2"; }
getc() { curl -s -o "$TEST_TMP/out" -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$STAM_URL$1"; }
jget() { python3 -c "import json; d=json.load(open('$TEST_TMP/out')); print($1)"; }

# While off: an ITSA home that isn't a peer would 503 an enabled request, so 404 here proves the
# disabled check runs before any proxying. Every route is 404 with the exact message.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s.setdefault('itsa', {})['home'] = 'nowhere'; json.dump(s, open(p, 'w'), indent=2)
PY
[ "$(getc /api/requirements)" = 404 ] || fail "an off GET wasn't 404 (did it proxy?)"
grep -q 'requirements are off (settings.requirements.enabled)' "$TEST_TMP/out" || fail "the off 404 message is wrong: $(cat "$TEST_TMP/out")"
[ "$(call POST /api/requirements '{"title":"x"}')" = 404 ] || fail "an off POST wasn't 404"
[ "$(getc /api/requirements/R-1)" = 404 ] || fail "an off GET :key wasn't 404"

# Enable on this machine, requirements on, approval human.
python3 - "$STAM_HOME/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s['itsa']['home'] = None
s['requirements'] = {'enabled': True, 'approval': 'human', 'keyPrefix': 'R', 'dailyCapUsd': 1, 'defaultThreshold': 0.8, 'defaultMode': 'observe'}
json.dump(s, open(p, 'w'), indent=2)
PY

[ "$(human POST /api/requirements '{"title":"Root","text":"shall work"}')" = 200 ] || fail "create failed: $(cat "$TEST_TMP/out")"
K=$(jget "d['key']")
[ "$K" = R-1 ] || fail "the key is $K, not R-1"
[ "$(jget "(d['status'], d['severity'], d['mode'], d['threshold'], d['version'])")" = "('draft', 'minor', 'observe', 0.8, 1)" ] || fail "defaults wrong: $(cat "$TEST_TMP/out")"
[ "$(human POST /api/requirements "{\"title\":\"Child\",\"parent\":\"$K\"}")" = 200 ] || fail "child create failed"
K2=$(jget "d['key']")
[ "$(getc "/api/requirements/$K")" = 200 ] || fail "get failed"
[ "$(jget "[c['key'] for c in d['children']]")" = "['$K2']" ] || fail "children wrong"
[ "$(getc /api/requirements)" = 200 ] || fail "list failed"
[ "$(jget "len(d)")" = 2 ] || fail "list length wrong"

# An agent's identity reaches the approval rule through the API: under human approval it can't
# move a draft (or a suspended one, or create one) into in_force; the human can.
# Sequential: `human` writes the body to a file and jget reads it, so a pipeline would race.
REG=$(human POST /api/register '{"name":"worker","role":"developer","harness":"external"}')
[ "$REG" = 200 ] || fail "register failed: $REG"
WID=$(jget "d['id']")
[ -n "$WID" ] || fail "register didn't return an id"
[ "$(call PATCH "/api/requirements/$K" "{\"by\":\"$WID\",\"status\":\"in_force\"}")" = 403 ] || fail "an agent's PATCH to in_force wasn't 403: $(cat "$TEST_TMP/out")"
[ "$(call POST /api/requirements "{\"title\":\"Forced\",\"status\":\"in_force\",\"by\":\"$WID\"}")" = 403 ] || fail "an agent's create in_force wasn't 403"
[ "$(human POST /api/requirements '{"title":"Suspended","status":"suspended"}')" = 200 ] || fail "the suspended create failed"
SK=$(jget "d['key']")
[ "$(call PATCH "/api/requirements/$SK" "{\"by\":\"$WID\",\"status\":\"in_force\"}")" = 403 ] || fail "suspended -> in_force by an agent wasn't 403"
[ "$(human PATCH "/api/requirements/$K" '{"status":"in_force","text":"shall work well"}')" = 200 ] || fail "the human's approval failed: $(cat "$TEST_TMP/out")"
[ "$(jget "(d['requirement']['status'], d['requirement']['version'])")" = "('in_force', 2)" ] || fail "the approval result is wrong: $(cat "$TEST_TMP/out")"

# Links: add, read back on get, remove; 400 for a bad kind, 404 for a missing link and an unknown key.
[ "$(human POST "/api/requirements/$K/links" '{"target":"S-1","target_kind":"itsa","role":"implements"}')" = 200 ] || fail "link add failed"
LID=$(jget "d['id']")
[ "$(getc "/api/requirements/$K")" = 200 ] || fail "get after link failed"
[ "$(jget "(len(d['links']), d['links'][0]['target_kind'], d['links'][0]['target'])")" = "(1, 'itsa', 'S-1')" ] || fail "link shape wrong"
[ "$(human POST "/api/requirements/$K/links" '{"target":"x","target_kind":"nope"}')" = 400 ] || fail "a bad link kind wasn't 400"
[ "$(human DELETE "/api/requirements/$K/links/$LID" '')" = 200 ] || fail "link delete failed"
[ "$(human DELETE "/api/requirements/$K/links/999" '')" = 404 ] || fail "a missing link wasn't 404"
[ "$(getc /api/requirements/R-999)" = 404 ] || fail "an unknown requirement wasn't 404"

# The CLI over the same daemon.
"$STAM" req ls | grep -q "$K" || fail "stam req ls missed the requirement"
"$STAM" req show "$K" >/dev/null || fail "stam req show failed"
"$STAM" req new "CLI made" >/dev/null || fail "stam req new failed"

# `stam req seed`: a small fixture as drafts, parents first. From an agent it raises one approval
# ask for the whole batch; the human's Approve puts every draft in force. From the human, no ask.
cat > "$TEST_TMP/seed.json" <<'JSON'
{"requirements": [
  {"ref": "top", "title": "Seed top", "text": "The seed shall load."},
  {"parent": "top", "title": "Seed one", "text": "One shall hold.", "verification": ["decision"], "scope": {"subjects": ["mail-to-human"]}, "mode": "observe"},
  {"parent": "top", "title": "Seed two", "text": "Two shall hold.", "verification": ["decision"], "scope": {"subjects": ["branch"]}, "mode": "observe"}
]}
JSON
with_agent_id "$WID" "$STAM" req seed "$TEST_TMP/seed.json" > "$TEST_TMP/seed.out" || fail "stam req seed failed: $(cat "$TEST_TMP/seed.out")"
grep -q '^3 drafts; approval ask S-' "$TEST_TMP/seed.out" || fail "the seed didn't raise one ask: $(cat "$TEST_TMP/seed.out")"
ASK=$(sed -n 's/^3 drafts; approval ask \(S-[0-9]*\).*/\1/p' "$TEST_TMP/seed.out")
SEEDED=$(awk 'NR<=3 {print $1}' "$TEST_TMP/seed.out")
[ "$(getc "/api/itsas/$ASK")" = 200 ] || fail "the ask $ASK isn't there"
[ "$(jget "(d.get('itsa', d)['kind'], d.get('itsa', d)['status'])")" = "('requirement-approval', 'needs_approval')" ] || fail "the ask is wrong: $(cat "$TEST_TMP/out")"
for k in $SEEDED; do
  [ "$(getc "/api/requirements/$k")" = 200 ] || fail "seeded $k is missing"
  [ "$(jget "d['status']")" = draft ] || fail "seeded $k isn't a draft"
done
getc "/api/itsas/$ASK" >/dev/null; REV=$(jget "d['rev']")
[ "$(human POST "/api/itsas/$ASK/act" "{\"action\":\"approve\",\"text\":\"\",\"if_rev\":\"$REV\"}")" = 200 ] || fail "Approve failed: $(cat "$TEST_TMP/out")"
in_force() { for k in $SEEDED; do getc "/api/requirements/$k" >/dev/null; [ "$(jget "d['status']")" = in_force ] || return 1; done; }
wait_until in_force
"$STAM" req seed "$TEST_TMP/seed.json" > "$TEST_TMP/seed.out" || fail "the human's seed failed"
grep -qx '3 drafts' "$TEST_TMP/seed.out" || fail "the human's seed raised an ask: $(cat "$TEST_TMP/seed.out")"

echo "PASS e2e-requirements"
