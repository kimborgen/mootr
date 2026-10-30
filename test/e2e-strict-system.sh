#!/bin/sh
# The deploy watcher's CLI sequence (S-601, under S-426), with auth.humanStrict on and off: read an ITSA,
# set it done and post a note with --system deploy-watch, send its alert mail with mail send --system,
# link a branch, hit health. The shared-token CLI doesn't claim to be the human for these, so they pass
# in both modes with no auth.humanStrict line in the log; a shared-token call that claims the human on a
# human-only route is still refused under strict. Free: one registered agent.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
daemon_home main
STAM_TEST_HUMAN_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')
export STAM_TEST_HUMAN_KEY
fail() { echo "FAIL: $1"; exit 1; }
setauth() { python3 - "$TEST_TMP/main/settings.json" "$1" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
s.setdefault('auth', {}).update({'humanStrict': sys.argv[2] == 'true'})
json.dump(s, open(p, 'w'))
PY
}
J='content-type: application/json'
watcher() { # MODE: runs the watcher's sequence against the running daemon
  _m=$1
  : >"$LOG"
  ID=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -H 'x-stam-human: 1' -d '{"title":"strict system probe"}' "$URL/api/itsas" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("key") or d.get("id") or d)')
  case "$ID" in S-*) ;; *) fail "$_m: no ITSA made: $ID";; esac
  _t="$TEST_TMP/out"
  on main "$STAM" itsa show "$ID" >"$_t" 2>&1 || fail "$_m: itsa show: $(cat "$_t")"
  on main "$STAM" itsa set "$ID" --status done --system deploy-watch >"$_t" 2>&1 || fail "$_m: itsa set: $(cat "$_t")"
  on main "$STAM" itsa post "$ID" "deployed" --system deploy-watch >"$_t" 2>&1 || fail "$_m: itsa post: $(cat "$_t")"
  # The nightly Go parity run posts its line as a system sender too (S-2297).
  on main "$STAM" itsa post "$ID" "nightly" --system go-parity >"$_t" 2>&1 || fail "$_m: itsa post --system go-parity: $(cat "$_t")"
  on main "$STAM" itsa show "$ID" | grep -q '"status": *"done"' || fail "$_m: the ITSA isn't done"
  on main "$STAM" mail send --to "$A" --system deploy-watch --subject "alert" "stopped" >"$_t" 2>&1 || fail "$_m: mail send --system: $(cat "$_t")"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "$URL/api/health")" = 200 ] || fail "$_m: health refused"
  on main "$STAM" daemon status >"$_t" 2>&1 || fail "$_m: stam daemon status failed: $(cat "$_t")"
  ! grep -q "not running" "$_t" || fail "$_m: stam daemon status: $(cat "$_t")"
  on main "$STAM" ls >"$_t" 2>&1 || fail "$_m: stam ls: $(cat "$_t")"
  grep -q alpha "$_t" || fail "$_m: stam ls didn't list the agent: $(cat "$_t")"
  ! grep -Eq 'auth.humanStrict (off|is off|refuses)' "$LOG" || fail "$_m: log has a refusal: $(grep -E 'auth.humanStrict (off|is off|refuses)' "$LOG")"
  # A link's `system` is its kind, not a sender: the human's header stays, so it works with strict off.
  if [ "$_m" = off ]; then
    # The derived repo's name is the checkout's folder name (S-2083), not always `stam2`: the daemon derives it from the
    # checkout it runs from, whether or not it writes it into settings.json.
    _repo=$(basename "$(readlink -f "$ROOT")")
    on main "$STAM" itsa link "$ID" --system branch --external-id some-branch --repo "$_repo" >"$_t" 2>&1 || fail "$_m: itsa link --system branch: $(cat "$_t")"
  fi
}
setauth true
daemon_up main
URL=$(on main sh -c 'echo "$STAM_URL"')
TOKEN=$(cat "$TEST_TMP/main/token")
LOG="$TEST_TMP/main/daemon.log"
A=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "$J" -H "x-stam-test-human: $STAM_TEST_HUMAN_KEY" -d '{"name":"alpha","role":"test","harness":"claude"}' "$URL/api/register" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
[ -n "$A" ] || fail "no agent registered"

echo "-- strict on"
watcher on
# Claiming the human on a human-only route is still refused.
OUT=$(on main "$STAM" authorize p000000 2>&1 || true)
case "$OUT" in *"answer from stam's web UI"*) ;; *) fail "authorize wasn't refused with the web UI hint: $OUT";; esac
CODE=$(curl -s -o "$TEST_TMP/body" -w "%{http_code}" -X PATCH -H "authorization: Bearer $TOKEN" -H "$J" -H "x-stam-human: 1" -d '{"status":"todo","by":"human"}' "$URL/api/itsas/$ID"); [ "$CODE" = 403 ] || fail "an ITSA change claiming the human gave $CODE: $(cat "$TEST_TMP/body")"
# as_system names a sender only on the ITSA routes: another name is refused.
CODE=$(curl -s -o "$TEST_TMP/body" -w "%{http_code}" -X POST -H "authorization: Bearer $TOKEN" -H "$J" -d '{"body":"x","as_system":"someone-else"}' "$URL/api/itsas/$ID/post"); [ "$CODE" = 403 ] || fail "another system sender posted: $CODE"

echo "-- strict off"
on main "$STAM" daemon stop >/dev/null 2>&1 || true
setauth false
daemon_up main
TOKEN=$(cat "$TEST_TMP/main/token")
watcher off
echo PASS
