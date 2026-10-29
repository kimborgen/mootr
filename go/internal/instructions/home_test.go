package instructions

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/skills"
	"stam/internal/templates"
)

// testHome is a test STAM_HOME with the TS daemon's empty stam.db, its settings.json, and the Prompts over it.
type testHome struct {
	t                    *testing.T
	ctx                  context.Context
	base, home, userHome string
	db                   *db.DB
	p                    *Prompts
}

func newTestHome(t *testing.T, settings string) *testHome {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not installed")
	}
	base := t.TempDir()
	h := &testHome{t: t, ctx: context.Background(), base: base, home: filepath.Join(base, "home"), userHome: filepath.Join(base, "user")}
	if err := os.Mkdir(h.home, 0o700); err != nil {
		t.Fatal(err)
	}
	// An empty stam.db with the TS daemon's schema, as src/db.ts leaves it.
	if out, err := exec.Command("node", "--no-warnings", "../search/testdata/mkdb.mjs", h.home).CombinedOutput(); err != nil {
		t.Fatalf("mkdb.mjs: %v\n%s", err, out)
	}
	write(t, filepath.Join(h.home, "settings.json"), settings)
	s, err := config.ParseSettings([]byte(settings), "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(h.ctx, filepath.Join(h.home, "stam.db"), db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	h.db = d
	get := func() config.Settings { return s }
	h.p = &Prompts{
		Templates: &templates.Set{Root: repoRoot(t), Home: h.home, UserHome: h.userHome, Settings: get, Machine: "test-machine"},
		DB:        d, Settings: get, Skills: skills.Paths{Home: h.home, UserHome: h.userHome},
	}
	return h
}

func (h *testHome) sql(q string, args ...any) {
	h.t.Helper()
	if err := h.db.Write(h.ctx, func(conn *sqlite.Conn) error { return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args}) }); err != nil {
		h.t.Fatal(err)
	}
}

// agent adds an agent row with the given columns set.
func (h *testHome) agent(id string, cols map[string]any) db.Agent {
	h.t.Helper()
	if _, err := h.db.CreateAgent(h.ctx, db.NewAgent{ID: id, Name: id + "-name", Role: "test", Machine: "test-machine", Harness: "claude", Cwd: h.base}); err != nil {
		h.t.Fatal(err)
	}
	for k, v := range cols {
		h.sql("UPDATE agents SET "+k+" = ? WHERE id = ?", v, id)
	}
	a, err := h.db.GetAgent(h.ctx, id)
	if err != nil {
		h.t.Fatal(err)
	}
	return a
}

// ts runs a reference script (its quoted testdata path, which gate-unit's live-mirror check follows) on this home with input as JSON on stdin, decoding its JSON output into out.
func (h *testHome) ts(script string, input, out any) {
	h.t.Helper()
	in, _ := json.Marshal(input)
	cmd := exec.Command("node", script, h.home, h.userHome)
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	b, err := cmd.Output()
	if err != nil {
		h.t.Fatalf("%s: %v\n%s", script, err, stderr.String())
	}
	if err := json.Unmarshal(b, out); err != nil {
		h.t.Fatalf("%s output: %v", script, err)
	}
}
