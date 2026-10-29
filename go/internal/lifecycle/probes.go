package lifecycle

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// Error blockers and probes (src/cost-probes.ts, docs/cost-policy.md build step 15, S-2848 part 9): a provider error
// that ends a turn after the harness's own retries (a transient or auth StopFailure) sets error:ACCOUNT on every agent on
// the account. Stam then probes the account at 1, 2, 4, 8 and 16 minutes, then every 16, one probe per account, and
// clears the blocker on every agent when one succeeds. Claude's credits-out from a billing_error clears the same way
// (the rules start the probe, and its success lifts it). The human gets one mail per account per outage, and only for
// an auth error, which no probe fixes without them; the error blocker's clear condition records that it went, so a
// restart doesn't send it again.
//
// Error blockers are written and cleared on the account's rules chain (onChain), as the rule blockers are, so a
// failure's writes, a success's clears and a spawn's attach of the account's blockers never interleave. A success
// clears only the generation it tested: one a newer failure overtook clears nothing.
//
// Claude has no free endpoint to probe, so a probe is the next turn of one blocked agent: stam lets one agent (the one
// blocked longest that nothing else holds) run past the account's probe blockers, which stay in place for the rest, and
// unpauses it. A Stop or PostToolUse hook from it (the model answered) is success and clears the account; an error
// signal is failure and holds it again. A probe turn that shows neither by the next step is abandoned and held again,
// and that step probes with another agent.
//
// Only Claude accounts are probed (S-2848, go-mgr): the Go daemon runs no OpenRouter or Codex agents and can't probe
// those accounts, so an error there would set a blocker nothing here clears. Their signals are recorded and set
// nothing, and an error blocker the TS daemon set on one stays until the TS daemon clears it.
//
// Each agent's manager hears of its error blocker, and the notice arms the onError fallback (costnotices.go,
// fallback.go), as for every blocker.

// probeOutcome is what a probe found: the account works ("ok"), doesn't ("fail"), or a turn must show it ("turn").
type probeOutcome string

// Prober probes an account; a nil Lifecycle.prober probes every account with a turn.
type Prober func(ctx context.Context, account string, acct config.CostAccount) (probeOutcome, error)

// backoff is src/cost-probes.ts backoff: the wait before probe n (0-based), 1, 2, 4, 8, 16 minutes, then 16.
func backoff(n int) time.Duration {
	return time.Duration(math.Min(math.Pow(2, float64(n)), 16)) * time.Minute
}

// probe is one account's probing: its next attempt and when it is due, and the agent whose turn is the probe while one
// runs.
type probe struct {
	attempt int
	due     float64
	timer   *time.Timer
	turn    string
}

// probeState is the probing of every account. gens is bumped by every new failure, before anything is queued, and kept
// when probing stops: a success clears only the generation it tested, so an older success queued behind a newer failure
// leaves that failure's blockers. told marks the accounts whose human was mailed this outage, reserved before any wait,
// so two auth errors at once mail once.
type probeState struct {
	mu     sync.Mutex
	states map[string]*probe
	gens   map[string]int
	told   map[string]bool
}

func (p *probeState) init() {
	if p.states == nil {
		p.states, p.gens, p.told = map[string]*probe{}, map[string]int{}, map[string]bool{}
	}
}

// probeKinds is the blockers a probe clears: error, and credits-out on a Claude account (it reports no balance).
func (l *Lifecycle) probeKinds(account string) []string {
	if acct, ok := l.settings.Get().CostAccounts[account]; ok && acct.Harness == "claude" {
		return []string{"error", "credits-out"}
	}
	return []string{"error"}
}

// probed is whether the Go daemon probes the account: Claude accounts only.
func (l *Lifecycle) probed(account string) bool {
	acct, ok := l.settings.Get().CostAccounts[account]
	return ok && acct.Harness == "claude"
}

// probeGen is src/cost-probes.ts generation.
func (l *Lifecycle) probeGen(account string) int {
	l.costProbes.mu.Lock()
	defer l.costProbes.mu.Unlock()
	return l.costProbes.gens[account]
}

