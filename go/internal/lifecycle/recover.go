package lifecycle

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/proctree"
)

// networkProbes is src/lifecycle.ts NETWORK_PROBES: any answer from one means the network is up.
var networkProbes = []string{"https://api.anthropic.com", "https://api.openai.com", "https://openrouter.ai"}

// recoverStagger is src/lifecycle.ts STAGGER_MS: the wait between resumes, so many harnesses don't start at once.
const recoverStagger = 3 * time.Second

// networkWait is how long recoverLost waits for the network before it tries anyway (ten minutes).
const networkWait = 10 * time.Minute

// being is src/lifecycle.ts BEING: how a refusal names the transition that holds the agent.
var being = map[string]string{"archive": "archived", "switch": "switched", "resume": "resumed"}

// transition is one agent's held transition lock: its kind, and a token of its own so a release removes only it.
type transition struct{ kind string }

// acquire is src/lifecycle.ts acquire: one transition (a cost switch, its rollback included, or a resume) at a time per
// agent, held for its whole run. It refuses while another holds the agent, naming that one.
func (l *Lifecycle) acquire(a db.Agent, kind string) (func(), error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.acquireLocked(a, kind)
}

// Archiving is the agents whose archive is in flight: from its transition lock, taken before the harness stops, to its
// release, after the row is marked archived or the archive failed. The developer slot queue counts them as holders, so
// a slot frees only once the archive has finished with the worktree.
func (l *Lifecycle) Archiving() map[string]bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]bool{}
	for id, t := range l.transitions {
		if t.kind == "archive" {
			out[id] = true
		}
	}
	return out
}

// acquireLocked is acquire under l.mu, which the caller holds; the release takes it itself.
func (l *Lifecycle) acquireLocked(a db.Agent, kind string) (func(), error) {
	if held := l.transitions[a.ID]; held != nil {
		return nil, fmt.Errorf("%s is being %s; try again when it is done", a.Name, being[held.kind])
	}
	if l.transitions == nil {
		l.transitions = map[string]*transition{}
	}
	token := &transition{kind: kind}
	l.transitions[a.ID] = token
	released := false
	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		if !released && l.transitions[a.ID] == token {
			delete(l.transitions, a.ID)
		}
		released = true
	}, nil
}

// takenOverBy is src/lifecycle.ts takenOverBy: the live successor a cost switch moved the agent's work to.
func (l *Lifecycle) takenOverBy(ctx context.Context, a db.Agent) (db.Agent, bool) {
	if a.ForwardedTo == nil || *a.ForwardedTo == "" {
		return db.Agent{}, false
	}
	s, err := l.db.GetAgent(ctx, *a.ForwardedTo)
	return s, err == nil && s.Lifecycle != "archived"
}

// assertNotTakenOver is src/lifecycle.ts assertNotTakenOver.
func (l *Lifecycle) assertNotTakenOver(ctx context.Context, a db.Agent) error {
	cur, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		cur = a
	}
	s, ok := l.takenOverBy(ctx, cur)
	if !ok {
		return nil
	}
	return fmt.Errorf("%s was taken over by %s: switch back with `cost_switch %s %s`, or archive %s first", cur.Name, s.Name, s.Name, l.presetFor(cur), s.Name)
}

// presetFor is the first registry preset (defaults, then the user registry (the home's cached copy on a peer) over them by name) of the agent's
// harness and model, else PRESET.
func (l *Lifecycle) presetFor(a db.Agent) string {
	merged := jsjson.NewObject()
	defaults, _ := readJSON(filepath.Join(l.claude.Templates.Root, "registry", "defaults.json"))
	user := jsjson.Value(l.claude.Templates.UserRegistry())
	dropped := map[string]bool{}
	for _, doc := range []jsjson.Value{defaults, user} {
		o, _ := doc.(*jsjson.Object)
		p, _ := o.Get("presets")
		po, _ := p.(*jsjson.Object)
		for _, k := range po.Keys() {
			v, _ := po.Get(k)
			merged.Set(k, v)
			dropped[k] = v == nil
		}
	}
	model := ""
	if a.Model != nil {
		model = *a.Model
	}
	for _, k := range merged.Keys() {
		if dropped[k] {
			continue
		}
		v, _ := merged.Get(k)
		o, _ := v.(*jsjson.Object)
		h, _ := o.Get("harness")
		m, _ := o.Get("model")
		ms, _ := m.(string)
		if h == a.Harness && ms == model {
			return k
		}
	}
	return "PRESET"
}

