package server

import (
	"context"
	"errors"
	"net/http"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
)

// The routes an OpenCode agent's plugin calls for the session it runs (src/daemon.ts GET /api/by-session/:sid/notice,
// /system and /compact-instructions, S-4237; the plugin is src/adapters/opencode-plugin/index.ts). It knows a session id,
// not the agent.

func (s *Server) pluginRoutes() {
	s.handle("GET /api/by-session/{sid}/notice", s.sessionNotice)
	s.handle("GET /api/by-session/{sid}/system", s.sessionSystem)
	s.handle("GET /api/by-session/{sid}/compact-instructions", s.sessionCompactInstructions)
}

// sessionText is what each of the three routes answers: the agent's text for the session, none (TS's `undefined`, so
// no key) when there is nothing to hand over.
type sessionText struct {
	Text string `json:"text,omitempty"`
}

// errSessionDenied is the one refusal a restricted caller gets for a session it may not act for and for one that does
// not exist, with the same text and status: neither the route's answer nor its message says which it was, and the message
// names no agent, so a caller learns nothing about an agent's mail, prompt or instructions, nor whether one has the
// session. (TS answers an unknown session with an empty 200 and another agent's with 403 and the agent's name.)
var errSessionDenied = Errorf(http.StatusForbidden, "that session isn't yours to read")

// sessionAgent is the agent whose harness session is the one in the path, when the caller may act as it. ok is false for
// a session no agent has when the caller is not restricted (the shared token, the human, a peer: TS's empty answer); a
// restricted caller (an agent's token, the OpenCode server's) is refused with errSessionDenied for an unknown session as
// for one it may not act as. The check is mayActAs, so the seam for a peer's own token (senderPeer, S-4127) is the same
// as every other route's.
func (s *Server) sessionAgent(r *http.Request, c auth.Resolved) (a db.Agent, ok bool, err error) {
	sid := r.PathValue("sid")
	if !agentRef.MatchString(sid) {
		return db.Agent{}, false, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	ctx := r.Context()
	restricted := c.Caller.Kind == auth.Agent || c.Caller.Kind == auth.OpenCode
	a, err = s.db.AgentBySession(ctx, sid)
	if errors.Is(err, db.ErrNotFound) {
		if restricted {
			return db.Agent{}, false, errSessionDenied
		}
		return db.Agent{}, false, nil
	}
	if err != nil {
		return db.Agent{}, false, err
	}
	if err := s.mayActAs(ctx, c.Caller, a.ID, true); err != nil {
		var e *Error
		if errors.As(err, &e) && e.Status == http.StatusForbidden {
			return db.Agent{}, false, errSessionDenied
		}
		return db.Agent{}, false, err
	}
	return a, true, nil
}

// sessionNotice is GET /api/by-session/:sid/notice (src/daemon.ts): the agent's in-turn notice, from the queue the Claude
// hook takes from, bound to the session in the path (lifecycle.SessionNotice). No agent, or one that no longer runs the
// session, is the empty text.
func (s *Server) sessionNotice(r *http.Request, c auth.Resolved) (any, error) {
	a, ok, err := s.sessionAgent(r, c)
	if err != nil || !ok {
		return sessionEmpty(err)
	}
	if s.life == nil {
		return nil, unported("notices aren't available on this daemon")
	}
	return sessionText{Text: s.life.SessionNotice(r.Context(), a.ID, r.PathValue("sid"))}, nil
}

// sessionSystem is GET /api/by-session/:sid/system: the agent's system prompt, rendered as a Claude agent's is, with the
// agent's harness and cwd.
func (s *Server) sessionSystem(r *http.Request, c auth.Resolved) (any, error) {
	a, ok, err := s.sessionAgent(r, c)
	if err != nil || !ok {
		return sessionEmpty(err)
	}
	return s.systemPromptOf(r.Context(), a)
}

func (s *Server) systemPromptOf(ctx context.Context, a db.Agent) (any, error) {
	p, err := s.promptSet()
	if err != nil {
		return nil, err
	}
	parts, err := s.promptParts(ctx, a, true)
	if err != nil {
		return nil, err
	}
	text, err := claude.SystemPrompt(ctx, p.Templates, a.Harness, a, parts)
	if err != nil {
		return nil, err
	}
	return sessionText{Text: text}, nil
}

// sessionCompactInstructions is GET /api/by-session/:sid/compact-instructions: the instructions the agent gave
// compact_self for the compaction the server is running, taken once through the agent's owner, for the session it runs.
func (s *Server) sessionCompactInstructions(r *http.Request, c auth.Resolved) (any, error) {
	a, ok, err := s.sessionAgent(r, c)
	if err != nil || !ok {
		return sessionEmpty(err)
	}
	if s.life == nil {
		return nil, unported("compaction isn't available on this daemon")
	}
	return sessionText{Text: s.life.SessionCompactInstructions(r.Context(), a.ID, r.PathValue("sid"))}, nil
}

// sessionEmpty is the answer for an unknown session to a caller that isn't restricted: TS's `{ text: undefined }`.
func sessionEmpty(err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return struct{}{}, nil
}
