package mcpservers

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"stam/internal/jsjson"
)

// TestBrowseCache: a page is read from the cache for ten minutes, then fetched again; another search is its own page.
func TestBrowseCache(t *testing.T) {
	var fetches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		_, _ = w.Write([]byte(`{"servers": [{"server": {"name": "a", "version": "1"}}]}`))
	}))
	t.Cleanup(srv.Close)
	now := time.Unix(1000, 0)
	r := NewRegistry(func() string { return srv.URL })
	r.Now = func() time.Time { return now }
	ctx := context.Background()
	for i, want := range []int32{1, 1, 2} {
		if i == 2 {
			now = now.Add(cacheFor)
		}
		if _, err := r.Browse(ctx, "", ""); err != nil || fetches.Load() != want {
			t.Fatalf("browse %d: %v, %d fetches, want %d", i, err, fetches.Load(), want)
		}
	}
	if _, err := r.Browse(ctx, "other", ""); err != nil || fetches.Load() != 3 {
		t.Errorf("another search: %v, %d fetches", err, fetches.Load())
	}
	if _, err := NewRegistry(func() string { return "not a url" }).Browse(ctx, "", ""); err == nil || err.Error() != "Invalid URL" {
		t.Errorf("a bad base: %v", err)
	}
}

// TestCheckStdioTimeout: a stdio server that never answers is killed and reported after the timeout.
func TestCheckStdioTimeout(t *testing.T) {
	defer func(d time.Duration) { CheckTimeout = d }(CheckTimeout)
	CheckTimeout = 200 * time.Millisecond
	server, _ := jsjson.Parse([]byte(`{"command": "sh", "args": ["-c", "while read l; do :; done"]}`))
	start := time.Now()
	got := jsjson.Stringify(Check(context.Background(), "s", server, nil, noRedirects()), "")
	if got != `{"ok":false,"tools":[],"error":"No answer within 5 seconds."}` || time.Since(start) > 3*time.Second {
		t.Errorf("a silent server: %s after %s", got, time.Since(start))
	}
}