// Resume is src/lifecycle.ts resume for a shut-down agent: it comes back on its session, told where it is. Bringing
// back an archived agent (its workspace restored) isn't ported.
func (l *Lifecycle) Resume(ctx context.Context, a db.Agent, note string) (string, error) {
	release, err := l.acquire(a, "resume")
	if err != nil {
		return "", err
	}
	defer release()
	return l.resumeLocked(ctx, a, note)
}

func (l *Lifecycle) resumeLocked(ctx context.Context, a db.Agent, note string) (string, error) {
	if err := l.assertNotTakenOver(ctx, a); err != nil {
		return "", err
	}
	if a.Lifecycle == "archived" {
		return "", fmt.Errorf("can't resume %s: resuming an archived agent isn't ported to the Go daemon yet; resume it with the TypeScript daemon", a.Name)
	}
	if a.Lifecycle != "shut_down" {
		return "", fmt.Errorf("%s is %s", a.Name, a.Lifecycle)
	}
	if a.SessionID == nil || *a.SessionID == "" {
		return "", fmt.Errorf("%s has no session to resume", a.Name)
	}
	if err := restoreTranscript(a.TranscriptPath); err != nil {
		return "", err
	}
	text, err := l.render("respawn", map[string]string{"cwd": a.Cwd, "note": note})
	if err != nil {
		return "", err
	}
	if err := l.StartHarness(ctx, a, text, true, "resume"); err != nil {
		return "", err
	}
	return "resuming", nil
}

// restoreTranscript is src/transcript-gz.ts restoreTranscript: a gzipped transcript goes back to its recorded path,
// and the .gz is removed. Nothing to restore is no error; a failed restore leaves the .gz.
func restoreTranscript(path *string) error {
	if path == nil || *path == "" {
		return nil
	}
	if _, err := os.Stat(*path); err == nil {
		return nil
	}
	gz := *path + ".gz"
	in, err := os.Open(gz)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer in.Close()
	r, err := gzip.NewReader(in)
	if err != nil {
		return err
	}
	tmp := *path + ".restore"
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, r)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, *path)
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Remove(gz)
}

// lostOpts are src/lifecycle.ts markLost's options.
type lostOpts struct {
	compact     bool
	tokens      float64
	interrupted *string
}

// markLost is src/lifecycle.ts markLost: shut down, with a pending recover that recoverLost runs (so a daemon restart
// before it still resumes the agent), or without one when there is no session to resume.
func (l *Lifecycle) markLost(ctx context.Context, a db.Agent, reason string, o lostOpts) {
	l.invalidate(a.ID)
	if a.SessionID == nil || *a.SessionID == "" {
		l.update(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
			db.Field{Col: "activity_detail", Val: reason + "; not resumed: no session to resume"}, db.Field{Col: "pending_action", Val: nil})
		l.event(ctx, a.ID, "tmux-lost", lostEvent{Reason: reason, Resume: false})
		return
	}
	pending := jsjson.NewObject("type", "recover", "reason", reason)
	if o.compact {
		pending.Set("compact", true)
		pending.Set("tokens", o.tokens)
	}
	if o.interrupted != nil {
		pending.Set("interrupted", *o.interrupted)
	}
	detail := reason + "; resuming"
	if o.compact {
		detail = "compacting, then resuming"
	}
	l.update(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
		db.Field{Col: "activity_detail", Val: detail}, db.Field{Col: "pending_action", Val: text(pending)})
	l.event(ctx, a.ID, "tmux-lost", lostEvent{Reason: reason, Resume: true})
}

func isLost(a db.Agent) bool {
	p := pendingOf(a)
	return a.Lifecycle == "shut_down" && p != nil && pstr(p, "type") == "recover"
}

// round is Math.round for the sizes stam reports.
func round(x float64) float64 { return math.Floor(x + 0.5) }

