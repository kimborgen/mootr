package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const token = "cli-test-token-value"

// call is what the stub daemon saw.
type call struct {
	method, path, auth, human string
	body                      string
}

// daemonStub answers each "METHOD /path" with a status and body, and records the calls.
type daemonStub struct {
	*httptest.Server
	mu    sync.Mutex
	calls []call
}

func newStub(t *testing.T, routes map[string]func(n int) (int, string)) *daemonStub {
	t.Helper()
	s := &daemonStub{}
	counts := map[string]int{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		key := r.Method + " " + r.URL.Path
		s.mu.Lock()
		s.calls = append(s.calls, call{r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"), r.Header.Get("X-Stam-Human"), string(b)})
		counts[key]++
		n := counts[key]
		s.mu.Unlock()
		h, ok := routes[key]
		if !ok {
			w.WriteHeader(501)
			io.WriteString(w, `{"error":"not ported to the Go daemon yet"}`)
			return
		}
		status, body := h(n)
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(s.Close)
	return s
}

func fixed(status int, body string) func(int) (int, string) {
	return func(int) (int, string) { return status, body }
}

// out is a command's result.
type out struct {
	code           int
	stdout, stderr string
}

func runCLI(t *testing.T, vars map[string]string, stdin string, args ...string) out {
	t.Helper()
	var o, er bytes.Buffer
	home := t.TempDir()
	env := map[string]string{"STAM_HOME": home, "STAM_TOKEN": token}
	for k, v := range vars {
		env[k] = v
	}
	e := env2(env, &o, &er, stdin)
	code := run(context.Background(), args, e)
	return out{code, o.String(), er.String()}
}

func env2(vars map[string]string, stdout, stderr io.Writer, stdin string) env {
	return env{
		getenv: func(k string) string { return vars[k] },
		stdin:  strings.NewReader(stdin),
		stdout: stdout, stderr: stderr,
		cwd: func() (string, error) { return "/work/dir", nil },
		environ: func() []string {
			l := os.Environ()
			for k, v := range vars {
				l = append(l, k+"="+v)
			}
			return l
		},
	}
}

func TestShowReindentsTheReply(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/agents/worker": fixed(200, `{"id":"a1","name":"worker","context_tokens":4200,"last_message":"DONE","tags":[],"x":{"y":null}}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "show", "worker")
	want := "{\n  \"id\": \"a1\",\n  \"name\": \"worker\",\n  \"context_tokens\": 4200,\n  \"last_message\": \"DONE\",\n  \"tags\": [],\n  \"x\": {\n    \"y\": null\n  }\n}\n"
	if o.code != 0 || o.stdout != want {
		t.Fatalf("show = %+v\nwant stdout %q", o, want)
	}
	if !strings.Contains(o.stdout, `"context_tokens": 4200`) || !strings.Contains(o.stdout, "DONE") {
		t.Fatal("e2e-m1's greps wouldn't match")
	}
	if c := s.calls[0]; c.auth != "Bearer "+token || c.human != "1" {
		t.Errorf("call = %+v", c)
	}
}

func TestEventsLines(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/agents/worker/events": fixed(200, `[{"ts":"2026-10-20T10:00:00.000Z","type":"hook:UserPromptSubmit","data":null},{"ts":"2026-10-20T10:00:01.000Z","type":"hook:Stop","data":"{\"x\":1}"}]`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "events", "worker", "--type", "hook:*", "--limit", "20")
	want := "2026-10-20T10:00:00.000Z hook:UserPromptSubmit \n2026-10-20T10:00:01.000Z hook:Stop {\"x\":1}\n"
	if o.code != 0 || o.stdout != want {
		t.Fatalf("events = %+v\nwant %q", o, want)
	}
	if got := s.calls[0].path; got != "/api/agents/worker/events?limit=20&type=hook%3A%2A" {
		t.Errorf("path %q", got)
	}
	for _, e := range []string{"UserPromptSubmit", "Stop"} {
		if !strings.Contains(o.stdout, "hook:"+e) {
			t.Errorf("no hook:%s line", e)
		}
	}
}

func TestKillForget(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/agents/worker/kill":   fixed(200, `{"name":"worker"}`),
		"POST /api/agents/worker/forget": fixed(200, `{"agent":{},"result":"forgot worker"}`),
	})
	v := map[string]string{"STAM_URL": s.URL}
	if o := runCLI(t, v, "", "kill", "worker"); o.code != 0 || o.stdout != "killed worker\n" {
		t.Errorf("kill = %+v", o)
	}
	if o := runCLI(t, v, "", "forget", "worker"); o.code != 0 || o.stdout != "forgot worker\n" {
		t.Errorf("forget = %+v", o)
	}
}

func TestWait(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/agents/worker": func(n int) (int, string) {
			if n < 2 {
				return 200, `{"name":"worker","lifecycle":"active","activity":"working","activity_detail":null}`
			}
			return 200, `{"name":"worker","lifecycle":"active","activity":"idle","activity_detail":"at prompt","resting":null}`
		},
		"GET /api/agents/gone": fixed(200, `{"name":"gone","lifecycle":"shut_down"}`),
		"GET /api/agents/rest": fixed(200, `{"name":"rest","lifecycle":"active","activity":"idle","resting":{"since":"x"}}`),
	})
	v := map[string]string{"STAM_URL": s.URL}
	if o := runCLI(t, v, "", "wait", "worker", "--until", "idle,blocked", "--timeout", "10"); o.code != 0 || o.stdout != "worker: idle at prompt\n" {
		t.Errorf("wait = %+v", o)
	}
	if o := runCLI(t, v, "", "wait", "gone", "--until=shut_down", "--timeout=5"); o.code != 0 || o.stdout != "gone: shut_down \n" {
		t.Errorf("wait lifecycle = %+v", o)
	}
	if o := runCLI(t, v, "", "wait", "rest", "--until", "resting"); o.code != 0 || o.stdout != "rest: resting \n" {
		t.Errorf("wait resting = %+v", o)
	}
	o := runCLI(t, v, "", "wait", "gone", "--until", "idle", "--timeout", "0.3")
	if o.code != 2 || o.stderr != "timed out waiting for idle\n" || o.stdout != "" {
		t.Errorf("timeout = %+v", o)
	}
}

func TestSpawnBodyAndOutput(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/agents": fixed(200, `{"id":"a9","name":"w","warning":"slow disk"}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "spawn", "w", "--model", "claude-haiku-5-5", "--cwd", "/d", "--var", "A=1", "--var", "B=x=y", "--standing", "--workspace=mine", "Run", "it")
	if o.code != 0 || o.stdout != "spawned w (a9); attach with: stam attach w\n" || o.stderr != "warning: slow disk\n" {
		t.Fatalf("spawn = %+v", o)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(s.calls[0].body), &body); err != nil {
		t.Fatal(err)
	}
	want := `{"brief_vars":{"A":"1","B":"x=y"},"cwd":"/d","model":"claude-haiku-5-5","name":"w","prompt":"Run it","standing":true,"workspace":"mine"}`
	got, _ := json.Marshal(body)
	if string(got) != want {
		t.Errorf("body %s\nwant %s", got, want)
	}

	// The working directory is the default cwd; a bare --workspace is true.
	runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "spawn", "w2", "--workspace")
	var b2 map[string]any
	json.Unmarshal([]byte(s.calls[1].body), &b2)
	if b2["cwd"] != "/work/dir" || b2["workspace"] != true {
		t.Errorf("defaults: %v", b2)
	}
}

