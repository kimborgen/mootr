package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"stam/internal/mcp"
)

// TestCatalogRoutes: the tool catalog lists the MCP tools grouped with the harness note, the tiny models are the six
// steps, and /api/models reads the registry's models or OpenRouter's catalogue (a loopback fake), else a 400.
func TestCatalogRoutes(t *testing.T) {
	calls := 0
	or := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"data":[{"id":"x/y","name":"X Y","pricing":{"prompt":"0.000001","completion":"0.000002"}}]}`))
	}))
	t.Cleanup(or.Close)
	t.Setenv("STAM_OPENROUTER_URL", or.URL)
	f := controlFixture(t)
	body := f.do(call{path: "/api/tools", token: agentTok}).Body.String()
	if !strings.HasPrefix(body, `{"groups":[{"name":"Mail","tools":[`) || !strings.Contains(body, `{"name":"send_mail","description":"Send mail to one or more agents`) ||
		!strings.HasSuffix(body, `"harnessTools":{"note":"`+mcp.HarnessToolsNote+`"}}`) || strings.Contains(body, `"group":`) {
		t.Errorf("the tool catalog: %.300s", body)
	}
	body = f.do(call{path: "/api/tiny-models", token: agentTok}).Body.String()
	if strings.Count(body, `"modelPath":`) != 6 || !strings.Contains(body, `{"id":"toolNames","label":"Tool names"`) {
		t.Errorf("the tiny models: %.300s", body)
	}
	for i := 0; i < 2; i++ {
		if rec := f.do(call{path: "/api/models?kind=openrouter", token: agentTok}); rec.Code != 200 || rec.Body.String() != `{"models":[{"id":"x/y","name":"X Y","in":1,"out":2}]}` {
			t.Errorf("OpenRouter's models: %d %s", rec.Code, rec.Body)
		}
	}
	if calls != 1 {
		t.Errorf("the catalogue was fetched %d times, not once and then from memory", calls)
	}
	if rec := f.do(call{path: "/api/models?kind=harness&harness=codex", token: agentTok}); rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"models":[{"id":`) {
		t.Errorf("codex's models: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/models", token: agentTok}); rec.Code != 400 || !strings.Contains(rec.Body.String(), "kind is openrouter or harness") {
		t.Errorf("no kind: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/blocks/composing?type=reviewer&harness=claude", token: agentTok}); rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"blocks":[{"id":`) ||
		!strings.Contains(rec.Body.String(), `"template":"mail-to-human-restricted"`) || !strings.HasSuffix(rec.Body.String(), `"replacements":[]}`) {
		t.Errorf("the composer's blocks: %d %.300s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/blocks/composing?type=nope", token: agentTok}); rec.Code != 404 || !strings.Contains(rec.Body.String(), "no agent type nope") {
		t.Errorf("an unknown type: %d %s", rec.Code, rec.Body)
	}
}
