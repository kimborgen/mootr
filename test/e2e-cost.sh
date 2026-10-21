#!/bin/sh
# The cost policy end to end (docs/cost-policy.md, step 17), free: one throwaway daemon with three fake
# accounts (a Claude-like and a Codex-like one with `paid: false`, an OpenRouter-like one with a budget),
# the scripted fake Claude Code, Codex and OpenCode, and a stub OpenRouter (test/cost-stub.mjs). No model;
# the dollars are the stub's: the ledger keeps them (KEEP=1 shows them) and lib.sh reports the run's spend as $0. Every wait is on
# state. Readings come in through POST /api/test/cost, which calls what the adapters call
# (usage.reportSubscription), and the fallback clock is a time the test passes (src/daemon.ts).
#
#   1. Window (Claude and Codex agents): a reading at 100% sets the `window` blocker, the admission gate
#      holds the agent's mail, a fresh reading below 100% clears it and the mail goes in.
#   2. Manager acts: the manager of w2 (a fake Claude agent) gets the notice and pauses the tree
#      until reset; its notice is acknowledged and its fallback is skipped.
#   3. Fallback: notices nobody acts on (w1, w3, whose manager is the chief of staff, a fake agent) run the
#      account's onSubExhausted action when the clock passes fallbackMinutes, and the chief of staff is told.
#   4. Budget (OpenCode agents): spend through the stub reaches the budget, `budget:openrouter` is set, mail
#      is held, a spawn onto the account is refused, stam mails the human a decision, and raising the budget
#      in settings through the human route clears it.
#   5. Credits out: a zero balance sets `credits-out:openrouter`, a spawn is refused, a top-up clears it.
#   6. Provider errors (`error:ACCOUNT`, OpenCode agents): a transient error sets the blocker and holds the
#      mail, a failing probe (the stub's GET /key) keeps it, a passing one clears it; an `auth` error twice
#      in one outage mails the human once.
# Scenarios 1 and 3 run on the Claude and Codex accounts; 4, 5 and 6 run on OpenCode, the only harness on an
# OpenRouter account. Runs on its own daemon (test/lib.sh).
set -e
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# The dollars are the stub's, not a provider's: the ledger keeps them, and run.sh reads the spend as $0 (lib.sh).
export STAM_TEST_SPEND_STUBBED=1

# Claude agents are scripted per name. mgr acts on w2's blocker notice; the others reply and, on a
# ping, read their mail.
cat >"$TEST_TMP/cost.json" <<'JSON'
{
  "agents": {
    "mgr": { "turns": [
      { "match": "/w2 blocked: window/", "once": true, "steps": [
        { "mcp": "cost_pause", "args": { "tree": "w2", "until": "reset" }, "expect": "Paused" },
        { "reply": "PAUSED" } ] } ] },
    "w1": { "turns": [ { "match": "/WINDOW-PING/", "steps": [ { "mcp": "read_mail" }, { "reply": "PONG" } ] } ] }
  },
  "default": { "steps": [ { "reply": "DONE" } ] }
}
JSON
fake_claude "$TEST_TMP/cost.json"
export STAM_OPENCODE_BIN="$ROOT/test/fake-opencode/opencode"