func TestSpawnOutputs(t *testing.T) {
	for _, c := range []struct{ reply, want string }{
		{`{"queued":true,"name":"q","place":2,"queue_length":3,"machine":"m1","cap":4,"holders":["a","b"]}`,
			"queued q: place 2 of 3 for a developer slot on m1 (4 in use: a, b); it starts when a slot frees\n"},
		{`{"kind":"ring","ring":{"name":"r","id":"r1"},"members":[{"name":"x"},{"name":"y"}],"moderator":{"name":"mod"}}`,
			"started ring r (r1); members x, y; moderator mod; result by mail; see: stam ring r\n"},
	} {
		s := newStub(t, map[string]func(int) (int, string){"POST /api/agents": fixed(200, c.reply)})
		if o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "spawn", "q"); o.code != 0 || o.stdout != c.want {
			t.Errorf("spawn %s = %+v\nwant %q", c.reply, o, c.want)
		}
	}
}

func TestSpawnUsageAndWorkspaceWord(t *testing.T) {
	o := runCLI(t, nil, "", "spawn")
	if o.code != 1 || o.stdout != "" || !strings.HasPrefix(o.stderr, "  stam spawn NAME") {
		t.Errorf("no name = %+v", o)
	}
	if o := runCLI(t, nil, "", "spawn", "--help"); o.code != 0 || !strings.HasPrefix(o.stdout, "  stam spawn NAME") {
		t.Errorf("help = %+v", o)
	}
	o = runCLI(t, nil, "", "spawn", "w", "--workspace", "name")
	if o.code != 1 || !strings.Contains(o.stderr, "use --workspace=name") {
		t.Errorf("separate word = %+v", o)
	}
}

