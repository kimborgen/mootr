package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const tok = "super-secret-token-value"

func envOf(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

// seen is what a stub saw of a request.
type seen struct {
	method, path, auth, human, ctype string
	body                             string
}

func stub(t *testing.T, status int, reply string, got *seen) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*got = seen{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), r.Header.Get("X-Stam-Human"), r.Header.Get("Content-Type"), string(b)}
		w.WriteHeader(status)
		io.WriteString(w, reply)
	}))
	t.Cleanup(s.Close)
	return s
}

func TestHumanHeaderAndToken(t *testing.T) {
	var got seen
	s := stub(t, 200, `{"ok":true}`, &got)
	base := map[string]string{"STAM_URL": s.URL, "STAM_TOKEN": tok}
	c := New(envOf(base))
	if _, err := c.Do(context.Background(), "POST", "/api/agents", map[string]any{"name": "a<b>"}, 0); err != nil {
		t.Fatal(err)
	}
	if got.auth != "Bearer "+tok || got.human != "1" || got.ctype != "application/json" || got.method != "POST" {
		t.Errorf("request = %+v", got)
	}
	if got.body != `{"name":"a<b>"}` {
		t.Errorf("body %q: JS doesn't escape HTML", got.body)
	}

	// An agent's CLI acts as the agent: no x-stam-human.
	base["STAM_AGENT_ID"] = "a1"
	if _, err := New(envOf(base)).Do(context.Background(), "POST", "/api/agents", nil, 0); err != nil {
		t.Fatal(err)
	}
	if got.human != "" {
		t.Errorf("an agent's call sent x-stam-human %q", got.human)
	}

	// System reads and writes send none either (S-601).
	delete(base, "STAM_AGENT_ID")
	for _, call := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/health", nil},
		{"GET", "/api/agents?q=x", nil},
		{"GET", "/api/itsas/S-12", nil},
		{"POST", "/api/mail", map[string]any{"system": "deploy-watch"}},
		{"PATCH", "/api/itsas/S-1", map[string]any{"as_system": true}},
	} {
		if _, err := New(envOf(base)).Do(context.Background(), call.method, call.path, call.body, 0); err != nil {
			t.Fatal(err)
		}
		if got.human != "" {
			t.Errorf("%s %s sent x-stam-human", call.method, call.path)
		}
	}
	if _, err := New(envOf(base)).Do(context.Background(), "GET", "/api/agents/a1", nil, 0); err != nil {
		t.Fatal(err)
	}
	if got.human != "1" {
		t.Error("GET /api/agents/a1 is the human's call")
	}
}

func TestTokenSources(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "token"), []byte(" file-token \n"), 0o600)
	if got := ReadToken(envOf(map[string]string{"STAM_HOME": home})).Reveal(); got != "file-token" {
		t.Errorf("file token %q", got)
	}
	if got := ReadToken(envOf(map[string]string{"STAM_HOME": home, "STAM_TOKEN": "env-token"})).Reveal(); got != "env-token" {
		t.Errorf("env token %q: STAM_TOKEN wins", got)
	}
	if got := ReadToken(envOf(map[string]string{"STAM_HOME": t.TempDir()})).Reveal(); got != "" {
		t.Errorf("missing file gave %q", got)
	}
}

func TestBaseURL(t *testing.T) {
	for _, c := range []struct {
		env  map[string]string
		want string
	}{
		{nil, "http://127.0.0.1:7878"},
		{map[string]string{"STAM_PORT": "9001"}, "http://127.0.0.1:9001"},
		{map[string]string{"STAM_URL": "http://h:1/", "STAM_PORT": "9"}, "http://h:1"},
	} {
		if got := BaseURL(envOf(c.env)); got != c.want {
			t.Errorf("%v: %q, want %q", c.env, got, c.want)
		}
	}
}

