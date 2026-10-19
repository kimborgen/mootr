#!/bin/sh
# Janitor (ITSA S-67), free (no models): a leftover test folder whose owner is gone -- a
# throwaway daemon, its tmux server, and a fake `stamd-test-*` systemd unit -- is swept
# away, while the test's own live daemon survives; a dry run reports it but removes
# nothing. Runs against its own daemon (test/lib.sh); the janitor is machine-wide, so it
# also sees this test's folder, which it must keep.
set -e
. "$(dirname "$(readlink -f "$0")")/lib.sh"
# A child that starts a daemon and waits to be killed, to prove the TERM trap cleans up.
if [ "$1" = --child ]; then
  isolate child
  printf '%s\n%s\n%s\n' "$TEST_TMP" "$STAM_PORT" "$STAM_TMUX_SOCKET" >"$2"
  trap 'kill "$keep" 2>/dev/null; exit 130' INT TERM HUP
  while :; do sleep 3600 & keep=$!; wait $keep; done
fi
isolate main
fail() { echo "FAIL: $1"; exit 1; }

# The fake orphan: /tmp/stam-test.zzgone.XXXX, a real throwaway daemon with its own home,
# a tmux server, and an enabled stamd-test-* unit pointing at that home. The owner file is
# written last, so until then the janitor keeps it (no owner file = unsure = leave it).
FAKE="$(mktemp -d /tmp/stam-test.zzgone.XXXXXX)"
FSOCK="stam-test-zzgone-${FAKE##*.}-fake"
FPORT=$(free_port)
FOPORT=$(free_port)
SVC="stamd-test-${FAKE##*.}"
UNITF="$HOME/.config/systemd/user/$SVC.service"

cleanup_fake() {
  set +e
  [ -n "$FAKE" ] || return
  if [ -f "$FAKE/fake/daemon.pid" ]; then
    fpid=$(cat "$FAKE/fake/daemon.pid" 2>/dev/null)
    case "$fpid" in '' | *[!0-9]*) ;; *) kill -s KILL "$fpid" 2>/dev/null ;; esac
  fi
  tmux -L "$FSOCK" kill-server 2>/dev/null
  rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/$FSOCK"
  systemctl --user disable --now "$SVC" >/dev/null 2>&1
  rm -f "$UNITF"
  rm -f "$HOME/.config/systemd/user/default.target.wants/$SVC.service"
  systemctl --user daemon-reload >/dev/null 2>&1
  rm -rf "$FAKE"
}
# The extras the no-daemon sections start: the server that resets the connection and the symlink
# scope. Removed on EXIT too, so a failure mid-section leaves neither behind.
RESET_PID=
ALIAS_SCOPE=
cleanup_extra() {
  set +e
  [ -n "$RESET_PID" ] && kill "$RESET_PID" 2>/dev/null
  [ -n "$ALIAS_SCOPE" ] && rm -f "$ALIAS_SCOPE"
  RESET_PID=
  ALIAS_SCOPE=
}
trap 'cleanup_extra; cleanup_fake; stam_test_cleanup' EXIT
trap 'exit 130' INT TERM HUP

mkdir -p "$FAKE/fake"
cat >"$FAKE/fake/test.env" <<EOF
export STAM_HOME='$FAKE/fake' STAM_PORT=$FPORT STAM_URL=http://127.0.0.1:$FPORT STAM_TMUX_SOCKET=$FSOCK STAM_MACHINE=fake STAM_BIND=127.0.0.1 STAM_OPENCODE_PORT=$FOPORT
EOF
printf '{ "peers": [] }\n' >"$FAKE/fake/settings.json"
(umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(24))' >"$FAKE/fake/token")
FTOKEN=$(cat "$FAKE/fake/token")

echo "== the owner is gone (its pid is dead), written before the daemon and tmux server start"
sh -c 'exit 0' & DEADPID=$!
wait "$DEADPID" 2>/dev/null || true
printf 'agent=zzgone\npid=%s\nstarted=%s\n' "$DEADPID" "$(date -Is)" >"$FAKE/owner"