// nextProbe is src/cost-probes.ts nextProbe: the account's next probe, and the agent whose turn is probing.
func (l *Lifecycle) nextProbe(account string) (attempt int, due float64, turn string, ok bool) {
	l.costProbes.mu.Lock()
	defer l.costProbes.mu.Unlock()
	s := l.costProbes.states[account]
	if s == nil {
		return 0, 0, "", false
	}
	return s.attempt, s.due, s.turn, true
}

// admitsProbe is src/cost-probes.ts admitsProbe: whether the agent runs its account's probe turn past this blocker.
func (l *Lifecycle) admitsProbe(id, kind, account string) bool {
	l.costProbes.mu.Lock()
	s := l.costProbes.states[account]
	turn := s != nil && s.turn == id
	l.costProbes.mu.Unlock()
	return turn && contains(l.probeKinds(account), kind)
}

// holding is the agent's blockers but those its probe turn runs past: what holds it (src/admission.ts blockedBy).
func (l *Lifecycle) holding(ctx context.Context, id string) ([]db.Blocker, error) {
	rows, err := l.db.BlockerRows(ctx, id)
	if err != nil {
		return nil, err
	}
	out := rows[:0:0]
	for _, b := range rows {
		if !l.admitsProbe(id, b.Kind, b.Account) {
			out = append(out, b)
		}
	}
	return out, nil
}

// probeHeld is src/cost-probes.ts held: the account's probe blockers, on every agent.
func (l *Lifecycle) probeHeld(ctx context.Context, account string) ([]db.Blocker, error) {
	rows, err := l.db.BlockersFor(ctx, account)
	if err != nil {
		return nil, err
	}
	kinds := l.probeKinds(account)
	var out []db.Blocker
	for _, k := range kinds {
		for _, b := range rows {
			if b.Kind == k {
				out = append(out, b)
			}
		}
	}
	return out, nil
}

