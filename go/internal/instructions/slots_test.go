package instructions

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/jsfmt"
)

// The ITSA, workspace and requirements slots against TS: "testdata/slotsref.mjs" runs src/itsa-owners.ts,
// src/workspace-prompt.ts, src/workspace-share.ts and src/requirements.ts on the same home: itsaPrompt (owned
// and participated ITSAs in open, closed and unknown statuses, a participation left, the fields, who changes the
// columns), workspacePrompt (an indexed folder shared with live, archived and forwarded agents; folders shared with an
// agent by their holder, by a named granter and by one no longer in the registry; neither), grantedPaths, the
// requirements prompt on and off, and the workspace index with a tight cap.

type slotsAgent struct {
	Itsa      string   `json:"itsa"`
	Workspace string   `json:"workspace"`
	Granted   []string `json:"granted"`
}

type slotsOut struct {
	Agents       map[string]slotsAgent `json:"agents"`
	Requirements string                `json:"requirements"`
	Index        []string              `json:"index"`
}

func TestSlotsMatchTS(t *testing.T) {
	for _, c := range []struct{ name, settings string }{
		{"plain", `{}`},
		{"full", `{"chiefOfStaff":"chief","requirements":{"enabled":true}}`},
		{"chief-by-name", `{"chiefOfStaff":"chief-name"}`},
	} {
		t.Run(c.name, func(t *testing.T) { runSlots(t, c.name, c.settings) })
	}
}

