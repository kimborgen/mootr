package mcpauth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// peerCase is one peer operation against a scripted home. The home answers each request with the next of replies (the
// last one repeats), or is not running when down.
type peerCase struct {
	name    string
	op      string // token, status or logout
	servers string
	grant   string // the peer's own grant, written to its store when set
	force   bool
	replies []homeReply
	down    bool
}

// peerCases are the peer operations shared with src/mcp-auth.ts: the lease, its url refetch and its refusals, the status
// with the home up, refused and down, and the logout with and without a grant of the peer's own.
func peerCases() []peerCase {
	lease := func(url, token string) string { return leaseBody(url, token, inAnHour()) }
	shared := `{"prov":{"url":"` + srvURL + `","auth":{"type":"oauth"},"shareWithPeers":true}}`
	status := `{"servers":[{"name":"prov","type":"oauth","logged_in":true,"expires_at":1792648896817}]}`
	return []peerCase{
		{name: "a lease", op: "token", servers: shared, replies: []homeReply{{status: 200, body: lease(srvURL, "LEASED-1")}}},
		{name: "a lease after a url refetch", op: "token", servers: shared, replies: []homeReply{
			{status: 200, body: lease("https://other.example/mcp", "WRONG")},
			{status: 200, body: lease(srvURL, "RIGHT")},
		}},
		{name: "two other urls", op: "token", servers: shared, replies: []homeReply{
			{status: 200, body: lease("https://other.example/mcp", "NEVER-USED")},
		}},
		{name: "a refused token", op: "token", servers: shared, replies: []homeReply{{status: 401, body: `{"error":"bad token"}`}}},
		{name: "a refused token without a reason", op: "token", servers: shared, replies: []homeReply{{status: 403, body: `{}`}}},
		{name: "no lease for the server", op: "token", servers: shared, replies: []homeReply{{status: 409, body: `{"error":"not logged in on this home"}`}}},
		{name: "a home error", op: "token", servers: shared, replies: []homeReply{{status: 500, body: ``}}},
		{name: "a home that is down", op: "token", servers: shared, down: true},
		{name: "the home's status", op: "status", servers: shared, replies: []homeReply{{status: 200, body: status}}},
		{name: "the home's status refused", op: "status", servers: shared, replies: []homeReply{{status: 403, body: `{}`}}},
		{name: "the home's status with the home down", op: "status", servers: shared, down: true},
		{name: "a peer's logout with no grant", op: "logout", servers: shared},
		{name: "a peer's logout with its old grant", op: "logout", servers: shared, grant: `{"server_url":"` + srvURL + `","access_token":"LOCAL-OLD","expires_at":9999999999999}`},
	}
}

// scriptedHome is a home that answers from c.replies, in order, and counts the requests it gets.
func scriptedHome(t *testing.T, c peerCase) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		i := n
		n++
		mu.Unlock()
		r := c.replies[len(c.replies)-1]
		if i < len(c.replies) {
			r = c.replies[i]
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(r.status)
		_, _ = w.Write([]byte(r.body))
	}))
	if c.down {
		srv.Close()
	} else {
		t.Cleanup(srv.Close)
	}
	return srv
}

// httpHomeGet is the peer's GET to the home over HTTP, with the lease token, as the server's mcpHomeGet makes it.
func httpHomeGet(ctx context.Context, p config.Peer, path string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(p.URL, "/")+path, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("authorization", "Bearer "+p.Bearer())
	cli := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := cli.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	return res.StatusCode, body, err
}

// runTSPeer runs the case through src/mcp-auth.ts and returns the answer, the RESULT line as JSON.
func runTSPeer(t *testing.T, c peerCase, home string) any {
	t.Helper()
	dir := t.TempDir()
	caseJSON, err := json.Marshal(map[string]any{
		"home":    home,
		"servers": json.RawMessage(c.servers),
		"grant":   rawOrNil(c.grant),
		"op":      c.op,
		"name":    "prov",
		"force":   c.force,
	})
	if err != nil {
		t.Fatal(err)
	}
	casePath := filepath.Join(dir, "case.json")
	if err := os.WriteFile(casePath, caseJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("node", "--no-warnings", "testdata/peer.mjs", dir, casePath).CombinedOutput()
	if err != nil {
		t.Fatalf("peer.mjs: %v\n%s", err, out)
	}
	var result string
	for _, line := range strings.Split(string(out), "\n") {
		if rest, ok := strings.CutPrefix(line, "RESULT "); ok {
			result = rest
		}
	}
	if result == "" {
		t.Fatalf("peer.mjs printed no RESULT line:\n%s", out)
	}
	var v any
	if err := json.Unmarshal([]byte(result), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// rawOrNil is the grant as JSON, or null when there is none.
func rawOrNil(grant string) any {
	if grant == "" {
		return nil
	}
	return json.RawMessage(grant)
}

// runGoPeer runs the same operation through this package's peer code, against the same home.
func runGoPeer(t *testing.T, c peerCase, home string) any {
	t.Helper()
	f := &fixture{t: t}
	f.settings = config.Settings{
		Home:       "home-machine",
		McpServers: mustParse(t, c.servers),
		Peers:      []config.Peer{{Name: "home-machine", URL: home, LeaseToken: "LEASE-SECRET"}},
	}
	f.a = New(Options{Home: t.TempDir(), Machine: "peer-machine", Settings: func() config.Settings { return f.settings }, Insecure: true, HomeGet: httpHomeGet})
	if c.grant != "" {
		f.writeGrant("prov", c.grant)
	}
	ctx := context.Background()
	var answer jsjson.Value
	var err error
	switch c.op {
	case "token":
		var b Bearer
		b, err = f.a.TokenFor(ctx, "prov", c.force)
		if err == nil {
			answer = jsjson.NewObject("ok", jsjson.NewObject("name", b.Name, "url", b.URL, "token", b.Token, "expires_at", expiresOf(b)))
		}
	case "status":
		var st Status
		st, err = f.a.Rows(ctx)
		if err == nil {
			var home jsjson.Value
			if st.Home != nil {
				home = st.Home
			}
			answer = jsjson.NewObject("ok", jsjson.NewObject("servers", st.Servers, "home", home))
		}
	case "logout":
		err = f.a.Logout("prov")
		if err == nil {
			answer = jsjson.NewObject("ok", jsjson.NewObject("logged_out", "prov"))
		}
	default:
		t.Fatalf("unknown op %s", c.op)
	}
	if err != nil {
		return map[string]any{"status": nil, "message": err.Error()}
	}
	var v any
	if err := json.Unmarshal([]byte(jsjson.Stringify(answer, "")), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// expiresOf is the bearer's expiry, or null when it never expires.
func expiresOf(b Bearer) jsjson.Value {
	if b.ExpiresAt == nil {
		return nil
	}
	return *b.ExpiresAt
}

// TestPeerMatchesTS runs every peerCases case through src/mcp-auth.ts and through this package's peer code, against the
// same scripted home, and wants the same answer: the same lease or status, or the same refusal with the same message.
func TestPeerMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/mcp-auth.ts")
	}
	for _, c := range peerCases() {
		t.Run(c.name, func(t *testing.T) {
			tsHome := scriptedHome(t, c)
			goHome := scriptedHome(t, c)
			want := runTSPeer(t, c, tsHome.URL)
			got := runGoPeer(t, c, goHome.URL)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("Go answers %v\nTS answers %v", got, want)
			}
		})
	}
}
