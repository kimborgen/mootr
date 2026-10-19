#!/bin/sh
# What an agent's token may read of cost data (S-593). Two trees: A1 > A2 and B1 > B2, each with usage
# rows, an ITSA and a permission ask. A2's token sees A's tree only, with B's usage collapsed into one
# "other" line; /api/usage?tree=B1 and /api/agents/B1/usage are 403; the ITSA lists leave out B's; the
# permission list holds A2's own. A1 (A2's ancestor) is allowed; the shared token and a boss (the chief
# of staff) read everything. Free: registered agents, usage rows written into the test DB.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
daemon_up main
URL=$(on main sh -c 'echo "$STAM_URL"')
TOKEN=$(cat "$TEST_TMP/main/token")
fail() { echo "FAIL: $1"; exit 1; }
J='content-type: application/json'
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
reg() { curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H 'x-stam-human: 1' -d "{\"name\":\"$1\",\"role\":\"test\",\"harness\":\"claude\",\"token\":true}" "$URL/api/register"; }
A1J=$(reg a1); A2J=$(reg a2); B1J=$(reg b1); B2J=$(reg b2)
for n in A1 A2 B1 B2; do eval "${n}=\$(printf '%s' \"\$${n}J\" | jget \"d['id']\"); ${n}T=\$(printf '%s' \"\$${n}J\" | jget \"d['token']\")"; done
[ -n "$A1" ] && [ -n "$A2T" ] && [ -n "$B2T" ] || fail "agents didn't register with tokens"
# The trees and their usage, straight into the test DB.
python3 - "$TEST_TMP/main/stam.db" "$A1" "$A2" "$B1" "$B2" <<'PY'
import sqlite3, sys, datetime
db = sqlite3.connect(sys.argv[1]); a1, a2, b1, b2 = sys.argv[2:6]
db.execute("UPDATE agents SET parent_id=? WHERE id=?", (a1, a2)); db.execute("UPDATE agents SET parent_id=? WHERE id=?", (b1, b2))
day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()  # the daemon buckets by UTC day, not the local one
for a, c in ((a1, 0.01), (a2, 0.02), (b1, 0.04), (b2, 0.08)):
    db.execute("INSERT INTO usage (agent_id, day, harness, model, cost_usd, tokens_in) VALUES (?, ?, 'claude', 'm', ?, 10)", (a, day, c))
db.commit()
PY
get() { _t=$1; shift; curl -s -o "$TEST_TMP/body" -w '%{http_code}' -H "authorization: Bearer $_t" "$@"; }
ids() { python3 -c "import json,sys; d=json.load(open('$TEST_TMP/body')); print(' '.join(sorted(r['agent_id'] for r in d['by_agent'])))"; }

echo "-- the shared token reads everything"
[ "$(get "$TOKEN" "$URL/api/usage")" = 200 ] || fail "usage as the shared token"
[ "$(ids)" = "$(printf '%s\n' "$A1" "$A2" "$B1" "$B2" | sort | tr '\n' ' ' | sed 's/ $//')" ] || fail "the shared token's by_agent isn't whole: $(ids)"
[ "$(get "$TOKEN" "$URL/api/usage?tree=$B1")" = 200 ] || fail "usage?tree= as the shared token"

echo "-- a2 sees its tree and an 'other' line"
[ "$(get "$A2T" "$URL/api/usage")" = 200 ] || fail "usage as a2"
python3 - "$TEST_TMP/body" "$A1" "$A2" "$B1" "$B2" <<'PY' || fail "a2's by_agent or trees wrong"
import json, sys
d = json.load(open(sys.argv[1])); a1, a2, b1, b2 = sys.argv[2:6]
ids = sorted(r['agent_id'] for r in d['by_agent'])
assert ids == sorted([a1, a2, 'other']), ids
other = next(r for r in d['by_agent'] if r['agent_id'] == 'other')
assert abs(other["cost_usd"] - 0.12) < 1e-6, other
assert sorted(t['id'] for t in d['trees']) == sorted([a1, 'other']), [t['id'] for t in d['trees']]
assert 'accounts' in d and 'today' in d and 'by_day' in d
PY
[ "$(get "$A2T" "$URL/api/usage?tree=$A1")" = 200 ] || fail "a2 reading its ancestor's tree was refused: $(cat "$TEST_TMP/body")"
[ "$(get "$A2T" "$URL/api/usage?tree=$A2")" = 200 ] || fail "a2 reading its own tree was refused"
[ "$(get "$A2T" "$URL/api/usage?tree=$B1")" = 403 ] || fail "a2 read b1's tree"
[ "$(get "$A2T" "$URL/api/agents/$B1/usage")" = 403 ] || fail "a2 read b1's usage"
[ "$(get "$A2T" "$URL/api/agents/$A1/usage")" = 200 ] || fail "a2 couldn't read its ancestor's usage"
[ "$(get "$A2T" "$URL/api/agents/$A2/usage")" = 200 ] || fail "a2 couldn't read its own usage"

