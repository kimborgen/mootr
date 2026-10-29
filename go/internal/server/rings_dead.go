package server

import (
	"context"
	"fmt"
	"log/slog"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/ring"
)

// A ring member that never started (src/daemon.ts fallbackAllowed, ringMemberFailed; S-3070, S-3862): the ring is decided
// at once, as incomplete or on its type's fallback reviewer, and a restart's sweep finishes what a crash between the two
// steps left.

// fallbackAllowed is src/daemon.ts fallbackAllowed: a ring's fallback reviewer may stand in for the members that never
// started only when it is none of their types and runs on none of their harnesses, which would likely fail the same way.
func (s *Server) fallbackAllowed(fb ring.Fallback, dead []ring.Dead) bool {
	if len(dead) == 0 {
		return false
	}
	typ, err := s.spawnType(fb.Type)
	if err != nil {
		return false
	}
	h := ""
	if v, _ := typ.Get("harness"); v != nil {
		h = jsjson.ToString(v)
	}
	for _, d := range dead {
		if d.Type == fb.Type || (h != "" && h == d.Harness) {
			return false
		}
	}
	return true
}

// ringMemberDead is the lifecycle's SetStartingDead hook: the agent is dropped from its open rings, which are decided now,
// and a ring that fell back runs its single reviewer in the daemon's background work.
func (s *Server) ringMemberDead(ctx context.Context, a db.Agent) {
	failures, effects, err := s.ringEngine().MemberFailed(ctx, s.db, a.ID, s.fallbackAllowed)
	if err != nil {
		slog.Error("ring: couldn't drop an agent that never started", "agent", a.ID)
		return
	}
	s.ringEffects(ctx, effects)
	s.ringsFellBack(ctx, failures)
}

// ringsFellBack is src/daemon.ts ringMemberFailed, off the caller: for each ring that ended on its fallback, its other
// members and moderator are retired and the type's single reviewer runs in the ring's place, under the ring's name and
// from the spawn-time request, as the ring's creator. The creator is told either way.
func (s *Server) ringsFellBack(ctx context.Context, failures []ring.MemberFailure) {
	var fell []ring.MemberFailure
	for _, f := range failures {
		if f.Fallback != nil {
			fell = append(fell, f)
		}
	}
	if len(fell) == 0 {
		return
	}
	s.background(ctx, func(ctx context.Context) {
		for _, f := range fell {
			s.ringFallback(ctx, f)
		}
	})
}

func (s *Server) ringFallback(ctx context.Context, f ring.MemberFailure) {
	var others []db.Agent
	for _, id := range f.Others {
		if a, err := s.db.GetAgent(ctx, id); err == nil && a.Lifecycle != "archived" {
			others = append(others, a)
		}
	}
	s.discardAgents(ctx, others)
	r := f.Ring
	human := r.CreatedBy == humanBox
	// {...fallback.body, name, type, by}: the request's own fields, then the ring's name and the fallback's type.
	body := jsjson.NewObject()
	if v, err := jsjson.Parse([]byte(jsfmt.Compact(f.Fallback.Body))); err == nil {
		if o, ok := v.(*jsjson.Object); ok {
			body = o
		}
	}
	body.Set("name", r.Name)
	body.Set("type", f.Fallback.Type)
	if !human {
		body.Set("by", r.CreatedBy)
	}
	out, err := s.spawnWrite(ctx, auth.Resolved{Caller: auth.Caller{Kind: auth.None}}, write{body: body, human: human})
	text := ""
	if err != nil {
		text = fmt.Sprintf("Ring %s lost its members that never started, and its fallback %s didn't start either: %s", r.Name, f.Fallback.Type, err.Error())
	} else {
		text = fmt.Sprintf("Ring %s lost its members that never started, so %s is a single %s reviewer with the same task.", r.Name, out.(spawnView).Name, f.Fallback.Type)
	}
	// TS queues the notice for the human too, where no agent reads it; here only an agent creator is told.
	if !human {
		s.life.QueueNotice(ctx, r.CreatedBy, text, false)
	}
}

// sweepRings is src/daemon.ts's restart sweep (S-3070): a member marked never started whose ring the restart left untold is
// dropped, before the open seats are prompted, so the sweep prompts nobody itself.
func (s *Server) sweepRings(ctx context.Context) error {
	failures, effects, err := s.ringEngine().SweepDeadMembers(ctx, s.db, s.fallbackAllowed)
	if err != nil {
		return err
	}
	s.ringEffects(ctx, effects)
	s.ringsFellBack(ctx, failures)
	return nil
}
