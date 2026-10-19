# Where tests keep their temporary folders: test/lib.sh, test/run.sh, web/check/run.sh, and the
# test/e2e-ui*.sh wrappers. Source it; it sets STAM_TEST_TMPDIR and creates the folder.
# STAM_TEST_TMPDIR when set. Otherwise /tmp, unless /tmp is a tmpfs (RAM), then
# ${XDG_CACHE_HOME:-$HOME/.cache}/stam-test, so a machine with a small tmpfs keeps test files on disk.
if [ -z "$STAM_TEST_TMPDIR" ]; then
  if [ "$(stat -f -c %T /tmp 2>/dev/null)" = tmpfs ]; then
    STAM_TEST_TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/stam-test"
  else
    STAM_TEST_TMPDIR=/tmp
  fi
fi
mkdir -p "$STAM_TEST_TMPDIR" || exit 1
export STAM_TEST_TMPDIR
