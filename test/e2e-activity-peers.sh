#!/bin/sh
# The activity summary across machines (S-1079), free (no models, no agent turns). Three isolated daemons
# on the same realistic-scale fixture (test/activity-fixture.mjs): "union" holds every agent and is the ITSA
# home of its own, "ma" holds the even-numbered agents and the ITSAs (the ITSA home), "mb" the odd ones and no
# ITSAs; ma and mb are peers. Checks:
#   - the summary from ma, and from mb, equals the one from union (clock, tiles, categories, bottlenecks,
#     configs, trees), for everything, a tree, an agent on the other machine, and an ITSA
#   - the answer says which machines it covers
#   - with mb stopped, ma answers with its own agents' data and names mb in machines.missing; with ma (the ITSA
#     home) stopped, mb answers for its own agents and names ma
#   - a peer-only route refuses an agent's token
# Waits on state, never on time. Run on storage (S-207), not on the ITSA home.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
export STAM_ACTIVITY_PEER_MS=100 STAM_ACTIVITY_REMOTE_MS=100 STAM_PEER_PROBE_MS=300 STAM_PEER_CHECK_MS=300
export SEED_NOW=$(date +%s)000
SETTINGS='"cost":{"accounts":{"claude":{"match":{"harness":"claude"}},"codex":{"match":{"harness":"codex"}},"openrouter":{"match":{"harness":"opencode"},"paid":true}}}'
daemon_home union
daemon_home ma
daemon_home mb
python3 - "$TEST_TMP" "$SETTINGS" <<'PY'
import json, re, sys
tmp, settings = sys.argv[1], json.loads("{" + sys.argv[2] + "}")
def env(d):
    return dict(re.findall(r"(\w+)='?([^' \n]+)'?", open(f"{tmp}/{d}/test.env").read()))
def peer(name):
    return {"name": name, "url": env(name)["STAM_URL"], "token": open(f"{tmp}/{name}/token").read().strip()}
for me, others, home in (("union", [], "union"), ("ma", ["mb"], "ma"), ("mb", ["ma"], "ma")):
    s = dict(settings)
    s["peers"] = [peer(o) for o in others]
    s["itsa"] = {"home": home}
    json.dump(s, open(f"{tmp}/{me}/settings.json", "w"), indent=2)
PY
# The realistic-scale fixture (S-1079, test/activity-fixture.mjs: 120 agents, 3 days), written as each daemon's startup
# seed (test-seed.json): the union holds all of it, ma the even agents with the ITSAs, mb the odd agents and no ITSAs.
ROOT="$ROOT" TEST_TMP="$TEST_TMP" node --input-type=module -e '
const { generateScale, splitScale, seedFile } = await import(process.env.ROOT + "/test/activity-fixture.mjs");
const { writeFileSync } = await import("node:fs");
const f = generateScale({ agents: 120, days: 3, now: Date.now() });
for (const [home, part, itsas] of [["union", "all", true], ["ma", "even", true], ["mb", "odd", false]]) {
  const { rows } = splitScale(f, part, { itsas });
  writeFileSync(`${process.env.TEST_TMP}/${home}/test-seed.json`, JSON.stringify(seedFile(rows)));
}'
daemon_up union
daemon_up ma
daemon_up mb
# The daemon's OpenCode adapter mints the server token at start; the test names its own (only the hash is kept).
for d in union ma mb; do python3 -c 'import hashlib; print(hashlib.sha256(b"oc-token").hexdigest())' >"$TEST_TMP/$d/opencode-token"; done
fail() { echo "FAIL: $1"; exit 1; }
# get DAEMON PATH: the shared token, as the CLI and the web do.
get() { on "$1" sh -c 'curl -s -m 120 -H "authorization: Bearer ${1:-$(cat "$STAM_HOME/token")}" "$STAM_URL$0"' "$2" "$3"; }
# The parts of a summary the machines must agree on (not the modes, which read each daemon's own cost snapshot).
# A peer's digests carry seconds to the millisecond and dollars to 1e-7, so a sum can land one second or a few
# millionths of a dollar across a rounding step; counts, names and the shape must match exactly.
cat >"$TEST_TMP/norm.py" <<'PY'
import json, sys
SKIP = ("modes", "cost_modes", "labels", "machines", "until", "note", "since")
def strip(x):
    if isinstance(x, dict):
        return {k: strip(v) for k, v in x.items() if k not in SKIP}
    if isinstance(x, list):
        return [strip(v) for v in x]
    return x
