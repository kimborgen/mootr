package server

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The sender withdraws its own ask from the human (src/withdraw.ts withdrawAsk, S-425; S-3734), and a peer withdraws mail
// it doesn't hold (POST /api/mail/withdraw).

// withdrawAskRoute is POST /api/mail/:id/withdraw-ask. An agent's own token acts as that agent; the OpenCode server's as
// the agent in body.by. A peer's forwarded call names its agent and its boss flag (S-239).
func (s *Server) withdrawAskRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	if !c.Caller.IsAgent() {
		return nil, Errorf(http.StatusForbidden, "only an agent withdraws its ask")
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	by := c.Caller.Agent
	if c.Caller.Kind != auth.Agent {
		by = orString(body, "by", "")
	}
	if by == "" {
		return nil, Errorf(http.StatusForbidden, "an ask is withdrawn for a named agent")
	}
	boss := c.Caller.Boss || s.chiefOfStaffID(ctx) == by || s.isAssistant(ctx, by)
	byName := ""
	if c.Local {
		byName = orString(body, "by_name", "")
	}
	ws, err := s.withdrawAsk(ctx, r.PathValue("id"), by, orString(body, "note", ""), boss, c.Local, byName)
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("withdrawn", ws)
	return out, nil
}

// withdrawAsk is src/withdraw.ts withdrawAsk: a decision mail stops waiting, leaving the decision list, and the human's
// copy is withdrawn as any settlement. A permission request and an ITSA ask settle their own way, and a decision the human
// deferred stays with them. Only the sender, its parent, the chief of staff or the assistant (boss) may withdraw. A mail
// this daemon doesn't hold goes to the peer that does, as the same caller, unless the call came from a peer.
func (s *Server) withdrawAsk(ctx context.Context, id, by, reason string, boss, fromPeer bool, byName string) (jsfmt.Value, error) {
	m, ok, err := s.db.GetMail(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !ok {
		if fromPeer {
			return jsfmt.Value{}, Errorf(http.StatusNotFound, "no mail %s", id)
		}
		return s.forwardWithdrawAsk(ctx, id, by, reason, boss, s.agentOrPeerName(ctx, by, by))
	}
	from := m.Text("from_id")
	allowed := boss || from == by
	if !allowed {
		if sender, err := s.db.GetAgent(ctx, from); err == nil {
			parents, err := s.db.ParentsOf(ctx, sender)
			if err != nil {
				return jsfmt.Value{}, err
			}
			allowed = contains(parents, by)
		} else if !errors.Is(err, db.ErrNotFound) {
			return jsfmt.Value{}, err
		}
	}
	if !allowed {
		return jsfmt.Value{}, Errorf(http.StatusForbidden, "only the agent that sent the mail, its parent, the chief of staff or the assistant may withdraw it")
	}
	if toHuman, err := s.db.SentToHuman(ctx, id); err != nil {
		return jsfmt.Value{}, err
	} else if !toHuman {
		return jsfmt.Value{}, Errorf(http.StatusConflict, "%s wasn't sent to the human", id)
	}
	if m.Text("permission_id") != "" {
		return jsfmt.Value{}, Errorf(http.StatusConflict, "%s is a permission request: answer it with answer_permission", id)
	}
	if m.Text("kind") == "ask" {
		return jsfmt.Value{}, Errorf(http.StatusConflict, "%s is an ITSA ask: move the ITSA out of its human status, which withdraws it", id)
	}
	if open, err := s.db.DecisionMailOpen(ctx, id); err != nil {
		return jsfmt.Value{}, err
	} else if !open {
		return jsfmt.Value{}, Errorf(http.StatusConflict, "%s isn't waiting on the human: it is answered, already withdrawn, or not a decision mail", id)
	}
	if tid := m.Text("thread_id"); tid != "" {
		if deferred, err := s.db.IsThreadDeferred(ctx, tid); err != nil {
			return jsfmt.Value{}, err
		} else if deferred {
			return jsfmt.Value{}, Errorf(http.StatusConflict, "%s is one the human deferred (Decide later), so it stays with them", id)
		}
	}
	if err := s.db.RemoveDecisionMail(ctx, id, "withdrawn"); err != nil {
		return jsfmt.Value{}, err
	}
	fallback := by
	if byName != "" {
		fallback = byName
	}
	note := "Withdrawn by @" + s.agentOrPeerName(ctx, by, fallback)
	if why := strings.TrimSpace(reason); why != "" {
		note += ": " + why
	}
	ws, err := s.withdraw(ctx, []string{id}, by, note, withdrawOpts{})
	if err != nil {
		return jsfmt.Value{}, err
	}
	return withdrawnValue(ws), nil
}

// agentOrPeerName is the name this daemon knows an agent by, here or on a peer, else fallback.
func (s *Server) agentOrPeerName(ctx context.Context, id, fallback string) string {
	if a, err := s.db.GetAgent(ctx, id); err == nil {
		return a.Name
	}
	if p, ok, err := s.db.FindPeerAgent(ctx, id); err == nil && ok {
		return p.Name
	}
	return fallback
}

// forwardWithdrawAsk is src/withdraw.ts forwardWithdrawAsk: the peer that holds the mail settles it for this caller, which
// the forwarded request names as its agent, with its boss flag.
func (s *Server) forwardWithdrawAsk(ctx context.Context, id, by, reason string, boss bool, byName string) (jsfmt.Value, error) {
	for _, p := range s.peers.Peers() {
		r, err := s.peers.Call(ctx, p, http.MethodPost, "/api/mail/"+url.PathEscape(id)+"/withdraw-ask",
			map[string]string{"note": reason, "by_name": byName}, 8*time.Second, false, &peers.Via{Agent: by, Boss: boss})
		if err != nil {
			continue
		}
		if r.Status == http.StatusOK {
			if w, ok := r.Data.Get("withdrawn"); ok && w.Kind == jsfmt.Array {
				return w, nil
			}
			return jsfmt.ArrayValue([]jsfmt.Value{}), nil
		}
		if r.Status != http.StatusNotFound {
			msg := r.Data.Text("error")
			if e, ok := r.Data.Get("error"); !ok || e.Kind == jsfmt.Null {
				msg = "HTTP " + strconv.Itoa(r.Status)
			}
			return jsfmt.Value{}, Errorf(r.Status, "%s", msg)
		}
	}
	return jsfmt.Value{}, Errorf(http.StatusNotFound, "no mail %s", id)
}

// peerWithdrawRoute is POST /api/mail/withdraw: a peer withdraws mail it doesn't hold from the human; only a peer may.
func (s *Server) peerWithdrawRoute(r *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer withdraws mail from the human this way")
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	var ids []string
	if v, ok := body.Get("ids"); ok && v.Kind == jsfmt.Array {
		for _, x := range v.Items {
			ids = append(ids, anyString(x))
		}
	}
	truthy := func(k string) bool { v, ok := body.Get(k); return ok && v.Truthy() }
	ws, err := s.withdraw(context.WithoutCancel(r.Context()), ids, orString(body, "by", ""), orString(body, "note", ""),
		withdrawOpts{fromPeer: true, keepThread: truthy("keep_thread"), closeKept: truthy("close_kept")})
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("withdrawn", withdrawnValue(ws))
	return out, nil
}
