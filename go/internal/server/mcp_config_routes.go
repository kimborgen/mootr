package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"

	"stam/internal/auth"
	"stam/internal/jsjson"
	"stam/internal/mcpservers"
)

// The MCP config routes are src/daemon.ts's /api/mcp/parse, NAME/test, import, registry and registry/probe, for the
// Settings section's MCP servers: a pasted config read into stam's form (S-51), a configured server's tools, the
// servers the harnesses already have (S-52), and the public MCP registry (S-53). None of them writes.
func (s *Server) mcpConfigRoutes() {
	s.handle("POST /api/mcp/parse", s.mcpParse)
	s.handle("POST /api/mcp/{name}/test", mcpPath(s.mcpTest))
	s.handle("GET /api/mcp/import", s.mcpImport)
	s.handle("GET /api/mcp/registry", s.mcpBrowse)
	s.handle("POST /api/mcp/registry/probe", s.mcpProbe)
}

// raw is v as the JSON.stringify text the route answers.
func raw(v jsjson.Value) json.RawMessage { return json.RawMessage(jsjson.Stringify(v, "")) }

// mcpParse is POST /api/mcp/parse: the pasted text any harness's MCP config is read into {servers, notes}. It only reads
// the text it is handed, so anyone may ask; a text with no config is a 400 saying why.
func (s *Server) mcpParse(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	text := ""
	if v := getValue(w.body, "text"); v != nil {
		text = jsjson.ToString(v)
	}
	parsed, err := mcpservers.ParseConfig(text)
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	return raw(parsed), nil
}

// mcpServer is settings.mcpServers[name], nil when there is none.
func (s *Server) mcpServer(name string) jsjson.Value {
	switch x := s.settings.Get().McpServers.(type) {
	case *jsjson.Object:
		v, _ := x.Get(name)
		return v
	case []jsjson.Value:
		for i, v := range x {
			if jsjson.Number(float64(i)) == name {
				return v
			}
		}
	}
	return nil
}

// mcpTest is POST /api/mcp/NAME/test: the human connects to one configured server and gets its tools, or the error.
func (s *Server) mcpTest(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "test an MCP server"); err != nil {
		return nil, err
	}
	name := r.PathValue("name")
	server := s.mcpServer(name)
	if !jsjson.Truthy(server) {
		return nil, Errorf(http.StatusNotFound, "no MCP server %s", name)
	}
	token := func(ctx context.Context, name string) (string, error) { return s.mcp.Token(ctx, name, false) }
	return raw(mcpservers.Check(r.Context(), name, server, token, nil)), nil
}

// mcpImport is GET /api/mcp/import: the servers the harnesses on this machine already have, for the human to import.
// HARNESS_HOME points the scan at a test's fixture files; otherwise it reads the user's home.
func (s *Server) mcpImport(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "import MCP servers"); err != nil {
		return nil, err
	}
	agents, err := s.db.ListAgents(r.Context())
	if err != nil {
		return nil, err
	}
	var cwds []string
	seen := map[string]bool{}
	for _, a := range agents {
		if a.Cwd != "" && !seen[a.Cwd] {
			seen[a.Cwd] = true
			cwds = append(cwds, a.Cwd)
		}
	}
	home := getenvStam("HARNESS_HOME")
	if home == "" {
		if home, err = os.UserHomeDir(); err != nil {
			return nil, err
		}
	}
	existing := s.settings.Get().McpServers
	if existing == nil {
		existing = jsjson.NewObject()
	}
	return raw(jsjson.NewObject("servers", mcpservers.ScanHarnesses(r.Context(), home, cwds, existing))), nil
}

// mcpBrowse is GET /api/mcp/registry?search=&cursor=: a page of the public MCP registry for the human, cached.
func (s *Server) mcpBrowse(r *http.Request, _ auth.Resolved) (any, error) {
	if err := s.humanOnly(r, "browse the MCP registry"); err != nil {
		return nil, err
	}
	q := r.URL.Query()
	page, err := s.mcpRegistry.Browse(r.Context(), q.Get("search"), q.Get("cursor"))
	if err != nil {
		return nil, err
	}
	return raw(page), nil
}

var httpURL = regexp.MustCompile(`^https?://`)

// mcpProbe is POST /api/mcp/registry/probe {url}: the login a remote server likely needs, checked when the human adds
// it and not before.
func (s *Server) mcpProbe(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "check an MCP server"); err != nil {
		return nil, err
	}
	u := ""
	if v := getValue(w.body, "url"); v != nil {
		u = jsjson.ToString(v)
	}
	if !httpURL.MatchString(u) {
		return nil, Errorf(http.StatusBadRequest, "a http or https url is required")
	}
	var found jsjson.Value
	if a := s.mcpRegistry.RemoteAuth(r.Context(), u); a != "" {
		found = a
	}
	return raw(jsjson.NewObject("auth", found)), nil
}
