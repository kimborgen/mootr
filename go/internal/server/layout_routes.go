package server

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"unicode/utf16"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/layout"
)

// The human's layout (worlds, panes, tabs), shared by every web client (src/daemon.ts, S-98). Reading it and its stream
// are open to anyone with a token; arranging it is the human's (the web UI) or an agent's when the human asked (its MCP
// tools, naming itself with `by`). Setting the whole layout is the human's alone.
func (s *Server) layoutRoutes() {
	s.handle("GET /api/layout", func(*http.Request, auth.Resolved) (any, error) { return rawJSON(s.layout.Get()), nil })
	s.mux.Handle("GET /api/layout/stream", s.stream(s.layoutStream))
	s.handle("POST /api/layout/ops", s.layoutOps)
	s.handle("PUT /api/layout", s.layoutPut)
}

// StartLayout closes the image tabs of dead pages every 15 s, and ends the layout streams, until ctx ends: shutdown
// waits for every handler, and a stream's runs until its client goes.
func (s *Server) StartLayout(ctx context.Context) {
	s.layoutDone = ctx.Done()
	go s.layout.Sweep(ctx.Done())
}

func (s *Server) layoutStream(w http.ResponseWriter, r *http.Request, _ auth.Resolved) error {
	s.layout.Serve(w, r, r.Header.Get("X-Stam-Page"), s.layoutDone)
	return nil
}

// layoutOps is POST /api/layout/ops: a batch of ops, all or none, from the human or an agent naming itself (by).
func (s *Server) layoutOps(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	body := w.body
	var agent *db.Agent
	if by := get(body, "by"); jsjson.Truthy(by) {
		a, err := s.db.GetAgent(ctx, jsjson.ToString(by))
		if err != nil && !errors.Is(err, db.ErrNotFound) {
			return nil, err
		}
		if err == nil {
			agent = &a
		}
	}
	if !w.human && agent == nil {
		return nil, Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), changes the layout")
	}
	ops, ok := get(body, "ops").([]jsjson.Value)
	if !ok {
		return nil, Errorf(http.StatusBadRequest, "ops must be a list of layout ops")
	}
	var base *float64
	if v, has := body.Get("base"); has {
		f, isNum := v.(float64)
		if !isNum || f != math.Trunc(f) || math.IsInf(f, 0) {
			return nil, Errorf(http.StatusBadRequest, "base must be a layout version")
		}
		base = &f
	}
	var batch *string
	if v, has := body.Get("batch"); has {
		b, isStr := v.(string)
		// JavaScript's length counts UTF-16 units.
		if !isStr || len(utf16.Encode([]rune(b))) > 64 {
			return nil, Errorf(http.StatusBadRequest, "batch must be a short string")
		}
		batch = &b
	}
	next, err := s.layout.ApplyOps(ops, base, batch)
	if err != nil {
		return nil, layoutError(err)
	}
	if agent != nil && len(ops) > 0 {
		parts := make([]string, len(ops))
		for i, op := range ops {
			parts[i] = layout.DescribeOp(op)
		}
		if err := s.db.AddEvent(ctx, agent.ID, "layout", map[string]string{"summary": strings.Join(parts, "; ")}); err != nil {
			return nil, err
		}
	}
	return rawJSON(next), nil
}

// layoutPut is PUT /api/layout: the web's one-time move of its layout from browser storage, only while the stored one is
// empty.
func (s *Server) layoutPut(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.human {
		return nil, Errorf(http.StatusForbidden, "only the human sets the layout, from the web UI")
	}
	next, err := s.layout.Replace(get(w.body, "layout"))
	if err != nil {
		return nil, layoutError(err)
	}
	return rawJSON(next), nil
}

// layoutError is src/daemon.ts layoutRoute: a stale base or a non-empty replace is a 409 carrying the current layout;
// an invalid op is a 400.
func layoutError(err error) error {
	var conflict *layout.Conflict
	if errors.As(err, &conflict) {
		return &Error{Status: http.StatusConflict, Message: conflict.Message, Extra: map[string]any{"layout": rawJSON(conflict.Layout)}}
	}
	return Errorf(http.StatusBadRequest, "%s", err.Error())
}
