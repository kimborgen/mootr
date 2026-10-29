package lifecycle

import (
	"fmt"
	"strconv"
	"testing"
	"time"

	"stam/internal/db"
)

// The model test of the OpenCode compaction and reconnect (S-4237 PR 4e). Four actors, each asked to act on an agent, are
// crossed with four intruders (the agent moves on) at every boundary of the actor's steps, and each run asserts what the
// binding guarantees: nothing the actor does after the intrusion reaches the agent's successor (no call to the server, no
// claim, pending action, event, mark or prompt), a pending compaction is never lost or run twice, no reservation leaks,
// and a legitimate request on the successor is served afterwards.
//
// A step is a point in the actor's code (turnAt): the intruder acts there. At a step inside the owner's lock (the claim)
// the intruder can only write the row, as a writer outside the owner would, and the transaction's own check must refuse
// the actor; elsewhere the intruder is the whole stop or launch, owner transitions included.

type ocActor struct {
	name string
	// steps are the points the intruder is tried at, "start" being between the caller's reading of the row and the call.
	steps []string
	// claimedAfter is the first step after which the agent is claimed for the compaction.
	claimedAfter string
	pending      bool
	// working seeds the agent in a turn: a request is left pending for its end. busy seeds a compaction that just ran.
	working, busy bool
	run           func(s *stopLive, id string, intrude func()) (sid string)
}

var ocCompactSteps = []string{"request-bound", "request-checked", "compact-bound", "compact-claim", "claimed", "compact", "compacted", "compact-mark", "compact-marked"}

// ocStepIndex orders the steps of a compaction, for "after the claim" and "after the mark".
func ocStepIndex(step string) int {
	order := []string{"start", "pending-gen", "context-forced", "request-bound", "request-checked", "compact-bound", "compact-claim", "claimed", "compact", "compacted", "compact-mark", "compact-marked"}
	for i, s := range order {
		if s == step {
			return i
		}
	}
	return -1
}

type ocIntruder struct {
	name string
	// moves says the agent now runs another launch (the successor), sameSession that it runs the same session.
	moves, sameSession bool
	// ownerOnly is an intrusion that is the owner's alone (no row write): it can't be made inside the owner's lock.
	ownerOnly bool
	// afterBind is an intrusion that only the owner can see (the generation moves, the row does not), so it is one only for
	// an action already bound: not between a caller's reading of the row and its binding.
	afterBind bool
	// beforeClaim is an intrusion that leaves the actor's claim on the row as it was, so it is made only before one.
	beforeClaim bool
	// apply is the intrusion; rowOnly is for a step inside the owner's lock.
	apply func(s *stopLive, id string, n int, rowOnly bool)
}

func ocStamp(n int) string { return fmt.Sprintf("2099-01-01T00:00:%02d.000Z", n) }

// relaunch is a stop followed by a launch that lands: the owner's generations (not at a step inside its lock), and a row
// that runs the session again from a new start, idle in a new period.
func ocRelaunch(session string) func(s *stopLive, id string, n int, rowOnly bool) {
	return func(s *stopLive, id string, n int, rowOnly bool) {
		var gen int
		if !rowOnly {
			s.life.invalidate(id)
			gen = s.life.nextLaunchGen(id)
		}
		fields := []db.Field{{Col: "lifecycle", Val: "active"}, {Col: "resumed_at", Val: ocStamp(n)}, {Col: "activity", Val: "idle"},
			{Col: "activity_detail", Val: "turn finished"}, {Col: "idle_since", Val: ocStamp(n)}}
		if session != "" {
			fields = append(fields, db.Field{Col: "session_id", Val: session})
		}
		s.live.set(id, fields...)
		if !rowOnly {
			s.life.ownerOf(id).settleLaunch(gen, true)
		}
	}
}

