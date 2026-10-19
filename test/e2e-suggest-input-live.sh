#!/bin/sh
# Suggested harness input (S-422) on real Claude Code: a smoke test (--smoke), with
# claude-haiku-5-5 against its own daemon (test/lib.sh). The human's approval (the test key)
# types a bash-mode command with double spaces and a ';', one of about 250 characters, which
# word-wraps in the box, a plain prompt, and `/re`, whose completion menu needs one Esc. Each
# must be sent exactly as written or not at all. The screens go to $OUT (default: the test
# folder) for comparing with the fake's. Costs about $0.01.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
isolate
fail() { "$STAM" events live 2>/dev/null | grep -E 'input:|hook:UserPromptSubmit' >"$OUT/events.txt" || true; echo "FAIL: $1 (events in $OUT/events.txt)"; exit 1; }
OUT=${OUT:-$TEST_TMP/screens}
mkdir -p "$OUT"
TOKEN=$(cat "$STAM_HOME/token")
DIR="$(mktemp -d "$TEST_TMP/work.XXXX")"
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));console.log(v??"")})' "$1"; }
human() { curl -s -X "$1" -H "authorization: Bearer $TOKEN" -H 'x-stam-human: 1' -H 'content-type: application/json' "$STAM_URL$2" ${3:+-d "$3"}; }
ID=$(human POST /api/agents "{\"name\":\"live\",\"harness\":\"claude\",\"model\":\"claude-haiku-5-5\",\"cwd\":\"$DIR\",\"role\":\"test\"}" | field id)
[ -n "$ID" ] || fail "spawn"
"$STAM" wait live --until idle --timeout 120 >/dev/null
KT=$(tmux -L "$STAM_TMUX_SOCKET" show-environment -t "$ID" STAM_TOKEN | cut -d= -f2-)
cap() { tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -t "=$ID:" >"$OUT/$1.txt"; }
ready() { "$STAM" show live | grep -q '"activity": "idle"' && tmux -L "$STAM_TMUX_SOCKET" capture-pane -p -t "=$ID:" >"$TEST_TMP/pane" && grep -q '^❯.$' "$TEST_TMP/pane" && ! grep -q '… (' "$TEST_TMP/pane"; }
status() { human GET /api/permissions | python3 -c 'import json,sys; print(next(r["status"] for r in json.load(sys.stdin) if r["id"]==sys.argv[1]))' "$1"; }
# suggest TEXT: the agent suggests it and the human approves; prints the outcome.
suggest() {
  wait_until ready
  curl -s -X POST -H "authorization: Bearer $KT" -H 'content-type: application/json' "$STAM_URL/api/suggest-input" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1], "reason": "smoke"}))' "$1")" >"$TEST_TMP/s.json"
  P=$(field id <"$TEST_TMP/s.json")
  [ -n "$P" ] || fail "suggest '$1': $(cat "$TEST_TMP/s.json")"
  curl -s -X POST -H "authorization: Bearer $TOKEN" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'content-type: application/json' \
    "$STAM_URL/api/permissions/$P/answer" -d "{\"approve\":true,\"text_sha256\":\"$(printf %s "$1" | sha256sum | cut -d' ' -f1)\"}" >"$TEST_TMP/a.json"
  # The agent may have started a turn (a pushed notice) since: a held approval is typed at its next idle.
  for _i in $(seq 1 120); do [ "$(status "$P")" = held ] || break; sleep 0.5; done
  case "$(status "$P")" in approved) echo typed ;; *) status "$P" ;; esac
}
transcript() { "$STAM" show live | grep -m1 '"transcript_path"' | cut -d'"' -f4; }

echo "-- a bash-mode command runs exactly as written"
O=$(suggest '! echo s422-smoke  a;b')
cap 1-bash
[ "$O" = typed ] || fail "bash outcome: $O"
ran() { grep -qF 'echo s422-smoke  a;b' "$(transcript)"; }
wait_until ran
grep -F 's422-smoke' "$(transcript)" >"$OUT/transcript-bash.jsonl" || true

echo "-- a plain prompt is submitted as written"
O=$(suggest 'say ok')
cap 2-plain
[ "$O" = typed ] || fail "plain outcome: $O"
submitted() { "$STAM" events live | grep -q 'input:submitted.*"matched":true.*say ok'; }
wait_until submitted
"$STAM" wait live --until idle --timeout 120 >/dev/null

echo "-- a long bash-mode command word-wraps in the box and still runs exactly as written"
LONG="! echo s422-long  $(python3 -c 'print(" ".join("w%03d" % i for i in range(45)))')  &&  echo   s422-long-done"
O=$(suggest "$LONG")
cap 1-long
[ "$O" = typed ] || fail "long outcome: $O"
ran_long() { grep -qF "$(printf %s "${LONG#!}" | sed 's/^ *//')" "$(transcript)"; }
wait_until ran_long

echo "-- /re: its menu gets one Esc, then it is sent as written or not at all"
O=$(suggest '/re')
cap 3-slash
case "$O" in typed | failed) ;; *) fail "/re outcome: $O" ;; esac
echo "   /re: $O"
"$STAM" events live | grep -E 'input:|hook:UserPromptSubmit' >"$OUT/events.txt" || true

grep -q 'input:mismatch' "$OUT/events.txt" && fail "a submitted prompt wasn't the text: $(grep mismatch "$OUT/events.txt")"
echo "   bash mode's UserPromptSubmit: $(grep -c 'input:submitted.*s422' "$OUT/events.txt" || true) (screens in $OUT)"
echo "PASS e2e-suggest-input-live"
