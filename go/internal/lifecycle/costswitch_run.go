package lifecycle

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The switch around the move (src/cost-switch.ts, S-2848 B5e2): check, quiesce, stop, move, launch, tell, and the
// rollback when anything after the stop fails; resumeSwitches re-arms a switch a restart cut short in its soft stop, and
// startSwitch is POST /api/cost/switch's. Only Claude Code launches here: a preset on another harness is refused, and
// the cost fallback's take-over (toType, the "stam" requester and its stillWanted re-check) isn't ported (S-3687). Spawn
// admission isn't either (S-3545): the successor gets the rule, budget and pause blockers a Go spawn gets, so a switch
// onto a blocked account starts it held where TS refuses the switch.

// takenOver is src/cost-switch.ts TAKEN_OVER, the blocker a switched predecessor keeps.
const takenOver = "taken-over"

// switchStartup is the successor's startupMs default: three minutes to start and take its takeover prompt.
const switchStartup = 180 * time.Second

// SwitchOptions is src/cost-switch.ts SwitchOptions, less the fallback's toType and stillWanted.
type SwitchOptions struct {
	// Agent is the agent whose work moves, an id or a name; Preset the registry preset it moves to; By the manager, an
	// agent id or "human".
	Agent, Preset, By string
	// Remote is the manager when it runs on another machine (S-923): By is its id, which this daemon has no row for.
	Remote *RemoteManager
	// SoftStopMinutes overrides settings.cost.softStopMinutes when set.
	SoftStopMinutes *float64
	// Poll is how often the quiesce looks for the turn's end (a second when 0); Startup how long the successor gets to
	// start (switchStartup when 0). Tests shorten both.
	Poll, Startup time.Duration
}

// SwitchPlan is src/cost-switch.ts SwitchPlan: what the check admitted.
type SwitchPlan struct {
	Agent     db.Agent
	Preset    string
	To        switchTo
	By        string
	Successor string
}

// SwitchResult is src/cost-switch.ts SwitchResult, in its JSON order.
type SwitchResult struct {
	From        string      `json:"from"`
	To          string      `json:"to"`
	Preset      string      `json:"preset"`
	Waited      bool        `json:"waited"`
	Interrupted bool        `json:"interrupted"`
	Handover    *string     `json:"handover"`
	Moved       SwitchMoved `json:"moved"`
	Acked       []string    `json:"acked"`
}

// SwitchMoved is SwitchResult's moved: the children's names and how many threads, unread mail and ITSAs moved.
type SwitchMoved struct {
	Children []string `json:"children"`
	Threads  int      `json:"threads"`
	Unread   int      `json:"unread"`
	Itsas    int      `json:"itsas"`
}

// Quiescing is startSwitch's answer for a working agent, whose switch goes on in the background.
type Quiescing struct {
	Status  string  `json:"status"`
	From    string  `json:"from"`
	To      string  `json:"to"`
	Preset  string  `json:"preset"`
	Minutes float64 `json:"minutes"`
}

// busy is src/cost-switch.ts busy: a turn runs, or the harness is still starting.
func busy(a db.Agent) bool { return a.Activity == "working" || a.Activity == "starting" }

// switchStep runs the test's hook at a step of a switch, nil outside tests: a test stops the switch there, as a crash
// would, or races another change against it.
func (l *Lifecycle) switchStep(id, step string) {
	l.mu.Lock()
	fn := l.switchAt
	l.mu.Unlock()
	if fn != nil {
		fn(id, step)
	}
}

// SetSwitchedItsas sets what asks the ITSA home to move a switched agent's open ITSAs to its successor (src/itsa-owners.ts
// handOffSwitchedItsas): the server, which does nothing on the home itself. Soft: it never fails the switch.
func (l *Lifecycle) SetSwitchedItsas(fn func(ctx context.Context, from, to db.Agent)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.switchedItsas = fn
}

// isSwitching is src/cost-switch.ts switching.has.
func (l *Lifecycle) isSwitching(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.switching[id]
}

