package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
)

// acceptedEncoding picks what src/compress.ts's does for every header shape: q values, spaces, case, repeats, junk.
func TestAcceptedEncodingMatchesTS(t *testing.T) {
	headers := []*string{nil}
	for _, h := range []string{"", "br", "gzip", "identity", "gzip, br", "br;q=0", "br;q=0, gzip", "BR", " br ", "br ;q=1", "br; q=0.5",
		"br;q=", "br;q=abc", "br;q=-1, gzip;q=0.1", "gzip;q=0, br;q=0", "br, br;q=0", "deflate, gzip;q=1.0", "*", "br;level=3;q=1", "br;Q=0", "gzip;q=0x1"} {
		h := h
		headers = append(headers, &h)
	}
	in, err := json.Marshal(headers)
	must(t, err)
	cmd := exec.Command("node", "--no-warnings", "testdata/compressref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("compressref.mjs: %v\n%s", err, stderr.String())
	}
	var want []string
	must(t, json.Unmarshal(out, &want))
	for i, h := range headers {
		v := ""
		if h != nil {
			v = *h
		}
		if got := acceptedEncoding(v); got != want[i] {
			t.Errorf("acceptedEncoding(%q) = %q, TS %q", v, got, want[i])
		}
	}
}

func decoded(t *testing.T, enc string, b []byte) []byte {
	t.Helper()
	var r io.Reader
	switch enc {
	case "br":
		r = brotli.NewReader(bytes.NewReader(b))
	case "gzip":
		z, err := gzip.NewReader(bytes.NewReader(b))
		must(t, err)
		r = z
	default:
		return b
	}
	out, err := io.ReadAll(r)
	must(t, err)
	return out
}

// A JSON answer over 1 KB is brotli when br is taken, gzip when only gzip is, and plain otherwise, with Vary and the
// length either way; an error under 1 KB is sent plain.
func TestJSONCompressed(t *testing.T) {
	f := newFixture(t, nil)
	get := func(path, accept string) *httptest.ResponseRecorder {
		return f.do(call{path: path, token: sharedTok, header: map[string]string{"Accept-Encoding": accept}})
	}
	plain := get("/api/tools", "identity")
	if plain.Code != 200 || plain.Body.Len() < minCompress || plain.Header().Get("Content-Encoding") != "" {
		t.Fatalf("plain: %d, %d bytes, encoding %q", plain.Code, plain.Body.Len(), plain.Header().Get("Content-Encoding"))
	}
	for _, c := range []struct{ accept, enc string }{{"gzip, br", "br"}, {"gzip", "gzip"}, {"identity", ""}, {"br;q=0, gzip", "gzip"}} {
		rec := get("/api/tools", c.accept)
		h := rec.Header()
		if h.Get("Content-Encoding") != c.enc || h.Get("Vary") != "accept-encoding" || h.Get("Content-Type") != "application/json" {
			t.Errorf("%q: headers %v", c.accept, h)
		}
		if h.Get("Content-Length") != itoa(rec.Body.Len()) {
			t.Errorf("%q: Content-Length %s for %d bytes", c.accept, h.Get("Content-Length"), rec.Body.Len())
		}
		if c.enc != "" && rec.Body.Len() >= plain.Body.Len() {
			t.Errorf("%q: %d bytes compressed, %d plain", c.accept, rec.Body.Len(), plain.Body.Len())
		}
		if got := decoded(t, c.enc, rec.Body.Bytes()); !bytes.Equal(got, plain.Body.Bytes()) {
			t.Errorf("%q: decodes to other JSON", c.accept)
		}
	}
	if rec := get("/api/nope-nothing", "br"); rec.Code != 404 || rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Vary") != "accept-encoding" {
		t.Errorf("a tiny error: %d %v", rec.Code, rec.Header())
	}
}

