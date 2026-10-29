package lifecycle

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"stam/internal/agentenv"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// compactDedupe is src/lifecycle.ts COMPACT_DEDUPE_MS (S-273): a compaction just done isn't repeated within it.
const compactDedupe = 10 * time.Second

// compactTimeout is the headless /compact run's deadline (the Claude adapter's 600 s).
const compactTimeout = 600 * time.Second

// compactContinuePrompt is src/lifecycle.ts COMPACT_CONTINUE_PROMPT (S-4304): what a compaction that cut into work
// ends with when it carries no prompt of its own.
const compactContinuePrompt = "[stam] Your context was compacted. Continue your task from your compaction notes."

// compactPrompt is the prompt a compaction ends with: its own, else the continue prompt for the reasons that interrupt
// an agent's work (compact_self, the enforcement threshold). An idle compaction (cache lifetime, before a long rest)
// has no work to continue and gets none. Shared by the Claude and OpenCode paths.
func compactPrompt(p *jsjson.Object) string {
	if prompt := pstr(p, "prompt"); prompt != "" {
		return prompt
	}
	switch pstr(p, "reason") {
	case "requested by the agent", "enforcement threshold":
		return compactContinuePrompt
	}
	return ""
}

type compaction struct {
	running bool
	at      time.Time
}

func (l *Lifecycle) compactionBusy(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.busyLocked(id)
}

func (l *Lifecycle) busyLocked(id string) bool {
	c, ok := l.compactions[id]
	return ok && (c.running || time.Since(c.at) < compactDedupe)
}

// errCompactionBusy is a compaction refused because one runs on the agent or just ran.
var errCompactionBusy = errors.New("a compaction runs or just ran")

// reserveCompaction checks and takes the agent's compaction slot in one step, before any I/O: TS checks and starts a
// compaction in one synchronous run, and here two requests (or a request and a turn end's pending) may race, which
// would put two compactors on one session. false when the slot is busy. A reservation ends in trackCompaction, or in
// releaseCompaction when the compaction never starts.
func (l *Lifecycle) reserveCompaction(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.busyLocked(id) {
		return false
	}
	if l.compactions == nil {
		l.compactions = map[string]compaction{}
	}
	l.compactions[id] = compaction{running: true}
	return true
}

func (l *Lifecycle) releaseCompaction(id string) { l.setCompaction(id, nil) }

// droppedCompaction records a compaction request refused because one runs or just ran, and says so.
func (l *Lifecycle) droppedCompaction(ctx context.Context, a db.Agent, reason string) string {
	l.event(ctx, a.ID, "compact:dropped", reasonEvent{Reason: reason})
	return fmt.Sprintf("%s is already compacting or was just compacted; this request is dropped", a.Name)
}

// compactionRunning is src/lifecycle.ts compactionRunning (S-273): the harness is down on purpose, so reconcile must
// not read that as an exit.
func (l *Lifecycle) compactionRunning(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.compactions[id].running
}

// harnessExited is src/lifecycle.ts harnessExited: a harness that exits after a compaction starts a new cycle.
func (l *Lifecycle) harnessExited(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if c, ok := l.compactions[id]; ok && !c.running {
		delete(l.compactions, id)
	}
}

func (l *Lifecycle) setCompaction(id string, c *compaction) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.compactions == nil {
		l.compactions = map[string]compaction{}
	}
	if c == nil {
		delete(l.compactions, id)
	} else {
		l.compactions[id] = *c
	}
}

type opEvent struct {
	Op string `json:"op"`
}

type opFailedEvent struct {
	Op    string `json:"op"`
	Error string `json:"error"`
}

// trackCompaction is src/lifecycle.ts trackCompaction (S-358): one compaction, recorded as a `compact` event with an
// operation id, then `compact:done` or `compact:failed`, so a daemon restart can tell what it cut short. The caller
// holds the agent's reservation (reserveCompaction); it ends here.
func (l *Lifecycle) trackCompaction(ctx context.Context, id string, data *jsjson.Object, run func(op string) error) error {
	op, err := newOp()
	if err != nil {
		l.releaseCompaction(id)
		return err
	}
	ev := copyObject(data)
	ev.Set("op", op)
	l.event(ctx, id, "compact", raw(ev))
	if err := run(op); err != nil {
		l.setCompaction(id, nil)
		l.event(ctx, id, "compact:failed", opFailedEvent{Op: op, Error: err.Error()})
		return err
	}
	l.setCompaction(id, &compaction{at: time.Now()})
	l.event(ctx, id, "compact:done", opEvent{Op: op})
	return nil
}

