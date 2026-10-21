// Package lifecycle starts, watches and stops agents' harnesses (S-2820, S-2848): src/lifecycle.ts startHarness and
// quitHarness, the Claude Code adapter's launch dialogs and first prompt (src/adapters/claude.ts afterLaunch), forget,
// what a hook or a status-line report changes (src/daemon.ts onHook and the status-line gate), pending stops,
// compaction, restart and resume, and reconcile (src/daemon.ts reconcile) with the recovery of lost agents.
//
// Every tmux call has a deadline (internal/tmux), and a launch's first prompt is typed in the background under the
// daemon's own context, so a daemon stop ends it. A restart leaves the tmux server and its sessions running: the first
// reconcile compares the server with the one seen at start and leaves live sessions alone.
//
// Context thresholds, their enforcement and the idle compaction (context.go), and the cold-wake measurement
// (cachecold.go) run from status-line reports, which the Claude transcript reader (claude.Transcripts) feeds, and so do
// the usage tables (usage.go).
//
// Mail, notices and stam's own prompts reach an idle Claude Code agent over its shim's push stream (push.go), and a
// working one in its next PostToolUse hook's answer.
//
// Only Claude Code is ported. Not yet: cost blockers and fallbacks and the other cost signals (a blocker the TS daemon
// recorded still holds a push), archives (a pending one is left for the TS daemon), resuming an archived agent, waits
// the hooks keep, permission dialogs, and the rest clock.
package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"stam/internal/adapters"
	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/push"
	"stam/internal/tmux"
)

// Lifecycle runs one daemon's agents.
type Lifecycle struct {
	db       *db.DB
	tmux     *tmux.Client
	settings *config.SettingsFile
	claude   claude.Env
	url      string
	machine  string
	probes   []string
	stagger  time.Duration
	// ctx is the daemon's: background work (a launch's first prompt) ends with it.
	ctx context.Context

	// orgMu guards the org observers' queue (org.go): the changes the db handed over, waiting for the org goroutine
	// (orgWake wakes it), whether it is handling some (orgBusy), how it mails the human and reaches an agent on another
	// machine, the tree-idle notices on their way to one (treeIdlePending), and what reports an ITSA owner's stop.
	orgMu           sync.Mutex
	orgQueue        []db.ActivityChange
	orgWake         chan struct{}
	orgBusy         bool
	mailHuman       func(ctx context.Context, from, subject, body string) error
	tellPeer        TellPeer
	treeIdlePending map[string]bool
	ownerStopped    func(ctx context.Context, id, name, what string)
	// peerRetryFor is how long deliver tries a machine that doesn't answer; 0 for a day (tests shorten it).
	peerRetryFor time.Duration

	mu sync.Mutex
	// gens is each agent's launch generation (S-578): a stop takes the next one, so a launch still in flight notices
	// it is no longer wanted and starts nothing.
	gens map[string]int
	bg   sync.WaitGroup
	// bgRunning counts the goBG work still running, for a test to wait on.
	bgRunning atomic.Int64
	// onDialogStep is a test's hook into AnswerDialog (dialogStep); nil outside tests.
	onDialogStep func(step string)
	// waited is set, under mu, once Wait began: work a timer would start then starts no more (bg.Add must not race
	// bg.Wait).
	waited bool
	// dialogs makes and closes the permission requests of harness dialogs (SetDialogs), under mu.
	dialogs Dialogs

	// notices is each agent's queued stam notices (QueueNotice), held under mu; noticeSeq numbers them.
	notices   map[string][]notice
	noticeSeq uint64
	// pushTimers is each agent's debounced push (SchedulePush) and pushRuns how many of its fired pushes run,
	// pushHolds the agents stam types into (HoldingPushes), and pushLocks each agent's push lock, so two pushes never
	// build the same prompt; all under mu.
	pushTimers map[string]*time.Timer
	pushRuns   map[string]int
	pushHolds  map[string]int
	pushLocks  map[string]*sync.Mutex
	// streams is the shims' push streams; nil pushes nothing.
	streams *push.Streams
	// debounce is the wait before a scheduled push runs.
	debounce time.Duration
	// compactions is the compactions running or just done (src/lifecycle.ts compactions), under mu.
	compactions map[string]compaction
	// transitions is the agents being resumed (src/lifecycle.ts acquire), under mu.
	transitions map[string]bool
	// recovering is a recoverLost running; recoverAgain asks it for one more pass.
	recovering, recoverAgain bool
	// measureNext is the agents whose next size report is their post-compaction size (src/context.ts), under mu.
	measureNext map[string]bool
	// idleCompacted is each agent's idle period (idle_since) its idle compaction was asked in, under mu.
	idleCompacted map[string]string

	// statusLocks is each agent's status-line lock (statusLock), under mu.
	statusLocks map[string]*sync.Mutex

	live Live
	// usage is the usage tables' throttles (usage.go), under mu.
	usage usageState

	// transcripts is the Claude transcript usage reader's state.
	transcripts claude.Transcripts

	reconcile reconcileState
	gate      statusGate
	clients   clientCache
}

