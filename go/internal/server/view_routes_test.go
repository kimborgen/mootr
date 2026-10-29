package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// viewFixture is a fixture whose child (achild, Claude Code) has a transcript: a prompt, a Bash call with its output,
// and a reply. It returns the transcript's path.
func viewFixture(t *testing.T) (*fixture, string) {
	t.Helper()
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	file := filepath.Join(t.TempDir(), "t.jsonl")
	rows := []string{
		`{"type":"user","uuid":"u1","timestamp":"2026-10-01T00:00:00.000Z","message":{"role":"user","content":"run echo hi"}}`,
		`{"type":"assistant","uuid":"u2","timestamp":"2026-10-01T00:00:01.000Z","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"echo hi"}}]}}`,
		`{"type":"user","uuid":"u3","timestamp":"2026-10-01T00:00:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"hi"}]}}`,
		`{"type":"assistant","uuid":"u4","timestamp":"2026-10-01T00:00:03.000Z","message":{"id":"m1","content":[{"type":"text","text":"DONE"}]}}`,
	}
	must(t, os.WriteFile(file, []byte(strings.Join(rows, "\n")+"\n"), 0o644))
	f.sql("UPDATE agents SET transcript_path = ?, activity = 'idle' WHERE id = 'achild'", file)
	// The seeded mail to the child is today's; these tests bring their own.
	f.sql("DELETE FROM mail_recipients WHERE agent_id = 'achild'")
	f.sql("DELETE FROM mail WHERE from_id = 'achild'")
	return f, file
}

func viewEvents(f *fixture, agent string) int {
	f.t.Helper()
	n := 0
	rows, err := f.db.ListEvents(context.Background(), agent, 100, "view-*")
	must(f.t, err)
	for _, e := range rows {
		if strings.HasPrefix(e.Type, "view-") {
			n++
		}
	}
	return n
}