func runSlots(t *testing.T, name, settings string) {
	h := newTestHome(t, settings)
	ws := filepath.Join(h.base, "ws")
	write(t, filepath.Join(ws, "a.md"), "\n  # Notes  \nmore\n")
	write(t, filepath.Join(ws, "sub", "b.txt"), strings.Repeat("é", 300)+"\n")
	write(t, filepath.Join(ws, "sub", "deep", "c.bin"), "\x00\x01binary")
	write(t, filepath.Join(ws, "Z.md"), "")
	write(t, filepath.Join(ws, ".hidden"), "secret\n")
	// A name outside the BMP sorts by UTF-16 code units (a surrogate before U+FF5E), and a first line that isn't UTF-8
	// is left out.
	write(t, filepath.Join(ws, "\U0001F600.md"), "smile\n")
	write(t, filepath.Join(ws, "\uFF5E.md"), "tilde\n")
	write(t, filepath.Join(ws, "latin1.txt"), "caf\xe9 au lait\n")
	// A directory past the entry cap, read in more than one batch, and a chain deeper than the depth limit.
	big := filepath.Join(h.base, "big")
	for i := range indexMaxEntries + walkBatch + 7 {
		write(t, filepath.Join(big, "many", fmt.Sprintf("f%04d.txt", i)), "")
	}
	deep := filepath.Join(h.base, "deep")
	for d, dir := 0, deep; d <= indexMaxDepth+2; d, dir = d+1, filepath.Join(dir, fmt.Sprintf("d%d", d)) {
		write(t, filepath.Join(dir, fmt.Sprintf("at%d.md", d)), fmt.Sprintf("depth %d\n", d))
	}
	if err := os.Symlink("/etc/hostname", filepath.Join(ws, "link")); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(h.base, "other")

	h.agent("chief", map[string]any{"lifecycle": "active"})
	h.agent("owner", map[string]any{"lifecycle": "active"})
	h.agent("ws", map[string]any{"lifecycle": "active", "personal_workspace": ws})
	h.agent("g1", map[string]any{"lifecycle": "active"})
	h.agent("g2", map[string]any{"lifecycle": "archived"})
	h.agent("fwd", map[string]any{"lifecycle": "active", "forwarded_to": "g1"})
	h.agent("bare", map[string]any{"lifecycle": "active"})
	for _, g := range []struct{ path, grantee, access, by string }{
		{ws, "g1", "write", "ws"}, {ws, "g2", "read", "ws"}, {ws, "fwd", "read", "ws"},
		{other, "g1", "read", "chief"}, {filepath.Join(h.base, "gone"), "g1", "read", "vanished"},
	} {
		h.sql("INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')", g.path, g.grantee, g.access, g.by)
	}
	if name != "plain" {
		for i, it := range []struct{ id, key, title, status, owner string }{
			{"i1", "S-1", `Open "one"`, "in_progress", "owner"},
			{"i2", "S-2", "Closed", "done", "owner"},
			{"i3", "S-3", "Odd", "weird", "owner"},
			{"i4", "S-4", "Theirs", "todo", "chief"},
			{"i5", "S-5", "Left", "todo", "chief"},
		} {
			at := "2026-01-0" + string(rune('1'+i)) + "T00:00:00Z"
			h.sql("INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at) VALUES (?, ?, 'issue', ?, ?, ?, 'human', ?, ?)", it.id, it.key, it.title, it.status, it.owner, at, at)
		}
		h.sql("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('i1', 'owner'), ('i4', 'owner'), ('i2', 'owner')")
		h.sql("INSERT INTO itsa_participants (itsa_id, agent_id, left_at) VALUES ('i5', 'owner', '2026-01-09T00:00:00Z')")
		for i, f := range []struct{ id, key, label, typ, options, description, kinds string }{
			{"f1", "stage", "Stage", "choice", `[{"value":"plan","label":"Plan"},{"value":"code"},{"label":"no value"}]`, "Which step.", ""},
			{"f2", "notes", "Notes", "text", "", "", `["issue","project"]`},
		} {
			h.sql("INSERT INTO itsa_fields (id, key, label, type, options, description, width, align, card, position, created_by, created_at, updated_at, kinds) VALUES (?, ?, ?, ?, ?, ?, 'm', 'left', 'hide', ?, 'human', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)",
				f.id, f.key, f.label, f.typ, nullable(f.options), nullable(f.description), i, nullable(f.kinds))
		}
	}
	ids := []string{"chief", "owner", "ws", "g1", "fwd", "bare"}
	indexes := []struct {
		Path string `json:"path"`
		Max  int    `json:"max"`
	}{{ws, WorkspaceIndexMaxChars}, {ws, 40}, {ws, 5}, {other, 100}, {big, 1 << 20}, {deep, 1 << 20}}

	got := slotsOut{Agents: map[string]slotsAgent{}}
	var err error
	if got.Requirements, err = h.p.RequirementsPrompt(); err != nil {
		t.Fatal(err)
	}
	for _, x := range indexes {
		got.Index = append(got.Index, WorkspaceIndex(x.Path, x.Max))
	}
	for _, id := range ids {
		a, err := h.db.GetAgent(h.ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		var o slotsAgent
		if o.Itsa, err = h.p.ItsaPrompt(h.ctx, id); err != nil {
			t.Fatal(err)
		}
		if o.Workspace, err = h.p.WorkspacePrompt(h.ctx, a); err != nil {
			t.Fatal(err)
		}
		if o.Granted, err = h.p.GrantedPaths(h.ctx, id); err != nil {
			t.Fatal(err)
		}
		got.Agents[id] = o
	}
	var want slotsOut
	h.ts("testdata/slotsref.mjs", map[string]any{"agents": ids, "index": indexes}, &want)
	for _, id := range ids {
		g, w := got.Agents[id], want.Agents[id]
		g.Granted, w.Granted = nonNil(g.Granted), nonNil(w.Granted)
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s:\n--- go\n%+v\n--- ts\n%+v", id, g, w)
		}
	}
	if got.Requirements != want.Requirements {
		t.Errorf("requirements:\n--- go\n%s\n--- ts\n%s", got.Requirements, want.Requirements)
	}
	if !reflect.DeepEqual(got.Index, want.Index) {
		t.Errorf("index:\n--- go\n%.2000q\n--- ts\n%.2000q", got.Index, want.Index)
	}
	// The fixture reaches the caps: 500 files from the big folder, none below the depth limit.
	if n := strings.Count(got.Index[4], "\n") + 1; n != indexMaxEntries {
		t.Errorf("the big folder's index has %d lines, want %d", n, indexMaxEntries)
	}
	if !strings.Contains(got.Index[5], fmt.Sprintf("at%d.md", indexMaxDepth)) || strings.Contains(got.Index[5], fmt.Sprintf("at%d.md", indexMaxDepth+1)) {
		t.Errorf("the deep folder's index misses the depth limit:\n%s", got.Index[5])
	}
	if i, j := strings.Index(got.Index[0], "\U0001F600"), strings.Index(got.Index[0], "\uFF5E"); i < 0 || j < 0 || i > j || strings.Contains(got.Index[0], "caf") {
		t.Errorf("the ws index misses its UTF-16 order or keeps a non-UTF-8 line:\n%s", got.Index[0])
	}
	if name == "full" && (!strings.Contains(got.Agents["owner"].Itsa, "You participate in these ITSAs: S-4") || got.Requirements == "" || !strings.Contains(got.Agents["owner"].Itsa, "(plan | code | )")) {
		t.Errorf("full: the fixture misses its ITSA lines, fields or requirements:\n%s", got.Agents["owner"].Itsa)
	}
}

