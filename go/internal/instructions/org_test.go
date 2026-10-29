package instructions

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/skills"
	"stam/internal/templates"
)

// The org parts against src/org.ts (testdata/orgref.mjs on the same home): each agent's orgRest, typeSegments,
// typePrompt, orgPrompt and managerCostPrompt, then costPrompt, reviewerProcessPrompt and typeSkillsBlock, in four
// homes: the shipped registry with no chief of staff; a chief of staff, cost instructions, process.run on and a
// registry of reviewer types with a fallback cycle, a ring and skills; a type template override that hides the memory
// block's split and a default reviewer that isn't one; and a malformed reviewer entry, which empties the reviewer
// process.

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

type orgCase struct {
	name, settings, registry string
	// override is a STAM_HOME/templates type-MEM.md text, "" for none.
	override string
}

type orgAgent struct {
	Rest     string    `json:"rest"`
	Segments []Segment `json:"segments"`
	Type     string    `json:"type"`
	Org      string    `json:"org"`
	Cost     string    `json:"cost"`
	Children []string  `json:"children"`
}

type orgOut struct {
	Agents   map[string]orgAgent `json:"agents"`
	Cost     string              `json:"cost"`
	Reviewer string              `json:"reviewer"`
	Skills   struct {
		Text    string   `json:"text"`
		Missing []string `json:"missing"`
	} `json:"skills"`
}

var skillNames = []string{"s-one", "s-missing", "s-one", "s-long", "s-empty", "s-spaces"}

func TestOrgPartsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not installed")
	}
	checkout := repoRoot(t)
	before := listDir(t, filepath.Join(checkout, "blocks"))
	// A type whose template is built from blocks with a memory block (S-888): the checkout ships none, so the test adds
	// one under a name of its own, in an isolated copy of the checkout that both Go and TS read, so no other package
	// running at the same time sees it in the shared blocks/.
	root := isolatedRoot(t, checkout)
	memDir, err := os.MkdirTemp(filepath.Join(root, "blocks"), "type-orgref-")
	if err != nil {
		t.Fatal(err)
	}
	if after := listDir(t, filepath.Join(checkout, "blocks")); !reflect.DeepEqual(after, before) {
		t.Fatalf("the fixture changed the checkout's blocks/: %q, was %q", after, before)
	}
	t.Cleanup(func() {
		if after := listDir(t, filepath.Join(checkout, "blocks")); !reflect.DeepEqual(after, before) {
			t.Errorf("the checkout's blocks/ changed during the test: %q, was %q", after, before)
		}
	})
	mem := strings.TrimPrefix(filepath.Base(memDir), "type-")
	write(t, filepath.Join(memDir, "10-body.md"), "---\nid: "+mem+"-body\ntitle: Body\nsummary: s\nscope: type:"+mem+"\nkind: process\nsummary_of: x\n---\n## Your type: {{type}}\n\nYou are {{name}}. {{merge}}\n")
	write(t, filepath.Join(memDir, "99-memory.md"), "---\nid: "+mem+"-memory\ntitle: Before you start\nsummary: s\nscope: type:"+mem+"\nkind: memory\nsummary_of: x\n---\n## Before you start\n\nNotes for {{name}} the {{type}}{{unknown}}.\n")

	reviewers := `"rev-a":{"description":"Reviews things.","harness":"codex","model":"gpt-6.1-sol","effort":"low","review":{"fallback":"rev-b"}},` +
		`"rev-b":{"description":"Backup","harness":"claude","model":"claude-opus-5-5","review":{"fallback":"rev-a"}},` +
		`"rev-c":{"harness":"opencode","review":{"fallback":"rev-gone"}},` +
		`"rev-ring":{"description":"A ring.","harness":"","review":{"ring":{"format":"rounds","members":["rev-a","rev-b"],"maxRounds":3}}},` +
		`"rev-plain":{"description":"No harness","review":{"fallback":null}}`
	types := `"skilled":{"description":"d","harness":"claude","skills":["s-one","s-missing","s-long"]},` +
		`"` + mem + `":{"description":"d","harness":"claude","skills":["s-one"]}`
	cases := []orgCase{
		{name: "shipped", settings: `{}`, registry: `{"types":{` + types + `}}`},
		{name: "cos", settings: `{"chiefOfStaff":"chief","cost":{"instructions":"  keep it cheap\n"},"process":{"run":"on"}}`,
			registry: `{"defaultReviewer":"rev-a","types":{` + reviewers + `,` + types + `}}`},
		{name: "override", settings: `{"chiefOfStaff":"gone"}`, registry: `{"defaultReviewer":"skilled","types":{` + reviewers + `,` + types + `}}`,
			override: "Overridden for {{name}}.\n\n## Before you start\n\nNotes for {{name}} the {{type}}."},
		{name: "malformed", settings: `{"chiefOfStaff":"chief"}`,
			registry: `{"defaultReviewer":"rev-a","types":{` + reviewers + `,"rev-bad":{"description":7,"review":{}},` + types + `}}`},
		{name: "ring-members", settings: `{}`,
			registry: `{"defaultReviewer":"rev-a","types":{` + reviewers + `,"rev-ring2":{"review":{"ring":{"format":"fire","members":"rev-a","maxRounds":2}}},` + types + `}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { runOrgCase(t, root, mem, c) })
	}
}

func runOrgCase(t *testing.T, root, mem string, c orgCase) {
	ctx := context.Background()
	base := t.TempDir()
	home, userHome := filepath.Join(base, "home"), filepath.Join(base, "user")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	// An empty stam.db with the TS daemon's schema, as src/db.ts leaves it.
	if out, err := exec.Command("node", "--no-warnings", "../search/testdata/mkdb.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("mkdb.mjs: %v\n%s", err, out)
	}
	write(t, filepath.Join(home, "settings.json"), c.settings)
	write(t, filepath.Join(home, "registry.json"), c.registry)
	if c.override != "" {
		write(t, filepath.Join(home, "templates", "type-"+mem+".md"), c.override)
	}
	write(t, filepath.Join(home, "skills", "s-one", "SKILL.md"), "---\nname: s-one\ndescription: >\n  One skill,\n  folded.\n---\nbody\n")
	write(t, filepath.Join(userHome, ".claude", "skills", "s-one", "SKILL.md"), "---\ndescription: the user's own\n---\n")
	write(t, filepath.Join(userHome, ".claude", "skills", "s-long", "SKILL.md"), "---\ndescription: \""+strings.Repeat("long  words ", 30)+"\"\n---\n")
	write(t, filepath.Join(userHome, ".claude", "skills", "s-empty", "SKILL.md"), "no frontmatter\n")
	// JavaScript's \s holds NBSP, U+2028, VT and the rest of Unicode's whitespace.
	write(t, filepath.Join(userHome, ".claude", "skills", "s-spaces", "SKILL.md"), "---\ndescription: tab\there\u00a0\u00a0nbsp\u2028ls\vvt\u3000end\u00a0\n---\n")

	d, err := db.Open(ctx, filepath.Join(home, "stam.db"), db.Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	sql := func(q string, args ...any) {
		t.Helper()
		if err := d.Write(ctx, func(conn *sqlite.Conn) error { return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args}) }); err != nil {
			t.Fatal(err)
		}
	}
	agents := []struct {
		id, typ, parent, kind, visibility, lifecycle string
	}{
		{"chief", "", "", "", "", "active"},
		{"mgr", "manager", "", "", "", "active"},
		{"dev1", "developer", "mgr", "", `{"reach":"tree"}`, "active"},
		{"dev2", "skilled", "mgr", "", `{"reach":"parent","siblings":false}`, "paused"},
		{"coord", "coordinator", "", "", "", "active"},
		{"asst", "", "", "assistant", "not json", "active"},
		{"memo", mem, "", "", "", "active"},
		{"ghost", "nosuch", "", "", "", "active"},
		{"lone", "", "", "", "", "archived"},
		{"gone", "", "", "", "", "archived"},
	}
	var ids []string
	for _, a := range agents {
		var parent *string
		if a.parent != "" {
			parent = &a.parent
		}
		if _, err := d.CreateAgent(ctx, db.NewAgent{ID: a.id, Name: a.id + "-name", Role: "test", Machine: "test-machine", Harness: "claude", Cwd: base, ParentID: parent}); err != nil {
			t.Fatal(err)
		}
		sql("UPDATE agents SET lifecycle = ?, type = ?, kind = ?, visibility = ? WHERE id = ?", a.lifecycle, nullable(a.typ), nullable(a.kind), nullable(a.visibility), a.id)
		ids = append(ids, a.id)
	}
	// dev2 has a second, adopting parent; lone was adopted by an agent that is no longer in the registry; mgr has a
	// child on a peer, and coord only a peer child.
	sql("INSERT INTO agent_parents (child_id, parent_id) VALUES ('dev2', 'coord')")
	sql("INSERT INTO agent_parents (child_id, parent_id) VALUES ('lone', 'vanished')")
	sql("INSERT INTO peer_agents (id, name, machine, updated_at, parents) VALUES ('p1', 'peer-one', 'peer1', '2026-01-01T00:00:00Z', '[\"mgr\",\"coord\"]')")
	// dev1 is also remembered as a peer agent under mgr: childrenOf counts it once.
	sql("INSERT INTO peer_agents (id, name, machine, updated_at, parents) VALUES ('dev1', 'dev1-name', 'peer1', '2026-01-01T00:00:00Z', '[\"mgr\"]')")

	settingsBytes, _ := os.ReadFile(filepath.Join(home, "settings.json"))
	s, err := config.ParseSettings(settingsBytes, "test-machine")
	if err != nil {
		t.Fatal(err)
	}
	get := func() config.Settings { return s }
	p := &Prompts{
		Templates: &templates.Set{Root: root, Home: home, UserHome: userHome, Settings: get, Machine: "test-machine"},
		DB:        d, Settings: get, Skills: skills.Paths{Home: home, UserHome: userHome},
	}
	got := orgOut{Agents: map[string]orgAgent{}, Cost: p.CostPrompt(), Reviewer: p.ReviewerProcessPrompt()}
	var names []any
	for _, n := range skillNames {
		names = append(names, n)
	}
	got.Skills.Text, got.Skills.Missing = p.TypeSkillsBlock(names)
	for _, id := range ids {
		a, err := d.GetAgent(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		var o orgAgent
		if o.Rest, err = p.OrgRest(ctx, a); err != nil {
			t.Fatal(err)
		}
		if o.Segments, err = p.TypeSegments(a); err != nil {
			t.Fatal(err)
		}
		if o.Type, err = p.TypePrompt(a); err != nil {
			t.Fatal(err)
		}
		if o.Org, err = p.OrgPrompt(ctx, a); err != nil {
			t.Fatal(err)
		}
		if o.Cost, err = p.ManagerCostPrompt(ctx, a); err != nil {
			t.Fatal(err)
		}
		if o.Children, err = p.childrenOf(ctx, id); err != nil {
			t.Fatal(err)
		}
		got.Agents[id] = o
	}

	in, _ := json.Marshal(map[string]any{"agents": ids, "skills": skillNames})
	cmd := exec.Command("node", "testdata/orgref.mjs", home, userHome, root)
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("orgref.mjs: %v\n%s", err, stderr.String())
	}
	var want orgOut
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatalf("orgref.mjs output: %v", err)
	}
	for _, id := range ids {
		g, w := got.Agents[id], want.Agents[id]
		if !reflect.DeepEqual(nonNil(g.Segments), nonNil(w.Segments)) {
			t.Errorf("%s typeSegments:\n  go %q\n  ts %q", id, g.Segments, w.Segments)
		}
		g.Segments, w.Segments = nil, nil
		g.Children, w.Children = nonNil(g.Children), nonNil(w.Children)
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s:\n--- go\n%+v\n--- ts\n%+v", id, g, w)
		}
	}
	if got.Cost != want.Cost {
		t.Errorf("costPrompt:\n  go %q\n  ts %q", got.Cost, want.Cost)
	}
	if got.Reviewer != want.Reviewer {
		t.Errorf("reviewerProcessPrompt:\n--- go\n%s\n--- ts\n%s", got.Reviewer, want.Reviewer)
	}
	if got.Skills.Text != want.Skills.Text || !reflect.DeepEqual(nonNil(got.Skills.Missing), nonNil(want.Skills.Missing)) {
		t.Errorf("typeSkillsBlock:\n--- go\n%s %q\n--- ts\n%s %q", got.Skills.Text, got.Skills.Missing, want.Skills.Text, want.Skills.Missing)
	}
	// A child both local and remembered on a peer counts once, as src/tree.ts childrenOf's Set does.
	if kids := got.Agents["mgr"].Children; !reflect.DeepEqual(kids, []string{"dev1", "dev2", "p1"}) {
		t.Errorf("childrenOf(mgr) = %q, want dev1, dev2, p1", kids)
	}
	// The fixture reaches the branches it is for.
	checks := map[string]bool{
		"a memory segment":         c.override != "" || len(got.Agents["memo"].Segments) == 3 && got.Agents["memo"].Segments[2].Key == "memory",
		"a skills segment":         len(got.Agents["dev2"].Segments) == 1 && got.Agents["dev2"].Segments[0].Key == "skills",
		"a reviewer process":       c.name != "cos" || strings.Contains(got.Reviewer, "rev-ring"),
		"an empty reviewer prompt": (c.name != "malformed" && c.name != "ring-members") || got.Reviewer == "",
	}
	for what, ok := range checks {
		if !ok {
			t.Errorf("%s: fixture misses %s", c.name, what)
		}
	}
}

// isolatedRoot is a copy of the checkout for a test that adds files to it: src/ is hard-linked file by file (copied
// where links fail), because Node resolves a symlinked module to its real path and so to the checkout's own ROOT;
// blocks/ is a real folder of symlinks to the checkout's blocks, for the test to add its own; every other top-level
// entry is a symlink. Go and TS read the copy, and the checkout is never written.
func isolatedRoot(t *testing.T, checkout string) string {
	t.Helper()
	root := t.TempDir()
	entries, err := os.ReadDir(checkout)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		src, dst := filepath.Join(checkout, e.Name()), filepath.Join(root, e.Name())
		switch e.Name() {
		case ".git", ".tmp":
		case "src":
			linkTree(t, src, dst)
		case "blocks":
			if err := os.Mkdir(dst, 0o700); err != nil {
				t.Fatal(err)
			}
			for _, b := range listDir(t, src) {
				if err := os.Symlink(filepath.Join(src, b), filepath.Join(dst, b)); err != nil {
					t.Fatal(err)
				}
			}
		default:
			if err := os.Symlink(src, dst); err != nil {
				t.Fatal(err)
			}
		}
	}
	return root
}

// linkTree recreates the tree at src under dst, each file a hard link, or a copy where a link fails.
func linkTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if os.Link(path, target) == nil {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o600)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// listDir is the names in a folder, sorted.
func listDir(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
