package linearpoll

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/events"
	"stam/internal/jsjson"
	"stam/internal/mcpauth"
)

// goodToken is the one bearer the fake Linear accepts (test/fixtures/fake-linear.mjs).
const goodToken = "good-bearer-0123456789"

// fakeLinear is test/fixtures/fake-linear.mjs in Go: a Linear MCP server over httptest, with issues, comments, a throttle
// (HTTP 429), a list that ignores `after`, one that never ends, and a newest-first order. No real Linear.
type fakeLinear struct {
	srv *httptest.Server
	mu  sync.Mutex

	issues   map[string]map[string]any
	comments map[string][]map[string]any

	throttle    int
	ignoreAfter bool
	endless     bool
	desc        bool
	// echo makes every error answer repeat the bearer it was sent, as a server that echoes its headers would.
	echo bool
	// sse answers in an event stream.
	sse bool
	// hook runs, unlocked, at the start of each tools/call.
	hook func(tool string)
	// fail answers HTTP 500 to the nth call (counting from 1) of a tool it returns true for.
	fail func(tool string, n int) bool

	calls   []string
	inits   int
	session string
}

func newFake(t *testing.T) *fakeLinear {
	f := &fakeLinear{issues: map[string]map[string]any{}, comments: map[string][]map[string]any{}, session: "fake-linear-session"}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeLinear) url() string { return f.srv.URL + "/mcp" }

func (f *fakeLinear) setIssue(id string, issue map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.issues[id] = issue
}

func (f *fakeLinear) setComments(id string, c ...map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.comments[id] = c
}

func (f *fakeLinear) callCount(tool string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == tool {
			n++
		}
	}
	return n
}

