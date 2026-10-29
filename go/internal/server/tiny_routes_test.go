package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"stam/internal/catalog"
	"stam/internal/tiny"
)

// startStub runs the stub model endpoint the TS tests use (test/decide-stub.mjs) and points stam's OpenRouter calls at
// it, with a key.
func startStub(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("node", "../../../test/decide-stub.mjs", dir)
	must(t, cmd.Start())
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	for i := 0; i < 500; i++ {
		if b, err := os.ReadFile(filepath.Join(dir, "url")); err == nil && len(b) > 0 {
			t.Setenv("STAM_OPENROUTER_URL", strings.TrimSpace(string(b)))
			t.Setenv("OPENROUTER_API_KEY", "test-key")
			return dir
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the stub did not start")
	return ""
}

// TestTinyRoutes: src/daemon.ts POST /api/tool-summaries and /api/tool-names. Only the human's view asks; the agent and
// the lists are checked; a summary and a label come from the model (the stub), and with the step off a stored summary
// still comes back alone.
func TestTinyRoutes(t *testing.T) {
	startStub(t)
	f := controlFixture(t)
	writeSettings(t, f, `{"tiny":{"toolSummary":{"enabled":true}}}`)
	post := func(c call) (int, string) {
		c.method = "POST"
		rec := f.do(c)
		return rec.Code, rec.Body.String()
	}
	for _, c := range []struct {
		call
		code int
		want string
	}{
		{call{path: "/api/tool-summaries", token: agentTok, body: `{"agent":"achild","calls":[]}`}, 403, "tool summaries are for the human's view"},
		{call{path: "/api/tool-names", token: agentTok, body: `{"agent":"achild","names":[]}`}, 403, "tool names are for the human's view"},
		{call{path: "/api/tool-summaries", header: humanHeader(), body: `{"calls":[]}`}, 400, "agent is required, at most 200 characters"},
		{call{path: "/api/tool-summaries", header: humanHeader(), body: `{"agent":"` + strings.Repeat("a", 201) + `","calls":[]}`}, 400, "agent is required"},
		{call{path: "/api/tool-summaries", header: humanHeader(), body: `{"agent":"achild","calls":"x"}`}, 400, "calls must be a list"},
		{call{path: "/api/tool-summaries", header: humanHeader(), body: `{"agent":"achild","calls":[{"id":"a"}]}`}, 400, "each call needs an id and a name"},
		{call{path: "/api/tool-names", header: humanHeader(), body: `{"agent":"nobody","names":[]}`}, 404, "no such agent"},
		{call{path: "/api/tool-names", header: humanHeader(), body: `{"agent":"achild","names":[3]}`}, 400, "each name must be text"},
	} {
		if code, body := post(c.call); code != c.code || !strings.Contains(body, c.want) {
			t.Errorf("%s %s: %d %s", c.path, c.body, code, body)
		}
	}
	stub := `{"enabled":true,"summaries":{"toolu_1":{"tool":"stub Read","doing":"doing the stub work of Read"}},"pending":[]}`
	if code, body := post(call{path: "/api/tool-summaries", header: humanHeader(), body: `{"agent":"achild","calls":[{"id":"toolu_1","name":"Read","input":{"file_path":"/a"}}],"wait":5000}`}); code != 200 || body != stub {
		t.Errorf("a summary: %d %s", code, body)
	}
	if code, body := post(call{path: "/api/tool-names", header: humanHeader(), body: `{"agent":"achild","names":["Read","mcp__stam__send_mail"],"wait":5000}`}); code != 200 || body != `{"enabled":true,"labels":{"Read":"Read","mcp__stam__send_mail":"Stub send_mail"},"pending":[]}` {
		t.Errorf("the labels: %d %s", code, body)
	}
	writeSettings(t, f, `{"tiny":{"toolSummary":{"enabled":false}}}`)
	if code, body := post(call{path: "/api/tool-summaries", header: humanHeader(), body: `{"agent":"achild","calls":[{"id":"toolu_1","name":"Read","input":{"file_path":"/a"}},{"id":"new","name":"Read"}]}`}); code != 200 || body != strings.Replace(stub, `"enabled":true`, `"enabled":false`, 1) {
		t.Errorf("the step off: %d %s", code, body)
	}
	if n := f.text("SELECT count(*) FROM usage WHERE agent_id = 'stam' AND account = 'openrouter-system'"); n != "1" {
		t.Errorf("the spend rows: %s", n)
	}
}

// TestMailTitlesRoute: src/daemon.ts POST /api/mail-titles (S-1843). Only the human's view asks: an agent's token, the
// peer token, the OpenCode server and the daemon token without the human's header are refused, each before any mail is
// looked at. As in TS, a non-agent caller sending x-stam-human is the human unless auth.humanStrict is on, so the peer
// token is refused with that header under strict only. ids must be a list of mail ids of at most 200 characters. A
// mail with a stale title is queued, never waited for, and its new title lands with the hash it was asked with.
func TestMailTitlesRoute(t *testing.T) {
	startStub(t)
	f := controlFixture(t)
	post := func(c call) (int, string) {
		c.method, c.path = "POST", "/api/mail-titles"
		rec := f.do(c)
		return rec.Code, rec.Body.String()
	}
	human := humanHeader()
	refused := func(name string, c call, why string) {
		t.Helper()
		if code, body := post(c); code != 403 || !strings.Contains(body, why) {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
	const route = "mail titles are for the human's view"
	refused("an agent's token", call{token: agentTok, body: `{"ids":["m1"]}`}, route)
	refused("an agent's token with the human's header", call{token: agentTok, header: human, body: `{"ids":["m1"]}`}, route)
	refused("the peer token", call{token: peerTok, header: map[string]string{"X-Stam-Local": "1"}, body: `{"ids":["m1"]}`}, route)
	refused("the daemon token without the human's header", call{token: sharedTok, body: `{"ids":["m1"]}`}, route)
	// The OpenCode server is refused before the route, by the identity check every write from it passes.
	refused("the OpenCode server", call{token: serverTok, header: human, body: `{"ids":["m1"]}`}, "OpenCode server")
	refused("the OpenCode server naming an agent", call{token: serverTok, header: human, body: `{"by":"achild","ids":["m1"]}`}, "")
	writeSettings(t, f, `{"auth":{"humanStrict":true}}`)
	refused("the peer token with the human's header under strict", call{token: peerTok, header: map[string]string{"X-Stam-Local": "1", "X-Stam-Human": "1"}, body: `{"ids":["m1"]}`}, route)
	writeSettings(t, f, `{}`)
	for _, body := range []string{`{"ids":"m1"}`, `{}`, `[]`, `{"ids":[1]}`, `{"ids":[""]}`, `{"ids":["m1",null]}`, `{"ids":["` + strings.Repeat("i", 201) + `"]}`, `{"ids":["` + strings.Repeat("😀", 101) + `"]}`} {
		if code, out := post(call{header: human, body: body}); code != 400 || !strings.Contains(out, "ids must be mail ids, at most 200 characters each") {
			t.Errorf("%.40s: %d %s", body, code, out)
		}
	}
	for _, body := range []string{`{"ids":[]}`, `{"ids":["` + strings.Repeat("i", 200) + `","` + strings.Repeat("😀", 100) + `"]}`} {
		if code, out := post(call{header: human, body: body}); code != 200 || out != `{"enabled":false,"pending":[]}` {
			t.Errorf("the model off, %.40s: %d %s", body, code, out)
		}
	}

	writeSettings(t, f, `{"mail":{"titles":{"model":"google/gemma-3-4b-it"}}}`)
	if code, out := post(call{header: human, body: `{"ids":["m1","nope"]}`}); code != 200 || out != `{"enabled":true,"pending":["m1"]}` {
		t.Fatalf("a mail with no title: %d %s", code, out)
	}
	cfg := tiny.ConfigHash("google/gemma-3-4b-it", catalog.MailTitlePrompt)
	for i := 0; i < 500 && f.text("SELECT IFNULL(title_config, '') FROM mail WHERE id = 'm1'") != cfg; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if got := f.text("SELECT title || ' ' || title_config FROM mail WHERE id = 'm1'"); got != "s "+cfg {
		t.Fatalf("m1's title and hash = %q", got)
	}
	for i := 0; i < 500; i++ {
		if _, out := post(call{header: human, body: `{"ids":["m1"]}`}); out == `{"enabled":true,"pending":[]}` {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if code, out := post(call{header: human, body: `{"ids":["m1"]}`}); code != 200 || out != `{"enabled":true,"pending":[]}` {
		t.Errorf("a current title: %d %s", code, out)
	}
	if n := f.text("SELECT count(*) FROM usage WHERE agent_id = 'stam' AND account = 'openrouter-system'"); n != "1" {
		t.Errorf("the spend rows: %s", n)
	}
}
