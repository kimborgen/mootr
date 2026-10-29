package diff

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/config"
	"stam/internal/files"
)

// gitIn runs git in dir for the test, as a fixed author.
func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// repos builds a bare origin with two PRs, and a checkout of it. PR 7 edits, renames, adds a binary and a big text,
// deletes, and touches a credential; main moves on after it branched. PR 8 is merged into main.
func repos(t *testing.T, base string) (checkout string) {
	t.Helper()
	origin, work := filepath.Join(base, "origin.git"), filepath.Join(base, "work")
	must(t, os.MkdirAll(work, 0o755))
	gitIn(t, base, "init", "-q", "--bare", "-b", "main", origin)
	gitIn(t, work, "init", "-q", "-b", "main")
	write(t, filepath.Join(work, "a.txt"), "one\n")
	write(t, filepath.Join(work, ".env"), "S=1\n")
	write(t, filepath.Join(work, "old.txt"), strings.Repeat("old content\n", 20))
	write(t, filepath.Join(work, "docs", "x.md"), "# x\n")
	write(t, filepath.Join(work, "keep.txt"), "keep\n")
	write(t, filepath.Join(work, "secret.pem"), strings.Repeat("-----KEY-----\n", 10))
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "base")
	gitIn(t, work, "remote", "add", "origin", origin)
	gitIn(t, work, "push", "-q", "origin", "main")

	gitIn(t, work, "checkout", "-q", "-b", "pr7")
	write(t, filepath.Join(work, "a.txt"), "one\ntwo\n")
	write(t, filepath.Join(work, ".env"), "S=2\n")
	gitIn(t, work, "mv", "old.txt", "new.txt")
	gitIn(t, work, "mv", "secret.pem", "cert.txt")
	write(t, filepath.Join(work, "test", "t.test.js"), "test()\n")
	write(t, filepath.Join(work, "img.png"), "\x89PNG\r\n\x1a\n\x00\x01\x02")
	write(t, filepath.Join(work, "blob.dat"), "\x00\x01")
	write(t, filepath.Join(work, "big.txt"), strings.Repeat("abcdefghi\n", files.TextCap/10+10))
	gitIn(t, work, "rm", "-q", "keep.txt")
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "pr 7")
	gitIn(t, work, "push", "-q", "origin", "pr7:refs/pull/7/head")

	gitIn(t, work, "checkout", "-q", "main")
	write(t, filepath.Join(work, "z.txt"), "main moved\n")
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "main moves")
	gitIn(t, work, "checkout", "-q", "-b", "pr8")
	write(t, filepath.Join(work, "m.txt"), "merged\n")
	gitIn(t, work, "add", "-A")
	gitIn(t, work, "commit", "-q", "-m", "pr 8")
	gitIn(t, work, "push", "-q", "origin", "pr8:refs/pull/8/head")
	gitIn(t, work, "checkout", "-q", "main")
	gitIn(t, work, "merge", "-q", "--no-ff", "-m", "merge pr 8", "pr8")
	gitIn(t, work, "push", "-q", "origin", "main")
	checkout = filepath.Join(base, "checkout")
	gitIn(t, base, "clone", "-q", origin, checkout)
	return checkout
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

type fileQuery struct {
	Repo string            `json:"repo"`
	PR   int               `json:"pr"`
	Path string            `json:"path"`
	Side string            `json:"side"`
	All  bool              `json:"all"`
	Want map[string]string `json:"want,omitempty"`
}

type served struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// goRefuses are the file queries (path and side, on PR 7, unpinned) where Go deliberately differs from TS
// (docs/migration/README.md), with Go's answer and TS's status: cert.txt is secret.pem renamed, so its content is the
// secret's and the list shows it denied; and Go serves only a path in the PR's list.
var goRefuses = map[string]struct {
	goWant   attempt
	tsStatus int
}{
	"cert.txt head":    {attempt{Status: 403, Message: "not available"}, 200},
	"missing.txt head": {attempt{Status: 404, Message: "missing.txt is not among the files of PR 7"}, 404},
	"docs head":        {attempt{Status: 404, Message: "docs is not among the files of PR 7"}, 400},
	"docs/x.md base":   {attempt{Status: 404, Message: "docs/x.md is not among the files of PR 7"}, 200},
}