// An error is `stam: MESSAGE` on stderr and exit 1, and the token is in none of the output.
func TestErrorsAndNoLeak(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/agents/nobody": fixed(404, `{"error":"no agent nobody"}`),
	})
	v := map[string]string{"STAM_URL": s.URL}
	o := runCLI(t, v, "", "show", "nobody")
	if o.code != 1 || o.stderr != "stam: no agent nobody\n" || o.stdout != "" {
		t.Errorf("404 = %+v", o)
	}
	// A route the Go daemon doesn't serve yet answers 501 with the envelope.
	o = runCLI(t, v, "", "kill", "nobody")
	if o.code != 1 || o.stderr != "stam: not ported to the Go daemon yet\n" {
		t.Errorf("501 = %+v", o)
	}
	o = runCLI(t, map[string]string{"STAM_URL": "http://127.0.0.1:1"}, "", "show", "x")
	if o.code != 1 || strings.Contains(o.stderr+o.stdout, token) || !strings.HasPrefix(o.stderr, "stam: ") {
		t.Errorf("refused = %+v", o)
	}
}

func TestUsage(t *testing.T) {
	for _, args := range [][]string{nil, {"help"}, {"--help"}} {
		if o := runCLI(t, nil, "", args...); o.code != 0 || !strings.HasPrefix(o.stdout, "usage: stam") {
			t.Errorf("%v = %+v", args, o)
		}
	}
	// A command the Go CLI doesn't have yet fails, so a script never takes the usage text for an answer.
	for _, cmd := range []string{"ls", "nonsense"} {
		if o := runCLI(t, nil, "", cmd); o.code != 1 || o.stdout != "" || o.stderr != "stam: "+cmd+" is not ported to the Go CLI yet\n" {
			t.Errorf("%s = %+v", cmd, o)
		}
	}
	if o := runCLI(t, nil, "", "daemon", "bogus"); o.code != 1 || o.stderr != "stam: unknown daemon command bogus\n" {
		t.Errorf("bogus = %+v", o)
	}
}

func TestDaemonStatusPrintsHealth(t *testing.T) {
	s := newStub(t, map[string]func(int) (int, string){
		"GET /api/health": fixed(200, `{"ok":true,"machine":"test-machine","memory":{"heapUsed":1,"heapTotal":2,"rss":3,"external":0},"stalls":[]}`),
	})
	o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "", "daemon", "status")
	if o.code != 0 || !strings.Contains(o.stdout, "machine: 'test-machine'") || !strings.HasPrefix(o.stdout, "{\n  ok: true,\n") {
		t.Errorf("status = %+v", o)
	}
	o = runCLI(t, map[string]string{"STAM_URL": "http://127.0.0.1:1"}, "", "daemon", "status")
	if o.code != 1 || o.stdout != "stamd not running\n" {
		t.Errorf("down = %+v", o)
	}
}

func hookStub(t *testing.T, status int, reply string) (*daemonStub, map[string]string) {
	t.Helper()
	s := newStub(t, map[string]func(int) (int, string){
		"POST /api/hook/claude/a1":       fixed(status, reply),
		"POST /api/statusline/claude/a1": fixed(200, `{"viewed":true}`),
	})
	return s, map[string]string{"STAM_URL": s.URL, "STAM_AGENT_ID": "a1"}
}

func TestHookPrintsStdoutByteForByte(t *testing.T) {
	payload := `{"hook_event_name":"Stop","big":"` + strings.Repeat("x", 200_000) + `"}`
	s, v := hookStub(t, 200, `{"ok":true,"stdout":"{\"decision\":\"block\"}\nline2 é\n\t"}`)
	o := runCLI(t, v, payload, "hook", "claude")
	if o.code != 0 || o.stdout != "{\"decision\":\"block\"}\nline2 é\n\t" || o.stderr != "" {
		t.Fatalf("hook = %+v", o)
	}
	c := s.calls[0]
	if c.body != payload || c.human != "" || c.auth != "Bearer "+token {
		t.Errorf("call: body kept %v, human %q, auth %q", c.body == payload, c.human, c.auth)
	}
	// No stdout member, an empty one, or an error reply: silent exit 0.
	for _, reply := range []string{`{"ok":true}`, `{"stdout":""}`, `{"stdout":null}`, `{"error":"nope"}`, `not json`, ``} {
		_, v := hookStub(t, 200, reply)
		if o := runCLI(t, v, "{}", "hook", "claude"); o.code != 0 || o.stdout != "" || o.stderr != "" {
			t.Errorf("reply %q gave %+v", reply, o)
		}
	}
	_, v = hookStub(t, 500, `{"error":"boom","stdout":"x"}`)
	if o := runCLI(t, v, "{}", "hook", "claude"); o.code != 0 {
		t.Errorf("500 = %+v", o)
	}
}