echo "-- series and scope (S-657): the same scoping on the new endpoints"
[ "$(get "$TOKEN" "$URL/api/usage/series?days=14&group=agent")" = 200 ] || fail "series as the shared token"
python3 - "$TEST_TMP/body" "$A1" "$A2" "$B1" "$B2" <<'PY' || fail "the shared token's series isn't whole"
import json, sys
d = json.load(open(sys.argv[1])); a1, a2, b1, b2 = sys.argv[2:6]
assert {g['id'] for g in d['groups']} == {a1, a2, b1, b2}, d['groups']
assert abs(d['total']['cost_usd'] - 0.15) < 1e-9, d['total']
PY
[ "$(get "$A2T" "$URL/api/usage/series?days=14&group=tree")" = 200 ] || fail "tree series as a2"
python3 - "$TEST_TMP/body" "$A1" "$B1" <<'PY' || fail "a2's tree series isn't scoped"
import json, sys
d = json.load(open(sys.argv[1])); a1, b1 = sys.argv[2:4]
ids = {g['id'] for g in d['groups']}
assert a1 in ids and 'other' in ids and b1 not in ids, ids
PY
[ "$(get "$A2T" "$URL/api/usage/scope?days=14&tree=$A1")" = 200 ] || fail "a2 scope of its ancestor's tree"
python3 - "$TEST_TMP/body" "$A1" "$A2" "$B1" "$B2" <<'PY' || fail "a2's tree scope isn't scoped or wrong"
import json, sys
d = json.load(open(sys.argv[1])); a1, a2, b1, b2 = sys.argv[2:6]
assert {a['id'] for a in d['by_agent']} == {a1, a2}, d['by_agent']
assert abs(d['totals']['cost_usd'] - 0.03) < 1e-9, d['totals']
PY
[ "$(get "$A2T" "$URL/api/usage/scope?days=14&tree=$B1")" = 403 ] || fail "a2 scoped b1's tree"
[ "$(get "$A2T" "$URL/api/usage/scope?days=14&agent=$A2")" = 200 ] || fail "a2 scoped its own agent"
[ "$(get "$A2T" "$URL/api/usage/scope?days=14&agent=$B2")" = 403 ] || fail "a2 scoped b2's agent"
[ "$(get "$A2T" "$URL/api/usage/scope?days=14&model=nope")" = 200 ] || fail "an empty scope isn't 200"
python3 - "$TEST_TMP/body" <<'PY' || fail "an empty scope isn't empty arrays"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['by_agent'] == [] and d['by_model'] == [] and d['totals']['cost_usd'] == 0, d
PY
[ "$(get "$TOKEN" "$URL/api/usage/scope?days=14&harness=claude&model=m")" = 200 ] || fail "scope by harness+model isn't 200"
python3 - "$TEST_TMP/body" <<'PY' || fail "scope by harness+model is wrong"
import json, sys
d = json.load(open(sys.argv[1]))
assert d['scope'].get('harness') == 'claude' and d['scope']['id'] == 'claude · m', d['scope']
assert abs(d['totals']['cost_usd'] - 0.15) < 1e-9, d['totals']
PY
[ "$(get "$TOKEN" "$URL/api/usage/series?group=nope")" = 400 ] || fail "a bad series group isn't 400"
[ "$(get "$TOKEN" "$URL/api/usage/scope")" = 400 ] || fail "a scope with no selector isn't 400"
[ "$(get "$TOKEN" "$URL/api/usage/scope?days=100000&model=m")" = 400 ] || fail "a scope with days=100000 isn't 400"
[ "$(get "$TOKEN" "$URL/api/usage/series?days=100000")" = 400 ] || fail "a series with days=100000 isn't 400"

echo "-- ITSAs: only those a2 belongs to"
mk() { curl -s -X POST -H "authorization: Bearer $1" -H "$J" -d "{\"title\":\"$2\",\"by\":\"$3\",\"owner\":\"$3\"}" "$URL/api/itsas" | jget "d.get('key') or d"; }
IA=$(mk "$A2T" "a's issue" "$A2"); IB=$(mk "$B1T" "b's issue" "$B1")
case "$IA$IB" in S-*S-*) ;; *) fail "ITSAs weren't made: $IA $IB";; esac
# Spend sampled after each ITSA was made, so an ITSA shows in the cost lists.
sleep 1
python3 - "$TEST_TMP/main/stam.db" "$A2" "$B1" <<'PY'
import sqlite3, sys, datetime
db = sqlite3.connect(sys.argv[1])
b = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
for a in sys.argv[2:4]:
    db.execute("INSERT INTO usage_samples (agent_id, account, harness, model, bucket, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES (?, '', 'claude', 'm', ?, 0.5, 10, 10, 0, 0)", (a, b))
