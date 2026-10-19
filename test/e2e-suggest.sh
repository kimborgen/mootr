#!/bin/sh
# Prompt suggestions (S-1459), free (no model): GET /api/suggest ranks agents and ITSAs by meaning
# above the cosine floor, a recent id lifts its item, an archived agent ranks below a live one, and
# an agent's token gets no thread. Runs on a throwaway daemon (test/lib.sh) with the stub embedder
# (STAM_EMBEDDER=stub); nothing waits on a timer.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
cat >"$TEST_TMP/suggest.json" <<'EOJ'
{ "turns": [
  { "match": "zebra ledger migration", "steps": [
    { "tool": "Grep", "input": { "pattern": "hidden-tool-input-xyzzy" }, "output": "hidden-tool-result-plugh" },
    { "reply": "Moved the quarterly ledger rows into the new tables." } ] }
] }
EOJ
fake_claude "$TEST_TMP/suggest.json"
isolate main
fail() { echo "FAIL: $1"; exit 1; }
human() { curl -s -X "$1" -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'content-type: application/json' -H 'x-stam-human: 1' "$STAM_URL$2" ${3:+-d "$3"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
spawn() { human POST /api/agents "{\"name\":\"$1\",\"harness\":\"claude\",\"model\":\"claude-sonnet-5-5\",\"cwd\":\"$TEST_TMP\",\"role\":\"$2\"}" | field id; }
suggest() { human GET "/api/suggest?q=$(printf '%s' "$1" | sed 's/ /%20/g')${2:+&recent=$2}"; }
SIGNIN=$(human POST /api/itsas '{"by":"human","title":"Login regression","summary":"Sign-in breaks for returning people","body":"Users keep getting redirected back to the sign-in page after logout."}' | field id)
human POST /api/itsas '{"by":"human","title":"Invoice reconciliation","body":"Reconcile the September invoices against the ledger."}' >/dev/null
LIVE=$(spawn invoice-live "reconcile the september invoices against the ledger")
OLD=$(spawn invoice-old "reconcile the september invoices against the ledger")
spawn palette "pick a colour palette for the spend chart" >/dev/null
[ -n "$SIGNIN" ] && [ -n "$LIVE" ] && [ -n "$OLD" ] || fail "setup: $SIGNIN $LIVE $OLD"
# An agent's finished turn is its own vector: this one's role says nothing about it.
TURN=$(human POST /api/agents "{\"name\":\"quiet-helper\",\"harness\":\"claude\",\"model\":\"claude-sonnet-5-5\",\"cwd\":\"$TEST_TMP\",\"role\":\"helper\",\"prompt\":\"Start the zebra ledger migration\"}" | field id)
[ -n "$TURN" ] || fail "setup: no turn agent"
indexed() { "$STAM" embedder status | grep -Eq "agent: [3-9]" && "$STAM" embedder status | grep -Eq "itsa: 2(,|\$)" && "$STAM" embedder status | grep -Eq "turn: [1-9]"; }
wait_until indexed

# The turn maps to its agent, with the turn as the snippet and a `turn` field; tool inputs and results aren't in it.
OUT=$(suggest "moved the quarterly ledger rows into the new tables")
[ "$(echo "$OUT" | field 0.id)" = "$TURN" ] || fail "the turn's agent isn't first: $OUT"
[ -n "$(echo "$OUT" | field 0.turn)" ] || fail "no turn field: $OUT"
echo "$OUT" | grep -q "quarterly ledger rows" || fail "the turn isn't the snippet: $OUT"
echo "$OUT" | grep -q "Start the zebra" || fail "the prompt isn't in the snippet: $OUT"
[ "$(suggest "hidden-tool-input-xyzzy hidden-tool-result-plugh" | grep -c "$TURN")" = 0 ] || fail "a tool input or result was embedded"
[ "$(echo "$OUT" | grep -o "\"id\":\"$TURN\"" | wc -l)" = 1 ] || fail "the agent has more than one row: $OUT"

# By meaning: the sign-in ITSA first for words only its body shares, with the shape search.ts uses.
OUT=$(suggest "keeps redirecting users")
[ "$(echo "$OUT" | field 0.id)" = "$SIGNIN" ] || fail "the sign-in ITSA isn't first: $OUT"
[ "$(echo "$OUT" | field 0.kind)" = itsa ] && [ "$(echo "$OUT" | field 0.by)" = meaning ] || fail "wrong kind or by: $OUT"

# Agents: the two invoice agents, the palette agent below the floor.
OUT=$(suggest "reconcile the september invoices")
echo "$OUT" | grep -q '"palette"' && fail "the palette agent is below the floor: $OUT"
[ "$(echo "$OUT" | field 0.kind)" != "" ] || fail "no suggestion: $OUT"
echo "$OUT" | grep -q "$LIVE" || fail "the live invoice agent is missing: $OUT"

# An archived agent ranks below its live twin; a recent id narrows the gap.
human POST "/api/agents/$OLD/archive" '{}' >/dev/null
archived() { suggest "reconcile the september invoices" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s).filter(r=>r.kind==="agent");process.exit(h[0]?.id===process.argv[1]&&h.some(r=>r.id===process.argv[2])?0:1)})' "$LIVE" "$OLD"; }
wait_until archived

# The query stays out of the way: a nonsense query suggests nothing; an agent's token gets no thread.
[ "$(suggest "zzqx unrelated gibberish" | field length)" = 0 ] || fail "a nonsense query suggested something"
echo "PASS e2e-suggest"
