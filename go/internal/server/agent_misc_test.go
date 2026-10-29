package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
)

// fakeTmux is a tmux binary that answers every call at once, has every session, and logs each paste-buffer: one line
// per prompt delivered.
func fakeTmux(t *testing.T) (bin, log string) {
	t.Helper()
	dir := t.TempDir()
	log = filepath.Join(dir, "pastes")
	bin = filepath.Join(dir, "tmux")
	script := "#!/bin/sh\nfor a in \"$@\"; do [ \"$a\" = paste-buffer ] && echo paste >>'" + log + "'; done\nexit 0\n"
	must(t, os.WriteFile(bin, []byte(script), 0o755))
	return bin, log
}

// sessionTmux is a tmux binary that keeps its sessions as files in a t.TempDir: a launch makes one, kill-session removes
// it, and has-session asks for it. A launch is either new-session on the command line or, as tmux.Client.NewSession does,
// `start-server ; source-file FILE` with new-session in FILE; the harness it names never runs. Every other call
// succeeds. An archive can then see a stopped agent's session gone (S-4167).
func sessionTmux(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "tmux")
	script := strings.ReplaceAll(`#!/bin/sh
cmd=; name=; file=
while [ $# -gt 0 ]; do
  case "$1" in
    new-session|has-session|kill-session) cmd=$1 ;;
    source-file) cmd=$1; shift; file=$1 ;;
    -s|-t) shift; name=${1#=}; name=${name%%:*} ;;
  esac
  shift
done
if [ "$cmd" = source-file ]; then
  cmd=new-session
  name=$(sed -n "s/^'new-session' '-d' '-s' '\([^']*\)'.*/\1/p" "$file")
fi
case "$cmd" in
  new-session) [ -n "$name" ] && touch 'DIR'/s."$name" ;;
  has-session) [ -e 'DIR'/s."$name" ] ;;
  kill-session) rm -f 'DIR'/s."$name" ;;
esac
`, "DIR", dir)
	must(t, os.WriteFile(bin, []byte(script), 0o755))
	return bin
}

func pastes(t *testing.T, log string) int {
	t.Helper()
	b, err := os.ReadFile(log)
	if os.IsNotExist(err) {
		return 0
	}
	must(t, err)
	return strings.Count(string(b), "paste\n")
}

func promptFixture(t *testing.T) (*fixture, string) {
	t.Helper()
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey})
	checkout, err := filepath.Abs("../../..")
	must(t, err)
	bin, log := fakeTmux(t)
	withLifeRootTmux(f, checkout, bin)
	return f, log
}

func (f *fixture) postAs(token, path, body string, header map[string]string) (int, string) {
	f.t.Helper()
	rec := f.do(call{method: "POST", path: path, token: token, body: body, header: header})
	return rec.Code, rec.Body.String()
}

// TestPromptAccess: only the human types into an agent, as TS refuses everyone else with a 403; an agent with no
// session is a 409; the prompt is pasted once and recorded with its length and file count.
func TestPromptAccess(t *testing.T) {
	f, log := promptFixture(t)
	for _, tc := range []struct {
		name, token, body string
		header            map[string]string
	}{
		{"the agent itself", agentTok, `{"by":"achild","text":"hi"}`, nil},
		{"its parent", bossTok, `{"by":"aboss","text":"hi"}`, nil},
		{"the shared token without the human", sharedTok, `{"text":"hi"}`, nil},
		{"a peer", peerTok, `{"text":"hi"}`, map[string]string{"X-Stam-Local": "1"}},
	} {
		if code, body := f.postAs(tc.token, "/api/agents/achild/prompt", tc.body, tc.header); code != 403 || !strings.Contains(body, "only the human types into an agent") {
			t.Errorf("%s: %d %s", tc.name, code, body)
		}
	}
	if n := pastes(t, log); n != 0 {
		t.Fatalf("a refused prompt was pasted %d times", n)
	}
	if code, body := f.postAs(sharedTok, "/api/agents/nobody/prompt", `{"text":"hi"}`, humanHeader()); code != 404 {
		t.Errorf("no agent: %d %s", code, body)
	}
	code, body := f.postAs(sharedTok, "/api/agents/child/prompt", `{"text":"héllo","files":[{"name":"../../a b.txt","content_b64":"aGk="}]}`, humanHeader())
	if code != 200 || body != `{"sent":true}` {
		t.Fatalf("the human's prompt: %d %s", code, body)
	}
	if n := pastes(t, log); n != 1 {
		t.Errorf("pasted %d times", n)
	}
	evs, err := f.db.ListEvents(context.Background(), "achild", 5, "human:prompt")
	must(t, err)
	if len(evs) != 1 || evs[0].Data == nil || *evs[0].Data != `{"chars":5,"files":1}` {
		t.Errorf("events: %+v", evs)
	}
	// The upload stays in the agent's uploads folder, whatever its name says.
	ups, err := filepath.Glob(filepath.Join(f.home, "uploads", "achild", "*", "*"))
	must(t, err)
	if len(ups) != 1 || filepath.Base(ups[0]) != "1-a_b.txt" {
		t.Errorf("uploads: %v", ups)
	}
	if b, _ := os.ReadFile(ups[0]); string(b) != "hi" {
		t.Errorf("upload content %q", b)
	}
}