// Off the home, the ITSA slot is the lines Load last read from the home; a failed list drops them and a failed field
// or chief-of-staff read keeps the last good value.
func TestItsaSlotOffHome(t *testing.T) {
	h := newTestHome(t, `{"chiefOfStaff":"local-cos"}`)
	h.agent("a1", map[string]any{"lifecycle": "active"})
	h.p.IsHome = func() bool { return false }
	h.p.Home = &HomeItsas{}
	parse := func(s string) jsfmt.Value {
		v, err := jsfmt.Parse([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	answers := map[string]string{
		"/api/itsas?owner=a1":       `[{"key":"S-7","title":"Mine","status":"in_progress","owner":"a1"},{"key":"S-8","title":"Done","status":"done","owner":"a1"}]`,
		"/api/itsas?participant=a1": `[{"key":"S-7","title":"Mine","status":"in_progress","owner":"a1"},{"key":"S-9","title":"Theirs","status":"todo","owner":"x"}]`,
		"/api/itsas/fields":         `[{"key":"stage","label":"Stage","type":"text"}]`,
		"/api/chief-of-staff":       `{"setting":"home-cos"}`,
	}
	failing := map[string]bool{}
	get := func(_ context.Context, path string) (jsfmt.Value, error) {
		if failing[path] {
			return jsfmt.Value{}, errors.New("home down")
		}
		return parse(answers[path]), nil
	}
	h.p.Load(h.ctx, "a1", get)
	text, err := h.p.ItsaPrompt(h.ctx, "a1")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`You own these ITSAs: S-7 "Mine" (in_progress).`, `You participate in these ITSAs: S-9 "Theirs" (todo).`, "- `stage` · Stage · text", "@home-cos"} {
		if !strings.Contains(text, want) {
			t.Errorf("off-home slot lacks %q:\n%s", want, text)
		}
	}
	failing["/api/itsas?owner=a1"], failing["/api/itsas/fields"], failing["/api/chief-of-staff"] = true, true, true
	h.p.Load(h.ctx, "a1", get)
	if text, err = h.p.ItsaPrompt(h.ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "S-7") || strings.Contains(text, "S-9") || !strings.Contains(text, "- `stage`") || !strings.Contains(text, "@home-cos") {
		t.Errorf("after a failed load the lines stay or the fields and chief of staff are lost:\n%s", text)
	}
}

// Load's four reads from the home are in flight at once, as TS's Promise.all: each answers only once all four arrived,
// which reads one after another never reach.
func TestItsaSlotLoadsAtOnce(t *testing.T) {
	h := newTestHome(t, `{}`)
	h.agent("a1", map[string]any{"lifecycle": "active"})
	h.p.IsHome = func() bool { return false }
	h.p.Home = &HomeItsas{}
	var mu sync.Mutex
	arrived := 0
	all := make(chan struct{})
	get := func(ctx context.Context, path string) (jsfmt.Value, error) {
		mu.Lock()
		if arrived++; arrived == 4 {
			close(all)
		}
		mu.Unlock()
		select {
		case <-all:
		case <-time.After(5 * time.Second):
			return jsfmt.Value{}, errors.New("the other reads never came")
		}
		body := `{"setting":"home-cos"}`
		switch {
		case strings.HasPrefix(path, "/api/itsas?"):
			body = `[{"key":"S-1","title":"T","status":"todo","owner":"a1"}]`
		case path == "/api/itsas/fields":
			body = `[{"key":"stage","label":"Stage","type":"text"}]`
		}
		return jsfmt.Parse([]byte(body))
	}
	h.p.Load(h.ctx, "a1", get)
	text, err := h.p.ItsaPrompt(h.ctx, "a1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, `You own these ITSAs: S-1 "T" (todo).`) || !strings.Contains(text, "- `stage`") || !strings.Contains(text, "@home-cos") {
		t.Errorf("a read failed waiting for the others:\n%s", text)
	}
}

// Load, the slot's reads and Forget at once, off the home: run with -race, they never touch the cache unlocked.
func TestItsaSlotConcurrent(t *testing.T) {
	h := newTestHome(t, `{}`)
	h.agent("a1", map[string]any{"lifecycle": "active"})
	h.p.IsHome = func() bool { return false }
	h.p.Home = &HomeItsas{}
	get := func(_ context.Context, path string) (jsfmt.Value, error) {
		v, _ := jsfmt.Parse([]byte(map[string]string{
			"/api/itsas/fields": `[{"key":"stage","label":"Stage","type":"text"}]`, "/api/chief-of-staff": `{"setting":"cos"}`,
		}[path] + ""))
		if strings.HasPrefix(path, "/api/itsas?") {
			v, _ = jsfmt.Parse([]byte(`[{"key":"S-1","title":"T","status":"todo","owner":"a1"}]`))
		}
		return v, nil
	}
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				switch i % 3 {
				case 0:
					h.p.Load(h.ctx, "a1", get)
				case 1:
					if _, err := h.p.ItsaPrompt(h.ctx, "a1"); err != nil {
						t.Error(err)
						return
					}
				default:
					h.p.Home.Forget("a1")
				}
			}
		}()
	}
	wg.Wait()
}

