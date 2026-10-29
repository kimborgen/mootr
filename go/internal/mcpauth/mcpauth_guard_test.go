package mcpauth

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// Fail-closed cases: each one asserts the refusal and that nothing was sent to the provider, so removing the check it
// names makes the test fail.

// A client secret held as a reference the secret store doesn't give (no store here) is refused before any request
// leaves, and the stored refresh token is kept.
func TestSecretReferenceRefusesBeforeAnyProviderCall(t *testing.T) {
	p := newProvider(t, 0, false)
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","client_secret":{"secret":"mcp:prov"},"token_endpoint":"`+p.srv.URL+`/token","access_token":"OLD","refresh_token":"R1","expires_at":1}`)
	if _, err := f.a.Token(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "secret store") {
		t.Fatalf("a secret reference answered %v, want a refusal naming the secret store", err)
	}
	if n := p.calls.Load(); n != 0 {
		t.Errorf("%d provider calls for a secret reference, want 0", n)
	}
	if g, _ := f.a.storedGrant("prov"); g.refreshToken != "R1" {
		t.Errorf("the refresh token changed after a refusal: %q", g.refreshToken)
	}
}

// A reference is read from the store: an `mcp` entry's value goes to the token endpoint. An entry tagged for another
// provider and a broken secrets.json are each refused before any request leaves, and no error carries the value.
func TestSecretReferenceReadsTheStore(t *testing.T) {
	const value = "sv-client-secret-123456"
	var sent []string
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		mu.Lock()
		sent = append(sent, r.PostForm.Get("client_secret"))
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"NEW","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	setup := func(machine, provider string, broken bool) *fixture {
		f := newFixture(t, machine, "m", oneServer(srvURL))
		f.a.opt.Secrets = config.NewSecrets(f.a.opt.Home, func(string) string { return "" })
		body := jsjson.NewObject("value", value, "provider", provider)
		if _, err := f.a.opt.Secrets.Set("prov-client", body); err != nil {
			t.Fatal(err)
		}
		if broken {
			if err := os.WriteFile(filepath.Join(f.a.opt.Home, "secrets.json"), []byte("{not json"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","client_secret":{"secret":"prov-client"},"token_endpoint":"`+srv.URL+`/token","refresh_token":"R1","expires_at":1}`)
		return f
	}
	if tok, err := setup("m", "mcp", false).a.Token(context.Background(), "prov", false); err != nil || tok != "NEW" || len(sent) != 1 || sent[0] != value {
		t.Fatalf("an mcp reference: %q %v, sent %d", tok, err, len(sent))
	}
	for _, c := range []struct {
		name, machine, provider, want string
		broken                        bool
	}{
		{"another provider's key", "m", "openai", "is not an MCP client secret", false},
		{"a broken store", "m", "mcp", "isn't in the secret store", true},
	} {
		_, err := setup(c.machine, c.provider, c.broken).a.Token(context.Background(), "prov", false)
		if err == nil || !strings.Contains(err.Error(), c.want) || strings.Contains(err.Error(), value) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	if len(sent) != 1 {
		t.Errorf("%d token requests, want only the first", len(sent))
	}
}

// A plain client secret that isn't a credential (a space, a control byte) is refused before any request.
func TestBadPlainSecretRefusesBeforeAnyProviderCall(t *testing.T) {
	for _, secret := range []string{`"bad value"`, `"tab\there"`} {
		p := newProvider(t, 0, false)
		f := newFixture(t, "m", "m", oneServer(srvURL))
		f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","client_secret":`+secret+`,"token_endpoint":"`+p.srv.URL+`/token","refresh_token":"R1","expires_at":1}`)
		if _, err := f.a.Token(context.Background(), "prov", false); err == nil || !strings.Contains(err.Error(), "invalid prov's client secret") {
			t.Errorf("secret %s answered %v, want the invalid-secret refusal", secret, err)
		}
		if n := p.calls.Load(); n != 0 {
			t.Errorf("secret %s: %d provider calls, want 0", secret, n)
		}
	}
}

// A provider's error is echoed only as a plain code. A token or secret in it never reaches the error, and an
// allowed code passes through.
func TestProviderErrorWithATokenNeverReachesTheError(t *testing.T) {
	// An alphanumeric token-shaped string, which a shape rule would pass: only the exact OAuth codes are echoed.
	const leak = "sk1LEAKabc234XYZ"
	if _, err := tokenResponse(mustParse(t, `{"ok":false,"error":"`+leak+`"}`)); err == nil || strings.Contains(err.Error(), leak) || err.Error() != "the token endpoint refused: unknown error" {
		t.Errorf("a token in the provider's error answered %v", err)
	}
	if _, err := tokenResponse(mustParse(t, `{"ok":false,"error":"Bearer sk/LEAK 1234"}`)); err == nil || strings.Contains(err.Error(), "LEAK") {
		t.Errorf("a token in a sentence answered %v", err)
	}
	for code := range providerCodes {
		if _, err := tokenResponse(mustParse(t, `{"ok":false,"error":"`+code+`"}`)); err == nil || err.Error() != "the token endpoint refused: "+code {
			t.Errorf("the code %s answered %v, want it echoed", code, err)
		}
	}
	if _, err := tokenResponse(mustParse(t, `{"ok":false,"error":"invalid_grant"}`)); err == nil || err.Error() != "the token endpoint refused: invalid_grant" {
		t.Errorf("a plain code answered %v, want it echoed", err)
	}
	if _, err := tokenResponse(mustParse(t, `{"ok":false,"error":{"detail":"`+leak+`"}}`)); err == nil || strings.Contains(err.Error(), leak) {
		t.Errorf("an object error answered %v", err)
	}

	// End to end: the provider answers 200 with the leak in its error, and the refresh is refused with no leak in the
	// error or in the logs.
	logs := captureLogs(t)
	f := newFixture(t, "m", "m", oneServer(srvURL))
	srv := newLeakingProvider(t, `{"ok":false,"error":"`+leak+`"}`)
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"`+srv.URL+`/token","access_token":"OLD","refresh_token":"R1","expires_at":1}`)
	_, err := f.a.Token(context.Background(), "prov", false)
	if err == nil || strings.Contains(err.Error(), leak) {
		t.Errorf("the refresh answered %v, want a refusal with no token in it", err)
	}
	if strings.Contains(logs.String(), leak) || strings.Contains(logs.String(), "LEAK") {
		t.Errorf("a token reached the logs: %s", logs.String())
	}
}

// captureLogs sends the default slog logger to a buffer until the test ends, and returns the buffer.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// A temp file whose writer is dead is swept when the auth starts: a crash leaves it holding a whole store.
func TestSweepRemovesADeadWritersTemp(t *testing.T) {
	cmd := exec.Command("true")
	if err := cmd.Run(); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	leftover := filepath.Join(home, fmt.Sprintf(".mcp-auth.%d.1.tmp", cmd.Process.Pid)) // reaped, so the pid is gone
	if err := os.WriteFile(leftover, []byte(`{"prov":{"access_token":"SECRET-LEFT"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	New(Options{Home: home})
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Errorf("a dead writer's temp file holding a login survived start: %v", err)
	}
}

// A temp file whose writer is alive, an unparseable name, and the store itself are kept by the sweep.
func TestSweepKeepsLiveWritersAndOtherNames(t *testing.T) {
	home := t.TempDir()
	keep := []string{
		fmt.Sprintf(".mcp-auth.%d.1.tmp", os.Getppid()), // a live process
		fmt.Sprintf(".mcp-auth.%d.2.tmp", os.Getpid()),  // this one
		".mcp-auth-123456.tmp",                          // the pattern of a build that never ran as the live daemon
		".mcp-auth.x.tmp",
		".mcp-auth.99999999999.4.tmp", // a pid no system has: out of range, so kept
		"mcp-auth.json",
	}
	for _, name := range keep {
		if err := os.WriteFile(filepath.Join(home, name), []byte(`{}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	New(Options{Home: home})
	for _, name := range keep {
		if _, err := os.Stat(filepath.Join(home, name)); err != nil {
			t.Errorf("the sweep removed %s: %v", name, err)
		}
	}
}

// A write is in flight when a new daemon starts on the same home: its temp file belongs to a live writer, so the sweep
// keeps it, and the rotated token still commits.
func TestActiveWriteSurvivesANewDaemon(t *testing.T) {
	home := t.TempDir()
	a := New(Options{Home: home})
	paused, resume := make(chan struct{}), make(chan struct{})
	a.afterTemp = func() {
		close(paused)
		<-resume
	}
	store := func(v string) *jsjson.Object {
		return mustParse(t, `{"prov":{"access_token":"`+v+`"}}`).(*jsjson.Object)
	}
	done := make(chan error, 1)
	go func() { done <- a.write(store("ROTATED")) }()
	<-paused
	New(Options{Home: home}) // a second daemon on the same home starts its sweep
	close(resume)
	if err := <-done; err != nil {
		t.Fatalf("the write failed after the sweep: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(home, "mcp-auth.json"))
	if err != nil || !strings.Contains(string(raw), "ROTATED") {
		t.Errorf("the rotated store did not commit: %v %q", err, raw)
	}
}

// The refresh is not cancelled with the caller that started it. The provider rotates the refresh token and answers,
// the first caller goes away, and the second caller still gets the new token and the rotated refresh token is saved.
func TestRefreshSurvivesTheStartingCallerLeaving(t *testing.T) {
	p := newProvider(t, 0, true)
	f := newFixture(t, "m", "m", oneServer(srvURL))
	f.writeGrant("prov", `{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"`+p.srv.URL+`/token","access_token":"OLD","refresh_token":"R1","expires_at":1}`)

	ctxA, cancelA := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	wg.Add(1)
	var errA error
	doneA := make(chan struct{})
	go func() {
		defer wg.Done()
		defer close(doneA)
		_, errA = f.a.Token(ctxA, "prov", false)
	}()
	<-p.arrived // the provider has the request

	var tokenB string
	var errB error
	wg.Add(1)
	go func() {
		defer wg.Done()
		tokenB, errB = f.a.Token(context.Background(), "prov", false)
	}()

	cancelA()
	// The starting caller returns at once with its own cancellation, while the provider still holds the request.
	select {
	case <-doneA:
	case <-time.After(5 * time.Second):
		t.Fatal("the starting caller did not return after its context was cancelled")
	}
	if !errors.Is(errA, context.Canceled) {
		t.Errorf("the starting caller returned %v, want its own context.Canceled", errA)
	}
	close(p.release) // the provider answers with a rotated refresh token
	wg.Wait()

	if errB != nil {
		t.Fatalf("the waiting caller got %v after the starting caller left", errB)
	}
	if !strings.HasPrefix(tokenB, "NEW-") {
		t.Errorf("the waiting caller got %q, want the refreshed token", tokenB)
	}
	// One refresh reached the provider in every ordering: a retry after a lost refresh would be a second call, and it
	// would also be the way a rotated refresh token gets lost.
	if n := p.calls.Load(); n != 1 {
		t.Errorf("%d provider refreshes, want 1: the refresh was lost with the caller", n)
	}
	g, ok := f.a.storedGrant("prov")
	if !ok || g.refreshToken != "R2" {
		t.Errorf("the rotated refresh token was lost: stored %+v", g)
	}
}

// Store reads never overlap a write, and a reader sees the old store or the new one, never a truncated file: a
// writer swaps the grant's bearer many times while a reader reads the file and parses it.
func TestStoreWritesAreAtomic(t *testing.T) {
	f := newFixture(t, "m", "m", oneServer(srvURL))
	store := func(v string) *jsjson.Object {
		return mustParse(t, `{"prov":{"server_url":"`+srvURL+`","client_id":"c","token_endpoint":"https://x.example/t","access_token":"`+v+`","expires_at":9999999999999}}`).(*jsjson.Object)
	}
	if err := f.a.write(store("A0")); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(done)
		for i := 0; i < 300; i++ {
			if err := f.a.write(store("A" + string(rune('0'+i%10)))); err != nil {
				t.Errorf("write %d: %v", i, err)
				return
			}
		}
	}()
	reads := 0
	for {
		select {
		case <-done:
			if reads == 0 {
				t.Fatal("the reader never ran")
			}
			return
		default:
		}
		raw, err := os.ReadFile(filepath.Join(f.a.opt.Home, "mcp-auth.json"))
		if err != nil {
			t.Fatalf("read during a write: %v", err)
		}
		v, perr := jsjson.Parse(raw)
		if perr != nil {
			t.Fatalf("a read saw a half-written store: %v in %q", perr, raw)
		}
		if _, ok := v.(*jsjson.Object).Get("prov"); !ok {
			t.Fatalf("a read saw an empty store: %q", raw)
		}
		reads++
	}
}

// A reader that goes through the daemon's locked read never sees the login absent while a writer keeps it present.
func TestLockedReadNeverSeesTheLoginAbsent(t *testing.T) {
	f := newFixture(t, "m", "m", oneServer(srvURL))
	grant := func(v string) string {
		return `{"server_url":"` + srvURL + `","client_id":"c","token_endpoint":"https://x.example/t","access_token":"` + v + `","expires_at":9999999999999}`
	}
	f.writeGrant("prov", grant("A0"))
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer close(done)
		for i := 0; i < 300; i++ {
			if err := f.a.update(func(s *jsjson.Object) *jsjson.Object {
				s.Set("prov", mustParse(t, grant("A"+string(rune('0'+i%10)))))
				return s
			}); err != nil {
				t.Errorf("update %d: %v", i, err)
				return
			}
		}
	}()
	for {
		select {
		case <-done:
			wg.Wait()
			return
		default:
		}
		if _, ok := f.a.storedGrant("prov"); !ok {
			t.Fatal("a locked read saw the login absent while it was kept")
		}
	}
}

// newLeakingProvider answers every request 200 with body.
func newLeakingProvider(t *testing.T, body string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}
