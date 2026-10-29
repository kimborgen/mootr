package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"stam/internal/auth"
	"stam/internal/jsjson"
)

// mcpName is the server name a route takes: TS's [\w-]+, so any other name is no route at all.
var mcpName = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// mcpAuthInsecure is whether the MCP auth may use loopback http (MCP_AUTH_INSECURE, read as envVar does: MOOTR_ first). Tests
// set it for their fake servers; nothing else does.
func mcpAuthInsecure(getenv func(string) string) bool {
	v := getenv("MOOTR_MCP_AUTH_INSECURE")
	if v == "" {
		v = getenv("STAM_MCP_AUTH_INSECURE")
	}
	return v == "1"
}

func (s *Server) mcpRoutes() {
	s.handle("GET /api/mcp/status", s.mcpStatus)
	s.handle("GET /api/mcp/{name}/token", mcpPath(s.mcpToken))
	s.handle("POST /api/mcp/{name}/logout", mcpPath(s.mcpLogout))
	s.handle("POST /api/mcp/{name}/login", mcpPath(s.mcpLogin))
	s.mux.Handle("GET /oauth/callback", http.HandlerFunc(s.oauthCallback))
}

// mcpLogin is POST /api/mcp/NAME/login: the human, as trustedHuman proves it (an agent's token and an x-stam-human header
// prove nothing), starts a login and gets the authorize URL. The redirect is the one canonical web origin's callback,
// and a request whose Origin is another is refused.
func (s *Server) mcpLogin(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "log in to an MCP server"); err != nil {
		return nil, err
	}
	origin := s.canonicalWebOrigin()
	if given, ok := r.Header["Origin"]; ok && strings.TrimRight(strings.Join(given, ", "), "/") != origin {
		return nil, Errorf(http.StatusForbidden, "a login must come from %s", origin)
	}
	u, err := s.mcp.StartLogin(r.Context(), r.PathValue("name"), origin+"/oauth/callback")
	if err != nil {
		return nil, err
	}
	return map[string]string{"url": u}, nil
}

// oauthCallback is GET /oauth/callback, the OAuth redirect the browser follows: it completes the login its single-use
// state names and answers a short page.
func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	name, err := s.mcp.FinishLogin(r.Context(), q.Get("code"), q.Get("state"))
	if err != nil {
		sendHTML(w, http.StatusBadRequest, "Login failed: "+err.Error())
		return
	}
	sendHTML(w, http.StatusOK, "Logged in to "+name+". You can close this tab.")
}

var htmlEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")

// sendHTML is src/daemon.ts sendHtml: a one-paragraph page.
func sendHTML(w http.ResponseWriter, status int, text string) {
	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`<!doctype html><meta charset="utf-8"><title>mootr</title><p>` + htmlEscaper.Replace(text) + "</p>\n"))
}

// mcpPath refuses a route whose server name TS's pattern wouldn't match, as no route.
func mcpPath(h handler) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !mcpName.MatchString(r.PathValue("name")) {
			return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
		}
		return h(r, c)
	}
}

// mcpStatus is GET /api/mcp/status: one row per MCP server with an auth, and the home's state on a peer. No row
// holds a token.
func (s *Server) mcpStatus(r *http.Request, _ auth.Resolved) (any, error) {
	st, err := s.mcp.Rows(r.Context())
	if err != nil {
		return nil, err
	}
	servers := st.Servers
	if servers == nil {
		servers = []jsjson.Value{}
	}
	out := jsjson.NewObject("servers", servers, "home", nil)
	if st.Home != nil {
		out.Set("home", st.Home)
	}
	return json.RawMessage(jsjson.Stringify(out, "")), nil
}

// mcpToken is GET /api/mcp/NAME/token: the bearer and url a proxy reaches the server with. A peer never gets one (S-3212):
// it asks the settings home for a lease. Otherwise the human, or a known agent named by ?agent=, may read it.
func (s *Server) mcpToken(r *http.Request, c auth.Resolved) (any, error) {
	if c.Verified == auth.Peer {
		return nil, Errorf(http.StatusForbidden, "a peer may not fetch an MCP token; it asks the settings home for a lease (GET /api/peer/mcp/NAME/lease)")
	}
	q := r.URL.Query()
	human := s.isHuman(r, c)
	if agent := q.Get("agent"); !human && !(agent != "" && s.knownAgent(r, agent)) {
		return nil, Errorf(http.StatusForbidden, "only the human or a known agent may fetch an MCP token")
	}
	b, err := s.mcp.TokenFor(r.Context(), r.PathValue("name"), q.Get("refresh") == "1")
	if err != nil {
		return nil, err
	}
	var expires jsjson.Value
	if b.ExpiresAt != nil {
		expires = *b.ExpiresAt
	}
	out := jsjson.NewObject("name", b.Name, "url", b.URL, "token", b.Token, "expires_at", expires)
	return json.RawMessage(jsjson.Stringify(out, "")), nil
}

// knownAgent is whether an agent of that id exists here.
func (s *Server) knownAgent(r *http.Request, id string) bool {
	_, err := s.db.GetAgent(r.Context(), id)
	return err == nil
}

// mcpLogout is POST /api/mcp/NAME/logout: the human (trustedHuman, as login) forgets a server's login.
func (s *Server) mcpLogout(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "log out of an MCP server"); err != nil {
		return nil, err
	}
	name := r.PathValue("name")
	if err := s.mcp.Logout(name); err != nil {
		return nil, err
	}
	return json.RawMessage(jsjson.Stringify(jsjson.NewObject("logged_out", name), "")), nil
}
