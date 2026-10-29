package llm

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"syscall"
	"time"

	"stam/internal/jsjson"
)

// Small HTTP helpers the adapters share (src/llm/http.ts).

// retryAfterMax caps a Retry-After header at 5 minutes.
const retryAfterMax = 5 * time.Minute

// bodyMax bounds a provider's answer; TS reads any size.
const bodyMax = 8 << 20

// HTTPError is src/llm/types.ts LlmHttpError: a call that answered non-2xx. RetryAfter is the Retry-After header, when
// HasRetryAfter.
type HTTPError struct {
	Status        int
	RetryAfter    time.Duration
	HasRetryAfter bool
	// Message replaces `HTTP <status>` when set: fixed text that quotes nothing.
	Message string
}

func (e *HTTPError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("HTTP %d", e.Status)
}

// RetryAfter is retryAfterMs: seconds, or an HTTP date, capped at 5 minutes. It is false when the header is absent or
// unreadable.
func RetryAfter(h string) (time.Duration, bool) {
	if h == "" {
		return 0, false
	}
	var d time.Duration
	if secs, err := strconv.ParseFloat(h, 64); err == nil {
		d = time.Duration(secs * float64(time.Second))
	} else if t, err := http.ParseTime(h); err == nil {
		d = time.Until(t)
	} else {
		return 0, false
	}
	return min(max(d, 0), retryAfterMax), true
}

// errRedirect is a redirect refused (fetch's redirect: 'error'), which fetch throws as a TypeError.
var errRedirect = errors.New("unexpected redirect")

// TransportCode is the cause's code (ECONNREFUSED) or the error's name (TimeoutError, AbortError, TypeError), as send
// rethrows it.
func TransportCode(err error) string {
	var dns *net.DNSError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "TimeoutError"
	case errors.Is(err, context.Canceled):
		return "AbortError"
	case errors.Is(err, errRedirect):
		return "TypeError"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "ECONNREFUSED"
	case errors.Is(err, syscall.ECONNRESET):
		return "ECONNRESET"
	case errors.As(err, &dns):
		return "ENOTFOUND"
	}
	return "Error"
}

// failed is send's rethrow: fixed text, since the library's own error can quote a header, a key among them.
func failed(err error) error { return errors.New("request failed: " + TransportCode(err)) }

// noRedirects is a client that refuses a redirect, as fetch's redirect: 'error' does.
func noRedirects(c *http.Client) *http.Client {
	n := *c
	n.CheckRedirect = func(*http.Request, []*http.Request) error { return errRedirect }
	return &n
}

// post sends a JSON body and parses the answer. A non-2xx answer is an *HTTPError; a transport failure or an answer
// that is not JSON is fixed text that quotes nothing of the request or the answer. Every call refuses a redirect, which
// is stricter than TS, where only the OpenAI-compatible and Azure adapters do: Go's client keeps the authorization
// header on a same-host or subdomain redirect and a 307 resends the body, so a redirect could carry a key elsewhere.
func post(ctx context.Context, client *http.Client, url string, headers map[string]string, body string) (jsjson.Value, error) {
	client = noRedirects(client)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader([]byte(body)))
	if err != nil {
		return nil, failed(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("content-type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return nil, failed(err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		ra, has := RetryAfter(res.Header.Get("retry-after"))
		return nil, &HTTPError{Status: res.StatusCode, RetryAfter: ra, HasRetryAfter: has}
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, bodyMax))
	if err != nil {
		return nil, failed(err)
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		// res.json() throws a SyntaxError that quotes the answer; this names only what it is.
		return nil, errors.New("the answer is not JSON")
	}
	return v, nil
}
