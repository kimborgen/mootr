package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/config"
	"stam/internal/jsjson"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// settingsFixture is a test home with the human's key and a settings.json holding a peer token and an MCP env value.
func settingsFixture(t *testing.T) (*fixture, string) {
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	// A refused cost config mails the human from a background goroutine; it ends before the database closes.
	t.Cleanup(f.srv.WaitBackground)
	path := filepath.Join(f.home, "settings.json")
	must(t, os.WriteFile(path, []byte(`{"peers":[{"name":"p","url":"http://p","token":"PEER-SECRET"}],"mcpServers":{"s":{"command":"c","env":{"K":"ENV-SECRET"}}},"boardViews":{"v0":{"mode":"status"}}}`+"\n"), 0o600))
	return f, path
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	must(t, err)
	return string(b)
}

// TestGetSettings: the shared token reads the file whole; an agent and the OpenCode server read it redacted. Each gets
// the local keys and the home, as TS's home does.
func TestGetSettings(t *testing.T) {
	f, path := settingsFixture(t)
	rec := f.do(call{path: "/api/config/settings", token: sharedTok})
	if rec.Code != 200 {
		t.Fatalf("GET: %d %s", rec.Code, rec.Body)
	}
	if want := `{"text":` + jsonString(readFile(t, path)) + `,"local":["home","peers","itsa.home","itsa.repos","search.embedder","debug.stallMs","files.roots","auth.humanStrict","auth.localHuman","resourceWarn.lastWarned","retro.lastDigest"],"home":"test-machine","stale":false,"fetchedAt":null}`; rec.Body.String() != want {
		t.Errorf("GET = %s\nwant %s", rec.Body, want)
	}
	for _, tok := range []string{agentTok, serverTok} {
		rec := f.do(call{path: "/api/config/settings", token: tok})
		if rec.Code != 200 || strings.Contains(rec.Body.String(), "SECRET") || !strings.Contains(rec.Body.String(), "[redacted]") {
			t.Errorf("GET as %s: %d %s", tok, rec.Code, rec.Body)
		}
	}
}

func jsonString(s string) string {
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // a string always encodes
	return strings.TrimSuffix(buf.String(), "\n")
}

// TestSettingsWritesNeedTheHuman: without the human's proof a write is refused and nothing is written; an agent that
// is neither the chief of staff nor the assistant gets TS's 403, and the chief of staff's ask writes nothing.
func TestSettingsWritesNeedTheHuman(t *testing.T) {
	f, path := settingsFixture(t)
	before := readFile(t, path)
	for _, c := range []call{
		{method: "PATCH", path: "/api/config/settings", token: sharedTok, body: `{"patch":{"chiefOfStaff":"x"}}`},
		{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}, body: `{"patch":{"chiefOfStaff":"x"}}`},
		{method: "POST", path: "/api/config/settings", token: sharedTok, header: map[string]string{"X-Stam-Human": "1"}, body: `{"text":"{}"}`},
		{method: "PATCH", path: "/api/config/settings", token: agentTok, body: `{"patch":{"chiefOfStaff":"x"}}`},
		{method: "POST", path: "/api/config/settings", token: agentTok, body: `{"text":"{}"}`},
	} {
		rec := f.do(c)
		if rec.Code != 403 || !strings.Contains(envelope(t, rec)["error"].(string), "only the human can change stam's settings") {
			t.Errorf("%s %v: %d %s", c.method, c.header, rec.Code, rec.Body)
		}
	}
	if readFile(t, path) != before {
		t.Errorf("a refused write changed the file")
	}
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'achild'")
	must(t, f.srv.settings.SetShared("chiefOfStaff", "achild"))
	before = readFile(t, path)
	if rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: agentTok, body: `{"patch":"x"}`}); rec.Code != 400 {
		t.Errorf("the chief of staff's bad patch: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: agentTok, body: `{"patch":{"a":1}}`}); rec.Code != 202 {
		t.Errorf("the chief of staff's ask: %d %s", rec.Code, rec.Body)
	}
	if readFile(t, path) != before {
		t.Errorf("an ask changed the file")
	}
}

// TestPatchSettingsConcurrent: patches sent at once, each adding its own view, all survive.
func TestPatchSettingsConcurrent(t *testing.T) {
	f, path := settingsFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: fmt.Sprintf(`{"patch":{"boardViews":{"b%d":{"mode":"status"}}}}`, i)})
			if rec.Code != 200 {
				t.Errorf("patch %d: %d %s", i, rec.Code, rec.Body)
			}
		}(i)
	}
	wg.Wait()
	var s struct {
		BoardViews map[string]any `json:"boardViews"`
		Peers      []map[string]any
	}
	must(t, json.Unmarshal([]byte(readFile(t, path)), &s))
	if len(s.BoardViews) != 21 {
		t.Errorf("views after 20 patches: %v", s.BoardViews)
	}
	if s.Peers[0]["token"] != "PEER-SECRET" {
		t.Errorf("a patch lost the peer token: %v", s.Peers)
	}
}