daemon_home main
stub_key main
STUB="$TEST_TMP/stub"
mkdir -p "$STUB"
node "$ROOT/test/cost-stub.mjs" "$STUB" &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null; stam_test_cleanup' EXIT
for _i in $(seq 1 50); do
  [ -s "$STUB/url" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || { echo "FAIL: the stub OpenRouter didn't start"; exit 1; }
  sleep 0.2
done
STAM_OPENROUTER_URL="$(cat "$STUB/url")"
export STAM_OPENROUTER_URL
# paid: false on both subscriptions; budget on the OpenRouter account. mgr, cos and the human's own agents
# run on claude-haiku, which no account matches (unmanaged), so they can always hear a notice.
cat >"$TEST_TMP/main/settings.json" <<'JSON'
{ "peers": [], "cost": {
  "fallbackMinutes": 15,
  "accounts": {
    "claude-like": { "match": { "harness": "claude", "model": "claude-sonnet" }, "paid": false, "onSubExhausted": "wait" },
    "codex-like": { "match": { "harness": "codex" }, "paid": false, "onSubExhausted": "wait" },
    "openrouter": { "match": { "harness": "opencode", "model": "openrouter/" }, "subscription": false, "lowCreditsUsd": 2,
      "budget": { "usd": 0.05, "per": "cap" } }
  } } }
JSON
daemon_up main
use main
TOKEN=$(cat "$STAM_HOME/token")
FUT=$(($(date +%s) + 7200))

fail() { echo "FAIL: $1"; exit 1; }
api() { curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'x-stam-human: 1' "$@"; }
# tget PATH: a test-route read (-f: a gate 404 fails here). py EXPR: EXPR over the JSON on stdin, as d.
tget() { curl -sf -H "authorization: Bearer $TOKEN" "$STAM_URL/api/test/$1"; }
py() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
aid() { api "$STAM_URL/api/agents" | python3 -c 'import json,sys; print(next((a["id"] for a in json.load(sys.stdin) if a["name"] == sys.argv[1]), ""))' "$1"; }
count_blockers() { tget "blockers?agent=$1" | py "sum(b['kind'] == '$2' and b['account'] == '$3' for b in d)"; }
has_blocker() { [ "$(count_blockers "$1" "$2" "$3")" = 1 ]; }
no_blocker() { [ "$(count_blockers "$1" "$2" "$3")" = 0 ]; }
# 1 once the mail with this subject was pushed to the agent, 0 while it waits.
pushed() { tget "mail-pushed?agent=$1&subject=$2" | py "int(d[0]['pushed']) if d else ''"; }
is_pushed() { [ "$(pushed "$1" "$2")" = 1 ]; }
# The events of an agent of one type whose data holds a text: count.
event_count() { tget "events?agent=$(aid "$1")&type=$2" | py "sum('$3' in (e['data'] or '') for e in d)"; }
refusals() { event_count "$1" cost:refused ''; }
refused() { [ "$(refusals "$1")" -ge 1 ]; }
# Who acknowledged an agent's blocker-set notice: empty while nobody did.
acked_by() { tget "cost-notices?agent=$1" | py "next((n['acked_by'] or '' for n in d if n['kind'] == 'blocker-set'), '')"; }
# The mails in an agent's inbox whose subject matches a regex: their threads' first bodies, one per line break.
inbox_subjects() { api "$STAM_URL/api/agents/$1/inbox?limit=200" | py "'\n'.join(m['subject'] for m in d)"; }
mail_body() { api "$STAM_URL/api/agents/$1/inbox?limit=200" | python3 -c 'import json,re,sys
for m in json.load(sys.stdin):
    if re.search(sys.argv[1], m["subject"]): print(m["thread_id"]); break' "$2" | while read -r _t; do api "$STAM_URL/api/threads/$_t" | py "d[0]['body']"; done; }
ping() { "$STAM" mail send --to "$1" --subject "$2" "ping" >/dev/null; }
reading() { api -X POST "$STAM_URL/api/test/cost" -d "{\"action\":\"reading\",\"name\":\"$1\",\"windows\":{\"five_hour\":{\"used_percentage\":$2,\"resets_at\":$FUT}}}" >/dev/null; }
fallbacks_due() { api -X POST "$STAM_URL/api/test/cost" -d "{\"action\":\"fallback-due\",\"now\":$(($(date +%s) * 1000 + 7200000))}" >/dev/null; }
poll_credits() { api -X POST "$STAM_URL/api/test/cost" -d '{"action":"poll-credits"}' >/dev/null; }
# A provider error on an agent, as its adapter reports it, and the account's error probe run now.
provider_error() { api -X POST "$STAM_URL/api/test/cost" -d "{\"action\":\"error\",\"agent\":\"$1\",\"class\":\"$2\",\"source\":\"$3\"}" >/dev/null; }
probe_due() { api -X POST "$STAM_URL/api/test/cost" -d "{\"action\":\"probe-due\",\"account\":\"$1\"}" >/dev/null; }
# The balance the stub reports, and the credit the daemon has read from it.
balance() { printf '%s' "$1" >"$STUB/remaining"; poll_credits; }
setbudget() {
  api "$STAM_URL/api/config/settings" | python3 -c '
import json, sys
s = json.loads(json.load(sys.stdin)["text"])
s["cost"]["accounts"]["openrouter"]["budget"]["usd"] = float(sys.argv[1])
print(json.dumps({"text": json.dumps(s)}))' "$1" |
    api -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -X POST "$STAM_URL/api/config/settings" -d @- >/dev/null
}

echo "-- the test hooks are off unless the daemon is an isolated test one"
hooks_status() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $(cat "$STAM_HOME/token")" -H 'content-type: application/json' -d '{"action":"poll-credits"}' "$STAM_URL/api/test/cost"; }
daemon_home off
(STAM_TEST_COST_HOOKS=0; daemon_up off)
[ "$(on off hooks_status)" = 404 ] || fail "the cost test hooks answered with STAM_TEST_COST_HOOKS=0"
daemon_stop off
(unset STAM_TEST_COST_HOOKS; daemon_up off)
[ "$(on off hooks_status)" = 404 ] || fail "the cost test hooks answered with STAM_TEST_COST_HOOKS unset"
daemon_stop off
sed -i "s/STAM_TMUX_SOCKET=stam-test-/STAM_TMUX_SOCKET=other-/" "$TEST_TMP/off/test.env"
daemon_up off
[ "$(on off hooks_status)" = 404 ] || fail "the cost test hooks answered on a daemon with a non-test tmux socket"
daemon_stop off

echo "-- setup: the chief of staff, a manager, three Claude workers, a Codex agent, an OpenCode agent"
D="$TEST_TMP/work"
mkdir -p "$D"
"$STAM" spawn cos --model claude-haiku-5-5 --cwd "$D" "Say hi." >/dev/null
"$STAM" spawn mgr --model claude-haiku-5-5 --cwd "$D" "Say hi." >/dev/null
"$STAM" wait cos --until idle --timeout 60 >/dev/null
"$STAM" wait mgr --until idle --timeout 60 >/dev/null
"$STAM" cos cos >/dev/null
for w in w1 w3; do "$STAM" spawn "$w" --model claude-sonnet-5-5 --cwd "$D" "Say hi." >/dev/null; done
"$STAM" spawn w2 --model claude-sonnet-5-5 --parent mgr --cwd "$D" "Say hi." >/dev/null
"$STAM" spawn cx --harness codex --cwd "$D" >/dev/null
# A manager, so its mail to the human is checked (and billed) by the decision stub; a plain agent's is rerouted to its parent first (S-548).
"$STAM" spawn oc --type manager --harness opencode --model openrouter/stub/model --cwd "$D" "Say hi." >/dev/null
for a in w1 w2 w3 cx oc; do "$STAM" wait "$a" --until idle --timeout 60 >/dev/null; done

echo "-- the test hooks refuse an agent's token (S-1287); the shared token still reaches them"
W1_TOKEN=$(agent_token w1)
hooks_code() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -d '{"action":"poll-credits"}' "$STAM_URL/api/test/cost"; }
[ "$(hooks_code "$W1_TOKEN")" = 403 ] || fail "an agent's token reached the cost test hooks"
[ "$(hooks_code "$TOKEN")" = 200 ] || fail "the shared token was refused by the cost test hooks"

echo "-- the other test hooks refuse an agent's token too (S-1731); the shared token still reaches them"
hook_code() { curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $1" -H 'content-type: application/json' -d "$3" "$STAM_URL/api/test/$2"; }
[ "$(hook_code "$W1_TOKEN" read-hold '{"agent":"w1","action":"release"}')" = 403 ] || fail "an agent's token reached read-hold"
[ "$(hook_code "$TOKEN" read-hold '{"agent":"w1","action":"release"}')" = 200 ] || fail "the shared token was refused by read-hold"
[ "$(hook_code "$W1_TOKEN" statements '{"action":"stop"}')" = 403 ] || fail "an agent's token reached statements"
[ "$(hook_code "$TOKEN" statements '{"action":"stop"}')" = 400 ] || fail "the shared token was refused by statements"
[ "$(hook_code "$W1_TOKEN" stall '{"ms":0}')" = 403 ] || fail "an agent's token reached stall"
[ "$(hook_code "$TOKEN" stall '{"ms":0}')" = 200 ] || fail "the shared token was refused by stall"
[ "$(hook_code "$W1_TOKEN" launch-fail '{"names":[]}')" = 403 ] || fail "an agent's token reached launch-fail"
[ "$(hook_code "$TOKEN" launch-fail '{"names":[]}')" = 200 ] || fail "the shared token was refused by launch-fail"
[ "$(hook_code "$W1_TOKEN" itsa-gate '{"action":"status"}')" = 403 ] || fail "an agent's token reached itsa-gate"
[ "$(hook_code "$TOKEN" itsa-gate '{"action":"status"}')" = 200 ] || fail "the shared token was refused by itsa-gate"
[ "$(hook_code "$W1_TOKEN" await '{}')" = 403 ] || fail "an agent's token reached await"
[ "$(hook_code "$W1_TOKEN" agent '{"agent":"w1"}')" = 403 ] || fail "an agent's token reached agent"
[ "$(hook_code "$W1_TOKEN" events '{}')" = 403 ] || fail "an agent's token reached events"
[ "$(hook_code "$W1_TOKEN" pending-unown '{}')" = 403 ] || fail "an agent's token reached pending-unown"
[ "$(hook_code "$W1_TOKEN" permission '{}')" = 403 ] || fail "an agent's token reached permission"
[ "$(hook_code "$W1_TOKEN" wait '{}')" = 403 ] || fail "an agent's token reached wait"
[ "$(hook_code "$W1_TOKEN" usage '{}')" = 403 ] || fail "an agent's token reached usage"
[ "$(hook_code "$W1_TOKEN" settings '{}')" = 403 ] || fail "an agent's token reached settings"
[ "$(hook_code "$W1_TOKEN" set-setting '{"key":"x","value":"y"}')" = 403 ] || fail "an agent's token reached set-setting"
[ "$(hook_code "$W1_TOKEN" token-at-rest '{}')" = 403 ] || fail "an agent's token reached token-at-rest"
[ "$(hook_code "$W1_TOKEN" seed-agents '{}')" = 403 ] || fail "an agent's token reached seed-agents"
[ "$(hook_code "$W1_TOKEN" mail '{}')" = 403 ] || fail "an agent's token reached mail"
[ "$(hook_code "$W1_TOKEN" delivery-fail '{}')" = 403 ] || fail "an agent's token reached delivery-fail"
[ "$(hook_code "$W1_TOKEN" kv '{"key":"x","value":"y"}')" = 403 ] || fail "an agent's token reached kv"
[ "$(hook_code "$W1_TOKEN" no-such-hook '{}')" = 403 ] || fail "an agent's token got past the prefix gate on an unknown test route"
touch "$STAM_HOME/stall-release"
[ "$(hook_code "$TOKEN" await '{}')" = 200 ] || fail "the shared token was refused by await"

echo "-- 1. window (Claude): a reading at 100% sets the blocker and holds the mail; below 100% clears it"
reading claude 100
for w in w1 w2 w3; do wait_until has_blocker "$w" window claude-like; done
ping w1 WINDOW-PING-1
wait_until refused w1
[ "$(pushed w1 WINDOW-PING-1)" = 0 ] || fail "the admission gate let a turn start on w1 while its window read 100%"

echo "-- 2. the manager acts: mgr pauses w2's tree until reset, which acknowledges the notice"
w2_acked() { [ -n "$(acked_by w2)" ]; }
wait_until w2_acked
[ "$(acked_by w2)" = "$(aid mgr)" ] || fail "the notice about w2 wasn't acknowledged by mgr"
# The notice about w1 went to the chief of staff, which didn't act.
[ -z "$(acked_by w1)" ] || fail "the notice about w1 was acknowledged"

echo "-- 3. the fallback: past fallbackMinutes, unacted notices run onSubExhausted and tell the chief of staff"
fallbacks_due
fb() { tget "cost-fallbacks?agent=$1" | py "next((f['$2'] for f in d if f['notice_kind'] == 'blocker-set' and f['kind'] == 'window'), '')"; }
fb_done() { [ "$(fb "$1" state)" = done ]; }
for w in w1 w2 w3; do wait_until fb_done "$w"; done
case "$(fb w2 result)" in "skipped: mgr acted on it"*) ;; *) fail "w2's fallback should be skipped for the manager's act, got: $(fb w2 result)" ;; esac
case "$(fb w3 result)" in "waited: "*) ;; *) fail "w3's fallback should have run the wait action, got: $(fb w3 result)" ;; esac
told() { inbox_subjects cos | grep -q "Cost fallback ran for $1"; }
wait_until told w3
wait_until told w1
! told w2 || fail "the chief of staff was told of a fallback for w2, whose manager acted"
[ "$(event_count w2 cost:fallback start)" = 0 ] || fail "w2's fallback ran"