// beginSwitch is what src/cost-switch.ts costSwitch does before its first await: the agent's transition lock and its
// place in switching, taken at once under l.mu, so a switch asked while another starts is refused as already being
// switched, and a resume asked then is refused by the lock. StartSwitch and ResumeSwitches take it before their
// background switch runs; the release gives both back, once, on every path.
func (l *Lifecycle) beginSwitch(a db.Agent) (func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.switching[a.ID] {
		return nil, fmt.Errorf("%s is already being switched", a.Name)
	}
	release, err := l.acquireLocked(a, "switch")
	if err != nil {
		return nil, err
	}
	if l.switching == nil {
		l.switching = map[string]bool{}
	}
	l.switching[a.ID] = true
	var once sync.Once
	return func() {
		once.Do(func() {
			l.setSwitching(a.ID, false)
			release()
		})
	}, nil
}

func (l *Lifecycle) setSwitching(id string, on bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.switching == nil {
		l.switching = map[string]bool{}
	}
	if on {
		l.switching[id] = true
	} else {
		delete(l.switching, id)
	}
}

// switchTarget is src/cost-switch.ts switchTarget for a preset: the registry's (defaults, then the user registry (the home's cached copy on a peer)
// over them by name; a null entry is dropped). A model or effort that isn't a string counts as none.
func (l *Lifecycle) switchTarget(preset string) (switchTo, error) {
	defaults, err := readJSON(l.claude.Templates.Root + "/registry/defaults.json")
	if err != nil {
		return switchTo{}, err
	}
	user := jsjson.Value(l.claude.Templates.UserRegistry())
	var found jsjson.Value
	for _, doc := range []jsjson.Value{defaults, user} {
		o, _ := doc.(*jsjson.Object)
		p, _ := o.Get("presets")
		po, _ := p.(*jsjson.Object)
		if v, ok := po.Get(preset); ok {
			found = v
		}
	}
	o, _ := found.(*jsjson.Object)
	if o == nil {
		return switchTo{}, fmt.Errorf("no preset %s; see stam registry", preset)
	}
	text := func(k string) *string {
		v, _ := o.Get(k)
		if s, ok := v.(string); ok {
			return &s
		}
		return nil
	}
	h := text("harness")
	if h == nil {
		return switchTo{}, fmt.Errorf("preset %s runs undefined, which stam can't control", preset)
	}
	return switchTo{Harness: *h, Model: text("model"), Effort: text("effort")}, nil
}

// Preset is src/registry.ts preset: the registry preset's harness, model and effort (a spawn's default preset).
func (l *Lifecycle) Preset(name string) (harness string, model, effort *string, err error) {
	t, err := l.switchTarget(name)
	return t.Harness, t.Model, t.Effort, err
}

// tsHarnesses are the harnesses src/adapters/index.ts has an adapter for; a preset on another one is refused as TS
// refuses it.
var tsHarnesses = []string{"claude", "codex", "opencode"}

// CheckSwitch is src/cost-switch.ts check: everything that refuses the switch before anything changes. A permission
// refusal is a ForbiddenError. again is the re-check after the quiesce, of the switch already under way.
func (l *Lifecycle) CheckSwitch(ctx context.Context, o SwitchOptions, again bool) (SwitchPlan, error) {
	a, err := l.db.GetAgent(ctx, o.Agent)
	if errors.Is(err, db.ErrNotFound) {
		return SwitchPlan{}, fmt.Errorf("no agent %s", o.Agent)
	}
	if err != nil {
		return SwitchPlan{}, err
	}
	if err := l.assertMayManageTreeAs(ctx, o.By, a, o.Remote); err != nil {
		return SwitchPlan{}, err
	}
	if a.Lifecycle == "archived" {
		return SwitchPlan{}, fmt.Errorf("%s is archived", a.Name)
	}
	if a.ForwardedTo != nil && *a.ForwardedTo != "" {
		to := *a.ForwardedTo
		if s, err := l.db.GetAgent(ctx, to); err == nil {
			to = s.Name
		}
		return SwitchPlan{}, fmt.Errorf("%s was already taken over by %s", a.Name, to)
	}
	if !again && l.isSwitching(a.ID) {
		return SwitchPlan{}, fmt.Errorf("%s is already being switched", a.Name)
	}
	to, err := l.switchTarget(o.Preset)
	if err != nil {
		return SwitchPlan{}, err
	}
	if !contains(tsHarnesses, to.Harness) {
		return SwitchPlan{}, fmt.Errorf("preset %s runs %s, which stam can't control", o.Preset, to.Harness)
	}
	if to.Harness != "claude" {
		return SwitchPlan{}, fmt.Errorf("preset %s runs %s, which the Go daemon can't launch yet; switch with the TypeScript daemon", o.Preset, to.Harness)
	}
	successor, err := l.db.SuccessorName(ctx, a.Name)
	if err != nil {
		return SwitchPlan{}, err
	}
	return SwitchPlan{Agent: a, Preset: o.Preset, To: to, By: o.By, Successor: successor}, nil
}