// scheduleProbe is src/cost-probes.ts schedule, with l.costProbes.mu held: probe attempt n at now plus its backoff.
func (l *Lifecycle) scheduleProbe(account string, attempt int, now float64) {
	l.costProbes.init()
	s := l.costProbes.states[account]
	if s == nil {
		s = &probe{}
		l.costProbes.states[account] = s
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	s.attempt = attempt
	s.due = now + float64(backoff(attempt).Milliseconds())
	l.mu.Lock()
	stopped := l.waited || l.ctx.Err() != nil
	l.mu.Unlock()
	if stopped {
		return
	}
	s.timer = time.AfterFunc(time.Duration(math.Max(0, s.due-ms(time.Now())))*time.Millisecond, func() {
		l.goBG(func(ctx context.Context) {
			if err := l.runProbe(ctx, account, ms(time.Now())); err != nil {
				slog.Error("cost probe", "account", account, "err", err)
			}
		})
	})
}

// startProbe is src/cost-probes.ts start, with l.costProbes.mu held: a new failure starts probing the account, unless a
// probe is already scheduled; a probe turn under way failed (it tested the account before this), so it is held again
// and the step tried again.
func (l *Lifecycle) startProbe(account string, now float64) {
	l.costProbes.init()
	l.costProbes.gens[account]++
	s := l.costProbes.states[account]
	if s == nil {
		l.scheduleProbe(account, 0, now)
		return
	}
	if s.turn != "" {
		l.failTurn(account, s, now, true)
	}
}

// stopProbe is src/cost-probes.ts stop, with l.costProbes.mu held.
func (l *Lifecycle) stopProbe(account string) {
	if s := l.costProbes.states[account]; s != nil && s.timer != nil {
		s.timer.Stop()
	}
	delete(l.costProbes.states, account)
	delete(l.costProbes.told, account)
}

type errorClear struct {
	After string `json:"after"`
	Class string `json:"class"`
	Human bool   `json:"human,omitempty"`
}

// onError is src/cost-probes.ts onError: a transient or auth provider error ended a turn on the agent. Its account's
// agents are blocked, the human is mailed once for an auth error, and probing starts (or the probe under way is marked
// stale). Only a Claude account is blocked (see above).
func (l *Lifecycle) onError(ctx context.Context, a db.Agent, class, source string, now float64) error {
	account := l.settings.Get().AccountFor(a.Harness, a.Model)
	if account == "" || !l.probed(account) {
		return nil
	}
	rows, err := l.db.BlockersFor(ctx, account)
	if err != nil {
		return err
	}
	prior, err := parseBlockers(rows)
	if err != nil {
		return err
	}
	l.costProbes.mu.Lock()
	l.costProbes.init()
	hadError, marked := false, false
	for _, b := range prior {
		if b.Kind == "error" {
			hadError = true
			marked = marked || field(b.clear, "human") == true
		}
	}
	// A new outage: no blocker and no probe yet. The probe starts below, before anything waits, so a second error
	// arriving meanwhile joins this outage.
	if !hadError && l.costProbes.states[account] == nil {
		delete(l.costProbes.told, account)
	}
	// Once told, the outage keeps the mark through later errors of either class.
	if marked {
		l.costProbes.told[account] = true
	}
	mail := class == "auth" && !l.costProbes.told[account] && l.settings.Get().HumanMail.Allows("necessary")
	if mail {
		l.costProbes.told[account] = true
	}
	human := l.costProbes.told[account]
	// Starts the probe, or marks the one under way stale: it tested the account before this.
	l.startProbe(account, now)
	l.costProbes.mu.Unlock()
	if mail {
		l.tellHuman(ctx, account, source)
	}
	backoffs := "stam probes the account (1, 2, 4, 8, 16 minutes, then every 16) and clears this when one succeeds"
	reason := "a provider error after the harness's retries, " + source + "; " + backoffs
	if class == "auth" {
		reason = "an authentication error after the harness's retries, " + source + "; " + backoffs + ", which needs the login fixed"
	}
	clear, err := json.Marshal(errorClear{After: isoMs(now), Class: class, Human: human})
	if err != nil {
		return err
	}
	text := string(clear)
	// On the account's chain, ordered against a success's clears and a spawn's attach: a clear can't slip in between
	// and drop what this writes.
	var werr error
	<-l.onChain(account, func(ctx context.Context) error {
		werr = l.setErrorBlockers(ctx, account, reason, text, human)
		return nil
	})
	return werr
}

// setErrorBlockers puts the error blocker on every live agent of the account, on its rules chain; an unchanged one
// writes nothing.
func (l *Lifecycle) setErrorBlockers(ctx context.Context, account, reason, text string, human bool) error {
	agents, err := l.agentsOn(ctx, account)
	if err != nil {
		return err
	}
	for _, x := range agents {
		have, err := l.blockerOf(ctx, x.ID, "error", account)
		if err != nil {
			return err
		}
		if have != nil && have.Reason == reason && (field(have.clear, "human") == true) == human {
			continue
		}
		l.event(ctx, x.ID, "cost:rule", ruleEvent{Rule: "error", Account: account, Action: "set", Reason: reason})
		if _, err := l.AddBlocker(ctx, x.ID, NewBlocker{Kind: "error", Account: account, Reason: reason, Clear: &text}); err != nil {
			return err
		}
	}
	return nil
}

// blockerOf is the agent's blocker of this kind and account, nil for none.
func (l *Lifecycle) blockerOf(ctx context.Context, id, kind, account string) (*parsedBlocker, error) {
	rows, err := l.db.BlockerRows(ctx, id)
	if err != nil {
		return nil, err
	}
	blocks, err := parseBlockers(rows)
	if err != nil {
		return nil, err
	}
	for i := range blocks {
		if blocks[i].Kind == kind && blocks[i].Account == account {
			return &blocks[i], nil
		}
	}
	return nil, nil
}

// tellHuman is src/cost-probes.ts tellHuman: the one mail of an auth outage, sent in the background. A send that fails
// is logged; the blocker stays either way.
func (l *Lifecycle) tellHuman(ctx context.Context, account, source string) {
	var names []string
	if agents, err := l.agentsOn(ctx, account); err == nil {
		for _, x := range agents {
			names = append(names, x.Name)
		}
	}
	list := strings.Join(names, ", ")
	if list == "" {
		list = "(none)"
	}
	body, err := l.render("cost-error-human", map[string]string{"account": account, "source": source, "agents": list})
	if err != nil {
		slog.Error("cost error mail", "account", account, "err", err)
		return
	}
	l.goBG(func(ctx context.Context) {
		l.mailFromSystem(ctx, "cost", []string{humanID}, "[stam] "+account+": authentication error stops its agents", body)
	})
}

type probeEvent struct {
	Account string `json:"account"`
	Attempt *int   `json:"attempt,omitempty"`
	Outcome string `json:"outcome,omitempty"`
	Turn    bool   `json:"turn,omitempty"`
	Error   string `json:"error,omitempty"`
}

// runProbe is src/cost-probes.ts runProbe: a probe is due; it runs, and clears the account or schedules the next.
func (l *Lifecycle) runProbe(ctx context.Context, account string, now float64) error {
	l.costProbes.mu.Lock()
	s := l.costProbes.states[account]
	l.costProbes.mu.Unlock()
	if s == nil {
		return nil
	}
	acct, ok := l.settings.Get().CostAccounts[account]
	rows, err := l.probeHeld(ctx, account)
	if err != nil {
		return err
	}
	if !ok || len(rows) == 0 {
		l.costProbes.mu.Lock()
		l.stopProbe(account)
		l.costProbes.mu.Unlock()
		return nil
	}
	// A probe turn that showed nothing by now is abandoned: its agent is held again, and this step probes anew.
	l.costProbes.mu.Lock()
	abandoned := ""
	if s.turn != "" {
		abandoned = l.failTurn(account, s, now, false)
	}
	gen := l.costProbes.gens[account]
	prober := l.prober
	l.costProbes.mu.Unlock()
	out := probeOutcome("turn")
	if prober != nil {
		var err error
		if out, err = prober(ctx, account, acct); err != nil {
			out = "fail"
		}
	}
	l.costProbes.mu.Lock()
	current := l.costProbes.states[account] == s
	l.costProbes.mu.Unlock()
	if !current {
		return nil
	}
	// The blockers cleared some other way while it ran.
	if rows, err = l.probeHeld(ctx, account); err != nil {
		return err
	}
	l.costProbes.mu.Lock()
	if len(rows) == 0 {
		l.stopProbe(account)
		l.costProbes.mu.Unlock()
		return nil
	}
	// A failure that arrived while it ran is newer than what it tested.
	if out == "ok" && l.costProbes.gens[account] != gen {
		out = "fail"
	}
	attempt := s.attempt
	l.costProbes.mu.Unlock()
	l.event(ctx, rows[0].AgentID, "cost:probe", probeEvent{Account: account, Attempt: &attempt, Outcome: string(out)})
	if out == "ok" {
		return l.probeSucceeded(ctx, account, "a probe of "+account+" succeeded", gen, s)
	}
	if out == "turn" {
		if err := l.startTurn(ctx, account, s, abandoned); err != nil {
			return err
		}
	}
	// The next step; for a probe turn, also when it is abandoned.
	l.costProbes.mu.Lock()
	if l.costProbes.states[account] == s {
		l.scheduleProbe(account, s.attempt+1, now)
	}
	l.costProbes.mu.Unlock()
	return nil
}

// startTurn is src/cost-probes.ts startTurn: one blocked agent runs a turn as the probe, the one blocked longest that
// only probe blockers hold, the agent of an abandoned probe turn last. With none, the probe waits for the next step.
func (l *Lifecycle) startTurn(ctx context.Context, account string, s *probe, last string) error {
	rows, err := l.probeHeld(ctx, account)
	if err != nil {
		return err
	}
	order := func(b db.Blocker) int {
		if b.AgentID == last {
			return 1
		}
		return 0
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if oi, oj := order(rows[i]), order(rows[j]); oi != oj {
			return oi < oj
		}
		return localeCompare(rows[i].Since, rows[j].Since) < 0
	})
	kinds := l.probeKinds(account)
	for _, b := range rows {
		a, err := l.db.GetAgent(ctx, b.AgentID)
		if err != nil || a.Lifecycle != "paused" || len(pauseOwners(a)) > 0 {
			continue
		}
		if l.onlyProbeBlockers(ctx, a.ID, account, kinds) != nil {
			continue
		}
		started, stale := false, false
		// Checked again in the agent's serial: a pause queued ahead of this one (the human's, say) wins, and resumeNow
		// would otherwise erase its owner. So does a success or a stop that ended this probing while the turn waited:
		// its turn would run past blockers no probe watches any more.
		err = l.serial(ctx, a.ID, func(ctx context.Context) error {
			now, err := l.db.GetAgent(ctx, a.ID)
			if err != nil || now.Lifecycle != "paused" || len(pauseOwners(now)) > 0 {
				return nil
			}
			l.costProbes.mu.Lock()
			if l.costProbes.states[account] != s {
				l.costProbes.mu.Unlock()
				stale = true
				return nil
			}
			s.turn = a.ID
			attempt := s.attempt
			l.costProbes.mu.Unlock()
			l.event(ctx, a.ID, "cost:probe", probeEvent{Account: account, Attempt: &attempt, Turn: true})
			own, err := l.db.BlockerRows(ctx, a.ID)
			if err != nil {
				return err
			}
			what := make([]string, len(own))
			for i, x := range own {
				what[i] = x.Kind + " on " + account
			}
			text, err := l.render("cost-probe-turn", map[string]string{"blocker": strings.Join(what, ", ")})
			if err != nil {
				return err
			}
			if _, err := l.resumeNow(ctx, a.ID, text); err != nil {
				return err
			}
			started = true
			return nil
		})
		if err != nil {
			l.event(ctx, a.ID, "cost:probe", probeEvent{Account: account, Error: err.Error()})
			l.costProbes.mu.Lock()
			s.turn = ""
			l.costProbes.mu.Unlock()
			continue
		}
		if started || stale {
			return nil
		}
	}
	return nil
}