// TestViewSendsHumanOnly: prompting, interrupting and answering from the view act as the human, so an agent's token, the
// shared token without the human's proof, a peer's token, and an agent's token carrying the test human's header are all
// refused before anything is typed or recorded; the human gets through to the source.
func TestViewSendsHumanOnly(t *testing.T) {
	f, _ := viewFixture(t)
	routes := map[string]string{
		"prompt":     "send to an agent's view",
		"interrupt":  "interrupt an agent from its view",
		"permission": "answer permissions from the view",
	}
	for route, what := range routes {
		for _, tc := range []struct {
			name, token string
			header      map[string]string
		}{
			{"the agent itself", agentTok, nil},
			{"the agent with the human's header", agentTok, humanHeader()},
			{"the shared token without the human", sharedTok, nil},
			{"the shared token with only x-stam-human", sharedTok, map[string]string{"X-Stam-Human": "1"}},
			{"a peer", peerTok, map[string]string{"X-Stam-Local": "1"}},
		} {
			rec := f.do(call{method: "POST", path: "/api/agents/achild/view/" + route, token: tc.token, header: tc.header, body: `{"text":"hi"}`})
			if rec.Code != 403 || !strings.Contains(errorOf(t, rec), "only the human can "+what) {
				t.Errorf("%s %s: %d %s", route, tc.name, rec.Code, rec.Body.String())
			}
		}
	}
	if n := viewEvents(f, "achild"); n != 0 {
		t.Fatalf("refused sends recorded %d view events", n)
	}
	human := func(route, agent, body string) *httptest.ResponseRecorder {
		return f.do(call{method: "POST", path: "/api/agents/" + agent + "/view/" + route, token: sharedTok, header: humanHeader(), body: body})
	}
	// The human reaches the source: no lifecycle here, so the box is never free; nothing is recorded for it.
	if rec := human("prompt", "achild", `{"text":"hi"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "input box isn't free") {
		t.Errorf("the human's prompt: %d %s", rec.Code, rec.Body.String())
	}
	for _, tc := range []struct{ body, want string }{
		{`{"text":"  "}`, "text is empty"},
		{`{"text":"hi","delivery":"now"}`, "delivery is 'queue' or 'steer'"},
		{`{"text":"hi","delivery":3}`, "delivery is 'queue' or 'steer'"},
	} {
		if rec := human("prompt", "achild", tc.body); rec.Code != 400 || errorOf(t, rec) != tc.want {
			t.Errorf("prompt %s: %d %s", tc.body, rec.Code, rec.Body.String())
		}
	}
	if n := viewEvents(f, "achild"); n != 0 {
		t.Fatalf("an undelivered prompt recorded %d view events", n)
	}
	if rec := human("interrupt", "achild", `{}`); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"stopped":false}` {
		t.Errorf("the human's interrupt: %d %s", rec.Code, rec.Body.String())
	}
	if n := viewEvents(f, "achild"); n != 1 {
		t.Errorf("the interrupt recorded %d view events, want 1", n)
	}
	if rec := human("permission", "achild", `{"request":"r1","decision":"once"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "claude takes no permission replies from the view") {
		t.Errorf("the human's permission answer: %d %s", rec.Code, rec.Body.String())
	}
	if rec := human("prompt", "nobody", `{"text":"hi"}`); rec.Code != 404 || errorOf(t, rec) != "no agent nobody" {
		t.Errorf("no agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := human("prompt", "acodex", `{"text":"hi"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "doesn't support codex yet") {
		t.Errorf("a Codex agent: %d %s", rec.Code, rec.Body.String())
	}
	if rec := human("interrupt", "agone", `{}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "has no Claude Code transcript yet") {
		t.Errorf("no transcript: %d %s", rec.Code, rec.Body.String())
	}
}

// TestViewHistory: the history is the transcript's messages with the agent's mail among them, any token may read it,
// and limit is clamped as TS clamps it.
func TestViewHistory(t *testing.T) {
	f, _ := viewFixture(t)
	f.sql("INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES ('mv1', 'aboss', 'boss', 'go', 'please', '2026-10-01T00:00:00.500Z', 'mv1')")
	f.sql("INSERT INTO mail_recipients (mail_id, agent_id, read_at) VALUES ('mv1', 'achild', '2026-10-01T00:00:00.700Z')")
	get := func(token, q string) (int, map[string]any) {
		rec := f.do(call{path: "/api/agents/achild/view/history" + q, token: token})
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, page := get(agentTok, "?limit=50")
	if code != 200 {
		t.Fatalf("%d %v", code, page)
	}
	msgs := page["messages"].([]any)
	var ids []string
	for _, m := range msgs {
		ids = append(ids, m.(map[string]any)["id"].(string))
	}
	if strings.Join(ids, " ") != "u1 mail:mv1 u2" {
		t.Fatalf("messages %v", ids)
	}
	parts := msgs[2].(map[string]any)["parts"].([]any)
	tool := parts[0].(map[string]any)
	if tool["name"] != "Bash" || tool["output"] != "hi" || tool["status"] != "done" || parts[1].(map[string]any)["text"] != "DONE" {
		t.Errorf("the turn %v", parts)
	}
	mail := msgs[1].(map[string]any)["parts"].([]any)[0].(map[string]any)
	if mail["from"] != "boss" || mail["read_at"] != float64(1790812800700) {
		t.Errorf("the mail %v", mail)
	}
	if page["older"] != nil {
		t.Errorf("older %v", page["older"])
	}
	// A limit of 1 is the newest message, with the mail of its span only, and older names where to go on.
	if code, page = get(sharedTok, "?limit=1"); code != 200 || len(page["messages"].([]any)) != 1 || page["older"] != "u2" {
		t.Errorf("limit 1: %d %v", code, page)
	}
	if code, page = get(sharedTok, "?before=u2&limit=abc"); code != 200 || len(page["messages"].([]any)) != 2 || page["older"] != nil {
		t.Errorf("before u2: %d %v", code, page)
	}
	if code, page = get(sharedTok, "?limit=-5"); code != 200 || len(page["messages"].([]any)) != 1 {
		t.Errorf("limit -5 is 1: %d %v", code, page)
	}
	rec := f.do(call{path: "/api/agents/acodex/view/history", token: sharedTok})
	if rec.Code != 409 {
		t.Errorf("Codex: %d %s", rec.Code, rec.Body.String())
	}
}

// TestViewTools: the tool calls before a mail the agent sent; a mail it didn't send is a 404.
func TestViewTools(t *testing.T) {
	f, _ := viewFixture(t)
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id) VALUES ('ms1', 'achild', 'done', 'DONE', '2026-10-01T00:00:03.500Z', 'ms1')")
	f.sql("INSERT INTO mail (id, from_id, subject, body, created_at, thread_id) VALUES ('mo1', 'aboss', 'x', 'y', '2026-10-01T00:00:03.500Z', 'mo1')")
	rec := f.do(call{path: "/api/agents/achild/view/tools?mail=ms1", token: sharedTok})
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Tools []struct {
			Name   string `json:"name"`
			Output string `json:"output"`
		} `json:"tools"`
		Truncated bool `json:"truncated"`
	}
	must(t, json.Unmarshal(rec.Body.Bytes(), &out))
	if len(out.Tools) != 1 || out.Tools[0].Name != "Bash" || out.Tools[0].Output != "hi" || out.Truncated {
		t.Errorf("%s", rec.Body.String())
	}
	if rec := f.do(call{path: "/api/agents/achild/view/tools?mail=mo1", token: sharedTok}); rec.Code != 404 || errorOf(t, rec) != "child sent no mail mo1" {
		t.Errorf("another's mail: %d %s", rec.Code, rec.Body.String())
	}
}

// TestViewStream: the stream opens with the state, a row Claude Code writes comes as a message event, the status line
// counts the open view, and closing the stream drops the live window and its follow.
func TestViewStream(t *testing.T) {
	f, file := viewFixture(t)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	f.srv.StartViews(ctx)
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	reqCtx, leave := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(reqCtx, "GET", ts.URL+"/api/agents/achild/view", nil)
	must(t, err)
	req.Host = "127.0.0.1:7999"
	req.Header.Set("Authorization", "Bearer "+sharedTok)
	res, err := http.DefaultClient.Do(req)
	must(t, err)
	defer res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("%d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	lines := bufio.NewScanner(res.Body)
	lines.Buffer(nil, 1<<20)
	next := func() map[string]any {
		t.Helper()
		for lines.Scan() {
			if data, ok := strings.CutPrefix(lines.Text(), "data: "); ok {
				var ev map[string]any
				must(t, json.Unmarshal([]byte(data), &ev))
				return ev
			}
		}
		t.Fatalf("the stream ended: %v", lines.Err())
		return nil
	}
	first := next()
	state, _ := first["state"].(map[string]any)
	if first["type"] != "state" || state["agent"] != "achild" || len(state["messages"].([]any)) != 2 || state["capabilities"].(map[string]any)["can_send"] != true {
		t.Fatalf("first event %v", first)
	}
	if !f.srv.views.HasViewers("achild") {
		t.Error("the open view isn't counted")
	}
	fh, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
	must(t, err)
	_, err = fh.WriteString(`{"type":"user","uuid":"u5","timestamp":"2026-10-01T00:00:05.000Z","message":{"content":"again"}}` + "\n")
	must(t, err)
	must(t, fh.Close())
	for {
		ev := next()
		if m, _ := ev["message"].(map[string]any); ev["type"] == "message" && m["id"] == "u5" {
			break
		}
	}
	leave()
	deadline := time.Now().Add(10 * time.Second)
	for f.srv.views.OpenViews() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the closed view stayed open")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if f.srv.views.HasViewers("achild") {
		t.Error("a closed view is still counted")
	}
}

// TestViewStreamRefusals: a stream that can't open answers the envelope before any event.
func TestViewStreamRefusals(t *testing.T) {
	f, _ := viewFixture(t)
	for path, want := range map[string]int{
		"/api/agents/nobody/view": 404,
		"/api/agents/acodex/view": 409,
		"/api/agents/agone/view":  409,
	} {
		rec := f.do(call{path: path, token: sharedTok})
		if rec.Code != want {
			t.Errorf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
		envelope(t, rec)
	}
	if f.srv.views.OpenViews() != 0 {
		t.Error("a refused stream left a view open")
	}
}

// TestViewPromptResting: a prompt to an agent resting under standing-idle is a 409 that says to mail it (the wake isn't
// ported), after the empty-text 400; nothing is typed or recorded. Another pause goes on to the source.
func TestViewPromptResting(t *testing.T) {
	f, _ := viewFixture(t)
	f.sql(`UPDATE agents SET lifecycle = 'paused', paused_by = '["standing-idle"]' WHERE id = 'achild'`)
	send := func(body string) *httptest.ResponseRecorder {
		return f.do(call{method: "POST", path: "/api/agents/achild/view/prompt", token: sharedTok, header: humanHeader(), body: body})
	}
	if rec := send(`{"text":" "}`); rec.Code != 400 || errorOf(t, rec) != "text is empty" {
		t.Errorf("empty: %d %s", rec.Code, rec.Body.String())
	}
	if rec := send(`{"text":"wake up"}`); rec.Code != 409 || errorOf(t, rec) != "child is resting, and a prompt from the view doesn't wake it on this daemon yet; send it mail" {
		t.Errorf("resting: %d %s", rec.Code, rec.Body.String())
	}
	if n := viewEvents(f, "achild"); n != 0 {
		t.Errorf("recorded %d view events", n)
	}
	f.sql(`UPDATE agents SET paused_by = '["human","standing-idle"]' WHERE id = 'achild'`)
	if rec := send(`{"text":"wake up"}`); rec.Code != 409 || !strings.Contains(errorOf(t, rec), "input box isn't free") {
		t.Errorf("paused by more than the rest: %d %s", rec.Code, rec.Body.String())
	}
}