func contextTokens(a db.Agent) float64 {
	if a.ContextTokens == nil {
		return 0
	}
	return float64(*a.ContextTokens)
}

type contextExitEvent struct {
	Tokens  float64 `json:"tokens"`
	Resumed bool    `json:"resumed"`
}

// contextExit is src/lifecycle.ts contextExit (S-220): a harness that exits near its context limit is compacted and
// resumed once; a second exit within settings.exitRecovery.repeatMinutes isn't. Its parent hears either way.
func (l *Lifecycle) contextExit(ctx context.Context, a db.Agent) bool {
	s := l.settings.Get().ExitRecovery
	tokens := contextTokens(a)
	if tokens < s.WindowTokens*s.PercentOfWindow/100 {
		return false
	}
	since := time.Now().Add(-time.Duration(s.RepeatMinutes * float64(time.Minute))).UTC().Format("2006-01-02T15:04:05.000Z")
	again := false
	if events, err := l.db.ListEvents(ctx, a.ID, 1000, "exit:context"); err == nil {
		for _, e := range events {
			var d contextExitEvent
			if e.TS > since && e.Decode(&d) == nil && d.Resumed {
				again = true
			}
		}
	}
	resume := !again && a.SessionID != nil && *a.SessionID != ""
	l.event(ctx, a.ID, "exit:context", contextExitEvent{Tokens: tokens, Resumed: resume})
	if resume {
		l.markLost(ctx, a, "harness exited", lostOpts{compact: true, tokens: tokens})
	} else {
		l.tellParent(ctx, a, fmt.Sprintf("%s exited at %sk context again; not resumed.", a.Name, jsjson.Number(round(tokens/1000))))
	}
	return resume
}

// compactionInterrupted is src/lifecycle.ts compactionInterrupted (S-358): whether the agent's latest launch or
// compaction event is a `compact` with nothing after it, and that compaction's operation id.
func (l *Lifecycle) compactionInterrupted(ctx context.Context, a db.Agent) (string, bool) {
	e, err := l.db.LatestEvent(ctx, a.ID, []string{"compact", "compact:done", "compact:failed", "spawn", "resume", "exited", "tmux-lost"})
	if err != nil || e == nil || e.Type != "compact" {
		return "", false
	}
	var d struct {
		Op string `json:"op"`
	}
	_ = e.Decode(&d)
	return d.Op, true
}

type compactionExitEvent struct {
	Tokens float64 `json:"tokens"`
	Op     string  `json:"op"`
}

// compactionExit is src/lifecycle.ts compactionExit (S-358): a compaction the daemon's restart cut short is finished and
// the agent resumed, quietly. True when it was one.
func (l *Lifecycle) compactionExit(ctx context.Context, a db.Agent) bool {
	op, ok := l.compactionInterrupted(ctx, a)
	if !ok {
		return false
	}
	tokens := contextTokens(a)
	l.event(ctx, a.ID, "exit:compaction", compactionExitEvent{Tokens: tokens, Op: op})
	l.markLost(ctx, a, "stam restarted during a compaction", lostOpts{compact: true, tokens: tokens, interrupted: &op})
	return true
}

// recoverLostSoon runs recoverLost in the background, as reconcile does. A call while one runs makes it run once more,
// so an agent marked lost after its last look isn't left until the next loss.
func (l *Lifecycle) recoverLostSoon() {
	l.mu.Lock()
	if l.recovering {
		l.recoverAgain = true
		l.mu.Unlock()
		return
	}
	l.recovering = true
	l.mu.Unlock()
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		for {
			l.recoverLost(l.ctx)
			l.mu.Lock()
			if !l.recoverAgain || l.ctx.Err() != nil {
				l.recovering, l.recoverAgain = false, false
				l.mu.Unlock()
				return
			}
			l.recoverAgain = false
			l.mu.Unlock()
		}
	}()
}