echo "== a throwaway daemon and a tmux server under the fake home"
( . "$FAKE/fake/test.env"; STAM_OPENCODE_BIN=/bin/false STAM_CODEX_BIN=/bin/false node --no-warnings "$ROOT/src/cli.ts" daemon start >/dev/null )
for _i in $(seq 1 40); do curl -sf -m 1 -H "authorization: Bearer $FTOKEN" "http://127.0.0.1:$FPORT/api/health" >/dev/null && break; sleep 0.25; done
curl -sf -m 1 -H "authorization: Bearer $FTOKEN" "http://127.0.0.1:$FPORT/api/health" >/dev/null || fail "the fake daemon didn't start"
FPID=$(cat "$FAKE/fake/daemon.pid")
tmux -L "$FSOCK" new-session -d -s orphan 'sleep 300'
tmux -L "$FSOCK" has-session -t =orphan 2>/dev/null || fail "the fake tmux server didn't start"

echo "== an enabled stamd-test unit for the fake home"
mkdir -p "$(dirname "$UNITF")"
cat >"$UNITF" <<EOF
[Unit]
Description=fake test daemon (janitor test)

[Service]
ExecStart=/bin/sleep 300
Environment=STAM_HOME=$FAKE/fake
Restart=always

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$SVC" >/dev/null 2>&1 || true
systemctl --user is-active --quiet "$SVC" || fail "the fake unit didn't start"

# Scoped to the fake folder and this test's own folder, so an unscoped sweep elsewhere (the
# machine may hold other tests' leftovers) can't change what the dry run reports.
echo "== a dry run reports the orphan but removes nothing"
"$STAM" janitor --dry-run --only "$FAKE" --only "$TEST_TMP" >"$TEST_TMP/janitor-dry.out" 2>&1 || fail "janitor --dry-run: $(cat "$TEST_TMP/janitor-dry.out")"
grep -q "would clean daemon $FPID" "$TEST_TMP/janitor-dry.out" || fail "the dry run didn't see the daemon: $(cat "$TEST_TMP/janitor-dry.out")"
grep -q "would clean tmux $FSOCK" "$TEST_TMP/janitor-dry.out" || fail "the dry run didn't see the tmux server"
grep -q "would clean unit $SVC" "$TEST_TMP/janitor-dry.out" || fail "the dry run didn't see the unit"
grep -q "kept $TEST_TMP: test shell $$ is alive" "$TEST_TMP/janitor-dry.out" || fail "the dry run didn't keep the live test folder"
[ -d "$FAKE/fake" ] || fail "the dry run removed the orphan folder"
[ -f "$UNITF" ] || fail "the dry run removed the unit"
kill -0 "$FPID" 2>/dev/null || fail "the dry run stopped the fake daemon"
tmux -L "$FSOCK" has-session -t =orphan 2>/dev/null || fail "the dry run killed the fake tmux server"

# Another daemon's sweep (the live one's every ten minutes, or another test's) is unscoped and
# sees this fresh orphan too; it must keep it, its daemon, tmux server, and unit.
echo "== an unscoped sweep keeps the fresh orphan"
"$STAM" janitor >"$TEST_TMP/janitor-unscoped.out" 2>&1 || fail "janitor (unscoped): $(cat "$TEST_TMP/janitor-unscoped.out")"
grep -q "kept $FAKE: too new" "$TEST_TMP/janitor-unscoped.out" || fail "the unscoped sweep didn't keep the fresh orphan: $(cat "$TEST_TMP/janitor-unscoped.out")"
[ -d "$FAKE/fake" ] || fail "an unscoped sweep removed the fresh orphan folder"
[ -f "$UNITF" ] || fail "an unscoped sweep removed the fresh unit"
kill -0 "$FPID" 2>/dev/null || fail "an unscoped sweep stopped the fake daemon"
tmux -L "$FSOCK" has-session -t =orphan 2>/dev/null || fail "an unscoped sweep killed the fake tmux server"

