#!/bin/sh
# Builds stamd and stam into go/bin/ (gitignored). Uses ~/.local/go/bin/go when go isn't on PATH.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if command -v go >/dev/null 2>&1; then
  GO=go
else
  GO="$HOME/.local/go/bin/go"
fi
cd "$here"
mkdir -p bin
"$GO" build -o bin/stamd ./cmd/stamd
"$GO" build -o bin/stam ./cmd/stam
