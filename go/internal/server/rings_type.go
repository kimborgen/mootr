package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"stam/internal/auth"
	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/ring"
)

// ringConfig is a type's review.ring (src/agent-types.ts RingConfig), or nil when the type is no ring.
func ringConfig(typ *jsjson.Object) *jsjson.Object {
	rv, _ := typ.Get("review")
	g, _ := at(rv, "ring")
	o, _ := g.(*jsjson.Object)
	return o
}

// ringTypeOf is the route's test in src/daemon.ts POST /api/agents: a spawn body naming a ring reviewer type, with no
// harness, model, or preset, is spawned as a ring. It gives the type's name and entry, or nil.
func (s *Server) ringTypeOf(body *jsjson.Object) (string, *jsjson.Object) {
	if body == nil {
		return "", nil
	}
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	t := field("type")
	if !jsjson.Truthy(t) || jsjson.Truthy(field("preset")) || jsjson.Truthy(field("harness")) || jsjson.Truthy(field("model")) {
		return "", nil
	}
	name := jsjson.ToString(t)
	typ, err := s.spawnType(name)
	if err != nil || ringConfig(typ) == nil {
		return "", nil
	}
	return name, typ
}

// spawnRingType is src/daemon.ts spawnRingType: `spawn_agent type: <ring reviewer type>` is a ring of the type's member
// types, named NAME-1, NAME-2, ..., with a moderator NAME-mod when the type has one, and the type's brief as its topic.
// If the ring can't start, the type's `review.fallback` runs as a single reviewer with the same task and `warning` says
// why; with no fallback the spawn is refused. The fallback is recorded on the ring too (ring:fallback), from the
// spawn-time request.
func (s *Server) spawnRingType(ctx context.Context, c auth.Resolved, w write, typeName string, typ *jsjson.Object) (any, error) {
	body := w.body
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	cfg := ringConfig(typ)
	// The route's own checks come first, as for any spawn: a write with no `by` under auth.humanStrict, and a local
	// caller's spawn on another machine, which this daemon doesn't forward.
	if !jsjson.Truthy(field("by")) && s.strictRefuses("spawn with no by", !w.human && !(w.local && c.Kind == auth.Shared) && c.Kind != auth.Agent) {
		return nil, Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), spawns an agent")
	}
	if m := field("machine"); jsjson.Truthy(m) && claude.JSString(m) != s.cfg.Machine {
		return nil, Errorf(http.StatusNotImplemented, "spawn: machine is not ported to the Go daemon yet")
	}
	name := ""
	if v := field("name"); v != nil {
		name = jsjson.Trim(claude.JSString(v))
	}
	var err error
	if name == "" {
		if name, err = s.freeName(ctx); err != nil {
			return nil, err
		}
	}
	if !nameRe.MatchString(name) {
		return nil, Errorf(http.StatusBadRequest, "name must be lowercase letters, digits, and dashes")
	}
	if _, err := s.db.GetAgent(ctx, name); err == nil {
		return nil, Errorf(http.StatusConflict, "name %s is taken", name)
	} else if !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	// The creator may live on another machine: resolved as a spawn's parent is.
	by := field("by")
	assistant := jsjson.Truthy(by) && s.isAssistant(ctx, claude.JSString(by))
	createdBy, parentName := "", humanBox
	if jsjson.Truthy(by) && !assistant {
		id, n, err := s.spawnParent(ctx, claude.JSString(by))
		if err != nil {
			return nil, err
		}
		createdBy, parentName = id, n
	} else if w.human || assistant {
		createdBy = humanBox
	}
	if createdBy == "" {
		return nil, Errorf(http.StatusForbidden, "a ring needs a creator")
	}
	if err := s.ringsNeedLife(); err != nil {
		return nil, err
	}
	cwd := ""
	if v := field("cwd"); v != nil {
		cwd = claude.JSString(v)
	} else if cwd, err = os.Getwd(); err != nil {
		return nil, err
	}
	vars := briefVars(field("brief_vars"))
	task := ""
	if v := field("prompt"); jsjson.Truthy(v) {
		task = claude.JSString(v)
	}
	for k, v := range map[string]string{"task": task, "name": name, "type": typeName, "parent": parentName, "cwd": cwd, "branch": ""} {
		vars[k] = v
	}
	topic, _ := renderBrief(typ, vars, func() string { return s.typeNextSteps(typeName) })
	if topic == "" {
		return nil, Errorf(http.StatusBadRequest, "%s is a ring: give a prompt, the topic of the review", typeName)
	}

	// The ITSA a ring is spawned for: every member and the moderator join it as participants (S-501).
	entry := func(t jsjson.Value) *jsjson.Object {
		e := jsjson.NewObject("type", t)
		if v := field("itsa"); jsjson.Truthy(v) {
			e.Set("itsa", jsjson.ToString(v))
			e.Set("itsa_participant", true)
		}
		return e
	}
	spec := jsjson.NewObject("name", name, "topic", topic, "cwd", cwd)
	var spawn []jsjson.Value
	if ms, _ := cfg.Get("members"); ms != nil {
		list, _ := ms.([]jsjson.Value)
		for _, t := range list {
			spawn = append(spawn, entry(t))
		}
	}
	spec.Set("spawn", spawn)
	rv, _ := typ.Get("review")
	fbType, _ := at(rv, "fallback")
	if jsjson.Truthy(fbType) {
		spec.Set("fallback", jsjson.NewObject("type", fbType, "body", fallbackBody(body, cwd)))
	}
	in := ring.CreateInput{Name: name, Topic: topic, CreatedBy: createdBy, Format: "rounds"}
	if f, _ := cfg.Get("format"); f != nil {
		in.Format = jsjson.ToString(f)
	}
	if n, _ := cfg.Get("maxRounds"); n != nil {
		in.MaxRounds = int(jsjson.ToNumber(n))
	}
	if mod, _ := cfg.Get("moderator"); jsjson.Truthy(mod) {
		mt, _ := at(mod, "type")
		spec.Set("moderator", entry(mt))
		d, _ := at(mod, "decides")
		in.ModeratorDecides = d == true
	}
	sp, err := jsfmt.Parse([]byte(jsjson.Stringify(spec, "")))
	if err != nil {
		return nil, err
	}
	st := ringStart{s: s, c: c, human: w.human, body: sp, in: in}
	id, err := st.run(ctx)
	if err != nil {
		return s.ringTypeFallback(ctx, c, w, name, typeName, fbType, err)
	}
	return s.ringTypeView(ctx, id, cwd)
}