// TestPatchSettingsRefused: an invalid patch is refused whole with TS's status and message, and nothing is written.
func TestPatchSettingsRefused(t *testing.T) {
	f, path := settingsFixture(t)
	before := readFile(t, path)
	for _, c := range []struct {
		method, body string
		status       int
		error        string
	}{
		{"PATCH", `{"patch":"nope"}`, 400, "the patch must be an object"},
		{"PATCH", `{"patch":[1]}`, 400, "the patch must be an object"},
		{"PATCH", `{"patch":{"a":1,"cost":{"fallbackMinutes":0}}}`, 400, "cost config rejected: cost.fallbackMinutes must be a positive number"},
		{"PATCH", `{"patch":{"a":1,"requirements":{"keyPrefix":"R-"}}}`, 400, "requirements config rejected: requirements.keyPrefix must be letters only, such as R"},
		{"PATCH", `{"patch":{"harness":{"claude":{"promptCacheTtl":"2h"}}}}`, 400, `harness config rejected: harness.claude.promptCacheTtl must be "5m" or "1h"`},
		{"POST", `{"text":"{not json"}`, 400, "not valid JSON"},
		{"POST", `{"text":"{\"harness\":{\"x\":{}}}"}`, 400, "harness config rejected: harness.x is not a harness stam sets (claude, codex)"},
	} {
		rec := f.do(call{method: c.method, path: "/api/config/settings", token: sharedTok, header: trusted, body: c.body})
		if rec.Code != c.status || !strings.Contains(envelope(t, rec)["error"].(string), c.error) {
			t.Errorf("%s %s: %d %s", c.method, c.body, rec.Code, rec.Body)
		}
	}
	if readFile(t, path) != before {
		t.Errorf("a refused write changed the file: %s", readFile(t, path))
	}
}

// TestPatchAndPostSettings: the human's patch merges views per id and replaces other keys, fill only adds views, and
// a whole-file save writes the text as sent.
func TestPatchAndPostSettings(t *testing.T) {
	f, path := settingsFixture(t)
	patch := func(body string) {
		t.Helper()
		if rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: body}); rec.Code != 200 {
			t.Fatalf("PATCH %s: %d %s", body, rec.Code, rec.Body)
		}
	}
	patch(`{"patch":{"boardViews":{"v1":{"mode":"category"}},"chiefOfStaff":"cos"}}`)
	patch(`{"patch":{"boardViews":{"v0":{"mode":"x"},"v2":{"mode":"subtree"}},"chiefOfStaff":"other"},"fill":true}`)
	patch(`{"patch":{"boardViews":{"v1":null}}}`)
	var s struct {
		BoardViews   map[string]map[string]string `json:"boardViews"`
		ChiefOfStaff string                       `json:"chiefOfStaff"`
	}
	must(t, json.Unmarshal([]byte(readFile(t, path)), &s))
	if s.ChiefOfStaff != "cos" || s.BoardViews["v0"]["mode"] != "status" || s.BoardViews["v2"]["mode"] != "subtree" || s.BoardViews["v1"] != nil {
		t.Errorf("after the patches: %+v", s)
	}
	if got := f.srv.settings.Get().ChiefOfStaff; got != "cos" {
		t.Errorf("settings read %q after the patch", got)
	}
	text := "{\n\"chiefOfStaff\":  \"raw\"\n}"
	rec := f.do(call{method: "POST", path: "/api/config/settings", token: sharedTok, header: trusted, body: `{"text":` + jsonString(text) + `}`})
	if rec.Code != 200 || readFile(t, path) != text {
		t.Errorf("POST: %d %s; file %q", rec.Code, rec.Body, readFile(t, path))
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("settings.json mode: %v %v", info, err)
	}
}

