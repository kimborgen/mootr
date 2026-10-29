package lifecycle

import (
	"errors"
	"strings"
	"testing"

	"stam/internal/adapters/opencode"
	"stam/internal/jsjson"
)

// The model test of the connect sweep (S-4280): the sweep, at each place it or its raiser reads the agent's session or
// generation, crossed with what can happen to the agent or to the ask there. The reads, in order:
//   - "sweep-start": just before bindSweep (session, generation, askSeq, the launch in flight: one step under owner.mu),
//   - the listing (no lock),
//   - "sweep-listed": just before queueSweep (generation, session and askSeq read again under owner.mu),
//   - "raise": the raiser's beginRaise,
//   - "listing": its own listing (no lock),
//   - "listed": just before mayShow,
//   - "shown": just before shown, the ask on the dialog.
// At each, one of: the agent moves on (stop, a new session, the same session resumed, a stop begun, a launch in flight), the
// ask is answered (typed through stam, replied to outside stam, found gone), or a newer ask comes from an event. Each run
// asserts the invariants of the ask: an ask is on the dialog at the end only when the agent still runs the session it
// is for, under the generation it was raised under, and nothing newer or answered was replaced or reopened.

var sweepSteps = []string{"sweep-start", "sweep-listed", "raise", "listing", "listed", "shown"}

type sweepCase struct {
	name string
	// apply is the intrusion, made once at the step.
	apply func(s *stopLive, id, sid string)
	// want is what the dialog holds at the end for the step: "per_1" (the sweep's ask), "per_2" (the event's ask), or "" (none).
	want func(step string) string
}

func sweepCases(strict bool) []sweepCase {
	var cases []sweepCase
	// The agent moves on. Before the sweep binds it, the sweep finds the agent as it is; after, it is stale.
	for _, in := range ocIntruders {
		switch in.name {
		case "stop", "newsession", "samesession", "stopping", "launching":
		default:
			continue
		}
		in := in
		cases = append(cases, sweepCase{
			name:  in.name,
			apply: func(s *stopLive, id, sid string) { in.apply(s, id, 2, false) },
			want: func(step string) string {
				// The raiser's own read of the generation is at its start ("raise"), as an event's ask raise has: what
				// happened before it is the agent as the raise finds it, the same session being the ask's.
				switch {
				case step == "sweep-start" && (in.name == "samesession" || in.name == "stopping"):
					return "per_1"
				case step == "raise" && (in.name == "samesession" || in.name == "stopping" || in.name == "launching"):
					return "per_1"
				}
				return ""
			},
		})
	}
	none := func(string) string { return "" }
	cases = append(cases,
		sweepCase{name: "outside", want: none, apply: func(s *stopLive, id, sid string) { s.life.onOpenCodeEvent(s.ctx, ocEvent(replied(sid, "per_1"))) }},
		sweepCase{name: "typed", want: none, apply: func(s *stopLive, id, sid string) {
			if out := s.life.AnswerDialog(s.ctx, s.agent(id), askDetails(sid, "per_1"), true, ""); strict && out != "typed" {
				s.t.Errorf("answer %s", out)
			}
		}},
		sweepCase{name: "gone", want: none, apply: func(s *stopLive, id, sid string) {
			s.pend(sid)
			if out := s.life.AnswerDialog(s.ctx, s.agent(id), askDetails(sid, "per_1"), true, ""); strict && out != "gone" {
				s.t.Errorf("answer %s", out)
			}
		}},
		// replay is a permission answered outside stam before any ask for it was raised, whose permission.asked is told of
		// again: not a newer ask, so the sweep's ask stands.
		sweepCase{name: "replay", want: func(string) string { return "per_1" }, apply: func(s *stopLive, id, sid string) {
			s.life.onOpenCodeEvent(s.ctx, ocEvent(replied(sid, "per_z")))
			s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_z")))
		}},
		// dup is the event of the swept ask's own permission, told while it is being raised.
		sweepCase{name: "dup", want: func(string) string { return "per_1" }, apply: func(s *stopLive, id, sid string) {
			s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_1")))
		}},
		sweepCase{name: "newer", want: func(string) string { return "per_2" }, apply: func(s *stopLive, id, sid string) {
			s.pend(sid, "per_1", "per_2")
			s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_2")))
		}},
	)
	return cases
}

