# opencode_bin_guard: refuses (prints FAIL, returns 1) a STAM_OPENCODE_BIN that would run the real OpenCode outside a
# smoke test (S-4237, S-107). test/lib.sh sources this file and runs the guard when it is sourced and before every daemon
# start, the Go daemon's included.
#
# The value is resolved before it is judged: a bare name through PATH (`command -v`), then every link (`readlink -f`).
# It is the real binary when that path is one of the real ones, resolved the same way: ~/.opencode/bin/opencode, and
# `opencode` on PATH. STAM_TEST_REAL_OPENCODE stands in for the first in the guard's own test (test/opencode-guard.test.mjs),
# which never runs either. A value that can't be resolved, or is empty, is refused: the guard fails closed. A file that
# isn't there runs nothing, so it passes, unless its path is one of the real ones. A MOOTR_OPENCODE_BIN is judged too, since
# a reader takes it before the STAM_ name (src/env.ts, Go's BinPath). The daemons judge the binary once more themselves
# (src/test-env.ts realOpencodeRefusal), so a launcher that skips this file still can't run the real one in a test home.
opencode_bin_guard() {
  [ -n "$STAM_TEST_SMOKE" ] && return 0
  if [ -z "$STAM_OPENCODE_BIN" ]; then
    echo "FAIL: STAM_OPENCODE_BIN is empty, so a test daemon would run the real opencode; only --smoke tests may" >&2
    return 1
  fi
  _ocg_judge STAM_OPENCODE_BIN "$STAM_OPENCODE_BIN" || return 1
  [ -z "$MOOTR_OPENCODE_BIN" ] || _ocg_judge MOOTR_OPENCODE_BIN "$MOOTR_OPENCODE_BIN"
}

# _ocg_judge NAME VALUE: refuses VALUE, NAME's value, when it is or may be the real opencode.
_ocg_judge() {
  _ocg_name=$1
  _ocg_bin=$2
  case "$_ocg_bin" in
    */*) _ocg_path=$_ocg_bin ;;
    *)
      _ocg_path=$(command -v "$_ocg_bin" 2>/dev/null) || _ocg_path=""
      case "$_ocg_path" in
        /*) ;;
        *)
          echo "FAIL: $_ocg_name ($_ocg_bin) isn't a path and isn't found on PATH, so the guard can't tell it from the real opencode" >&2
          return 1 ;;
      esac ;;
  esac
  _ocg_real=$(readlink -f -- "$_ocg_path" 2>/dev/null) || _ocg_real=""
  if [ -z "$_ocg_real" ]; then
    echo "FAIL: $_ocg_name ($_ocg_bin) doesn't resolve, so the guard can't tell it from the real opencode" >&2
    return 1
  fi
  _ocg_ifs=$IFS
  IFS='
'
  for _ocg_r in "${STAM_TEST_REAL_OPENCODE:-$HOME/.opencode/bin/opencode}" $(command -v opencode 2>/dev/null); do
    IFS=$_ocg_ifs
    [ -n "$_ocg_r" ] || continue
    _ocg_rr=$(readlink -f -- "$_ocg_r" 2>/dev/null) || _ocg_rr=$_ocg_r
    if [ "$_ocg_real" = "$_ocg_rr" ] || [ "$_ocg_path" = "$_ocg_r" ]; then
      echo "FAIL: $_ocg_name ($_ocg_bin) is the real opencode ($_ocg_rr); only --smoke tests may run it" >&2
      return 1
    fi
  done
  IFS=$_ocg_ifs
  return 0
}
