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
// Claude Code is ported, and OpenCode's launch, first prompt, mail and states (opencode.go), and its turn stop,
// interrupt and turn state (turnstop.go). Not yet: cost take-overs
// (a fallback naming one runs its else action, fallback.go), archives (a pending one is left for the TS daemon), resuming an archived agent, waits
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
	"stam/internal/adapters/opencode"
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
	// opencode is the shared OpenCode server its OpenCode agents attach to (opencode.go); nil runs none.
	opencode *opencode.Server
	// openCodeSettle is afterLaunch's wait for an OpenCode TUI, openCodeSettle when 0 (tests shorten it).
	openCodeSettle time.Duration
	// openCodeViewer is told of each event of the server's stream (SetOpenCodeViewer), under mu to read.
	openCodeViewer func(typ string, data *jsjson.Object)
	// openCodeConnected, nil outside tests, runs on each connect to the OpenCode server's event stream, under mu.
	openCodeConnected func()
	// ctx is the daemon's: background work (a launch's first prompt) ends with it.
	ctx context.Context

	// firstMu guards firstAwait: the launches still waiting for their first prompt to be taken (firstprompt.go, S-3454).
	firstMu    sync.Mutex
	firstAwait map[string]*firstWait

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
	unown           func(ctx context.Context, a db.Agent, how string) error
	// agentGone hears that an agent was archived, once its notices are dropped (SetAgentGone).
	agentGone func(ctx context.Context, id string)
	// startingDead hears of an agent markStartingDead just marked never started (SetStartingDead), under orgMu.
	startingDead func(ctx context.Context, a db.Agent)
	// peerRetryFor is how long deliver tries a machine that doesn't answer; 0 for a day (tests shorten it).
	peerRetryFor time.Duration

	// genChecked, nil outside tests, runs in updateIfCurrent between its generation check and its write, under the
	// agent's owner's lock.
	genChecked func(id string)
	// rowChecked, nil outside tests, runs in updateIfCurrent after its row's check, before its write.
	rowChecked func(id string)
	// quitKilled, nil outside tests, runs in quitHarness after its invalidate and its kill, before its serial.
	quitKilled func(id string)
	// quitKilling, nil outside tests, runs in quitHarness after its invalidate, before its kill.
	quitKilling func(id string)
	// stopPublishing, nil outside tests, runs in a turn stop after its last call to the server, before it publishes.
	stopPublishing func(id string)
	// stopChecked, nil outside tests, runs in a turn stop's publication after its check, before its writes, under the
	// agent's owner's lock.
	stopChecked func(id string)
	// paneKilling, nil outside tests, runs in killPane with its kill begun, before its tmux call.
	paneKilling func(id string)
	// launchReleasing, nil outside tests, runs in launchAt after the launch's generation, before its release.
	launchReleasing func(id string)
	// quitWrote, nil outside tests, runs in quitHarness's serial after its write, before its stop is listed.
	quitWrote func(id string)

	mu sync.Mutex
	// owners is each agent's launch, stop and kill state (owner.go), under mu for the lookup alone.
	owners map[string]*owner
	// launchGen is the agents whose launch is still in its afterLaunch in this daemon, by generation (S-3250). A daemon
	// restart drops them, which is how settleStart tells a launch the restart cut off from one still running.
	launchGen map[string]int
	bg        sync.WaitGroup
	// bgRunning counts the goBG work still running, for a test to wait on.
	bgRunning atomic.Int64
	// onDialogStep is a test's hook into AnswerDialog (dialogStep); nil outside tests.
	onDialogStep func(step string)
	// jobs is what the OpenCode server runs for the agents (jobs.go); jobGrace is a finished job's grace, jobGrace's
	// default when 0; jobAfter, nil outside tests, schedules a grace's end; jobStep is a test's hook into a job wait's write.
	jobs     *jobTracker
	jobGrace time.Duration
	jobAfter func(d time.Duration, f func())
	jobStep  func(id, step string)
	// turnStep is a test's hook into an OpenCode turn end's reads and writes, a compaction or a reconnect (turnAt); nil
	// outside tests.
	turnStep func(id, step string)
	// askStep is a test's hook into an OpenCode ask's raise and answer (askAt); nil outside tests.
	askStep func(id, step string)
	// waited is set, under mu, once Wait began: work a timer would start then starts no more (bg.Add must not race
	// bg.Wait).
	waited bool
	// dialogs makes and closes the permission requests of harness dialogs (SetDialogs), under mu.
	dialogs Dialogs
	// sweep is the sweeps of pending OpenCode asks (asksweep.go).
	sweep askSweep
	// banners is the banners loop's looks and captures (banners.go).
	banners bannerState
	// inputs checks and types suggested input when hooks report a prompt or an idle agent (SetInputs), under mu.
	inputs Inputs
	// prompts fills a launch's system prompt slots (SetPrompts), under mu.
	prompts Prompts
	// leftover is each agent's own unfinished typing (input.go), under mu.
	leftover map[string]leftoverText

	// notices is each agent's queued stam notices (QueueNotice), held under mu; noticeSeq numbers them.
	notices   map[string][]notice
	noticeSeq uint64
	// unconfirmed holds, per agent, the answer_notices rows its in-turn notices handed over: deleted when the hook's client
	// acknowledges them (AckNotice), once it has printed the response (S-3923).
	unconfirmed map[string][]int64
	// pushTimers is each agent's debounced push (SchedulePush) and pushRuns how many of its fired pushes run,
	// pushHolds the agents stam types into (HoldingPushes), and pushLocks each agent's push lock, so two pushes never
	// build the same prompt; all under mu.
	pushTimers map[string]*time.Timer
	pushRuns   map[string]int
	pushHolds  map[string]int
	pushLocks  map[string]*sync.Mutex
	// serialLocks is each agent's lock for its pause transitions and blocker changes (serial), under mu.
	serialLocks map[string]*serialLock
	// resuming, nil outside tests, runs in a blocker's clear right before it resumes the agent, so a test can race
	// another change against the resume.
	resuming func(id string)
	// acquired, nil outside tests, runs in resumeNow and archiveNow once they hold the transition lock; serialWaiting runs
	// right before serial waits for the agent's lock; launching runs in a launch between its first held check and the
	// final one: each lets a test hold a change at that point.
	acquired, serialWaiting, launching func(id string)
	// archiveStopped, nil outside tests, runs in an archive right after it stopped the harness, before it confirms the
	// session is gone, so a test can start it again there.
	archiveStopped func(id string)
	// switchAt, nil outside tests, runs at each step of a cost switch (switchStep), so a test can stop it there as a crash
	// would or race a change against it; switchedItsas asks the ITSA home to move a switched agent's ITSAs
	// (SetSwitchedItsas). Both under mu.
	switchAt      func(id, step string)
	switchedItsas func(ctx context.Context, from, to db.Agent)
	// successorID, nil outside tests, gives a switch's successor its id (newSuccessorID), under mu.
	successorID func() string
	// attaching, nil outside tests, runs in AttachSpawn between its plan and its writes; chainWaiting runs right before a
	// job on an account's rules chain waits for the one ahead of it.
	attaching, chainWaiting func(account string)
	// succeeding, nil outside tests, runs in a probe turn's success worker, after the hook accepted it and before it
	// goes on.
	succeeding func(account string)
	// costProbes is the accounts' error probing (probes.go); prober replaces the probe in tests (nil probes with a
	// turn).
	costProbes probeState
	// tests is the test routes' state (testhooks.go).
	tests  testState
	prober Prober
	// systemMail sends stam's own mail from a system:NAME sender (the server's sendFromSystem): the auth error's, the
	// budget, the human's warnings and the credit warning.
	systemMail func(ctx context.Context, name string, to []string, subject, body string) bool
	// costSend mails a cost notice and gives the mail's id, and costWithdraw withdraws the human's copy of one a manager
	// handled (SetCostMail), under mu; fallbackTimer is the cost fallbacks' one timer (fallback.go), and recovered says
	// the rows a previous daemon left mid-run were recovered, which no timer is set before, both under mu.
	costSend      func(ctx context.Context, name string, to []string, subject, body string) (string, bool)
	costWithdraw  func(ctx context.Context, ids []string, by, note string)
	fallbackTimer *time.Timer
	recovered     bool
	// pauseTimer is the cost pauses' one timer (costpause.go) and pauseWait its wait, under pauseMu, which also holds the
	// read that sets it.
	pauseMu    sync.Mutex
	pauseTimer *time.Timer
	pauseWait  time.Duration
	// pauseListed, nil outside tests, runs in CostPause right after it lists the tree and right before it lists it again;
	// pauseJudged runs in EvaluatePauses between a pause's verdict and its drop: each lets a test race a change against
	// the pause.
	pauseListed func(root string, again bool)
	pauseJudged func(id string)
	// pauseAttach, nil outside tests, runs in AttachPause between its first read of the chain and its serial.
	pauseAttach func(id string)
	// pushing, nil outside tests, runs in a push after its admission and before its prompt goes out, so a test can hold
	// a push mid-flight.
	pushing func(id string)
	// streams is the shims' push streams; nil pushes nothing.
	streams *push.Streams
	// debounce is the wait before a scheduled push runs.
	debounce time.Duration
	// compactions is the compactions running or just done (src/lifecycle.ts compactions), under mu.
	compactions map[string]compaction
	// transitions is the agents being switched or resumed (src/lifecycle.ts acquire), and switching the agents a cost
	// switch runs for (src/cost-switch.ts switching), both under mu.
	transitions map[string]*transition
	switching   map[string]bool
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
	// rules is the cost rules' evaluation chains and timers (rules.go), under mu; resetMargin is the margin past a
	// window's reset before its wait clears unconfirmed.
	rules       rulesState
	resetMargin time.Duration
	// peerSource reads the peers' subscription windows and peers is their last answers (peer_readings.go), under mu;
	// peerEvery is how often they are refreshed.
	peerSource PeerReadings
	peers      peerState
	peerEvery  time.Duration
	// spend is the peers' paid spend (peerspend.go), and budgets the budgets' timers and mail tries (budgets.go), both
	// under mu.
	spend   spendState
	budgets budgetState
	// credits is the OpenRouter credit poller's state (credits.go), under mu.
	credits creditState
	// snapshot is the usage summary's 30-second attribution memo (attribsummary.go), under mu.
	snapshot *snapshotMemo
	// typical is typicalIssue's 10-minute memo of the per-config rows (issuecosts.go), under mu.
	typical *typicalMemo

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
	// OpenCode is the shared OpenCode server, which OpenCode agents need; nil refuses them, as before (S-4237).
	OpenCode *opencode.Server
	// OpenCodeSettle is the wait for an OpenCode TUI before its first prompt, openCodeSettle when 0.
	OpenCodeSettle time.Duration
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
	// ResetMargin is the margin past a window's reset before the cost rules clear its wait unconfirmed, resetMargin
	// when 0 (tests shorten it).
	ResetMargin time.Duration
	// PeerReadingsEvery is how often the peers' subscription windows are refreshed, peerReadingsEvery when 0.
	PeerReadingsEvery time.Duration
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
	l := &Lifecycle{db: o.DB, tmux: o.Tmux, settings: o.Settings, claude: o.Claude, opencode: o.OpenCode, openCodeSettle: o.OpenCodeSettle, url: o.URL, machine: o.Machine, ctx: ctx, owners: map[string]*owner{}, jobs: newJobTracker(),
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
	l.resetMargin, l.peerEvery = o.ResetMargin, o.PeerReadingsEvery
	if l.resetMargin == 0 {
		l.resetMargin = resetMargin
	}
	if l.peerEvery == 0 {
		l.peerEvery = peerReadingsEvery
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

// nextGen takes the agent's next generation (owner.invalidate).
func (l *Lifecycle) nextGen(id string) int { return l.ownerOf(id).invalidate() }

// nextLaunchGen is nextGen for a launch, which also records it as the agent's latest launch (launchedSince).
func (l *Lifecycle) nextLaunchGen(id string) int { return l.ownerOf(id).beginLaunch() }

// launchedSince is whether a launch took a generation later than gen: the launch owns the agent now, so a shutdown or
// a stop of gen must not act on it. Another invalidate (a reconcile's, a recovery's) doesn't count.
func (l *Lifecycle) launchedSince(id string, gen int) bool { return l.ownerOf(id).launchedSince(gen) }

// updateUnlessLaunched sets fields on the agent unless a launch took a generation later than gen, in one step with that
// check (owner.unlessLaunched). It reports whether it wrote.
func (l *Lifecycle) updateUnlessLaunched(ctx context.Context, id string, gen int, fields ...db.Field) (bool, error) {
	return l.ownerOf(id).unlessLaunched(gen, func() (bool, error) {
		return l.db.UpdateAgentIf(ctx, id, func(db.Agent) bool { return true }, fields...)
	})
}

// updateIfCurrent sets fields on the agent while gen is still its launch generation and ok (when not nil) holds for its
// row, in one step: no generation is taken between the check and the write (owner.whileCurrent), and ok reads the row
// in the write's own transaction. It reports whether it wrote.
func (l *Lifecycle) updateIfCurrent(ctx context.Context, id string, gen int, ok func(db.Agent) bool, fields ...db.Field) (bool, error) {
	var checked func()
	if l.genChecked != nil {
		checked = func() { l.genChecked(id) }
	}
	return l.ownerOf(id).whileCurrent(gen, checked, func() (bool, error) {
		check := func(a db.Agent) bool {
			r := ok == nil || ok(a)
			if l.rowChecked != nil {
				l.rowChecked(id)
			}
			return r
		}
		return l.db.UpdateAgentIf(ctx, id, check, fields...)
	})
}

// invalidate cancels any launch in flight for the agent (src/lifecycle.ts invalidateLaunch).
func (l *Lifecycle) invalidate(id string) { l.nextGen(id) }

func (l *Lifecycle) current(id string, gen int) bool { return l.ownerOf(id).current(gen) }

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

type spawnEvent struct {
	Argv   []string `json:"argv"`
	Prompt bool     `json:"prompt"`
	// Stuck marks the stuck-start restart's own launch (S-3250).
	Stuck bool `json:"stuck,omitempty"`
}

type heldEvent struct {
	Owners   []string `json:"owners"`
	Blockers []string `json:"blockers"`
}

type lateHeldEvent struct {
	Blockers []string `json:"blockers"`
	Late     bool     `json:"late"`
}

// killIfCurrent stops the session of a launch that failed after starting it, unless a newer launch or a stop took
// over the agent (its session is that one's to keep or end), even when the caller's context ended.
func (l *Lifecycle) killIfCurrent(ctx context.Context, id string, gen int) {
	_ = l.killPane(context.WithoutCancel(ctx), id, gen, true)
}

// holdLaunch records a held agent's launch without its prompt: the admission gate's refusal when cost blockers are
// among what holds it, and launch-held.
func (l *Lifecycle) holdLaunch(ctx context.Context, a db.Agent, kind string) {
	l.admit(ctx, a.ID, kind)
	owners := pauseOwners(a)
	if owners == nil {
		owners = []string{}
	}
	l.event(ctx, a.ID, "launch-held", heldEvent{Owners: owners, Blockers: l.blockerKinds(ctx, a.ID)})
}

// keepCompactPrompt is src/lifecycle.ts launchAt's S-4304 line: a held launch drops its prompt, but a compaction's
// continue prompt goes in when the agent is idle again. Every other kind's prompt is dropped. Like the notice queue it
// is in memory: a daemon restart loses it, and the agent's row carries no copy.
func (l *Lifecycle) keepCompactPrompt(ctx context.Context, id, kind, prompt string) {
	if kind == "compact" {
		l.QueueNotice(ctx, id, prompt, true)
	}
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
	return l.startHarnessMarked(ctx, a, prompt, resume, kind, false)
}

// startHarnessMarked is startHarness; stuck marks the launch as the stuck-start restart's own (src/lifecycle.ts
// startHarness's mark, S-3250), in its spawn or resume event.
func (l *Lifecycle) startHarnessMarked(ctx context.Context, a db.Agent, prompt string, resume bool, kind string, stuck bool) (<-chan error, error) {
	if a.Harness != "claude" && (a.Harness != "opencode" || l.opencode == nil) {
		return nil, fmt.Errorf("%s runs %s, which the Go daemon can't control yet", a.Name, a.Harness)
	}
	gen := l.nextLaunchGen(a.ID)
	// S-3250: the launch counts as running here from its generation on, so settleStart never reads a relaunch's old
	// pane, still starting, as a launch that ended. Superseded, failed or landed (the goroutine below) clears it.
	l.setLaunching(a.ID, gen)
	launched, err := l.launchAt(ctx, a, gen, prompt, resume, kind, stuck)
	if launched == nil {
		l.clearLaunching(a.ID, gen)
		// The asks a stop it gave up handed it go with it (owner.settleLaunch).
		l.ownerOf(a.ID).settleLaunch(gen, false)
	}
	return launched, err
}

// launchAt is startHarnessMarked past its generation: the launch itself, under the generation gen.
func (l *Lifecycle) launchAt(ctx context.Context, a db.Agent, gen int, prompt string, resume bool, kind string, stuck bool) (<-chan error, error) {
	if l.launchReleasing != nil {
		l.launchReleasing(a.ID)
	}
	// A launch a stop has superseded since its generation goes no further: its release cancels nothing.
	if current, err := l.releaseTurnStop(ctx, a, gen); err != nil || !current {
		return nil, err
	}
	held := l.isHeld(ctx, a)
	if held && prompt != "" {
		l.holdLaunch(ctx, a, kind)
		l.keepCompactPrompt(ctx, a.ID, kind, prompt)
		prompt = ""
	}
	if l.launchFails(a.Name) {
		return nil, fmt.Errorf("test: launch of %s failed", a.Name)
	}
	spec, sessionID, err := l.launchSpec(ctx, a, resume)
	if err != nil {
		return nil, err
	}
	if !l.current(a.ID, gen) {
		return nil, nil
	}
	if now, err := l.db.GetAgent(ctx, a.ID); err == nil && now.ForwardedTo != nil && *now.ForwardedTo != "" {
		return nil, fmt.Errorf("%s was taken over while it started", a.Name)
	}
	// An OpenCode launch's new session (src/lifecycle.ts spec.fields), written only while this launch is current, in one
	// step with the check: a launch superseded meanwhile never overwrites the later one's session.
	if sessionID != "" {
		if wrote, err := l.updateIfCurrent(ctx, a.ID, gen, nil, db.Field{Col: "session_id", Val: sessionID}); err != nil || !wrote {
			return nil, err
		}
	}
	// No pane begins while a kill of it is in flight, and only under a generation still current: a quit that took a
	// later one has the agent (owner.beginPane).
	if !l.ownerOf(a.ID).beginPane(gen) {
		return nil, nil
	}
	if err := l.tmux.KillSession(ctx, a.ID); err != nil {
		return nil, err
	}
	token, err := l.mintToken(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	sessionEnv := adapters.SessionEnv(spec.Env, adapters.SessionVars{AgentID: a.ID, URL: l.url, Token: token})
	// The Go bin dir goes first on the shell's PATH, for spawn and resume alike (S-3666; adapters.GoBinArgv).
	argv := adapters.GoBinArgv(spec.Argv, adapters.GoBinDir(spec.Env))
	if err := l.tmux.NewSession(ctx, a.ID, a.Cwd, sessionEnv, argv); err != nil {
		return nil, err
	}
	if !l.current(a.ID, gen) {
		// Superseded after making its pane: it goes, unless a later launch has the pane now.
		_ = l.killPane(ctx, a.ID, gen, false)
		return nil, nil
	}
	// A compaction asked for before the launch stays pending; any other pending action goes.
	var pending any
	if p, err := a.PendingActionOf(); err == nil && p != nil && p.Type == "compact" {
		pending = a.PendingAction
	}
	if l.launching != nil {
		l.launching(a.ID)
	}
	// The final held check and the state it writes run in the agent's serial, so a blocker added since the first check
	// (which pauses an active agent, or only records one that isn't) leaves it paused, and one cleared since (whose
	// resume already made it active) leaves it active: held is read again either way. A stop while this waited on the
	// serial wins: the launch writes nothing.
	superseded := false
	err = l.serial(ctx, a.ID, func(ctx context.Context) error {
		if !l.current(a.ID, gen) {
			superseded = true
			return nil
		}
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		wasHeld := held
		if held = l.isHeld(ctx, now); held && !wasHeld && prompt != "" {
			l.holdLaunch(ctx, now, kind)
			l.keepCompactPrompt(ctx, now.ID, kind, prompt)
			prompt = ""
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
		// The harness starts here, whatever asked for it: the only writes of launched_at and resumed_at (S-3372).
		// launched_at is the first start only; every later start, fresh or resumed, sets resumed_at.
		started := db.Field{Col: "resumed_at", Val: db.Now()}
		if now.LaunchedAt == nil {
			started = db.Field{Col: "launched_at", Val: db.Now()}
		}
		return l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "lifecycle", Val: lifecycle}, db.Field{Col: "activity", Val: "starting"},
			db.Field{Col: "activity_detail", Val: detail}, db.Field{Col: "pending_action", Val: pending}, started)
	})
	if superseded {
		return nil, nil
	}
	if err != nil {
		l.killIfCurrent(ctx, a.ID, gen)
		return nil, err
	}
	// The row runs the session again: the asks a stop this launch gave up handed it are raised (owner.settleLaunch).
	l.queueAsks(a.ID, l.ownerOf(a.ID).settleLaunch(gen, true))
	typ := "spawn"
	if resume {
		typ = "resume"
	}
	l.event(ctx, a.ID, typ, spawnEvent{Argv: spec.Argv, Prompt: prompt != "", Stuck: stuck})
	if resume {
		l.markCold(ctx, a.ID, "wake")
	}
	started, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		l.killIfCurrent(ctx, a.ID, gen)
		return nil, err
	}
	launched := make(chan error, 1)
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		err := l.afterLaunch(started, prompt, kind, gen)
		l.clearLaunching(started.ID, gen)
		launched <- err
		close(launched)
	}()
	return launched, nil
}