def close(a, b, key, path):
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return f"{path}: keys {sorted(a.keys() ^ b.keys())}"
        for k in a:
            r = close(a[k], b[k], k, f"{path}/{k}")
            if r: return r
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: {len(a)} vs {len(b)} items"
        for i, (x, y) in enumerate(zip(a, b)):
            r = close(x, y, key, f"{path}/{i}")
            if r: return r
        return None
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        parts = path.split("/")
        # Counts are exact; dollars to a few millionths; every other number is seconds.
        tol = 1e-5 if any("usd" in k for k in parts) else (0 if parts[-1] in ("agents", "n", "review_rounds") else 1.0)
        return None if abs(a - b) <= tol else f"{path}: {a} vs {b}"
    return None if a == b else f"{path}: {a!r} vs {b!r}"
a, b = (strip(json.load(open(p))) for p in sys.argv[1:3])
for d in (a, b):
    if "error" in d:
        print("ERROR", d["error"]); sys.exit(1)
r = close(a, b, "", "")
if r:
    print(r); sys.exit(1)
PY
same() { # same SCOPE: ma and mb answer as union does
  _q="/api/activity?by=summary&days=3${1:+&scope=$1}"
  get union "$_q" >"$TEST_TMP/u.json"
  grep -q '"error"' "$TEST_TMP/u.json" && fail "union can't answer ${1:-all}: $(cat "$TEST_TMP/u.json")"
  for m in ma mb; do
    # A peer's first read can still be in flight (or its digests warming), so the answer is polled until it agrees.
    _try=0
    while :; do
      get "$m" "$_q" >"$TEST_TMP/$m.json"
      _why=$(python3 "$TEST_TMP/norm.py" "$TEST_TMP/u.json" "$TEST_TMP/$m.json") && break
      _try=$((_try + 1))
      [ "$_try" -lt 40 ] || fail "$m's summary of ${1:-everything} differs from the union's: $_why"
      sleep 0.5
    done
  done
}
echo "-- everything"
same ""
python3 - "$TEST_TMP/ma.json" "$TEST_TMP/u.json" <<'PY' || fail "the answer doesn't name its machines"
import json, sys
a, u = (json.load(open(p)) for p in sys.argv[1:])
assert a["machines"] == {"included": ["ma", "mb"], "missing": []}, a["machines"]
assert u["machines"] == {"included": ["union"], "missing": []}, u["machines"]
assert a["agents"] == u["agents"] and a["agents"] > 30, (a["agents"], u["agents"])
PY
echo "-- a tree, an agent on the other machine, and an ITSA"
same "tree:a0001"
same "agent:a0003"
same "agent:agent-4"
same "itsa:S-2"
echo "-- a peer-only route refuses the shared token, an agent's token and the OpenCode server"
for tok in "" tok-a0001 oc-token; do
  for by in digests attribution; do
    get mb "/api/activity?by=$by&days=3" "$tok" | grep -q 'for a peer' || fail "by=$by answered a caller that is not a peer (token '${tok:-shared}')"
  done
