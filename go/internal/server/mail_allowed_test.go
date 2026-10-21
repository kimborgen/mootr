package server

import (
	"context"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/auth"
)

// sendH is send with more headers.
func (f *fixture) sendH(method, path, token string, header map[string]string, body string) *httptest.ResponseRecorder {
	f.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Host = "127.0.0.1:7999"
	r.Header.Set("Authorization", "Bearer "+token)
	for k, v := range header {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, r)
	return rec
}

const parentTok = "parent-token-value"

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	must(t, os.WriteFile(path, []byte(text), 0o600))
}

// The acting rules that allow: a parent on a child's box, a boss, the chief of staff and the assistant on another box,
// the OpenCode server on an OpenCode agent.
func TestMailActingAllowed(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(parentTok))
	f.sql("UPDATE agents SET harness = 'opencode' WHERE id = 'agone'")
	f.sql("UPDATE mail SET thread_id = id WHERE thread_id IS NULL")

	if rec := f.send("GET", "/api/agents/achild/inbox", parentTok, ""); rec.Code != 200 {
		t.Errorf("a parent on its child's box: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.send("POST", "/api/agents/achild/read", parentTok, `{"ids":[]}`); rec.Code != 200 {
		t.Errorf("a parent reading as its child: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.send("GET", "/api/threads/m1?box=achild", parentTok, ""); rec.Code != 200 {
		t.Errorf("a parent on its child's thread: %d %s", rec.Code, rec.Body.String())
	}
	// A peer forwarding the child as a boss.
	boss := map[string]string{"X-Stam-Local": "1", "X-Stam-Agent": "agone", "X-Stam-Agent-Boss": "1"}
	if rec := f.sendH("GET", "/api/agents/aboss/inbox", peerTok, boss, ""); rec.Code != 200 {
		t.Errorf("a boss on another box: %d %s", rec.Code, rec.Body.String())
	}
	notBoss := map[string]string{"X-Stam-Local": "1", "X-Stam-Agent": "agone"}
	if rec := f.sendH("GET", "/api/agents/aboss/inbox", peerTok, notBoss, ""); rec.Code != 403 {
		t.Errorf("a forwarded agent that is no boss: %d", rec.Code)
	}
	// The chief of staff, named in settings, and the assistant.
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'acodex'", auth.Hash("cos-token-value"))
	if rec := f.send("GET", "/api/agents/agone/inbox", "cos-token-value", ""); rec.Code != 403 {
		t.Errorf("a stranger on another box: %d", rec.Code)
	}
	writeFile(t, f.home+"/settings.json", `{"chiefOfStaff":"coder"}`)
	if rec := f.send("GET", "/api/agents/agone/inbox", "cos-token-value", ""); rec.Code != 200 {
		t.Errorf("the chief of staff on another box: %d %s", rec.Code, rec.Body.String())
	}
	writeFile(t, f.home+"/settings.json", `{}`)
	f.sql("UPDATE agents SET kind = 'assistant' WHERE id = 'acodex'")
	if rec := f.send("GET", "/api/agents/agone/inbox", "cos-token-value", ""); rec.Code != 200 {
		t.Errorf("the assistant on another box: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.send("GET", "/api/threads/m1?box=nowhere", "cos-token-value", ""); rec.Code != 200 {
		t.Errorf("the assistant on a box this daemon lacks: %d %s", rec.Code, rec.Body.String())
	}
	// The OpenCode server on an OpenCode agent's box, and on the thread it names.
	if rec := f.send("GET", "/api/agents/agone/inbox", serverTok, ""); rec.Code != 200 {
		t.Errorf("the OpenCode server on an OpenCode agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.send("GET", "/api/threads/m1?box=agone", serverTok, ""); rec.Code != 200 {
		t.Errorf("the OpenCode server on its agent's thread: %d %s", rec.Code, rec.Body.String())
	}
}

// deliveries is the mail_deliveries rows of an agent: mail handed out in a batch and still owed.
func deliveries(t *testing.T, f *fixture, agent string) []string {
	t.Helper()
	var out []string
	must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT mail_id || '/' || batch FROM mail_deliveries WHERE agent_id = ? ORDER BY mail_id, batch",
			&sqlitex.ExecOptions{Args: []any{agent}, ResultFunc: func(stmt *sqlite.Stmt) error { out = append(out, stmt.ColumnText(0)); return nil }})
	}))
	return out
}

// A read with a batch leaves the mail owed; the next read acknowledges the batch it was told of, and a read with no ids
// is the owed mail, else the unread.
func TestMailReadAckAndDefault(t *testing.T) {
	f := newFixture(t, nil)
	if got := mailIDs(t, f.send("POST", "/api/agents/achild/read", agentTok, `{"batch":"b1"}`)); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Fatalf("a read with no ids gave %v, want the one unread mail", got)
	}
	if got := deliveries(t, f, "achild"); !reflect.DeepEqual(got, []string{"m1/b1"}) {
		t.Fatalf("deliveries %v", got)
	}
	// The client got no reply to b1 (no ack): the mail is owed and handed out again.
	if got := mailIDs(t, f.send("POST", "/api/agents/achild/read", agentTok, `{"batch":"b2"}`)); !reflect.DeepEqual(got, []string{"m1"}) {
		t.Fatalf("an unacknowledged read gave %v, want m1 again", got)
	}
	if got := deliveries(t, f, "achild"); !reflect.DeepEqual(got, []string{"m1/b1", "m1/b2"}) {
		t.Fatalf("deliveries %v", got)
	}
	// It got b2's reply: b2 is acknowledged, which retires every batch of its mail.
	if got := mailIDs(t, f.send("POST", "/api/agents/achild/read", agentTok, `{"batch":"b3","ack":"b2"}`)); len(got) != 0 {
		t.Fatalf("after the ack the read gave %v, want nothing", got)
	}
	if got := deliveries(t, f, "achild"); len(got) != 0 {
		t.Fatalf("deliveries after the ack %v", got)
	}
	// An ack with no batch does nothing; the human's box has no batches.
	f.sql("INSERT INTO mail_deliveries (agent_id, mail_id, batch) VALUES ('achild', 'm1', 'bx')")
	f.send("POST", "/api/agents/achild/read", agentTok, `{"ack":"bx"}`)
	if got := deliveries(t, f, "achild"); len(got) != 1 {
		t.Fatalf("an ack with no batch changed the deliveries: %v", got)
	}
}

// What a body holds that JSON.stringify would not escape reaches the reader as it is: <, > and & plain, U+2028 and
// U+2029 as characters, and the text   (a backslash and letters) escaped as the backslash it is.
func TestJSONBytesMatchStringify(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("UPDATE mail SET thread_id = id WHERE thread_id IS NULL")
	f.sql("UPDATE mail SET subject = ? WHERE id = 'm1'", "a <b> & c   d   e \\u2028 f \\\\ g")
	rec := f.send("GET", "/api/agents/achild/inbox?unread=1", sharedTok, "")
	want := `"subject":"a <b> & c ` + " " + ` d ` + " " + ` e \\u2028 f \\\\ g"`
	if !strings.Contains(rec.Body.String(), want) {
		t.Errorf("body %q lacks %q", rec.Body.String(), want)
	}
	// The same through a plain map, as the error envelope and the other routes write.
	out, err := stringify(map[string]any{"error": "x <&>  "})
	must(t, err)
	if string(out) != "{\"error\":\"x <&>  \"}" {
		t.Errorf("map: %q", out)
	}
}
