package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/search"
)

// The local embedder's install, as src/embed.ts pins it: `installed` is true only when its marker names these.
const (
	localVersion  = "4.3.1"
	localRevision = "751bff37182d3f1213fa05d7196b954e230abad9"
)

// embedder is src/cli.ts `stam embedder [status|install]`. It runs here, not on the daemon: the status reads the db.
// `install` (an npm run of transformers.js for the TS daemon's local model) is not ported.
func embedder(ctx context.Context, args []string, e env) error {
	if len(args) > 0 && args[0] != "status" {
		if args[0] == "install" {
			return errors.New("embedder install is not ported to the Go CLI yet")
		}
		return errors.New("usage: stam embedder [status|install]")
	}
	cfg, err := config.Load(e.getenv)
	if err != nil {
		return err
	}
	settings := config.NewSettingsFile(cfg.Home, cfg.Machine).Get()
	env := e.getenv("MOOTR_EMBEDDER")
	if env == "" {
		env = e.getenv("STAM_EMBEDDER")
	}
	p := search.ProviderOf(env, settings.SearchOff)
	model := p.Model()
	d, err := db.Open(ctx, cfg.DBPath(), db.Options{Readers: 1})
	if err != nil {
		return err
	}
	defer d.Close()
	counts, err := d.EmbeddingCounts(ctx)
	if err != nil {
		return err
	}
	var indexed []string
	for _, c := range counts {
		if c.Model == model {
			indexed = append(indexed, fmt.Sprintf("%s: %d", c.Source, c.N))
		}
	}
	state, dim := string(p), 0
	switch p {
	case search.Stub:
		dim = search.StubDim
	case search.Local:
		// The model runs only in the TS daemon: the Go daemon searches by keyword whatever the install's state.
		dim, state = search.LocalDim, "missing (the Go daemon searches by keyword)"
		if localInstalled(cfg.Home) {
			state = "installed (the Go daemon searches by keyword)"
		}
	}
	line := "provider: " + string(p)
	if model != "" {
		line += " (" + model
		if dim > 0 {
			line += fmt.Sprintf(", %d dims", dim)
		}
		line += ")"
	}
	fmt.Fprintln(e.stdout, line)
	fmt.Fprintln(e.stdout, "state: "+state)
	if len(indexed) == 0 {
		fmt.Fprintln(e.stdout, "indexed: nothing yet")
	} else {
		fmt.Fprintln(e.stdout, "indexed: "+strings.Join(indexed, ", "))
	}
	return nil
}

// localInstalled is src/embed.ts installed: the install's marker names the pinned package and model, and the package is
// there.
func localInstalled(home string) bool {
	dir := filepath.Join(home, "embedder")
	raw, err := os.ReadFile(filepath.Join(dir, "installed.json"))
	if err != nil {
		return false
	}
	var m struct{ Version, Model, Revision string }
	if json.Unmarshal(raw, &m) != nil || m.Version != localVersion || m.Model != search.LocalModel || m.Revision != localRevision {
		return false
	}
	_, err = os.Stat(filepath.Join(dir, "node_modules", "@huggingface", "transformers", "package.json"))
	return err == nil
}