// TestPromptNoSession: an agent with no tmux session isn't typed into.
func TestPromptNoSession(t *testing.T) {
	f := controlFixture(t)
	if code, body := f.postAs(sharedTok, "/api/agents/achild/prompt", `{"text":"hi"}`, humanHeader()); code != 409 || !strings.Contains(body, "child isn't running") {
		t.Errorf("%d %s", code, body)
	}
}

// TestPromptDedup: a retried prompt (one client_id) is delivered once, also when the copies arrive at once; another id,
// or none, is another prompt; a failed first is forgotten, so its retry runs.
func TestPromptDedup(t *testing.T) {
	f, log := promptFixture(t)
	send := func(body string) (int, string) {
		return f.postAs(sharedTok, "/api/agents/achild/prompt", body, humanHeader())
	}
	// Eight identical posts at once: the first reserves the key before it pastes, the rest wait for its answer.
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = send(`{"text":"once","client_id":"c-1"}`)
		}(i)
	}
	wg.Wait()
	for i, c := range codes {
		if c != 200 {
			t.Errorf("post %d: %d", i, c)
		}
	}
	if n := pastes(t, log); n != 1 {
		t.Fatalf("eight concurrent copies of one prompt pasted %d times", n)
	}
	send(`{"text":"once","client_id":"c-1"}`)
	if n := pastes(t, log); n != 1 {
		t.Fatalf("a later retry pasted again: %d", n)
	}
	send(`{"text":"once","client_id":"c-2"}`)
	if n := pastes(t, log); n != 2 {
		t.Fatalf("a new client_id was dropped: %d", n)
	}
	send(`{"text":"twice"}`)
	send(`{"text":"twice"}`)
	if n := pastes(t, log); n != 4 {
		t.Fatalf("prompts without a client_id were deduplicated: %d", n)
	}
	// The same id from another agent's path is another prompt.
	f.postAs(sharedTok, "/api/agents/aboss/prompt", `{"text":"once","client_id":"c-1"}`, humanHeader())
	if n := pastes(t, log); n != 5 {
		t.Fatalf("the same id for another agent was dropped: %d", n)
	}
	// A refused first (a takeover) is forgotten: the retry after it is delivered.
	f.sql("UPDATE agents SET forwarded_to = 'aboss' WHERE id = 'acodex'")
	if code, body := f.postAs(sharedTok, "/api/agents/acodex/prompt", `{"text":"x","client_id":"c-3"}`, humanHeader()); code != 409 || !strings.Contains(body, "taken over by boss") {
		t.Fatalf("taken over: %d %s", code, body)
	}
	f.sql("UPDATE agents SET forwarded_to = NULL WHERE id = 'acodex'")
	if code, _ := f.postAs(sharedTok, "/api/agents/acodex/prompt", `{"text":"x","client_id":"c-3"}`, humanHeader()); code != 200 {
		t.Fatalf("the retry after a failure: %d", code)
	}
	if n := pastes(t, log); n != 6 {
		t.Fatalf("the retry after a failure: %d pastes", n)
	}
}

