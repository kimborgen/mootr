package skills

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"stam/internal/jsjson"
)

// gitOut is git's trimmed output in dir.
func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// importFixture is an importer that imported each named skill from one local repository's skills folder.
func importFixture(t *testing.T, names ...string) (*Importer, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	repo := filepath.Join(t.TempDir(), "repo")
	for _, n := range names {
		if err := os.MkdirAll(filepath.Join(repo, "skills", n), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, "skills", n, "SKILL.md"), []byte(skillMD(n, "Do it.")), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git(t, repo, "init", "-q")
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-qm", "first")
	im := NewImporter(Paths{Home: t.TempDir(), UserHome: t.TempDir(), Agents: filepath.Join(t.TempDir(), "agents")}, true)
	for _, n := range names {
		if _, err := im.Import(context.Background(), "file://"+repo+"#skills/"+n); err != nil {
			t.Fatal(err)
		}
	}
	return im, repo
}

// TestCheckSeenUnderImportLock: src/skill-import.ts checkUpdate remembers a seen head with a compare and a write of
// origin.json that no update can land between (Node runs both with no await between). The Go check holds the import
// lock across both, so an update that comes between them waits, and the newer origin.json it writes stays.
func TestCheckSeenUnderImportLock(t *testing.T) {
	im, repo := importFixture(t, "tidy")
	ctx := context.Background()
	// The origin moves outside the folder, so the check remembers the new head as seen.
	must(t, os.WriteFile(filepath.Join(repo, "README"), []byte("x"), 0o644))
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-qm", "second")
	oldTree, _ := field(im.OriginOf("tidy"), "tree")
	updated := false
	im.beforeSeen = func() {
		// Between the compare and the write, the folder moves at the origin and an update fetches it, if it can.
		must(t, os.WriteFile(filepath.Join(repo, "skills", "tidy", "SKILL.md"), []byte(skillMD("tidy", "Tidy more.")), 0o644))
		git(t, repo, "add", "-A")
		git(t, repo, "commit", "-qm", "third")
		if im.serial.TryLock() {
			im.serial.Unlock()
			updated = true
			if _, err := im.Update(ctx, "tidy"); err != nil {
				t.Errorf("the update: %v", err)
			}
		}
	}
	if res := im.checkNow(ctx, "tidy", im.OriginOf("tidy")); res == nil {
		t.Fatal("no check result")
	}
	im.beforeSeen = nil
	if !updated {
		// The update waited for the check's lock; it runs now.
		if _, err := im.Update(ctx, "tidy"); err != nil {
			t.Fatal(err)
		}
	}
	cur := im.OriginOf("tidy")
	commit, _ := field(cur, "commit")
	tree, _ := field(cur, "tree")
	if head := gitOut(t, repo, "rev-parse", "HEAD"); commit != head || tree == oldTree {
		t.Errorf("origin.json lost the newer update: %s (head %s)", jsjson.Stringify(cur, ""), head)
	}
}

// TestGitWatchdog: src/skill-import.ts stops a trees-only clone whose folder grows past the cap. A git run that sits
// while its watched folder holds more than CloneBytes is stopped and refused as too large.
func TestGitWatchdog(t *testing.T) {
	im := NewImporter(Paths{Home: t.TempDir()}, false)
	im.CloneBytes = 10
	im.Poll = 10 * time.Millisecond
	watch := t.TempDir()
	must(t, os.WriteFile(filepath.Join(watch, "pack"), make([]byte, 100), 0o644))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, err := im.git(ctx, []string{"-c", "alias.zz=!sleep 30", "zz"}, "", watch)
	if err == nil || err.Error() != im.tooBig().Error() {
		t.Errorf("an oversized clone: %v", err)
	}
}

// TestGitKillsGroup: a stopped git run takes its helpers with it (a deviation: TS kills only git). The helper here is
// a shell git starts, which writes its pid and sleeps; once the run is canceled, it is gone.
func TestGitKillsGroup(t *testing.T) {
	im := NewImporter(Paths{Home: t.TempDir()}, false)
	pidFile := filepath.Join(t.TempDir(), "pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		for i := 0; i < 1000; i++ {
			if b, _ := os.ReadFile(pidFile); strings.TrimSpace(string(b)) != "" {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
	}()
	_, _ = im.git(ctx, []string{"-c", "alias.zz=!echo $$ > '" + pidFile + "'; exec sleep 30", "zz"}, "", "")
	b, err := os.ReadFile(pidFile)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 {
		t.Fatalf("the helper's pid: %q %v", b, err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	gone := func() bool {
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			return true
		}
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		return err != nil || strings.Contains(string(stat), ") Z ")
	}
	for i := 0; i < 500 && !gone(); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if !gone() {
		t.Error("git's helper outlived the stopped run")
	}
}

// TestCheckUpdateCache: src/skill-import.ts checkUpdate keeps an answer for ten minutes and runs at most two checks at
// once.
func TestCheckUpdateCache(t *testing.T) {
	im, _ := importFixture(t, "a", "b", "c")
	ctx := context.Background()
	now := time.Now()
	im.Now = func() time.Time { return now }
	var mu sync.Mutex
	runs := 0
	im.onCheck = func(string) {
		mu.Lock()
		runs++
		mu.Unlock()
	}
	count := func() int {
		mu.Lock()
		defer mu.Unlock()
		return runs
	}
	for _, step := range []struct {
		advance time.Duration
		want    int
	}{{0, 1}, {0, 1}, {9 * time.Minute, 1}, {time.Minute, 2}} {
		now = now.Add(step.advance)
		if res := im.CheckUpdate(ctx, "a"); res == nil {
			t.Fatal("no answer")
		}
		if got := count(); got != step.want {
			t.Errorf("after %v more: %d checks, want %d", step.advance, got, step.want)
		}
	}
	// Two at a time: a third check waits for a slot.
	arrived := make(chan string, 3)
	release := make(chan struct{})
	im.onCheck = func(n string) {
		arrived <- n
		<-release
	}
	now = now.Add(checkTTL)
	var wg sync.WaitGroup
	for _, n := range []string{"a", "b", "c"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			im.CheckUpdate(ctx, n)
		}()
	}
	<-arrived
	<-arrived
	// The admission barrier: the third check is queued for a slot, not running.
	for i := 0; i < 500 && im.queued.Load() != 1; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if q := im.queued.Load(); q != 1 || len(arrived) != 0 {
		t.Errorf("with two checks running, %d queued and %d more ran", q, len(arrived))
	}
	close(release)
	wg.Wait()
	if len(arrived) != 1 {
		t.Errorf("the queued check didn't run once a slot was free")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// TestTreeSizesGitHub: src/skill-import.ts treeSizes for a GitHub source asks the trees API (a loopback fake here) for
// the folder's tree, and a rate limit, another refusal and a tree past the caps each refuse the import.
func TestTreeSizesGitHub(t *testing.T) {
	answers := map[string]struct {
		status int
		body   string
	}{
		"ok":        {200, `{"tree":[{"type":"blob","size":10}]}`},
		"limited":   {403, ``},
		"throttled": {429, ``},
		"broken":    {500, ``},
		"truncated": {200, `{"tree":[],"truncated":true}`},
	}
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.RequestURI()+" "+r.Header.Get("user-agent"))
		a := answers[r.URL.Path[len("/repos/o/r/git/trees/"):]]
		w.WriteHeader(a.status)
		_, _ = w.Write([]byte(a.body))
	}))
	t.Cleanup(srv.Close)
	im := NewImporter(Paths{}, false)
	im.GitHubAPI = srv.URL
	src := Source{URL: "https://github.com/o/r"}
	for tree, want := range map[string]string{
		"ok":        "",
		"limited":   "GitHub refused to size the folder (rate limit); try again later",
		"throttled": "GitHub refused to size the folder (rate limit); try again later",
		"broken":    "could not size the folder at GitHub (500)",
		"truncated": "the folder is too large to list",
	} {
		err := im.treeSizes(context.Background(), src, "", tree)
		if got := ""; err != nil {
			got = err.Error()
			if _, refused := err.(*ImportError); !refused || got != want {
				t.Errorf("%s: %v", tree, err)
			}
		} else if want != "" {
			t.Errorf("%s: no error, want %q", tree, want)
		}
	}
	if len(paths) != 5 || paths[0][len(paths[0])-len("?recursive=1 stam"):] != "?recursive=1 stam" {
		t.Errorf("the requests: %q", paths)
	}
	if err := im.treeSizes(context.Background(), Source{URL: "file:///r.git"}, "", "x"); err == nil || err.Error() != "only github.com sources can be imported" {
		t.Errorf("a file source without allowFile: %v", err)
	}
}