var ocIntruders = []ocIntruder{
	{name: "stop", apply: func(s *stopLive, id string, n int, rowOnly bool) {
		if !rowOnly {
			s.life.invalidate(id)
		}
		s.live.set(id, db.Field{Col: "lifecycle", Val: "shut_down"})
	}},
	{name: "newsession", moves: true, apply: ocRelaunch("ses_next")},
	{name: "samesession", moves: true, sameSession: true, apply: ocRelaunch("")},
	// stopping is a stop begun and not written: the generation taken, the row still the old one's.
	{name: "stopping", ownerOnly: true, afterBind: true, apply: func(s *stopLive, id string, n int, rowOnly bool) {
		s.life.invalidate(id)
	}},
	// restart is a new start of the harness in the same session that writes nothing else: the start the row shows moves.
	{name: "restart", beforeClaim: true, moves: true, sameSession: true, apply: func(s *stopLive, id string, n int, rowOnly bool) {
		var gen int
		if !rowOnly {
			s.life.invalidate(id)
			gen = s.life.nextLaunchGen(id)
		}
		s.live.set(id, db.Field{Col: "resumed_at", Val: ocStamp(n)})
		if !rowOnly {
			s.life.ownerOf(id).settleLaunch(gen, true)
		}
	}},
	// launching is a launch begun and not landed: the generation taken, the row still the old one's.
	{name: "launching", ownerOnly: true, apply: func(s *stopLive, id string, n int, rowOnly bool) {
		s.life.invalidate(id)
		s.life.nextLaunchGen(id)
	}},
	{name: "newidle", apply: func(s *stopLive, id string, n int, rowOnly bool) {
		s.live.set(id, db.Field{Col: "idle_since", Val: ocStamp(n)})
	}},
}

// ocSeed makes the agent idle in its session with a start and an idle period of its own.
func ocSeed(s *stopLive, id string) {
	s.live.set(id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "turn finished"},
		db.Field{Col: "resumed_at", Val: ocStamp(1)}, db.Field{Col: "idle_since", Val: ocStamp(1)})
}

const ocPendingText = `{"type":"compact","reason":"test"}`

var ocActors = []ocActor{
	{name: "request", steps: append([]string{"start"}, ocCompactSteps...), claimedAfter: "claimed",
		run: func(s *stopLive, id string, intrude func()) string {
			a := s.agent(id)
			intrude() // "start"
			_, _ = s.life.RequestCompaction(s.ctx, a, "keep", "test")
			return "ses_" + id
		}},
	{name: "requestworking", working: true, steps: []string{"start", "request-bound", "request-checked"}, claimedAfter: "never",
		run: func(s *stopLive, id string, intrude func()) string {
			a := s.agent(id)
			intrude() // "start"
			_, _ = s.life.RequestCompaction(s.ctx, a, "keep", "test")
			return "ses_" + id
		}},
	{name: "forced", steps: append([]string{"context-forced"}, ocCompactSteps...), claimedAfter: "claimed",
		run: func(s *stopLive, id string, intrude func()) string {
			s.live.setSettings(`{"context":{"warnTokens":100,"instructTokens":200,"enforceTokens":300},"retro":{"reminders":{"enabled":false}}}`)
			sid := "ses_" + id
			s.set(func(s *stopLive) { s.messages[sid] = messageOf(1000, 0) })
			s.event(execution("succeeded", sid))
			s.reportsDone()
			s.life.bg.Wait()
			return sid
		}},
	{name: "pendingidle", pending: true, steps: append([]string{"pending-gen"}, ocCompactSteps[2:]...), claimedAfter: "claimed",
		run: func(s *stopLive, id string, intrude func()) string {
			_ = s.life.OnIdle(s.ctx, id)
			return "ses_" + id
		}},
	{name: "pendingevent", pending: true, steps: append([]string{"idle-dispatched"}, ocCompactSteps[2:]...), claimedAfter: "claimed",
		run: func(s *stopLive, id string, intrude func()) string {
			sid := "ses_" + id
			s.live.set(id, db.Field{Col: "activity", Val: "working"})
			s.event(execution("succeeded", sid))
			s.reportsDone()
			s.life.bg.Wait()
			return sid
		}},
	{name: "requestbusy", busy: true, steps: []string{"start", "request-bound"}, claimedAfter: "never",
		run: func(s *stopLive, id string, intrude func()) string {
			a := s.agent(id)
			intrude() // "start"
			_, _ = s.life.RequestCompaction(s.ctx, a, "keep", "test")
			return "ses_" + id
		}},
	{name: "pendingrun", pending: true, steps: append([]string{"start"}, ocCompactSteps[2:]...), claimedAfter: "claimed",
		run: func(s *stopLive, id string, intrude func()) string {
			a := s.agent(id)
			p := pendingOf(a)
			intrude() // "start"
			_, _ = s.life.runPending(s.ctx, a, p)
			return "ses_" + id
		}},
	{name: "reconnect", steps: []string{"start", "reconnect"}, claimedAfter: "never",
		run: func(s *stopLive, id string, intrude func()) string {
			a := s.agent(id)
			intrude() // "start"
			_, _ = s.life.ReconnectMCP(s.ctx, a, false)
			return "ses_" + id
		}},
}

