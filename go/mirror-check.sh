#!/bin/sh
# The go-mirror gate (S-3286): every Go test, on storage, through test/remote.sh, for a PR that changes a src/ module the Go daemon
# mirrors (scripts/go-mirror.mjs) and doesn't already select the `go` gate. A Go test can read a TS fixture whatever its name (the db
# tests read the one make-fixture.mjs builds, the server tests seed through seed.mjs), so the run is all of them, not only the *MatchesTS.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
PATH="$HOME/.local/go/bin:$PATH"
export PATH
cd "$here"
# -count=1: the parity tests run src/ through node, and the test cache doesn't see a change there.
go test -count=1 ./...