type quiesceEvent struct {
	Step     string  `json:"step"`
	Minutes  float64 `json:"minutes"`
	Deadline string  `json:"deadline"`
	Preset   string  `json:"preset"`
	By       string  `json:"by"`
}

type interruptEvent struct {
	Step      string `json:"step"`
	Confirmed bool   `json:"confirmed"`
}

// softStop is the switch's soft stop in minutes: the option, else settings.cost.softStopMinutes.
func (l *Lifecycle) softStop(o SwitchOptions) float64 {
	if o.SoftStopMinutes != nil {
		return *o.SoftStopMinutes
	}
	return l.settings.Get().CostSoftStopMinutes
}

// quiesce is src/cost-switch.ts quiesce: a working agent, whatever its lifecycle (a paused one can be mid-turn), gets
// cost-prepare.md and up to the soft stop to end its turn; at the deadline the harness is asked to interrupt, best
// effort, and the stop follows either way. Every switch records the step with its deadline and parameters, idle ones
// too, so a restart can re-arm it (resumeSwitches). It returns whether it waited, and whether the deadline passed.
func (l *Lifecycle) quiesce(ctx context.Context, a db.Agent, o SwitchOptions) (waited, interrupted bool, err error) {
	cur, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return false, false, err
	}
	minutes := l.softStop(o)
	// new Date(NaN or Infinity).toISOString() throws this in TS, before the step is recorded.
	if math.IsNaN(minutes) || math.IsInf(minutes, 0) {
		return false, false, errors.New("Invalid time value")
	}
	deadline := time.Now().Add(time.Duration(minutes * float64(time.Minute)))
	l.event(ctx, a.ID, "cost:switch", quiesceEvent{Step: "quiesce", Minutes: minutes, Deadline: iso(deadline), Preset: o.Preset, By: o.By})
	l.switchStep(a.ID, "quiesce")
	if cur.Lifecycle == "shut_down" || !busy(cur) {
		return false, false, nil
	}
	text, err := l.render("cost-prepare", map[string]string{"cwd": cur.Cwd, "minutes": jsjson.Number(minutes)})
	if err != nil {
		return false, false, err
	}
	l.QueueNotice(ctx, a.ID, text, false)
	// A turn that ended before its next tool call never saw the request; it no longer applies.
	defer l.dropNotice(a.ID, text)
	poll := o.Poll
	if poll <= 0 {
		poll = time.Second
	}
	for time.Now().Before(deadline) {
		if err := sleep(ctx, min(poll, max(0, time.Until(deadline)))); err != nil {
			return false, false, err
		}
		if cur, err = l.db.GetAgent(ctx, a.ID); err != nil {
			return false, false, err
		}
		if !busy(cur) {
			return true, false, nil
		}
	}
	ok, err := l.interrupt(ctx, cur)
	if err != nil {
		if ctx.Err() != nil {
			return false, false, ctx.Err()
		}
		l.event(ctx, a.ID, "cost:interrupt-error", "Error: "+err.Error())
	}
	l.event(ctx, a.ID, "cost:switch", interruptEvent{Step: "interrupt", Confirmed: ok})
	l.switchStep(a.ID, "interrupt")
	return true, true, nil
}

// dropNotice is src/mail.ts dropNotice: every queued notice of the agent with that text goes.
func (l *Lifecycle) dropNotice(id, text string) {
	l.mu.Lock()
	var kept, dropped []notice
	for _, n := range l.notices[id] {
		if n.Text != text {
			kept = append(kept, n)
		} else {
			dropped = append(dropped, n)
		}
	}
	if len(kept) > 0 {
		l.notices[id] = kept
	} else {
		delete(l.notices, id)
	}
	l.mu.Unlock()
	l.forgetRows(context.Background(), dropped)
}

