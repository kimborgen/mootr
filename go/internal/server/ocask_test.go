package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"stam/internal/testenv"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/adapters/opencode"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// ocStub is an OpenCode server for the asks (S-3980): each session's pending permissions (an unknown session is a 404),
// the replies it got, which emit permission.replied as OpenCode does, and its event stream, fed by send.
type ocStub struct {
	mu        sync.Mutex
	pending   map[string][]string
	replies   []string
	failReply bool
	// resources are the resources every listed permission names (testenv.PermissionItem's when none): the listing says what the
	// permission.asked event of the same permission did.
	resources []string
	events    chan string
	// replied, when set, runs after a reply's permission.replied is sent and before the reply's response.
	replied func()
}

func newOCStub(t *testing.T) (*ocStub, int) {
	s := &ocStub{pending: map[string][]string{}, events: make(chan string, 16)}
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
		case len(p) == 4 && p[1] == "session" && p[3] == "permission" && r.Method == "GET":
			s.mu.Lock()
			list, ok := s.pending[p[2]]
			s.mu.Unlock()
			if !ok {
				w.WriteHeader(404)
				return
			}
			items := []string{}
			for _, id := range list {
				items = append(items, testenv.PermissionItem(p[2], id, s.resources...))
			}
			fmt.Fprint(w, `{"data":[`+strings.Join(items, ",")+`]}`)
		case len(p) == 6 && p[3] == "permission" && p[5] == "reply" && r.Method == "POST":
			var body struct{ Decision string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.mu.Lock()
			if s.failReply {
				s.mu.Unlock()
				w.WriteHeader(500)
				return
			}
			s.replies = append(s.replies, p[2]+" "+p[4]+" "+body.Decision)
			var kept []string
			for _, id := range s.pending[p[2]] {
				if id != p[4] {
					kept = append(kept, id)
				}
			}
			s.pending[p[2]] = kept
			s.mu.Unlock()
			// OpenCode tells of the reply on its stream, as soon as it is made.
			s.events <- `{"type":"permission.replied","data":{"sessionID":"` + p[2] + `","requestID":"` + p[4] + `","reply":"` + body.Decision + `"}}`
			s.mu.Lock()
			after := s.replied
			s.mu.Unlock()
			if after != nil {
				after()
			}
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

func (s *ocStub) set(sid string, ids ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending[sid] = ids
}

func (s *ocStub) got() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.replies...)
}

// ocLife is the fixture's daemon with the OpenCode server at port, following its event stream: a start with nothing in
// memory. The server is never started here (no binary), so only the stub answers.
func ocLife(t *testing.T, f *fixture, port int) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	settings := config.NewSettingsFile(f.home, f.cfg.Machine)
	userHome := t.TempDir()
	root, err := filepath.Abs("../../..")
	must(t, err)
	tc := &tmux.Client{Socket: "stam-test-none", Bin: "/bin/false"}
	tpl := &templates.Set{Root: root, Home: f.home, UserHome: userHome, Settings: settings.Get, Machine: f.cfg.Machine}
	srv := &opencode.Server{Tmux: tc, Port: port, Bin: filepath.Join(f.home, "no-opencode"),
		Config: func() opencode.Env { return opencode.Env{Home: f.home, Getenv: func(string) string { return "" }} },
		Sleep: func(ctx context.Context, d time.Duration) error {
			select {
			case <-time.After(20 * time.Millisecond):
			case <-ctx.Done():
			}
			return ctx.Err()
		}}
	life := lifecycle.New(ctx, lifecycle.Options{DB: f.db, Tmux: tc, Settings: settings, Machine: f.cfg.Machine,
		Claude: claude.Env{Templates: tpl, ClaudeBin: "/bin/false", Home: f.home, UserHome: userHome}, NetworkProbes: []string{"http://127.0.0.1:1/"},
		Streams: push.New(), PushDebounce: time.Hour, OpenCode: srv})
	f.srv.life = life
	life.SetDialogs(f.srv)
	life.StartOpenCode()
	t.Cleanup(func() { cancel(); life.Wait() })
}

