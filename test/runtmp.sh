# A run's own temporary folder (S-2586), so test scratch never fills the machine's shared /tmp.
# Source it, then call runtmp_make ROOT: when the caller set no TMPDIR it makes ROOT/.tmp/r.XXXXXX, exports it
# as TMPDIR (Chromium, vitest, node's os.tmpdir() and mktemp all follow it) and sets RUNTMP_OWNED to it.
# The caller that sees RUNTMP_OWNED set removes the folder when it ends. An explicit TMPDIR, or one a
# parent run already made, is kept as is and never removed, so a nested run can't delete its parent's folder.
# The folder is short on purpose: a unix socket path inside it must stay under 108 bytes.
runtmp_make() {
  RUNTMP_OWNED=
  [ -z "$TMPDIR" ] || return 0
  mkdir -p "$1/.tmp" 2>/dev/null || return 0
  d=$(mktemp -d "$1/.tmp/r.XXXXXX" 2>/dev/null) || return 0
  TMPDIR=$d; export TMPDIR
  RUNTMP_OWNED=$d
}