// The web UI's page, stories, service worker and assets are public; an asset is compressed on request from a cache a
// rebuild refreshes, and a path out of web/dist or of another type is no asset.
func TestStaticFiles(t *testing.T) {
	f := newFixture(t, nil)
	root := t.TempDir()
	dist := filepath.Join(root, "web", "dist")
	must(t, os.MkdirAll(filepath.Join(dist, "assets"), 0o755))
	js := []byte(strings.Repeat("console.log('mootr');\n", 200))
	must(t, os.WriteFile(filepath.Join(dist, "assets", "app-1.js"), js, 0o644))
	must(t, os.WriteFile(filepath.Join(dist, "index.html"), []byte("<!doctype html>page"), 0o644))
	must(t, os.WriteFile(filepath.Join(dist, "secret.txt"), []byte("no"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "outside.js"), []byte("no"), 0o644))
	f.srv.tpl.Root = root
	get := func(path, accept string) *httptest.ResponseRecorder {
		return f.do(call{path: path, header: map[string]string{"Accept-Encoding": accept}})
	}

	if rec := get("/stories", ""); rec.Code != 503 || !strings.Contains(rec.Body.String(), "stories page is not built") {
		t.Errorf("no stories page: %d %s", rec.Code, rec.Body)
	}
	for _, p := range []string{"/", "/?x=1", "/#a"} {
		if rec := get(p, "br"); rec.Code != 200 || rec.Body.String() != "<!doctype html>page" || rec.Header().Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: %d %q %v", p, rec.Code, rec.Body, rec.Header())
		}
	}
	if rec := get("/sw.js", ""); rec.Code != 404 {
		t.Errorf("a missing service worker: %d", rec.Code)
	}
	br := get("/web/assets/app-1.js?v=2", "br, gzip")
	if br.Code != 200 || br.Header().Get("Content-Encoding") != "br" || br.Header().Get("Cache-Control") != "max-age=31536000, immutable" || br.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("an asset: %d %v", br.Code, br.Header())
	}
	if !bytes.Equal(decoded(t, "br", br.Body.Bytes()), js) {
		t.Error("the asset decodes to other bytes")
	}
	if again := get("/web/assets/app-1.js", "br"); !bytes.Equal(again.Body.Bytes(), br.Body.Bytes()) {
		t.Error("a cached asset's bytes changed")
	}
	if plain := get("/web/assets/app-1.js", "identity"); !bytes.Equal(plain.Body.Bytes(), js) || plain.Header().Get("Content-Encoding") != "" {
		t.Error("the plain asset isn't the file")
	}
	// A rebuild writes new bytes with a new mtime; the cache reads them.
	js2 := []byte(strings.Repeat("console.log('rebuilt');\n", 200))
	must(t, os.WriteFile(filepath.Join(dist, "assets", "app-1.js"), js2, 0o644))
	later := time.Now().Add(time.Minute)
	must(t, os.Chtimes(filepath.Join(dist, "assets", "app-1.js"), later, later))
	if rebuilt := get("/web/assets/app-1.js", "br"); !bytes.Equal(decoded(t, "br", rebuilt.Body.Bytes()), js2) {
		t.Error("a rebuilt asset was served from the old cache")
	}
	// No asset: another type, a folder walk, a missing file. Each falls to the API, which wants a token, or is a 404.
	for p, want := range map[string]int{"/web/secret.txt": 401, "/web/../outside.js": 401, "/web/assets/../../outside.js": 401, "/web/..js": 401, "/web/assets/nope.js": 404} {
		if rec := get(p, ""); rec.Code != want {
			t.Errorf("%s: %d, want %d: %s", p, rec.Code, want, rec.Body)
		}
	}
}

// A public GET reads nothing outside web/dist: a file symlink or a folder symlink that leads out is refused, for an
// asset, the page, the stories page and the service worker alike. A symlink inside web/dist still works.
func TestStaticSymlinks(t *testing.T) {
	f := newFixture(t, nil)
	root := t.TempDir()
	dist := filepath.Join(root, "web", "dist")
	outside := filepath.Join(root, "outside")
	must(t, os.MkdirAll(dist, 0o755))
	must(t, os.MkdirAll(outside, 0o755))
	secret := "the secret outside web/dist"
	for _, name := range []string{"app.js", "index.html", "stories.html", "sw.js"} {
		must(t, os.WriteFile(filepath.Join(outside, name), []byte(secret), 0o644))
	}
	must(t, os.WriteFile(filepath.Join(dist, "real.js"), []byte("inside"), 0o644))
	for _, name := range []string{"index.html", "stories.html", "sw.js"} {
		must(t, os.Symlink(filepath.Join(outside, name), filepath.Join(dist, name)))
	}
	must(t, os.Symlink(filepath.Join(outside, "app.js"), filepath.Join(dist, "linked.js")))
	must(t, os.Symlink(outside, filepath.Join(dist, "assets")))
	must(t, os.Symlink("real.js", filepath.Join(dist, "alias.js")))
	f.srv.tpl.Root = root
	for p, want := range map[string]int{"/": 503, "/stories": 503, "/sw.js": 404, "/web/linked.js": 404, "/web/assets/app.js": 404} {
		rec := f.do(call{path: p})
		if rec.Code != want || strings.Contains(rec.Body.String(), secret) {
			t.Errorf("%s: %d, want %d: %s", p, rec.Code, want, rec.Body)
		}
	}
	if rec := f.do(call{path: "/web/alias.js"}); rec.Code != 200 || rec.Body.String() != "inside" {
		t.Errorf("a symlink inside web/dist: %d %s", rec.Code, rec.Body)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
