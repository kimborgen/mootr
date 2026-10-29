package server

import (
	"net/http"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
)

// costAck is POST /api/cost/ack (src/daemon.ts): a manager (by) or the human records that it handled a cost notice, by
// the event id in the notice, which stops its fallback. A request with no by speaks for the human, refused under
// auth.humanStrict when it doesn't come from the human. The answer is the ack's result: ok, or why not, both a 200.
func (s *Server) costAck(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	by, _ := w.body.Get("by")
	named := jsjson.Truthy(by)
	if !named && s.strictRefuses("cost ack with no by", !w.human && !(w.local && c.Kind == auth.Shared) && c.Kind != auth.Agent) {
		return nil, Errorf(http.StatusForbidden, "a cost notice is acknowledged by an agent (by) or the human")
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "cost notices aren't available on this daemon")
	}
	who := humanBox
	if named {
		a, err := s.mustAgent(ctx, claude.JSString(by))
		if err != nil {
			return nil, err
		}
		who = a.ID
	}
	event, _ := w.body.Get("event")
	return s.life.AckCostNotice(ctx, bodyText(event), who, "cost_ack")
}

// costPause is POST /api/cost/pause (src/daemon.ts): a manager (by) or the human pauses a tree for cost until a window
// resets or a set time, or clears the pause. Who may is src/cost-auth.ts's rule (lifecycle.CostPause): a refusal is a
// 403, any other error a 400.
func (s *Server) costPause(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	var by string
	if v, _ := w.body.Get("by"); jsjson.Truthy(v) {
		a, err := s.mustAgent(ctx, claude.JSString(v))
		if err != nil {
			return nil, err
		}
		by = a.ID
	} else if w.human {
		by = humanBox
	} else {
		return nil, Errorf(http.StatusForbidden, "cost_pause needs an agent (by) or the human")
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "cost pauses aren't available on this daemon")
	}
	opt := func(k string) *string {
		v, _ := w.body.Get(k)
		if v == nil {
			return nil
		}
		t := bodyText(v)
		return &t
	}
	tree, _ := w.body.Get("tree")
	clear, _ := w.body.Get("clear")
	out, err := s.life.CostPause(ctx, lifecycle.PauseOptions{Root: bodyText(tree), By: by, Until: opt("until"), Account: opt("account"),
		Window: opt("window"), Reason: opt("reason"), Clear: jsjson.Truthy(clear)})
	if lifecycle.IsForbidden(err) {
		return nil, Errorf(http.StatusForbidden, "%s", err.Error())
	}
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	return out, nil
}

// costAllocations is GET /api/cost/allocations (src/daemon.ts): the allocations with their current use, or the tree's
// (?tree=, an agent's name or id).
func (s *Server) costAllocations(r *http.Request, _ auth.Resolved) (any, error) {
	ctx := r.Context()
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "allocations aren't available on this daemon")
	}
	root := ""
	if tree := r.URL.Query().Get("tree"); tree != "" {
		a, err := s.mustAgent(ctx, tree)
		if err != nil {
			return nil, err
		}
		root = a.ID
	}
	views, err := s.life.AllocationViews(ctx, root, time.Now())
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("allocations", jsfmt.ArrayValue(views))
	return out, nil
}

// costAllocate is POST /api/cost/allocate (src/daemon.ts): a manager (by) or the human sets an allocation on a tree, or
// with clear removes one. Who may is cost_pause's rule; every refusal and malformed allocation is a 400, as TS's. Setting
// or clearing a tree's allocation counts as acting on its cost notices.
func (s *Server) costAllocate(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	var by string
	if v, _ := w.body.Get("by"); jsjson.Truthy(v) {
		a, err := s.mustAgent(ctx, claude.JSString(v))
		if err != nil {
			return nil, err
		}
		by = a.ID
	} else if w.human {
		by = humanBox
	} else {
		return nil, Errorf(http.StatusForbidden, "an allocation needs an agent (by) or the human")
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "allocations aren't available on this daemon")
	}
	field := func(k string) jsjson.Value { v, _ := w.body.Get(k); return v }
	in := lifecycle.AllocationInput{ID: field("id"), Tree: field("tree"), Account: field("account"), Kind: field("kind"), Window: field("window"),
		Percent: field("percent"), Amount: field("amount"), Period: field("period"), Note: field("note")}
	bad := func(err error) error { return Errorf(http.StatusBadRequest, "%s", err.Error()) }
	if jsjson.Truthy(field("clear")) {
		root := ""
		if jsjson.Truthy(in.Tree) {
			root = claude.JSString(in.Tree)
		} else if jsjson.Truthy(in.ID) {
			a, found, err := s.life.FindAllocation(ctx, claude.JSString(in.ID))
			if err != nil {
				return nil, bad(err)
			}
			if found {
				root = a.RootID
			}
		}
		cleared, err := s.life.ClearAllocation(ctx, in, by)
		if err != nil {
			return nil, bad(err)
		}
		if cleared > 0 && root != "" {
			if err := s.life.AckTreeNotices(ctx, root, by, "cost_allocate"); err != nil {
				return nil, bad(err)
			}
		}
		out := jsfmt.Value{Kind: jsfmt.Object}
		out.Set("cleared", jsfmt.IntValue(int64(cleared)))
		return out, nil
	}
	a, warning, err := s.life.SetAllocation(ctx, in, by, time.Now())
	if err != nil {
		return nil, bad(err)
	}
	if err := s.life.AckTreeNotices(ctx, a.RootID, by, "cost_allocate"); err != nil {
		return nil, bad(err)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("allocation", lifecycle.AllocationJSON(a))
	if warning != nil {
		out.Set("warning", jsfmt.StringValue(*warning))
	} else {
		out.Set("warning", jsfmt.NullValue())
	}
	return out, nil
}