// errOtherBlocker says an agent carries a blocker other than its account's probe blockers.
type errOtherBlocker struct{}

func (errOtherBlocker) Error() string { return "held by another blocker" }

// onlyProbeBlockers is nil when every blocker the agent has is one of the account's probe kinds on that account.
func (l *Lifecycle) onlyProbeBlockers(ctx context.Context, id, account string, kinds []string) error {
	own, err := l.db.BlockerRows(ctx, id)
	if err != nil {
		return err
	}
	for _, x := range own {
		if !contains(kinds, x.Kind) || x.Account != account {
			return errOtherBlocker{}
		}
	}
	return nil
}

// failTurn is src/cost-probes.ts failTurn, with l.costProbes.mu held: the probe turn failed (an error signal) or showed
// nothing in time. Its agent is held again (its blockers never left, so a pause does it) and, unless the caller probes at
// once, the step waits for its time again. It returns the agent.
func (l *Lifecycle) failTurn(account string, s *probe, now float64, reschedule bool) string {
	id := s.turn
	s.turn = ""
	l.goBG(func(ctx context.Context) {
		err := l.serial(ctx, id, func(ctx context.Context) error {
			a, err := l.db.GetAgent(ctx, id)
			if err != nil || a.Lifecycle != "active" {
				return err
			}
			rows, err := l.db.BlockerRows(ctx, id)
			if err != nil || len(rows) == 0 {
				return err
			}
			_, err = l.pauseNow(ctx, id, "")
			return err
		})
		if err != nil {
			slog.Error("cost probe: hold again", "agent", id, "err", err)
		}
	})
	if reschedule {
		l.scheduleProbe(account, s.attempt, now)
	}
	return id
}

