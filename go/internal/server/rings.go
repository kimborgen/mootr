package server

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/ring"
)

// Rings (src/ring.ts, src/daemon.ts startRing and the /api/rings routes): several agents work on one topic together.
//
// Not ported, each answering 501 before anything is written: starting a ring that spawns its members or its moderator (`spawn`, a
// moderator given as an object, and the ring reviewer types of spawn_agent), since the Go daemon has no spawn yet. A ring of
// agents that already exist starts here. A ring's turn notices need the lifecycle (they are queued for the agents' next idle push),
// so a daemon without it answers 501 too.

func (s *Server) ringRoutes() {
	s.handle("GET /api/rings", s.ringsListRoute)
	s.handle("GET /api/rings/{id}", s.ringGetRoute)
	s.handle("POST /api/rings", s.ringCreateRoute)
	s.handle("POST /api/rings/{id}/submit", s.ringActRoute)
	s.handle("POST /api/rings/{id}/decide", s.ringActRoute)
}

func (s *Server) ringEngine() ring.Engine {
	// A template that can't be read fails the step that renders it, which rolls back the tx it runs in (TS's render throws inside
	// createRing's, submit's and decide's transactions): no ring is stored with empty prompts.
	return ring.Engine{Entered: s.ringHooks.entered, Wrote: s.ringHooks.wrote, Render: func(name string, vars map[string]string) (string, error) {
		if s.tpl == nil {
			return "", fmt.Errorf("no templates: can't render %s", name)
		}
		return s.tpl.Render(name, vars, "")
	}}
}

func (s *Server) ringsNeedLife() error {
	if s.life == nil {
		return unported("a ring's turns are notices queued for its agents, which needs the lifecycle this daemon runs without")
	}
	return nil
}

// ringEffects carries out what a committed ring step asked for: the notices queued for the agents, and the mail stam sends when a
// ring ends (which TS sends without waiting for, and ignores a failure of).
func (s *Server) ringEffects(ctx context.Context, effects []ring.Effect) {
	for _, e := range effects {
		if e.Agent != "" {
			s.life.QueueRingNotice(ctx, e.Agent, e.Text)
		} else {
			s.sendFromStam(ctx, e.To, e.Subject, e.Body)
		}
	}
}

func (s *Server) ringsListRoute(r *http.Request, _ auth.Resolved) (any, error) {
	list, err := s.db.RingsStatus(r.Context())
	return nonNilValues(list), err
}

func (s *Server) ringGetRoute(r *http.Request, _ auth.Resolved) (any, error) {
	ref := r.PathValue("id")
	row, subs, ok, err := s.db.RingView(r.Context(), ref)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, Errorf(http.StatusInternalServerError, "no ring %s", ref)
	}
	// {...r, members: names, submissions}: the row's columns in place, members as the member names.
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range row.Keys {
		out.Set(k, row.Items[i])
	}
	var names []jsfmt.Value
	if m, err := jsfmt.Parse([]byte(row.Text("members"))); err == nil && m.Kind == jsfmt.Array {
		for _, id := range m.Items {
			name := id.Str
			if a, err := s.db.GetAgent(r.Context(), id.Str); err == nil {
				name = a.Name
			}
			names = append(names, jsfmt.StringValue(name))
		}
	}
	out.Set("members", jsfmt.ArrayValue(names))
	out.Set("submissions", jsfmt.ArrayValue(nonNilValues(subs)))
	return out, nil
}

// ringRefusal maps a ring's own refusal to the status the daemon answers it with: 409 for a submit or decide, 400 for a start.
func ringRefusal(err error, status int) error {
	if err == nil {
		return nil
	}
	if ring.IsRefusal(err) {
		return Errorf(status, "%s", err.Error())
	}
	return err
}

