package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// send is f.do with a JSON body.
func (f *fixture) send(method, path, token, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "127.0.0.1:7999"
	r.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, r)
	return rec
}

func (f *fixture) sql(query string, args ...any) {
	f.t.Helper()
	must(f.t, f.db.Write(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{Args: args})
	}))
}

// mailIDs is the ids of a mail list answer.
func mailIDs(t *testing.T, rec *httptest.ResponseRecorder) []string {
	t.Helper()
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var list []struct {
		ID string `json:"id"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &list))
	out := []string{}
	for _, m := range list {
		out = append(out, m.ID)
	}
	return out
}

// The inbox, the read and the thread of the seeded home: m1 unread, m2 deferred, m3 read, all to achild.
func TestMailRoutes(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE mail SET thread_id = id WHERE thread_id IS NULL")
	if got := mailIDs(t, f.send("GET", "/api/agents/achild/inbox?unread=1", agentTok, "")); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Errorf("unread inbox %v", got)
	}
	if got := mailIDs(t, f.send("GET", "/api/agents/achild/inbox?limit=2", sharedTok, "")); len(got) != 2 {
		t.Errorf("limit=2 gave %v", got)
	}
	if rec := f.send("GET", "/api/agents/nobody/inbox", sharedTok, ""); rec.Code != 404 || envelope(t, rec)["error"] != "no agent nobody" {
		t.Errorf("no such agent: %d %s", rec.Code, rec.Body.String())
	}

	// A read with a batch hands the mail out and marks it read; the next unread inbox no longer holds it.
	rec := f.send("POST", "/api/agents/achild/read", agentTok, `{"ids":["m1","nosuch"],"batch":"b1"}`)
	if got := mailIDs(t, rec); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Errorf("read gave %v", got)
	}
	if got := mailIDs(t, f.send("GET", "/api/agents/achild/inbox?unread=1", agentTok, "")); len(got) != 0 {
		t.Errorf("unread after the read %v", got)
	}
	if rec := f.send("POST", "/api/agents/achild/read", agentTok, `[1]`); rec.Code != 400 {
		t.Errorf("a body that isn't an object: %d", rec.Code)
	}

	// The whole thread to the box that is in it; a stranger's box sees none of it.
	if got := mailIDs(t, f.send("GET", "/api/threads/m1?box=achild", agentTok, "")); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Errorf("thread for achild %v", got)
	}
	if got := mailIDs(t, f.send("GET", "/api/threads/m1?box=agone", sharedTok, "")); !reflect.DeepEqual(got, []string{}) {
		t.Errorf("thread for agone %v", got)
	}
	if got := mailIDs(t, f.send("GET", "/api/threads/m1", sharedTok, "")); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Errorf("thread, no box %v", got)
	}
}

// Who may read whose mail: an agent its own box and its descendants', a boss or the chief of staff any, the shared token
// any, the OpenCode server only an OpenCode agent's.
func TestMailActingRules(t *testing.T) {
	f := newFixture(t, nil)
	for _, tc := range []struct {
		name, path, token string
		status            int
		error             string
	}{
		{"an agent on its own box", "/api/agents/achild/inbox", agentTok, 200, ""},
		{"an agent on a parent's box", "/api/agents/aboss/inbox", agentTok, 403, "agent child can't act as aboss"},
		{"an agent on a sibling's box", "/api/agents/agone/inbox", agentTok, 403, "agent child can't act as agone"},
		{"an agent on the human's box", "/api/agents/human/inbox", agentTok, 403, "agent child can't act as human"},
		{"the OpenCode server on a Claude agent", "/api/agents/achild/inbox", serverTok, 403, "the OpenCode server can't act as achild"},
		{"the shared token on any box", "/api/agents/aboss/inbox", sharedTok, 200, ""},
		{"the peer token on any box", "/api/agents/aboss/inbox", peerTok, 200, ""},
		{"the shared token on the human's box", "/api/agents/human/inbox", sharedTok, 200, ""},
		{"an agent reading a box with no viewer name", "/api/threads/m1", agentTok, 200, ""},
		{"an agent naming another's box in a thread", "/api/threads/m1?box=aboss", agentTok, 403, "agent child can't act as aboss"},
		{"the OpenCode server naming no box in a thread", "/api/threads/m1", serverTok, 403, "the OpenCode server must name the box it reads"},
		{"an agent naming a box that isn't here", "/api/threads/m1?box=elsewhere", agentTok, 403, "child can't act as elsewhere"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := f.send("GET", tc.path, tc.token, "")
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if tc.error != "" {
				if got := envelope(t, rec)["error"].(string); got != tc.error {
					t.Fatalf("error %q, want %q", got, tc.error)
				}
			}
		})
	}
	// The same rules guard a read: the agent may not mark another's mail read.
	if rec := f.send("POST", "/api/agents/aboss/read", agentTok, `{}`); rec.Code != 403 {
		t.Errorf("a read as another agent: %d", rec.Code)
	}
}

// A thread that belongs to an ITSA is read whole only by those the ITSA belongs to (S-480): its owner, a participant, the
// creator, the owner of an ancestor, the chief of staff and the assistant. Anyone else, an agent naming its own box, reads
// only its part of it; with no box named the whole thread is read.
func TestMailItsaThread(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("INSERT INTO itsas (id, key, title, status, created_by, created_at, updated_at, thread_id) VALUES ('iabcd', 'S-1', 't', 'backlog', 'human', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'mi1')")
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, itsa_id) VALUES ('mi1', 'aboss', 's', 'b', '2026-10-01T00:00:00.000Z', 'mi1', 'S-1')")
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, reply_to) VALUES ('mi2', 'aboss', 's', 'c', '2026-10-01T00:01:00.000Z', 'mi1', 'mi1')")
	f.sql("INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mi1', 'achild')")
	f.sql("INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mi2', 'human')")
	if got := mailIDs(t, f.send("GET", "/api/threads/mi1?box=achild", agentTok, "")); !reflect.DeepEqual(got, []string{"mi1"}) {
		t.Errorf("an agent outside the ITSA reads its part: %v", got)
	}
	f.sql("INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('iabcd', 'achild')")
	if got := mailIDs(t, f.send("GET", "/api/threads/mi1?box=achild", agentTok, "")); !reflect.DeepEqual(got, []string{"mi1", "mi2"}) {
		t.Errorf("a participant reads the whole thread: %v", got)
	}
	// With no box named the whole thread is read, as TS does for the shared token.
	if got := mailIDs(t, f.send("GET", "/api/threads/mi1", sharedTok, "")); !reflect.DeepEqual(got, []string{"mi1", "mi2"}) {
		t.Errorf("the shared token, no box: %v", got)
	}
}

// What a read does is told to the views as a mail.read event, and no token is in a mail row.
func TestMailReadEventAndSecrets(t *testing.T) {
	f := newFixture(t, nil)
	ts := httptest.NewServer(f.srv)
	t.Cleanup(ts.Close)
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/live", nil)
	must(t, err)
	req.Header.Set("Authorization", "Bearer "+sharedTok)
	req.Host = "127.0.0.1:7999"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res, err := http.DefaultClient.Do(req.WithContext(ctx))
	must(t, err)
	defer res.Body.Close()
	lines := bufio.NewReader(res.Body)
	if first, _ := lines.ReadString('\n'); first != ": connected\n" {
		t.Fatalf("first line %q", first)
	}
	rec := f.send("POST", "/api/agents/achild/read", agentTok, `{"ids":["m1"],"batch":"b9"}`)
	if rec.Code != 200 {
		t.Fatal(rec.Body.String())
	}
	got := ""
	for !strings.Contains(got, "m1") {
		line, err := lines.ReadString('\n')
		if err != nil {
			t.Fatalf("stream ended: %v after %q", err, got)
		}
		got += line
	}
	if !strings.Contains(got, "mail.read") || !strings.Contains(got, `"by":"achild"`) {
		t.Errorf("event %q", got)
	}
	for _, tok := range []string{sharedTok, agentTok, peerTok, serverTok} {
		if strings.Contains(rec.Body.String(), tok) || strings.Contains(got, tok) {
			t.Errorf("a token reached the answer or the event")
		}
	}
}
