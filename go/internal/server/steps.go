package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/steps"
)

// stepsRoutes registers the decision-step API (src/daemon.ts, "Decision steps"). `decisions` is registered beside the
// `{id}` routes: the mux prefers the literal path.
func (s *Server) stepsRoutes() {
	s.handle("GET /api/steps", s.listSteps)
	s.handle("POST /api/steps", s.createStep)
	s.handle("POST /api/steps/check", s.checkStep)
	s.handle("GET /api/steps/decisions", s.stepDecisions)
	s.handle("GET /api/steps/{id}", stepPath(s.showStep))
	s.handle("PATCH /api/steps/{id}", stepPath(s.updateStep))
	s.handle("DELETE /api/steps/{id}", stepPath(s.removeStep))
	s.handle("POST /api/steps/{id}/preview", stepPath(s.previewStep))
	s.handle("GET /api/steps/{id}/log", stepPath(s.stepLog))
}

// stepPath refuses a step route whose id isn't one TS's ([\w-]+) matches, as no route.
func stepPath(h handler) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !agentRef.MatchString(r.PathValue("id")) {
			return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
		}
		return h(r, c)
	}
}

// stepErr is src/daemon.ts stepRoute: an unknown step is 404, anything else the step code throws 400.
func stepErr(err error) error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) {
		return err
	}
	var missing steps.ErrNoStep
	if errors.As(err, &missing) {
		return Errorf(http.StatusNotFound, "%s", err.Error())
	}
	// Whatever else the step code throws is a bad input (a database error too, as TS's catch-all).
	return Errorf(http.StatusBadRequest, "%s", err.Error())
}

// bodyInput is a request body as the steps' input: an absent or non-object body has no field.
func bodyInput(o *jsjson.Object) steps.Input {
	return func(key string) (jsjson.Value, bool) {
		if o == nil {
			return nil, false
		}
		return o.Get(key)
	}
}

// numberOr is `Number(text) || def` for a query value.
func numberOr(text string, def float64) float64 {
	if n := steps.JSNumber(text); n != 0 && n == n {
		return n
	}
	return def
}