// countingDir records each ReadDir call walk makes: the batch it asked for and how many entries came back.
type countingDir struct {
	dirReader
	calls *[][2]int
}

func (c countingDir) ReadDir(n int) ([]os.DirEntry, error) {
	es, err := c.dirReader.ReadDir(n)
	*c.calls = append(*c.calls, [2]int{n, len(es)})
	return es, err
}

// The walk reads a big directory in positive batches and asks for nothing more once the entry cap is met, as TS reads
// entry by entry: a whole-directory ReadDir(-1) fails this.
func TestWalkStopsReadingAtCap(t *testing.T) {
	dir := t.TempDir()
	for i := range 3 * indexMaxEntries {
		write(t, filepath.Join(dir, fmt.Sprintf("f%04d", i)), "")
	}
	var calls [][2]int
	orig := openDir
	openDir = func(path string) (dirReader, error) {
		d, err := orig(path)
		if err != nil {
			return nil, err
		}
		return countingDir{d, &calls}, nil
	}
	t.Cleanup(func() { openDir = orig })
	var out []string
	walk(dir, "", 0, &out)
	if len(out) != indexMaxEntries {
		t.Fatalf("walk listed %d files, want %d", len(out), indexMaxEntries)
	}
	read := 0
	for i, c := range calls {
		if c[0] <= 0 {
			t.Fatalf("ReadDir(%d): not a positive batch", c[0])
		}
		if read >= indexMaxEntries {
			t.Fatalf("ReadDir call %d after the cap was met (%d entries read): %v", i+1, read, calls)
		}
		read += c[1]
	}
	if read >= 3*indexMaxEntries {
		t.Errorf("the walk read the whole directory (%d entries)", read)
	}
}
