package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	// Fixed dates make the same commits the same head wherever they are made (the TS replay reads this repository too).
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2026-10-21T00:00:00Z", "GIT_COMMITTER_DATE=2026-10-21T00:00:00Z")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// branchRepo is a repository with main and a branch `feat` that changes one Go file and one doc.
func branchRepo(t *testing.T) (dir, head string) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	gitIn(t, dir, "init", "-q", "-b", "main")
	must(t, os.MkdirAll(filepath.Join(dir, "docs"), 0o755))
	writeFile(t, filepath.Join(dir, "a.go"), "package a\n")
	writeFile(t, filepath.Join(dir, "docs", "x.md"), "# x\n")
	gitIn(t, dir, "add", ".")
	gitIn(t, dir, "commit", "-q", "-m", "base")
	gitIn(t, dir, "checkout", "-q", "-b", "feat")
	writeFile(t, filepath.Join(dir, "a.go"), "package a\n// REQ:R-1=violates\n")
	writeFile(t, filepath.Join(dir, "docs", "x.md"), "# x\nREQ:R-2=violates\n")
	gitIn(t, dir, "commit", "-q", "-am", "feat")
	return dir, gitIn(t, dir, "rev-parse", "feat")
}

func (f *fixture) verdictsByKey() string {
	return jsfmt.Compact(dumpTyped(f.t, f, "SELECT r.key, v.verdict, v.subject FROM req_verdicts v JOIN requirements r ON r.id = v.req_id ORDER BY r.key"))
}