func (f *fakeLinear) serve(w http.ResponseWriter, r *http.Request) {
	reply := func(status int, body any, h ...string) {
		w.Header().Set("content-type", "application/json")
		for i := 0; i+1 < len(h); i += 2 {
			w.Header().Set(h[i], h[i+1])
		}
		w.WriteHeader(status)
		if body != nil {
			_ = json.NewEncoder(w).Encode(body)
		}
	}
	if r.URL.Path != "/mcp" {
		reply(404, map[string]any{"error": "not found"})
		return
	}
	auth := r.Header.Get("authorization")
	if auth != "Bearer "+goodToken {
		if f.echo {
			reply(401, map[string]any{"error": "bad bearer " + auth})
			return
		}
		reply(401, map[string]any{"error": "unauthorized"})
		return
	}
	raw, _ := io.ReadAll(r.Body)
	var msg struct {
		ID     *float64 `json:"id"`
		Method string   `json:"method"`
		Params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	_ = json.Unmarshal(raw, &msg)
	if msg.Method == "notifications/initialized" || msg.ID == nil {
		w.WriteHeader(202)
		return
	}
	rpc := func(result any) {
		body := map[string]any{"jsonrpc": "2.0", "id": *msg.ID, "result": result}
		if f.sse {
			b, _ := json.Marshal(body)
			w.Header().Set("content-type", "text/event-stream")
			w.Header().Set("mcp-session-id", f.session)
			_, _ = w.Write([]byte("event: message\ndata: " + string(b) + "\n\n"))
			return
		}
		reply(200, body, "mcp-session-id", f.session)
	}
	switch msg.Method {
	case "initialize":
		f.mu.Lock()
		f.inits++
		f.mu.Unlock()
		rpc(map[string]any{"protocolVersion": "2025-06-18"})
		return
	case "tools/call":
	default:
		reply(200, map[string]any{"jsonrpc": "2.0", "id": *msg.ID, "error": map[string]any{"code": -32601, "message": "no method " + msg.Method}})
		return
	}
	if h := r.Header.Get("mcp-session-id"); h != f.session {
		reply(404, map[string]any{"error": "no session"})
		return
	}
	f.mu.Lock()
	f.calls = append(f.calls, msg.Params.Name)
	hook := f.hook
	f.mu.Unlock()
	if hook != nil {
		hook(msg.Params.Name)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		n := 0
		for _, c := range f.calls {
			if c == msg.Params.Name {
				n++
			}
		}
		if f.fail(msg.Params.Name, n) {
			w.WriteHeader(500)
			return
		}
	}
	args := msg.Params.Arguments
	id, _ := args["id"].(string)
	if id == "" {
		id, _ = args["issueId"].(string)
	}
	text := func(v any) map[string]any {
		b, _ := json.Marshal(v)
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": string(b)}}}
	}
	switch msg.Params.Name {
	case "get_issue":
		issue, ok := f.issues[id]
		if !ok {
			rpc(map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": "no issue " + id + f.echoed(auth)}}})
			return
		}
		rpc(text(issue))
	case "list_comments":
		c := f.comments[id]
		if c == nil {
			c = []map[string]any{}
		}
		rpc(text(map[string]any{"comments": c}))
	case "list_issues":
		if f.throttle > 0 {
			f.throttle--
			w.WriteHeader(429)
			_, _ = w.Write([]byte("rate limited" + f.echoed(auth)))
			return
		}
		limit := 50
		if l, ok := args["limit"].(float64); ok {
			limit = int(l)
		}
		from := 0
		if a, ok := args["after"].(string); ok && !f.ignoreAfter {
			from, _ = strconv.Atoi(a)
		}
		since, _ := args["updatedAt"].(string)
		team, _ := args["team"].(string)
		var all []map[string]any
		for _, i := range f.issues {
			ident, _ := i["identifier"].(string)
			if ident == "" {
				ident, _ = i["id"].(string)
			}
			upd, _ := i["updatedAt"].(string)
			if strings.SplitN(ident, "-", 2)[0] == team && (since == "" || upd >= since) {
				all = append(all, i)
			}
		}
		sort.Slice(all, func(a, b int) bool {
			ua, _ := all[a]["updatedAt"].(string)
			ub, _ := all[b]["updatedAt"].(string)
			return ua < ub
		})
		if f.desc {
			for a, b := 0, len(all)-1; a < b; a, b = a+1, b-1 {
				all[a], all[b] = all[b], all[a]
			}
		}
		end := min(from+limit, len(all))
		nodes := []map[string]any{}
		if from < len(all) {
			nodes = all[from:end]
		}
		hasNext := f.endless || from+limit < len(all)
		var cursor any
		if hasNext {
			cursor = strconv.Itoa(from + limit)
		}
		rpc(text(map[string]any{"nodes": nodes, "pageInfo": map[string]any{"hasNextPage": hasNext, "endCursor": cursor}}))
	default:
		reply(200, map[string]any{"jsonrpc": "2.0", "id": *msg.ID, "error": map[string]any{"code": -32601, "message": "no tool " + msg.Params.Name}})
	}
}

func (f *fakeLinear) echoed(auth string) string {
	if f.echo {
		return " [" + auth + "]"
	}
	return ""
}

// staticAuth hands out one bearer; a refresh (force) hands out refreshed, when set.
type staticAuth struct {
	mu        sync.Mutex
	url       string
	token     string
	refreshed string
	forced    int
}

func (a *staticAuth) TokenFor(_ context.Context, name string, force bool) (mcpauth.Bearer, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	t := a.token
	if force {
		a.forced++
		if a.refreshed != "" {
			t = a.refreshed
		}
	}
	return mcpauth.Bearer{Name: name, URL: a.url, Token: t}, nil
}

// memStore is a Store in memory: the same rules as the database one, in one lock.
type memStore struct {
	mu      sync.Mutex
	watched map[string]bool
	rows    map[string]Row
	clock   int
	// onApply runs, unlocked, before an apply takes the lock.
	onApply func(watched, subject string)
	// sink takes the events.
	sink *sink
	// now is the time a row is stamped with; time.Now when nil.
	now func() time.Time
}

func newMem(watch ...string) *memStore {
	m := &memStore{watched: map[string]bool{}, rows: map[string]Row{}, sink: &sink{}}
	for _, w := range watch {
		m.watched[w] = true
	}
	return m
}

func (m *memStore) nowTime() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

func (m *memStore) watch(s string)   { m.mu.Lock(); m.watched[s] = true; m.mu.Unlock() }
func (m *memStore) unwatch(s string) { m.mu.Lock(); delete(m.watched, s); m.mu.Unlock() }

func (m *memStore) Watched(context.Context) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for s := range m.watched {
		out = append(out, s)
	}
	return out, nil
}

func (m *memStore) Row(_ context.Context, s string) (Row, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[s]
	return r, ok, nil
}

// Apply stores the events (a repeated dedupe key is dropped, as the events service does) and the row under one lock, as the
// database one does in one transaction.
func (m *memStore) Apply(ctx context.Context, watched, subject string, evs []events.Input, state string) (int, bool, error) {
	if m.onApply != nil {
		m.onApply(watched, subject)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.watched[watched] {
		return 0, false, nil
	}
	n := 0
	for _, in := range evs {
		res, err := m.sink.Ingest(ctx, in)
		if err != nil {
			return n, false, err
		}
		if res.Stored {
			n++
		}
	}
	m.clock++
	m.rows[subject] = Row{State: state, UpdatedAt: iso(m.nowTime())}
	return n, true, nil
}

func (m *memStore) StateSubjects(_ context.Context, prefix string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []string
	for s := range m.rows {
		if strings.HasPrefix(s, prefix) {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out, nil
}

func (m *memStore) DropTree(_ context.Context, subjects []string, olderThan time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range subjects {
		if m.watched[s] {
			continue
		}
		if r, ok := m.rows[s]; ok && r.UpdatedAt >= iso(olderThan) {
			continue
		}
		for k := range m.rows {
			if k == s || strings.HasPrefix(k, s+"/") {
				delete(m.rows, k)
			}
		}
	}
	return nil
}

func (m *memStore) has(subject string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.rows[subject]
	return ok
}

func (m *memStore) rowsUnder(prefix string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for k := range m.rows {
		if strings.HasPrefix(k, prefix) {
			n++
		}
	}
	return n
}

// sink is an Ingester that keeps what it is given and drops a repeated dedupe key, as the events service does.
type sink struct {
	mu   sync.Mutex
	got  []events.Input
	keys map[string]bool
	err  error
}

func (s *sink) Ingest(_ context.Context, in events.Input) (events.Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return events.Result{}, s.err
	}
	if s.keys == nil {
		s.keys = map[string]bool{}
	}
	if in.DedupeKey != "" && s.keys[in.DedupeKey] {
		return events.Result{}, nil
	}
	s.keys[in.DedupeKey] = true
	s.got = append(s.got, in)
	return events.Result{Stored: true}, nil
}

func (s *sink) types() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, e := range s.got {
		out = append(out, e.Type)
	}
	return out
}

func (s *sink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.got)
}

func (s *sink) byType(typ string) []events.Input {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []events.Input
	for _, e := range s.got {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

// all is every event as JSON, to search for a secret.
func (s *sink) all() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var b strings.Builder
	for _, e := range s.got {
		b.WriteString(jsjson.Stringify(jsjson.NewObject("type", e.Type, "subjects", toVals(e.Subjects), "summary", deref(e.Summary), "actor", deref(e.Actor), "url", deref(e.URL), "payload", e.Payload, "key", e.DedupeKey), ""))
	}
	return b.String()
}

func toVals(ss []string) []jsjson.Value {
	out := make([]jsjson.Value, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// forSubject is the events of one type whose subjects include subject.
func (s *sink) forSubject(subject, typ string) []events.Input {
	var out []events.Input
	for _, e := range s.byType(typ) {
		for _, x := range e.Subjects {
			if x == subject {
				out = append(out, e)
			}
		}
	}
	return out
}
