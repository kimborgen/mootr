package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/auth"
	"stam/internal/db"
)

// controlCall posts an agent-control action and returns its status and body.
func controlCall(f *fixture, token, id, action, body string, header map[string]string) (int, string) {
	f.t.Helper()
	rec := f.do(call{method: "POST", path: "/api/agents/" + id + "/" + action, token: token, body: body, header: header})
	return rec.Code, rec.Body.String()
}

// controlFixture is a fixture with a lifecycle over the checkout's templates, the test human's key, and a token for
// coder (cos-token).
func controlFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	checkout, err := filepath.Abs("../../..")
	must(t, err)
	withLifeRoot(f, checkout)
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'acodex'", auth.Hash("cos-token"))
	return f
}

func humanHeader() map[string]string {
	return map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}
}

// TestControlWho: an agent controls itself and its children; only the human and the assistant rename, reparent and
// name the chief of staff; the chief of staff may adopt any agent but not pause it.
func TestControlWho(t *testing.T) {
	f := controlFixture(t)
	writeSettings(t, f, `{"home":"test-machine","chiefOfStaff":"coder"}`)
	for _, tc := range []struct {
		name, token, id, action, body string
		status                        int
		want                          string
	}{
		{"a child pauses its parent", agentTok, "aboss", "pause", `{"by":"achild"}`, 403, "achild may control only itself and its children"},
		{"a child renames itself", agentTok, "achild", "rename", `{"by":"achild","name":"kid"}`, 403, "only the human and the assistant may rename"},
		{"a child reparents itself", agentTok, "achild", "set-parent", `{"by":"achild","parent":[]}`, 403, "only the human and the assistant may set-parent"},
		{"a child names the chief of staff", agentTok, "achild", "chief-of-staff", `{"by":"achild"}`, 403, "only the human and the assistant may chief-of-staff"},
		{"the chief of staff pauses a stranger", "cos-token", "aboss", "pause", `{"by":"acodex"}`, 403, "acodex may control only itself and its children"},
		{"the chief of staff adopts a stranger", "cos-token", "aboss", "adopt", `{"by":"acodex"}`, 200, `"result":"coder is now a parent of boss"`},
		{"a parent sets its child's notices", bossTok, "achild", "set-child-notices", `{"by":"aboss","child_notices":"none"}`, 200, "child notices set to none"},
		{"a bad notices mode", bossTok, "achild", "set-child-notices", `{"by":"aboss","child_notices":"loud"}`, 409, "child notices must be turn, tree-idle, or none"},
		{"visibility that isn't an object", agentTok, "achild", "set-visibility", `{"by":"achild","visibility":"all"}`, 409, "set-visibility needs a visibility object"},
		{"a child archives its parent", agentTok, "aboss", "archive", `{"by":"achild"}`, 403, "achild may control only itself and its children"},
		{"a codex agent's archive isn't ported", bossTok, "acodex", "archive", `{"by":"aboss"}`, 501, "archiving a codex agent is not ported"},
	} {
		code, body := controlCall(f, tc.token, tc.id, tc.action, tc.body, nil)
		if code != tc.status || !strings.Contains(body, tc.want) {
			t.Errorf("%s: %d %s, want %d %q", tc.name, code, body, tc.status, tc.want)
		}
		if strings.Contains(body, agentTok) || strings.Contains(body, "token_hash") {
			t.Errorf("%s: the reply holds a token: %s", tc.name, body)
		}
	}
	a, err := f.db.GetAgent(context.Background(), "achild")
	must(t, err)
	if a.ChildNotices == nil || *a.ChildNotices != "none" {
		t.Errorf("child notices = %v", a.ChildNotices)
	}
	parents, err := f.db.ParentsOf(context.Background(), agentRow(t, f, "aboss"))
	must(t, err)
	if len(parents) != 1 || parents[0] != "acodex" {
		t.Errorf("boss's parents after the adopt = %v", parents)
	}
}