// ocEvent parses one event of the server's stream.
func ocEvent(text string) opencode.Event {
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		panic(err)
	}
	o := v.(*jsjson.Object)
	typ, _ := o.Get("type")
	data, _ := o.Get("data")
	return opencode.Event{Type: typ.(string), Data: data.(*jsjson.Object), Raw: v}
}

func TestOpenCodeSweepModel(t *testing.T) {
	for _, step := range sweepSteps {
		for _, c := range sweepCases(true) {
			t.Run(step+"/"+c.name, func(t *testing.T) {
				id := "asm1"
				sid := "ses_" + id
				s, fd := newAskLive(t, id, "per_1")
				ocSeed(s, id)
				fired := false
				s.life.askStep = func(aid, at string) {
					if at == step && aid == id && !fired {
						fired = true
						c.apply(s, id, sid)
					}
				}
				s.sweep()
				s.life.askStep = nil
				if !fired {
					t.Fatalf("the sweep never reached %s", step)
				}
				s.raised()
				got, _ := fd.state()
				want := c.want(step)
				if want == "" {
					if got != "" {
						t.Errorf("the dialog holds %s after the intrusion, want none", got)
					}
					return
				}
				// The newer ask is the dialog's alone, the swept (older) per_1 never replaces it.
				if !strings.Contains(got, `"permission":"`+want+`"`) {
					t.Errorf("the dialog holds %q, want %s", got, want)
				}
			})
		}
	}
}

// Two intrusions in one run, both at the same step, one after the other (a pair of the cases that leave the agent as it is):
// the dialog holds at most one of the listed asks, never the swept per_1 once it was answered or a newer ask came, and the
// sweep's ask stands when the only intrusions were replays.
func TestOpenCodeSweepModelPairs(t *testing.T) {
	var pool []sweepCase
	for _, c := range sweepCases(false) {
		switch c.name {
		case "samesession", "stopping", "outside", "typed", "gone", "replay", "newer", "dup":
			pool = append(pool, c)
		}
	}
	for _, step := range sweepSteps {
		for _, a := range pool {
			for _, b := range pool {
				t.Run(step+"/"+a.name+"+"+b.name, func(t *testing.T) {
					id := "asm2"
					sid := "ses_" + id
					s, fd := newAskLive(t, id, "per_1")
					ocSeed(s, id)
					fired := false
					s.life.askStep = func(aid, at string) {
						if at == step && aid == id && !fired {
							fired = true
							a.apply(s, id, sid)
							b.apply(s, id, sid)
						}
					}
					s.sweep()
					s.life.askStep = nil
					if !fired {
						t.Fatalf("the sweep never reached %s", step)
					}
					s.raised()
					got, _ := fd.state()
					answered := map[string]bool{"outside": true, "typed": true, "gone": true}
					// Before the sweep's ask is in the raiser, the event of its permission is the first event for it: a fresh ask of its own.
					eventFirst := (a.name == "dup" || b.name == "dup") && (step == "sweep-start" || step == "sweep-listed")
					if !eventFirst && (answered[a.name] || answered[b.name] || a.name == "newer" || b.name == "newer") && strings.Contains(got, `"permission":"per_1"`) {
						t.Errorf("the dialog holds the swept ask after it was answered or a newer one came: %s", got)
					}
					if a.name == "replay" && b.name == "replay" && !strings.Contains(got, `"permission":"per_1"`) {
						t.Errorf("the sweep's ask did not survive its replays: %q", got)
					}
					// Only moves that leave the agent as it is, and the same permission told again: the ask survives them.
					keeps := map[string]bool{"samesession": true, "stopping": true, "dup": true, "replay": true}
					if keeps[a.name] && keeps[b.name] && (a.name == "dup" || b.name == "dup") && !strings.Contains(got, `"permission":"per_1"`) {
						t.Errorf("the sweep's ask did not survive %s + %s: %q", a.name, b.name, got)
					}
					if strings.Contains(got, "per_z") {
						t.Errorf("the dialog holds the replayed permission: %s", got)
					}
				})
			}
		}
	}
}