// ocNamed are the races the review rings of #1326 found, by the cell of the model that covers each.
var ocNamed = map[string][3]string{
	"S-4287 post-call guards: the mark and the prompt after the held call":                              {"request", "compacted", "newsession"},
	"S-4287 post-call guards: the cache mark after the held call":                                       {"request", "compact-mark", "stop"},
	"S-4288 the forced compaction rebinding to the successor":                                           {"forced", "context-forced", "newsession"},
	"S-4288 the mark after still":                                                                       {"request", "compact-marked", "samesession"},
	"S-4290 the reconnect rebinding to the current session":                                             {"reconnect", "start", "newsession"},
	"S-4290 the reconnect after a same-session relaunch (ring 6)":                                       {"reconnect", "start", "samesession"},
	"S-4291 the stale OnIdle clearing a pending compaction":                                             {"pendingidle", "pending-gen", "samesession"},
	"the stale take of a pending compaction by a runner of the row it read":                             {"pendingrun", "start", "newsession"},
	"the claim of a successor in the owner's critical section":                                          {"request", "compact-claim", "newsession"},
	"the forced compaction's claim after a relaunch into the same session":                              {"forced", "compact-bound", "samesession"},
	"a pending compaction kept across a relaunch is the new generation's":                               {"pendingidle", "compact-bound", "samesession"},
	"an idle period that moved on leaves the compaction pending, not run":                               {"pendingidle", "compact-bound", "newidle"},
	"a launch begun after the row was read (row-bound, no row write yet)":                               {"request", "start", "launching"},
	"a reconnect while a launch is in flight":                                                           {"reconnect", "start", "launching"},
	"a new start written under the claim by a writer outside the owner":                                 {"request", "compact-claim", "restart"},
	"a request in a turn is left pending only on the row it read":                                       {"requestworking", "request-bound", "newsession"},
	"S-4291/ring 1 the idle callback run after a same-session relaunch took the successor's generation": {"pendingevent", "idle-dispatched", "samesession"},
	"the idle callback run after a launch landed in a new session":                                      {"pendingevent", "idle-dispatched", "newsession"},
	"the claim after a stop begun and not written (generation moved, row not)":                          {"forced", "compact-bound", "stopping"},
	"a stale request that ends at the busy check records no dropped event":                              {"requestbusy", "request-bound", "samesession"},
	"a stale request for a stopped agent":                                                               {"request", "start", "stop"},
	"the reconnect's call after a stop between the check and the call":                                  {"reconnect", "reconnect", "stop"},
}

// ocCounts is what the server and the agent's events had seen at some moment.
type ocCounts struct {
	compacts, connects, prompts int
	events                      map[string]int
}

func ocCountsOf(s *stopLive, id string) ocCounts {
	c := ocCounts{compacts: len(s.compactsOf()), connects: len(s.connectsOf()), prompts: len(s.promptsOf()), events: map[string]int{}}
	for _, typ := range []string{"pending", "cache:mark", "compaction:measured", "compact:dropped"} {
		c.events[typ] = s.countEvents(id, typ)
	}
	return c
}

