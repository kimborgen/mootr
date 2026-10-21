#!/bin/sh
# The UI flows' startup (web/check/daemon.sh) reads a failed web build as a build failure, not as
# "the check daemon didn't start" (S-2162). Each case runs the real startup with a shim on PATH and
# stops before any check: no Chromium, no model, nothing left running.
#   build: `npm run build` fails with a TS error. The FAIL line is the build's, and the error is above it.
#   dies:  the daemon really dies (its `node` exits, and the build is skipped), so the FAIL line still says it didn't start.
set -e
HERE="$(dirname "$(readlink -f "$0")")"
ROOT="$HERE/.."
. "$ROOT/test/tmpdir.sh"
SHIMS="$(mktemp -d "$STAM_TEST_TMPDIR/stam-build-shims.XXXXXX")"
trap 'rm -rf "$SHIMS"' EXIT
mkdir -p "$SHIMS/build" "$SHIMS/dies"
cat >"$SHIMS/build/npm" <<'SH'
#!/bin/sh
echo "src/App.tsx(3,5): error TS18046: 't' is of type 'unknown'." >&2
exit 2
SH
cat >"$SHIMS/dies/node" <<'SH'
#!/bin/sh
exit 1
SH
chmod +x "$SHIMS/build/npm" "$SHIMS/dies/node"
fail() { echo "FAIL: $1"; exit 1; }
# startup DIR FLOW SKIP_BUILD: runs FLOW's startup with DIR's shim first on PATH. Sets out (its output) and rc (its status).
# web/check/run.sh takes a check name and skips the test-slot wait.
startup() {
  rc=0
  if [ "$2" = web/check/run.sh ]; then
    out=$(env PATH="$1:$PATH" SKIP_BUILD="$3" STAM_TEST_NOSLOT=1 sh "$ROOT/$2" phone 2>&1) || rc=$?
  else
    out=$(env PATH="$1:$PATH" SKIP_BUILD="$3" sh "$ROOT/$2" 2>&1) || rc=$?
  fi
}
FLOWS="test/e2e-ui.sh test/e2e-ui-assistant.sh web/check/run.sh"

for flow in $FLOWS; do
  startup "$SHIMS/build" "$flow" ""
  [ "$rc" != 0 ] || fail "$flow: a failed build exited 0"
  last=$(printf '%s\n' "$out" | tail -n 1)
  [ "$last" = "FAIL: the web build failed (see the error above)" ] || fail "$flow: last line is '$last'"
  printf '%s\n' "$out" | sed '$d' | grep -q "error TS18046" || fail "$flow: the TS error isn't above the FAIL line"
  echo "build, $flow: PASS"
done

for flow in $FLOWS; do
  startup "$SHIMS/dies" "$flow" 1
  [ "$rc" != 0 ] || fail "$flow: a daemon that died exited 0"
  last=$(printf '%s\n' "$out" | tail -n 1)
  [ "$last" = "FAIL: the check daemon didn't start" ] || fail "$flow: last line is '$last'"
  echo "dies, $flow: PASS"
done
echo "PASS: ui-build"