echo "-- 1 (continued). a fresh Claude reading below 100% clears the blockers; the held mail goes in"
reading claude 40
for w in w1 w2 w3; do wait_until no_blocker "$w" window claude-like; done
wait_until is_pushed w1 WINDOW-PING-1
# mgr's cost pause lifts on the same reading.
no_pause() { [ "$(api "$STAM_URL/api/agents/w2" | py "d.get('paused_by') or '[]'")" = '[]' ]; }
wait_until no_pause

echo "-- 1 (Codex): the same on a Codex agent"
reading codex 100
wait_until has_blocker cx window codex-like
ping cx WINDOW-PING-2
wait_until refused cx
[ "$(pushed cx WINDOW-PING-2)" = 0 ] || fail "the admission gate let a turn start on cx while its window read 100%"
# Its notice went to the chief of staff, which didn't act: the fallback runs and tells it.
fallbacks_due
wait_until fb_done cx
case "$(fb cx result)" in "waited: "*) ;; *) fail "cx's fallback should have run the wait action, got: $(fb cx result)" ;; esac
wait_until told cx
reading codex 30
wait_until no_blocker cx window codex-like
wait_until is_pushed cx WINDOW-PING-2

echo "-- 4. budget (OpenCode): the agent's spend reaches \$0.05, which holds the account"
# Stam's own model calls (the mail gate) book to openrouter-system (S-1254), so the agents' budget is spent by
# the agent's own reported cost: $0.06 for oc, on the openrouter account.
api -X POST "$STAM_URL/api/test/cost" -d '{"action":"spend","agent":"oc","cost":0.06}' >/dev/null
wait_until has_blocker oc budget openrouter
[ "$(tget "usage-total?account=openrouter" | py "round(d['cost_usd'], 2) >= 0.05")" = True ] || fail "the ledger doesn't show the stub's spend"
ping oc BUDGET-PING
wait_until refused oc
[ "$(pushed oc BUDGET-PING)" = 0 ] || fail "the admission gate let a turn start on oc while its budget was spent"
OUT=$("$STAM" spawn oc2 --harness opencode --model openrouter/stub/model --cwd "$D" "Say hi." 2>&1) && fail "a spawn onto the spent account succeeded" || true
case "$OUT" in *budget*) ;; *) fail "the refused spawn doesn't name the budget: $OUT" ;; esac
budget_mail() { mail_body human 'openrouter.* reached'; }
has_budget_mail() { [ -n "$(budget_mail)" ]; }
wait_until has_budget_mail
budget_mail | grep -q '```decision' || fail "stam's budget mail to the human has no decision block"
setbudget 5
wait_until no_blocker oc budget openrouter
wait_until is_pushed oc BUDGET-PING