// TestPromptRetryAfterHangup: a client that hangs up while its prompt is pasted doesn't fail the delivery, so the
// outbox's retry with the same client_id gets the first answer and is not pasted again.
func TestPromptRetryAfterHangup(t *testing.T) {
	f, log := promptFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "/api/agents/achild/prompt", strings.NewReader(`{"text":"once","client_id":"c-hup"}`)).WithContext(ctx)
	r.Host = "127.0.0.1:7999"
	r.Header.Set("Authorization", "Bearer "+sharedTok)
	for k, v := range humanHeader() {
		r.Header.Set(k, v)
	}
	// The client hangs up once the paste is in, while PasteText waits to press Enter.
	go func() {
		for pastesNow(log) == 0 {
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
	}()
	f.srv.ServeHTTP(httptest.NewRecorder(), r)
	cancel()
	if code, body := f.postAs(sharedTok, "/api/agents/achild/prompt", `{"text":"once","client_id":"c-hup"}`, humanHeader()); code != 200 || body != `{"sent":true}` {
		t.Fatalf("the retry: %d %s", code, body)
	}
	if n := pastes(t, log); n != 1 {
		t.Fatalf("a prompt retried after a hang-up was pasted %d times", n)
	}
	if evs, _ := f.db.ListEvents(context.Background(), "achild", 5, "human:prompt"); len(evs) != 1 {
		t.Errorf("human:prompt events: %d", len(evs))
	}
}

func pastesNow(log string) int {
	b, _ := os.ReadFile(log)
	return strings.Count(string(b), "paste\n")
}

// TestNoticeRoute: only a peer queues a notice, and only for an active or paused agent.
func TestNoticeRoute(t *testing.T) {
	f := newFixture(t, nil)
	var got []string
	f.srv.noticeHook = func(id, text string) { got = append(got, id+": "+text) }
	if code, body := f.postAs(agentTok, "/api/agents/aboss/notice", `{"by":"achild","text":"x"}`, nil); code != 403 || !strings.Contains(body, "only a peer can queue a notice") {
		t.Errorf("an agent: %d %s", code, body)
	}
	if code, body := f.postAs(sharedTok, "/api/agents/aboss/notice", `{"text":"x"}`, humanHeader()); code != 403 {
		t.Errorf("the human: %d %s", code, body)
	}
	local := map[string]string{"X-Stam-Local": "1"}
	if code, body := f.postAs(peerTok, "/api/agents/aboss/notice", `{"text":"owner stopped"}`, local); code != 200 || body != `{}` {
		t.Errorf("a peer: %d %s", code, body)
	}
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'achild'")
	f.postAs(peerTok, "/api/agents/achild/notice", `{"text":"to a stopped agent"}`, local)
	f.postAs(peerTok, "/api/agents/aboss/notice", `{"text":7}`, local)
	if strings.Join(got, "|") != "aboss: owner stopped" {
		t.Errorf("notices: %v", got)
	}
}

// TestRetroFinal: only the agent itself files its final round; the event carries its effort, model, type and measured
// split.
func TestRetroFinal(t *testing.T) {
	f := newFixture(t, nil)
	if code, body := f.postAs(bossTokOr(f), "/api/agents/achild/retro-final", `{"by":"aboss","effort":{}}`, nil); code != 403 || !strings.Contains(body, "only the agent itself files its final retro round") {
		t.Errorf("its parent: %d %s", code, body)
	}
	if code, body := f.postAs(sharedTok, "/api/agents/achild/retro-final", `{"effort":{}}`, humanHeader()); code != 403 {
		t.Errorf("the human: %d %s", code, body)
	}
	f.sql(`INSERT INTO activity_items (agent_id, seq, turn, kind, name, start, "end", category) VALUES
		('achild', 1, 1, 'tool', 'Read', '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z', 'understand.read'),
		('achild', 2, 1, 'tool', 'Bash', '2026-10-01T00:01:00.000Z', '2026-10-01T00:04:00.000Z', 'verify.test')`)
	if code, body := f.postAs(agentTok, "/api/agents/achild/retro-final", `{"effort":{"reading":50,"testing":50}}`, nil); code != 200 || body != `{}` {
		t.Fatalf("the agent: %d %s", code, body)
	}
	evs, err := f.db.ListEvents(context.Background(), "achild", 5, "retro_final")
	must(t, err)
	if len(evs) != 1 || evs[0].Data == nil {
		t.Fatalf("events: %+v", evs)
	}
	var ev map[string]json.RawMessage
	must(t, json.Unmarshal([]byte(*evs[0].Data), &ev))
	if string(ev["effort"]) != `{"reading":50,"testing":50}` || string(ev["measured"]) != `{"reading":25,"implementing":0,"testing":75,"waiting":0,"review_fixes":0,"coordination":0}` {
		t.Errorf("event: %s", *evs[0].Data)
	}
}

