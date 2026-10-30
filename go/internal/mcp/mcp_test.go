package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"stam/internal/jsfmt"
)

const (
	sharedTok = "shared-token-value"
	agentTok  = "agent-token-value"
)

// repoRoot is the checkout this test runs in: src/mcp.ts, the reference, and templates/ are there.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "src", "mcp.ts")); err != nil {
		t.Skip("no src/mcp.ts to compare with")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/mcp.ts")
	}
	return root
}

// seen is one request the stub daemon got.
type seen struct {
	Method, Path, Query, Auth, Human string
	Body                             any
	// Raw is the body as the server wrote it, so the order of its members is compared too.
	Raw string
}

// stub is the daemon for both servers: the same answers, and a record of what each was asked.
type stub struct {
	*httptest.Server
	mu    sync.Mutex
	calls []seen
}

func newStub(t *testing.T, streamData string) *stub {
	t.Helper()
	s := &stub{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body any
		json.Unmarshal(b, &body)
		if !strings.HasSuffix(r.URL.Path, "/stream") {
			s.mu.Lock()
			s.calls = append(s.calls, seen{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("X-Stam-Human"), body, string(b)})
			s.mu.Unlock()
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/agents/a1/stream" && streamData != "":
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, ": connected\n\n"+streamData)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case r.Method == "GET" && r.URL.Path == "/api/agents/a1":
			io.WriteString(w, `{"id":"a1","name":"worker","context_tokens":4200,"tags":[],"none":{},"nested":{"x":null,"n":1.50},"s":"é<&> \u2028 \u0001"}`)
		case r.Method == "GET" && r.URL.Path == "/api/agents/n1":
			io.WriteString(w, `{"id":"n1","name":"joined"}`)
		case r.Method == "GET" && r.URL.Path == "/api/layout":
			io.WriteString(w, stubLayout)
		case r.Method == "POST" && r.URL.Path == "/api/layout/ops":
			if base, _ := body.(map[string]any)["base"].(float64); base == 1 {
				w.WriteHeader(409)
				io.WriteString(w, `{"error":"layout is at version 2, not the base 1","layout":`+stubLayout+`}`)
				break
			}
			io.WriteString(w, `{"version":3,"current":null,"agentWorlds":{},"worlds":{}}`)
		case r.Method == "GET" && r.URL.Path == "/api/agents/gone":
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"no agent gone"}`)
		case r.Method == "GET" && r.URL.Path == "/api/agents/a1/inbox":
			io.WriteString(w, `[{"id":"m1","subject":"Plan","from_id":"boss","unread":1,"itsas":[{"key":"S-1","title":"x"},{"key":"S-2","title":"y"}]},{"id":"m2","itsas":[]},{"id":"m3","itsas":null}]`)
		case r.Method == "POST" && r.URL.Path == "/api/agents/a1/read":
			ids, _ := body.(map[string]any)["ids"].([]any)
			switch {
			case ids != nil && len(ids) == 0, len(ids) == 1 && ids[0] == "none":
				io.WriteString(w, `[]`)
			case len(ids) > 0:
				io.WriteString(w, `[{"id":"m1","subject":"Plan","title":"S-1 Plan","from_id":"boss","from_name":"boss","created_at":"2026-10-01T00:00:00.000Z","thread_id":"m0","reply_to":"m0","body":"Do é <it>\n\nNo action needed","note":"slow down","attachments":[{"name":"a.txt","size":12,"path":"/x/a.txt"}]}]`)
			default:
				io.WriteString(w, `[{"id":"m2","subject":"Own","from_id":"u","from_name":null,"created_at":"2026-10-02T00:00:00.000Z","thread_id":"m2","reply_to":null,"body":"b"},{"id":"m3","subject":"Re","from_id":"u","from_name":"u","created_at":"2026-10-03T00:00:00.000Z","thread_id":"m2","reply_to":null,"body":"c","title":null,"note":null,"attachments":[]}]`)
			}
		case r.Method == "POST" && r.URL.Path == "/api/mail":
			subject, _ := body.(map[string]any)["subject"].(string)
			switch subject {
			case "reply":
				io.WriteString(w, `{"id":"m7","from_id":"a1","subject":"Re: x","thread_id":"m0","reply_to":"m0","not_running":["sleepy"]}`)
			case "stopped":
				io.WriteString(w, `{"id":"m8","thread_id":"m8","reply_to":null,"not_running":["x","y"],"misses_human":true}`)
			case "queued":
				io.WriteString(w, `{"id":"m9","thread_id":"m9","to":["z"],"queued":true,"misses_human":true}`)
			case "boom":
				w.WriteHeader(400)
				io.WriteString(w, `{"error":"no agent boom"}`)
			default:
				io.WriteString(w, `{"id":"m5","thread_id":"t5","reply_to":null,"not_running":[]}`)
			}
		case r.Method == "GET" && r.URL.Path == "/api/threads/m0":
			io.WriteString(w, `[{"id":"m0","subject":"Start","from_id":"boss","from_name":"boss","recipients":[{"id":"a1"},{"id":"a2"}],"created_at":"2026-09-30T00:00:00.000Z","body":"first","note":"n"},{"id":"m1","subject":"Plan","from_id":"a1","from_name":null,"recipients":[],"created_at":"2026-10-01T00:00:00.000Z","body":"second"}]`)
		case r.Method == "GET" && r.URL.Path == "/api/threads/empty":
			io.WriteString(w, `[]`)
		case r.Method == "GET" && (r.URL.Path == "/api/mail/search" || r.URL.Path == "/api/itsas/search"):
			// The query picks the answer: "none" finds nothing, "kw" ranks by keyword, anything else by meaning.
			q, mail := r.URL.Query().Get("q"), r.URL.Path == "/api/mail/search"
			by, s1, s2 := "meaning", "0.81", "0.4"
			if q == "kw" {
				by, s1, s2 = "keyword", "7", "2"
			}
			switch {
			case q == "none":
				io.WriteString(w, `[]`)
			case mail:
				io.WriteString(w, `[{"thread_id":"t1","subject":"Sign-in","latest":"m3","people":["boss","human"],"last":"2026-10-01T00:00:00.000Z","excerpt":"users keep…","score":`+s1+`,"by":"`+by+`","cosine":null,"keyword":3},`+
					`{"thread_id":"t2","subject":"Other","latest":"m4","people":[],"last":"2026-10-02T00:00:00.000Z","excerpt":"","score":`+s2+`,"by":"`+by+`","cosine":null,"keyword":1}]`)
			default:
				io.WriteString(w, `[{"id":"i1","key":"S-1","title":"Login","status":"todo","owner":null,"excerpt":"e","score":`+s2+`,"by":"`+by+`","cosine":null,"keyword":2},`+
					`{"id":"i2","key":"S-2","title":"Cost","status":"done","owner":"pm","excerpt":"f","score":0.9,"by":"`+by+`","cosine":null,"keyword":5}]`)
			}
		case r.Method == "POST" && r.URL.Path == "/api/mail/m7/attach":
			io.WriteString(w, `{"attached":{"itsas":["i1","i2"],"agents":["a2"]}}`)
		case r.Method == "POST" && r.URL.Path == "/api/mail/m7/withdraw-ask", r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/agents/a1/threads/t7/"):
			io.WriteString(w, `{"withdrawn":[],"deferred":true}`)
		case r.Method == "POST" && r.URL.Path == "/api/mail/m8/withdraw-ask":
			w.WriteHeader(409)
			io.WriteString(w, `{"error":"m8 isn't waiting on the human"}`)
		case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/cost/"):
			costStub(w, r.URL.Path, body)
		case r.Method == "GET" && r.URL.Path == "/api/usage" && r.URL.Query().Get("tree") == "nope":
			w.WriteHeader(403)
			io.WriteString(w, `{"error":"an agent reads the usage of its own tree and its ancestors' trees only, not nope's"}`)
		case r.Method == "GET" && r.URL.Path == "/api/usage":
			io.WriteString(w, usageStub(r.URL.Query().Get("days")))
		case r.Method == "POST" && r.URL.Path == "/api/register":
			io.WriteString(w, `{"id":"n1","name":"joined","token":"`+agentTok+`"}`)
		case r.Method == "POST" && r.URL.Path == "/api/steps/check":
			args, _ := body.(map[string]any)["args"].(map[string]any)
			switch args["self"] {
			case "deny":
				io.WriteString(w, `{"allow":false,"error":"stopped by a step"}`)
			case "deny-quiet":
				io.WriteString(w, `{"allow":false}`)
			case "forbid":
				w.WriteHeader(403)
				io.WriteString(w, `{"error":"not you","hint":"ask the human"}`)
			case "unported":
				// A daemon that has not ported a check answers 501: the shim runs the tool, so a daemon that must
				// withhold one answers 403 instead.
				w.WriteHeader(501)
				io.WriteString(w, `{"error":"the requirement check is not ported"}`)
			case "broken":
				w.WriteHeader(500)
				io.WriteString(w, `{"error":"boom"}`)
			case "noverdict":
				io.WriteString(w, `{}`)
			default:
				io.WriteString(w, `{"allow":true}`)
			}
		default:
			if !reqringRoutes(w, r, body) && !agentRoutes(w, r, body) && !s.itsaRoutes(w, r, body) && !s.eventsRoutes(w, r, body) {
				w.WriteHeader(404)
				io.WriteString(w, `{"error":"no route"}`)
			}
		}
	}))
	t.Cleanup(s.Close)
	return s
}

// reqs is a run's input: one JSON-RPC message per line.
type result struct {
	byID          map[string]string
	notifications []string
	stderr        string
	calls         []seen
}

// session is the lines a harness sends.
var session = []string{
	`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fake-claude","version":"0"}}}`,
	`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
	`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
	`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`,
	`{"jsonrpc":"2.0","id":"s4","method":"tools/call","params":{"name":"nosuchtool","arguments":{}}}`,
	`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"whoami","arguments":{"self":"gone"}}}`,
	`{"jsonrpc":"2.0","id":6,"method":"ping"}`,
	`this is not json`,
	``,
	`{"jsonrpc":"2.0","id":7,"method":"initialize","params":{}}`,
}