# Only the daemon holds the registry the sweep's rules read, and a failed call doesn't mean it
# is absent: a timeout, a reset socket, a terminated response, and a refused connection all look
# like one from here. Without that registry an unscoped sweep would treat the fresh orphan's
# owner as gone (S-190), so an unscoped sweep with no daemon to answer must refuse and leave
# everything alone, however the call failed (S-764).
echo "== with no daemon to answer, an unscoped sweep refuses"
CLOSED_URL="http://127.0.0.1:$(free_port)"
RESET_PORT=$(free_port)
RESET_UP="$(mktemp)"
node -e 'require("node:http").createServer((req) => req.socket.destroy()).listen(Number(process.argv[1]), "127.0.0.1", () => console.log("up"))' "$RESET_PORT" >"$RESET_UP" 2>&1 &
RESET_PID=$!
for _i in $(seq 1 40); do [ -s "$RESET_UP" ] && grep -q up "$RESET_UP" && break; sleep 0.25; done
grep -q up "$RESET_UP" || fail "the socket-resetting server didn't start: $(cat "$RESET_UP")"
rm -f "$RESET_UP"
for why in timeout reset refused; do
  case $why in
    timeout) url=$STAM_URL; ms=1 ;;
    reset) url="http://127.0.0.1:$RESET_PORT"; ms=5000 ;;
    refused) url=$CLOSED_URL; ms=5000 ;;
  esac
  if STAM_URL=$url STAM_JANITOR_TIMEOUT_MS=$ms "$STAM" janitor >"$TEST_TMP/janitor-$why.out" 2>&1; then
    fail "an unscoped janitor with no daemon to answer ($why) swept here: $(cat "$TEST_TMP/janitor-$why.out")"
  fi
  grep -q "an unscoped sweep, and the daemon didn't answer" "$TEST_TMP/janitor-$why.out" || fail "the $why refusal didn't name the missing daemon: $(cat "$TEST_TMP/janitor-$why.out")"
done
[ -d "$FAKE/fake" ] || fail "a refused unscoped sweep cleaned the orphan folder here"
[ -f "$UNITF" ] || fail "a refused unscoped sweep removed the unit here"
kill -0 "$FPID" 2>/dev/null || fail "a refused unscoped sweep stopped the fake daemon"
tmux -L "$FSOCK" has-session -t =orphan 2>/dev/null || fail "a refused unscoped sweep killed the fake tmux server"
kill "$RESET_PID" 2>/dev/null
RESET_PID=