done
echo "-- an agent's token: its tree crosses machines; its ITSAs are judged on the home's data"
# as AGENT_TOKEN DAEMON SCOPE [AS]: ma, mb or union must answer as the union does for that agent.
as_same() {
  _id=$1 _m=$2 _scope=$3 _tok=${4:-tok-$1} _as=${5:+&as=$5}
  _q="/api/activity?by=summary&days=3&scope=$_scope$_as"
  get union "$_q" "tok-$_id" >"$TEST_TMP/u.json"
  get "$_m" "$_q" "$_tok" >"$TEST_TMP/a.json"
  _why=$(python3 "$TEST_TMP/norm.py" "$TEST_TMP/u.json" "$TEST_TMP/a.json") || fail "$_id on $_m reads $_scope differently from the union: $_why"
}
status_of() { get "$1" "$2" "$3" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error","ok")[:60])'; }
# An odd agent (on mb) whose parent is even (on ma): the child reads its ancestor's tree, the parent its own.
# The union daemon's agents, read through its API.
get union /api/agents >"$TEST_TMP/union-agents.json"
python3 - "$TEST_TMP/union-agents.json" >"$TEST_TMP/pair.txt" <<'PY'
import json, sys
agents = sorted(json.load(open(sys.argv[1])), key=lambda a: a["id"])
ids = [a["id"] for a in agents]
odd, even = set(ids[1::2]), set(ids[0::2])
for a in agents:
    if a.get("parent_id") and a["id"] in odd and a["parent_id"] in even:
        print(a["id"], a["parent_id"]); break
for a in agents:
    if a["harness"] == "opencode" and a["id"] in odd:
        print(a["id"]); break
PY
read CHILD PARENT <"$TEST_TMP/pair.txt"
OC=$(sed -n 2p "$TEST_TMP/pair.txt")
[ -n "$PARENT" ] || fail "the fixture has no odd agent under an even one"
as_same "$CHILD" mb "tree:$PARENT"
as_same "$CHILD" mb "tree:$CHILD"
as_same "$CHILD" mb "agent:$CHILD"
as_same "$PARENT" ma "tree:$PARENT"
as_same "$OC" mb "tree:$OC" oc-token "$OC"
[ "$(get ma "/api/activity?by=summary&days=3&scope=tree:$PARENT" "tok-$PARENT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["agents"])')" -gt 1 ] || fail "$PARENT sees only itself in its own tree"
# An ITSA, its worker (odd, so on mb, which has no ITSAs) and an unrelated developer.
python3 - "$TEST_TMP/union-agents.json" "$(on union sh -c 'echo "$STAM_URL"')" "$(cat "$TEST_TMP/union/token")" >"$TEST_TMP/members.txt" <<'PY'
import json, sys, urllib.request
agents = sorted(json.load(open(sys.argv[1])), key=lambda a: a["id"])
url, token = sys.argv[2:4]
def api(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(url + path, headers={"authorization": "Bearer " + token}), timeout=60))
ids = [a["id"] for a in agents]
odd = set(ids[1::2])
developers = [a["id"] for a in agents if a.get("type") == "developer"]
for i in sorted(api("/api/itsas?kind=issue"), key=lambda i: i["key"], reverse=True):
    if not i.get("owner") or i["owner"] not in odd: continue
    v = api("/api/itsas/" + i["key"])
    related = {i["owner"], i["created_by"]} | set(v["participants"])
    # The owners of every ancestor ITSA.
    for c in v["parent_chain"]:
        related.add(api("/api/itsas/" + c["key"])["owner"])
    out = [a for a in sorted(developers) if a in odd and a not in related]
    if out:
        print(i["key"], i["owner"], out[0]); break
PY
read KEY MEMBER OUTSIDER <"$TEST_TMP/members.txt"
[ -n "$OUTSIDER" ] || fail "the fixture has no ITSA with a worker on mb and an unrelated developer on mb"
as_same "$MEMBER" mb "itsa:$KEY"
[ "$(status_of mb "/api/activity?by=summary&days=3&scope=itsa:$KEY" "tok-$OUTSIDER")" != ok ] || fail "$OUTSIDER read $KEY on mb without belonging to it"
echo "-- mb down: ma answers with its own agents and names mb"
daemon_stop mb
_missing() { get ma "/api/activity?by=summary&days=3" | python3 -c 'import json,sys; m=json.load(sys.stdin)["machines"]; sys.exit(0 if m["missing"]==["mb"] and m["included"]==["ma"] else 1)'; }
wait_until _missing
get ma "/api/activity?by=summary&days=3" | python3 -c '
import json, sys
a = json.load(sys.stdin)
assert 0 < a["agents"] < 70, a["agents"]
assert a["clock"]["total_s"] > 0
'
echo "-- ma (the ITSA home) down: mb answers for its own agents and names ma"
daemon_up mb
daemon_stop ma
_missing_ma() { get mb "/api/activity?by=summary&days=3" | python3 -c 'import json,sys; m=json.load(sys.stdin)["machines"]; sys.exit(0 if m["missing"]==["ma"] and m["included"]==["mb"] else 1)'; }
wait_until _missing_ma
echo PASS