// feed writes the lines of a session; a line "WAIT" holds the next one back until every request sent so far is answered.
func feed(lines []string, got *atomic.Int32, write func(string)) {
	sent := int32(0)
	for _, l := range lines {
		if l == "WAIT" {
			for got.Load() < sent {
				time.Sleep(5 * time.Millisecond)
			}
			continue
		}
		write(l + "\n")
		if strings.Contains(l, `"id"`) {
			sent++
		}
	}
}

// run feeds lines to a server and collects its answers until there are n responses (and wantNotes notifications).
func collect(t *testing.T, stdout io.Reader, n, wantNotes int, got *atomic.Int32) (map[string]string, []string) {
	t.Helper()
	byID := map[string]string{}
	var notes []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 1<<24)
		for sc.Scan() {
			line := sc.Text()
			v, err := jsfmt.Parse([]byte(line))
			if err != nil {
				t.Errorf("a line that isn't JSON: %q", line)
				continue
			}
			if id, ok := v.Get("id"); ok {
				byID[jsfmt.Compact(id)] = line
				got.Add(1)
			} else {
				notes = append(notes, line)
			}
			if len(byID) >= n && len(notes) >= wantNotes {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatalf("got %d responses and %d notifications, want %d and %d", len(byID), len(notes), n, wantNotes)
	}
	return byID, notes
}

