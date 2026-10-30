package linearpoll

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/jsjson"
	"stam/internal/mcpauth"
)

func clientFor(f *fakeLinear, token string) (*Client, *staticAuth) {
	a := &staticAuth{url: f.url(), token: token}
	return NewClient(a, nil), a
}

func callGet(c *Client, id string) (*jsjson.Object, error) {
	return c.CallTool(context.Background(), Server, "get_issue", jsjson.NewObject("id", id))
}

func TestClientCallsATool(t *testing.T) {
	f := newFake(t)
	f.setIssue("ENG-1", map[string]any{"id": "ENG-1", "title": "T"})
	c, _ := clientFor(f, goodToken)
	res, err := callGet(c, "ENG-1")
	if err != nil {
		t.Fatal(err)
	}
	if v := JSONOf(res); prop(v, "title") != "T" {
		t.Errorf("%v", v)
	}
	if _, err := callGet(c, "ENG-1"); err != nil || f.inits != 1 {
		t.Errorf("a second call reuses the session: err %v, %d initializes", err, f.inits)
	}
}

func TestClientReadsAnEventStreamAnswer(t *testing.T) {
	f := newFake(t)
	f.sse = true
	f.setIssue("ENG-1", map[string]any{"id": "ENG-1", "title": "T"})
	c, _ := clientFor(f, goodToken)
	res, err := callGet(c, "ENG-1")
	if err != nil || prop(JSONOf(res), "title") != "T" {
		t.Fatalf("%v %v", res, err)
	}
}

// A bearer the server refuses at initialize is an error, as in TS (initialize is not retried; tokenFor refreshes a token near
// its expiry before it gets here).
func TestClientABadBearerFailsAtInitialize(t *testing.T) {
	f := newFake(t)
	c, _ := clientFor(f, "stale")
	if _, err := callGet(c, "ENG-1"); err == nil || !strings.Contains(err.Error(), "initialize HTTP 401") {
		t.Fatalf("a bad bearer answered %v", err)
	}
}

func TestClientRetriesA401OnToolsCallWithARefreshedToken(t *testing.T) {
	f := newFake(t)
	f.setIssue("ENG-1", map[string]any{"id": "ENG-1", "title": "T"})
	// The first tools/call is refused; the retry carries the refreshed bearer and lands.
	var denied atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if bytes.Contains(readBody(r), []byte(`"tools/call"`)) && !denied.Swap(true) {
			w.WriteHeader(401)
			return
		}
		f.srv.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	a := &staticAuth{url: srv.URL + "/mcp", token: goodToken, refreshed: goodToken}
	c := NewClient(a, nil)
	res, err := callGet(c, "ENG-1")
	if err != nil || prop(JSONOf(res), "title") != "T" {
		t.Fatalf("%v %v", res, err)
	}
	if a.forced != 1 {
		t.Errorf("%d refreshes, want 1", a.forced)
	}
}

func readBody(r *http.Request) []byte {
	var b bytes.Buffer
	_, _ = b.ReadFrom(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(b.Bytes()))
	return b.Bytes()
}

func TestClientStartsAgainOnAnExpiredSession(t *testing.T) {
	f := newFake(t)
	f.setIssue("ENG-1", map[string]any{"id": "ENG-1"})
	c, _ := clientFor(f, goodToken)
	if _, err := callGet(c, "ENG-1"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.session = "second-session"
	f.mu.Unlock()
	if _, err := callGet(c, "ENG-1"); err != nil {
		t.Fatalf("an expired session is not started again: %v", err)
	}
	if f.inits != 2 {
		t.Errorf("%d initializes, want 2", f.inits)
	}
}

func TestClientFollowsNoRedirect(t *testing.T) {
	var hits atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	t.Cleanup(other.Close)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/mcp", http.StatusFound)
	}))
	t.Cleanup(srv.Close)
	c := NewClient(&staticAuth{url: srv.URL + "/mcp", token: goodToken}, nil)
	_, err := callGet(c, "ENG-1")
	if err == nil || !strings.Contains(err.Error(), "HTTP 302") {
		t.Fatalf("a redirect answered %v, want an HTTP 302 error", err)
	}
	if hits.Load() != 0 {
		t.Error("the bearer was sent on to the redirect target")
	}
}

func TestClientErrorsAndToolFailuresNameNoSecret(t *testing.T) {
	f := newFake(t)
	f.echo = true
	f.sse = false
	c, _ := clientFor(f, "wrong-bearer-secret-value")
	// The server echoes the bearer it was sent: neither the status error nor the tool error may repeat it.
	_, err := callGet(c, "ENG-1")
	if err == nil {
		t.Fatal("a wrong bearer succeeded")
	}
	if strings.Contains(err.Error(), "wrong-bearer-secret-value") {
		t.Errorf("the error carries the bearer: %v", err)
	}
	c2, _ := clientFor(f, goodToken)
	_, err = callGet(c2, "NOPE-1")
	if err == nil || !strings.Contains(err.Error(), "no issue NOPE-1") {
		t.Fatalf("a failing tool answered %v", err)
	}
	if strings.Contains(err.Error(), goodToken) {
		t.Errorf("the tool error carries the bearer: %v", err)
	}
	// A transport error (nothing listens) names neither the bearer nor the url.
	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL + "/mcp"
	dead.Close()
	c3 := NewClient(&staticAuth{url: url, token: goodToken}, nil)
	_, err = callGet(c3, "ENG-1")
	if err == nil || strings.Contains(err.Error(), goodToken) || strings.Contains(err.Error(), url) {
		t.Errorf("a transport error answered %v", err)
	}
}

func TestClientTimesOutARequest(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	t.Cleanup(func() { close(release); srv.Close() })
	c := NewClient(&staticAuth{url: srv.URL + "/mcp", token: goodToken}, &http.Client{Timeout: 50 * time.Millisecond})
	start := time.Now()
	if _, err := callGet(c, "ENG-1"); err == nil {
		t.Fatal("a hung server answered")
	}
	if time.Since(start) > 5*time.Second {
		t.Error("the call did not time out")
	}
	if NewClient(&staticAuth{}, nil).http.Timeout != 20*time.Second {
		t.Error("the default timeout is not 20 s")
	}
}

func TestClientStopsWithItsContext(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	t.Cleanup(func() { close(release); srv.Close() })
	c := NewClient(&staticAuth{url: srv.URL + "/mcp", token: goodToken}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.CallTool(ctx, Server, "get_issue", jsjson.NewObject()); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Error("a cancelled call succeeded")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled call hangs")
	}
}

func TestClientGivesTokenErrorsThrough(t *testing.T) {
	want := errors.New("not logged in")
	c := NewClient(failAuth{want}, nil)
	if _, err := callGet(c, "ENG-1"); !errors.Is(err, want) {
		t.Errorf("%v", err)
	}
}

type failAuth struct{ err error }

func (a failAuth) TokenFor(context.Context, string, bool) (b mcpauth.Bearer, err error) {
	return b, a.err
}