func TestErrorEnvelope(t *testing.T) {
	var got seen
	for _, c := range []struct {
		status int
		reply  string
		want   string
	}{
		{404, `{"error":"no such agent"}`, "no such agent"},
		{403, `{"error":"refused","hint":"answer in the web UI"}`, "refused; answer in the web UI"},
		{500, `{"hint":"x"}`, "HTTP 500"},
		{502, `<html>bad gateway</html>`, "HTTP 502"},
		{501, `{"error":"not ported"}`, "not ported"},
	} {
		s := stub(t, c.status, c.reply, &got)
		_, err := New(envOf(map[string]string{"STAM_URL": s.URL, "STAM_TOKEN": tok})).Do(context.Background(), "GET", "/x", nil, 0)
		var e *Error
		if !errors.As(err, &e) || e.Status != c.status || e.Message != c.want {
			t.Errorf("%d %s: %v, want %q", c.status, c.reply, err, c.want)
		}
	}
}

func TestTimeoutAndRefused(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer slow.Close()
	start := time.Now()
	_, err := New(envOf(map[string]string{"STAM_URL": slow.URL, "STAM_TOKEN": tok})).Do(context.Background(), "GET", "/x", nil, 100*time.Millisecond)
	if err == nil || ConnRefused(err) || time.Since(start) > 3*time.Second {
		t.Fatalf("timeout gave %v after %s", err, time.Since(start))
	}

	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	_, err = New(envOf(map[string]string{"STAM_URL": "http://" + addr, "STAM_TOKEN": tok})).Do(context.Background(), "GET", "/x", nil, 0)
	if !ConnRefused(err) {
		t.Fatalf("a closed port gave %v, not a refused connection", err)
	}
}

// The token and the URL's credentials never reach an error.
func TestErrorsLeakNothing(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := l.Addr().String()
	l.Close()
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer slow.Close()
	for _, u := range []string{"http://user:pw-secret@" + addr, strings.Replace(slow.URL, "http://", "http://user:pw-secret@", 1)} {
		_, err := New(envOf(map[string]string{"STAM_URL": u, "STAM_TOKEN": tok})).Do(context.Background(), "GET", "/x", nil, 100*time.Millisecond)
		if err == nil {
			t.Fatal("no error")
		}
		for _, secret := range []string{tok, "pw-secret", "Bearer"} {
			if strings.Contains(err.Error(), secret) {
				t.Errorf("error %q leaks %q", err, secret)
			}
		}
	}
	if s := New(envOf(map[string]string{"STAM_TOKEN": tok})); strings.Contains(fmt.Sprintf("%v %+v", s, s), tok) {
		t.Error("the client prints its token")
	}
}

// The token and the agent id are read at each call, not when the client is made (S-2817): `register` sets both late.
func TestTokenAndIdentityReadPerCall(t *testing.T) {
	var got seen
	s := stub(t, 200, `{}`, &got)
	vars := map[string]string{"STAM_URL": s.URL, "STAM_TOKEN": "first"}
	c := New(func(k string) string { return vars[k] })
	c.Do(context.Background(), "POST", "/x", nil, 0)
	if got.auth != "Bearer first" || got.human != "1" {
		t.Fatalf("first call %+v", got)
	}
	vars["STAM_TOKEN"], vars["STAM_AGENT_ID"] = "second", "a1"
	c.Do(context.Background(), "POST", "/x", nil, 0)
	if got.auth != "Bearer second" || got.human != "" {
		t.Fatalf("second call %+v", got)
	}
}

func TestStream(t *testing.T) {
	var got seen
	s := stub(t, 200, "data: {}\n\n", &got)
	body, err := New(envOf(map[string]string{"STAM_URL": s.URL, "STAM_TOKEN": tok})).Stream(context.Background(), "/api/agents/a1/stream")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(body)
	body.Close()
	if string(b) != "data: {}\n\n" || got.auth != "Bearer "+tok || got.human != "" {
		t.Errorf("stream %q %+v", b, got)
	}
	s2 := stub(t, 404, `{"error":"no route"}`, &got)
	_, err = New(envOf(map[string]string{"STAM_URL": s2.URL})).Stream(context.Background(), "/x")
	var e *Error
	if !errors.As(err, &e) || e.Message != "no route" {
		t.Errorf("404 stream: %v", err)
	}
}