func runGo(t *testing.T, root string, env map[string]string, lines []string, n, notes int, st *stub) result {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	var errBuf syncBuf
	dir := t.TempDir()
	srv := New(Options{
		In: inR, Out: outW, Err: &errBuf,
		Getenv: func(k string) string { return env[k] },
		Cwd:    func() (string, error) { return dir, nil },
	})
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() { srv.Run(ctx); close(runDone) }()
	t.Cleanup(cancel)
	var got atomic.Int32
	go feed(lines, &got, func(l string) { io.WriteString(inW, l) })
	byID, nn := collect(t, outR, n, notes, &got)
	inW.Close()
	<-runDone
	st.mu.Lock()
	defer st.mu.Unlock()
	return result{byID, nn, errBuf.String(), append([]seen(nil), st.calls...)}
}

func runNode(t *testing.T, root string, env map[string]string, lines []string, n, notes int, st *stub) result {
	t.Helper()
	cmd := exec.Command("node", "--no-warnings", filepath.Join(root, "src", "cli.ts"), "mcp")
	cmd.Dir = env["PWD_FOR_TEST"]
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "STAM_EMBEDDER=stub"}
	for k, v := range env {
		if k != "PWD_FOR_TEST" {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	var errBuf syncBuf
	cmd.Stderr = &errBuf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var got atomic.Int32
	go feed(lines, &got, func(l string) { io.WriteString(in, l) })
	byID, nn := collect(t, out, n, notes, &got)
	in.Close()
	cmd.Wait()
	st.mu.Lock()
	defer st.mu.Unlock()
	return result{byID, nn, errBuf.String(), append([]seen(nil), st.calls...)}
}

type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// both runs the same session against src/mcp.ts and the Go server, each with a stub of its own, and returns the two.
func both(t *testing.T, vars map[string]string, lines []string, n, notes int, streamData string) (ts, goR result) {
	t.Helper()
	root := repoRoot(t)
	home := t.TempDir()
	mk := func(st *stub) map[string]string {
		env := map[string]string{"STAM_HOME": home, "STAM_URL": st.URL, "STAM_TOKEN": sharedTok, "STAM_ROOT": root, "PWD_FOR_TEST": t.TempDir()}
		for k, v := range vars {
			env[k] = v
		}
		return env
	}
	tsStub, goStub := newStub(t, streamData), newStub(t, streamData)
	ts = runNode(t, root, mk(tsStub), lines, n, notes, tsStub)
	goEnv := mk(goStub)
	goEnv["PWD_FOR_TEST"] = ""
	goR = runGo(t, root, goEnv, lines, n, notes, goStub)
	return ts, goR
}

// toolNames lists the tool names of a tools/list answer.
func toolNames(t *testing.T, line string) []string {
	t.Helper()
	v, err := jsfmt.Parse([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	res, _ := v.Get("result")
	list, _ := res.Get("tools")
	var out []string
	for _, tl := range list.Items {
		out = append(out, tl.Text("name"))
	}
	return out
}

// portedTool is whether the Go server carries the tool.
func portedTool(n string) bool {
	return n == "whoami" || n == "register" || n == "list_inbox" || n == "read_mail" || n == "read_thread" || n == "send_mail" ||
		n == "mail_attach" || n == "withdraw_ask" || n == "defer_thread" || n == "search_mail" || n == "search" || n == "settings_ask" || strings.HasPrefix(n, "itsa_") ||
		n == "usage_info" || n == "cost_allocate" || n == "cost_ack" || n == "cost_switch" || n == "cost_pause" ||
		n == "workspace_share" || n == "find_agents" || n == "registry_info" || n == "spawn_agent" || n == "agent_control" || n == "compact_self" || n == "reconnect_mcp" ||
		n == "feedback" || n == "retro" ||
		n == "request_permission" || n == "suggest_input" || n == "answer_permission" || n == "ring_create" || n == "ring_submit" || n == "ring_decide" ||
		n == "wait_for" || n == "wait_done" || n == "wake_me" || strings.HasPrefix(n, "req_") ||
		n == "subscribe" || n == "unsubscribe" || n == "list_subscriptions" || n == "watch_pr" || n == "unwatch_pr" ||
		n == "layout_get" || n == "layout_arrange"
}

// ported is the entries of whoami and register in a tools/list answer, as the server wrote them.
func ported(t *testing.T, line string) string {
	t.Helper()
	v, err := jsfmt.Parse([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	res, _ := v.Get("result")
	list, _ := res.Get("tools")
	var out []string
	for _, tl := range list.Items {
		if n := tl.Text("name"); portedTool(n) {
			out = append(out, jsfmt.Compact(tl))
		}
	}
	sort.Strings(out)
	return strings.Join(out, "\n")
}

// uuidIn is the random batch and ack ids of a read, which differ by run.
var uuidIn = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

var cwdMember = regexp.MustCompile(`,?"cwd":"[^"]*"`)

// sameCalls compares what the daemon was asked, in any order (requests are handled concurrently) and without the
// requirements probe the TS tools/list makes for the tools Go doesn't list.
// sinceIn is watch_pr's `since`, the time the tool ran.
var sinceIn = regexp.MustCompile(`"since":"[^"]*"`)

func sameCalls(t *testing.T, ts, goR []seen) {
	t.Helper()
	norm := func(l []seen) []string {
		var out []string
		for _, c := range l {
			if c.Path != "/api/req-enabled" {
				raw := sinceIn.ReplaceAllString(uuidIn.ReplaceAllString(c.Raw, "UUID"), `"since":"TIME"`)
				out = append(out, fmt.Sprintf("%s %s?%s %s %s %s", c.Method, c.Path, c.Query, c.Auth, c.Human, raw))
			}
		}
		sort.Strings(out)
		return out
	}
	if a, b := norm(ts), norm(goR); !reflect.DeepEqual(a, b) {
		t.Errorf("the daemon was asked differently\n ts: %s\n go: %s", strings.Join(a, "\n     "), strings.Join(b, "\n     "))
	}
}

// The Go server's answers to a harness are the TS server's, byte for byte: initialize with its instructions and the
// channel capability, tools/list with the schemas, a tool result, an unknown tool, an error envelope, a request it
// doesn't know, and a bad line.
func TestSessionMatchesTS(t *testing.T) {
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, session, 7, 0, "")
	for id, want := range ts.byID {
		if id == "2" {
			// The TS server lists every tool; the Go one lists what is ported, each entry the same bytes.
			if listed := ported(t, want); listed != ported(t, g.byID[id]) || listed == "" {
				t.Errorf("tools/list differs for the ported tools\n ts: %s\n go: %s", listed, ported(t, g.byID[id]))
			}
			// Go lists the tools it ports in the order TS lists them.
			var wantNames []string
			for _, n := range toolNames(t, want) {
				if portedTool(n) {
					wantNames = append(wantNames, n)
				}
			}
			if got := toolNames(t, g.byID[id]); !reflect.DeepEqual(got, wantNames) || len(got) == 0 {
				t.Errorf("go lists %v, ts order of the ported tools is %v", got, wantNames)
			}
			continue
		}
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	if len(g.byID) != len(ts.byID) {
		t.Errorf("go answered %d requests, ts %d", len(g.byID), len(ts.byID))
	}
	// The pieces the byte comparison rests on are really there.
	for _, want := range []string{`"experimental":{"claude/channel":{}}`, `"serverInfo":{"name":"stam","version":"0.1.0"}`, `"instructions":"`} {
		if !strings.Contains(g.byID["1"], want) {
			t.Errorf("initialize lacks %s", want)
		}
	}
	if !strings.Contains(g.byID["3"], `\"context_tokens\": 4200`) || !strings.Contains(g.byID[`"s4"`], `"isError":true`) {
		t.Errorf("tool results: %s / %s", g.byID["3"], g.byID[`"s4"`])
	}
	sameCalls(t, ts.calls, g.calls)
}

// The decision-steps check runs before every call and decides it, as checkStep does: a deny, a deny with no text, a 403
// that withholds the call, and the failures that let it run.
func TestStepsCheckMatchesTS(t *testing.T) {
	var lines []string
	n := 0
	for _, self := range []string{"ok", "deny", "deny-quiet", "forbid", "unported", "broken", "noverdict"} {
		n++
		lines = append(lines, fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"whoami","arguments":{"self":%q}}}`, n, self))
	}
	// No agent id in the environment: the `self` argument names the agent and is checked; with neither, nothing is.
	ts, g := both(t, nil, lines, n, 0, "")
	for id, want := range ts.byID {
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	sameCalls(t, ts.calls, g.calls)
	for _, want := range []string{"stopped by a step", "Denied by a decision step: whoami", "Refused: decision steps can't check whoami: not you; ask the human"} {
		found := false
		for _, line := range g.byID {
			found = found || strings.Contains(line, want)
		}
		if !found {
			t.Errorf("no answer holds %q", want)
		}
	}
	// A check that fails other than by a 403 runs the tool and says so on stderr.
	if !strings.Contains(g.stderr, "stam: decision steps could not check whoami, running it anyway: boom") ||
		!strings.Contains(g.stderr, "stam: decision steps could not check whoami, running it anyway: the requirement check is not ported") ||
		!strings.Contains(g.stderr, "no verdict in the reply") {
		t.Errorf("stderr %q", g.stderr)
	}
	// Each read came after its check.
	checked := map[string]bool{}
	for _, c := range g.calls {
		if c.Path == "/api/steps/check" {
			checked[c.Body.(map[string]any)["agent"].(string)] = true
		} else if id, ok := strings.CutPrefix(c.Path, "/api/agents/"); ok && !checked[id] {
			t.Errorf("%s was read before its steps check", id)
		}
	}
	// A denied call is never made.
	for _, c := range g.calls {
		if c.Path == "/api/agents/deny" || c.Path == "/api/agents/forbid" {
			t.Errorf("a denied call reached the daemon: %v", c)
		}
	}
}

// A caller with no id has no steps to check against: whoami asks for `self`, and the call runs unchecked.
func TestNoIdentity(t *testing.T) {
	lines := []string{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`}
	ts, g := both(t, nil, lines, 1, 0, "")
	if g.byID["1"] != ts.byID["1"] || !strings.Contains(g.byID["1"], "Pass your stam id as `self`") {
		t.Errorf("go %s\n ts %s", g.byID["1"], ts.byID["1"])
	}
	sameCalls(t, ts.calls, g.calls)
	if len(g.calls) != 0 {
		t.Errorf("calls %v", g.calls)
	}
}

// register: the agent's own token is used for every later call and shown nowhere; whoami then needs no `self`.
func TestRegisterMatchesTS(t *testing.T) {
	lines := []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"name":"joined","role":"tests","cwd":"x","extra":[1,{"a":"é"}]}}}`,
		"WAIT",
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`,
		"WAIT",
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"register","arguments":{"name":"again","role":"x"}}}`,
	}
	ts, g := both(t, nil, lines, 3, 0, "")
	for id, want := range ts.byID {
		if id == "1" {
			continue
		}
		if g.byID[id] != want {
			t.Errorf("id %s differs\n ts: %s\n go: %s", id, want, g.byID[id])
		}
	}
	// register's reply carries the working directory of each process, which differs; compare its shape.
	if !strings.Contains(g.byID["1"], `\"id\": \"n1\"`) || strings.Contains(g.byID["1"], agentTok) || strings.Contains(g.byID["1"], "token") {
		t.Errorf("register result %s", g.byID["1"])
	}
	for i := range g.calls {
		if i < len(ts.calls) && ts.calls[i].Path == "/api/register" {
			// cwd differs by process; the rest of the body is the same
			for _, c := range []*seen{&ts.calls[i], &g.calls[i]} {
				c.Raw = cwdMember.ReplaceAllString(c.Raw, "")
			}
		}
	}
	sameCalls(t, ts.calls, g.calls)
	for _, c := range g.calls {
		if c.Path != "/api/register" && c.Auth != "Bearer "+agentTok {
			t.Errorf("%s after register used %q, not the agent's token", c.Path, c.Auth)
		}
	}
	for _, c := range g.calls {
		if c.Path == "/api/agents/n1" && (c.Auth != "Bearer "+agentTok || c.Human != "") {
			t.Errorf("whoami after register: %+v", c)
		}
	}
}