// fallbackBody is src/daemon.ts fallbackBody: the spawn-time request a fallback reviewer is spawned from, without the
// identity (the ring's creator spawns it) or the name and type (the ring's), and with the ring's cwd.
func fallbackBody(body *jsjson.Object, cwd string) *jsjson.Object {
	out := jsjson.NewObject()
	for _, k := range body.Keys() {
		switch k {
		case "by", "self", "from", "name", "type":
			continue
		}
		v, _ := body.Get(k)
		out.Set(k, jsjson.Clone(v))
	}
	out.Set("cwd", cwd)
	return out
}

// ringTypeFallback is spawnRingType's catch: a ring that didn't start is refused, or replaced by the type's fallback
// reviewer under the ring's name with the same request.
func (s *Server) ringTypeFallback(ctx context.Context, c auth.Resolved, w write, name, typeName string, fb jsjson.Value, cause error) (any, error) {
	why := cause.Error()
	if !jsjson.Truthy(fb) {
		status := http.StatusConflict
		var e *Error
		if errors.As(cause, &e) {
			status = e.Status
		}
		return nil, Errorf(status, "can't start ring %s: %s. %s has no fallback reviewer type.", name, why, typeName)
	}
	body, _ := jsjson.Clone(w.body).(*jsjson.Object)
	body.Set("name", name)
	body.Set("type", jsjson.ToString(fb))
	out, err := s.spawnWrite(ctx, c, write{body: body, human: w.human, local: w.local})
	if err != nil {
		return nil, err
	}
	a := out.(spawnView)
	t := ""
	if a.Type != nil {
		t = *a.Type
	}
	return ringFallbackView{spawnView: a, Warning: fmt.Sprintf("ring %s didn't start (%s), so %s is a single %s reviewer (type %s) with the same task", typeName, why, name, jsjson.ToString(fb), t)}, nil
}

// ringFallbackView is the fallback reviewer's spawn reply with the warning after it: {...a, view, warning}.
type ringFallbackView struct {
	spawnView
	Warning string `json:"warning"`
}

// ringTypeView is spawnRingType's reply: the ring's row, then kind 'ring', the ring's own fields, its members and
// moderator as {id, name, type}, and the absolute cwd.
func (s *Server) ringTypeView(ctx context.Context, id, cwd string) (any, error) {
	row, _, _, err := s.db.RingView(ctx, id)
	if err != nil {
		return nil, err
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range row.Keys {
		out.Set(k, row.Items[i])
	}
	view := func(ref string) (jsfmt.Value, error) {
		a, err := s.db.GetAgent(ctx, ref)
		if err != nil {
			return jsfmt.Value{}, err
		}
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("id", jsfmt.StringValue(a.ID))
		v.Set("name", jsfmt.StringValue(a.Name))
		if a.Type != nil {
			v.Set("type", jsfmt.StringValue(*a.Type))
		} else {
			v.Set("type", jsfmt.NullValue())
		}
		return v, nil
	}
	out.Set("kind", jsfmt.StringValue("ring"))
	inner := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"id", "name", "format", "max_rounds"} {
		v, _ := row.Get(k)
		inner.Set(k, v)
	}
	out.Set("ring", inner)
	members := []jsfmt.Value{}
	if m, err := jsfmt.Parse([]byte(row.Text("members"))); err == nil && m.Kind == jsfmt.Array {
		for _, ref := range m.Items {
			v, err := view(ref.Str)
			if err != nil {
				return nil, err
			}
			members = append(members, v)
		}
	}
	out.Set("members", jsfmt.ArrayValue(members))
	mod := jsfmt.NullValue()
	if ref := row.Text("moderator_id"); ref != "" {
		if mod, err = view(ref); err != nil {
			return nil, err
		}
	}
	out.Set("moderator", mod)
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	out.Set("cwd", jsfmt.StringValue(abs))
	return out, nil
}