// TestPauseUnpause: a parent's pause holds the child until that parent releases it; the child can't release it, a held
// human unpause names what holds the agent, and force clears the cost blockers.
func TestPauseUnpause(t *testing.T) {
	f := controlFixture(t)
	code, body := controlCall(f, bossTok, "achild", "pause", `{"by":"aboss"}`, nil)
	if code != 200 || !strings.Contains(body, `"result":"paused"`) {
		t.Fatalf("pause: %d %s", code, body)
	}
	a := agentRow(t, f, "achild")
	if a.Lifecycle != "paused" || a.PausedBy == nil || *a.PausedBy != `["aboss"]` {
		t.Fatalf("after pause: %s %v", a.Lifecycle, a.PausedBy)
	}
	code, body = controlCall(f, agentTok, "achild", "unpause", `{"by":"achild"}`, nil)
	if code != 200 || !strings.Contains(body, `"result":"child stays paused: paused by boss"`) {
		t.Fatalf("the child's own unpause: %d %s", code, body)
	}
	f.sql("INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES ('achild', 'window', 'claude-max', 'five_hour at 100%', '2026-01-01T00:00:00.000Z')")
	code, body = controlCall(f, sharedTok, "achild", "unpause", `{}`, humanHeader())
	if code != 409 || !strings.Contains(body, "child stays paused: window on claude-max: five_hour at 100%. Unpause with force") {
		t.Fatalf("a held human unpause: %d %s", code, body)
	}
	code, body = controlCall(f, agentTok, "achild", "unpause", `{"by":"achild","force":true}`, nil)
	if code != 409 || !strings.Contains(body, "only the human may force an unpause") {
		t.Fatalf("an agent's forced unpause: %d %s", code, body)
	}
	code, body = controlCall(f, sharedTok, "achild", "unpause", `{"force":true}`, humanHeader())
	if code != 200 || !strings.Contains(body, `"result":"active"`) {
		t.Fatalf("a forced unpause: %d %s", code, body)
	}
	if rows, _ := f.db.BlockerRows(context.Background(), "achild"); len(rows) != 0 {
		t.Errorf("blockers left after force: %v", rows)
	}
	evs, err := f.db.ListEvents(context.Background(), "achild", 10, "cost:override")
	must(t, err)
	if len(evs) != 1 || !strings.Contains(*evs[0].Data, `"kind":"window"`) {
		t.Errorf("cost:override events = %+v", evs)
	}
	if a = agentRow(t, f, "achild"); a.Lifecycle != "active" || a.PausedBy != nil {
		t.Errorf("after the forced unpause: %s %v", a.Lifecycle, a.PausedBy)
	}
}

// TestPauseConcurrent: pauses by two owners at once both land, so neither owner's hold is lost to the other's write.
func TestPauseConcurrent(t *testing.T) {
	f := controlFixture(t)
	var wg sync.WaitGroup
	for by, token := range map[string]string{"aboss": bossTok, "acodex": "cos-token"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, body := controlCall(f, token, "achild", "pause", `{"by":"`+by+`"}`, nil); code != 200 {
				t.Errorf("pause by %s: %d %s", by, code, body)
			}
		}()
	}
	wg.Wait()
	a := agentRow(t, f, "achild")
	var owners []string
	must(t, json.Unmarshal([]byte(*a.PausedBy), &owners))
	if a.Lifecycle != "paused" || len(owners) != 2 {
		t.Errorf("after two pauses: %s %v", a.Lifecycle, owners)
	}
}

// TestRenameAndParents: the human renames an agent (the chief of staff setting follows it), a taken name or a bad one
// is refused, and set-parent replaces the parents or makes the agent top-level.
func TestRenameAndParents(t *testing.T) {
	f := controlFixture(t)
	writeSettings(t, f, `{"home":"test-machine","chiefOfStaff":"child"}`)
	for _, tc := range []struct {
		body   string
		status int
		want   string
	}{
		{`{"name":"boss"}`, 409, "name boss is taken"},
		{`{"name":"aboss"}`, 409, "name aboss is taken"},
		{`{"name":"Kid"}`, 409, "name must be lowercase letters, digits, and dashes"},
		{`{"name":" kid "}`, 200, `"result":"child is now kid"`},
	} {
		if code, body := controlCall(f, sharedTok, "achild", "rename", tc.body, humanHeader()); code != tc.status || !strings.Contains(body, tc.want) {
			t.Errorf("rename %s: %d %s", tc.body, code, body)
		}
	}
	if got := f.srv.settings.Get().ChiefOfStaff; got != "kid" {
		t.Errorf("chiefOfStaff = %q, want kid", got)
	}
	b, err := os.ReadFile(filepath.Join(f.home, "settings.json"))
	must(t, err)
	if !strings.HasPrefix(string(b), "{\n  \"home\": \"test-machine\",\n  \"chiefOfStaff\": \"kid\"\n}") {
		t.Errorf("settings.json = %s", b)
	}
	for _, tc := range []struct {
		body   string
		status int
		want   string
	}{
		{`{"parent":"achild"}`, 409, "kid can't be its own parent"},
		{`{"parent":["nobody"]}`, 409, "no agent nobody"},
		{`{"parent":"none"}`, 200, `"result":"kid is now top-level"`},
		{`{"parent":["boss","coder"]}`, 200, `"result":"kid now reports to boss, coder"`},
	} {
		if code, body := controlCall(f, sharedTok, "achild", "set-parent", tc.body, humanHeader()); code != tc.status || !strings.Contains(body, tc.want) {
			t.Errorf("set-parent %s: %d %s", tc.body, code, body)
		}
	}
	parents, err := f.db.ParentsOf(context.Background(), agentRow(t, f, "achild"))
	must(t, err)
	if strings.Join(parents, ",") != "aboss,acodex" {
		t.Errorf("parents = %v", parents)
	}
}