// TestPatchKeepsFileMcpSecret: a plaintext MCP client secret already in the file doesn't block a patch of other keys,
// which keeps it; a patch that adds one stores it in the secret store and writes only the reference, and its answer holds
// no value. A refused patch stores nothing, and a store that can't be read refuses the patch and writes nothing.
func TestPatchKeepsFileMcpSecret(t *testing.T) {
	const value = "new-client-secret-9876"
	f, path := settingsFixture(t)
	must(t, os.WriteFile(path, []byte(`{"mcpServers":{"s":{"url":"https://x","auth":{"client_secret":"abc"}}}}`), 0o600))
	rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: `{"patch":{"boardViews":{"b":{"mode":"status"}}}}`})
	if rec.Code != 200 || !strings.Contains(readFile(t, path), `"client_secret": "abc"`) || !strings.Contains(readFile(t, path), `"boardViews"`) {
		t.Errorf("a views patch over a file with a plaintext secret: %d %s; file %s", rec.Code, rec.Body, readFile(t, path))
	}
	secrets := filepath.Join(f.srv.cfg.Home, "secrets.json")
	patch := `{"patch":{"mcpServers":{"t":{"url":"https://y","auth":{"client_secret":"` + value + `"}}}}}`
	// A refused patch (an invalid cost config beside it) stores nothing.
	bad := `{"patch":{"cost":{"display":{"mode":"nope"}},"mcpServers":{"t":{"url":"https://y","auth":{"client_secret":"` + value + `"}}}}}`
	if rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: bad}); rec.Code != 400 || fileExists(secrets) {
		t.Errorf("a refused patch: %d %s; secrets.json written %v", rec.Code, rec.Body, fileExists(secrets))
	}
	// A broken store refuses the patch, and the file stays as it was.
	must(t, os.WriteFile(secrets, []byte("{broken"), 0o600))
	before := readFile(t, path)
	if rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: patch}); rec.Code != 409 || readFile(t, path) != before || strings.Contains(rec.Body.String(), value) {
		t.Errorf("a patch over a broken store: %d %s; file changed %v", rec.Code, rec.Body, readFile(t, path) != before)
	}
	must(t, os.Remove(secrets))
	rec = f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: patch})
	name, _ := config.McpClientSecretName("t")
	if rec.Code != 200 || strings.Contains(rec.Body.String(), value) || strings.Contains(readFile(t, path), value) || !strings.Contains(readFile(t, path), `"secret": "`+name+`"`) {
		t.Errorf("a patch adding a plaintext secret: %d %s; file %s", rec.Code, rec.Body, readFile(t, path))
	}
	if got, _ := f.srv.secrets.Get(name); got.Reveal() != value {
		t.Errorf("the store holds %v under %s", got, name)
	}
}

// TestPatchRefusedAfterStoring: a patch whose text with the references is refused (TS's checkedPatchText checks it
// again) answers that 400 and leaves settings.json as it was, never empty.
func TestPatchRefusedAfterStoring(t *testing.T) {
	f, path := settingsFixture(t)
	must(t, os.WriteFile(path, []byte(`{"chiefOfStaff":"cos"}`), 0o600))
	calls := 0
	defer func(p func(string, *jsjson.Object, bool, *jsjson.Object) (string, *config.Problem)) { patched = p }(patched)
	patched = func(current string, patch *jsjson.Object, fill bool, reg *jsjson.Object) (string, *config.Problem) {
		if calls++; calls == 2 {
			return "", &config.Problem{Field: "mcpServers", Problem: "the second pass"}
		}
		return config.Patched(current, patch, fill, reg)
	}
	body := `{"patch":{"mcpServers":{"t":{"url":"https://y","auth":{"client_secret":"second-pass-secret"}}}}}`
	rec := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: body})
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "mcpServers config rejected: the second pass") || calls != 2 || readFile(t, path) != `{"chiefOfStaff":"cos"}` {
		t.Errorf("a refusal of the stored patch: %d %s after %d passes; file %q", rec.Code, rec.Body, calls, readFile(t, path))
	}
}

