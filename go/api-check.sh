#!/bin/sh
# Fails when go/internal/api/api.gen.go is stale against api/openapi.yaml (S-2388), or when the generator
# fails. Part of the `go` gate (go/check.sh); storage only, where Go is installed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
PATH="$HOME/.local/go/bin:$PATH"
export PATH
cd "$here/.."
node scripts/api-gen.mjs --go --check