// launchSpec is the adapter's launch (src/lifecycle.ts adapter.launch): the command and env that start the agent's
// harness, and for OpenCode the session it made, "" when none.
func (l *Lifecycle) launchSpec(ctx context.Context, a db.Agent, resume bool) (adapters.LaunchSpec, string, error) {
	if a.Harness == "opencode" {
		return l.opencode.Launch(ctx, a, resume)
	}
	env := l.claude
	env.Settings = l.settings.Get()
	var parts claude.Parts
	if p := l.promptParts(); p != nil {
		var err error
		if parts, err = p.LaunchParts(ctx, a); err != nil {
			return adapters.LaunchSpec{}, "", err
		}
	}
	spec, err := claude.Launch(ctx, env, a, resume, parts)
	return spec, "", err
}

// launchingNow is whether a launch of the agent is in its afterLaunch in this daemon (src/lifecycle.ts launching).
func (l *Lifecycle) launchingNow(id string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.launchGen[id]
	return ok
}

// setLaunching records gen's launch of the agent as running here.
func (l *Lifecycle) setLaunching(id string, gen int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.launchGen == nil {
		l.launchGen = map[string]int{}
	}
	l.launchGen[id] = gen
}

// clearLaunching ends gen's launch of the agent, unless a later launch has taken its place.
func (l *Lifecycle) clearLaunching(id string, gen int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.launchGen[id] == gen {
		delete(l.launchGen, id)
	}
}

