package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	neturl "net/url"
	"regexp"
	"strings"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// What src/daemon.ts handler does to a write before its route (S-2820): it reads the JSON body, refuses an agent's
// body that isn't an object, resolves the identity fields (resolveActors), and tells whether the request is the
// human's.

// humanName is mail.HUMAN, the human's address.
const humanName = "human"

// maxBody bounds a request body: no route takes more.
const maxBody = 64 << 20

// write is a write request after those checks.
type write struct {
	body  *jsjson.Object
	human bool
	local bool
}

// readWrite reads and checks the body of a POST, PUT, PATCH or DELETE.
func (s *Server) readWrite(r *http.Request, c auth.Resolved) (write, error) {
	raw, err := readBody(r)
	if err != nil {
		return write{}, err
	}
	return s.parseWrite(r, c, raw, true)
}

// readBody reads a request's body, bounded.
func readBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBody))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return nil, Errorf(http.StatusRequestEntityTooLarge, "the request body is too large")
	}
	return raw, err
}

// parseWrite checks a body read by readBody. resolve is false for a peer's own call, whose identity is trusted as it is
// (src/daemon.ts: `if (!local || caller.kind === 'agent') resolveActors`).
func (s *Server) parseWrite(r *http.Request, c auth.Resolved, raw []byte, resolve bool) (write, error) {
	var body jsjson.Value = jsjson.NewObject()
	if len(raw) > 0 {
		// A fixed message: a parse error may quote the input, which may hold a secret (S-2114).
		var err error
		if body, err = jsjson.Parse(raw); err != nil {
			return write{}, Errorf(http.StatusBadRequest, "the request body is not valid JSON")
		}
	}
	obj, isObj := body.(*jsjson.Object)
	// A write from an agent or the OpenCode server is a JSON object: any other JSON has no identity to check.
	if c.IsAgent() && !isObj {
		return write{}, Errorf(http.StatusBadRequest, "the request body must be a JSON object")
	}
	if isObj && resolve {
		if err := s.resolveActors(r, c, obj); err != nil {
			return write{}, err
		}
	}
	return write{body: obj, human: s.isHuman(r, c), local: c.Local}, nil
}

// opencodeNamed is the routes ported here whose path names the agent for the OpenCode server (src/agent-routes.ts
// opencodeNamesAgent), plus its hook and status-line reports: none of the ported agent routes is an `acting` write.
var opencodeNamed = regexp.MustCompile(`^/api/(hook|statusline)/`)

// bodyNamesAgent is the writes that name their agent in the body as `agent`, checked in their routes.
var bodyNamesAgent = regexp.MustCompile(`^POST /api/(steps/check|permissions)$`)

// resolveActors is src/daemon.ts resolveActors for a body: `by`, `from` and `self` become the identity the caller may
// act as, and an agent's own token names itself in all three. The OpenCode server must name its agent.
func (s *Server) resolveActors(r *http.Request, c auth.Resolved, body *jsjson.Object) error {
	keys := []string{"by", "from", "self"}
	// A route that names its agent in the path, the hook and status-line reports, and a tool check or permission request
	// (which name theirs as `agent`) need no identity in the body.
	if c.Kind == auth.OpenCode && !opencodeNamed.MatchString(r.URL.Path) && !opencodeNamesAgent(r.Method, r.URL.Path) && !bodyNamesAgent.MatchString(r.Method+" "+r.URL.Path) {
		named := false
		for _, k := range keys {
			if _, ok := body.Get(k); ok {
				named = true
			}
		}
		if !named {
			return Errorf(http.StatusForbidden, "the OpenCode server's request must name its agent (by, from, or self)")
		}
	}
	for _, k := range keys {
		v, ok := body.Get(k)
		if !ok && c.Kind != auth.Agent {
			continue
		}
		claim := ""
		if v != nil {
			claim = claude.JSString(v)
		}
		id, err := s.actor(r.Context(), c.Caller, claim)
		if err != nil {
			return err
		}
		if id != "" {
			body.Set(k, id)
		}
	}
	if c.Kind == auth.OpenCode {
		var named jsjson.Value
		for _, k := range keys {
			if v, ok := body.Get(k); ok && v != nil {
				named = v
				break
			}
		}
		if named != nil {
			for _, k := range keys {
				if v, _ := body.Get(k); v == nil {
					body.Set(k, named)
				}
			}
		}
	}
	return nil
}

// mustAgent is src/daemon.ts mustAgent: the agent by id or name, else a 404.
func (s *Server) mustAgent(ctx context.Context, ref string) (db.Agent, error) {
	a, err := s.db.GetAgent(ctx, ref)
	if errors.Is(err, db.ErrNotFound) {
		return db.Agent{}, Errorf(http.StatusNotFound, "no agent %s", ref)
	}
	return a, err
}

// resolveQuery is the end of src/daemon.ts resolveActors: the `as` query names the viewer, and becomes the identity the
// caller may act as (an agent's own token is itself, the OpenCode server must name an OpenCode agent). The other pairs are
// written back as URLSearchParams.set does, in their order, with the first `as` replaced and any other dropped. The `by`
// query is a grouping on some routes, so each route that reads it as an actor checks it.
func (s *Server) resolveQuery(r *http.Request, c auth.Resolved) error {
	if c.Local && c.Kind != auth.Agent {
		return nil
	}
	if r.URL.RawQuery == "" {
		return nil
	}
	type pair struct{ k, v string }
	var pairs []pair
	as, has := "", false
	for _, part := range strings.Split(r.URL.RawQuery, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		k, err1 := neturl.QueryUnescape(k)
		v, err2 := neturl.QueryUnescape(v)
		if err1 != nil || err2 != nil {
			// URLSearchParams keeps what it cannot decode as it is.
			k, v, _ = strings.Cut(part, "=")
		}
		if k == "as" {
			if !has {
				as, has = v, true
				pairs = append(pairs, pair{k, ""})
			}
			continue
		}
		pairs = append(pairs, pair{k, v})
	}
	if !has {
		return nil
	}
	id, err := s.actor(r.Context(), c.Caller, as)
	if err != nil {
		return err
	}
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		v := p.v
		if p.k == "as" {
			v = id
		}
		b.WriteString(neturl.QueryEscape(p.k) + "=" + neturl.QueryEscape(v))
	}
	r.URL.RawQuery = b.String()
	return nil
}