type attempt struct {
	Ok      any    `json:"ok"`
	Status  int    `json:"status"`
	Message string `json:"message"`
}

// src/diff.ts compared with Go: its pure parts over a matrix, and a PR's file list and files over the same git repos.
func TestDiffMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/diff.ts")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	checkout := repos(t, base)
	home := filepath.Join(base, "home")
	tsHome, goHome := filepath.Join(base, "ts-stam"), filepath.Join(base, "go-stam")
	settings := `{"itsa":{"repos":{"app":"` + checkout + `"}}}`
	write(t, filepath.Join(tsHome, "settings.json"), settings)
	set, err := config.ParseSettings([]byte(settings), "m")
	must(t, err)
	svc := &Service{Home: goHome, Settings: func() config.Settings { return set }, Repos: func() map[string]string { return map[string]string{"app": checkout} },
		Paths: files.Paths{Home: home, StamHome: goHome}}

	var in struct {
		Match    [][2]string         `json:"match"`
		Classes  map[string][]string `json:"classes"`
		Classify []string            `json:"classify"`
		Parse    [][3]string         `json:"parse"`
		Slug     []string            `json:"slug"`
		Review   [][2]any            `json:"review"`
		List     [][2]any            `json:"list"`
		File     []fileQuery         `json:"file"`
	}
	for _, p := range []string{"test/", "*.md", "docs/", "/src/*.ts", "src/**/x.ts", "*.test.*", "a?c", "", "/", "dir/sub/", "[x].txt", "a.b", "(x)", "**", "**/z", "x+y"} {
		for _, path := range []string{"test/a.js", "src/test/a.js", "contest/a.js", "README.md", "docs/a/b.md", "src/a.ts", "src/a/b.ts", "src/a/b/x.ts", "src/x.ts", "a.test.js", "abc", "a/c",
			"dir/sub/x", "x/dir/sub/y", "[x].txt", "x.txt", "a.b", "axb", "(x)", "z", "q/z", "x+y", "xxy"} {
			in.Match = append(in.Match, [2]string{p, path})
		}
	}
	in.Classes = config.DiffClassDefaults
	in.Classify = []string{"test/a.go", "package-lock.json", "web/package-lock.json", "dist/x.js", "a.min.js", "docs/a.md", "README.md", "src/a.ts", "x.snap", "a/__tests__/b.js", "vendor/x/go.sum", "go.sum"}
	in.Parse = [][3]string{
		{"M\x00a.txt\x00R087\x00old.txt\x00new.txt\x00A\x00img.png\x00D\x00keep.txt\x00", "1\t0\ta.txt\x0017\t2\t\x00old.txt\x00new.txt\x00-\t-\timg.png\x000\t1\tkeep.txt\x00",
			":100644 100644 " + strings.Repeat("a", 40) + " " + strings.Repeat("b", 40) + " M\x00a.txt\x00:100644 100644 " + strings.Repeat("c", 40) + " " + strings.Repeat("d", 40) + " R087\x00old.txt\x00new.txt\x00:000000 100644 " + strings.Repeat("0", 40) + " " + strings.Repeat("e", 40) + " A\x00img.png\x00:100644 000000 " + strings.Repeat("f", 40) + " " + strings.Repeat("0", 40) + " D\x00keep.txt\x00"},
		{"", "", ""},
		{"T\x00x\x00C100\x00a\x00b\x00X\x00y\x00", "x\ty\tx\x00", "garbage\x00"},
	}
	in.Slug = []string{"https://github.com/o/r.git", "https://user@github.com/o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r/", " HTTPS://GitHub.com/O/R.git\n", "https://gitlab.com/o/r", "https://github.com/o", "git@github.com:o/r/x", ""}
	st := func(statuses ...map[string]any) map[string]any {
		return map[string]any{"checksHead": "h1", "headStatuses": statuses}
	}
	rev := func(state, desc, at string) map[string]any {
		return map[string]any{"context": "stam/review", "state": state, "description": desc, "updated_at": at}
	}
	in.Review = [][2]any{
		{nil, "h1"}, {map[string]any{}, "h1"}, {st(), "h1"},
		{st(rev("success", "Review (aw6pg): approve. Looks fine.", "2026-10-26T09:00:00Z")), "h1"},
		{st(rev("success", "Review (aw6pg): approve. Old", "2026-10-26T08:00:00Z"), rev("failure", "Review (b): request_changes. Fix the race\u00a0 ", "2026-10-26T09:00:00Z")), "h2"},
		{st(rev("pending", "Review (x): approve", "2026-10-26T09:00:00Z")), "h1"},
		{st(rev("error", "", ""), map[string]any{"context": "ci", "state": "success"}), "h1"},
		{st(rev("success", "approve "+strings.Repeat("é", 250), "2026-10-26T09:00:00Z")), "h1"},
		{st(map[string]any{"context": "stam/review", "state": "success", "created_at": "c", "updated_at": nil}), "h1"},
	}
	in.List = [][2]any{{"app", 7}, {"app", 8}, {"app", 99}, {"nope", 7}}
	origin := filepath.Join(base, "origin.git")
	pr7, main := gitIn(t, origin, "rev-parse", "refs/pull/7/head"), gitIn(t, origin, "rev-parse", "main")
	for _, q := range []fileQuery{
		{Path: "a.txt", Side: "head"}, {Path: "a.txt", Side: "base"}, {Path: ".env", Side: "head"}, {Path: "missing.txt", Side: "head"}, {Path: "docs", Side: "head"},
		{Path: "img.png", Side: "head"}, {Path: "blob.dat", Side: "head"}, {Path: "new.txt", Side: "base"}, {Path: "new.txt", Side: "head"}, {Path: "big.txt", Side: "head"}, {Path: "big.txt", Side: "head", All: true},
		{Path: "../x", Side: "head"}, {Path: "a//b", Side: "head"}, {Path: "/etc/passwd", Side: "head"}, {Path: "", Side: "head"}, {Path: "docs/x.md", Side: "base"}, {Path: "cert.txt", Side: "head"},
		{Path: "a.txt", Side: "head", Want: map[string]string{"head": strings.Repeat("1", 40), "base": strings.Repeat("2", 40)}},
		// The web view's own ask, pinned to the list's shas: served alike.
		{Path: "a.txt", Side: "base", Want: map[string]string{"head": pr7, "base": main}}, {Path: "new.txt", Side: "head", Want: map[string]string{"head": pr7, "base": main}},
		{Path: "cert.txt", Side: "head", Want: map[string]string{"head": pr7, "base": pr7}},
		{PR: 8, Path: "m.txt", Side: "base"}, {PR: 8, Path: "m.txt", Side: "head"}, {Repo: "nope", Path: "a.txt", Side: "head"},
	} {
		if q.Repo == "" {
			q.Repo = "app"
		}
		if q.PR == 0 {
			q.PR = 7
		}
		in.File = append(in.File, q)
	}

	dir := t.TempDir()
	inFile, outFile := filepath.Join(dir, "in.json"), filepath.Join(dir, "out.json")
	b, _ := json.Marshal(in)
	must(t, os.WriteFile(inFile, b, 0o644))
	cmd := exec.Command("node", "--no-warnings", "testdata/diffref.mjs", inFile, outFile)
	cmd.Env = append(os.Environ(), "HOME="+home, "STAM_HOME="+tsHome, "MOOTR_HOME="+tsHome)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("node: %v\n%s", err, b)
	}
	raw, err := os.ReadFile(outFile)
	must(t, err)
	var ref struct {
		Match    []bool    `json:"match"`
		Classify []*string `json:"classify"`
		Parse    []any     `json:"parse"`
		Slug     []*string `json:"slug"`
		Review   []any     `json:"review"`
		List     []attempt `json:"list"`
		File     []attempt `json:"file"`
	}
	must(t, json.Unmarshal(raw, &ref))
	if len(ref.Match) != len(in.Match) || len(ref.Classify) != len(in.Classify) || len(ref.Parse) != len(in.Parse) || len(ref.Slug) != len(in.Slug) ||
		len(ref.Review) != len(in.Review) || len(ref.List) != len(in.List) || len(ref.File) != len(in.File) {
		t.Fatalf("TS answered another number of cases")
	}
	norm := func(v any) any {
		b, _ := json.Marshal(v)
		var out any
		json.Unmarshal(b, &out)
		return out
	}
	opt := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	for i, c := range in.Match {
		if got := MatchPattern(c[0], c[1]); got != ref.Match[i] {
			t.Errorf("MatchPattern(%q, %q): go %v, ts %v", c[0], c[1], got, ref.Match[i])
		}
	}
	for i, path := range in.Classify {
		if got := opt(Classify(path, in.Classes)); !reflect.DeepEqual(got, ref.Classify[i]) {
			t.Errorf("Classify(%q): go %v, ts %v", path, got, ref.Classify[i])
		}
	}
	for i, c := range in.Parse {
		if got := norm(ParseDiff(c[0], c[1], c[2])); !reflect.DeepEqual(got, ref.Parse[i]) {
			t.Errorf("ParseDiff %d:\n go %v\n ts %v", i, got, ref.Parse[i])
		}
	}
	for i, u := range in.Slug {
		if got := opt(GithubSlug(u)); !reflect.DeepEqual(got, ref.Slug[i]) {
			t.Errorf("GithubSlug(%q): go %v, ts %v", u, got, ref.Slug[i])
		}
	}
	for i, c := range in.Review {
		if got := norm(ReviewOf(norm(c[0]), c[1].(string))); !reflect.DeepEqual(got, ref.Review[i]) {
			t.Errorf("ReviewOf %d:\n go %v\n ts %v", i, got, ref.Review[i])
		}
	}
	ctx := context.Background()
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
	for i, c := range in.List {
		if got := try(svc.List(ctx, c[0].(string), int(c[1].(int)))); !reflect.DeepEqual(got, ref.List[i]) {
			t.Errorf("List(%v):\n go %+v\n ts %+v", c, got, ref.List[i])
		}
	}
	for i, q := range in.File {
		rec := httptest.NewRecorder()
		err := svc.ServeFile(ctx, rec, q.Repo, q.PR, q.Path, q.Side, q.All, q.Want["head"], q.Want["base"])
		var got attempt
		if err != nil {
			got = try(nil, err)
		} else {
			h := map[string]string{}
			for k := range rec.Header() {
				h[strings.ToLower(k)] = rec.Header().Get(k)
			}
			got = attempt{Ok: norm(served{Status: rec.Code, Headers: h, Body: base64.StdEncoding.EncodeToString(rec.Body.Bytes())})}
		}
		// Where Go refuses on purpose what TS serves (docs/migration/README.md), TS's answer is pinned too, so a change on
		// either side shows.
		if want, ok := goRefuses[q.Path+" "+q.Side]; ok && q.PR == 7 && q.Want == nil {
			ts := ref.File[i].Status
			if ref.File[i].Ok != nil {
				ts = 200
			}
			if got != want.goWant || ts != want.tsStatus {
				t.Errorf("ServeFile(%+v): go %+v, want %+v; ts %.200v, want %d", q, got, want.goWant, ref.File[i], want.tsStatus)
			}
			continue
		}
		if q.Path == "cert.txt" && q.Want != nil {
			// head = base = the PR's head would make an empty range: Go refuses a base that isn't main's, where TS serves.
			if got.Status != 404 || ref.File[i].Ok == nil {
				t.Errorf("ServeFile(%+v): go %+v, want 404; ts %.200v, want it served", q, got, ref.File[i])
			}
			continue
		}
		if !reflect.DeepEqual(got, ref.File[i]) {
			t.Errorf("ServeFile(%+v):\n go %.400v\n ts %.400v", q, got, ref.File[i])
		}
	}
}