// recoverLost is src/lifecycle.ts recoverLost: every agent markLost marked is resumed, one at a time, once the network
// is up.
func (l *Lifecycle) recoverLost(ctx context.Context) {
	for waited := false; ctx.Err() == nil; {
		agents, err := l.db.ListAgents(ctx)
		if err != nil {
			slog.Error("resuming agents failed", "err", err)
			return
		}
		var lost []db.Agent
		for _, a := range agents {
			if isLost(a) {
				lost = append(lost, a)
			}
		}
		if len(lost) == 0 {
			return
		}
		if !waited {
			l.waitForNetwork(ctx)
		}
		waited = true
		for _, a := range lost {
			l.recoverOne(ctx, a.ID)
			if sleep(ctx, l.stagger) != nil {
				return
			}
		}
	}
}

// waitForNetwork is src/lifecycle.ts waitForNetwork: at boot the daemon can start before the network is up. It waits
// up to networkWait for any probe to answer, 5 s per try, then lets the launches try anyway.
func (l *Lifecycle) waitForNetwork(ctx context.Context) {
	deadline := time.Now().Add(networkWait)
	client := &http.Client{Timeout: 5 * time.Second}
	for time.Now().Before(deadline) {
		up := make(chan bool, len(l.probes))
		for _, u := range l.probes {
			go func(u string) {
				req, err := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
				if err != nil {
					up <- false
					return
				}
				resp, err := client.Do(req)
				if err == nil {
					resp.Body.Close()
				}
				up <- err == nil
			}(u)
		}
		for range l.probes {
			if <-up {
				return
			}
		}
		if sleep(ctx, 5*time.Second) != nil {
			return
		}
	}
}

type recoverEvent struct {
	Reason    string `json:"reason"`
	Compacted bool   `json:"compacted,omitempty"`
}

type pidsEvent struct {
	Pids []int `json:"pids"`
}

// recoverOne is src/lifecycle.ts recoverOne. The recover action stays set until the resume launches, so a daemon
// restart meanwhile still recovers the agent; a failure clears it. A context exit is compacted headless first.
func (l *Lifecycle) recoverOne(ctx context.Context, id string) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil || !isLost(a) {
		return
	}
	intent := *a.PendingAction
	p := pendingOf(a)
	reason := pstr(p, "reason")
	interrupted := phas(p, "interrupted")
	compacting := ptruthy(p, "compact") && a.Harness == "claude"
	compactAsked := ptruthy(p, "compact") || ptruthy(p, "compacted")
	parent := l.parentOrChief(ctx, a)
	tokens, _ := pnum(p, "tokens")
	size := jsjson.Number(round(tokens/1000)) + "k"
	stage := "resume"
	fail := func(err error) {
		now, gerr := l.db.GetAgent(ctx, id)
		fields := []db.Field{{Col: "activity_detail", Val: reason + "; not resumed: " + err.Error()}}
		if gerr == nil && now.PendingAction != nil && *now.PendingAction == intent {
			fields = append(fields, db.Field{Col: "pending_action", Val: nil})
		}
		l.update(ctx, id, fields...)
		l.event(ctx, id, "recover-error", err.Error())
		if parent != "" && compactAsked {
			failed := "resume failed: " + err.Error() + "; still shut down"
			if stage == "compaction" {
				failed = fmt.Sprintf("compaction failed: %s; still shut down, run `stam compact %s` to retry", err.Error(), a.Name)
			}
			l.QueueNotice(ctx, parent, fmt.Sprintf("%s exited at %s context; %s.", a.Name, size, failed), false)
		}
	}
	if _, err := os.Stat(a.Cwd); err != nil {
		fail(fmt.Errorf("its workspace %s is gone", a.Cwd))
		return
	}
	if compacting {
		stage = "compaction"
		// A compactor a restart cut off from the daemon may still run on the session: it is stopped, and confirmed gone,
		// before this compaction starts, so there are never two.
		if a.SessionID != nil && *a.SessionID != "" {
			left := proctree.CompactorProcesses(a.ID, *a.SessionID, a.Cwd)
			if len(left) > 0 {
				pids := make([]int, 0, len(left))
				for pid := range left {
					pids = append(pids, pid)
				}
				sort.Ints(pids)
				l.event(ctx, id, "compact:killed", pidsEvent{Pids: pids})
				if err := proctree.StopAndConfirm(ctx, left, 5*time.Second); err != nil {
					fail(err)
					return
				}
			}
			if err := repairSession(a); err != nil {
				fail(err)
				return
			}
		}
		if err := l.compactShutDown(ctx, a, "", "shut down"); err != nil {
			fail(err)
			return
		}
		stage = "resume"
		// Compacted: a restart before the resume below resumes without compacting again.
		if cur, err := l.db.GetAgent(ctx, id); err == nil && cur.PendingAction != nil && *cur.PendingAction == intent {
			next := without(p, "compact")
			next.Set("compacted", true)
			intent = text(next)
			l.update(ctx, id, db.Field{Col: "pending_action", Val: intent})
		}
	}
	// A human may have resumed, paused, or archived it while it compacted.
	now, err := l.db.GetAgent(ctx, id)
	if err != nil || now.PendingAction == nil || *now.PendingAction != intent || !isLost(now) {
		if err == nil && now.PendingAction != nil && *now.PendingAction == intent {
			l.update(ctx, id, db.Field{Col: "pending_action", Val: nil})
		}
		var lc any
		if err == nil {
			lc = now.Lifecycle
		}
		l.event(ctx, id, "recover:cancelled", struct {
			Lifecycle any `json:"lifecycle,omitempty"`
		}{lc})
		return
	}
	compacted := compacting || ptruthy(p, "compacted")
	var note string
	switch {
	case interrupted:
		note, err = l.render("respawn-compaction-restart", nil)
	case compacted:
		note, err = l.render("respawn-context-exit", nil)
	case ptruthy(p, "compact"):
		note, err = l.renderWithRetro("respawn-context-exit-self", nil)
	default:
		note, err = l.render("respawn-reboot", map[string]string{"reason": reason})
	}
	if err == nil {
		_, err = l.Resume(ctx, now, note)
	}
	if err != nil {
		fail(err)
		return
	}
	l.event(ctx, id, "recover", recoverEvent{Reason: reason, Compacted: compacted})
	if parent != "" && compactAsked && !interrupted {
		how := "resumed"
		if compacted {
			how = "compacted and resumed"
		}
		l.QueueNotice(ctx, parent, fmt.Sprintf("%s exited at %s context; %s.", a.Name, size, how), false)
	}
}