// Options is what a Lifecycle needs.
type Options struct {
	DB       *db.DB
	Tmux     *tmux.Client
	Settings *config.SettingsFile
	// Claude is the Claude Code launch's env; its Settings field is filled from Settings at each launch.
	Claude claude.Env
	// URL is the STAM_URL agents call back on.
	URL string
	// Machine is this daemon's machine name.
	Machine string
	// NetworkProbes are the URLs recoverLost waits on before it resumes lost agents, networkProbes when nil; any
	// answer means the network is up. Tests point them at a local server.
	NetworkProbes []string
	// RecoverStagger is the wait between those resumes, recoverStagger when 0.
	RecoverStagger time.Duration
	// Live is the live stream the usage tables tell of a change (the daemon's sse.Hub); nil tells nothing.
	Live Live
	// Streams is the shims' push streams, which carry Claude Code agents' prompts; nil pushes nothing.
	Streams *push.Streams
	// PushDebounce is the wait before a scheduled push runs, pushDebounce when 0.
	PushDebounce time.Duration
}

// Live is the part of the live stream (sse.Hub) the lifecycle sends to.
type Live interface {
	Emit(event string, data any) error
	AgentChanged(id string, patch *jsjson.Object)
}

type noLive struct{}

func (noLive) Emit(string, any) error              { return nil }
func (noLive) AgentChanged(string, *jsjson.Object) {}

// New returns the lifecycle of a daemon whose background work runs under ctx.
func New(ctx context.Context, o Options) *Lifecycle {
	l := &Lifecycle{db: o.DB, tmux: o.Tmux, settings: o.Settings, claude: o.Claude, url: o.URL, machine: o.Machine, ctx: ctx, gens: map[string]int{},
		probes: o.NetworkProbes, stagger: o.RecoverStagger, live: o.Live, streams: o.Streams, debounce: o.PushDebounce,
		orgWake: make(chan struct{}, 1)}
	if l.live == nil {
		l.live = noLive{}
	}
	if l.probes == nil {
		l.probes = networkProbes
	}
	if l.stagger == 0 {
		l.stagger = recoverStagger
	}
	if l.debounce == 0 {
		l.debounce = pushDebounce
	}
	return l
}

// Wait waits for the background work to end, after the daemon's context ended.
func (l *Lifecycle) Wait() {
	l.mu.Lock()
	l.waited = true
	l.mu.Unlock()
	l.bg.Wait()
}

func (l *Lifecycle) nextGen(id string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.gens[id]++
	return l.gens[id]
}

// invalidate cancels any launch in flight for the agent (src/lifecycle.ts invalidateLaunch).
func (l *Lifecycle) invalidate(id string) { l.nextGen(id) }

func (l *Lifecycle) current(id string, gen int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.gens[id] == gen
}

// mintToken is src/agent-token.ts mintAgentToken: a new token per launch, the agent's own (S-237), of which only the
// hash is stored. The token itself goes only into the session's env.
func (l *Lifecycle) mintToken(ctx context.Context, id string) (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	if err := l.db.SetTokenHash(ctx, id, auth.Hash(token)); err != nil {
		return "", err
	}
	return token, nil
}

func (l *Lifecycle) event(ctx context.Context, id, typ string, data any) {
	if err := l.db.AddEvent(ctx, id, typ, data); err != nil {
		slog.Error("lifecycle: event not recorded", "agent", id, "type", typ, "err", err)
	}
}

// heldBy is the pause owners of src/lifecycle.ts isHeld: someone paused the agent. Cost blockers aren't ported.
func heldBy(a db.Agent) []string {
	owners, err := a.PausedByOf()
	if err != nil {
		return nil
	}
	return owners
}

type spawnEvent struct {
	Argv   []string `json:"argv"`
	Prompt bool     `json:"prompt"`
}

type heldEvent struct {
	Owners   []string `json:"owners"`
	Blockers []string `json:"blockers"`
}

// StartHarness is src/lifecycle.ts startHarness: it starts the agent's harness in a new tmux session, a fresh launch
// or a resume, and types the prompt in once the harness is up (in the background). A held agent comes back paused,
// without the prompt.
func (l *Lifecycle) StartHarness(ctx context.Context, a db.Agent, prompt string, resume bool, kind string) error {
	_, err := l.startHarness(ctx, a, prompt, resume, kind)
	return err
}

