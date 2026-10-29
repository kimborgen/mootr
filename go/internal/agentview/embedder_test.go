package agentview

import (
	"os"

	"stam/internal/testenv"
)

// A test that runs TS code (node) must not let src/ install the local embedder into its temp dir: the detached npm outlives the
// test and leaves hundreds of megabytes behind (S-2926). The stub embedder installs nothing, as test/lib.sh sets it.
func init() {
	testenv.Scrub()
	os.Setenv("STAM_EMBEDDER", "stub")
}