// firstPromptLost is src/lifecycle.ts firstPromptLost (S-759): a spawn a daemon restart cut off before its first prompt
// went in: starting, the prompt stored, and no delivery marker.
func (l *Lifecycle) firstPromptLost(ctx context.Context, a db.Agent) bool {
	if a.Activity != "starting" || a.Lifecycle != "active" || a.FirstPrompt == nil || *a.FirstPrompt == "" {
		return false
	}
	if l.isHeld(ctx, a) {
		return false
	}
	if _, ok := l.takenOverBy(ctx, a); ok {
		return false
	}
	return l.hasEvent(ctx, a.ID, "first-prompt:pending") && !l.hasEvent(ctx, a.ID, "first-prompt:delivered")
}

type errorEvent struct {
	Error string `json:"error"`
}

// recoverFirstPrompt is src/lifecycle.ts recoverFirstPrompt: a fresh launch carrying the prompt, since an agent whose
// prompt never went in has no conversation to resume. A failure leaves the agent errored and tells its parent.
func (l *Lifecycle) recoverFirstPrompt(ctx context.Context, a db.Agent) {
	l.event(ctx, a.ID, "first-prompt:recover", nil)
	launched, err := l.startHarness(ctx, a, *a.FirstPrompt, false, "spawn")
	if err == nil && launched != nil {
		err = <-launched
	}
	if err == nil || ctx.Err() != nil {
		return
	}
	msg := err.Error()
	l.update(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "errored"},
		db.Field{Col: "activity_detail", Val: "first prompt not delivered: " + msg})
	l.event(ctx, a.ID, "first-prompt:failed", errorEvent{Error: msg})
	l.tellParent(ctx, a, fmt.Sprintf("%s never got its first prompt (%s); respawn it.", a.Name, msg))
}

// RestoreTranscript is restoreTranscript for the agent view, which reads an archived agent's transcript.
func RestoreTranscript(path *string) error {
	return restoreTranscript(path)
}
