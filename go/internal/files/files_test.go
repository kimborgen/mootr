package files

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

// tree builds a home folder with stam's home inside it, credentials, a project, and links in and out of the roots.
func tree(t *testing.T) (Paths, string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(base, "home")
	stam := filepath.Join(home, "stamhome")
	repo := filepath.Join(home, "projects", "repo")
	file := func(p, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	link := func(target, p string) {
		t.Helper()
		if err := os.Symlink(target, p); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []string{"a.txt", ".env", ".env.local", "key.pem", "tls.KEY", "id_rsa", "id_ed25519.pub", ".bash_history", ".history", ".netrc", ".git-credentials",
		"notes.md", "B.txt", "_x", "-y", "10.txt", "9.txt", "Äpfel.txt", "a-b", "a_b", "a.b", "zeta", "Zeta", "été", "ß"} {
		file(filepath.Join(repo, n), "x")
	}
	file(filepath.Join(repo, "sub", "deep.go"), "package deep")
	file(filepath.Join(repo, ".ssh", "config"), "Host x")
	file(filepath.Join(home, ".claude", "settings.json"), "{}")
	file(filepath.Join(home, ".claude-work", "x"), "x")
	file(filepath.Join(home, ".config", "gh", "hosts.yml"), "x")
	file(filepath.Join(home, ".config", "other.txt"), "x")
	file(filepath.Join(home, ".aws", "credentials"), "x")
	file(filepath.Join(home, ".npmrc"), "x")
	file(filepath.Join(stam, "token"), "secret")
	file(filepath.Join(stam, "attachments", "m1", "a.png"), "png")
	file(filepath.Join(stam, "worktrees", "w", ".env"), "x")
	file(filepath.Join(stam, "worktrees", "w", "b.go"), "package b")
	file(filepath.Join(base, "outside", "secret.txt"), "x")
	link(filepath.Join(base, "outside"), filepath.Join(repo, "out"))
	link(filepath.Join(stam, "token"), filepath.Join(repo, "tok"))
	link("../../.aws/credentials", filepath.Join(repo, "innocent"))
	link(filepath.Join(stam, "worktrees", "w", "b.go"), filepath.Join(repo, "wt.go"))
	link("loop", filepath.Join(repo, "loop"))
	link("missing", filepath.Join(repo, "broken"))
	link("sub", filepath.Join(repo, "subdir"))
	link(".env", filepath.Join(repo, "harmless.txt"))
	return Paths{Home: home, StamHome: stam}, base
}

// The path rules of src/files.ts (the deny list, the roots, resolving a path, a listing and a type) compared with TS over
// one tree: every escape through `..` or a symlink, and every credential the deny list names.
func TestPathsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/files.ts")
	}
	p, base := tree(t)
	home, stam := p.Home, p.StamHome
	repo := filepath.Join(home, "projects", "repo")
	checkout, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	var in struct {
		Denied  []string   `json:"denied"`
		Roots   [][]string `json:"roots"`
		Allowed []string   `json:"allowed"`
		Resolve []string   `json:"resolve"`
		List    []string   `json:"list"`
		Types   []string   `json:"types"`
	}
	entries, err := os.ReadDir(repo)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		in.Denied = append(in.Denied, filepath.Join(repo, e.Name()))
	}
	in.Denied = append(in.Denied, filepath.Join(repo, ".ssh", "config"), filepath.Join(home, ".claude", "settings.json"), filepath.Join(home, ".CLAUDE-work", "x"),
		filepath.Join(home, ".config", "gh"), filepath.Join(home, ".config", "gh", "hosts.yml"), filepath.Join(home, ".config", "ghost"), filepath.Join(home, ".config", "other.txt"),
		filepath.Join(home, ".aws"), filepath.Join(home, ".npmrc"), filepath.Join(home, ".npmrc.bak"), stam, filepath.Join(stam, "token"), filepath.Join(stam, "attachments", "m1", "a.png"),
		filepath.Join(stam, "worktrees", "w", ".env"), filepath.Join(stam, "worktrees", "w", "b.go"), filepath.Join(stam, "attachmentsX"), home, "/", "")
	in.Roots = [][]string{nil, {}, {"~/projects"}, {"~/projects", filepath.Join(home, "projects"), "~/projects/"}, {"~"}, {base}, {filepath.Join(home, "nope")},
		{filepath.Join(repo, "subdir"), filepath.Join(repo, "sub")}, {"~/projects/repo/../repo"}}
	in.Allowed = []string{filepath.Join(home, "projects"), filepath.Join(stam, "attachments"), filepath.Join(stam, "worktrees")}
	in.Resolve = []string{filepath.Join(repo, "a.txt"), repo, filepath.Join(repo, "out", "secret.txt"), filepath.Join(repo, "..", "..", "..", "outside", "secret.txt"),
		filepath.Join(base, "outside", "secret.txt"), filepath.Join(repo, ".env"), filepath.Join(repo, "tok"), filepath.Join(repo, "innocent"), filepath.Join(repo, "harmless.txt"), filepath.Join(repo, "wt.go"),
		filepath.Join(repo, "loop"), filepath.Join(repo, "broken"), filepath.Join(repo, "missing"), filepath.Join(repo, "subdir", "deep.go"), "~/projects/repo/a.txt",
		"projects/repo/a.txt", "~", "~nobody/x", filepath.Join(stam, "worktrees", "w", "b.go"), filepath.Join(stam, "worktrees", "w", ".env"), filepath.Join(stam, "token"),
		filepath.Join(stam, "attachments", "m1", "a.png"), repo + "/./sub/../a.txt", ""}
	in.List = []string{repo, filepath.Join(repo, "sub"), filepath.Join(repo, "a.txt"), filepath.Join(stam, "worktrees", "w")}
	in.Types = []string{"a.PNG", "b.jpeg", "c.md", "d.yml", "e.yaml", "f", "Makefile", "g.tar.gz", "h.mov", "i.MJS", ".env", "j.", "k.diff", "l.webp", "m.bin"}
	dir := t.TempDir()
	inFile, outFile := filepath.Join(dir, "in.json"), filepath.Join(dir, "out.json")
	b, _ := json.Marshal(in)
	if err := os.WriteFile(inFile, b, 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--no-warnings", "testdata/filesref.mjs", inFile, outFile)
	cmd.Env = append(os.Environ(), "HOME="+home, "STAM_HOME="+stam)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("node: %v\n%s", err, b)
	}
	raw, err := os.ReadFile(outFile)
	if err != nil {
		t.Fatal(err)
	}
	type attempt struct {
		Ok      any    `json:"ok"`
		Status  int    `json:"status"`
		Message string `json:"message"`
	}
	var ref struct {
		Denied  []bool     `json:"denied"`
		Roots   [][]string `json:"roots"`
		Resolve []attempt  `json:"resolve"`
		List    []attempt  `json:"list"`
		Types   []string   `json:"types"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	if len(ref.Denied) != len(in.Denied) || len(ref.Roots) != len(in.Roots) || len(ref.Resolve) != len(in.Resolve) || len(ref.List) != len(in.List) || len(ref.Types) != len(in.Types) {
		t.Fatalf("TS answered %d/%d/%d/%d/%d cases", len(ref.Denied), len(ref.Roots), len(ref.Resolve), len(ref.List), len(ref.Types))
	}
	// A value as TS's JSON has it.
	norm := func(v any) any {
		b, _ := json.Marshal(v)
		var out any
		json.Unmarshal(b, &out)
		return out
	}
	try := func(v any, err error) attempt {
		if err != nil {
			e, ok := AsError(err)
			if !ok {
				t.Fatalf("not a refusal: %v", err)
			}
			return attempt{Status: e.Status, Message: e.Message}
		}
		return attempt{Ok: norm(v)}
	}
	for i, path := range in.Denied {
		if got := p.Denied(path); got != ref.Denied[i] {
			t.Errorf("Denied(%q): go %v, ts %v", path, got, ref.Denied[i])
		}
	}
	for i, c := range in.Roots {
		if got := p.RealRoots(c, checkout); !reflect.DeepEqual(got, ref.Roots[i]) {
			t.Errorf("RealRoots(%q):\n go %q\n ts %q", c, got, ref.Roots[i])
		}
	}
	for i, path := range in.Resolve {
		got := try(p.ResolveIn(path, in.Allowed))
		if !reflect.DeepEqual(got, ref.Resolve[i]) {
			t.Errorf("ResolveIn(%q):\n go %+v\n ts %+v", path, got, ref.Resolve[i])
		}
	}
	for i, path := range in.List {
		got := try(p.ListDir(path, in.Allowed))
		if !reflect.DeepEqual(got, ref.List[i]) {
			t.Errorf("ListDir(%q):\n go %+v\n ts %+v", path, got, ref.List[i])
		}
	}
	for i, n := range in.Types {
		if got := TypeByExt(n); got != ref.Types[i] {
			t.Errorf("TypeByExt(%q): go %q, ts %q", n, got, ref.Types[i])
		}
	}
}
