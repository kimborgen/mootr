package server

import (
	"context"
	"math"
	"net/http"
	"time"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/requirements"
	"stam/internal/steps"
)

// requirementCheckRoutes registers the check engine's routes (src/daemon.ts, "Requirement checks for subjects on a
// non-home daemon" and POST /api/requirements/check). The four peer routes answer only a peer; the literal paths are
// registered beside `{id}`, which the mux ranks below them.
func (s *Server) requirementCheckRoutes() {
	s.handle("POST /api/requirements/check", s.manualCheck)
	s.handle("POST /api/requirements/check-subject", s.peerOnly("only a peer can forward a subject", s.checkSubject))
	s.handle("POST /api/requirements/check-tool", s.peerOnly("only a peer can ask for a tool check", s.toolFromPeer))
	s.handle("GET /api/requirements/enforced-tools", s.peerOnly("only a peer can read the enforced-tools index", s.enforcedTools))
	s.handle("POST /api/requirements/enforced-tools/changed", s.peerOnly("only a peer can say the index changed", s.indexChanged))
}

func (s *Server) peerOnly(msg string, h handler) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !c.Local {
			return nil, Errorf(http.StatusForbidden, "%s", msg)
		}
		return h(r, c)
	}
}

// manualCheck is POST /api/requirements/check: a check on demand of `text`, or of a mail or an ITSA (a branch is PR 6).
func (s *Server) manualCheck(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	in := requirements.ManualInput{}
	if w.body != nil {
		in.Subject, _ = w.body.Get("subject")
		in.Text, _ = w.body.Get("text")
		in.Keys, _ = w.body.Get("keys")
	}
	ref, results, err := s.requirements.Manual(context.WithoutCancel(r.Context()), in, s.resolveSubject)
	if err != nil {
		return nil, reqErr(err)
	}
	list := jsfmt.Value{Kind: jsfmt.Array}
	for _, res := range results {
		list.Items = append(list.Items, res.Value())
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("subject", jsfmt.StringValue(ref))
	out.Set("results", list)
	return out, nil
}

func peerActor(v jsfmt.Value) (steps.Actor, bool) {
	a, ok := v.Get("actor")
	if !ok || a.Kind != jsfmt.Object {
		return steps.Actor{}, false
	}
	name, ok := a.Get("name")
	if !ok || name.Kind != jsfmt.String {
		return steps.Actor{}, false
	}
	out := steps.Actor{Name: name.Str}
	for key, dst := range map[string]**string{"role": &out.Role, "parent": &out.Parent} {
		if p, ok := a.Get(key); ok && p.Kind == jsfmt.String {
			v := p.Str
			*dst = &v
		}
	}
	return out, true
}

// toolFromPeer is src/req-check.ts toolFromPeer: the home's answer for a tool call from a peer, in at most 7 s.
func (s *Server) toolFromPeer(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	agent, okAgent := body.Get("agent")
	tool, okTool := body.Get("tool")
	if !okAgent || agent.Kind != jsfmt.String || !okTool || tool.Kind != jsfmt.String || !s.isHome() {
		return requirements.ToolVerdict{Allow: true}.Value(), nil
	}
	budget := 0.0
	if v, has := body.Get("budgetMs"); has {
		if f, ok := jsNumber(v); ok {
			budget = f
		}
	}
	budget = math.Min(budget, 7000)
	args := jsfmt.Value{Kind: jsfmt.Object}
	if a, ok := body.Get("args"); ok && (a.Kind == jsfmt.Object || a.Kind == jsfmt.Array) {
		args = a
	}
	ctx := r.Context()
	actor, ok := peerActor(body)
	if !ok {
		actor = s.steps.ActorOf(ctx, agent.Str)
	}
	return s.requirements.CheckTool(ctx, agent.Str, tool.Str, toJSJSON(args), time.Duration(budget*float64(time.Millisecond)), actor).Value(), nil
}

// enforcedTools is GET /api/requirements/enforced-tools: the index, sorted.
func (s *Server) enforcedTools(r *http.Request, _ auth.Resolved) (any, error) {
	tools, err := s.requirements.EnforcedTools(r.Context())
	if err != nil {
		return nil, reqErr(err)
	}
	list := jsfmt.Value{Kind: jsfmt.Array}
	for _, t := range requirements.ToolsSorted(tools) {
		list.Items = append(list.Items, jsfmt.StringValue(t))
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("tools", list)
	return out, nil
}

// indexChanged is the home's push that its index changed: this daemon fetches it again, off the request.
func (s *Server) indexChanged(r *http.Request, _ auth.Resolved) (any, error) {
	go s.fetchIndex(context.WithoutCancel(r.Context()))
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("scheduled", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	return out, nil
}

// StartRequirements starts the requirement checks' background work (src/req-check.ts watch): the home pushes its enforced-tools
// index to its peers when it changes, and a daemon that is not the home fetches the index at boot and then every minute
// (STAM_REQ_INDEX_MS), so a tool a requirement newly names is checked from its first call. It ends with ctx.
func (s *Server) StartRequirements(ctx context.Context) {
	s.requirements.OnIndexChange(s.pushIndexChange)
	s.goBg(func() {
		// Built now, off the request, so the first tool call finds the index warm.
		if s.isHome() && s.requirements.Enabled() {
			if _, err := s.requirements.EnforcedTools(ctx); err != nil {
				s.reqError(ctx, "", "index: "+err.Error())
			}
		}
		s.fetchIndex(ctx)
		t := time.NewTicker(indexPoll())
		defer t.Stop()
		// A synced setting that turns requirements on brings the first fetch (src/req-check.ts onSettingsChange).
		turn := time.NewTicker(time.Second)
		defer turn.Stop()
		was := s.requirements.Enabled()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.fetchIndex(ctx)
			case <-turn.C:
				on := s.requirements.Enabled()
				if on && !was {
					s.remoteIdx.mu.Lock()
					have := s.remoteIdx.have
					s.remoteIdx.mu.Unlock()
					if !have {
						s.fetchIndex(ctx)
					}
				}
				was = on
			}
		}
	})
}

func (s *Server) reqError(ctx context.Context, subject, msg string) {
	data := jsfmt.Value{Kind: jsfmt.Object}
	if subject != "" {
		data.Set("subject", jsfmt.StringValue(subject))
	}
	data.Set("error", jsfmt.StringValue(msg))
	_ = s.db.AddEvent(context.WithoutCancel(ctx), "stam", "req:error", data)
}

// pushIndexChange tells every peer to fetch the index again (3 s each, fire and forget).
func (s *Server) pushIndexChange() {
	if !s.isHome() || !s.requirements.Enabled() {
		return
	}
	for _, p := range s.peers.Peers() {
		s.peers.Notify(p, "POST", "/api/requirements/enforced-tools/changed", jsfmt.Value{Kind: jsfmt.Object}, 3*time.Second)
	}
}