func bossTokOr(f *fixture) string {
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(bossTok))
	return bossTok
}

// TestMeasuredFromItems: concurrent items split their stretch evenly, a gap is waiting, an uncategorized item is
// unclassified, and work inside a review-fix window is review_fixes.
func TestMeasuredFromItems(t *testing.T) {
	cat := func(s string) *string { return &s }
	items := []db.EffortItem{
		{Kind: "tool", Category: cat("produce.edit"), Start: "2026-10-01T00:00:00.000Z", End: "2026-10-01T00:02:00.000Z"},
		{Kind: "tool", Category: cat("communicate.mail"), Start: "2026-10-01T00:01:00.000Z", End: "2026-10-01T00:02:00.000Z"},
		{Kind: "gap", Start: "2026-10-01T00:02:00.000Z", End: "2026-10-01T00:03:00.000Z"},
		{Kind: "tool", Start: "2026-10-01T00:03:00.000Z", End: "2026-10-01T00:04:00.000Z"},
		{Kind: "tool", Category: cat("produce.edit"), Start: "2026-10-01T00:04:00.000Z", End: "2026-10-01T00:05:00.000Z"},
	}
	moves := []db.ItsaMove{
		{ItsaID: "i1", TS: "2026-10-01T00:04:00.000Z", Type: "status", Data: cat(`{"from":"in_review","to":"in_progress"}`)},
	}
	owner := "achild"
	windows := fixWindowsFrom(moves, map[string]*string{"i1": &owner}, map[string]string{"in_review": "review", "in_progress": "active"})
	m := measuredFromItems(items, windows["achild"], math.Inf(-1), math.Inf(1))
	b, _ := json.Marshal(m)
	want := `{"split":{"reading":0,"implementing":37.5,"testing":0,"waiting":25,"review_fixes":25,"coordination":12.5},"unclassified":20,"seconds":{"reading":0,"implementing":90,"testing":0,"waiting":60,"review_fixes":60,"coordination":30,"unclassified":60}}`
	if string(b) != want {
		t.Errorf("measured:\n got %s\nwant %s", b, want)
	}
	if measuredFromItems(nil, nil, math.Inf(-1), math.Inf(1)) != nil {
		t.Error("no items: want nil")
	}
}