// The daemon's events become channel notifications, as the TS bridge makes them.
func TestChannelMatchesTS(t *testing.T) {
	data := "data: {\"content\":\"hi\\nthere é\",\"meta\":{\"kind\":\"mail\",\"id\":\"m1\"}}\n\n" +
		"data: {\"content\":\"two\\nlines\"}\n\n" +
		"data: {\"content\":\"split\",\ndata: \"meta\":{\"n\":2}}\n\n"
	lines := []string{session[0], `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`}
	ts, g := both(t, map[string]string{"STAM_AGENT_ID": "a1"}, lines, 2, 3, data)
	if len(g.notifications) != 3 || !reflect.DeepEqual(g.notifications, ts.notifications) {
		t.Errorf("notifications\n ts: %q\n go: %q", ts.notifications, g.notifications)
	}
	if want := `{"jsonrpc":"2.0","method":"notifications/claude/channel","params":{"content":"hi\nthere é","meta":{"kind":"mail","id":"m1"}}}`; len(g.notifications) > 0 && g.notifications[0] != want {
		t.Errorf("first notification %s", g.notifications[0])
	}
}

// Taking over a session from a TS process that exec'd into this one: no initialize comes, so the server announces the
// tools and opens the stream; a canary only answers.
func TestAdoptedSession(t *testing.T) {
	st := newStub(t, "data: {\"content\":\"x\"}\n\n")
	env := map[string]string{"STAM_URL": st.URL, "STAM_TOKEN": sharedTok, "STAM_AGENT_ID": "a1", "STAM_HOME": t.TempDir(), SessionEnv: `{"protocolVersion":"2025-06-18"}`}
	r := runGo(t, "", env, []string{`{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}`}, 1, 2, st)
	if len(r.notifications) != 2 || r.notifications[0] != `{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}` {
		t.Errorf("notifications %q", r.notifications)
	}
	env[CanaryEnv] = "1"
	st2 := newStub(t, "data: {\"content\":\"x\"}\n\n")
	env["STAM_URL"] = st2.URL
	r = runGo(t, "", env, []string{`{"jsonrpc":"2.0","id":"canary","method":"tools/list","params":{}}`}, 1, 0, st2)
	if !strings.Contains(r.byID[`"canary"`], `"name":"whoami"`) || len(r.notifications) != 0 {
		t.Errorf("canary %v %q", r.byID, r.notifications)
	}
	time.Sleep(100 * time.Millisecond)
	st2.mu.Lock()
	defer st2.mu.Unlock()
	if len(st2.calls) != 0 {
		t.Errorf("a canary called the daemon: %v", st2.calls)
	}
}

