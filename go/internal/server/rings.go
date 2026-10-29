package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strings"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/ring"
)

// Rings (src/ring.ts, src/daemon.ts startRing and the /api/rings routes): several agents work on one topic together.
//
// A ring's members and moderator may be spawned for it (ringStart), a ring reviewer type spawns a ring (rings_type.go), and a
// member that never started decides its ring at once, as incomplete or on its type's fallback (rings_dead.go). A ring's turn
// notices need the lifecycle (they are queued for the agents' next idle push), so a daemon without it answers 501.

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
			s.sendFromSystem(ctx, "ring", e.To, e.Subject, e.Body)
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
	if err := s.ringsNeedLife(); err != nil {
		return nil, err
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
	st := ringStart{s: s, c: c, human: s.isHuman(r, c), body: body, in: in}
	id, err := st.run(ctx)
	if err != nil {
		return nil, err
	}
	row, _, _, err := s.db.RingView(ctx, id)
	return row, err
}

// ringStart is src/daemon.ts startRing: new members are spawned from the `spawn` entries ({type}, {preset} or {harness,
// model}) as NAME-1, NAME-2, ..., and a moderator given as an object as NAME-mod, each through the normal spawn as the
// ring's creator asked. If anything fails, the agents spawned for the ring are stopped and archived, so nothing is left
// running and no ring is stored.
type ringStart struct {
	s       *Server
	c       auth.Resolved
	human   bool
	body    jsfmt.Value
	in      ring.CreateInput
	spawned []db.Agent
}

func (st *ringStart) run(ctx context.Context) (string, error) {
	id, err := st.start(ctx)
	if err != nil {
		st.s.discardAgents(ctx, st.spawned)
		return "", err
	}
	return id, nil
}

func (st *ringStart) start(ctx context.Context) (string, error) {
	in := st.in
	if sp, ok := st.body.Get("spawn"); ok && sp.Kind == jsfmt.Array {
		for i, entry := range sp.Items {
			a, err := st.spawnFor(ctx, entry, fmt.Sprintf("%s-%d", in.Name, i+1), "Member")
			if err != nil {
				return "", err
			}
			in.Members = append(in.Members, a.Name)
		}
	}
	if v, ok := st.body.Get("moderator"); ok && v.Truthy() {
		// typeof moderator === 'object': an object (or an array) is a spec to spawn, anything else an agent's name.
		if v.Kind == jsfmt.Object || v.Kind == jsfmt.Array {
			a, err := st.spawnFor(ctx, v, in.Name+"-mod", "Moderator")
			if err != nil {
				return "", err
			}
			in.Moderator = a.Name
		} else {
			in.Moderator = anyString(v)
		}
	}
	id, effects, err := st.s.ringEngine().Create(ctx, st.s.db, in)
	if err != nil {
		return "", ringRefusal(err, http.StatusBadRequest)
	}
	st.s.ringEffects(ctx, effects)
	if fb, ok := st.body.Get("fallback"); ok && fb.Truthy() {
		st.s.recordFallback(ctx, id, fb)
	}
	return id, nil
}

// recordFallback is src/ring.ts recordFallback: what a ring spawned from a reviewer type needs to run its type's single
// reviewer later (S-3070), as a `ring:fallback` event {ring, ...fallback} on its first member, so it needs no column and
// survives a restart. The ring is running by now, so a failed write is logged, not returned: the ring goes on with no
// fallback.
func (s *Server) recordFallback(ctx context.Context, id string, fb jsfmt.Value) {
	row, _, _, err := s.db.RingView(ctx, id)
	first := ""
	if err == nil {
		if m, perr := jsfmt.Parse([]byte(row.Text("members"))); perr == nil && m.Kind == jsfmt.Array && len(m.Items) > 0 {
			first = m.Items[0].Str
		}
	}
	data := jsfmt.Value{Kind: jsfmt.Object}
	data.Set("ring", jsfmt.StringValue(id))
	if fb.Kind == jsfmt.Object {
		for i, k := range fb.Keys {
			data.Set(k, fb.Items[i])
		}
	}
	if err == nil {
		err = s.db.AddEvent(ctx, first, "ring:fallback", json.RawMessage(jsfmt.Compact(data)))
	}
	if err != nil {
		slog.Error("ring: couldn't record its fallback", "ring", id)
	}
}