// A duplicate of an event's ask, told while the sweep's ask is in its listing after a newer event: the newer one alone is the
// dialog's; the duplicate is not queued as a fresh raise that would replace it.
func TestOpenCodeSweepDuplicateEventAfterANewerOne(t *testing.T) {
	for _, step := range []string{"listing", "listed"} {
		t.Run(step, func(t *testing.T) {
			id := "asm3"
			sid := "ses_" + id
			s, fd := newAskLive(t, id, "per_1")
			fired := false
			s.life.askStep = func(aid, at string) {
				if at == step && aid == id && !fired {
					fired = true
					s.pend(sid, "per_1", "per_2")
					s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_2")))
					s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_1")))
				}
			}
			s.sweep()
			s.life.askStep = nil
			if !fired {
				t.Fatalf("the sweep never reached %s", step)
			}
			s.raised()
			got, _ := fd.state()
			if !strings.Contains(got, `"permission":"per_2"`) {
				t.Errorf("the dialog holds %q, want per_2 alone", got)
			}
		})
	}
}

// A same-session relaunch moves the generation under the sweep's raise, and the event of its own permission is told while that
// raise is in flight (at its listing, after it, and with the ask shown): the raise ends stale, and the event, which coalesced
// into it, is queued once more: the pending ask survives.
func TestOpenCodeSweepSameSessionAndItsEvent(t *testing.T) {
	var resume sweepCase
	for _, c := range sweepCases(true) {
		if c.name == "samesession" {
			resume = c
		}
	}
	for _, step := range []string{"listing", "listed", "shown"} {
		t.Run(step, func(t *testing.T) {
			id := "asm4"
			sid := "ses_" + id
			s, fd := newAskLive(t, id, "per_1")
			ocSeed(s, id)
			fired := false
			s.life.askStep = func(aid, at string) {
				if at == step && aid == id && !fired {
					fired = true
					resume.apply(s, id, sid)
					s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_1")))
				}
			}
			s.sweep()
			s.life.askStep = nil
			if !fired {
				t.Fatalf("the sweep never reached %s", step)
			}
			s.raised()
			if got, _ := fd.state(); !strings.Contains(got, `"permission":"per_1"`) {
				t.Errorf("the pending ask was lost: %q", got)
			}
		})
	}
}

// A raise that fails (the dialog can't be shown) while the event of its permission is told: the event is tried once more.
func TestOpenCodeRaiseFailsWhileItsEventComes(t *testing.T) {
	id := "asm5"
	sid := "ses_" + id
	s, fd := newAskLive(t, id, "per_1")
	raises := 0
	s.life.askStep = func(aid, at string) {
		if aid != id {
			return
		}
		switch at {
		case "raise":
			raises++
			if raises == 2 {
				fd.mu.Lock()
				fd.fail = nil
				fd.mu.Unlock()
			}
		case "listed":
			if raises == 1 {
				fd.mu.Lock()
				fd.fail = errors.New("dialog write failed")
				fd.mu.Unlock()
				s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_1")))
			}
		}
	}
	s.event(asked(sid, "per_1"))
	s.life.askStep = nil
	if got, _ := fd.state(); !strings.Contains(got, `"permission":"per_1"`) {
		t.Errorf("the pending ask was lost: %q (raises %d)", got, raises)
	}
}

// The event of a permission already on the dialog, told again while a sweep's ask for another is in flight, is not a newer ask:
// the swept ask stands (it is not counted by askSeq).
func TestOpenCodeSweepSurvivesARepeatOfAnAskedEvent(t *testing.T) {
	id := "asm6"
	sid := "ses_" + id
	s, fd := newAskLive(t, id, "per_1")
	s.event(asked(sid, "per_1"))
	if got, _ := fd.state(); !strings.Contains(got, `"permission":"per_1"`) {
		t.Fatalf("the first ask was not raised: %q", got)
	}
	// per_1 left the listing unseen (replied in the TUI while the stream was down); per_2 is pending.
	s.pend(sid, "per_2")
	fired := false
	s.life.askStep = func(aid, at string) {
		if at == "listing" && aid == id && !fired {
			fired = true
			s.life.onOpenCodeEvent(s.ctx, ocEvent(asked(sid, "per_1")))
		}
	}
	s.sweep()
	s.life.askStep = nil
	if !fired {
		t.Fatal("the sweep never reached listing")
	}
	if got, _ := fd.state(); !strings.Contains(got, `"permission":"per_2"`) {
		t.Errorf("the swept ask was dropped by a repeat of an asked event: %q", got)
	}
}
