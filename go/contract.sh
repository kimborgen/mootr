#!/bin/sh
# The API contract against the Go daemon (S-2614): test/openapi-contract.mjs, which validates every route in
# api/openapi.yaml with ajv, run on go/bin/stamd. Part of the `go` gate (go/check.sh); storage only, where Go is.
#
# The Go daemon can't spawn agents yet, so instead of test/e2e-openapi-contract.sh's two fake Claude Code agents, the
# test home (test/lib.sh with STAM_DAEMON=go) gets a stam.db that src/db.ts builds with the same kinds of rows
# (go/internal/server/testdata/seed.mjs). lib.sh's cleanup stops the daemon by its PID.
set -e
STAM_DAEMON=go
. "$(dirname "$(readlink -f "$0")")/../test/lib.sh"
daemon_home main
use main
node "$ROOT/go/internal/server/testdata/seed.mjs" "$STAM_HOME" || { echo "FAIL go-contract: seed"; exit 1; }
daemon_up main
node "$ROOT/test/openapi-contract.mjs" || { echo "FAIL go-contract"; exit 1; }
echo "PASS go-contract"