# A --only that isn't one test folder is no scope at all: sweep() drops an empty one, /tmp or the
# test base select every test folder there while skipping the freshness rule, a stam-test.* symlink
# to a wider folder takes everything the sweep follows into it, and a path that isn't there has
# nothing to sweep. Dry runs here: a refused connection would otherwise be free to remove other
# tests' folders while proving it.
echo "== with no daemon, a --only that isn't one test folder refuses"
ALIAS_SCOPE="$STAM_TEST_TMPDIR/stam-test.zzalias.$$"
ln -s "$STAM_TEST_TMPDIR" "$ALIAS_SCOPE"
for spec in "empty:--only=" "root:--only /tmp" "base:--only $STAM_TEST_TMPDIR" \
  "symlink:--only $ALIAS_SCOPE" "missing:--only $STAM_TEST_TMPDIR/stam-test.zzmissing.$$"; do
  what=${spec%%:*}
  args=${spec#*:}
  if STAM_URL=$CLOSED_URL STAM_JANITOR_TIMEOUT_MS=5000 "$STAM" janitor --dry-run $args >"$TEST_TMP/janitor-scope-$what.out" 2>&1; then
    fail "a janitor scoped to '$args' with no daemon swept here: $(cat "$TEST_TMP/janitor-scope-$what.out")"
  fi
  grep -q "is not a concrete test folder" "$TEST_TMP/janitor-scope-$what.out" || fail "the '$args' refusal didn't name the scope: $(cat "$TEST_TMP/janitor-scope-$what.out")"
done
rm -f "$ALIAS_SCOPE"
ALIAS_SCOPE=
[ -d "$FAKE/fake" ] || fail "a refused --only sweep cleaned the orphan folder here"
[ -f "$UNITF" ] || fail "a refused --only sweep removed the unit here"
kill -0 "$FPID" 2>/dev/null || fail "a refused --only sweep stopped the fake daemon"
tmux -L "$FSOCK" has-session -t =orphan 2>/dev/null || fail "a refused --only sweep killed the fake tmux server"

# A sweep of the folders it names touches only those, so it needs no registry and runs here.
echo "== with no daemon, a sweep of named folders still runs here"
STAM_URL="$CLOSED_URL" "$STAM" janitor --dry-run --only "$FAKE" >"$TEST_TMP/janitor-scoped.out" 2>&1 || fail "janitor --dry-run --only with no daemon: $(cat "$TEST_TMP/janitor-scoped.out")"
grep -q "would clean daemon $FPID" "$TEST_TMP/janitor-scoped.out" || fail "a scoped sweep with no daemon didn't see the daemon: $(cat "$TEST_TMP/janitor-scoped.out")"
grep -q "would clean unit $SVC" "$TEST_TMP/janitor-scoped.out" || fail "a scoped sweep with no daemon didn't see the unit: $(cat "$TEST_TMP/janitor-scoped.out")"
[ -f "$UNITF" ] || fail "the scoped dry run removed the unit"

# Scoped to the fake folder, so the sweep can't touch another test's leftovers (the
# machine may hold some) while it proves the cleanup.
echo "== the live test's own daemon survives the sweep"
"$STAM" janitor --only "$FAKE" >"$TEST_TMP/janitor.out" 2>&1 || fail "janitor: $(cat "$TEST_TMP/janitor.out")"
grep -q "cleaned daemon $FPID" "$TEST_TMP/janitor.out" || fail "the janitor didn't clean the fake daemon: $(cat "$TEST_TMP/janitor.out")"
"$STAM" daemon status | grep -q "machine: 'main'" || fail "the janitor stopped the live test daemon"

echo "== the orphan, its tmux server, and its unit are gone"
[ ! -e "$FAKE" ] || fail "the orphan folder survived"
curl -sf -m 1 -H "authorization: Bearer $FTOKEN" "http://127.0.0.1:$FPORT/api/health" >/dev/null && fail "the orphan daemon still answers on $FPORT"
tmux -L "$FSOCK" ls >/dev/null 2>&1 && fail "the orphan tmux server still runs"
[ ! -e "$UNITF" ] || fail "the unit file survived"
systemctl --user is-active --quiet "$SVC" && fail "the unit is still active"
systemctl --user is-enabled --quiet "$SVC" && fail "the unit is still enabled"

echo "== the sweep logged a janitor event on the daemon"
node --no-warnings --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; const d = new DatabaseSync(process.argv[1], { readOnly: true }); console.log(d.prepare(\"SELECT count(*) AS c FROM events WHERE type='janitor'\").get().c)" \
  "$STAM_HOME/stam.db" | grep -qx '[1-9][0-9]*' || fail "no janitor event was logged"

echo "== a test killed by SIGTERM leaves nothing behind"
OUT="$TEST_TMP/child.out" # in the test folder, so the EXIT trap removes it on a failure too (S-668)
sh "$(readlink -f "$0")" --child "$OUT" &
CHILD=$!
for _i in $(seq 1 60); do [ -s "$OUT" ] && break; sleep 0.25; done
[ -s "$OUT" ] || fail "the child test didn't start"
{ read -r ctmp; read -r cport; read -r csock; } <"$OUT"
rm -f "$OUT"
kill -s TERM "$CHILD" 2>/dev/null || true
wait "$CHILD" 2>/dev/null || true
for _i in $(seq 1 40); do [ ! -e "$ctmp" ] && break; sleep 0.25; done
[ ! -e "$ctmp" ] || fail "a SIGTERM'd test left its folder $ctmp"
curl -s -m 2 "http://127.0.0.1:$cport/api/health" >/dev/null && fail "a SIGTERM'd test left its daemon on $cport"
tmux -L "$csock" ls >/dev/null 2>&1 && fail "a SIGTERM'd test left its tmux server $csock"

echo "PASS e2e-janitor"