// An ITSA that moves to ready_to_merge has each linked branch's diff checked against main: a requirement reads only the files
// its path globs match, one that matches none is not asked, and a branch that can't be read is skipped.
func TestRequirementsBranchCheckAtReadyToMerge(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	repo, head := branchRepo(t)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true},"itsa":{"ownerNotices":"off","repos":{"r":"`+repo+`"}}}`)
	f.reqCreate(`{"title":"Go","verification":["decision"],"scope":{"paths":["**/*.go"]},"status":"in_force"}`)
	f.reqCreate(`{"title":"Docs","verification":["decision"],"scope":{"paths":["docs/**"]},"status":"in_force"}`)
	f.reqCreate(`{"title":"Rust","verification":["decision"],"scope":{"paths":["**/*.rs"]},"status":"in_force"}`)
	key := f.createItsa(`{"title":"Alpha","owner":"child"}`)
	until(t, "the create checks", func() bool { return f.count("SELECT count(*) FROM req_verdicts WHERE subject LIKE 'itsa:%'") == 0 })
	f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url, meta) SELECT id, 1, 'branch', 'feat', '', '{\"repo\":\"r\"}' FROM itsas WHERE key = ?", key)
	f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url, meta) SELECT id, 2, 'branch', 'gone', '', '{\"repo\":\"r\"}' FROM itsas WHERE key = ?", key)
	f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url, meta) SELECT id, 3, 'branch', 'feat', '', '{\"repo\":\"nope\"}' FROM itsas WHERE key = ?", key)
	if rec := f.post2("PATCH", "/api/itsas/"+key, `{"status":"ready_to_merge"}`); rec.Code != 200 {
		t.Fatalf("move: %d %s", rec.Code, rec.Body.String())
	}
	subject := "branch:r/feat@" + head
	until(t, "the branch verdicts", func() bool { return f.count("SELECT count(*) FROM req_verdicts WHERE subject = ?", subject) == 2 })
	want := `[{"key":"R-1","verdict":"violates","subject":"` + subject + `"},{"key":"R-2","verdict":"violates","subject":"` + subject + `"}]`
	if got := f.verdictsByKey(); !strings.Contains(got, want[1:len(want)-1]) {
		t.Errorf("verdicts:\n got %s\nwant %s", got, want)
	}
	// Each read only its files: the Go requirement is not condemned by the marker in the doc, and not the other way round.
	f.sql("DELETE FROM req_verdicts")
	writeFile(t, filepath.Join(repo, "a.go"), "package a\n// fine\n")
	gitIn(t, repo, "commit", "-q", "-am", "clean go")
	rec := f.post2("POST", "/api/requirements/check", `{"subject":"branch:r/feat"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"key":"R-1","verdict":"conforms"`) || !strings.Contains(rec.Body.String(), `"key":"R-2","verdict":"violates"`) || strings.Contains(rec.Body.String(), "R-3") {
		t.Errorf("manual branch check: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/requirements/check", `{"subject":"branch:r/zzz"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "can't read the diff of zzz in r") {
		t.Errorf("unknown branch: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/requirements/check", `{"subject":"branch:oops"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "a branch subject is branch:REPO/NAME") {
		t.Errorf("malformed ref: %d %s", rec.Code, rec.Body.String())
	}
}

// The diff is split per file and read in full: renames and several files keep their own text.
func TestSplitDiff(t *testing.T) {
	out := "diff --git a/a.go b/a.go\nindex 1..2\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\n"
	files := splitDiff(out)
	if len(files) != 2 || files[0].Path != "a.go" || files[1].Path != "new name.txt" || !strings.HasSuffix(files[0].Text, "+y\n") || !strings.HasPrefix(files[1].Text, "diff --git a/old name.txt") {
		t.Errorf("files: %+v", files)
	}
	if got := splitDiff(""); got == nil || len(got) != 0 {
		t.Errorf("empty diff: %#v", got)
	}
}

// A preview runs one requirement, in any status, on the last real subjects of its scope: it records no verdict, tells nobody and
// costs under decide:req:preview.
func TestRequirementsPreview(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), reqSettings)
	n := &notices{}
	f.srv.noticeHook = n.add
	key := f.reqCreate(`{"title":"Plainly","verification":["decision"],"scope":{"subjects":["mail"]},"mode":"enforce","status":"draft"}`)
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"first","body":"fine"}`)
	f.mailAs(agentTok, `{"to":["aboss"],"subject":"second","body":"REQ:R-2=violates"}`)
	third := f.mailAs(agentTok, `{"to":["aboss"],"subject":"third","body":"fine too"}`)
	rec := f.post2("POST", "/api/requirements/"+key+"/preview", `{"n":2}`)
	if rec.Code != 200 {
		t.Fatalf("preview: %d %s", rec.Code, rec.Body.String())
	}
	v := f.body(rec)
	rows, _ := v.Get("rows")
	if v.Text("key") != key || jsfmt.Compact(mustGet(v, "n")) != "2" || len(rows.Items) != 2 {
		t.Fatalf("preview: %s", rec.Body.String())
	}
	if rows.Items[0].Text("subject") != "mail:"+third || rows.Items[0].Text("summary") != "third" || rows.Items[0].Text("verdict") != "conforms" {
		t.Errorf("newest first: %s", jsfmt.Compact(rows.Items[0]))
	}
	if w, _ := rows.Items[1].Get("would_act"); w.Kind != jsfmt.Bool || w.Bool {
		t.Errorf("would_act of the conforming: %s", jsfmt.Compact(rows.Items[1]))
	}
	if f.verdictCount() != 0 || len(n.all()) != 0 {
		t.Errorf("a preview recorded %d verdicts and told %d", f.verdictCount(), len(n.all()))
	}
	if c := f.count("SELECT count(*) FROM events WHERE type = 'decide' AND data LIKE '%decide:req:preview%'"); c == 0 {
		t.Errorf("no preview spend recorded")
	}
	// The second mail carries the marker for R-2: that requirement would act on it.
	f.reqCreate(`{"title":"Second","verification":["decision"],"scope":{"subjects":["mail"]},"mode":"enforce","status":"draft"}`)
	rec = f.post2("POST", "/api/requirements/R-2/preview", `{"n":3}`)
	if !strings.Contains(rec.Body.String(), `"verdict":"violates"`) || !strings.Contains(rec.Body.String(), `"would_act":true`) {
		t.Errorf("a violating subject: %d %s", rec.Code, rec.Body.String())
	}
	// No subject in scope, no decision method, an unknown requirement, and the bounds of n.
	f.reqCreate(`{"title":"Branches","verification":["decision"],"scope":{"subjects":["branch"]},"status":"draft"}`)
	if rec := f.post2("POST", "/api/requirements/R-3/preview", `{}`); rec.Code != 200 || rec.Body.String() != `{"key":"R-3","n":20,"rows":[],"note":"no recent subject in the scope of R-3"}` {
		t.Errorf("no subject: %d %s", rec.Code, rec.Body.String())
	}
	f.reqCreate(`{"title":"By test","verification":["test"],"status":"draft"}`)
	if rec := f.post2("POST", "/api/requirements/R-4/preview", `{"n":999}`); rec.Code != 200 || rec.Body.String() != `{"key":"R-4","n":50,"rows":[],"note":"R-4 has no decision method, so there is nothing a model would check"}` {
		t.Errorf("no decision method: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/requirements/R-9/preview", `{}`); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no requirement R-9") {
		t.Errorf("unknown: %d %s", rec.Code, rec.Body.String())
	}
}

// An external event is checked after it is stored, and nobody is told.
func TestRequirementsCheckEvent(t *testing.T) {
	startDecideStub(t)
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), reqSettings)
	n := &notices{}
	f.srv.noticeHook = n.add
	f.reqCreate(`{"title":"Events","verification":["decision"],"scope":{"subjects":["event"],"sources":["github"],"types":["pull_request.*"]},"mode":"enforce","status":"in_force"}`)
	f.srv.checkEvent(context.Background(), extEvent{id: 7, source: "github", typ: "pull_request.opened", subjects: []string{"acme/widgets#1"}, actor: "someone", hasActor: true, summary: "REQ:R-1=violates", payload: jsjson.NewObject("number", 1.0)})
	f.srv.checkEvent(context.Background(), extEvent{id: 8, source: "linear", typ: "issue.created", summary: "x"})
	if got := f.verdictOf("event:7"); got != `[{"verdict":"violates","action":"notified"}]` {
		t.Errorf("verdict: %s", got)
	}
	if f.verdictCount() != 1 || len(n.all()) != 0 {
		t.Errorf("verdicts %d, notices %v", f.verdictCount(), n.all())
	}
}

