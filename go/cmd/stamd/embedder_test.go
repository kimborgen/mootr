package main

import (
	"os"

	"stam/internal/testenv"
)

// The reference scripts import src/, whose daemon installs the local embedder under STAM_HOME in the background on first
// need: a detached npm that outlives the script and is still writing node_modules when the test's temp dir is removed,
// which leaves it behind (hundreds of megabytes in /tmp, S-2926). The stub embedder installs nothing, as test/lib.sh sets it.
func init() {
	// The test binary re-runs as stamd (main_test.go) with the env its test built for it: scrub only in the parent.
	if os.Getenv("STAMD_TEST_RUN_MAIN") != "1" {
		testenv.Scrub()
	}
	os.Setenv("STAM_EMBEDDER", "stub")
}