// turnSucceeded is src/cost-probes.ts turnSucceeded: the agent's model answered (a Stop or PostToolUse hook); if its
// turn is its account's probe, the account works. The success is accepted here, for the generation and probing it
// tested.
func (l *Lifecycle) turnSucceeded(ctx context.Context, a db.Agent) {
	type accepted struct {
		account string
		gen     int
		s       *probe
	}
	var won []accepted
	l.costProbes.mu.Lock()
	for account, s := range l.costProbes.states {
		if s.turn == a.ID {
			won = append(won, accepted{account, l.costProbes.gens[account], s})
		}
	}
	l.costProbes.mu.Unlock()
	for _, w := range won {
		l.goBG(func(ctx context.Context) {
			if f := l.succeeding; f != nil {
				f(w.account)
			}
			if err := l.probeSucceeded(ctx, w.account, a.Name+"'s turn, the probe, got a model response", w.gen, w.s); err != nil {
				slog.Error("cost probe", "account", w.account, "err", err)
			}
		})
	}
}

// probeSucceeded is src/cost-probes.ts succeeded, for a success accepted at generation gen of probing s: on the
// account's rules chain, so it is ordered against a newer failure's writes and a spawn's attach, probing stops and the
// account's error blockers clear, and on Claude its credits-out. Nothing happens once a newer failure (or another
// probing) took over, checked under the probes' lock before probing stops, and again inside each agent's serial right
// before its drop; that newer failure's own writes queue behind this on the chain.
func (l *Lifecycle) probeSucceeded(ctx context.Context, account, why string, gen int, s *probe) error {
	var err error
	<-l.onChain(account, func(ctx context.Context) error {
		err = l.succeed(ctx, account, why, gen, s)
		return nil
	})
	return err
}