// spawnFor spawns one member or moderator. A name already taken is refused before anything is created, and that agent is
// never ours to touch. It spawns as the ring's creator, checked as that creator (S-480): a `by`, `self` or `from` inside
// the entry is no identity resolveActors checked, so the creator's replaces it.
func (st *ringStart) spawnFor(ctx context.Context, entry jsfmt.Value, name, what string) (db.Agent, error) {
	if _, err := st.s.db.GetAgent(ctx, name); err == nil {
		return db.Agent{}, Errorf(http.StatusConflict, "name %s is taken", name)
	} else if !errors.Is(err, db.ErrNotFound) {
		return db.Agent{}, err
	}
	spec, err := st.s.ringSpawnBrief(entry, st.in, what)
	if err != nil {
		return db.Agent{}, err
	}
	spec.Delete("self")
	spec.Delete("from")
	spec.Delete("by")
	parent := ""
	if st.in.CreatedBy != humanBox {
		parent = st.in.CreatedBy
		spec.Set("by", parent)
	}
	spec.Set("name", name)
	spec.Set("role", sliceUTF16(fmt.Sprintf("%s of ring %s: %s", what, st.in.Name, st.in.Topic), 300))
	spec.Delete("cwd")
	if v, ok := st.body.Get("cwd"); ok {
		if cwd, err := jsjson.Parse([]byte(jsfmt.Compact(v))); err == nil {
			spec.Set("cwd", cwd)
		}
	}
	spec.Delete("parent")
	if parent != "" {
		spec.Set("parent", parent)
	}
	created := ""
	out, err := st.s.spawnWrite(ctx, st.c, write{body: spec, human: st.human, local: st.c.Local, onCreated: func(id string) { created = id }})
	if err != nil {
		// A launch that failed after the agent's row was created leaves it behind: discard it too, by the id this spawn made.
		if created != "" {
			if left, gerr := st.s.db.GetAgent(ctx, created); gerr == nil {
				st.spawned = append(st.spawned, left)
			}
		}
		return db.Agent{}, err
	}
	a := out.(spawnView).Agent
	st.spawned = append(st.spawned, a)
	return a, nil
}

// ringSpawnBrief is src/daemon.ts ringSpawnBrief: a member or moderator spawned by a type with a brief gets that brief as
// its first prompt (S-3926). The ring's topic is its task unless its entry names one, and the ring's next steps replace
// the type's, which would have it post its own pr_review. An unknown type is the spawn's to refuse.
func (s *Server) ringSpawnBrief(entry jsfmt.Value, in ring.CreateInput, what string) (*jsjson.Object, error) {
	v, err := jsjson.Parse([]byte(jsfmt.Compact(entry)))
	if err != nil {
		return nil, err
	}
	spec, ok := v.(*jsjson.Object)
	if !ok {
		spec = jsjson.NewObject()
	}
	t, _ := spec.Get("type")
	if !jsjson.Truthy(t) {
		return spec, nil
	}
	typ, err := s.spawnType(jsjson.ToString(t))
	if err != nil {
		return spec, nil
	}
	if b, _ := typ.Get("brief"); !jsjson.Truthy(b) {
		return spec, nil
	}
	if p, ok := spec.Get("prompt"); !ok || p == nil {
		spec.Set("prompt", in.Topic)
	}
	if s.tpl == nil {
		return nil, fmt.Errorf("no templates: can't render ring-member-steps")
	}
	steps, err := s.tpl.Render("ring-member-steps", map[string]string{"role": strings.ToLower(what), "ring": in.Name}, "")
	if err != nil {
		return nil, err
	}
	// {next_steps, ...vars}: the entry's own brief_vars win.
	vars := jsjson.NewObject()
	vars.Set("next_steps", steps)
	if bv, _ := spec.Get("brief_vars"); bv != nil {
		if o, ok := bv.(*jsjson.Object); ok {
			for _, k := range o.Keys() {
				x, _ := o.Get(k)
				vars.Set(k, x)
			}
		}
	}
	spec.Set("brief_vars", vars)
	return spec, nil
}

// discardAgents is src/daemon.ts discardAgents: it stops and archives agents spawned for something that then failed.
// A failure is logged with the agent's id only.
func (s *Server) discardAgents(ctx context.Context, list []db.Agent) {
	for _, a := range list {
		cur, err := s.db.GetAgent(ctx, a.ID)
		if err == nil {
			err = s.life.Shutdown(ctx, cur)
		}
		if err == nil {
			cur, err = s.db.GetAgent(ctx, a.ID)
		}
		if err == nil {
			_, err = s.life.Archive(ctx, cur, lifecycle.ArchiveOpts{Force: true, Discard: true})
		}
		if err != nil {
			// The error can carry a worktree command's path and stderr, so only the agent id is logged.
			slog.Error("ring: couldn't discard an agent spawned for it", "agent", a.ID)
		}
	}
}

func (s *Server) ringActRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
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

// StartRings is what the daemon does at its first start for rings (src/daemon.ts: ring.sweepDeadMembers, then
// ring.promptOpenSeats): a member marked never started whose ring the restart left untold is dropped first (S-3070), then the
// queued turn notices, which died with the last run, are given again: each open seat of a running ring is prompted from the
// durable state. It returns how many seats.
func (s *Server) StartRings(ctx context.Context) (int, error) {
	if s.life == nil {
		return 0, nil
	}
	if err := s.sweepRings(ctx); err != nil {
		slog.Error("ring sweep failed", "err", err)
	}
	n, effects, err := s.ringEngine().PromptOpenSeats(ctx, s.db)
	if err != nil {
		return 0, err
	}
	s.ringEffects(ctx, effects)
	return n, nil
}