// moveRingNotices is src/mail.ts moveRingNotices (S-2490): a taken-over agent's queued ring turns move to its
// successor, once, out of its own queue, since a held predecessor runs nothing. It returns how many moved.
func (l *Lifecycle) moveRingNotices(ctx context.Context, from, to string) int {
	l.mu.Lock()
	var ring, kept []notice
	for _, n := range l.notices[from] {
		if n.Ring {
			ring = append(ring, n)
		} else {
			kept = append(kept, n)
		}
	}
	if len(ring) == 0 {
		l.mu.Unlock()
		return 0
	}
	if len(kept) > 0 {
		l.notices[from] = kept
	} else {
		delete(l.notices, from)
	}
	l.mu.Unlock()
	for _, n := range ring {
		l.queue(ctx, to, n.Text, n.IdleOnly, true, 0)
	}
	return len(ring)
}

type stoppedEvent struct {
	Step string `json:"step"`
	Was  string `json:"was"`
}

// stopForSwitch is src/cost-switch.ts stop: the predecessor's harness stops as a shutdown does (its session stays, to
// resume), and nothing of it may still run: its terminal must be gone, and an OpenCode turn confirmed stopped in the
// shared server (awaitTurnStop; Claude Code has no server-side turn). It returns whether the agent was running, so a
// rollback knows to resume it.
func (l *Lifecycle) stopForSwitch(ctx context.Context, a db.Agent) (bool, error) {
	cur, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return false, err
	}
	running := cur.Lifecycle == "active" || cur.Lifecycle == "paused"
	// A down agent's stop still gets a generation of its own, so a launch since gives it up.
	gen := l.nextGen(a.ID)
	if running || l.tmux.HasSession(ctx, a.ID) {
		if gen, err = l.stopForGoodGen(ctx, cur, "shut down"); err != nil {
			return false, err
		}
	}
	for i := 0; i < 20 && l.tmux.HasSession(ctx, a.ID); i++ {
		if err := sleep(ctx, 250*time.Millisecond); err != nil {
			return false, err
		}
	}
	if l.tmux.HasSession(ctx, a.ID) {
		return false, fmt.Errorf("%s's terminal didn't close", a.Name)
	}
	if err := l.awaitTurnStop(ctx, cur, gen); err != nil {
		return false, err
	}
	l.event(ctx, a.ID, "cost:switch", stoppedEvent{Step: "stopped", Was: string(cur.Lifecycle)})
	return running, nil
}

type spawnedLive struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	ParentID *string `json:"parent_id"`
}

// moveForSwitch is src/cost-switch.ts move: the successor's row and the predecessor's place in the org, in one
// transaction (db.MoveToSuccessor). The live stream then hears of the new agent (src/db.ts createAgent's agent.spawned);
// TS's agentTextChanged feeds the embedding index, which the Go daemon doesn't have.
func (l *Lifecycle) moveForSwitch(ctx context.Context, plan SwitchPlan, threads []db.ThreadRef) (db.Agent, db.Moved, error) {
	a, err := l.db.GetAgent(ctx, plan.Agent.ID)
	if err != nil {
		return db.Agent{}, db.Moved{}, err
	}
	id, err := l.newSuccessorID(ctx)
	if err != nil {
		return db.Agent{}, db.Moved{}, err
	}
	session, err := randomUUID()
	if err != nil {
		return db.Agent{}, db.Moved{}, err
	}
	spec, err := l.successorSpec(a, plan.To, id, session)
	if err != nil {
		return db.Agent{}, db.Moved{}, err
	}
	s, moved, err := l.db.MoveToSuccessor(ctx, a, spec, threads, plan.Preset)
	if err != nil {
		return db.Agent{}, db.Moved{}, err
	}
	_ = l.live.Emit("agent.spawned", spawnedLive{ID: s.ID, Name: s.Name, ParentID: s.ParentID})
	l.switchStep(a.ID, "moved")
	return s, moved, nil
}

// newSuccessorID is a new agent id for a successor; a test gives its own (successorID), which no real agent has, so a
// kill's process sweep can't reach a real agent's processes.
func (l *Lifecycle) newSuccessorID(ctx context.Context) (string, error) {
	l.mu.Lock()
	fn := l.successorID
	l.mu.Unlock()
	if fn != nil {
		return fn(), nil
	}
	return l.db.NewAgentID(ctx)
}