// afterLaunch answers the launch dialogs and types the first prompt, then records that it went in (S-759), or the
// error.
func (l *Lifecycle) afterLaunch(a db.Agent, prompt, kind string, gen int) error {
	ctx := l.ctx
	current := func() bool { return l.current(a.ID, gen) }
	// src/lifecycle.ts startHarness's gate: refused, the prompt waits as an idle notice that goes in once the blockers
	// clear.
	gate := func() bool {
		if !current() {
			return false
		}
		if ok, _ := l.admit(ctx, a.ID, kind); ok {
			return true
		}
		l.event(ctx, a.ID, "launch-held", lateHeldEvent{Blockers: l.blockerKinds(ctx, a.ID), Late: true})
		if now, err := l.db.GetAgent(ctx, a.ID); err == nil && now.Activity == "starting" {
			if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "ready"}); err != nil {
				slog.Error("lifecycle: update failed", "agent", a.ID, "err", err)
			}
		}
		l.QueueNotice(ctx, a.ID, prompt, true)
		return false
	}
	var err error
	if a.Harness == "opencode" {
		err = l.openCodeAfterLaunch(ctx, a, prompt, gen, gate)
	} else if err = l.answerLaunchDialogs(ctx, a.ID); err == nil && prompt != "" {
		err = l.typeFirstPrompt(ctx, a.ID, prompt, current, gate)
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
	for _, o := range pauseOwners(a) {
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
	return l.stopForGood(ctx, a, "shut down")
}

// stopForGood is a real stop, not a restart: the agent's pending suggestions are withdrawn with it (S-3830). A restart
// calls quitHarness alone and keeps them.
func (l *Lifecycle) stopForGood(ctx context.Context, a db.Agent, detail string) error {
	_, err := l.stopForGoodGen(ctx, a, detail)
	return err
}

// stopForGoodGen is stopForGood, with the launch generation its quitHarness left (quitHarnessGen).
func (l *Lifecycle) stopForGoodGen(ctx context.Context, a db.Agent, detail string) (int, error) {
	gen, err := l.quitHarnessGen(ctx, a, detail)
	if err != nil || l.launchedSince(a.ID, gen) {
		// A launch that took the agent back meanwhile keeps its suggestions.
		return gen, err
	}
	l.withdrawInputs(ctx, a, "the agent was shut down")
	return gen, nil
}

// quitHarness is src/lifecycle.ts quitHarness. An OpenCode agent's turn, which its TUI's end leaves running in the
// shared server, is stopped in the background (stopTurn); an archive or a switch waits for that stop (awaitTurnStop).
func (l *Lifecycle) quitHarness(ctx context.Context, a db.Agent, detail string) error {
	_, err := l.quitHarnessGen(ctx, a, detail)
	return err
}

// quitHarnessGen is quitHarness, with the launch generation its invalidate took: its turn stop belongs to that one, so
// a launch that takes a later one, even before the stop is listed, makes it give up.
func (l *Lifecycle) quitHarnessGen(ctx context.Context, a db.Agent, detail string) (int, error) {
	gen := l.nextGen(a.ID)
	if l.quitKilling != nil {
		l.quitKilling(a.ID)
	}
	if err := l.killPane(ctx, a.ID, gen, false); err != nil {
		return gen, err
	}
	if l.quitKilled != nil {
		l.quitKilled(a.ID)
	}
	// In the agent's serial, so a launch already past its generation check finishes its write first and this one lands
	// after it. The write is this quit's only while no launch took a later generation: one that did (a resume racing a
	// repeated shutdown) owns the agent, its row and its turn, so this quit writes nothing and stops nothing.
	return gen, l.serial(ctx, a.ID, func(ctx context.Context) error {
		cur, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			cur = a
		}
		wrote, err := l.updateUnlessLaunched(ctx, a.ID, gen, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "unknown"},
			db.Field{Col: "activity_detail", Val: detail}, db.Field{Col: "pending_action", Val: nil}, db.Field{Col: "paused_by", Val: withoutRest(cur)})
		if err != nil || !wrote {
			return err
		}
		if l.quitWrote != nil {
			l.quitWrote(a.ID)
		}
		l.event(ctx, a.ID, "shutdown", shutdownEvent{Detail: detail})
		l.stopTurn(cur, gen)
		return nil
	})
}