// tsAsks runs testdata/ocaskref.mjs: the TS daemon raises an ask for each event on its own home, and the fixture is a
// Go daemon's start over that database. Each ask is the row TS left pending.
func tsAsks(t *testing.T, events ...string) (*fixture, []struct{ ID, Action, Details string }) {
	t.Helper()
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	must(t, os.Mkdir(home, 0o700))
	out, err := exec.Command("node", "testdata/ocaskref.mjs", home, "["+strings.Join(events, ",")+"]").Output()
	if err != nil {
		t.Fatalf("ocaskref.mjs: %v", err)
	}
	var ref struct {
		Asks []struct{ ID, Action, Details string }
	}
	must(t, json.Unmarshal(out, &ref))
	if len(ref.Asks) != len(events) {
		t.Fatalf("TS raised %d asks for %d events: %s", len(ref.Asks), len(events), out)
	}
	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.db"))
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'amgr'", auth.Hash(parentTok))
	return f, ref.Asks
}

// The event TS and Go raise an ask from: a shell command with characters JSON.stringify and Go's encoder print apart,
// and fields stam must keep out (a fake key and bearer in its metadata).
const tsAskEvent = `{"type":"permission.asked","data":{"id":"per_ts1","sessionID":"ses_tsask","action":"shell",` +
	`"resources":["rm -rf build/ <x> & y \u2028 \"q\""],"metadata":{"key":"sk-or-v1-fakeleak","auth":"Bearer fakebearer"}}}`

// An ask TS raised is answered by a Go daemon started over its database (S-4237 PR 4b): the row is read as TS wrote
// it, byte for byte what Go raises for the same event, and the human's yes goes to its permission id under its session,
// as `once`. The same event told again keeps TS's row. stam's own reply, told of on the stream, leaves the decision as it
// is.
func TestOpenCodeAskFromTSAcrossARestart(t *testing.T) {
	f, asks := tsAsks(t, tsAskEvent)
	ev, err := jsjson.Parse([]byte(tsAskEvent))
	must(t, err)
	data, _ := ev.(*jsjson.Object).Get("data")
	action, details, ok := opencode.AskDialog(data.(*jsjson.Object))
	if !ok || action != asks[0].Action || details != asks[0].Details {
		t.Fatalf("Go's ask differs from TS's:\n  go %q %s\n  ts %q %s", action, details, asks[0].Action, asks[0].Details)
	}
	stub, port := newOCStub(t)
	stub.set("ses_tsask", "per_ts1")
	stub.resources = []string{"rm -rf build/ <x> & y \u2028 \"q\""}
	ocLife(t, f, port)
	// The same event, told again to the Go daemon, which has nothing in memory: TS's row is kept, no second request.
	stub.events <- tsAskEvent
	stub.events <- `{"type":"session.tool.called","data":{"sessionID":"ses_tsask"}}`
	eventually(t, "the event after the repeat", func() bool { return deref(f.agentObj("aoc").ActivityDetail) == "running a tool" })
	if got := f.count("SELECT count(*) FROM permission_requests WHERE agent_id = 'aoc'"); got != 1 || f.status(asks[0].ID) != "pending" {
		t.Fatalf("after the repeat: %d requests, TS's %s", got, f.status(asks[0].ID))
	}
	if code, body := f.answerAs(sharedTok, human, asks[0].ID, `{"approve":true}`); code != 200 || !strings.Contains(body, `"status":"approved"`) {
		t.Fatalf("the human's yes: %d %s", code, body)
	}
	if got := stub.got(); len(got) != 1 || got[0] != "ses_tsask per_ts1 once" {
		t.Fatalf("replies %q", got)
	}
	// The reply's permission.replied is stam's own: it closes nothing. The stream is read in order, so once the event
	// after it set the agent's state, it was read.
	stub.events <- `{"type":"session.tool.called","data":{"sessionID":"ses_tsask"}}`
	eventually(t, "the event after the reply's", func() bool { return deref(f.agentObj("aoc").ActivityDetail) == "running a tool" })
	if s := f.status(asks[0].ID); s != "approved" {
		t.Errorf("status %s", s)
	}
	keptOut(t, f)
}

