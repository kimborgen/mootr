package opencode

import (
	"context"
	"errors"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// StopAttempts is how many times src/adapters/opencode.ts stop interrupts a session before it gives up; each attempt
// looks confirmPolls times, confirmEvery apart, for the server to list the session as idle.
const (
	StopAttempts = 6
	confirmPolls = 10
	confirmEvery = 250 * time.Millisecond
)

// errOddActive is an active list of a shape other than v2's `{"data": {SESSION: {...}}}`. Nothing of the answer is in it.
var errOddActive = errors.New("OpenCode GET /api/session/active: not a list of sessions")

// Active is src/adapters/opencode.ts isActive: whether the server lists the session as active (GET
// /api/session/active, `{"data": {SESSION: STATUS}}`: OpenCode 2.0.26's openapi schema requires data, an object of
// SessionActive objects keyed ^ses, and the server answers `{"data":{}}` with none). An error is no answer, never "idle", and so is an answer of any
// other shape (an empty body, null, a list, a scalar, a list not under data, a status that isn't an object), which TS
// would read as idle.
func (s *Server) Active(ctx context.Context, sid string) (bool, error) {
	active, err := s.ActiveSessions(ctx)
	return active[sid], err
}

// ActiveSessions is the sessions the server lists as active (Active's call), by id. An error is no answer, and so is
// an answer of an odd shape (errOddActive).
func (s *Server) ActiveSessions(ctx context.Context) (map[string]bool, error) {
	text, err := s.callText(ctx, "GET", "/api/session/active", nil)
	if err != nil {
		return nil, err
	}
	v, err := jsjson.Parse(text)
	if err != nil {
		return nil, errOddActive
	}
	wrap, _ := v.(*jsjson.Object)
	data, _ := ocGet(wrap, "data").(*jsjson.Object)
	if data == nil {
		return nil, errOddActive
	}
	listed := map[string]bool{}
	for _, k := range data.Keys() {
		if _, ok := ocGet(data, k).(*jsjson.Object); !ok || !strings.HasPrefix(k, "ses") {
			return nil, errOddActive
		}
		listed[k] = true
	}
	return listed, nil
}

// ocGet is o's value at key, nil when o is nil or lacks it.
func ocGet(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

// idle is whether the server answered that the session isn't active: a session it can't be asked about still runs.
func (s *Server) idle(ctx context.Context, sid string) bool {
	active, err := s.Active(ctx, sid)
	return err == nil && !active
}

// InterruptSession is src/adapters/opencode.ts interruptSession: the session interrupted (POST
// /api/session/:id/interrupt) up to attempts times, confirmed after each one by the server no longer listing it. An
// interrupt that errors counts as an attempt. keep, when given, is asked before each attempt and
// between the polls: false means the session is wanted again, so no more interrupts and no more waiting. It reports whether the session is idle; one whose state can't be read is not.
func (s *Server) InterruptSession(ctx context.Context, sid string, attempts int, keep func() bool) bool {
	for range attempts {
		if keep != nil && !keep() {
			break
		}
		_, _ = s.Call(ctx, "POST", "/api/session/"+sid+"/interrupt", nil)
		for range confirmPolls {
			// Asked between polls too, so a release never waits out a whole loop on a server that won't answer.
			if keep != nil && !keep() {
				return false
			}
			if err := s.sleep(ctx, confirmEvery); err != nil {
				return false
			}
			if s.idle(ctx, sid) {
				return true
			}
		}
	}
	return s.idle(ctx, sid)
}

// Interrupt is src/adapters/opencode.ts interrupt: one interrupt of the session, confirmed when the server no longer
// lists it as active. The server then sends session.execution.interrupted, which marks the agent idle.
func (s *Server) Interrupt(ctx context.Context, sid string) bool {
	return s.InterruptSession(ctx, sid, 1, nil)
}
