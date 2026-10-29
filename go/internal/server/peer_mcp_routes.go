package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
	"stam/internal/mcpauth"
)

// homeTimeout is the limit of one call to a peer in TS's peerCall (8 s).
const homeTimeout = 8 * time.Second

// homeClient is the client for a peer's GET to its settings home (S-3177). It follows no redirect: a redirect would send
// the lease token to another address, so a 3xx is returned as it came and the caller refuses it. It has its own limit,
// not the peer client's health-check deadline, and a timeout here doesn't mark the home down.
var homeClient = &http.Client{
	Timeout:       homeTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// mcpHomeGet is the peer's GET to its settings home for a lease or the home's status (S-3177). The bearer is p's lease
// token, which the home's lease routes accept, and it goes to p's url only. A home that doesn't answer is an error; the
// answer's status and body are returned as they came, except that a refusal's body has the tokens redacted (S-3994).
func (s *Server) mcpHomeGet(ctx context.Context, p config.Peer, path string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(p.URL, "/")+path, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("authorization", "Bearer "+p.Bearer())
	req.Header.Set("x-stam-local", "1")
	req.Header.Set("accept-encoding", "identity")
	res, err := homeClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		body = []byte(s.peers.RedactText(p, string(body)))
	}
	return res.StatusCode, body, err
}

// peerLeaseRoute is the lease of a server to a peer (S-3176): GET /api/peer/mcp/NAME/lease and GET /api/peer/mcp/status.
// It is answered before the caller logic, as src/daemon.ts peerLeaseRoute does: its one bearer is the lease token, read
// per request and compared in constant time. The peer token, the shared token, an agent's token and no token are all
// refused here, so none reaches the routes. Only the settings home serves it. A lease is logged by server, caller and
// expiry, never with the token.
var peerLeasePath = regexp.MustCompile(`^/api/peer/mcp/([A-Za-z0-9_-]+)/lease$`)

func (s *Server) peerLeaseRoute(w http.ResponseWriter, r *http.Request) {
	token, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !bearer {
		writeError(w, Errorf(http.StatusUnauthorized, "the MCP lease route needs the lease token as a Bearer"))
		return
	}
	if !s.mcp.LeaseTokenMatches(token) {
		writeError(w, Errorf(http.StatusForbidden, "not the lease token"))
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, Errorf(http.StatusMethodNotAllowed, "no route %s %s", r.Method, r.URL.Path))
		return
	}
	if home := s.settings.Get().Home; home != s.cfg.Machine {
		writeError(w, &Error{Status: http.StatusConflict, Message: fmt.Sprintf("%s is not the settings home; MCP leases come from %s", s.cfg.Machine, home), Extra: map[string]any{"home": home}})
		return
	}
	if r.URL.Path == "/api/peer/mcp/status" {
		writeJSON(w, http.StatusOK, rawJSON(jsjson.NewObject("servers", s.sharedRows(r))))
		return
	}
	m := peerLeasePath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		writeError(w, Errorf(http.StatusNotFound, "no route GET %s", r.URL.Path))
		return
	}
	name := m[1]
	lease, err := s.mcp.LeaseFor(r.Context(), name, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		var le *mcpauth.LeaseError
		if errors.As(err, &le) {
			writeError(w, Errorf(le.Status, "%s", le.Message))
			return
		}
		writeError(w, Errorf(http.StatusBadGateway, "%s: the home could not get a token (%s)", name, err.Error()))
		return
	}
	slog.Info(fmt.Sprintf("mcp lease: %s to %s, expires %s", name, leaseCaller(r), isoMs(lease.ExpiresAt)))
	out := jsjson.NewObject("url", lease.URL, "access_token", lease.AccessToken, "expires_at", lease.ExpiresAt)
	writeJSON(w, http.StatusOK, rawJSON(out))
}

// sharedRows is the status rows of the servers the settings share: no token in any of them.
func (s *Server) sharedRows(r *http.Request) []jsjson.Value {
	rows := s.mcp.SharedRows(r.Context())
	if rows == nil {
		rows = []jsjson.Value{}
	}
	return rows
}

// leaseCaller is who a lease is for, as the log names it (S-3212). Behind `tailscale serve` the connection is loopback, so
// the client is the address serve forwards, read only from a loopback connection. The lease token is one secret for every
// peer, so it names no caller.
func leaseCaller(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	client := ""
	if loopback := host == "127.0.0.1" || host == "::1" || host == "::ffff:127.0.0.1"; loopback {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		client = strings.TrimSpace(parts[len(parts)-1])
	}
	switch {
	case client != "":
		return client
	case host != "":
		return host
	}
	return "a peer"
}

// isoMs is an epoch in ms as JavaScript's toISOString writes it.
func isoMs(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}

// rawJSON is a JSON value for writeJSON, which writes it as is.
func rawJSON(v jsjson.Value) json.RawMessage {
	return json.RawMessage(jsjson.Stringify(v, ""))
}
