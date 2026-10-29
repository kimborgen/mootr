package opencode

import (
	"context"
	"net/url"

	"stam/internal/jsjson"
)

// What a turn's end and the control calls read and send (src/adapters/opencode.ts updateContext, compact, reconnectMcp,
// S-4237). Like every call here, a failure's text is the method, the path and the status (CallError), never a body.

// SessionUsage is a session's cumulative usage (GET /api/session/SID): the cost, which the server may not send, and the
// token counts, the output with the reasoning tokens.
type SessionUsage struct {
	Cost                                 *float64
	Input, Output, CacheRead, CacheWrite float64
}

// SessionUsage is the session's usage, ok false when the server sends no tokens for it.
func (s *Server) SessionUsage(ctx context.Context, sid string) (SessionUsage, bool, error) {
	v, err := s.Call(ctx, "GET", "/api/session/"+url.PathEscape(sid), nil)
	if err != nil {
		return SessionUsage{}, false, err
	}
	o := asObject(v)
	t := asObject(ocGet(o, "tokens"))
	if !jsjson.Truthy(ocGet(o, "tokens")) || t == nil {
		return SessionUsage{}, false, nil
	}
	u := SessionUsage{
		Input:      num(ocGet(t, "input")),
		Output:     num(ocGet(t, "output")) + num(ocGet(t, "reasoning")),
		CacheRead:  num(ocGet(asObject(ocGet(t, "cache")), "read")),
		CacheWrite: num(ocGet(asObject(ocGet(t, "cache")), "write")),
	}
	if c, ok := ocGet(o, "cost").(float64); ok {
		u.Cost = &c
	}
	return u, true, nil
}

// ContextTokens is the size of the session's context at its last assistant message (GET
// /api/session/SID/message?type=assistant&order=desc&limit=1): its input and cache-read tokens. ok is false when there is
// no such message or it has no tokens.
func (s *Server) ContextTokens(ctx context.Context, sid string) (float64, bool, error) {
	q := url.Values{"type": {"assistant"}, "order": {"desc"}, "limit": {"1"}}
	v, err := s.Call(ctx, "GET", "/api/session/"+url.PathEscape(sid)+"/message?"+q.Encode(), nil)
	if err != nil {
		return 0, false, err
	}
	list, ok := v.([]jsjson.Value)
	if !ok {
		list, _ = ocGet(asObject(v), "items").([]jsjson.Value)
	}
	if len(list) == 0 {
		return 0, false, nil
	}
	t := asObject(ocGet(asObject(list[0]), "tokens"))
	if t == nil {
		return 0, false, nil
	}
	return num(ocGet(t, "input")) + num(ocGet(asObject(ocGet(t, "cache")), "read")), true, nil
}

// Compact asks the server to compact the session (POST /api/session/SID/compact): its summary is written by the
// server, in the session, with no relaunch.
func (s *Server) Compact(ctx context.Context, sid string) error {
	_, err := s.Call(ctx, "POST", "/api/session/"+url.PathEscape(sid)+"/compact", jsjson.NewObject())
	return err
}

// ConnectMCP reconnects the stam MCP server for dir (POST /api/experimental/mcp/stam/connect?location[directory]=DIR):
// the server keeps one MCP client per directory, and connect replaces the one for the directory it names.
func (s *Server) ConnectMCP(ctx context.Context, dir string) error {
	q := url.Values{"location[directory]": {dir}}
	_, err := s.Call(ctx, "POST", "/api/experimental/mcp/stam/connect?"+q.Encode(), jsjson.NewObject())
	return err
}

// num is a number's value, 0 for anything else (TS's `?? 0` over a number).
func num(v jsjson.Value) float64 {
	n, _ := v.(float64)
	return n
}