// No token reaches stdout, stderr or an error: neither the shared one nor the agent's own.
func TestNoTokenLeaks(t *testing.T) {
	st := newStub(t, "")
	env := map[string]string{"STAM_URL": st.URL, "STAM_TOKEN": sharedTok, "STAM_HOME": t.TempDir()}
	lines := []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"name":"joined","role":"r"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{"self":"broken"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}`,
	}
	r := runGo(t, "", env, lines, 3, 0, st)
	all := r.stderr
	for _, l := range r.byID {
		all += l
	}
	for _, secret := range []string{sharedTok, agentTok, "Bearer"} {
		if strings.Contains(all, secret) {
			t.Errorf("output holds %q:\n%s", secret, all)
		}
	}
	// And the daemon being down says why without the URL's credentials.
	env["STAM_URL"] = "http://user:pw-secret@127.0.0.1:1"
	st2 := newStub(t, "")
	r = runGo(t, "", env, []string{`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{"self":"x"}}}`}, 1, 0, st2)
	if strings.Contains(r.stderr+r.byID["1"], "pw-secret") || strings.Contains(r.stderr+r.byID["1"], sharedTok) {
		t.Errorf("down: %q %q", r.stderr, r.byID["1"])
	}
}

func TestTemplateLookup(t *testing.T) {
	home := t.TempDir()
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "templates"), 0o755)
	os.MkdirAll(filepath.Join(root, "go", "bin"), 0o755)
	os.WriteFile(filepath.Join(root, "templates", "mcp-instructions.md"), []byte("from the release\n"), 0o644)
	get := func(vars map[string]string) func(string) string { return func(k string) string { return vars[k] } }
	exe := filepath.Join(root, "go", "bin", "stam")
	if got := Template(get(map[string]string{"STAM_HOME": home}), exe, "mcp-instructions"); got != "from the release\n" {
		t.Errorf("release template %q", got)
	}
	os.MkdirAll(filepath.Join(home, "templates"), 0o755)
	os.WriteFile(filepath.Join(home, "templates", "mcp-instructions.md"), []byte("mine"), 0o644)
	if got := Template(get(map[string]string{"STAM_HOME": home}), exe, "mcp-instructions"); got != "mine" {
		t.Errorf("home override %q", got)
	}
	if got := Template(get(map[string]string{"STAM_HOME": t.TempDir(), "STAM_ROOT": root}), "", "mcp-instructions"); got != "from the release\n" {
		t.Errorf("STAM_ROOT %q", got)
	}
	if got := Template(get(map[string]string{"STAM_HOME": t.TempDir()}), "/nowhere/stam", "mcp-instructions"); got != "" {
		t.Errorf("missing template %q", got)
	}
}

// A request with no id is answered without one, as src/mcp.ts's JSON.stringify leaves out an undefined id: the line is valid JSON.
func TestRequestWithoutID(t *testing.T) {
	st := newStub(t, "")
	var out syncBuf
	env := map[string]string{"STAM_URL": st.URL, "STAM_TOKEN": sharedTok, "STAM_HOME": t.TempDir()}
	srv := New(Options{In: strings.NewReader(`{"jsonrpc":"2.0","method":"tools/list"}` + "\n" + `{"jsonrpc":"2.0","method":"initialize","params":{}}` + "\n"), Out: &out, Err: io.Discard,
		Getenv: func(k string) string { return env[k] }})
	if err := srv.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	srv.Wait()
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines %q", lines)
	}
	for _, l := range lines {
		v, err := jsfmt.Parse([]byte(l))
		if err != nil {
			t.Fatalf("not JSON: %q", l)
		}
		if _, has := v.Get("id"); has || !strings.HasPrefix(l, `{"jsonrpc":"2.0","result":`) {
			t.Errorf("line %q", l)
		}
	}
}

// usageStub is a /api/usage answer with what the compact usage_info keeps and drops: seven trees, the caller a1 nested
// under the first one and another caller outside the top five, a window with agents, history and other_trees, and long lists.
func usageStub(days string) string {
	tree := func(id string, kids string) string {
		return `{"id":"` + id + `","name":"n-` + id + `","cost_usd":1.5,"tokens":10,"shares":{"claude":{"five_hour":{"estimate":true,"percent":2}}},"children":[` + kids + `],"extra":"drop"}`
	}
	// a1 holds 40 children (the dearest last), each with a child, so the compact answer must cap them.
	var kids []string
	for i := 0; i < 40; i++ {
		kids = append(kids, strings.Replace(tree("a-"+strconv.Itoa(i), tree("g-"+strconv.Itoa(i), "")), `"cost_usd":1.5`, `"cost_usd":`+strconv.Itoa(i), 1))
	}
	trees := tree("t0", tree("a9", tree("a1", strings.Join(kids, ","))))
	for _, id := range []string{"t1", "t2", "t3", "t4", "t5", "t6"} {
		trees += "," + tree(id, tree("c-"+id, ""))
	}
	trees += "," + tree("other", "")
	row := func(i int) string {
		return `{"agent_id":"x` + strconv.Itoa(i) + `","agent":"x","type":"developer","harness":"claude","model":"m","cost_usd":1,"tokens_in":2,"tokens_out":3,"tokens_cache_read":4,"tokens_cache_write":5,"hourly":[1,2,3]}`
	}
	var by []string
	for i := 0; i < 8; i++ {
		by = append(by, row(i))
	}
	win := `{"estimate":true,"since":"s","change":1,"other":{"percent":3},"agents":[{"id":"a1"}],"by_agent":[{"id":"a1"},{"id":"zz"}],"trees":[{"id":"t0"}],"by_tree":[1],"by_model":[{"m":1},{"m":2},{"m":3},{"m":4},{"m":5},{"m":6}],` +
		`"projection":{"hits_100_at":"later"},"other_trees":{"percent":4.5},"history":{"percent_per_hour":[1,2],"trees":[1]},"daily":[1,2,3]}`
	return `{"note":"n","see_also":"replaced","days":"` + days + `","instructions":["i"],"allocations":[{"root_id":"t0"}],"machines":[{"machine":"m"}],` +
		`"accounts":[{"name":"claude","shares":{"five_hour":` + win + `,"odd":null},"junk":1},{"name":"bare"}],"trees":[` + trees + `],` +
		`"today":{"cost_usd":2,"tokens_in":1,"extra":1},"by_day":[{"day":"2026-10-01","cost_usd":1.5,"tokens_in":1,"hourly":[1]}],"by_model":[` + row(0) + "," + row(1) + "," + row(2) + "," + row(3) + "," + row(4) + "," + row(5) + `],` +
		`"by_agent":[` + strings.Join(by, ",") + `],"by_account":[{"account":"claude","cost_usd":3,"x":1}],"blocked":[` + strings.Repeat(`{"agent_id":"b"},`, 11) + `{"agent_id":"b"}]}`
}
