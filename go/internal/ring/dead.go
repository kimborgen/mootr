package ring

import (
	"context"
	"encoding/json"

	"stam/internal/db"
	"stam/internal/jsfmt"
)

// A ring member (or its moderator) that never started (src/ring.ts memberFailed, sweepDeadMembers; S-3070, S-3862).

// Fallback is what a ring spawned from a reviewer type needs to run its type's single reviewer later: the type and the spawn-time
// request, recorded as a ring:fallback event when the ring started.
type Fallback struct {
	Type string
	Body jsfmt.Value
}

// Dead is an agent a ring dropped as never started, as a fallback is judged against it.
type Dead struct {
	ID, Type, Harness string
}

// MemberFailure is one ring a dropped member decided. Fallback is set when the ring ended on its type's fallback: the caller runs
// the single reviewer in its place and retires Others, the ring's other members and moderator.
type MemberFailure struct {
	Ring     Ring
	Fallback *Fallback
	Others   []string
}

// CanFallback is whether a recorded fallback may stand in for the dead agents (src/daemon.ts fallbackAllowed).
type CanFallback func(fb Fallback, dead []Dead) bool

const neverStarted = "never started: no harness process"

func (s *session) fallbackOf(r Ring) (*Fallback, error) {
	v, ok, err := s.tx.RingFallback(r.ID)
	if err != nil || !ok {
		return nil, err
	}
	body, _ := v.Get("body")
	return &Fallback{Type: v.Text("type"), Body: body}, nil
}

// droppedOf is every agent the ring dropped as never started, the current one included: a fallback must differ from all of them,
// not only the last to die.
func (s *session) droppedOf(r Ring) ([]Dead, error) {
	found, err := s.tx.RingDropped(r.ID)
	out := make([]Dead, len(found))
	for i, v := range found {
		out[i] = Dead{ID: v.Text("id"), Type: v.Text("type"), Harness: v.Text("harness")}
	}
	return out, err
}

func ringData(id string, extra ...string) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("ring", jsfmt.StringValue(id))
	for i := 0; i+1 < len(extra); i += 2 {
		v.Set(extra[i], jsfmt.StringValue(extra[i+1]))
	}
	return v
}

// seatDead is whether the agent's seat in the ring is still one that never started, read in the ring's own transaction: the
// agent exists, isn't active and wasn't taken over, and its starting:dead is later than its join of the ring (and no older than
// the ring, for a moderator, which has no join), with no resume since. The live hook and the restart sweep both decide on it:
// in Go the death and the ring's transaction are separate commits, and a resume or takeover between them keeps the seat.
func (s *session) seatDead(agentID string, r Ring) (bool, error) {
	_, _, fwd, life, ok, err := s.tx.Agent(agentID)
	if err != nil || !ok || life == "active" || fwd != "" {
		return false, err
	}
	return s.tx.DiedInRing(agentID, r.ID, r.CreatedAt)
}

// memberFailed is src/ring.ts memberFailed. A ring decides only on verdicts from every member it was created with, so a running
// ring that loses a member can't go on with the rest: it ends now, on its type's fallback when can allows it, else as incomplete,
// naming the missing member, with no verdict line. A dropped member is no longer a member, and a ring that is done takes no
// submission. The moderator's loss alone leaves the members' round to decide, as in an unmoderated ring. A ring that no longer
// lists the agent, or whose seat seatDead doesn't find dead, is skipped, so it is idempotent.
func (s *session) memberFailed(agentID, why string, can CanFallback) ([]MemberFailure, error) {
	open, err := s.tx.OpenRings()
	if err != nil {
		return nil, err
	}
	var out []MemberFailure
	for _, v := range open {
		r := ringOf(v)
		i := -1
		for j, m := range r.Members {
			if m == agentID {
				i = j
			}
		}
		if i < 0 && r.ModeratorID != agentID {
			continue
		}
		if dead, err := s.seatDead(agentID, r); err != nil {
			return nil, err
		} else if !dead {
			continue
		}
		name := s.name(agentID)
		if err := s.tx.AgentEvent(agentID, "ring:dropped", ringData(r.ID, "why", why)); err != nil {
			return nil, err
		}
		if i < 0 {
			if r, err = s.update(r, db.RingField{Name: "moderator_id", Value: nil}); err != nil {
				return nil, err
			}
			if r.Status == "moderating" {
				if r, err = s.update(r, db.RingField{Name: "status", Value: "running"}); err != nil {
					return nil, err
				}
				if err := s.roundComplete(r); err != nil {
					return nil, err
				}
			}
			continue
		}
		if err := s.tx.AgentEvent(agentID, "ring:missing", ringData(r.ID)); err != nil {
			return nil, err
		}
		rest := make([]string, 0, len(r.Members))
		for _, m := range r.Members {
			if m != agentID {
				rest = append(rest, m)
			}
		}
		list, _ := json.Marshal(rest)
		if r, err = s.update(r, db.RingField{Name: "members", Value: string(list)}); err != nil {
			return nil, err
		}
		reason := name + " never started (" + why + ")"
		fb, err := s.fallbackOf(r)
		if err != nil {
			return nil, err
		}
		allowed := false
		if fb != nil && can != nil {
			dead, err := s.droppedOf(r)
			if err != nil {
				return nil, err
			}
			allowed = can(*fb, dead)
		}
		if allowed {
			done, err := s.update(r, db.RingField{Name: "status", Value: "done"}, db.RingField{Name: "result", Value: reason + ", so it fell back to a single " + fb.Type + " reviewer"})
			if err != nil {
				return nil, err
			}
			others := append([]string{}, rest...)
			if r.ModeratorID != "" {
				others = append(others, r.ModeratorID)
			}
			out = append(out, MemberFailure{Ring: done, Fallback: fb, Others: others})
			continue
		}
		if err := s.finish(r, reason+", so the ring is incomplete", nil); err != nil {
			return nil, err
		}
		done, _, err := s.get(r.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, MemberFailure{Ring: done})
	}
	return out, nil
}

// MemberFailed is memberFailed in one transaction: an agent just marked never started is dropped from every open ring it is in.
func (e Engine) MemberFailed(ctx context.Context, d *db.DB, agentID string, can CanFallback) ([]MemberFailure, []Effect, error) {
	var out []MemberFailure
	_, effects, err := e.run(ctx, d, func(s *session) (string, error) {
		var err error
		out, err = s.memberFailed(agentID, neverStarted, can)
		return "", err
	})
	return out, effects, err
}

// SweepDeadMembers is src/ring.ts sweepDeadMembers, for a daemon restart: a member marked never started whose ring was not told,
// because the restart came between the two steps. Only a starting:dead later than the member's join of that ring counts (and none
// from before the ring, for a moderator, which has no join), with no resume since. It prompts nobody: it runs just before
// PromptOpenSeats, which prompts every open seat.
func (e Engine) SweepDeadMembers(ctx context.Context, d *db.DB, can CanFallback) ([]MemberFailure, []Effect, error) {
	var out []MemberFailure
	_, effects, err := e.run(ctx, d, func(s *session) (string, error) {
		s.quiet = true
		open, err := s.tx.OpenRings()
		if err != nil {
			return "", err
		}
		for _, v := range open {
			r := ringOf(v)
			seats := append([]string{}, r.Members...)
			if r.ModeratorID != "" {
				seats = append(seats, r.ModeratorID)
			}
			for _, id := range seats {
				// memberFailed gates each ring's seat on seatDead.
				found, err := s.memberFailed(id, neverStarted, can)
				if err != nil {
					return "", err
				}
				out = append(out, found...)
			}
		}
		return "", nil
	})
	return out, effects, err
}