db.commit()
PY
sleep 3
keys() { python3 -c "import json; d=json.load(open('$TEST_TMP/body')); print(' '.join(sorted(r['key'] for r in d['$1'])))"; }
[ "$(get "$A2T" "$URL/api/usage/issues")" = 200 ] || fail "issues as a2"
case "$(keys issues)" in *"$IA"*) ;; *) fail "a2 doesn't see its own ITSA in usage/issues";; esac
case "$(keys issues)" in *"$IB"*) fail "a2 sees b1's ITSA in usage/issues";; esac
[ "$(get "$A2T" "$URL/api/activity?by=itsa")" = 200 ] || fail "activity by itsa as a2"
case "$(keys rows)" in *"$IB"*) fail "a2 sees b1's ITSA in activity";; esac
# The activity summary (S-1009): the same scoping by tree, agent and ITSA.
[ "$(get "$A2T" "$URL/api/activity?by=summary&days=7")" = 200 ] || fail "activity summary as a2: $(cat "$TEST_TMP/body")"
python3 -c "import json; d=json.load(open('$TEST_TMP/body')); c=d['clock']; assert d['by'] == 'summary' and c['total_s'] == sum(c[k + '_s'] for k in ('working', 'friction', 'others', 'you', 'idle')), d" || fail "the summary's clock doesn't add up"
[ "$(get "$A2T" "$URL/api/activity?by=summary&scope=tree:$A1")" = 200 ] || fail "a2's summary of its ancestor's tree was refused"
[ "$(get "$A2T" "$URL/api/activity?by=summary&scope=tree:$B1")" = 403 ] || fail "a2 read b1's tree summary"
[ "$(get "$A2T" "$URL/api/activity?by=summary&scope=agent:$B2")" = 403 ] || fail "a2 read b2's summary"
[ "$(get "$A2T" "$URL/api/activity?by=summary&scope=itsa:$IA")" = 200 ] || fail "a2's summary of its own ITSA was refused"
[ "$(get "$A2T" "$URL/api/activity?by=summary&scope=itsa:$IB")" = 403 ] || fail "a2 read b1's ITSA summary"
[ "$(get "$TOKEN" "$URL/api/activity?by=summary&scope=tree:$B1")" = 200 ] || fail "the shared token's tree summary was refused"
[ "$(get "$TOKEN" "$URL/api/activity?by=summary&scope=team:$B1")" = 400 ] || fail "a bad summary scope isn't 400"
[ "$(get "$TOKEN" "$URL/api/activity?by=summary&scope=agent:nobody")" = 404 ] || fail "an unknown agent's summary isn't 404"
[ "$(get "$TOKEN" "$URL/api/usage/issues")" = 200 ] || fail "issues as the shared token"
case "$(keys issues)" in *"$IA"*"$IB"*|*"$IB"*"$IA"*) ;; *) fail "the shared token doesn't see both ITSAs: $(keys issues)";; esac

echo "-- permissions: a2's own and its tree's"
for t in "$A2T" "$B2T"; do curl -s -o /dev/null -X POST -H "authorization: Bearer $t" -H "$J" -d '{"action":"x","reason":"r","audience":"human"}' "$URL/api/permissions"; done
[ "$(get "$A2T" "$URL/api/permissions?status=pending")" = 200 ] || fail "permissions as a2"
python3 - "$TEST_TMP/body" "$A2" <<'PY' || fail "a2's permission list isn't just its own"
import json, sys
d = json.load(open(sys.argv[1])); assert d and all(r['agent_id'] == sys.argv[2] for r in d), d
PY
[ "$(get "$A1T" "$URL/api/permissions?status=pending")" = 200 ] || fail "permissions as a1"
python3 - "$TEST_TMP/body" "$A2" "$B2" <<'PY' || fail "a1 (a2's parent) doesn't see its tree's ask, or sees b2's"
import json, sys
ids = {r['agent_id'] for r in json.load(open(sys.argv[1]))}; assert sys.argv[2] in ids and sys.argv[3] not in ids, ids
PY
[ "$(get "$TOKEN" "$URL/api/permissions?status=pending")" = 200 ] || fail "permissions as the shared token"
python3 - "$TEST_TMP/body" "$A2" "$B2" <<'PY' || fail "the shared token doesn't see both asks"
import json, sys
ids = {r['agent_id'] for r in json.load(open(sys.argv[1]))}; assert sys.argv[2] in ids and sys.argv[3] in ids, ids
PY

echo "-- a boss (the chief of staff) reads everything"
COSJ=$(reg boss); BOSS=$(printf '%s' "$COSJ" | jget "d['id']"); BOSST=$(printf '%s' "$COSJ" | jget "d['token']")
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H 'x-stam-human: 1' -d '{}' "$URL/api/agents/$BOSS/chief-of-staff")" = 200 ] || fail "couldn't make a chief of staff"
[ "$(get "$BOSST" "$URL/api/usage?tree=$B1")" = 200 ] || fail "the chief of staff was refused b1's tree"
[ "$(get "$BOSST" "$URL/api/usage")" = 200 ] && [ "$(ids)" != "" ] && case "$(ids)" in *"$B2"*) ;; *) fail "the chief of staff's by_agent hides b2";; esac
echo PASS
