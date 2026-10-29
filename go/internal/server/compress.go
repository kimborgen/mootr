package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/andybalholm/brotli"

	"stam/internal/jsjson"
)

// What the daemon sends over HTTP is compressed (src/compress.ts): JSON answers and the web UI's static files, brotli
// when the client takes it, else gzip. Streams (SSE, terminal sockets) never come through here.

// minCompress is the smallest body compressed: under it, compressing saves less than the header costs.
const minCompress = 1024

// fastCompress is the body size from which the fastest level is used (src/compress.ts FAST_BYTES): JSON shrinks most of
// the way even at level 1.
const fastCompress = 256 * 1024

// acceptedEncoding is src/compress.ts acceptedEncoding: "br" or "gzip" when the Accept-Encoding header takes it (q > 0),
// brotli first, else "".
func acceptedEncoding(header string) string {
	accept := map[string]float64{}
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.ToLower(jsjson.Trim(part)), ";")
		q := 1.0
		for _, p := range fields[1:] {
			if p = jsjson.Trim(p); strings.HasPrefix(p, "q=") {
				q = jsjson.ToNumber(p[2:])
				break
			}
		}
		accept[fields[0]] = q
	}
	// NaN > 0 is false, as in JavaScript.
	switch {
	case accept["br"] > 0:
		return "br"
	case accept["gzip"] > 0:
		return "gzip"
	}
	return ""
}

// encodeBody is src/compress.ts encodeBody: brotli at quality 4 or gzip at level 6, the fastest level for a big body.
func encodeBody(body []byte, enc string) []byte {
	fast := len(body) >= fastCompress
	var buf bytes.Buffer
	if enc == "br" {
		q := 4
		if fast {
			q = 1
		}
		w := brotli.NewWriterLevel(&buf, q)
		w.Write(body)
		w.Close()
		return buf.Bytes()
	}
	level := 6
	if fast {
		level = 1
	}
	w, _ := gzip.NewWriterLevel(&buf, level)
	w.Write(body)
	w.Close()
	return buf.Bytes()
}

// sendCompressed is src/compress.ts sendCompressed: body with its status, compressed when the request takes it and the
// body is big enough. encoded, when not nil, gives the body already compressed for an encoding (a static file's cache).
func sendCompressed(w http.ResponseWriter, r *http.Request, status int, body []byte, encoded func(enc string) []byte) {
	enc := ""
	if len(body) >= minCompress {
		enc = acceptedEncoding(r.Header.Get("Accept-Encoding"))
	}
	h := w.Header()
	// Vary either way: a cache must not hand a compressed copy to a client that can't read it. A peer UI's answer
	// keeps its Vary: origin beside it (TS's writeHead replaces it).
	if v := h.Get("Vary"); v != "" && v != "accept-encoding" {
		h.Set("Vary", v+", accept-encoding")
	} else {
		h.Set("Vary", "accept-encoding")
	}
	out := body
	if enc != "" {
		if encoded != nil {
			out = encoded(enc)
		} else {
			out = encodeBody(body, enc)
		}
		h.Set("Content-Encoding", enc)
	}
	h.Set("Content-Length", strconv.Itoa(len(out)))
	w.WriteHeader(status)
	w.Write(out)
}

// jsonCompressor holds back a JSON answer (Content-Type application/json, written by writeJSON) until the route is done,
// then sends it compressed as sendCompressed does. Anything else, a stream or a file, passes through as it is written.
type jsonCompressor struct {
	http.ResponseWriter
	r         *http.Request
	held      bool
	status    int
	buf       bytes.Buffer
	wroteHead bool
	// hint is added to a 403's envelope (writeError): under auth.humanStrict, where a client that claims the human
	// without the proof is told to answer from the web UI.
	hint string
	// localLogin, when set, says whether a 403's envelope carries `localLogin: true` (writeError, S-2121): asked only
	// on a 403, since it reads the kernel's socket table.
	localLogin func() bool
}

func (c *jsonCompressor) WriteHeader(status int) {
	if c.wroteHead {
		return
	}
	c.wroteHead = true
	h := c.Header()
	if h.Get("Content-Type") == "application/json" && h.Get("Content-Encoding") == "" {
		c.held, c.status = true, status
		return
	}
	c.ResponseWriter.WriteHeader(status)
}

func (c *jsonCompressor) Write(b []byte) (int, error) {
	if !c.wroteHead {
		c.WriteHeader(http.StatusOK)
	}
	if c.held {
		return c.buf.Write(b)
	}
	return c.ResponseWriter.Write(b)
}

// Flush passes a stream's flush on; a held answer is sent whole at finish.
func (c *jsonCompressor) Flush() {
	if c.held {
		return
	}
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack hands a terminal socket's connection over (an upgrade writes no JSON).
func (c *jsonCompressor) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := c.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, errors.New("the connection can't be taken over")
}

// Unwrap lets http.ResponseController reach the connection.
func (c *jsonCompressor) Unwrap() http.ResponseWriter { return c.ResponseWriter }

// finish sends a held answer.
func (c *jsonCompressor) finish() {
	if !c.held {
		return
	}
	c.held = false
	sendCompressed(c.ResponseWriter, c.r, c.status, c.buf.Bytes(), nil)
}
