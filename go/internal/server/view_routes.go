package server

import (
	"context"
	"net/http"

	"stam/internal/agentview"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
)

// stam's own view of an agent: its conversation, live (src/agent-view.ts, internal/agentview). Reading it is open to
// any token, as in TS; sending is the human's, from the web UI, proven as trustedHuman proves it: an agent's token and an
// x-stam-human header prove nothing. Another machine's agent is relayed before these routes (relay.go), its sends
// refused there. Only Claude Code's view is ported; Codex and OpenCode answer 409.
func (s *Server) viewRoutes() {
	s.views = &agentview.Service{DB: s.db}
	// The lifecycle is read when used: a daemon with none types into no agent and interrupts none.
	s.views.Register("claude", &agentview.Claude{DB: s.db,
		Type: func(ctx context.Context, a db.Agent, text string) bool {
			return s.life != nil && s.life.TypeHumanInput(ctx, a, text)
		},
		Interrupt: func(ctx context.Context, a db.Agent) (bool, error) {
			if s.life == nil {
				return false, nil
			}
			return s.life.Interrupt(ctx, a)
		},
		Restore: lifecycle.RestoreTranscript})
	// OpenCode's: the shared server's calls and the lifecycle's binding are read when used, as the lifecycle may be set
	// after the server is made; the lifecycle tells it of each event (SetOpenCodeViewer, in viewEvents).
	s.ocView = &agentview.OpenCode{DB: s.db,
		Has: func() bool { return s.life != nil && s.life.HasOpenCode() },
		Call: func(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
			if s.life == nil {
				return nil, Errorf(http.StatusConflict, "OpenCode isn't running on this daemon")
			}
			return s.life.OpenCodeCall(ctx, method, path, body)
		},
		Interrupt: func(ctx context.Context, a db.Agent) (bool, error) {
			if s.life == nil {
				return false, nil
			}
			return s.life.Interrupt(ctx, a)
		},
		Send: func(ctx context.Context, id, pid string, do func(sid string) error) (bool, error) {
			if s.life == nil {
				return false, nil
			}
			return s.life.ViewSend(ctx, id, pid, do)
		}}
	s.views.Register("opencode", s.ocView)
	s.patterns = append(s.patterns, "GET /api/agents/{id}/view")
	s.mux.Handle("GET /api/agents/{id}/view", s.stream(s.viewStream))
	s.handle("GET /api/agents/{id}/view/history", agentPath(s.viewHistory))
	s.handle("GET /api/agents/{id}/view/tools", agentPath(s.viewTools))
	s.handle("POST /api/agents/{id}/view/prompt", agentPath(s.viewPrompt))
	s.handle("POST /api/agents/{id}/view/interrupt", agentPath(s.viewInterrupt))
	s.handle("POST /api/agents/{id}/view/permission", agentPath(s.viewPermission))
}

// StartViews ends the view streams when ctx ends: shutdown waits for every handler, and a stream's runs until its
// client goes. The follows stop with their last stream.
func (s *Server) StartViews(ctx context.Context) {
	s.views.Done = ctx.Done()
}

// viewErr is src/daemon.ts viewCall: a view's refusal as the route's status.
func viewErr(err error) error {
	if e, ok := agentview.AsError(err); ok {
		return Errorf(e.Status, "%s", e.Message)
	}
	return err
}

func (s *Server) viewStream(w http.ResponseWriter, r *http.Request, _ auth.Resolved) error {
	if !agentRef.MatchString(r.PathValue("id")) {
		return Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	return viewErr(s.views.Stream(w, r, a))
}

func (s *Server) viewHistory(r *http.Request, _ auth.Resolved) (any, error) {
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	limit := 50.0
	if q.Has("limit") {
		limit = jsjson.ToNumber(q.Get("limit"))
	}
	p, err := s.views.History(r.Context(), a, q.Get("before"), limit)
	return p, viewErr(err)
}

// viewTools is the tool calls an agent made before a mail it sent, for the ITSA thread (S-1643).
func (s *Server) viewTools(r *http.Request, _ auth.Resolved) (any, error) {
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	t, err := s.views.MailTools(r.Context(), a, r.URL.Query().Get("mail"))
	return t, viewErr(err)
}

// viewSend is a send's body, after the human's proof and the agent's lookup, in TS's order.
func (s *Server) viewSend(r *http.Request, c auth.Resolved, what string) (db.Agent, *jsjson.Object, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return db.Agent{}, nil, err
	}
	// The human's proof, and never with an agent's token: TS's humanOnly takes the test human's header from any token,
	// Go's Owned doesn't (a test daemon only; fail-closed).
	if !c.Owned {
		return db.Agent{}, nil, Errorf(http.StatusForbidden, "only the human can %s, %s", what, s.humanWays("stam"))
	}
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	return a, w.body, err
}

func (s *Server) viewPrompt(r *http.Request, c auth.Resolved) (any, error) {
	a, body, err := s.viewSend(r, c, "send to an agent's view")
	if err != nil {
		return nil, err
	}
	text := ""
	if v := get(body, "text"); v != nil {
		text = jsjson.ToString(v)
	}
	if err := s.views.Prompt(r.Context(), a, text, get(body, "delivery")); err != nil {
		return nil, viewErr(err)
	}
	return struct {
		Sent bool `json:"sent"`
	}{true}, nil
}

func (s *Server) viewInterrupt(r *http.Request, c auth.Resolved) (any, error) {
	a, _, err := s.viewSend(r, c, "interrupt an agent from its view")
	if err != nil {
		return nil, err
	}
	stopped, err := s.views.Interrupt(r.Context(), a)
	if err != nil {
		return nil, viewErr(err)
	}
	return struct {
		Stopped bool `json:"stopped"`
	}{stopped}, nil
}

func (s *Server) viewPermission(r *http.Request, c auth.Resolved) (any, error) {
	a, body, err := s.viewSend(r, c, "answer permissions from the view")
	if err != nil {
		return nil, err
	}
	if err := s.views.AnswerPermission(r.Context(), a, get(body, "request"), get(body, "decision")); err != nil {
		return nil, viewErr(err)
	}
	return struct {
		Answered bool `json:"answered"`
	}{true}, nil
}

// viewEvent is told of each event of the OpenCode server's stream, after the lifecycle handled it: the open views' feed.
func (s *Server) viewEvent(typ string, d *jsjson.Object) {
	if v := s.ocView; v != nil {
		v.Event(typ, d)
	}
}
