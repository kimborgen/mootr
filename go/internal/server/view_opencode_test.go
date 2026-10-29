package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// viewStub is the shared OpenCode server as the view calls it: its event stream, the messages and permissions of one
// session, and the prompts and permission replies it was sent.
type viewStub struct {
	mu      sync.Mutex
	events  chan string
	prompts []string
	replies []string
	active  string
}

func newViewStub(t *testing.T, sid string) (*viewStub, int) {
	s := &viewStub{events: make(chan string, 16), active: `{}`}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		switch {
		case r.URL.Path == "/api/event":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			for {
				select {
				case ev := <-s.events:
					fmt.Fprintf(w, "data: %s\n\n", ev)
					w.(http.Flusher).Flush()
				case <-r.Context().Done():
					return
				}
			}
		case r.URL.Path == "/api/session/active":
			s.mu.Lock()
			defer s.mu.Unlock()
			fmt.Fprint(w, `{"data":`+s.active+`}`)
		case len(p) == 4 && p[2] == sid && p[3] == "message":
			fmt.Fprint(w, `{"data":[{"id":"m2","type":"assistant","time":{"created":2,"completed":3},"content":[{"type":"text","text":"DONE"}]},{"id":"m1","type":"user","text":"hello","time":{"created":1}}]}`)
		case len(p) == 4 && p[2] == sid && p[3] == "permission" && r.Method == "GET":
			fmt.Fprint(w, `{"data":[{"id":"per_1","action":"bash","resources":["ls"]}]}`)
		case len(p) == 4 && p[2] == sid && p[3] == "prompt" && r.Method == "POST":
			var body struct{ Text, Delivery string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.mu.Lock()
			s.prompts = append(s.prompts, body.Text+" "+body.Delivery)
			s.mu.Unlock()
			fmt.Fprint(w, `{"data":{}}`)
		case len(p) == 6 && p[2] == sid && p[3] == "permission" && p[5] == "reply" && r.Method == "POST":
			var body struct{ Decision string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.mu.Lock()
			s.replies = append(s.replies, p[4]+" "+body.Decision)
			s.mu.Unlock()
			s.events <- `{"type":"permission.replied","data":{"sessionID":"` + sid + `","requestID":"` + p[4] + `","reply":"` + body.Decision + `"}}`
			fmt.Fprint(w, `{"data":{}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(ts.Close)
	_, port, _ := net.SplitHostPort(ts.Listener.Addr().String())
	n, _ := strconv.Atoi(port)
	return s, n
}

func (s *viewStub) got() (prompts, replies []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.prompts...), append([]string(nil), s.replies...)
}

// sseNext reads the next data frame of a view stream.
func sseNext(t *testing.T, r *bufio.Reader) map[string]any {
	t.Helper()
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatalf("view stream: %v", err)
		}
		if rest, ok := strings.CutPrefix(line, "data: "); ok {
			var m map[string]any
			if err := json.Unmarshal([]byte(rest), &m); err != nil {
				t.Fatal(err)
			}
			return m
		}
	}
}

// An OpenCode agent's view: the state first, from the server's stored messages; a live event as a message; a prompt and a
// permission reply sent from the view reach the server, in the agent's session, as the human's; the answer's event ends the
// permission. The sends are the human's alone, as the Claude view's are.
func TestOpenCodeViewRoutes(t *testing.T) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	stub, port := newViewStub(t, "ses_achild")
	ocLife(t, f, port)
	f.srv.life.SetOpenCodeViewer(f.srv.viewEvent)
	f.sql("UPDATE agents SET harness = 'opencode', session_id = 'ses_achild', lifecycle = 'active', activity = 'idle' WHERE id = 'achild'")
	f.sql("DELETE FROM mail_recipients WHERE agent_id = 'achild'")
	f.sql("DELETE FROM mail WHERE from_id = 'achild'")

	// The sends are the human's alone: nothing reaches the server for any other caller.
	for _, route := range []string{"prompt", "interrupt", "permission"} {
		for _, tc := range []struct {
			name, token string
			header      map[string]string
		}{
			{"the agent itself", agentTok, nil},
			{"the agent with the human's header", agentTok, humanHeader()},
			{"the shared token without the human", sharedTok, nil},
			{"the OpenCode server's token", serverTok, nil},
			{"a peer", peerTok, map[string]string{"X-Stam-Local": "1"}},
		} {
			rec := f.do(call{method: "POST", path: "/api/agents/achild/view/" + route, token: tc.token, header: tc.header, body: `{"text":"hi","request":"per_1","decision":"once"}`})
			if rec.Code != 403 {
				t.Errorf("%s %s: %d %s", route, tc.name, rec.Code, rec.Body.String())
			}
		}
	}
	if prompts, replies := stub.got(); len(prompts)+len(replies) != 0 {
		t.Fatalf("a refused caller reached the server: %v %v", prompts, replies)
	}

	srv := httptest.NewServer(f.srv)
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/agents/achild/view", nil)
	req.Header.Set("Authorization", "Bearer "+sharedTok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("view: %d", res.StatusCode)
	}
	r := bufio.NewReader(res.Body)
	st := sseNext(t, r)
	state, _ := st["state"].(map[string]any)
	msgs, _ := state["messages"].([]any)
	perms, _ := state["permissions"].([]any)
	if st["type"] != "state" || state["harness"] != "opencode" || len(msgs) < 2 || len(perms) != 1 {
		t.Fatalf("state %v", st)
	}
	caps, _ := state["capabilities"].(map[string]any)
	if caps["can_stream"] != true || caps["can_approve"] != true {
		t.Errorf("capabilities %v", caps)
	}

	// A live event of the agent's session is a message change.
	stub.events <- `{"type":"session.text.delta","data":{"sessionID":"ses_achild","assistantMessageID":"live1","ordinal":0,"delta":"streamed"}}`
	for {
		ev := sseNext(t, r)
		m, _ := ev["message"].(map[string]any)
		if ev["type"] == "message" && m["id"] == "live1" {
			if b, _ := json.Marshal(m["parts"]); !strings.Contains(string(b), "streamed") {
				t.Errorf("message %s", b)
			}
			break
		}
	}

	post := func(route, body string) *httptest.ResponseRecorder {
		return f.do(call{method: "POST", path: "/api/agents/achild/view/" + route, token: sharedTok, header: humanHeader(), body: body})
	}
	if rec := post("prompt", `{"text":"hello there","delivery":"steer"}`); rec.Code != 200 {
		t.Fatalf("prompt: %d %s", rec.Code, rec.Body.String())
	}
	if rec := post("permission", `{"request":"per_1","decision":"always"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"answered":true`) {
		t.Fatalf("permission: %d %s", rec.Code, rec.Body.String())
	}
	prompts, replies := stub.got()
	if fmt.Sprint(prompts) != "[hello there steer]" || fmt.Sprint(replies) != "[per_1 always]" {
		t.Errorf("sent %v %v", prompts, replies)
	}
	// The reply's own event ends the permission in the open view.
	for {
		ev := sseNext(t, r)
		if ev["type"] == "status" {
			if p, _ := ev["permissions"].([]any); len(p) == 0 {
				break
			}
		}
	}
	if rec := post("permission", `{"request":"per_1","decision":"maybe"}`); rec.Code != 400 {
		t.Errorf("a bad decision: %d", rec.Code)
	}
	if n := f.srv.ocView.Followers(); n != 1 {
		t.Errorf("%d followers with one view open", n)
	}
	res.Body.Close()
	cancel()
	deadline := time.Now().Add(5 * time.Second)
	for f.srv.ocView.Followers() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := f.srv.ocView.Followers(); n != 0 {
		t.Errorf("%d followers after the view closed", n)
	}
}