// TestPostStoresMcpSecret: the human's whole-file save moves each plain client secret into the store; the file and the
// answer hold the reference only.
func TestPostStoresMcpSecret(t *testing.T) {
	const value = "posted-client-secret-5555"
	f, path := settingsFixture(t)
	text := `{"mcpServers":{"a b":{"url":"https://x","auth":{"client_secret":"` + value + `"}}}}`
	rec := f.do(call{method: "POST", path: "/api/config/settings", token: sharedTok, header: trusted, body: `{"text":` + jsonString(text) + `}`})
	name, _ := config.McpClientSecretName("a b")
	if rec.Code != 200 || strings.Contains(rec.Body.String(), value) || strings.Contains(readFile(t, path), value) || !strings.Contains(readFile(t, path), name) {
		t.Fatalf("POST with a plain secret: %d %s; file %s", rec.Code, rec.Body, readFile(t, path))
	}
	if info, err := os.Stat(filepath.Join(f.srv.cfg.Home, "secrets.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("secrets.json: %v %v", info, err)
	}
}

// cosFixture is settingsFixture with achild the chief of staff.
func cosFixture(t *testing.T) (*fixture, string) {
	f, path := settingsFixture(t)
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id = 'achild'")
	must(t, f.srv.settings.SetShared("chiefOfStaff", "achild"))
	return f, path
}

// ask sends the chief of staff's settings ask and returns the request's id.
func ask(t *testing.T, f *fixture, method, body string) string {
	t.Helper()
	rec := f.do(call{method: method, path: "/api/config/settings", token: agentTok, body: body})
	if rec.Code != 202 {
		t.Fatalf("ask %s: %d %s", body, rec.Code, rec.Body)
	}
	var out struct{ Requested string }
	must(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out.Requested
}

// answer is the human's answer to a request; it returns the request as the route answers it.
func answer(t *testing.T, f *fixture, id string, approve bool) map[string]any {
	t.Helper()
	rec := f.do(call{method: "POST", path: "/api/permissions/" + id + "/answer", token: sharedTok, header: trusted, body: fmt.Sprintf(`{"approve":%v}`, approve)})
	if rec.Code != 200 {
		t.Fatalf("answer %s: %d %s", id, rec.Code, rec.Body)
	}
	var out map[string]any
	must(t, json.Unmarshal(rec.Body.Bytes(), &out))
	return out
}

// TestSettingsAsk: the chief of staff's patch is an ask with a diff that hides every secret, nothing is written until
// the human approves, and the approval applies it; another agent can't approve it.
func TestSettingsAsk(t *testing.T) {
	f, path := cosFixture(t)
	before := readFile(t, path)
	id := ask(t, f, "PATCH", `{"patch":{"mail":{"titles":{"model":"m2"}},"mcpServers":{"s":{"command":"c","env":{"K":"[redacted]"}}}}}`)
	if readFile(t, path) != before {
		t.Fatalf("an ask wrote the file")
	}
	r, ok, err := f.db.PermissionRequestByID(context.Background(), id)
	must(t, err)
	if !ok || r.Payload == nil || !strings.Contains(r.Details, `+    "titles": {`) || strings.Contains(r.Details, "SECRET") {
		t.Fatalf("the request: %+v", r)
	}
	var mails []string
	must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT body FROM mail WHERE permission_id = ?", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			mails = append(mails, stmt.ColumnText(0))
			return nil
		}})
	}))
	if len(mails) != 1 || strings.Contains(mails[0], "SECRET") || !strings.Contains(mails[0], "```diff") {
		t.Errorf("the ask's mail: %q", mails)
	}
	if rec := f.do(call{method: "POST", path: "/api/permissions/" + id + "/answer", token: sharedTok, body: `{"approve":true,"by":"aboss"}`}); rec.Code == 200 {
		t.Errorf("an agent approved a settings change: %s", rec.Body)
	}
	if out := answer(t, f, id, true); out["status"] != "approved" {
		t.Errorf("the approval: %v", out)
	}
	after := readFile(t, path)
	if !strings.Contains(after, `"model": "m2"`) || !strings.Contains(after, "ENV-SECRET") || !strings.Contains(after, "PEER-SECRET") {
		t.Errorf("the approved patch: %s", after)
	}
}

// TestSettingsAskRoundTrip: the chief of staff posts back its redacted GET with one edit; the approval writes the edit
// and keeps every secret.
func TestSettingsAskRoundTrip(t *testing.T) {
	f, path := cosFixture(t)
	rec := f.do(call{path: "/api/config/settings", token: agentTok})
	var got struct{ Text string }
	must(t, json.Unmarshal(rec.Body.Bytes(), &got))
	if strings.Contains(got.Text, "SECRET") {
		t.Fatalf("the chief of staff read a secret: %s", got.Text)
	}
	text := strings.Replace(got.Text, `"chiefOfStaff": "achild"`, `"chiefOfStaff": "achild", "debugX": 1`, 1)
	id := ask(t, f, "POST", `{"text":`+jsonString(text)+`}`)
	answer(t, f, id, true)
	after := readFile(t, path)
	if !strings.Contains(after, `"debugX": 1`) || !strings.Contains(after, "PEER-SECRET") || !strings.Contains(after, "ENV-SECRET") || strings.Contains(after, "[redacted]") {
		t.Errorf("the round trip: %s", after)
	}
	// A redacted value moved to another command is refused, and no ask is made.
	moved := strings.Replace(got.Text, `"command": "c"`, `"command": "other"`, 1)
	if rec := f.do(call{method: "POST", path: "/api/config/settings", token: agentTok, body: `{"text":` + jsonString(moved) + `}`}); rec.Code != 400 {
		t.Errorf("a redacted env under a changed command: %d %s", rec.Code, rec.Body)
	}
}