// TestRenameConcurrent: two renames to one name at once: exactly one wins, the other is told the name is taken.
func TestRenameConcurrent(t *testing.T) {
	f := controlFixture(t)
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i, id := range []string{"achild", "acodex"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i], _ = controlCall(f, sharedTok, id, "rename", `{"name":"same"}`, humanHeader())
		}()
	}
	wg.Wait()
	if codes[0]+codes[1] != 200+409 {
		t.Errorf("two renames to one name: %v", codes)
	}
}

// TestDefaultViewAndPermissionMode: only the human sets a default view (any id) or a permission mode; a stopped
// agent's mode is set without a restart.
func TestDefaultViewAndPermissionMode(t *testing.T) {
	f := controlFixture(t)
	put := func(token, body string, header map[string]string) (int, string) {
		rec := f.do(call{method: "PUT", path: "/api/agents/apeer/default-view", token: token, body: body, header: header})
		return rec.Code, rec.Body.String()
	}
	if code, body := put(agentTok, `{"view":"terminal"}`, nil); code != 403 {
		t.Errorf("an agent's default view: %d %s", code, body)
	}
	if code, body := put(sharedTok, `{"view":"grid"}`, humanHeader()); code != 400 {
		t.Errorf("a bad view: %d %s", code, body)
	}
	if code, body := put(sharedTok, `{"view":"conversation"}`, humanHeader()); code != 200 || body != `{"agent_id":"apeer","default_view":"conversation"}` {
		t.Errorf("set a view: %d %s", code, body)
	}
	if code, body := put(sharedTok, `{"view":null}`, humanHeader()); code != 200 || body != `{"agent_id":"apeer","default_view":null}` {
		t.Errorf("clear a view: %d %s", code, body)
	}
	mode := func(token, body string, header map[string]string) (int, string) {
		rec := f.do(call{method: "POST", path: "/api/agents/achild/permission-mode", token: token, body: body, header: header})
		return rec.Code, rec.Body.String()
	}
	if code, body := mode(sharedTok, `{"mode":"bypass"}`, map[string]string{"X-Stam-Human": "1"}); code != 403 {
		t.Errorf("x-stam-human alone set a mode: %d %s", code, body)
	}
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'achild'")
	code, body := mode("", `{"mode":"bypass"}`, map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"})
	if code != 200 || !strings.Contains(body, `"result":"set"`) || !strings.Contains(body, `"permission_mode":"bypass"`) || !strings.Contains(body, `"permission_source":"manual"`) {
		t.Errorf("the human's mode: %d %s", code, body)
	}
	// The human's proof counts with the shared token too, as src/daemon.ts humanOnly has it.
	code, body = mode(sharedTok, `{"mode":"auto"}`, map[string]string{"X-Stam-Test-Human": humanKey})
	if code != 200 || !strings.Contains(body, `"permission_mode":"auto"`) || !strings.Contains(body, `"permission_source":"manual"`) {
		t.Errorf("the human's mode with the shared token: %d %s", code, body)
	}
}

// TestArchiveRoutes: a parent archives its stopped child at once; only a peer's own call runs the archive cascade over
// this machine's children, and it needs the parents.
func TestArchiveRoutes(t *testing.T) {
	f := controlFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'achild'")
	code, body := controlCall(f, bossTok, "achild", "archive", `{"by":"aboss"}`, nil)
	if code != 200 || !strings.Contains(body, `"result":"done"`) || !strings.Contains(body, `"lifecycle":"archived"`) {
		t.Errorf("archive a stopped child: %d %s", code, body)
	}
	if code, body := controlCall(f, bossTok, "achild", "archive", `{"by":"aboss"}`, nil); code != 409 || !strings.Contains(body, "child is already archived") {
		t.Errorf("archive it again: %d %s", code, body)
	}
	// force implies discard unless discard is given; an explicit false forbids it.
	for _, tc := range []struct{ body, want string }{
		{`{"by":"aboss","force":true,"discard":false}`, `"force":true,"discard":false,"forceUnpushed":false`},
		{`{"by":"aboss","force":true}`, `"force":true,"discard":true,"forceUnpushed":false`},
	} {
		// boss's other child, made a running Claude Code agent so its archive waits for the final round.
		f.sql("UPDATE agents SET harness = 'claude', lifecycle = 'active', activity = 'idle', pending_action = NULL WHERE id = 'acodex'")
		code, body := controlCall(f, bossTok, "acodex", "archive", tc.body, nil)
		a := agentRow(t, f, "acodex")
		if code != 200 || a.PendingAction == nil || !strings.HasPrefix(*a.PendingAction, `{"type":"archive",`+tc.want+`,"at":`) {
			t.Errorf("%s: %d %s, pending %v", tc.body, code, body, a.PendingAction)
		}
	}
	local := map[string]string{"X-Stam-Local": "1"}
	cascade := func(token, body string, header map[string]string) (int, string) {
		rec := f.do(call{method: "POST", path: "/api/archive-children", token: token, body: body, header: header})
		return rec.Code, rec.Body.String()
	}
	if code, body := cascade(agentTok, `{"parents":["agone"]}`, local); code != 403 {
		t.Errorf("an agent's cascade: %d %s", code, body)
	}
	if code, body := cascade(sharedTok, `{"parents":["agone"]}`, nil); code != 403 {
		t.Errorf("a cascade from off the machine: %d %s", code, body)
	}
	if code, body := cascade(peerTok, `{"parents":[]}`, local); code != 400 || !strings.Contains(body, "parent ids are needed") {
		t.Errorf("no parents: %d %s", code, body)
	}
	if code, body := cascade(peerTok, `{"parents":["agone"],"fallback":[]}`, local); code != 200 || body != `{"archived":[],"archiving":[],"kept":[],"failed":[],"moved":[],"stayed":[],"ids":[]}` {
		t.Errorf("a peer's cascade: %d %s", code, body)
	}
}

// TestReconnectMCP: a Claude Code agent has no MCP reload, so a plain reconnect restarts it once its step ends, a
// whenIdle one (the deploy prune's) leaves it alone, and a Codex agent's is a 501.
func TestReconnectMCP(t *testing.T) {
	f := controlFixture(t)
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	if code, body := controlCall(f, agentTok, "achild", "reconnect-mcp", `{"by":"achild","whenIdle":true}`, nil); code != 200 || !strings.Contains(body, `"result":"reconnect requested"`) {
		t.Errorf("whenIdle: %d %s", code, body)
	}
	if a := agentRow(t, f, "achild"); a.PendingAction != nil {
		t.Errorf("whenIdle left a pending action: %s", *a.PendingAction)
	}
	if code, body := controlCall(f, agentTok, "achild", "reconnect-mcp", `{"by":"achild"}`, nil); code != 200 || !strings.Contains(body, `"result":"waiting for child to finish its step"`) {
		t.Errorf("a plain reconnect: %d %s", code, body)
	}
	if a := agentRow(t, f, "achild"); a.PendingAction == nil || *a.PendingAction != `{"type":"restart","reason":"reconnect MCP servers"}` {
		t.Errorf("pending = %v", a.PendingAction)
	}
	if code, body := controlCall(f, bossTok, "acodex", "reconnect-mcp", `{"by":"aboss"}`, nil); code != 501 || !strings.Contains(body, "reconnecting a codex agent's MCP servers is not ported") {
		t.Errorf("codex: %d %s", code, body)
	}
}

func agentRow(t *testing.T, f *fixture, id string) db.Agent {
	t.Helper()
	a, err := f.db.GetAgent(context.Background(), id)
	must(t, err)
	return a
}

func writeSettings(t *testing.T, f *fixture, text string) {
	t.Helper()
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(text), 0o600))
}