echo "-- 5. credits out: a zero balance sets the blocker, a top-up clears it"
balance 0
wait_until has_blocker oc credits-out openrouter
OUT=$("$STAM" spawn oc3 --harness opencode --model openrouter/stub/model --cwd "$D" "Say hi." 2>&1) && fail "a spawn onto an account without credits succeeded" || true
case "$OUT" in *credits-out*) ;; *) fail "the refused spawn doesn't name credits-out: $OUT" ;; esac
balance 5
wait_until no_blocker oc credits-out openrouter

echo "-- 6. provider errors: a transient error holds the account until a probe of GET /key succeeds"
provider_error oc transient 'session.execution.failed (503)'
wait_until has_blocker oc error openrouter
ping oc ERROR-PING
wait_until refused oc
[ "$(pushed oc ERROR-PING)" = 0 ] || fail "the admission gate let a turn start on oc while its account had a provider error"
OUT=$("$STAM" spawn oc4 --harness opencode --model openrouter/stub/model --cwd "$D" "Say hi." 2>&1) && fail "a spawn onto an account with a provider error succeeded" || true
case "$OUT" in *error*) ;; *) fail "the refused spawn doesn't name the error: $OUT" ;; esac
probes() { event_count oc cost:probe "$1"; }
printf 503 >"$STUB/key-status"
probe_due openrouter
[ "$(probes '"outcome":"fail"')" = 1 ] || fail "the failing probe wasn't recorded"
has_blocker oc error openrouter || fail "a failing probe cleared the error blocker"
rm "$STUB/key-status"
probe_due openrouter
wait_until no_blocker oc error openrouter
wait_until is_pushed oc ERROR-PING

echo "-- 6 (auth). two auth errors in one outage mail the human once; a probe clears it"
auth_mail() { inbox_subjects human | grep -c 'openrouter: authentication error' || true; }
provider_error oc auth 'session.execution.failed (401)'
wait_until has_blocker oc error openrouter
provider_error oc auth 'session.execution.failed (401)'
mailed() { [ "$(auth_mail)" -ge 1 ]; }
wait_until mailed
[ "$(auth_mail)" = 1 ] || fail "the human got $(auth_mail) mails for one auth outage"
probe_due openrouter
wait_until no_blocker oc error openrouter

echo "PASS e2e-cost"