// TestSettingsAskStale: an approval whose touched value changed since the ask is not applied and is recorded as denied;
// a change to another key doesn't matter; a denial writes nothing.
func TestSettingsAskStale(t *testing.T) {
	f, path := cosFixture(t)
	n := &notices{}
	f.srv.noticeHook = n.add
	id := ask(t, f, "PATCH", `{"patch":{"mail":{"titles":{"model":"m2"}}}}`)
	other := ask(t, f, "PATCH", `{"patch":{"boardViews":{"v9":{"mode":"x"}}}}`)
	denied := ask(t, f, "PATCH", `{"patch":{"chiefOfStaff":"nobody"}}`)
	patch := f.do(call{method: "PATCH", path: "/api/config/settings", token: sharedTok, header: trusted, body: `{"patch":{"mail":{"titles":{"model":"human"}},"zzz":1}}`})
	if patch.Code != 200 {
		t.Fatalf("the human's patch: %d %s", patch.Code, patch.Body)
	}
	if out := answer(t, f, id, true); out["status"] != "denied" {
		t.Errorf("a stale approval: %v", out)
	}
	if !strings.Contains(readFile(t, path), `"model": "human"`) {
		t.Errorf("a stale approval overwrote the human's change: %s", readFile(t, path))
	}
	var told []string
	for _, l := range n.all() {
		if strings.HasPrefix(l, "achild: ") {
			told = append(told, l)
		}
	}
	if len(told) != 1 || !strings.Contains(told[0], "Your request "+id+" to change mootr's settings was approved, but not applied: a setting it changes changed after you asked") {
		t.Errorf("the stale approval's notice: %q", told)
	}
	if out := answer(t, f, other, true); out["status"] != "approved" || !strings.Contains(readFile(t, path), `"v9"`) {
		t.Errorf("an approval over an untouched change: %v", out)
	}
	before := readFile(t, path)
	if out := answer(t, f, denied, false); out["status"] != "denied" || readFile(t, path) != before {
		t.Errorf("a denial: %v", out)
	}
}

// TestSettingsAskPlainMcpSecret: on the home, the chief of staff's ask that puts an MCP client secret in plain text is
// asked with the value hidden in the diff; the approval moves it into the secret store, and settings.json gets only the
// reference.
func TestSettingsAskPlainMcpSecret(t *testing.T) {
	const value = "asked-client-secret-4321"
	f, path := cosFixture(t)
	id := ask(t, f, "PATCH", `{"patch":{"mcpServers":{"t":{"url":"https://y","auth":{"client_secret":"`+value+`"}}}}}`)
	if shown := f.text("SELECT reason || details FROM permission_requests WHERE id = ?", id) + f.text("SELECT coalesce(group_concat(subject || body, ''), '') FROM mail"); strings.Contains(shown, value) {
		t.Errorf("the ask's reason, diff or mail holds the secret: %s", shown)
	}
	// The payload holds it until the answer applies it; no route serves the payload (db.PublicRequest drops it).
	if !strings.Contains(f.text("SELECT payload FROM permission_requests WHERE id = ?", id), value) {
		t.Fatalf("the payload doesn't hold the asked value, so this test checks nothing")
	}
	for _, c := range []call{{path: "/api/permissions", token: sharedTok}, {path: "/api/permissions?status=pending", token: agentTok}, {path: "/api/permissions?status=pending", token: sharedTok, header: trusted}} {
		if rec := f.do(c); rec.Code != 200 || !strings.Contains(rec.Body.String(), id) || strings.Contains(rec.Body.String(), value) || strings.Contains(rec.Body.String(), `"payload"`) {
			t.Errorf("%s with %s: %d %s", c.path, c.token, rec.Code, rec.Body)
		}
	}
	if out := answer(t, f, id, true); out["status"] != "approved" {
		t.Fatalf("the approval: %v", out)
	}
	name, _ := config.McpClientSecretName("t")
	if text := readFile(t, path); strings.Contains(text, value) || !strings.Contains(text, `"secret": "`+name+`"`) {
		t.Errorf("after the approval: %s", text)
	}
	if got, _ := f.srv.secrets.Get(name); got.Reveal() != value {
		t.Errorf("the store holds %v under %s", got, name)
	}
}
