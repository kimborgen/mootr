package files

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"
)

// Types are the types a file is served as by its extension (src/files.ts TYPES).
var Types = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml", "pdf": "application/pdf",
	"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "m4v": "video/mp4", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4",
}

var textExt = regexp.MustCompile(`^(txt|md|log|json|ya?ml|toml|csv|tsv|ts|tsx|js|jsx|mjs|py|sh|rs|go|css|html|sql|diff|patch)$`)

// TypeByExt is src/files.ts typeByExt: the type an attachment or file is served as, by extension.
func TypeByExt(name string) string {
	ext := strings.ToLower(name[strings.LastIndex(name, ".")+1:])
	if t, ok := Types[ext]; ok {
		return t
	}
	if textExt.MatchString(ext) {
		return "text/plain; charset=utf-8"
	}
	return "application/octet-stream"
}

// SafeHeaders are the headers every served file carries: no script can run from it, whatever its type
// (src/files.ts SAFE_HEADERS).
var SafeHeaders = [][2]string{{"Accept-Ranges", "bytes"}, {"Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'"}, {"X-Content-Type-Options", "nosniff"}, {"Cache-Control", "private"}}

// SetSafe sets SafeHeaders on h.
func SetSafe(h http.Header) {
	for _, kv := range SafeHeaders {
		h.Set(kv[0], kv[1])
	}
}

const sniffBytes = 4096

// sniff is src/files.ts sniff: the first bytes decide whether the file is text, and name a few binary types the
// extension missed.
func sniff(f *os.File) (text bool, typ string) {
	buf := make([]byte, sniffBytes)
	n, _ := f.ReadAt(buf, 0)
	b := buf[:n]
	switch {
	case bytes.HasPrefix(b, []byte("%PDF")):
		return false, "application/pdf"
	case len(b) >= 4 && string(b[1:4]) == "PNG":
		return false, "image/png"
	case len(b) >= 2 && b[0] == 0xff && b[1] == 0xd8:
		return false, "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF")):
		return false, "image/gif"
	case bytes.IndexByte(b, 0) >= 0:
		return false, ""
	}
	// A cut-off multi-byte character at the end of the sample isn't invalid: drop up to 3 trailing bytes.
	for cut := 0; cut <= 3 && cut < n; cut++ {
		if utf8.Valid(b[:n-cut]) {
			return true, ""
		}
	}
	return false, ""
}

var rangeRe = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// Serve is src/files.ts serve: a file's bytes, with Range, text capped at TextCap unless `all`, and binaries as
// attachments. The file is opened once and everything else reads that handle; the handle's real path is checked against
// the roots and the deny list again, so a link swapped in after ResolveIn can't redirect the read. An error is returned
// before anything is written.
func (p Paths) Serve(w http.ResponseWriter, r *http.Request, real string, all bool, roots []string) error {
	// Non-blocking, so a FIFO planted in a root can't hang the daemon until a writer shows up; the stat then refuses it.
	fd, err := syscall.Open(real, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return &os.PathError{Op: "open", Path: real, Err: err}
	}
	f := os.NewFile(uintptr(fd), real)
	defer f.Close()
	// No /proc (not Linux): the check made before the open stands.
	if now, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd)); err == nil {
		if !inRoots(now, roots) || p.Denied(now) {
			return refuse(403, "the file moved")
		}
	}
	st, err := f.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return refuse(400, "not a file")
	}
	size := st.Size()
	typ := TypeByExt(real)
	text, sniffed := sniff(f)
	switch {
	case strings.HasPrefix(typ, "text/") && !text:
		typ = "application/octet-stream"
		if sniffed != "" {
			typ = sniffed
		}
	case typ == "application/octet-stream" && text:
		typ = "text/plain; charset=utf-8"
	case typ == "application/octet-stream" && sniffed != "":
		typ = sniffed
	}
	isText := strings.HasPrefix(typ, "text/")
	h := w.Header()
	SetSafe(h)
	h.Set("Content-Type", typ)
	h.Set("X-Stam-Size", strconv.FormatInt(size, 10))
	media := strings.HasPrefix(typ, "image/") || strings.HasPrefix(typ, "video/") || strings.HasPrefix(typ, "audio/")
	if !isText && !media && typ != "application/pdf" {
		h.Set("Content-Disposition", `attachment; filename="`+SafeName(filepath.Base(real))+`"`)
	}
	if m := rangeRe.FindStringSubmatch(r.Header.Get("Range")); m != nil && (m[1] != "" || m[2] != "") {
		start, end := rangeOf(m[1], m[2], size)
		if start >= float64(size) || start > end {
			// The 416 carries only its range, as TS's writeHead replaces the headers set so far.
			for k := range h {
				delete(h, k)
			}
			h.Set("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return nil
		}
		from, to := int64(start), int64(end)
		h.Set("Content-Range", "bytes "+strconv.FormatInt(from, 10)+"-"+strconv.FormatInt(to, 10)+"/"+strconv.FormatInt(size, 10))
		h.Set("Content-Length", strconv.FormatInt(to-from+1, 10))
		w.WriteHeader(http.StatusPartialContent)
		send(w, f, from, to-from+1)
		return nil
	}
	n := size
	if isText && !all && size > TextCap {
		h.Set("X-Stam-Truncated", "1")
		n = TextCap
	}
	h.Set("Content-Length", strconv.FormatInt(n, 10))
	w.WriteHeader(http.StatusOK)
	if n > 0 {
		send(w, f, 0, n)
	}
	return nil
}

// rangeOf is the Range header's start and end as TS reads them: a missing start is a suffix of the last `end` bytes, a
// missing end is the file's end, and an end past the file is its last byte. Numbers, as JS's, so a huge one is no error.
func rangeOf(a, b string, size int64) (start, end float64) {
	num := func(s string) float64 { v, _ := strconv.ParseFloat(s, 64); return v }
	last := float64(size - 1)
	if a != "" {
		start = num(a)
	} else {
		start = max(0, float64(size)-num(b))
	}
	end = last
	if a != "" && b != "" {
		end = min(num(b), last)
	}
	return start, end
}

// send streams n bytes of f from off. A read that fails midway (a racing delete, an I/O error) ends the response short
// of its length, so the client sees it cut off, as TS destroys the response.
func send(w http.ResponseWriter, f *os.File, off, n int64) {
	_, _ = io.Copy(w, io.NewSectionReader(f, off, n))
}