// randomUUID is crypto.randomUUID: a random version 4 UUID.
func randomUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// launchSuccessor is src/cost-switch.ts launch: the successor starts as a Go spawn does (its account's rule and budget
// blockers and a tree paused for cost hold it, and a held agent's first prompt waits as an idle notice), then the
// switch waits for its real startup: the launch done, the agent out of starting (its takeover prompt taken, or it came
// up held), and its terminal alive. An error, or no start within the startup time, fails the switch.
func (l *Lifecycle) launchSuccessor(ctx context.Context, s db.Agent, prompt string, o SwitchOptions) error {
	if err := l.AttachSpawn(ctx, s); err != nil {
		return err
	}
	l.AttachBudget(ctx, s)
	if err := l.AttachPause(ctx, s); err != nil {
		return err
	}
	cur, err := l.db.GetAgent(ctx, s.ID)
	if err != nil {
		return err
	}
	text := prompt
	if l.isHeld(ctx, cur) {
		l.QueueNotice(ctx, s.ID, prompt, true)
		text = ""
	}
	startup := o.Startup
	if startup <= 0 {
		startup = switchStartup
	}
	timer := time.NewTimer(startup)
	defer timer.Stop()
	timeout := fmt.Errorf("%s didn't start within %s s", s.Name, jsjson.Number(math.Round(startup.Seconds())))
	launched, err := l.startHarness(ctx, cur, text, false, "spawn")
	if err != nil {
		return err
	}
	if launched != nil {
		select {
		case err := <-launched:
			if err != nil {
				return err
			}
		case <-timer.C:
			return timeout
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	l.switchStep(s.ID, "launched")
	poll := min(o.Poll, 500*time.Millisecond)
	if poll <= 0 {
		poll = 500 * time.Millisecond
	}
	for {
		now, err := l.db.GetAgent(ctx, s.ID)
		if err != nil {
			return err
		}
		if !l.tmux.HasSession(ctx, s.ID) || l.tmux.IsDead(ctx, s.ID) {
			return fmt.Errorf("%s's harness exited during startup", s.Name)
		}
		if now.Activity == "errored" {
			detail := "error"
			if now.ActivityDetail != nil {
				detail = *now.ActivityDetail
			}
			return fmt.Errorf("%s failed to start: %s", s.Name, detail)
		}
		if now.Activity != "starting" {
			return nil
		}
		select {
		case <-time.After(poll):
		case <-timer.C:
			return timeout
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

type switchStartEvent struct {
	Step   string `json:"step"`
	By     string `json:"by"`
	Preset string `json:"preset"`
}

type switchDoneEvent struct {
	Step string `json:"step"`
	To   string `json:"to"`
}

type switchFailedEvent struct {
	Step  string `json:"step"`
	Error string `json:"error"`
}

// ackSwitched is costSwitch's ackOpen: the manager acted, so the agent's open cost notices stop their fallbacks now,
// not after the soft stop. It returns the ids acknowledged.
func (l *Lifecycle) ackSwitched(ctx context.Context, a db.Agent, by string) []string {
	out := []string{}
	open, err := l.db.OpenCostNotices(ctx)
	if err != nil {
		l.logSwitch(a, "ack", err)
		return out
	}
	for _, n := range open {
		if n.AgentID == nil || *n.AgentID != a.ID {
			continue
		}
		if r, err := l.AckCostNotice(ctx, n.ID, by, "cost_switch"); err != nil {
			l.logSwitch(a, "ack", err)
		} else if r.OK {
			out = append(out, n.ID)
		}
	}
	return out
}

// CostSwitch is src/cost-switch.ts costSwitch, from the lock to the notices, with the plan CheckSwitch gave. It returns
// once the successor runs; with a working agent that is up to the soft stop later. Anything after the stop that fails,
// the successor's startup included, is rolled back: the move undone in one transaction, the successor forgotten, and
// the predecessor resumed if it ran. The agent's transition lock is held throughout, the rollback's resume included.
// A daemon stop mid-switch leaves it where it was, as a crash does, for the next start to re-arm or not.
func (l *Lifecycle) CostSwitch(ctx context.Context, o SwitchOptions, plan SwitchPlan) (SwitchResult, error) {
	release, err := l.beginSwitch(plan.Agent)
	if err != nil {
		return SwitchResult{}, err
	}
	defer release()
	return l.costSwitch(ctx, o, plan)
}

// costSwitch is CostSwitch past its lock, which the caller took with beginSwitch and releases.
func (l *Lifecycle) costSwitch(ctx context.Context, o SwitchOptions, plan SwitchPlan) (SwitchResult, error) {
	a := plan.Agent
	l.event(ctx, a.ID, "cost:switch", switchStartEvent{Step: "start", By: plan.By, Preset: plan.Preset})
	l.switchStep(a.ID, "start")
	acked := l.ackSwitched(ctx, a, plan.By)
	waited, interrupted, err := l.quiesce(ctx, a, o)
	if err != nil {
		return SwitchResult{}, err
	}
	wasRunning := false
	var s *db.Agent
	var moved db.Moved
	res, err := func() (SwitchResult, error) {
		// In serial, so a pause or unpause either lands before the stop or after it.
		if err := l.serial(ctx, a.ID, func(ctx context.Context) error {
			var err error
			wasRunning, err = l.stopForSwitch(ctx, a)
			return err
		}); err != nil {
			return SwitchResult{}, err
		}
		l.switchStep(a.ID, "stopped")
		// The stop was confirmed, but the agent may have been started again meanwhile.
		cur, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return SwitchResult{}, err
		}
		if l.tmux.HasSession(ctx, a.ID) || cur.Lifecycle == "active" {
			return SwitchResult{}, fmt.Errorf("%s was started again during the stop", a.Name)
		}
		// Stopped, it only records the blocker (no pause turn); the blocker keeps stam from resuming it on its own.
		if _, err := l.AddBlocker(ctx, a.ID, NewBlocker{Kind: takenOver, Reason: l.switchBy(ctx, plan.By) + " is moving its work to preset " + plan.Preset}); err != nil {
			return SwitchResult{}, err
		}
		l.switchStep(a.ID, "blocked")
		fresh, err := l.CheckSwitch(ctx, SwitchOptions{Agent: a.ID, Preset: o.Preset, By: o.By, Remote: o.Remote}, true)
		if err != nil {
			return SwitchResult{}, err
		}
		// The preset changed during the quiesce: admit only the plan that moves.
		if fresh.To.Harness != plan.To.Harness || deref(fresh.To.Model) != deref(plan.To.Model) || (fresh.To.Model == nil) != (plan.To.Model == nil) ||
			deref(fresh.To.Effort) != deref(plan.To.Effort) || (fresh.To.Effort == nil) != (plan.To.Effort == nil) {
			return SwitchResult{}, fmt.Errorf("the target of %s changed while %s finished its step", plan.Preset, a.Name)
		}
		threads, err := l.db.OpenThreads(ctx, a.ID, switchThreads)
		if err != nil {
			return SwitchResult{}, err
		}
		succ, m, err := l.moveForSwitch(ctx, plan, threads)
		if err != nil {
			return SwitchResult{}, err
		}
		s, moved = &succ, m
		pred, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return SwitchResult{}, err
		}
		text, handover, err := l.takeoverPrompt(ctx, pred, succ, plan.By, plan.Preset, threads)
		if err != nil {
			return SwitchResult{}, err
		}
		if err := l.launchSuccessor(ctx, succ, text, o); err != nil {
			return SwitchResult{}, err
		}
		// The ring turns queued to the predecessor are the successor's now, once (S-2490).
		l.moveRingNotices(ctx, a.ID, succ.ID)
		// The ITSAs live on the ITSA home; on another machine it moves their owner too (S-3636). Soft: it never fails the switch.
		l.mu.Lock()
		handOff := l.switchedItsas
		l.mu.Unlock()
		if handOff != nil {
			if pred, err := l.db.GetAgent(ctx, a.ID); err == nil {
				handOff(ctx, pred, succ)
			}
		}
		if _, err := l.AddBlocker(ctx, a.ID, NewBlocker{Kind: takenOver, Reason: "taken over by " + succ.Name + " on preset " + plan.Preset}); err != nil {
			return SwitchResult{}, err
		}
		acked = append(acked, l.ackSwitched(ctx, a, plan.By)...)
		if from, err := l.db.GetAgent(ctx, a.ID); err == nil {
			if to, err := l.db.GetAgent(ctx, succ.ID); err == nil {
				l.switched(ctx, from, to, plan.Preset, plan.By)
			}
		}
		if err := l.syncChildrenWaits(ctx, succ.ID); err != nil {
			l.logSwitch(a, "children waits", err)
		}
		l.event(ctx, a.ID, "cost:switch", switchDoneEvent{Step: "done", To: succ.Name})
		children := []string{}
		for _, c := range append(append([]string{}, moved.Spawned...), moved.Adopted...) {
			name := c
			if ca, err := l.db.GetAgent(ctx, c); err == nil {
				name = ca.Name
			}
			children = append(children, name)
		}
		var ho *string
		if handover != "" {
			ho = &handover
		}
		return SwitchResult{From: a.Name, To: succ.Name, Preset: plan.Preset, Waited: waited, Interrupted: interrupted, Handover: ho,
			Moved: SwitchMoved{Children: children, Threads: len(threads), Unread: len(moved.Unread), Itsas: len(moved.ItsaOwned)}, Acked: acked}, nil
	}()
	if err == nil {
		return res, nil
	}
	// A daemon stop is a crash to the switch: nothing is undone, so the next start sees what a crash leaves.
	if ctx.Err() != nil {
		return SwitchResult{}, err
	}
	return SwitchResult{}, l.rollbackSwitch(ctx, plan, s, moved, wasRunning, err)
}

// rollbackSwitch is costSwitch's catch: the successor's terminal goes, its ring turns go back, the move is undone, the
// taken-over blocker goes, and the predecessor is resumed if it ran, under the switch's lock, told why. The error names
// the switch, whether the predecessor came back, and the cause.
func (l *Lifecycle) rollbackSwitch(ctx context.Context, plan SwitchPlan, s *db.Agent, moved db.Moved, wasRunning bool, cause error) error {
	a := plan.Agent
	msg := cause.Error()
	restored := "restored"
	if s != nil {
		_ = l.killPane(ctx, s.ID, l.nextGen(s.ID), false)
		// The ring turns go back to the predecessor, which is resumed or stays held.
		l.moveRingNotices(ctx, s.ID, a.ID)
		if err := l.db.Unmove(ctx, a.ID, s.ID, moved); err != nil {
			return err
		}
	}
	if _, _, err := l.db.DropBlocker(ctx, a.ID, takenOver, "", nil); err != nil {
		l.logSwitch(a, "rollback", err)
	}
	if wasRunning {
		note, err := l.render("cost-switch-failed", map[string]string{"reason": msg})
		if err == nil {
			var cur db.Agent
			if cur, err = l.db.GetAgent(ctx, a.ID); err == nil {
				_, err = l.resumeLocked(ctx, cur, note)
			}
		}
		if err != nil {
			restored = "left shut down (" + err.Error() + ")"
			l.event(ctx, a.ID, "cost:switch-resume-error", "Error: "+err.Error())
		}
	}
	l.event(ctx, a.ID, "cost:switch", switchFailedEvent{Step: "rolled-back", Error: msg})
	return fmt.Errorf("switching %s to %s failed, and %s was %s: %s", a.Name, plan.Preset, a.Name, restored, msg)
}

// ResumeSwitches is src/cost-switch.ts resumeSwitches, run at daemon start: a switch a restart cut short in its soft
// stop (its latest cost:switch step, among the agent's last 500 events, is the quiesce or the interrupt) goes on with
// what is left of it, so a working agent is interrupted at the original deadline. Each runs on its own, in the
// background; a failure is recorded as a resume-failed step. It returns the agents whose switch was resumed.
func (l *Lifecycle) ResumeSwitches(ctx context.Context) []string {
	resumed := []string{}
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		l.logSwitch(db.Agent{}, "resume", err)
		return resumed
	}
	for _, a := range agents {
		if a.Lifecycle == "archived" || (a.ForwardedTo != nil && *a.ForwardedTo != "") || l.isSwitching(a.ID) {
			continue
		}
		events, err := l.db.ListEvents(ctx, a.ID, 500, "")
		if err != nil {
			continue
		}
		var steps []map[string]any
		for _, e := range events {
			if e.Type != "cost:switch" {
				continue
			}
			var d map[string]any
			_ = e.Decode(&d)
			steps = append(steps, d)
		}
		if len(steps) == 0 {
			continue
		}
		if step, _ := steps[len(steps)-1]["step"].(string); step != "quiesce" && step != "interrupt" {
			continue
		}
		// The newest quiesce belongs to the switch in progress: every switch writes one first.
		var q map[string]any
		for i := len(steps) - 1; i >= 0; i-- {
			if steps[i]["step"] == "quiesce" {
				q = steps[i]
				break
			}
		}
		preset, _ := q["preset"].(string)
		by, _ := q["by"].(string)
		deadline, _ := q["deadline"].(string)
		if preset == "" || by == "" || deadline == "" {
			continue
		}
		fail := func(err error) {
			l.event(l.ctx, a.ID, "cost:switch", switchFailedEvent{Step: "resume-failed", Error: err.Error()})
		}
		if t, ok := q["toType"].(string); ok && t != "" {
			fail(fmt.Errorf("a switch to the agent type %s is not in the Go daemon yet; resume it with the TypeScript daemon", t))
			continue
		}
		remaining := 0.0
		if at, err := time.Parse(time.RFC3339Nano, deadline); err == nil {
			remaining = max(0, float64(time.Until(at).Milliseconds())) / 60_000
		}
		o := SwitchOptions{Agent: a.ID, Preset: preset, By: by, SoftStopMinutes: &remaining}
		plan, err := l.CheckSwitch(ctx, o, false)
		if err != nil {
			fail(err)
			continue
		}
		release, err := l.beginSwitch(plan.Agent)
		if err != nil {
			fail(err)
			continue
		}
		if !l.tryBG(func(ctx context.Context) {
			defer release()
			if _, err := l.costSwitch(ctx, o, plan); err != nil && ctx.Err() == nil {
				fail(err)
			}
		}) {
			release()
			continue
		}
		resumed = append(resumed, a.Name)
	}
	return resumed
}

// StartSwitch is src/cost-switch.ts startSwitch, for the API: it checks at once, then switches. An agent that isn't
// working switches before this returns (a Quiescing answer otherwise): a working one gets up to the soft stop, so its
// switch goes on in the background and a failure reaches the manager as a notice. The switch runs under the daemon's
// context, so a caller that goes away doesn't cut it short.
func (l *Lifecycle) StartSwitch(ctx context.Context, o SwitchOptions) (any, error) {
	plan, err := l.CheckSwitch(ctx, o, false)
	if err != nil {
		return nil, err
	}
	a, err := l.db.GetAgent(ctx, plan.Agent.ID)
	if err != nil {
		return nil, err
	}
	// Taken before anything runs in the background, so a second caller in the gap is refused here.
	release, err := l.beginSwitch(plan.Agent)
	if err != nil {
		return nil, err
	}
	if a.Lifecycle == "shut_down" || !busy(a) {
		type outcome struct {
			r   SwitchResult
			err error
		}
		done := make(chan outcome, 1)
		if !l.tryBG(func(bg context.Context) {
			defer release()
			r, err := l.costSwitch(bg, o, plan)
			done <- outcome{r, err}
		}) {
			release()
			return nil, errors.New("the daemon is stopping")
		}
		select {
		case out := <-done:
			if out.err != nil {
				return nil, out.err
			}
			return out.r, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-l.ctx.Done():
			return nil, errors.New("the daemon is stopping")
		}
	}
	minutes := l.softStop(o)
	if !l.tryBG(func(bg context.Context) {
		defer release()
		_, err := l.costSwitch(bg, o, plan)
		if err != nil && bg.Err() == nil && plan.By != humanID {
			l.deliverCost(bg, plan.By, "[stam] cost_switch of "+a.Name+" failed", "[stam] "+err.Error(), nil)
		}
	}) {
		release()
		return nil, errors.New("the daemon is stopping")
	}
	return Quiescing{Status: "quiescing", From: a.Name, To: plan.Successor, Preset: plan.Preset, Minutes: minutes}, nil
}