// ocReached is the cells whose step the actor reached, so the intrusion was made.
var ocReached = map[[3]string]bool{}

func TestOpenCodeModel(t *testing.T) {
	covered := map[[3]string]bool{}
	total := 0
	clear(ocReached)
	for _, actor := range ocActors {
		for _, step := range actor.steps {
			for _, in := range ocIntruders {
				if (in.afterBind && step == "start") || (in.ownerOnly && step == "compact-claim") || (in.beforeClaim && ocStepIndex(step) > ocStepIndex("compact-claim")) {
					continue
				}
				covered[[3]string{actor.name, step, in.name}] = true
				total++
				t.Run(actor.name+"/"+step+"/"+in.name, func(t *testing.T) { ocRunCase(t, actor, step, in) })
			}
		}
	}
	var unreached []string
	for cell, ok := range ocReached {
		if !ok {
			unreached = append(unreached, fmt.Sprint(cell))
		}
	}
	t.Logf("%d cells, %d reached, unreached: %v", len(ocReached), len(ocReached)-len(unreached), unreached)
	if len(ocReached) < total {
		// A run of some cells (-run): the whole model's checks are for the whole.
		return
	}
	for name, cell := range ocNamed {
		if !covered[cell] {
			t.Errorf("%s: the cell %v isn't in the model", name, cell)
		} else if !ocReached[cell] {
			t.Errorf("%s: the actor never reached the step of %v", name, cell)
		}
	}
}