func (l *Lifecycle) succeed(ctx context.Context, account, why string, gen int, s *probe) error {
	l.costProbes.mu.Lock()
	if l.costProbes.gens[account] != gen || l.costProbes.states[account] != s {
		l.costProbes.mu.Unlock()
		return nil
	}
	l.stopProbe(account)
	l.costProbes.mu.Unlock()
	rows, err := l.db.BlockersFor(ctx, account)
	if err != nil {
		return err
	}
	kinds := []string{"error"}
	if contains(l.probeKinds(account), "credits-out") {
		kinds = append(kinds, "credits-out")
	}
	for _, kind := range kinds {
		for _, b := range rows {
			if b.Kind != kind {
				continue
			}
			// In the agent's serial, so the blocker it finds is the one the drop removes: the clear is logged only for a
			// blocker that is still there to clear, before the drop as TS logs it.
			still := func(ctx context.Context) bool {
				if l.probeGen(account) != gen {
					return false
				}
				have, err := l.blockerOf(ctx, b.AgentID, kind, account)
				if err != nil || have == nil {
					return false
				}
				l.event(ctx, b.AgentID, "cost:rule", ruleEvent{Rule: kind, Account: account, Action: "clear", Reason: have.Reason, Cleared: why})
				return true
			}
			if _, err := l.clearBlocker(ctx, b.AgentID, kind, account, why, nil, still); err != nil {
				return err
			}
		}
	}
	return nil
}

// resumeProbes is src/cost-probes.ts resumeAll, at daemon start: every probed account with a probe blocker is probed
// from the first step. A probe turn that was running when the daemon stopped (its agent is active with only probe
// blockers, and its last probe event started the turn) is taken up again, so its result still counts and a timeout still
// holds it again.
func (l *Lifecycle) resumeProbes(ctx context.Context, now float64) error {
	for account := range l.settings.Get().CostAccounts {
		if !l.probed(account) {
			continue
		}
		rows, err := l.probeHeld(ctx, account)
		if err != nil {
			return err
		}
		l.costProbes.mu.Lock()
		_, running := l.costProbes.states[account]
		if len(rows) == 0 || running {
			l.costProbes.mu.Unlock()
			continue
		}
		l.scheduleProbe(account, 0, now)
		s := l.costProbes.states[account]
		l.costProbes.mu.Unlock()
		kinds := l.probeKinds(account)
		for _, b := range rows {
			a, err := l.db.GetAgent(ctx, b.AgentID)
			if err != nil || a.Lifecycle != "active" || len(pauseOwners(a)) > 0 {
				continue
			}
			if l.onlyProbeBlockers(ctx, a.ID, account, kinds) != nil {
				continue
			}
			events, err := l.db.ListEvents(ctx, a.ID, 200, "")
			if err != nil {
				return err
			}
			var last *db.Event
			for i := range events {
				if events[i].Type == "cost:probe" {
					last = &events[i]
				}
			}
			if last == nil || last.Data == nil {
				continue
			}
			v, err := jsjson.Parse([]byte(*last.Data))
			if err != nil || field(v, "turn") != true {
				continue
			}
			l.costProbes.mu.Lock()
			s.turn = a.ID
			l.costProbes.mu.Unlock()
			break
		}
	}
	return nil
}
