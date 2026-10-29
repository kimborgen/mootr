package server

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// diffRepo is a checkout whose origin has PR 7, which edits a.txt and a credential.
func diffRepoFixture(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	origin, work := filepath.Join(base, "origin.git"), filepath.Join(base, "work")
	must(t, os.MkdirAll(work, 0o755))
	git(base, "init", "-q", "--bare", "-b", "main", origin)
	git(work, "init", "-q", "-b", "main")
	must(t, os.WriteFile(filepath.Join(work, "a.txt"), []byte("one\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(work, ".env"), []byte("S=1\n"), 0o644))
	git(work, "add", "-A")
	git(work, "commit", "-q", "-m", "base")
	git(work, "remote", "add", "origin", origin)
	git(work, "push", "-q", "origin", "main")
	git(work, "checkout", "-q", "-b", "pr")
	must(t, os.WriteFile(filepath.Join(work, "a.txt"), []byte("one\ntwo\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(work, ".env"), []byte("S=2\n"), 0o644))
	git(work, "commit", "-q", "-am", "pr")
	git(work, "push", "-q", "origin", "pr:refs/pull/7/head")
	checkout := filepath.Join(base, "checkout")
	git(base, "clone", "-q", origin, checkout)
	return checkout
}

func TestDiffRoute(t *testing.T) {
	checkout := diffRepoFixture(t)
	f := relayFixture(t, "http://127.0.0.1:1", `"itsa":{"repos":{"app":"`+checkout+`"}}`, nil)
	human := func(path string) (int, string) {
		rec := f.do(call{path: path, token: sharedTok, header: humanHdr})
		return rec.Code, rec.Body.String()
	}
	code, body := human("/api/diff?repo=app&pr=7")
	var list struct {
		Repo   string
		PR     int
		Head   string
		Files  []map[string]any
		Review any
	}
	must(t, json.Unmarshal([]byte(body), &list))
	if code != 200 || list.Repo != "app" || list.PR != 7 || len(list.Files) != 2 || list.Files[0]["path"] != ".env" || list.Files[0]["denied"] != true || list.Files[1]["additions"] != 1.0 {
		t.Errorf("the list: %d %s", code, body)
	}
	if !strings.HasSuffix(body, `"review":null}`) {
		t.Errorf("no review: %s", body)
	}
	rec := f.do(call{path: "/api/diff/file?repo=app&pr=7&path=a.txt", token: sharedTok, header: humanHdr})
	if rec.Code != 200 || rec.Body.String() != "one\ntwo\n" || rec.Header().Get("X-Stam-Head") != list.Head || rec.Header().Get("Accept-Ranges") != "" ||
		!strings.HasPrefix(rec.Header().Get("Content-Security-Policy"), "default-src 'none'") {
		t.Errorf("the head file: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	for path, want := range map[string]string{
		"/api/diff/file?repo=app&pr=7&path=a.txt&side=base": "200 one\n",
		"/api/diff/file?repo=app&pr=7&path=.env":            `403 {"error":"not available"}`,
		"/api/diff/file?repo=app&pr=7&path=../a.txt":        `400 {"error":"path must be a plain path inside the repo"}`,
		"/api/diff/file?repo=app&pr=7&path=a.txt&side=x":    `400 {"error":"side must be base or head"}`,
		"/api/diff/file?repo=app&pr=7&path=a.txt&side=":     `400 {"error":"side must be base or head"}`,
		"/api/diff/file?repo=app&pr=7&path=a.txt&head=xyz":  `400 {"error":"head must be a commit sha"}`,
		"/api/diff?repo=app&pr=07":                          `400 {"error":"pr must be a PR number"}`,
		"/api/diff?pr=7":                                    `400 {"error":"repo is required"}`,
		"/api/diff?repo=nope&pr=7":                          `404 {"error":"unknown repo nope: it is not in settings.itsa.repos"}`,
		"/api/diff?repo=app&pr=99":                          `404 {"error":"no PR 99 in app"}`,
	} {
		if code, body := human(path); strconv.Itoa(code)+" "+body != want {
			t.Errorf("%s: %d %s, want %s", path, code, body, want)
		}
	}
	code, body = human("/api/diff/repos")
	if code != 200 || !strings.HasPrefix(body, `{"machine":"here","repos":[`) || !strings.Contains(body, `{"name":"app","github":null,"path":"`+checkout+`","sha":"`) {
		t.Errorf("the repos: %d %s", code, body)
	}

	// Only the human: not an agent's own token, whatever it claims, and not the shared token without x-stam-human.
	for _, c := range []call{
		{path: "/api/diff?repo=app&pr=7", token: agentTok, header: map[string]string{"X-Stam-Human": "1"}},
		{path: "/api/diff/file?repo=app&pr=7&path=a.txt", token: agentTok, header: map[string]string{"X-Stam-Human": "1"}},
		{path: "/api/diff/repos", token: sharedTok},
	} {
		rec := f.do(c)
		if rec.Code != 403 || !strings.HasPrefix(errorOf(t, rec), "only the human can read diffs, ") {
			t.Errorf("%s %s: %d %s", c.token, c.path, rec.Code, rec.Body)
		}
	}
}

// A daemon that isn't the ITSA home forwards to it as the human; a home that is no peer, or is down, is a 503.
func TestDiffForwarded(t *testing.T) {
	checkout := diffRepoFixture(t)
	far, farTS := farDaemon(t)
	writeSettings(t, far, `{"itsa":{"repos":{"app":"`+checkout+`"}}}`)
	f := relayFixture(t, farTS.ts.URL, `"itsa":{"home":"far"}`, nil)
	rec := f.do(call{path: "/api/diff/file?repo=app&pr=7&path=a.txt", token: sharedTok, header: humanHdr})
	if rec.Code != 200 || rec.Body.String() != "one\ntwo\n" || rec.Header().Get("Accept-Ranges") != "none" || rec.Header().Get("X-Stam-Sha") == "" ||
		rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("a forwarded file: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	seen := farTS.seen()
	if last := seen[len(seen)-1]; last.path != "/api/diff/file" || last.query != "repo=app&pr=7&path=a.txt" || last.header.Get("X-Stam-Human") != "1" {
		t.Errorf("the forwarded call: %+v", last)
	}
	if rec = f.do(call{path: "/api/diff?repo=app&pr=7", token: sharedTok, header: humanHdr}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"denied":true`) {
		t.Errorf("a forwarded list: %d %s", rec.Code, rec.Body)
	}
	if rec = f.do(call{path: "/api/diff/file?repo=app&pr=7&path=.env", token: sharedTok, header: humanHdr}); rec.Code != 403 || strings.Contains(rec.Body.String(), "S=") {
		t.Errorf("the home's deny list: %d %s", rec.Code, rec.Body)
	}
	if rec = f.do(call{path: "/api/diff?repo=app&pr=7", token: agentTok, header: map[string]string{"X-Stam-Human": "1"}}); rec.Code != 403 {
		t.Errorf("an agent through the forward: %d %s", rec.Code, rec.Body)
	}
	farTS.ts.Close()
	if rec = f.do(call{path: "/api/diff?repo=app&pr=7", token: sharedTok, header: humanHdr}); rec.Code != 503 || errorOf(t, rec) != "far (the ITSA home) is stopped" {
		t.Errorf("a stopped home: %d %s", rec.Code, rec.Body)
	}
	writeSettings(t, f, `{"itsa":{"home":"elsewhere"}}`)
	if rec = f.do(call{path: "/api/diff?repo=app&pr=7", token: sharedTok, header: humanHdr}); rec.Code != 503 || errorOf(t, rec) != "ITSA home 'elsewhere' is not a configured peer" {
		t.Errorf("a home that is no peer: %d %s", rec.Code, rec.Body)
	}
}

// Under auth.humanStrict no relay carries the human: reading the home's diff is refused here, and the home isn't asked.
func TestDiffForwardedStrict(t *testing.T) {
	far, farTS := farDaemon(t)
	writeSettings(t, far, `{}`)
	f := relayFixture(t, farTS.ts.URL, `"auth":{"humanStrict":true},"itsa":{"home":"far"}`, nil)
	before := len(farTS.seen())
	rec := f.do(call{path: "/api/diff?repo=app&pr=7", token: sharedTok, header: humanHdr})
	if rec.Code != 409 || errorOf(t, rec) != "a diff on far is the human's; do it from stam's web UI on far" {
		t.Errorf("strict forward: %d %s", rec.Code, rec.Body)
	}
	if len(farTS.seen()) != before {
		t.Error("the home was asked")
	}
}
