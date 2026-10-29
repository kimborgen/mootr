package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// filesTree is a root with a file, a credential and a link out, and a secret outside the root.
func filesTree(t *testing.T) (root, outside string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	root, outside = filepath.Join(base, "files"), filepath.Join(base, "secret")
	must(t, os.MkdirAll(root, 0o755))
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello from here"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, ".env"), []byte("SECRET=1"), 0o644))
	must(t, os.WriteFile(filepath.Join(outside, "s.txt"), []byte("nope"), 0o644))
	must(t, os.Symlink(outside, filepath.Join(root, "out")))
	must(t, os.Symlink(".env", filepath.Join(root, "harmless.txt")))
	return root, outside
}

func filesPath(kind, path string, more ...string) string {
	return "/api/files/" + kind + "?path=" + url.QueryEscape(path) + strings.Join(more, "")
}

func TestFilesRoute(t *testing.T) {
	root, outside := filesTree(t)
	f := relayFixture(t, "http://127.0.0.1:1", `"files":{"roots":["`+root+`"]}`, nil)
	human := func(path string, hdr ...string) *httptest.ResponseRecorder {
		h := map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
		for i := 0; i+1 < len(hdr); i += 2 {
			h[hdr[i]] = hdr[i+1]
		}
		return f.do(call{path: path, token: sharedTok, header: h})
	}

	rec := human("/api/files/list")
	if rec.Code != 200 || rec.Body.String() != `{"host":"here","roots":[{"path":"`+root+`","name":"files"}]}` {
		t.Errorf("the roots: %d %s", rec.Code, rec.Body)
	}
	rec = human(filesPath("list", root))
	var listing struct {
		Host, Path string
		Entries    []struct{ Name, Kind string }
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &listing))
	if rec.Code != 200 || listing.Host != "here" || listing.Path != root || len(listing.Entries) != 3 || listing.Entries[0].Name != "a.txt" || listing.Entries[1].Name != "harmless.txt" || listing.Entries[2].Kind != "symlink" {
		t.Errorf("the listing (.env hidden): %d %s", rec.Code, rec.Body)
	}
	if !strings.HasPrefix(rec.Body.String(), `{"host":"here","path":`) {
		t.Errorf("the listing's keys are out of TS's order: %s", rec.Body)
	}
	rec = human(filesPath("read", filepath.Join(root, "a.txt")))
	if rec.Code != 200 || rec.Body.String() != "hello from here" || !strings.HasPrefix(rec.Header().Get("Content-Security-Policy"), "default-src 'none'") {
		t.Errorf("a read: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	if rec = human(filesPath("read", filepath.Join(root, "a.txt")), "Range", "bytes=6-9"); rec.Code != 206 || rec.Body.String() != "from" {
		t.Errorf("a Range: %d %q", rec.Code, rec.Body)
	}
	// Every way out of the root, and every name on the deny list, is refused.
	for path, want := range map[string]string{
		filepath.Join(root, ".env"):                  "403 not available",
		filepath.Join(root, "harmless.txt"):          "403 not available",
		filepath.Join(outside, "s.txt"):              "403 outside the allowed folders",
		filepath.Join(root, "out", "s.txt"):          "403 outside the allowed folders",
		filepath.Join(root, "..", "secret", "s.txt"): "403 outside the allowed folders",
		filepath.Join(root, "missing"):               "404 no such file",
		"files/a.txt":                                "400 path must be absolute",
	} {
		rec := human(filesPath("read", path))
		if got := strconv.Itoa(rec.Code) + " " + errorOf(t, rec); got != want {
			t.Errorf("%s: %s, want %s", path, got, want)
		}
	}
	if rec = human(filesPath("list", filepath.Join(root, "a.txt"))); rec.Code != 400 || errorOf(t, rec) != "not a folder" {
		t.Errorf("listing a file: %d %s", rec.Code, rec.Body)
	}
	// A FIFO is no folder: the listing refuses it at once rather than wait for a writer.
	must(t, syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644))
	listed := make(chan *httptest.ResponseRecorder, 1)
	go func() { listed <- human(filesPath("list", filepath.Join(root, "pipe"))) }()
	select {
	case rec := <-listed:
		if rec.Code != 400 || errorOf(t, rec) != "not a folder" {
			t.Errorf("listing a FIFO: %d %s", rec.Code, rec.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listing a FIFO blocked")
	}
	if rec = human(filesPath("read", root)); rec.Code != 400 || errorOf(t, rec) != "not a file" {
		t.Errorf("reading a folder: %d %s", rec.Code, rec.Body)
	}
	if rec = human("/api/files/write"); rec.Code != 404 {
		t.Errorf("another kind: %d %s", rec.Code, rec.Body)
	}

	// Only the human: not an agent's own token, whatever it claims, and not the shared token without x-stam-human.
	for _, c := range []call{
		{path: "/api/files/list", token: agentTok, header: map[string]string{"X-Stam-Human": "1"}},
		{path: filesPath("read", filepath.Join(root, "a.txt")), token: agentTok, header: map[string]string{"X-Stam-Human": "1"}},
		{path: filesPath("read", filepath.Join(root, "a.txt")), token: sharedTok},
		{path: filesPath("read", filepath.Join(root, "a.txt"), "&host=far"), token: agentTok, header: map[string]string{"X-Stam-Human": "1"}},
	} {
		rec := f.do(c)
		if rec.Code != 403 || !strings.HasPrefix(errorOf(t, rec), "only the human can read files, ") || strings.Contains(rec.Body.String(), "hello") {
			t.Errorf("%s %s: %d %s", c.token, c.path, rec.Code, rec.Body)
		}
	}
}

// Under auth.humanStrict the shared token's x-stam-human is no human: only the human's proof reads files.
func TestFilesRouteStrict(t *testing.T) {
	root, _ := filesTree(t)
	f := relayFixture(t, "http://127.0.0.1:1", `"auth":{"humanStrict":true},"files":{"roots":["`+root+`"]}`, nil)
	path := filesPath("read", filepath.Join(root, "a.txt"))
	if rec := f.do(call{path: path, token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}}); rec.Code != 403 {
		t.Errorf("the shared token under strict: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: path, token: sharedTok, header: humanHdr}); rec.Code != 200 || rec.Body.String() != "hello from here" {
		t.Errorf("the human's proof under strict: %d %s", rec.Code, rec.Body)
	}
}

// Another host is asked over the peer token as the human, Range and all; an unknown one is 404 and a stopped one 503.
func TestFilesForwarded(t *testing.T) {
	root, _ := filesTree(t)
	far, farTS := farDaemon(t)
	writeSettings(t, far, `{"files":{"roots":["`+root+`"]}}`)
	f := relayFixture(t, farTS.ts.URL, "", nil)
	read := filesPath("read", filepath.Join(root, "a.txt"), "&host=far")
	rec := f.do(call{path: read, token: sharedTok, header: humanHdr})
	if rec.Code != 200 || rec.Body.String() != "hello from here" || rec.Header().Get("Content-Length") != "15" || rec.Header().Get("X-Stam-Size") != "15" ||
		rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Errorf("a forwarded read: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	seen := farTS.seen()
	if last := seen[len(seen)-1]; last.path != "/api/files/read" || last.header.Get("X-Stam-Human") != "1" || last.header.Get("Authorization") != "Bearer "+peerTok ||
		strings.Contains(last.query, "host=") {
		t.Errorf("the forwarded call: %+v", last)
	}
	rec = f.do(call{path: read, token: sharedTok, header: map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1", "Range": "bytes=11-14"}})
	if rec.Code != 206 || rec.Body.String() != "here" || rec.Header().Get("Content-Range") != "bytes 11-14/15" {
		t.Errorf("a forwarded Range: %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	if rec = f.do(call{path: filesPath("read", filepath.Join(root, ".env"), "&host=far"), token: sharedTok, header: humanHdr}); rec.Code != 403 || strings.Contains(rec.Body.String(), "SECRET") {
		t.Errorf("the far side's deny list: %d %s", rec.Code, rec.Body)
	}
	if rec = f.do(call{path: filesPath("list", root, "&host=far"), token: sharedTok, header: humanHdr}); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"host":"far"`) {
		t.Errorf("a forwarded listing: %d %s", rec.Code, rec.Body)
	}
	if rec = f.do(call{path: filesPath("read", "/x", "&host=nowhere"), token: sharedTok, header: humanHdr}); rec.Code != 404 || errorOf(t, rec) != "no machine nowhere" {
		t.Errorf("an unknown host: %d %s", rec.Code, rec.Body)
	}

	farTS.ts.Close()
	rec = f.do(call{path: read, token: sharedTok, header: humanHdr})
	if rec.Code != http.StatusServiceUnavailable || rec.Body.String() != `{"state":"stopped","host":"far","error":"far is stopped"}` {
		t.Errorf("a stopped peer: %d %s", rec.Code, rec.Body)
	}
}

// Under auth.humanStrict no relay carries the human: reading a peer's file is refused here with the machine to go to,
// as TS's relayHuman treats 'a file' as a write.
func TestFilesForwardedStrict(t *testing.T) {
	root, _ := filesTree(t)
	far, farTS := farDaemon(t)
	writeSettings(t, far, `{"files":{"roots":["`+root+`"]}}`)
	f := relayFixture(t, farTS.ts.URL, `"auth":{"humanStrict":true}`, nil)
	before := len(farTS.seen())
	rec := f.do(call{path: filesPath("read", filepath.Join(root, "a.txt"), "&host=far"), token: sharedTok, header: humanHdr})
	if rec.Code != 409 || errorOf(t, rec) != "a file on far is the human's; do it from stam's web UI on far" {
		t.Errorf("strict forward: %d %s", rec.Code, rec.Body)
	}
	if len(farTS.seen()) != before {
		t.Error("the peer was asked")
	}
}