// startHarness is StartHarness, with `launched`: it gets the afterLaunch's outcome (nil once the prompt went in) and is
// closed, or is nil when no launch ran (superseded).
func (l *Lifecycle) startHarness(ctx context.Context, a db.Agent, prompt string, resume bool, kind string) (<-chan error, error) {
	if a.Harness != "claude" {
		return nil, fmt.Errorf("%s runs %s, which the Go daemon can't control yet", a.Name, a.Harness)
	}
	gen := l.nextGen(a.ID)
	held := len(heldBy(a)) > 0
	if held && prompt != "" {
		l.event(ctx, a.ID, "launch-held", heldEvent{Owners: heldBy(a), Blockers: []string{}})
		prompt = ""
	}
	env := l.claude
	env.Settings = l.settings.Get()
	spec, err := claude.Launch(ctx, env, a, resume, claude.Parts{})
	if err != nil {
		return nil, err
	}
	if !l.current(a.ID, gen) {
		return nil, nil
	}
	if now, err := l.db.GetAgent(ctx, a.ID); err == nil && now.ForwardedTo != nil && *now.ForwardedTo != "" {
		return nil, fmt.Errorf("%s was taken over while it started", a.Name)
	}
	if err := l.tmux.KillSession(ctx, a.ID); err != nil {
		return nil, err
	}
	token, err := l.mintToken(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	sessionEnv := adapters.SessionEnv(spec.Env, adapters.SessionVars{AgentID: a.ID, URL: l.url, Token: token})
	if err := l.tmux.NewSession(ctx, a.ID, a.Cwd, sessionEnv, spec.Argv); err != nil {
		return nil, err
	}
	if !l.current(a.ID, gen) {
		_ = l.tmux.KillSession(ctx, a.ID)
		return nil, nil
	}
	// A compaction asked for before the launch stays pending; any other pending action goes.
	var pending any
	if p, err := a.PendingActionOf(); err == nil && p != nil && p.Type == "compact" {
		pending = a.PendingAction
	}
	var detail any
	switch {
	case prompt != "":
		detail = "with prompt"
	case resume:
		detail = "resuming"
	}
	lifecycle := "active"
	if held {
		lifecycle = "paused"
	}
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "lifecycle", Val: lifecycle}, db.Field{Col: "activity", Val: "starting"},
		db.Field{Col: "activity_detail", Val: detail}, db.Field{Col: "pending_action", Val: pending}); err != nil {
		return nil, err
	}
	typ := "spawn"
	if resume {
		typ = "resume"
	}
	l.event(ctx, a.ID, typ, spawnEvent{Argv: spec.Argv, Prompt: prompt != ""})
	if resume {
		l.markCold(ctx, a.ID, "wake")
	}
	started, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	launched := make(chan error, 1)
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		launched <- l.afterLaunch(started, prompt, kind, gen)
		close(launched)
	}()
	return launched, nil
}

// afterLaunch answers the launch dialogs and types the first prompt, then records that it went in (S-759), or the
// error.
func (l *Lifecycle) afterLaunch(a db.Agent, prompt, kind string, gen int) error {
	ctx := l.ctx
	current := func() bool { return l.current(a.ID, gen) }
	err := l.answerLaunchDialogs(ctx, a.ID)
	if err == nil && prompt != "" {
		err = l.typeFirstPrompt(ctx, a.ID, prompt, current)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil {
		if kind == "spawn" && current() {
			l.event(ctx, a.ID, "first-prompt:delivered", nil)
		}
		return nil
	}
	l.event(ctx, a.ID, "launch-error", "Error: "+err.Error())
	if now, gerr := l.db.GetAgent(ctx, a.ID); gerr == nil && prompt != "" && now.Activity == "starting" {
		if uerr := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "activity", Val: "errored"},
			db.Field{Col: "activity_detail", Val: "first prompt not delivered: " + err.Error()}); uerr != nil {
			slog.Error("lifecycle: update failed", "agent", a.ID, "err", uerr)
		}
	}
	return err
}

// restOwner is src/lifecycle.ts REST_OWNER: the rest's pause, which ends with the harness.
const restOwner = "standing-idle"

// withoutRest is the agent's pause owners but the rest, as paused_by: nil when none is left.
func withoutRest(a db.Agent) any {
	var keep []string
	for _, o := range heldBy(a) {
		if o != restOwner {
			keep = append(keep, o)
		}
	}
	if len(keep) == 0 {
		return nil
	}
	return jsonText(keep)
}

