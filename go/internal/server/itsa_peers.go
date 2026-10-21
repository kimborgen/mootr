package server

import (
	"context"
	"errors"
	"net/http"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// The peer hooks of src/daemon.ts: what a peer's daemon calls on the ITSA home (join-parent, join, leave, may-participate,
// owner-stopped, unown-agent, incident-marked). Only a peer reaches them (x-stam-local), and this daemon has no peers:
//
//   - a caller that is not a peer is refused 403 'only a peer can call this', as TS does before it proxies or reads anything;
//   - incident-marked is a read of this daemon's ITSAs and is answered;
//   - owner-stopped and unown-agent report an agent a peer holds: when the agent is one of this machine's, TS answers 403
//     (only a peer can hold it) and so does this; when it is another machine's, TS asks its peers, which this daemon cannot,
//     so it answers 501;
//   - join-parent, join, leave and may-participate act for a peer's spawn and answer 501 after the checks TS makes on the body.
func (s *Server) peerHookRoutes() {
	for _, p := range []string{
		"POST /api/itsas/join-parent", "POST /api/itsas/join", "POST /api/itsas/leave", "POST /api/itsas/may-participate",
		"POST /api/itsas/owner-stopped", "POST /api/itsas/unown-agent", "GET /api/itsas/incident-marked",
	} {
		s.handle(p, s.peerHook(p))
	}
}

// peerNeeds is what TS says a body lacks, by route.
var peerNeeds = map[string]struct {
	keys []string
	msg  string
}{
	"POST /api/itsas/join-parent":     {[]string{"agent", "parent"}, "join-parent needs agent and parent"},
	"POST /api/itsas/join":            {[]string{"itsa", "agent"}, "join needs itsa and agent"},
	"POST /api/itsas/leave":           {[]string{"itsa", "agent"}, "leave needs itsa and agent"},
	"POST /api/itsas/may-participate": {[]string{"itsa"}, "may-participate needs itsa"},
}

func (s *Server) peerHook(route string) func(*http.Request, auth.Resolved) (any, error) {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !c.Local {
			return nil, Errorf(http.StatusForbidden, "only a peer can call this")
		}
		ctx := context.WithoutCancel(r.Context())
		if route == "GET /api/itsas/incident-marked" {
			out := jsfmt.Value{Kind: jsfmt.Object}
			out.Set("marked", jsfmt.Value{Kind: jsfmt.Bool, Bool: s.incidentMarkedHere(ctx, r.URL.Query().Get("itsa"))})
			return out, nil
		}
		body, err := jsonBody(r)
		if err != nil {
			return nil, err
		}
		if need, ok := peerNeeds[route]; ok {
			for _, k := range need.keys {
				if truthyString(body, k) == "" {
					return nil, Errorf(http.StatusBadRequest, "%s", need.msg)
				}
			}
			return nil, Errorf(http.StatusNotImplemented, "%s is not ported to the Go daemon yet", route[len("POST "):])
		}
		// owner-stopped and unown-agent: a peer reports an agent it holds. An agent of this machine is no peer's.
		id := strOrUndefined(body, "id")
		a, err := s.db.GetAgent(ctx, id)
		switch {
		case err == nil && (a.Machine == "" || a.Machine == s.cfg.Machine):
			what := "that agent can report its stop"
			if route == "POST /api/itsas/unown-agent" {
				what = "that archived agent can unown its ITSAs"
			}
			return nil, Errorf(http.StatusForbidden, "only a peer holding %s", what)
		case err != nil && !errors.Is(err, db.ErrNotFound):
			return nil, Errorf(http.StatusServiceUnavailable, "no peer answered about %s; try again", id)
		}
		return nil, Errorf(http.StatusNotImplemented, "%s needs the peers, which the Go daemon does not have yet", route[len("POST "):])
	}
}

// incidentMarkedHere is itsa-owners.ts incidentMarkedHere: whether the ITSA, or an ancestor of it, carries the incident
// mark. An ITSA this daemon cannot read, a missing parent and a chain that loops are no mark.
func (s *Server) incidentMarkedHere(ctx context.Context, ref string) bool {
	if ref == "" {
		return false
	}
	x, ok, err := s.db.FindItsa(ctx, ref)
	if err != nil || !ok {
		return false
	}
	seen := map[string]bool{x.Text("id"): true}
	marked := incidentOf(x)
	for cur := x; truthyString(cur, "parent_id") != ""; {
		p, ok, err := s.db.FindItsa(ctx, cur.Text("parent_id"))
		if err != nil || !ok || seen[p.Text("id")] {
			return false
		}
		seen[p.Text("id")] = true
		marked = marked || incidentOf(p)
		cur = p
	}
	return marked
}

func incidentOf(x jsfmt.Value) bool {
	v, ok := x.Get("incident")
	return ok && v.Kind == jsfmt.Number && v.Num == "1"
}

// truthyString is a body member that is a non-empty string, else "" (String(body?.k ?? ”) for what a peer sends).
func truthyString(v jsfmt.Value, key string) string {
	m, ok := v.Get(key)
	if !ok || m.Kind == jsfmt.Null {
		return ""
	}
	if m.Kind == jsfmt.String {
		return m.Str
	}
	return jsfmtString(m)
}

// strOrUndefined is String(body?.key): a missing member is "undefined".
func strOrUndefined(v jsfmt.Value, key string) string {
	m, ok := v.Get(key)
	if !ok {
		return "undefined"
	}
	if m.Kind == jsfmt.Null {
		return "null"
	}
	return jsfmtString(m)
}

func jsfmtString(m jsfmt.Value) string {
	if m.Kind == jsfmt.String {
		return m.Str
	}
	return jsfmt.Compact(m)
}