// A permission replied to while stam was down is no longer listed: the restarted daemon's answer reads it as gone,
// sends nothing, and closes the request with its mail, the human's copy included.
func TestOpenCodeAskRepliedWhileDown(t *testing.T) {
	f, asks := tsAsks(t, tsAskEvent)
	stub, port := newOCStub(t)
	stub.set("ses_tsask")
	ocLife(t, f, port)
	escalate(t, f, "amgr", asks[0].ID)
	if code, body := f.answerAs(sharedTok, human, asks[0].ID, `{"approve":true}`); code == 200 || !strings.Contains(body, "no longer shows this dialog") {
		t.Fatalf("the human's yes: %d %s", code, body)
	}
	if got := stub.got(); len(got) != 0 {
		t.Errorf("replies %q", got)
	}
	if s := f.status(asks[0].ID); s != "withdrawn" {
		t.Errorf("status %s", s)
	}
	withdrawnMail(t, f, asks[0].ID)
}

// escalate is the parent's escalation of the ask to the human, which mails the human a copy.
func escalate(t *testing.T, f *fixture, parent, id string) {
	t.Helper()
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"`+parent+`","decision":"escalate","note":"only a yes unblocks it"}`); code != 200 || !strings.Contains(body, `"audience":"human"`) {
		t.Fatalf("the escalation: %d %s", code, body)
	}
}

// withdrawnMail fails the test unless the human has a copy of the request's mail and every one is withdrawn, so no ask
// of it lingers in the human's view (TS withdrawDialog withdraws the human's copies; a reviewer's stays as a record).
func withdrawnMail(t *testing.T, f *fixture, id string) {
	t.Helper()
	all := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'human'", id)
	open := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'human' AND r.withdrawn_at IS NULL", id)
	if all == 0 || open != 0 {
		t.Errorf("%d of the human's %d copies of %s's mail still open", open, all, id)
	}
}

// keptOut fails the test if the event's fake key or bearer, or the server's password, reached a request, a mail or an
// event.
func keptOut(t *testing.T, f *fixture) {
	t.Helper()
	secrets := []string{"sk-or-v1-fakeleak", "fakebearer"}
	if pw, err := os.ReadFile(opencode.PasswordFile(f.home)); err == nil && strings.TrimSpace(string(pw)) != "" {
		secrets = append(secrets, strings.TrimSpace(string(pw)))
	}
	for _, s := range secrets {
		like := "%" + s + "%"
		if n := f.count("SELECT count(*) FROM permission_requests WHERE details LIKE ? OR action LIKE ? OR coalesce(note, '') LIKE ?", like, like, like) +
			f.count("SELECT count(*) FROM mail WHERE body LIKE ? OR subject LIKE ?", like, like) +
			f.count("SELECT count(*) FROM events WHERE coalesce(data, '') LIKE ?", like); n != 0 {
			t.Errorf("a secret reached %d rows", n)
		}
	}
}

// The Go daemon raises the ask from the event stream: one request for the event, the same event again keeping it, its
// details only the fields the mail reads and the answer needs. A reply made outside stam (the TUI) closes it with its
// mail. A parent's no goes to the server as reject; a yes from anyone but the human is refused. After the no, the
// agent's state is its events': OpenCode carries on with another tool, and nothing the answer writes says idle.
func TestOpenCodeAskLive(t *testing.T) {
	f, n := permFixture(t)
	f.sql("UPDATE agents SET harness = 'opencode', session_id = 'ses_live', activity = 'working' WHERE id = 'achild'")
	stub, port := newOCStub(t)
	stub.set("ses_live", "per_a")
	stub.resources = []string{"rm -rf build/ <x> & y \u2028 \"q\""}
	ocLife(t, f, port)
	ask := strings.NewReplacer("per_ts1", "per_a", "ses_tsask", "ses_live").Replace(tsAskEvent)
	stub.events <- ask
	eventually(t, "the ask", func() bool { _, ok, _ := f.db.PendingDialog(context.Background(), "achild"); return ok })
	r, _, _ := f.db.PendingDialog(context.Background(), "achild")
	if want := `{"tool":"shell","input":{"command":"rm -rf build/ <x> & y ` + "\u2028" + ` \"q\""},"action":"shell","permission":"per_a","session":"ses_live"}`; r.Details != want || r.Action != "OpenCode asks to allow shell" {
		t.Errorf("ask %q %s", r.Action, r.Details)
	}
	stub.events <- ask
	// The next ask after the duplicate: the stream is raised in order, so once it is pending the duplicate was read.
	stub.set("ses_live", "per_a", "per_b")
	stub.events <- strings.Replace(ask, "per_a", "per_b", 1)
	eventually(t, "the next ask", func() bool {
		r, _, _ := f.db.PendingDialog(context.Background(), "achild")
		return strings.Contains(r.Details, "per_b")
	})
	if got := f.count("SELECT count(*) FROM permission_requests WHERE agent_id = 'achild' AND details LIKE '%per_a%'"); got != 1 {
		t.Errorf("%d requests for one permission", got)
	}
	b, _, _ := f.db.PendingDialog(context.Background(), "achild")
	escalate(t, f, "aboss", b.ID)

	// Answered in the TUI: OpenCode tells of it, and the ask closes with its mail.
	stub.events <- `{"type":"permission.replied","data":{"sessionID":"ses_live","requestID":"per_b","reply":"once"}}`
	eventually(t, "the ask closed", func() bool { return f.status(b.ID) == "withdrawn" })
	withdrawnMail(t, f, b.ID)

	stub.set("ses_live", "per_c")
	stub.events <- strings.Replace(ask, "per_a", "per_c", 1)
	eventually(t, "the third ask", func() bool {
		r, _, _ := f.db.PendingDialog(context.Background(), "achild")
		return strings.Contains(r.Details, "per_c")
	})
	c, _, _ := f.db.PendingDialog(context.Background(), "achild")
	if code, body := f.answerAs(parentTok, nil, c.ID, `{"by":"aboss","approve":true}`); code == 200 || !strings.Contains(body, "only the human approves") {
		t.Errorf("the parent's yes: %d %s", code, body)
	}
	// OpenCode runs another tool after the rejection, told of before the reply's response.
	stub.mu.Lock()
	stub.replied = func() {
		stub.events <- `{"type":"session.tool.called","data":{"sessionID":"ses_live"}}`
		eventually(t, "the tool after the no", func() bool { return f.agentObj("achild").Activity == "working" })
	}
	stub.mu.Unlock()
	if code, body := f.answerAs(parentTok, nil, c.ID, `{"by":"aboss","approve":false,"note":"not that"}`); code != 200 || !strings.Contains(body, `"typed":true`) {
		t.Fatalf("the parent's no: %d %s", code, body)
	}
	if a := f.agentObj("achild"); a.Activity != "working" || deref(a.ActivityDetail) != "running a tool" {
		t.Errorf("after the no: %s %s", a.Activity, deref(a.ActivityDetail))
	}
	if got := stub.got(); len(got) != 1 || got[0] != "ses_live per_c reject" {
		t.Errorf("replies %q", got)
	}
	if f.status(c.ID) != "denied" || !hasNotice(n, "achild", "not that") {
		t.Errorf("after the no: %s, notices %q", f.status(c.ID), n.all())
	}
	keptOut(t, f)
}
