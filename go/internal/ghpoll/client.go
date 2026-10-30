package ghpoll

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// requestTimeout bounds one GitHub call.
const requestTimeout = 20 * time.Second

// maxBody bounds what one reply is read to.
const maxBody = 32 << 20

// Reply is one GET's answer. A 304 has no body.
type Reply struct {
	Status int
	Body   []byte
	ETag   string
	Link   string
	// Remaining and ResetAt are the rate-limit headers (ResetAt in ms), -1 when the reply had none.
	Remaining int64
	ResetAt   int64
	// RetryAfter is the retry-after header in ms, 0 when there is none.
	RetryAfter int64
}

// StatusError is a reply that makes the whole poll fail: the rate limit, or an error on the subject's own view. It names
// the status and path only, never a header or the token.
type StatusError struct {
	Status  int
	Path    string
	ResetAt int64
	// Global is GitHub's rate limit for the token (a 429, or a 403 that says the budget is spent, carries retry-after or names a rate limit in its body): every
	// subject waits. Any other failure, a 403 for permissions included, is the subject's own.
	Global bool
	// RetryAfter is the retry-after header in ms, 0 when there is none.
	RetryAfter int64
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("GitHub answered %d for %s", e.Status, e.Path)
}

// RateLimited is whether every subject must wait.
func (e *StatusError) RateLimited() bool { return e.Global }

// redact removes the token from an error's text. The token only travels in a header, which Go's errors don't echo, but a
// base URL or a proxy could carry it, so no error leaves this package with it.
func redact(err error, token string) error {
	if err == nil || token == "" {
		return err
	}
	msg := err.Error()
	if !strings.Contains(msg, token) {
		return err
	}
	return errors.New(strings.ReplaceAll(msg, token, "[redacted]"))
}

func headerNum(h http.Header, k string) int64 {
	v := h.Get(k)
	if v == "" {
		return -1
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return -1
	}
	return int64(n)
}

// get is one GET: If-None-Match with the stored ETag, a 304 meaning unchanged.
func (p *Poller) get(ctx context.Context, path, token, etag string) (Reply, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(p.o.Base(), "/")+path, nil)
	if err != nil {
		return Reply{}, redact(errors.New("GitHub request: "+path), token)
	}
	req.Header.Set("accept", "application/vnd.github+json")
	req.Header.Set("user-agent", "stam")
	req.Header.Set("authorization", "Bearer "+token)
	if etag != "" {
		req.Header.Set("if-none-match", etag)
	}
	res, err := p.o.HTTP.Do(req)
	if err != nil {
		// A transport error names the URL, which holds no secret, but is redacted all the same.
		return Reply{}, redact(fmt.Errorf("GitHub request %s: %w", path, redact(err, token)), token)
	}
	defer res.Body.Close()
	r := Reply{Status: res.StatusCode, ETag: res.Header.Get("etag"), Link: res.Header.Get("link"), Remaining: headerNum(res.Header, "x-ratelimit-remaining"), ResetAt: -1}
	if reset := headerNum(res.Header, "x-ratelimit-reset"); reset > 0 {
		r.ResetAt = reset * 1000
	}
	if ra := headerNum(res.Header, "retry-after"); ra > 0 {
		r.RetryAfter = ra * 1000
	}
	// An ETag that holds the token is never stored or sent back: the snapshot's ETags are kept in the database.
	if token != "" && strings.Contains(r.ETag, token) {
		r.ETag = ""
	}
	if res.StatusCode == 304 {
		r.ETag = etag
		return r, nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if err != nil {
		return Reply{}, redact(fmt.Errorf("GitHub reply %s: %w", path, redact(err, token)), token)
	}
	r.Body = body
	return r, nil
}

// decode reads a 200 reply's body into v; a body that isn't JSON fails the poll (TS throws on it).
func decode(r Reply, path string, v any) error {
	if err := json.Unmarshal(r.Body, v); err != nil {
		return fmt.Errorf("GitHub reply for %s is not the JSON expected", path)
	}
	return nil
}