// TestAgentFiles: the files list the agent folder's regular files; a symlink out of it, or to a file in it, is left
// out, and the secrets in the MCP config are redacted.
func TestAgentFiles(t *testing.T) {
	f := newFixture(t, nil)
	dir := filepath.Join(f.home, "agents", "achild")
	must(t, os.MkdirAll(filepath.Join(dir, "sub"), 0o700))
	must(t, os.WriteFile(filepath.Join(dir, "system-prompt.md"), []byte("# prompt\nAuthorization: Bearer abcdefghijklmnop\n"), 0o600))
	must(t, os.WriteFile(filepath.Join(dir, "claude-mcp.json"), []byte(`{"mcpServers":{"gh":{"command":"gh","env":{"GITHUB_TOKEN":"ghp_secretvalue"}},"web":{"type":"http","url":"https://x","headers":{"X-Api":"hdrsecret"}},"stam":{"command":"stam","args":["mcp"]}}}`), 0o600))
	outside := filepath.Join(t.TempDir(), "outside.txt")
	must(t, os.WriteFile(outside, []byte("OUTSIDE-SECRET"), 0o600))
	must(t, os.Symlink(outside, filepath.Join(dir, "escape.txt")))
	must(t, os.Symlink("../../token", filepath.Join(dir, "dotdot.txt")))
	// As src/adapters/codex.ts writes it: MCP env and header values in the app-server's environment.
	must(t, os.WriteFile(filepath.Join(dir, "codex-launch.sh"), []byte("#!/bin/sh\nGH_TOKEN='ghp_shsecret'\\''x' X_HDR=bareSecret123 MCP_PIN=40917253 SERVER='leakme' THREAD=leaktoo i=1234 /usr/bin/codex app-server >> '/tmp/log' 2>&1 &\nSERVER=$!\ni=0\nTHREAD=$(cat '/tmp/t')\n"), 0o600))
	rec := f.do(call{path: "/api/agents/achild/files", token: sharedTok})
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	var files []agentFile
	must(t, json.Unmarshal(rec.Body.Bytes(), &files))
	var names []string
	for _, x := range files {
		names = append(names, x.Name)
	}
	if strings.Join(names, ",") != "claude-mcp.json,codex-launch.sh,system-prompt.md" {
		t.Errorf("files: %v", names)
	}
	body := rec.Body.String()
	for _, secret := range []string{"OUTSIDE-SECRET", sharedTok, "ghp_secretvalue", "hdrsecret", "abcdefghijklmnop", "ghp_shsecret", "bareSecret123", "x' X_HDR", "40917253", "leakme", "leaktoo", "1234"} {
		if strings.Contains(body, secret) {
			t.Errorf("the reply leaks %q: %s", secret, body)
		}
	}
	if !strings.Contains(body, `\"args\": [\n        \"mcp\"`) {
		t.Errorf("the non-secret config is kept: %s", body)
	}
	if !strings.Contains(body, `GH_TOKEN='[redacted]' X_HDR='[redacted]' MCP_PIN='[redacted]' SERVER='[redacted]' THREAD='[redacted]' i='[redacted]' /usr/bin/codex app-server`) || !strings.Contains(body, `SERVER=$!\ni=0\nTHREAD=$(cat`) {
		t.Errorf("the launch script: %s", body)
	}
}

// TestAgentFilesCutOff: a file is read only up to the cap. A cut can't leave half a secret unredacted: a cut-off shell
// script, whose cap may land inside a quoted value, is withheld, as is a cut-off JSON file, which no longer parses. A
// cut-off prompt still shows its first fileLimit units.
func TestAgentFilesCutOff(t *testing.T) {
	dir := t.TempDir()
	// Three bytes and one code unit a character: the cut, past readLimit bytes, lands inside a quoted value while the
	// lines before it are still within the fileLimit units shown.
	pad := strings.Repeat("€", fileLimit-100)
	one := pad + "\nTOKEN='" + strings.Repeat("s", 4096) + "'\n"
	must(t, os.WriteFile(filepath.Join(dir, "codex-launch.sh"), []byte(one), 0o600))
	// A multi-line value (a PEM key), cut on a later line of it.
	pem := pad + "\nKEY='-----BEGIN KEY-----\npemsecret\n" + strings.Repeat("pemline\n", 2000) + "'\n"
	must(t, os.WriteFile(filepath.Join(dir, "pem.sh"), []byte(pem), 0o600))
	js := `{"env":{"K":"` + strings.Repeat("j", readLimit) + `jsonsecret"}}`
	must(t, os.WriteFile(filepath.Join(dir, "claude-mcp.json"), []byte(js), 0o600))
	must(t, os.WriteFile(filepath.Join(dir, "system-prompt.md"), []byte(strings.Repeat("p", readLimit+10)), 0o600))
	files, err := readAgentFiles(dir)
	must(t, err)
	if len(files) != 4 {
		t.Fatalf("files: %d", len(files))
	}
	for _, f := range files {
		if f.Name == "system-prompt.md" {
			if f.Text != strings.Repeat("p", fileLimit) {
				t.Errorf("a cut-off prompt shows %d units", utf16Len(f.Text))
			}
			continue
		}
		if f.Text != "" {
			t.Errorf("%s: %d units shown, ends %.60q", f.Name, utf16Len(f.Text), f.Text[max(0, len(f.Text)-60):])
		}
	}
}

