package files

import (
	"bytes"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// serveFixture is a root with files, and a folder outside it with a link to it from inside.
func serveFixture(t *testing.T) (Paths, string, []string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "root")
	write := func(name string, b []byte) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.txt", []byte("hello world"))
	write("noext", []byte("plain words"))
	write("bin.dat", []byte{1, 2, 0, 3})
	write("fake.txt", []byte("\x89PNG\r\n\x1a\nrest"))
	write("doc.bin", []byte("%PDF-1.4"))
	write("photo", []byte{0xff, 0xd8, 0xff, 0xe0})
	write("anim.dat", []byte("GIF89a"))
	write("empty.txt", nil)
	write("big.txt", bytes.Repeat([]byte("a"), TextCap+100))
	// A UTF-8 character cut by the sniff's 4096 bytes is still text.
	write("cut.log", append(bytes.Repeat([]byte("a"), sniffBytes-1), "é and more"...))
	write("bad.txt", []byte("ok \xff\xfe not utf-8"))
	write("😀 x\"y.zip", []byte{0, 1})
	if err := os.MkdirAll(filepath.Join(base, "outside"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "outside", "s.txt"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(base, "outside"), filepath.Join(root, "out")); err != nil {
		t.Fatal(err)
	}
	return Paths{Home: filepath.Join(base, "home"), StamHome: filepath.Join(base, "stam")}, root, []string{root}
}

func serveOne(t *testing.T, p Paths, roots []string, real, rng string, all bool) (*httptest.ResponseRecorder, error) {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/files/read", nil)
	if rng != "" {
		r.Header.Set("Range", rng)
	}
	w := httptest.NewRecorder()
	err := p.Serve(w, r, real, all, roots)
	return w, err
}

func TestServe(t *testing.T) {
	p, root, roots := serveFixture(t)
	get := func(name, rng string, all bool) *httptest.ResponseRecorder {
		t.Helper()
		w, err := serveOne(t, p, roots, filepath.Join(root, name), rng, all)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return w
	}
	a := get("a.txt", "", false)
	if a.Code != 200 || a.Body.String() != "hello world" || a.Header().Get("Content-Length") != "11" || a.Header().Get("X-Stam-Size") != "11" {
		t.Errorf("a.txt: %d %q %v", a.Code, a.Body, a.Header())
	}
	for k, v := range map[string]string{"Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
		"X-Content-Type-Options": "nosniff", "Cache-Control": "private", "Accept-Ranges": "bytes", "Content-Disposition": ""} {
		if got := a.Header().Get(k); got != v {
			t.Errorf("a.txt %s: %q, want %q", k, got, v)
		}
	}
	for name, want := range map[string][2]string{
		"noext":     {"text/plain; charset=utf-8", ""},
		"bin.dat":   {"application/octet-stream", `attachment; filename="bin.dat"`},
		"fake.txt":  {"image/png", ""},
		"doc.bin":   {"application/pdf", ""},
		"photo":     {"image/jpeg", ""},
		"anim.dat":  {"image/gif", ""},
		"empty.txt": {"application/octet-stream", `attachment; filename="empty.txt"`},
		"cut.log":   {"text/plain; charset=utf-8", ""},
		"bad.txt":   {"application/octet-stream", `attachment; filename="bad.txt"`},
		// The emoji is two UTF-16 units, so two underscores, as TS's replace.
		"😀 x\"y.zip": {"application/octet-stream", `attachment; filename="__ x_y.zip"`},
	} {
		w := get(name, "", false)
		if w.Header().Get("Content-Type") != want[0] || w.Header().Get("Content-Disposition") != want[1] {
			t.Errorf("%s: %q %q, want %q", name, w.Header().Get("Content-Type"), w.Header().Get("Content-Disposition"), want)
		}
	}
	if w := get("empty.txt", "", false); w.Code != 200 || w.Header().Get("Content-Length") != "0" || w.Body.Len() != 0 {
		t.Errorf("an empty file: %d %v", w.Code, w.Header())
	}

	for rng, want := range map[string][3]string{
		"bytes=0-4":                      {"206", "bytes 0-4/11", "hello"},
		"bytes=-5":                       {"206", "bytes 6-10/11", "world"},
		"bytes=6-":                       {"206", "bytes 6-10/11", "world"},
		"bytes=6-99":                     {"206", "bytes 6-10/11", "world"},
		"bytes=-99":                      {"206", "bytes 0-10/11", "hello world"},
		"bytes=50-":                      {"416", "bytes */11", ""},
		"bytes=5-2":                      {"416", "bytes */11", ""},
		"bytes=-0":                       {"416", "bytes */11", ""},
		"bytes=1e3-":                     {"200", "", "hello world"},
		"bytes=-":                        {"200", "", "hello world"},
		"bytes=0-0,2":                    {"200", "", "hello world"},
		"bytes=99999999999999999999999-": {"416", "bytes */11", ""},
	} {
		w := get("a.txt", rng, false)
		if code := w.Code; want[0] != itoa(code) || w.Header().Get("Content-Range") != want[1] || w.Body.String() != want[2] {
			t.Errorf("%s: %d %q %q, want %v", rng, code, w.Header().Get("Content-Range"), w.Body, want)
		}
		if w.Code == 416 && (w.Header().Get("Content-Type") != "" || w.Header().Get("Content-Security-Policy") != "") {
			t.Errorf("%s: a 416 carries only its range: %v", rng, w.Header())
		}
	}

	cut := get("big.txt", "", false)
	if cut.Header().Get("X-Stam-Truncated") != "1" || cut.Body.Len() != TextCap || cut.Header().Get("Content-Length") != itoa(TextCap) {
		t.Errorf("big text: %v, %d bytes", cut.Header(), cut.Body.Len())
	}
	if full := get("big.txt", "", true); full.Header().Get("X-Stam-Truncated") != "" || full.Body.Len() != TextCap+100 {
		t.Errorf("big text with all: %v, %d bytes", full.Header(), full.Body.Len())
	}
	if tail := get("big.txt", "bytes="+itoa(TextCap)+"-", false); tail.Code != 206 || tail.Body.Len() != 100 {
		t.Errorf("Range on big text: %d, %d bytes", tail.Code, tail.Body.Len())
	}
}

// A path that resolved inside a root but whose open file is elsewhere (a link swapped in after ResolveIn) is refused, and
// so is a FIFO, without blocking, and a folder.
func TestServeRefuses(t *testing.T) {
	p, root, roots := serveFixture(t)
	if err := syscall.Mkfifo(filepath.Join(root, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"out/s.txt": "403 the file moved", "pipe": "400 not a file", ".": "400 not a file"} {
		w, err := serveOne(t, p, roots, filepath.Join(root, name), "", false)
		e, ok := AsError(err)
		if !ok || itoa(e.Status)+" "+e.Message != want || w.Body.Len() != 0 || len(w.Header()) != 0 {
			t.Errorf("%s: %v, want %s; wrote %d %q", name, err, want, w.Code, w.Body)
		}
	}
	// A denied name reached through the open file is refused too.
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("SECRET=1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := serveOne(t, p, roots, filepath.Join(root, ".env"), "", false); err == nil || err.Error() != "the file moved" {
		t.Errorf(".env: %v", err)
	}
	// The last part a link: the open refuses it rather than follow it.
	if err := os.Symlink(filepath.Join(root, "a.txt"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := serveOne(t, p, roots, filepath.Join(root, "alias"), "", false); err == nil {
		t.Error("a link as the last part was followed")
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// A folder on the way to a listed path swapped for a link after ResolveIn: to a folder outside the roots, to a denied
// folder inside one, and a folder above the listed one. The listing refuses rather than show the other folder.
func TestListDirSwapped(t *testing.T) {
	p, root, roots := serveFixture(t)
	outside := filepath.Join(filepath.Dir(root), "outside")
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, ".ssh"), 0o755))
	must(os.WriteFile(filepath.Join(root, ".ssh", "id_rsa"), []byte("key"), 0o600))
	must(os.MkdirAll(filepath.Join(outside, "b"), 0o755))
	must(os.WriteFile(filepath.Join(outside, "b", "secret.txt"), []byte("x"), 0o644))
	for _, c := range []struct{ name, swap, target, list string }{
		{"a folder out of the roots", "sub", outside, "sub"},
		{"a denied folder inside a root", "sub", filepath.Join(root, ".ssh"), "sub"},
		{"a folder above the listed one", "a", outside, "a/b"},
	} {
		t.Run(c.name, func(t *testing.T) {
			must(os.MkdirAll(filepath.Join(root, "a", "b"), 0o755))
			must(os.MkdirAll(filepath.Join(root, "sub"), 0o755))
			t.Cleanup(func() {
				os.Remove(filepath.Join(root, c.swap))
				os.RemoveAll(filepath.Join(root, c.swap+".old"))
				beforeListOpen = nil
			})
			real, err := p.ResolveIn(filepath.Join(root, c.list), roots)
			must(err)
			beforeListOpen = func(string) {
				must(os.Rename(filepath.Join(root, c.swap), filepath.Join(root, c.swap+".old")))
				must(os.Symlink(c.target, filepath.Join(root, c.swap)))
			}
			entries, err := p.ListDir(real, roots)
			if e, ok := AsError(err); !ok || e.Status != 403 || e.Message != "the folder moved" {
				t.Errorf("listed %v, %v", entries, err)
			}
		})
	}
}

// A FIFO is no folder: listing it is refused at once, never blocked on a writer.
func TestListDirFIFO(t *testing.T) {
	p, root, roots := serveFixture(t)
	fifo := filepath.Join(root, "pipe")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := p.ListDir(fifo, roots); done <- err }()
	select {
	case err := <-done:
		if e, ok := AsError(err); !ok || e.Status != 400 || e.Message != "not a folder" {
			t.Errorf("a FIFO: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listing a FIFO blocked")
	}
}

// A folder swapped after the re-check: its entries are still read through the checked handle, so a listing shows the
// folder that was checked, never the one now at its path.
func TestListDirReadsTheCheckedFolder(t *testing.T) {
	p, root, roots := serveFixture(t)
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	afterListCheck = func(string) {
		if err := os.Rename(sub, sub+".old"); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(sub, "f.txt"), bytes.Repeat([]byte("y"), 999), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { afterListCheck = nil })
	entries, err := p.ListDir(sub, roots)
	if err != nil || len(entries) != 1 || entries[0].Name != "f.txt" || entries[0].Size != 1 {
		t.Errorf("the checked folder's entries: %+v %v", entries, err)
	}
}