func (s *Server) ringCreateRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if err := s.resolveBodyActors(ctx, c, &body); err != nil {
		return nil, err
	}
	createdBy := ""
	if v, ok := body.Get("by"); ok && v.Truthy() {
		a, err := s.mustAgent(ctx, anyString(v))
		if err != nil {
			return nil, err
		}
		createdBy = a.ID
	} else if s.isHuman(r, c) {
		createdBy = humanBox
	}
	if createdBy == "" {
		return nil, Errorf(http.StatusForbidden, "a ring needs a creator")
	}
	if sp, ok := body.Get("spawn"); ok && sp.Kind == jsfmt.Array && len(sp.Items) > 0 {
		return nil, unported("starting a ring spawns its members, which is not ported to the Go daemon yet: start it with agents that already exist")
	}
	in := ring.CreateInput{CreatedBy: createdBy, Format: "rounds"}
	// String(body.name): a missing name is "undefined" and a null one "null", and either is a ring so named.
	in.Name = "undefined"
	if v, ok := body.Get("name"); ok {
		in.Name = anyString(v)
	}
	in.Topic = jsString(body, "topic")
	if v, ok := body.Get("format"); ok && v.Kind != jsfmt.Null {
		in.Format = anyString(v)
	}
	if v, ok := body.Get("members"); ok && v.Kind == jsfmt.Array {
		for _, m := range v.Items {
			in.Members = append(in.Members, anyString(m))
		}
	}
	if v, ok := body.Get("moderator"); ok && v.Truthy() {
		if v.Kind == jsfmt.Object || v.Kind == jsfmt.Array {
			return nil, unported("starting a ring spawns its moderator, which is not ported to the Go daemon yet: name an agent that already exists")
		}
		in.Moderator = anyString(v)
	}
	if v, ok := body.Get("moderator_decides"); ok {
		in.ModeratorDecides = v.Truthy()
	}
	if v, ok := body.Get("max_rounds"); ok && v.Truthy() {
		// A fraction stays a fraction in TS (round >= 2.5 ends the ring after round 3): rounding it up ends it in the same round. A
		// value under 1 that rounds to 0 would read as "unset", so it is -1, which ends the ring just the same.
		if n, ok := jsNumber(v); ok {
			in.MaxRounds = int(math.Ceil(n))
			if in.MaxRounds == 0 {
				in.MaxRounds = -1
			}
		}
	}
	if err := s.ringsNeedLife(); err != nil {
		return nil, err
	}
	id, effects, err := s.ringEngine().Create(ctx, s.db, in)
	if err != nil {
		return nil, ringRefusal(err, http.StatusBadRequest)
	}
	s.ringEffects(ctx, effects)
	row, _, _, err := s.db.RingView(ctx, id)
	return row, err
}

func (s *Server) ringActRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if err := s.resolveBodyActors(ctx, c, &body); err != nil {
		return nil, err
	}
	by := ""
	if v, ok := body.Get("by"); ok && v.Kind != jsfmt.Null {
		by = anyString(v)
	}
	a, err := s.mustAgent(ctx, by)
	if err != nil {
		return nil, err
	}
	if err := s.ringsNeedLife(); err != nil {
		return nil, err
	}
	text := jsString(body, "text")
	var result string
	var effects []ring.Effect
	if strings.HasSuffix(r.URL.Path, "/submit") {
		in := ring.SubmitInput{Ring: r.PathValue("id"), Agent: a.ID, Text: text, Agree: truthy(body, "agree")}
		if v, ok := body.Get("verdict"); ok && v.Kind != jsfmt.Null {
			verdict := anyString(v)
			in.Verdict = &verdict
		}
		if v, ok := body.Get("round"); ok && v.Kind != jsfmt.Null {
			in.HasRound = true
			in.Round = math.NaN()
			if f, ok := jsNumber(v); ok {
				in.Round = f
			}
		}
		if v, ok := body.Get("seat"); ok && v.Kind != jsfmt.Null {
			seat := anyString(v)
			in.Seat = &seat
		}
		result, effects, err = s.ringEngine().Submit(ctx, s.db, in)
	} else {
		result, effects, err = s.ringEngine().Decide(ctx, s.db, r.PathValue("id"), a.ID, truthy(body, "continue"), text)
	}
	if err != nil {
		return nil, ringRefusal(err, http.StatusConflict)
	}
	s.ringEffects(ctx, effects)
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("result", jsfmt.StringValue(result))
	return out, nil
}

func truthy(body jsfmt.Value, key string) bool {
	v, ok := body.Get(key)
	return ok && v.Truthy()
}

// StartRings is what the daemon does at its first start for rings (src/daemon.ts: ring.promptOpenSeats): the queued turn notices
// died with the last run, so each open seat of a running ring is prompted again from the durable state. It returns how many seats.
func (s *Server) StartRings(ctx context.Context) (int, error) {
	if s.life == nil {
		return 0, nil
	}
	n, effects, err := s.ringEngine().PromptOpenSeats(ctx, s.db)
	if err != nil {
		return 0, err
	}
	s.ringEffects(ctx, effects)
	return n, nil
}
