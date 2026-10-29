package server

import (
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The web UI is web/'s build, web/dist (src/daemon.ts handler, before any auth): its page, the stories page, the
// service worker and its assets are public, like the page itself.

// webAsset is a web UI file under /web/: assets/ or fonts/ and a name with one of the served extensions. Its name can
// hold no slash, so it names a file in one of those folders or in web/dist itself.
var webAsset = regexp.MustCompile(`^/web/((?:assets/|fonts/)?[\w.-]+\.(js|css|svg|woff2|woff|ttf|png|webmanifest|wasm))(\?|$)`)

var assetTypes = map[string]string{"js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "svg": "image/svg+xml", "woff2": "font/woff2",
	"woff": "font/woff", "ttf": "font/ttf", "png": "image/png", "webmanifest": "application/manifest+json", "wasm": "application/wasm"}

// assetCache holds each web UI file read and compressed once per encoding; a rebuild (a new mtime) reads it again.
type assetCache struct {
	mu    sync.Mutex
	files map[string]*cachedAsset
}

type cachedAsset struct {
	mtime   time.Time
	raw     []byte
	mu      sync.Mutex
	encoded map[string][]byte
}

func (c *assetCache) get(dir, name string) (*cachedAsset, error) {
	mtime, raw, err := readWeb(dir, name, func(cur time.Time) bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		hit := c.files[name]
		return hit != nil && hit.mtime.Equal(cur)
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return c.files[name], nil
	}
	fresh := &cachedAsset{mtime: mtime, raw: raw, encoded: map[string][]byte{}}
	if c.files == nil {
		c.files = map[string]*cachedAsset{}
	}
	c.files[name] = fresh
	return fresh, nil
}

// readWeb reads name in the web UI's folder dir, through an os.Root: a symlink or `..` that leads out of web/dist is
// refused, so a public GET reads nothing outside it. A symlink inside it still works. fresh, when given, says whether a
// cached copy of that mtime is current; then nothing is read and raw is nil.
func readWeb(dir, name string, fresh func(time.Time) bool) (mtime time.Time, raw []byte, err error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return time.Time{}, nil, err
	}
	defer root.Close()
	f, err := root.Open(name)
	if err != nil {
		return time.Time{}, nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return time.Time{}, nil, err
	}
	if st.IsDir() {
		return time.Time{}, nil, fs.ErrNotExist
	}
	if fresh != nil && fresh(st.ModTime()) {
		return st.ModTime(), nil, nil
	}
	raw, err = io.ReadAll(f)
	return st.ModTime(), raw, err
}

func (a *cachedAsset) encode(enc string) []byte {
	a.mu.Lock()
	defer a.mu.Unlock()
	if b, ok := a.encoded[enc]; ok {
		return b
	}
	b := encodeBody(a.raw, enc)
	a.encoded[enc] = b
	return b
}

// webDir is web/dist of the checkout the daemon runs from; "" when the server has no templates (a unit test's).
func (s *Server) webDir() string {
	if s.tpl == nil || s.tpl.Root == "" {
		return ""
	}
	return filepath.Join(s.tpl.Root, "web", "dist")
}

// pageURL is whether the raw request URL is path itself, or path with a query or a fragment.
func pageURL(uri, path string) bool {
	return uri == path || strings.HasPrefix(uri, path+"?") || strings.HasPrefix(uri, path+"#")
}

// serveStatic answers a GET for the web UI's page, the stories page, the service worker or an asset, and says whether it
// did. It reads the request URL as sent, as TS's req.url.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) bool {
	dir := s.webDir()
	if r.Method != http.MethodGet || dir == "" {
		return false
	}
	uri := r.RequestURI
	page := func(file, missing string) {
		_, b, err := readWeb(dir, file, nil)
		if err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(missing))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		w.Write(b)
	}
	switch {
	case uri == "/" || strings.HasPrefix(uri, "/?") || strings.HasPrefix(uri, "/#"):
		page("index.html", "The web UI is not built. Run `npm install && npm run build` in web/, or deploy with `stam deploy`.\n")
		return true
	// The stories page (docs/stories.md): it calls no API, so it works under auth.humanStrict too.
	case pageURL(uri, "/stories"):
		page("stories.html", "The stories page is not built. Run `npm run build` in web/.\n")
		return true
	// The service worker lives at the root, so its scope is the whole page. It caches nothing.
	case uri == "/sw.js" || strings.HasPrefix(uri, "/sw.js?"):
		_, b, err := readWeb(dir, "sw.js", nil)
		if err != nil {
			w.WriteHeader(http.StatusNotFound)
			return true
		}
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		w.Write(b)
		return true
	}
	m := webAsset.FindStringSubmatch(uri)
	if m == nil || strings.Contains(m[1], "..") {
		return false
	}
	a, err := s.assets.get(dir, m[1])
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return true
	}
	// Hashed names under assets/ and fonts/ never change, so browsers keep them.
	cache := "no-cache"
	if strings.HasPrefix(m[1], "assets/") || strings.HasPrefix(m[1], "fonts/") {
		cache = "max-age=31536000, immutable"
	}
	w.Header().Set("Content-Type", assetTypes[m[2]])
	w.Header().Set("Cache-Control", cache)
	sendCompressed(w, r, http.StatusOK, a.raw, a.encode)
	return true
}
