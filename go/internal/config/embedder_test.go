package config

import (
	"os"

	"stam/internal/testenv"
)

// testdata/patchref.mjs imports src/, whose daemon installs the local embedder under STAM_HOME on first need; the stub
// installs nothing (S-2926).
func init() {
	testenv.Scrub()
	os.Setenv("STAM_EMBEDDER", "stub")
}