type shutdownEvent struct {
	Detail string `json:"detail"`
}

// Shutdown is src/lifecycle.ts explicitShutdown with now (quitHarness), what `stam kill` runs: any launch in flight is
// cancelled, the agent's tmux session and the processes its agent started stop, and it is shut down.
func (l *Lifecycle) Shutdown(ctx context.Context, a db.Agent) error {
	return l.quitHarness(ctx, a, "shut down")
}

// quitHarness is src/lifecycle.ts quitHarness. The adapter's turn stop is OpenCode's alone, so none runs here.
func (l *Lifecycle) quitHarness(ctx context.Context, a db.Agent, detail string) error {
	l.invalidate(a.ID)
	if err := l.tmux.KillSession(ctx, a.ID); err != nil {
		return err
	}
	cur, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		cur = a
	}
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
		db.Field{Col: "activity_detail", Val: detail}, db.Field{Col: "pending_action", Val: nil}, db.Field{Col: "paused_by", Val: withoutRest(cur)}); err != nil {
		return err
	}
	l.event(ctx, a.ID, "shutdown", shutdownEvent{Detail: detail})
	return nil
}

// Forget is src/daemon.ts forget: a stopped agent leaves the registry, its tmux session (if any) and the processes it
// started stopping first. An agent tied to an ITSA is refused, since unowning ITSAs isn't ported yet; TS's own message
// is kept for an unown still waiting on the ITSA home.
func (l *Lifecycle) Forget(ctx context.Context, a db.Agent) (string, error) {
	if a.Lifecycle == "active" || a.Lifecycle == "paused" {
		return "", fmt.Errorf("%s is running; shut it down first", a.Name)
	}
	pending, tied, err := l.db.ItsaTies(ctx, a.ID)
	if err != nil {
		return "", err
	}
	if pending {
		return "", fmt.Errorf("%s still has an unown waiting for the ITSA home; forget it after the home answers", a.Name)
	}
	if set := l.settings.Get(); tied || set.Itsa.Home != l.machine {
		return "", fmt.Errorf("can't forget %s: its ITSAs can't be unowned yet (the Go daemon doesn't unown ITSAs); forget it with the TypeScript daemon", a.Name)
	}
	parents, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return "", err
	}
	l.invalidate(a.ID)
	if err := l.tmux.KillSession(ctx, a.ID); err != nil {
		return "", err
	}
	if err := l.db.ForgetAgent(ctx, a.ID); err != nil {
		return "", err
	}
	// Its pending requests are withdrawn and it is gone from the tree, so a parent's children wait changes and a
	// tree-idle notice above may be owed: each parent here is settled again, on the org goroutine.
	for _, p := range parents {
		if _, err := l.db.GetAgent(ctx, p); err == nil {
			l.observeOrg(ctx, db.ActivityChange{Kind: "resync", ID: p})
		}
	}
	return "forgot " + a.Name, nil
}

// render is src/templates.ts render: the template with its {{vars}} filled in, trimmed.
func (l *Lifecycle) render(name string, vars map[string]string) (string, error) {
	if l.claude.Templates == nil {
		return "", errors.New("lifecycle: no templates")
	}
	return l.claude.Templates.Render(name, vars, "")
}

// retroReminder is src/templates.ts retroReminder: "" when settings.retro.reminders is off.
func (l *Lifecycle) retroReminder() string {
	if !l.settings.Get().RetroReminders {
		return ""
	}
	r, err := l.render("retro-reminder", nil)
	if err != nil {
		return ""
	}
	return r
}

// renderWithRetro is src/templates.ts renderWithRetro: the reminder where the template has {{retro}}, with runs of
// blank lines it leaves closed up.
func (l *Lifecycle) renderWithRetro(name string, vars map[string]string) (string, error) {
	all := map[string]string{}
	for k, v := range vars {
		all[k] = v
	}
	all["retro"] = l.retroReminder()
	s, err := l.render(name, all)
	return blankRuns.ReplaceAllString(s, "\n\n"), err
}

var blankRuns = regexp.MustCompile(`\n{3,}`)

// withRetroReminder is src/templates.ts withRetroReminder: the reminder appended after a blank line, when it is on.
func (l *Lifecycle) withRetroReminder(text string) string {
	if r := l.retroReminder(); r != "" {
		return text + "\n\n" + r
	}
	return text
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

var errExited = errors.New("the harness exited")

// jsonText is JSON.stringify of a list of strings.
func jsonText(list []string) string {
	v := make([]jsjson.Value, len(list))
	for i, s := range list {
		v[i] = s
	}
	return jsjson.Stringify(v, "")
}