func TestHookWithoutAgentIDOrDaemon(t *testing.T) {
	s, _ := hookStub(t, 200, `{"stdout":"x"}`)
	if o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "{}", "hook", "claude"); o.code != 0 || o.stdout != "" || len(s.calls) != 0 {
		t.Errorf("no agent id = %+v, %d calls", o, len(s.calls))
	}
	// A daemon that answers slowly: the hook gives up after its budget and exits 0 without retrying.
	var n int
	var mu sync.Mutex
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		mu.Lock()
		n++
		mu.Unlock()
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	defer slow.Close()
	start := time.Now()
	o := runCLI(t, map[string]string{"STAM_URL": slow.URL, "STAM_AGENT_ID": "a1"}, "{}", "hook", "claude")
	if d := time.Since(start); o.code != 0 || o.stdout != "" || d < 2*time.Second || d > 5*time.Second {
		t.Errorf("slow daemon = %+v after %s", o, d)
	}
	mu.Lock()
	defer mu.Unlock()
	if n != 1 {
		t.Errorf("a timeout was retried: %d requests", n)
	}
}

// A refused connection retries: the hook finds the daemon once it is up, within the retry window.
func TestHookRetriesRefusedConnection(t *testing.T) {
	l, err := newListener()
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	started := make(chan struct{})
	go func() {
		time.Sleep(1200 * time.Millisecond)
		l2, err := listenOn(addr)
		if err != nil {
			close(started)
			return
		}
		srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"stdout":"late"}`)
		})}
		go srv.Serve(l2)
		close(started)
		time.Sleep(5 * time.Second)
		srv.Close()
	}()
	o := runCLI(t, map[string]string{"STAM_URL": "http://" + addr, "STAM_AGENT_ID": "a1"}, "{}", "hook", "claude")
	<-started
	if o.code != 0 || o.stdout != "late" {
		t.Errorf("hook after retries = %+v", o)
	}
}

func TestStatusline(t *testing.T) {
	s, v := hookStub(t, 200, `{}`)
	home := t.TempDir()
	v["STAM_HOME"] = home
	// No user status line: the prefix only.
	if o := runCLI(t, v, "{}", "statusline", "claude"); o.stdout != "[stam a1] " || o.code != 0 {
		t.Errorf("prefix = %+v", o)
	}
	if o := runCLI(t, map[string]string{"STAM_URL": s.URL}, "{}", "statusline", "claude"); o.stdout != "[stam ?] " {
		t.Errorf("no id = %+v", o)
	}
	// The user's command gets the payload on stdin; its output is cached with the time on the first line.
	counter := filepath.Join(home, "runs")
	v["STAM_USER_STATUSLINE"] = `cat >/dev/null; echo run >>` + counter + `; printf 'ctx\n\n'`
	for i := 0; i < 2; i++ {
		if o := runCLI(t, v, `{"a":1}`, "statusline", "claude"); o.stdout != "[stam a1] ctx\n\n" {
			t.Fatalf("run %d = %+v", i, o)
		}
	}
	if b, _ := os.ReadFile(counter); string(b) != "run\n" {
		t.Errorf("the user's command ran %q, want once within the ttl", b)
	}
	cache, _ := os.ReadFile(filepath.Join(home, "statusline-a1.out"))
	if !strings.HasSuffix(string(cache), "\nctx\n\n") {
		t.Errorf("cache %q", cache)
	}

	// Past the ttl it runs again; an unviewed agent keeps the saved output forever (S-1055).
	old := "1000\nsaved\n"
	os.WriteFile(filepath.Join(home, "statusline-a1.out"), []byte(old), 0o600)
	if o := runCLI(t, v, "{}", "statusline", "claude"); o.stdout != "[stam a1] ctx\n\n" {
		t.Errorf("stale cache = %+v", o)
	}
	os.WriteFile(filepath.Join(home, "statusline-a1.out"), []byte(old), 0o600)
	unviewed := newStub(t, map[string]func(int) (int, string){"POST /api/statusline/claude/a1": fixed(200, `{"viewed":false}`)})
	v["STAM_URL"] = unviewed.URL
	if o := runCLI(t, v, "{}", "statusline", "claude"); o.stdout != "[stam a1] saved\n" {
		t.Errorf("unviewed = %+v", o)
	}
	// No answer from the daemon keeps the ttl, and exits 0.
	v["STAM_URL"] = "http://127.0.0.1:1"
	if o := runCLI(t, v, "{}", "statusline", "claude"); o.code != 0 || o.stderr != "" {
		t.Errorf("down = %+v", o)
	}
}

func TestStatuslineUserCommandIsLimited(t *testing.T) {
	_, v := hookStub(t, 200, `{}`)
	v["STAM_HOME"] = t.TempDir()
	v["STAM_USER_STATUSLINE"] = `printf partial; sleep 30 & sleep 30`
	start := time.Now()
	o := runCLI(t, v, "{}", "statusline", "claude")
	if d := time.Since(start); o.code != 0 || o.stdout != "[stam a1] partial" || d > 8*time.Second {
		t.Errorf("slow user command = %+v after %s", o, d)
	}
}