func ocRunCase(t *testing.T, actor ocActor, step string, in ocIntruder) {
	id := "atm1"
	s, _ := newJobLive(t, id)
	// No actor here pushes mail; a push timer that fired during the bg.Wait below would add to it as it runs.
	quietPushes(s)
	ocSeed(s, id)
	if actor.pending {
		s.live.set(id, db.Field{Col: "pending_action", Val: ocPendingText})
	}
	o := s.life.ownerOf(id)
	if actor.busy {
		o.mu.Lock()
		o.comp = &ocComp{b: &turnBind{sid: "ses_" + id}, at: time.Now()}
		o.mu.Unlock()
	}
	if actor.working {
		s.live.set(id, db.Field{Col: "activity", Val: "working"}, db.Field{Col: "activity_detail", Val: nil}, db.Field{Col: "idle_since", Val: nil})
	}
	var before ocCounts
	fired := false
	n := 2
	intrude := func() {
		if fired {
			return
		}
		fired = true
		before = ocCountsOf(s, id)
		in.apply(s, id, n, step == "compact-claim")
	}
	if step == "start" {
		// Between the caller's reading of the row and the call: the actor's run applies it.
	} else {
		s.life.turnStep = func(aid, at string) {
			if at == step && aid == id {
				intrude()
			}
		}
	}
	runIntrude := intrude
	if step != "start" {
		runIntrude = func() {}
	}
	sid := actor.run(s, id, runIntrude)
	s.life.bg.Wait()
	s.life.turnStep = nil
	ocReached[[3]string{actor.name, step, in.name}] = fired
	if !fired {
		// The step is never reached on this path (the actor stopped before it): the control, nothing to assert beyond
		// what the actor did on its own.
		return
	}
	if (actor.name == "pendingidle" && step == "pending-gen" || actor.name == "pendingevent" && step == "idle-dispatched") && in.name == "newidle" {
		// OnIdle reads the row after this step: it reads the new idle period, which is no stale row.
		return
	}
	after := ocCountsOf(s, id)
	row := s.agent(id)
	claimed := ocStepIndex(step) >= ocStepIndex(actor.claimedAfter) && actor.claimedAfter != "never"

	// 1. Nothing the actor does after the intrusion reaches the server or the successor (the idle period moving on is no
	// move: the actor's session still runs, and what it did before the claim it does not do after).
	if in.name != "newidle" {
		if after.compacts != before.compacts || after.connects != before.connects || after.prompts != before.prompts {
			t.Errorf("a call reached the server after the %s: compacts %d→%d connects %d→%d prompts %d→%d", in.name,
				before.compacts, after.compacts, before.connects, after.connects, before.prompts, after.prompts)
		}
	}
	if in.name == "newidle" && !claimed {
		if after.compacts != 0 {
			t.Errorf("compacted in an idle period that had moved on: %d calls", after.compacts)
		}
	}
	if after.compacts > 1 {
		t.Errorf("%d compact calls: double-applied", after.compacts)
	}
	for _, typ := range []string{"pending", "cache:mark", "compaction:measured", "compact:dropped"} {
		if in.name != "newidle" && after.events[typ] != before.events[typ] {
			t.Errorf("%d %s events were recorded after the %s", after.events[typ]-before.events[typ], typ, in.name)
		}
	}
	// 2. The successor's row is its own: not claimed for the actor, no pending action of the actor's, no restore over it.
	if in.moves || (in.name == "stop" && !claimed) {
		if d := deref(row.ActivityDetail); d == "compacting: test" || d == "compacting: enforcement threshold" || d == "compaction not done" {
			t.Errorf("the successor was given the actor's state: %s/%q", row.Activity, d)
		}
		if !actor.pending && row.PendingAction != nil {
			t.Errorf("the successor was given a pending action: %s", deref(row.PendingAction))
		}
	}
	// 3. A pending compaction is the agent's until a claim ran it: left on the row by an actor that did not claim, and gone
	// once one did, never both run and kept.
	if actor.pending {
		switch {
		case !claimed && row.PendingAction == nil:
			t.Errorf("the pending compaction was lost (step %s, %s)", step, in.name)
		case claimed && after.compacts > 0 && row.PendingAction != nil:
			t.Errorf("the pending compaction ran and is still pending")
		}
	} else if (actor.name == "request" || actor.name == "forced") && in.name == "newidle" && !claimed && row.PendingAction == nil && after.compacts == 0 {
		t.Errorf("a request that found the agent's idle period moved on was dropped, not left pending")
	}
	// 4. No reservation leaks and no stale mark: the slot is free or done, and a mark never belongs to a session the
	// actor didn't mark.
	o.mu.Lock()
	running := o.comp != nil && o.comp.running
	mark := o.mark
	o.mu.Unlock()
	if running {
		t.Errorf("the compaction's reservation is still running")
	}
	if mark != nil && (in.moves || in.name == "stop") && ocStepIndex(step) < ocStepIndex("compact-marked") && actor.name != "reconnect" {
		t.Errorf("a post-compaction mark was set for %s after the %s", mark.sid, in.name)
	}
	_ = sid

	// 5. Liveness: a legitimate request on the successor is served, once. (A stopped agent has no successor; the same
	// session within the dedupe window of a compaction that ran is dropped as TS drops it.)
	if actor.name == "reconnect" || !in.moves {
		return
	}
	succ := s.agent(id)
	c0 := len(s.compactsOf())
	if _, err := s.life.RequestCompaction(s.ctx, succ, "keep", "test"); err != nil {
		t.Fatalf("the successor's own request: %v", err)
	}
	served := len(s.compactsOf()) - c0
	ranBefore := (after.compacts > 0 || actor.busy) && in.sameSession
	switch {
	case ranBefore && served != 0:
		t.Errorf("the dedupe window did not hold in the same session: %d calls", served)
	case !ranBefore && actor.working && in.name == "restart":
		// Still in its turn: the request is left pending for its end.
		if served != 0 || s.agent(id).PendingAction == nil {
			t.Errorf("the successor's own request in its turn: %d calls, pending %v", served, deref(s.agent(id).PendingAction))
		}
	case !ranBefore && served != 1:
		t.Errorf("the successor's own request made %d compact calls, want 1", served)
	}
	if served == 1 {
		if got := s.compactsOf(); got[len(got)-1] != deref(succ.SessionID) {
			t.Errorf("compacted %v, the successor runs %s", got, deref(succ.SessionID))
		}
	}
	_ = strconv.Itoa
}
