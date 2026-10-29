#!/bin/sh
# Builds stamd and stam into go/bin/ (gitignored). Uses ~/.local/go/bin/go when go isn't on PATH.
# Each binary is built to a temp file in go/bin/ and renamed into place (S-4076), so a run building at the same
# time, or a daemon starting from go/bin/stamd, never sees a half-written binary, and a failed build keeps the old one.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if command -v go >/dev/null 2>&1; then
  GO=go
else
  GO="$HOME/.local/go/bin/go"
fi
cd "$here"
mkdir -p bin
trap 'rm -f bin/.stamd.$$ bin/.stam.$$' EXIT
# A shell killed by a signal it doesn't handle skips the EXIT trap: exit instead, so a cancelled run leaves no temp.
trap 'exit 1' HUP INT TERM
"$GO" build -o bin/.stamd.$$ ./cmd/stamd
"$GO" build -o bin/.stam.$$ ./cmd/stam
mv -f bin/.stamd.$$ bin/stamd
mv -f bin/.stam.$$ bin/stam
