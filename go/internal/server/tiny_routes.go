package server

import (
	"errors"
	"math"
	"net/http"
	"time"
	"unicode/utf16"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/tiny"
)

// The tiny-model steps the human's view asks for (src/daemon.ts): tool-call summaries (S-1481), tool names (S-1933) and
// mail titles (S-1843). Only the human's view asks, so an agent can't spend on them.
func (s *Server) tinyRoutes() {
	s.handle("POST /api/tool-summaries", s.toolSummaries)
	s.handle("POST /api/tool-names", s.toolNames)
	s.handle("POST /api/mail-titles", s.mailTitles)
}

// tinyRequest is a request's checks both routes share: the human's, and an agent of at most 200 characters.
func (s *Server) tinyRequest(r *http.Request, c auth.Resolved, what string) (write, string, time.Duration, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return w, "", 0, err
	}
	if !w.human {
		return w, "", 0, Errorf(http.StatusForbidden, "%s are for the human's view", what)
	}
	v, _ := w.body.Get("agent")
	agent, _ := v.(string)
	if agent == "" || len(utf16.Encode([]rune(agent))) > tiny.IDChars {
		return w, "", 0, Errorf(http.StatusBadRequest, "agent is required, at most 200 characters")
	}
	// Number(body.wait), when finite and positive.
	wv, _ := w.body.Get("wait")
	ms := jsjson.ToNumber(wv)
	var wait time.Duration
	if !math.IsNaN(ms) && !math.IsInf(ms, 0) && ms > 0 {
		wait = time.Duration(min(ms, float64(tiny.WaitMax/time.Millisecond)) * float64(time.Millisecond))
	}
	return w, agent, wait, nil
}

// toolSummaries is POST /api/tool-summaries: the calls the view shows, in priority order, as {agent, calls: [{id, name,
// input}], wait}. Stored summaries come back, missing ones are asked for (waiting up to wait ms), and with the step off
// nothing is asked.
func (s *Server) toolSummaries(r *http.Request, c auth.Resolved) (any, error) {
	w, agent, wait, err := s.tinyRequest(r, c, "tool summaries")
	if err != nil {
		return nil, err
	}
	v, _ := w.body.Get("calls")
	calls, err := tiny.ReadCalls(v)
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	out, err := s.tiny.ToolSummaries(r.Context(), agent, calls, wait)
	if err != nil {
		return nil, err
	}
	return raw(out), nil
}

// toolNames is POST /api/tool-names: the labels of the tools the view shows, as {agent, names, wait}. Labels are per
// harness, read from the agent; seeded and stored ones come back, missing ones are asked for once.
func (s *Server) toolNames(r *http.Request, c auth.Resolved) (any, error) {
	w, agent, wait, err := s.tinyRequest(r, c, "tool names")
	if err != nil {
		return nil, err
	}
	a, err := s.db.GetAgent(r.Context(), agent)
	if errors.Is(err, db.ErrNotFound) {
		return nil, Errorf(http.StatusNotFound, "no such agent")
	}
	if err != nil {
		return nil, err
	}
	v, _ := w.body.Get("names")
	names, err := tiny.ReadNames(v)
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	out, err := s.tiny.ToolNames(r.Context(), a.Harness, names, wait)
	if err != nil {
		return nil, err
	}
	return raw(out), nil
}

// mailTitles is POST /api/mail-titles: the mails the human's view shows, as {ids}. A stale title or summary is queued to
// be asked again, and the answer is {enabled, pending} at once (src/mail-title.ts mailTitlesShown).
func (s *Server) mailTitles(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.human {
		return nil, Errorf(http.StatusForbidden, "mail titles are for the human's view")
	}
	v, _ := w.body.Get("ids")
	list, ok := v.([]jsjson.Value)
	ids := make([]string, len(list))
	for i, x := range list {
		id, isText := x.(string)
		if !isText || id == "" || len(utf16.Encode([]rune(id))) > tiny.IDChars {
			ok = false
			break
		}
		ids[i] = id
	}
	if !ok {
		return nil, Errorf(http.StatusBadRequest, "ids must be mail ids, at most 200 characters each")
	}
	out, err := s.tiny.MailTitlesShown(r.Context(), ids)
	if err != nil {
		return nil, err
	}
	return raw(out), nil
}