// admit is src/admission.ts admit for the turns the Go daemon starts (none is the human's): an agent taken over by a
// live successor starts no turn, nor does one with cost blockers, but for the probe blockers its account's probe turn
// runs past (probes.go). Blockers that can't be read refuse it too.
func (l *Lifecycle) admit(ctx context.Context, id, kind string) (bool, string) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return false, "no such agent"
	}
	refuse := func(reason string) (bool, string) {
		l.event(ctx, a.ID, "cost:refused", struct {
			Kind   string `json:"kind"`
			Reason string `json:"reason"`
		}{kind, reason})
		return false, reason
	}
	if a.ForwardedTo != nil && *a.ForwardedTo != "" {
		if s, err := l.db.GetAgent(ctx, *a.ForwardedTo); err == nil && s.Lifecycle != "archived" {
			return refuse("taken over by " + s.Name)
		}
	}
	blocked, err := l.blockedBy(ctx, a.ID)
	if err != nil {
		return false, err.Error()
	}
	if len(blocked) > 0 {
		return refuse(strings.Join(blocked, "; "))
	}
	return true, ""
}

// blockedBy is src/admission.ts blockedBy: what holds the agent, "KIND on ACCOUNT: REASON" per blocker, oldest first,
// without the probe blockers its account's probe turn runs past.
func (l *Lifecycle) blockedBy(ctx context.Context, id string) ([]string, error) {
	rows, err := l.holding(ctx, id)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, b := range rows {
		what := b.Kind
		if b.Account != "" {
			what += " on " + b.Account
		}
		out = append(out, what+": "+b.Reason)
	}
	return out, nil
}

// compactNow is src/lifecycle.ts compactNow: p is the pending compact ({type, instructions?, prompt?, reason}). The
// agent counts as compacting until its relaunch is up.
func (l *Lifecycle) compactNow(ctx context.Context, a db.Agent, p *jsjson.Object) (string, error) {
	if a.Harness != "claude" {
		return "", fmt.Errorf("%s agents can't be compacted by stam", a.Harness)
	}
	if !l.reserveCompaction(a.ID) {
		return l.droppedCompaction(ctx, a, pstr(p, "reason")), nil
	}
	if ok, reason := l.admit(ctx, a.ID, "compact"); !ok {
		l.releaseCompaction(a.ID)
		pending := jsjson.NewObject("type", "compact")
		for _, k := range without(p, "type").Keys() {
			v, _ := p.Get(k)
			pending.Set(k, v)
		}
		if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: text(pending)}); err != nil {
			return "", err
		}
		return fmt.Sprintf("%s is blocked (%s); it compacts after it runs again", a.Name, reason), nil
	}
	// a may be stale (the idle sweep's row, a request's): the agent is claimed only if it is still idle in the same
	// idle period. A turn started since means it isn't idle: the compaction waits for that turn's end.
	claimed, err := l.db.ClaimIdle(ctx, a.ID, a.IdleSince, "compacting: "+pstr(p, "reason"))
	if err != nil {
		l.releaseCompaction(a.ID)
		return "", err
	}
	if !claimed {
		l.releaseCompaction(a.ID)
		if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: text(p)}); err != nil {
			return "", err
		}
		l.event(ctx, a.ID, "pending", raw(p))
		return l.waiting(a), nil
	}
	return "", l.trackCompaction(ctx, a.ID, p, func(op string) error {
		if err := l.compactClaude(ctx, a, pstr(p, "instructions"), op); err != nil {
			return err
		}
		l.markCompacted(ctx, a.ID)
		fresh, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		return l.StartHarness(ctx, fresh, compactPrompt(p), true, "compact")
	})
}

// RequestCompaction is src/lifecycle.ts requestCompaction: compacted when the agent's turn ends, with no wrap-up; a
// shut-down agent is compacted headless and resumed now (S-257). A request while one runs, or just after, is dropped.
func (l *Lifecycle) RequestCompaction(ctx context.Context, a db.Agent, instructions, reason string) (string, error) {
	return l.requestCompaction(ctx, a, instructions, "", reason)
}

// RequestCompactionNote is RequestCompaction for compact_self's prompt: the note the agent gets after the compaction is
// the compacted-self template around it (src/daemon.ts case 'compact'). The lessons and workspace blocks aren't ported
// (context.go), so the note renders without them.
func (l *Lifecycle) RequestCompactionNote(ctx context.Context, a db.Agent, instructions, prompt, reason string) (string, error) {
	note, err := l.render("compacted-self", map[string]string{"history": historyOf(a), "prompt": prompt, "lessons": "", "workspace": ""})
	if err != nil {
		return "", err
	}
	return l.requestCompaction(ctx, a, instructions, note, reason)
}

// requestCompaction is RequestCompaction with a prompt the relaunch types in after the compaction (the forced
// compaction's note); a shut-down agent's resume has its own note, as in TS.
func (l *Lifecycle) requestCompaction(ctx context.Context, a db.Agent, instructions, prompt, reason string) (string, error) {
	if a.Harness == "opencode" && a.Lifecycle != "shut_down" {
		return l.ocRequest(ctx, a, instructions, prompt, reason, nil)
	}
	if l.compactionBusy(a.ID) {
		return l.droppedCompaction(ctx, a, reason), nil
	}
	if a.Lifecycle == "shut_down" {
		r, err := l.compactAndResume(ctx, a, instructions)
		if errors.Is(err, errCompactionBusy) {
			return l.droppedCompaction(ctx, a, reason), nil
		}
		return r, err
	}
	p := jsjson.NewObject("type", "compact")
	if instructions != "" {
		p.Set("instructions", instructions)
	}
	if prompt != "" {
		p.Set("prompt", prompt)
	}
	p.Set("reason", reason)
	return l.whenIdle(ctx, a, p, "")
}

