#!/bin/sh
# The Go gate's checks (the `go` token in docs/pull-requests.md, S-2242): build, vet and test go/, then the API contract
# against go/bin/stamd (go/contract.sh, S-2614).
# It runs on storage only, through test/remote.sh, where Go is installed under ~/.local/go.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
PATH="$HOME/.local/go/bin:$PATH"
export PATH
sh "$here/build.sh"
sh "$here/api-check.sh"
cd "$here"
# A test package that runs TS code through node needs the stub embedder (embedder_test.go), or src/ installs the real one into
# the test's temp dir, hundreds of megabytes that outlive it (S-2926).
missing=$(for d in $(grep -rlE '"node"|\.mjs"|src/cli\.ts|"npx"|tsx' --include='*_test.go' . | xargs -r -n1 dirname | sort -u); do [ -f "$d/embedder_test.go" ] || echo "$d"; done)
if [ -n "$missing" ]; then
  echo "go test packages that run node without embedder_test.go (S-2926):" >&2
  echo "$missing" >&2
  exit 1
fi
go vet ./...
# -count=1: the TS-parity tests run src/ through node, and the test cache doesn't see a change there.
# -timeout 20m: go test's default is 10 minutes a package, and internal/lifecycle came near it under load (S-4392). A net
# for a slow machine; the fix is the package's own speed.
go test -count=1 -timeout 20m ./...
sh "$here/contract.sh"