// TestCheckStdioGrandchild: a silent server whose child holds its stdout (npx's node) is killed with that child at
// the timeout, and reaped, not left a zombie.
func TestCheckStdioGrandchild(t *testing.T) {
	defer func(d time.Duration) { CheckTimeout = d }(CheckTimeout)
	CheckTimeout = 200 * time.Millisecond
	pids := filepath.Join(t.TempDir(), "pids")
	server := jsjson.NewObject("command", "sh", "args", []jsjson.Value{"-c", `sleep 30 & echo $$ $! > "$0"; while read l; do :; done`, pids})
	if got := jsjson.Stringify(Check(context.Background(), "s", server, nil, noRedirects()), ""); !strings.Contains(got, "No answer within 5 seconds.") {
		t.Fatalf("a silent server: %s", got)
	}
	b, err := os.ReadFile(pids)
	if err != nil {
		t.Fatal(err)
	}
	ids := strings.Fields(string(b))
	// gone is true once PID is neither running nor a zombie waiting to be reaped.
	gone := func(pid string) bool {
		_, err := os.Stat("/proc/" + pid)
		return err != nil
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !(gone(ids[0]) && gone(ids[1])) {
		time.Sleep(20 * time.Millisecond)
	}
	for i, what := range []string{"the server", "its child"} {
		if !gone(ids[i]) {
			stat, _ := os.ReadFile("/proc/" + ids[i] + "/stat")
			if pid, err := strconv.Atoi(ids[i]); err == nil {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
			t.Errorf("%s (%s) is still there: %s", what, ids[i], stat)
		}
	}
}

// TestTOMLDepthCap: arrays nested past maxDepth are dropped, so a pasted text of deep nesting parses in linear time;
// nesting within the cap is kept.
func TestTOMLDepthCap(t *testing.T) {
	deep := "[mcp_servers.a]\ncommand = \"x\"\nargs = " + strings.Repeat("[", 200000) + strings.Repeat("]", 200000) + "\n"
	start := time.Now()
	v, err := parseTOML(deep)
	if err != nil || time.Since(start) > 2*time.Second {
		t.Fatalf("deep nesting: %v after %s", err, time.Since(start))
	}
	if got := jsjson.Stringify(v, ""); !strings.Contains(got, `"command":"x","args":[[[[`) || strings.Count(got, "[") != maxDepth {
		t.Errorf("deep nesting kept: %.200s", got)
	}
	v, _ = parseTOML("[mcp_servers.a]\ncommand = \"x\"\nargs = [[\"a\", {b = [1]}]]\n")
	if got := jsjson.Stringify(v, ""); !strings.Contains(got, `"args":[["a",{"b":[1]}]]`) {
		t.Errorf("shallow nesting: %s", got)
	}
}

// TestCheckStdioAnswerThenExit: a server that answers and exits at once is read for its answer; its exit doesn't win
// the race (in TS it can, and the check then reports the exit).
func TestCheckStdioAnswerThenExit(t *testing.T) {
	script := `while read l; do case "$l" in *'"id":1'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;; *tools/list*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"t1"}]}}'; exit 0 ;; esac; done`
	server := jsjson.NewObject("command", "sh", "args", []jsjson.Value{"-c", script})
	for i := 0; i < 20; i++ {
		if got := jsjson.Stringify(Check(context.Background(), "s", server, nil, noRedirects()), ""); !strings.HasPrefix(got, `{"ok":true,`) || !strings.Contains(got, "t1") {
			t.Fatalf("run %d: %s", i, got)
		}
	}
}

// TestCheckRemoteNotJSON: a remote answer that isn't JSON is a fixed message that doesn't quote the body (TS's is
// V8's SyntaxError, which does).
func TestCheckRemoteNotJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>secret-ish page</html>"))
	}))
	t.Cleanup(srv.Close)
	server := jsjson.NewObject("url", srv.URL)
	if got := jsjson.Stringify(Check(context.Background(), "s", server, nil, noRedirects()), ""); got != `{"ok":false,"tools":[],"error":"the server's answer is not JSON"}` {
		t.Errorf("a page that isn't JSON: %s", got)
	}
}

// TestCheckStdioStderr: a server that exits says why on stderr, and that is the error.
func TestCheckStdioStderr(t *testing.T) {
	server, _ := jsjson.Parse([]byte(`{"command": "sh", "args": ["-c", "echo '  missing API_KEY ' >&2; exit 1"]}`))
	if got := jsjson.Stringify(Check(context.Background(), "s", server, nil, noRedirects()), ""); got != `{"ok":false,"tools":[],"error":"missing API_KEY"}` {
		t.Errorf("an exit with stderr: %s", got)
	}
}

// TestCheckRemoteBearer: a server with an auth gets the stored bearer, and a token that can't be had is the error,
// before any request.
func TestCheckRemoteBearer(t *testing.T) {
	var auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auths = append(auths, r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"id": 1, "result": {}}`))
	}))
	t.Cleanup(srv.Close)
	server, _ := jsjson.Parse([]byte(`{"url": "` + srv.URL + `", "auth": {"type": "oauth"}}`))
	ok := func(_ context.Context, name string) (string, error) { return "TOKEN-" + name, nil }
	if got := jsjson.Stringify(Check(context.Background(), "lin", server, ok, noRedirects()), ""); got != `{"ok":true,"tools":[]}` ||
		strings.Join(auths, ",") != "Bearer TOKEN-lin,Bearer TOKEN-lin,Bearer TOKEN-lin" {
		t.Errorf("with a token: %s %q", got, auths)
	}
	auths = nil
	fail := func(context.Context, string) (string, error) { return "", errors.New("lin is not logged in") }
	if got := jsjson.Stringify(Check(context.Background(), "lin", server, fail, noRedirects()), ""); got != `{"ok":false,"tools":[],"error":"lin is not logged in"}` || len(auths) != 0 {
		t.Errorf("without a token: %s %q", got, auths)
	}
}