func (s *Server) listSteps(r *http.Request, _ auth.Resolved) (any, error) {
	all, err := s.steps.List(r.Context())
	if err != nil {
		return nil, err
	}
	list := jsfmt.Value{Kind: jsfmt.Array}
	for _, st := range all {
		list.Items = append(list.Items, st.Value())
	}
	events := jsfmt.Value{Kind: jsfmt.Array}
	for _, e := range steps.Events {
		events.Items = append(events.Items, jsfmt.StringValue(e))
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("steps", list)
	out.Set("events", events)
	return out, nil
}

func (s *Server) createStep(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	st, err := s.steps.Create(r.Context(), bodyInput(w.body), nil)
	if err != nil {
		return nil, stepErr(err)
	}
	return st.Value(), nil
}

func (s *Server) showStep(r *http.Request, _ auth.Resolved) (any, error) {
	st, err := s.steps.Must(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, stepErr(err)
	}
	return st.Value(), nil
}

func (s *Server) updateStep(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	st, err := s.steps.Update(r.Context(), r.PathValue("id"), bodyInput(w.body))
	if err != nil {
		return nil, stepErr(err)
	}
	return st.Value(), nil
}

func (s *Server) removeStep(r *http.Request, c auth.Resolved) (any, error) {
	if _, err := s.readWrite(r, c); err != nil {
		return nil, err
	}
	id := r.PathValue("id")
	if err := s.steps.Remove(r.Context(), id); err != nil {
		return nil, stepErr(err)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("removed", jsfmt.StringValue(id))
	return out, nil
}

func (s *Server) previewStep(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	n := 5.0
	if w.body != nil {
		if v, ok := w.body.Get("n"); ok {
			n = steps.JSNumber(v)
			if n == 0 || n != n {
				n = 5
			}
		}
	}
	out, err := s.steps.Preview(r.Context(), r.PathValue("id"), n)
	if steps.IsNotPorted(err) {
		return nil, Errorf(http.StatusNotImplemented, "%s", err.Error())
	}
	if err != nil {
		return nil, stepErr(err)
	}
	return out, nil
}

func (s *Server) stepLog(r *http.Request, _ auth.Resolved) (any, error) {
	st, err := s.steps.Must(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, stepErr(err)
	}
	log, err := s.steps.Log(r.Context(), st.ID, int64(numberOr(r.URL.Query().Get("limit"), 100)))
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("decisions", log)
	return out, nil
}

func (s *Server) stepDecisions(r *http.Request, _ auth.Resolved) (any, error) {
	q := r.URL.Query()
	log, err := s.steps.DecisionsOn(r.Context(), q.Get("subject"), int64(numberOr(q.Get("limit"), 100)))
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("decisions", log)
	return out, nil
}

// checkStep is POST /api/steps/check: a tool call's check, before the tool runs (src/mcp.ts). The agent is named in the
// body and must be registered; an agent's token may check only as itself, and with no agent named its own checks.
//
// With requirements on, the requirements scoped to the tool (req-check.ts checkTool) are asked after the steps; a violation
// is the answer, `{allow: false, ...}`, which the MCP shim reads as "withhold the tool" (only a 403 withholds it by status).
func (s *Server) checkStep(r *http.Request, c auth.Resolved) (any, error) {
	raw, err := readBody(r)
	if err != nil {
		return nil, err
	}
	w, err := s.parseWrite(r, c, raw, true)
	if err != nil {
		return nil, err
	}
	var named, tool jsjson.Value
	if w.body != nil {
		named, _ = w.body.Get("agent")
		tool, _ = w.body.Get("tool")
	}
	if named == nil && c.Kind == auth.Agent {
		named = c.Agent
	}
	agent, okAgent := named.(string)
	toolName, okTool := tool.(string)
	if !okAgent || !okTool {
		return nil, Errorf(http.StatusBadRequest, "a check needs agent and tool")
	}
	id, err := s.actor(r.Context(), c.Caller, agent)
	if err != nil {
		return nil, err
	}
	a, err := s.mustAgent(r.Context(), id)
	if err != nil {
		return nil, err
	}
	args := jsfmt.Value{Kind: jsfmt.Object}
	if parsed, perr := jsfmt.Parse(raw); perr == nil {
		if v, ok := parsed.Get("args"); ok && (v.Kind == jsfmt.Object || v.Kind == jsfmt.Array) {
			args = v
		}
	}
	started := time.Now()
	res, err := s.steps.CheckTool(r.Context(), a.ID, toolName, args)
	if err != nil {
		return nil, err
	}
	if res.Allow && s.settings.Get().RequirementsEnabled {
		if left := steps.ToolBudget - time.Since(started); left > 0 {
			denial, err := s.requirementCheck(r.Context(), a.ID, toolName, args, left)
			if err != nil || denial != nil {
				if denial != nil {
					return *denial, nil
				}
				return nil, err
			}
		}
	}
	return res.Value(), nil
}

// spawnStepRefusal answers 501 where an enabled decision step on `agent-spawned` would run (src/daemon.ts spawn): its hook
// is not ported, so no agent is spawned while one exists. The other event steps are refused in itsa_observers.go.
func (s *Server) spawnStepRefusal(ctx context.Context) error {
	return s.db.Inspect(ctx, func(tx db.ItsaTx) error {
		if has, err := tx.StepOn("agent-spawned"); err != nil {
			return err
		} else if has {
			return unported("a decision step runs on agent-spawned, and decision steps are not ported to the Go daemon yet")
		}
		return nil
	})
}

// requirementCheck is src/req-check.ts checkTool, with requirements on: only the tools an in-force `enforce` requirement with
// a decision check scopes are asked of the model. On the ITSA home the engine answers (requirements.CheckTool); a daemon that
// is not the home asks the home, but only for a tool in the copy of the home's index it keeps (remoteToolCheck).
func (s *Server) requirementCheck(ctx context.Context, agentID, tool string, args jsfmt.Value, left time.Duration) (*jsfmt.Value, error) {
	if !s.isHome() {
		return s.remoteToolCheck(ctx, agentID, tool, args, left), nil
	}
	v := s.requirements.CheckTool(ctx, agentID, tool, toJSJSON(args), left, s.steps.ActorOf(ctx, agentID))
	if v.Allow {
		return nil, nil
	}
	denial := v.Value()
	return &denial, nil
}

// toJSJSON is a parsed value as the ordered kind jsjson holds.
func toJSJSON(v jsfmt.Value) jsjson.Value {
	out, err := jsjson.Parse([]byte(jsfmt.Compact(v)))
	if err != nil {
		return jsjson.NewObject()
	}
	return out
}

func (s *Server) isHome() bool { return s.settings.Get().Itsa.Home == s.cfg.Machine }