// TestRedactOpenQuote: a quote left open (a value the text ends inside) is redacted to the end.
func TestRedactOpenQuote(t *testing.T) {
	for _, in := range []string{"A=1\nTOKEN='-----BEGIN\nsecretline\nmore", "A=1\nTOKEN=\"open\nsecretline"} {
		if got := redactSecrets("x.sh", in); strings.Contains(got, "secretline") || !strings.Contains(got, "TOKEN='[redacted]'") {
			t.Errorf("%q: %q", in, got)
		}
	}
}

// TestAgentFilesSwappedForFIFO: a FIFO put in a file's place after the listing is refused, not waited on: opening
// one for reading would block until a writer came.
func TestAgentFilesSwappedForFIFO(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "system-prompt.md")
	must(t, os.WriteFile(p, []byte("prompt"), 0o600))
	beforeOpen = func(p string) {
		must(t, os.Remove(p))
		must(t, syscall.Mkfifo(p, 0o600))
	}
	done := make(chan []agentFile, 1)
	t.Cleanup(func() {
		beforeOpen = nil
		// A blocked open (the failing case) gets its writer, so the goroutine ends.
		if w, err := os.OpenFile(p, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			w.Close()
		}
	})
	go func() {
		files, err := readAgentFiles(dir)
		must(t, err)
		done <- files
	}()
	select {
	case files := <-done:
		if len(files) != 0 {
			t.Errorf("a FIFO was read: %+v", files)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("reading the files blocked on a FIFO")
	}
}

// TestAgentFilesSwappedForSymlink: a file listed as regular and replaced by a symlink before it is opened is not read
// through the symlink.
func TestAgentFilesSwappedForSymlink(t *testing.T) {
	dir := t.TempDir()
	must(t, os.WriteFile(filepath.Join(dir, "system-prompt.md"), []byte("prompt"), 0o600))
	outside := filepath.Join(t.TempDir(), "outside.txt")
	must(t, os.WriteFile(outside, []byte("OUTSIDE-SECRET"), 0o600))
	beforeOpen = func(p string) {
		must(t, os.Remove(p))
		must(t, os.Symlink(outside, p))
	}
	t.Cleanup(func() { beforeOpen = nil })
	files, err := readAgentFiles(dir)
	must(t, err)
	if len(files) != 0 {
		t.Errorf("read through a symlink swapped in: %+v", files)
	}
}

// TestAgentUsage: an agent reads the usage of its own tree and its ancestors' trees only; a harness's missing counters
// and an agent with no rows read null.
func TestAgentUsage(t *testing.T) {
	f := newFixture(t, nil)
	f.sql("DELETE FROM usage WHERE agent_id = 'achild'")
	f.sql("UPDATE agents SET model = NULL WHERE id = 'achild'")
	f.sql(`INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write) VALUES
		('achild', '2026-01-01', 'claude', 'claude-x', '', 1.5, 10, 2, 0, 0)`)
	f.sql(`INSERT INTO agents (id, name, lifecycle, activity, harness, machine, cwd, created_at, updated_at) VALUES ('astr', 'stranger', 'active', 'idle', 'claude', 'test-machine', '/tmp', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
	rec := f.do(call{path: "/api/agents/achild/usage", token: agentTok})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"model":"claude-x","lifetime":{"cost_usd":1.5,"tokens_in":10,"tokens_out":2,"tokens_cache_read":0,"tokens_cache_write":0},"today":{"cost_usd":null`) {
		t.Errorf("its own: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/agents/aboss/usage", token: agentTok}); rec.Code != 200 {
		t.Errorf("its parent: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/agents/astr/usage", token: agentTok}); rec.Code != 403 || !strings.Contains(rec.Body.String(), "not stranger's") {
		t.Errorf("a stranger: %d %s", rec.Code, rec.Body)
	}
	if rec := f.do(call{path: "/api/agents/astr/usage", token: sharedTok}); rec.Code != 200 {
		t.Errorf("the shared token: %d %s", rec.Code, rec.Body)
	}
}