// compactShutDown is src/lifecycle.ts compactShutDown (S-257): a shut-down agent's conversation compacted headless on
// its own session, before any resume.
func (l *Lifecycle) compactShutDown(ctx context.Context, a db.Agent, instructions, reason string) error {
	if a.SessionID == nil || *a.SessionID == "" {
		return fmt.Errorf("%s has no session to compact", a.Name)
	}
	if a.Harness != "claude" {
		return fmt.Errorf("%s agents can't be compacted by stam", a.Harness)
	}
	if !l.reserveCompaction(a.ID) {
		return fmt.Errorf("can't compact %s: %w", a.Name, errCompactionBusy)
	}
	return l.trackCompaction(ctx, a.ID, jsjson.NewObject("reason", reason, "headless", true), func(op string) error {
		if err := l.compactClaude(ctx, a, instructions, op); err != nil {
			return err
		}
		l.markCompacted(ctx, a.ID)
		return nil
	})
}

func (l *Lifecycle) compactAndResume(ctx context.Context, a db.Agent, instructions string) (string, error) {
	release, err := l.acquire(a, "resume")
	if err != nil {
		return "", err
	}
	defer release()
	if err := l.compactShutDown(ctx, a, instructions, "shut down"); err != nil {
		return "", err
	}
	note, err := l.render("respawn-context-exit", nil)
	if err != nil {
		return "", err
	}
	fresh, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return "", err
	}
	return l.resumeLocked(ctx, fresh, note)
}

// compactClaude is src/adapters/claude.ts compact: a live Claude Code session can't be compacted from outside, so its
// session is killed and /compact runs headless on the same session. The command goes in on stdin (instructions on a
// command line would show in ps), and the compactor carries STAM_COMPACTOR=id:op so a later daemon can find it.
func (l *Lifecycle) compactClaude(ctx context.Context, a db.Agent, instructions, op string) error {
	if err := l.tmux.KillSession(ctx, a.ID); err != nil {
		return err
	}
	if a.SessionID == nil || *a.SessionID == "" {
		return fmt.Errorf("%s has no session to compact", a.Name)
	}
	args := []string{"-p", "--resume", *a.SessionID, "--output-format", "json"}
	if a.Model != nil && *a.Model != "" {
		args = append(args, "--model", *a.Model)
	}
	bin := l.claude.ClaudeBin
	if bin == "" {
		bin = "claude"
	}
	ctx, cancel := context.WithTimeout(ctx, compactTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = a.Cwd
	cmd.Env = append(withoutEnv(os.Environ(), append(agentenv.Names(), "STAM_COMPACTOR", "MOOTR_COMPACTOR")...), "STAM_AGENT_ID=", "MOOTR_AGENT_ID=", "STAM_COMPACTOR="+a.ID+":"+op, "MOOTR_COMPACTOR="+a.ID+":"+op)
	cmd.Stdin = bytes.NewReader([]byte(jsjson.Trim("/compact " + instructions)))
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = io.Discard, &out
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return fmt.Errorf("compaction timed out after %s", compactTimeout)
		}
		return fmt.Errorf("Command failed: %s\n%s", bin, out.String())
	}
	return nil
}

// withoutEnv is env with the named variables left out.
func withoutEnv(env []string, names ...string) []string {
	out := env[:0:0]
	for _, kv := range env {
		keep := true
		for _, n := range names {
			if len(kv) > len(n) && kv[:len(n)+1] == n+"=" {
				keep = false
			}
		}
		if keep {
			out = append(out, kv)
		}
	}
	return out
}

// repairSession is src/adapters/claude.ts repairSession (S-358): a compactor stopped mid-run leaves at most a last row
// cut short; the transcript is trimmed back to its last newline, looking at most 1 MiB back.
func repairSession(a db.Agent) error {
	if a.TranscriptPath == nil || *a.TranscriptPath == "" {
		return nil
	}
	f, err := os.OpenFile(*a.TranscriptPath, os.O_RDWR, 0)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	size := info.Size()
	n := min(size, 1<<20)
	tail := make([]byte, n)
	if _, err := f.ReadAt(tail, size-n); err != nil && err != io.EOF {
		return err
	}
	if n == 0 || tail[n-1] == '\n' {
		return nil
	}
	nl := bytes.LastIndexByte(tail, '\n')
	// A row longer than the tail read is left alone rather than guessed at.
	if nl >= 0 || n == size {
		return f.Truncate(size - n + int64(nl) + 1)
	}
	return nil
}

// newOp is crypto.randomUUID.
func newOp() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