func mustGet(v jsfmt.Value, k string) jsfmt.Value {
	x, _ := v.Get(k)
	return x
}

// The checkout the daemon runs from is a repo with no setting for it (src/default-repo.ts derivedRepos): a branch link names it, its
// diff is read, and a setting by the same name wins.
func TestDerivedRepo(t *testing.T) {
	f := newFixture(t, nil)
	repo, head := branchRepo(t)
	f.srv.tpl.Root = repo
	name := filepath.Base(repo)
	if got := f.srv.repos(); len(got) != 1 || got[name] != repo {
		t.Fatalf("derived: %v", got)
	}
	d := f.srv.branchDiff(context.Background(), name, "feat")
	if d == nil || d.head != head || len(d.files) != 2 {
		t.Fatalf("diff of the derived repo: %+v", d)
	}
	link := func(repo string) (any, error) {
		l, err := jsfmt.Parse([]byte(`{"system":"branch","external_id":"feat","repo":"` + repo + `"}`))
		must(t, err)
		return f.srv.validateLink(l)
	}
	if _, err := link(name); err != nil {
		t.Errorf("link to the derived repo: %v", err)
	}
	if _, err := link("ghost"); err == nil || !strings.Contains(err.Error(), "unknown repo ghost: add it to settings.itsa.repos") {
		t.Errorf("link to an unknown repo: %v", err)
	}
	other := t.TempDir()
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"itsa":{"repos":{"`+name+`":"`+other+`"}}}`)
	if got := f.srv.repos(); got[name] != other {
		t.Errorf("a setting wins: %v", got)
	}
}
