package server

import (
	"context"
	"errors"
	"net/http"

	"stam/internal/auth"
	"stam/internal/db"
)

const humanBox = "human"

// chiefOfStaffID is the chief of staff's id: the agent named in settings while it is active or paused (src/org.ts).
func (s *Server) chiefOfStaffID(ctx context.Context) string {
	name := s.settings.Get().ChiefOfStaff
	if name == "" {
		return ""
	}
	a, err := s.db.GetAgent(ctx, name)
	if err != nil || (a.Lifecycle != "active" && a.Lifecycle != "paused") {
		return ""
	}
	return a.ID
}

// isAssistant is whether the id, by id only, is the assistant's (src/mail-visibility.ts isAssistant).
func (s *Server) isAssistant(ctx context.Context, id string) bool {
	a, err := s.db.GetAgent(ctx, id)
	return err == nil && a.ID == id && a.Kind != nil && *a.Kind == "assistant"
}

// ancestors is every agent above a, by parent_id and the adopting parents (src/org.ts ancestors).
func (s *Server) ancestors(ctx context.Context, a db.Agent, extra map[string][]string) (map[string]bool, error) {
	out := map[string]bool{}
	var walk func(a db.Agent)
	walk = func(a db.Agent) {
		parents := append([]string(nil), extra[a.ID]...)
		if a.ParentID != nil {
			parents = append([]string{*a.ParentID}, parents...)
		}
		for _, p := range parents {
			if out[p] {
				continue
			}
			out[p] = true
			if pa, err := s.db.GetAgent(ctx, p); err == nil {
				walk(pa)
			}
		}
	}
	walk(a)
	return out, nil
}

// agentLabel is the name an error shows for an agent id.
func (s *Server) agentLabel(ctx context.Context, id string) string {
	if a, err := s.db.GetAgent(ctx, id); err == nil {
		return a.Name
	}
	return id
}

// mayActAs is src/daemon.ts mayActAs: whether the caller may act as the agent id. Only an agent's own token and the
// OpenCode server's are restricted; the human, the shared token and peers pass. selfOnly allows only the agent itself.
func (s *Server) mayActAs(ctx context.Context, c auth.Caller, id string, selfOnly bool) error {
	if c.Kind == auth.OpenCode {
		if a, err := s.db.GetAgent(ctx, id); err == nil && a.Harness == "opencode" {
			return nil
		}
		return Errorf(http.StatusForbidden, "the OpenCode server can't act as %s", id)
	}
	if c.Kind != auth.Agent {
		return nil
	}
	me := c.Agent
	target, err := s.db.GetAgent(ctx, id)
	found := err == nil
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		return err
	}
	if (found && target.ID == me) || (!found && id == me) {
		return nil
	}
	if selfOnly {
		return Errorf(http.StatusForbidden, "agent %s can't act as %s", s.agentLabel(ctx, me), id)
	}
	if !found && id != humanBox {
		return nil
	}
	if found {
		extra, err := s.db.ExtraParents(ctx)
		if err != nil {
			return err
		}
		anc, _ := s.ancestors(ctx, target, extra)
		if anc[me] {
			return nil
		}
	}
	if c.Boss || s.chiefOfStaffID(ctx) == me || s.isAssistant(ctx, me) {
		return nil
	}
	return Errorf(http.StatusForbidden, "agent %s can't act as %s", s.agentLabel(ctx, me), id)
}