// Forget is src/daemon.ts forget: a stopped agent leaves the registry, its tmux session (if any) and the processes it
// started stopping first. Its ITSAs are unowned first (SetUnown's hook); if that fails the agent is kept, so the forget
// can be repeated.
func (l *Lifecycle) Forget(ctx context.Context, a db.Agent) (string, error) {
	if a.Lifecycle == "active" || a.Lifecycle == "paused" {
		return "", fmt.Errorf("%s is running; shut it down first", a.Name)
	}
	pending, _, err := l.db.ItsaTies(ctx, a.ID)
	if err != nil {
		return "", err
	}
	if pending {
		return "", fmt.Errorf("%s still has an unown waiting for the ITSA home; forget it after the home answers", a.Name)
	}
	l.orgMu.Lock()
	unown := l.unown
	l.orgMu.Unlock()
	if unown == nil {
		return "", fmt.Errorf("can't forget %s: its ITSAs can't be unowned yet (no ITSA owners on this daemon); try again when the ITSA home answers", a.Name)
	}
	if err := unown(ctx, a, "forgotten"); err != nil {
		return "", fmt.Errorf("can't forget %s: its ITSAs can't be unowned yet (%s); try again when the ITSA home answers", a.Name, err.Error())
	}
	parents, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return "", err
	}
	if err := l.killPane(ctx, a.ID, l.nextGen(a.ID), false); err != nil {
		return "", err
	}
	l.withdrawInputs(ctx, a, "the agent was forgotten")
	if err := l.db.ForgetAgent(ctx, a.ID); err != nil {
		return "", err
	}
	l.tellAgentGone(ctx, a.ID)
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
