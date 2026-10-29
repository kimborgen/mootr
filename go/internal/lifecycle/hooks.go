package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"
	"unicode/utf16"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// ErrNoHooks is a hook for a harness the Go daemon has no hook handling for.
type ErrNoHooks struct{ Harness string }

func (e ErrNoHooks) Error() string {
	return fmt.Sprintf("%s hooks aren't ported to the Go daemon yet", e.Harness)
}

type hookEvent struct {
	Activity string  `json:"activity"`
	Detail   *string `json:"detail"`
}

// lastMessageMax is how much of the turn's last message the agent row keeps, in UTF-16 units as String#slice counts.
const lastMessageMax = 4000

// OnHook is src/daemon.ts onHook for a Claude Code hook: it applies what the event says to the agent and records a
// hook:EVENT event. After a tool call it answers the agent's in-turn notice as PostToolUse additionalContext (the
// hook's stdout), and a turn end schedules the agent's push and runs its pending action (onIdle) in the background.
// Not ported: the turn end's timeline ingest.
//
// ack receives the answer rows an in-turn response carried (S-3923): the hook's client acknowledges exactly those.
func (l *Lifecycle) OnHook(ctx context.Context, harness string, a db.Agent, payload jsjson.Value, ack *[]int64) (*string, error) {
	// The path's harness, else the agent's own, as `adapters[harness] ?? adapters[agent.harness]`.
	h := harness
	if !knownHarness(h) {
		h = a.Harness
	}
	if h != "claude" {
		return nil, ErrNoHooks{Harness: h}
	}
	p, _ := payload.(*jsjson.Object)
	// S-3454: the first prompt's wait ends on its UserPromptSubmit before anything below can fail, as TS's onHook does.
	if v, _ := p.Get("hook_event_name"); v == "UserPromptSubmit" {
		prompt, _ := p.Get("prompt")
		l.firstPromptHook(a.ID, prompt)
	}
	var dialog *db.PermissionRequest
	asked := false
	pendingDialog := func() (string, bool) {
		if !asked {
			asked = true
			if r, ok, err := l.db.PendingDialog(ctx, a.ID); err == nil && ok {
				dialog = &r
			}
		}
		if dialog == nil {
			return "", false
		}
		return dialog.Details, true
	}
	r := claude.OnHook(a, p, pendingDialog)
	// The adapter's cost signal goes first, as TS's onHook records it before the daemon applies the result.
	if r.CostSignal != nil {
		l.costSignal(ctx, a, *r.CostSignal)
	}
	// The model answered: if this turn is its account's probe, the account works.
	if v, _ := p.Get("hook_event_name"); v == "Stop" || v == "PostToolUse" {
		l.turnSucceeded(ctx, a)
	}
	if err := l.applyHookWaits(ctx, a.ID, r.Waits); err != nil {
		return nil, err
	}
	var fields []db.Field
	if r.Activity != "" {
		fields = append(fields, db.Field{Col: "activity", Val: r.Activity})
	}
	if r.SetDetail {
		fields = append(fields, db.Field{Col: "activity_detail", Val: r.Detail})
	}
	if r.SessionID != "" {
		fields = append(fields, db.Field{Col: "session_id", Val: r.SessionID})
	}
	if r.TranscriptPath != "" {
		fields = append(fields, db.Field{Col: "transcript_path", Val: r.TranscriptPath})
	}
	if r.LastMessage != "" {
		fields = append(fields, db.Field{Col: "last_message", Val: sliceUTF16(r.LastMessage, lastMessageMax)})
	}
	if len(fields) > 0 {
		if err := l.db.UpdateAgent(ctx, a.ID, fields...); err != nil {
			return nil, err
		}
	}
	var data any
	if r.Activity != "" {
		data = hookEvent{Activity: r.Activity, Detail: r.Detail}
	}
	ev := "undefined"
	if p != nil {
		if v, ok := p.Get("hook_event_name"); ok {
			ev = claude.JSString(v)
			if v == nil {
				ev = "null"
			}
		}
	}
	if err := l.db.AddEvent(ctx, a.ID, "hook:"+ev, data); err != nil {
		return nil, err
	}
	// A dialog that blocks the agent becomes a permission request; any other activity, or a new harness session, means
	// it's gone.
	if err := l.hookDialog(ctx, a.ID, r); err != nil {
		return nil, err
	}
	l.hookInputs(ctx, a.ID, ev, p, r.Activity)
	if r.AfterTool {
		if notice, rows := l.InTurnTake(ctx, a.ID); notice != "" {
			l.event(ctx, a.ID, "mail:notice", nil)
			out := claude.InTurnNotice(notice)
			*ack = rows
			return &out, nil
		}
	}
	if r.TurnEnded {
		l.SchedulePush(a.ID)
		l.onIdleSoon(a.ID)
	} else if r.Activity == "idle" && a.Activity != "idle" && !ownerPaused(a) {
		// A harness that comes up idle (SessionStart) takes what queued while it started: a push that ran then found it
		// not idle and left it waiting, with nothing else to wake it (S-4168). One an owner paused meanwhile waits for
		// its resume, which pushes.
		l.SchedulePush(a.ID)
	}
	return nil, nil
}

// Dialogs is the handling of the harness dialogs hooks report (src/permissions.ts dialogShown and dialogClosed), which
// the server sets: each makes or closes a permission request.
type Dialogs interface {
	DialogShown(ctx context.Context, a db.Agent, d claude.Dialog) error
	DialogClosed(ctx context.Context, a db.Agent) error
	// DialogClosedIf closes the agent's pending dialog only when match accepts its details, checked and closed in one
	// step (an OpenCode ask closes only the request for its own permission).
	DialogClosedIf(ctx context.Context, a db.Agent, match func(details string) bool) error
}

// SetDialogs sets the handling of harness dialogs; without it, a dialog makes no request.
func (l *Lifecycle) SetDialogs(d Dialogs) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.dialogs = d
}

// hookDialog is src/daemon.ts onHook's dialog step, after the hook's write: a reported dialog is shown (a failure is a
// permission-error event, and the hook still succeeds, as TS's floating promise), any other activity than blocked, or a
// session, closes the pending one.
func (l *Lifecycle) hookDialog(ctx context.Context, id string, r claude.HookResult) error {
	l.mu.Lock()
	d := l.dialogs
	l.mu.Unlock()
	if d == nil || (r.Dialog == nil && (r.Activity == "" || r.Activity == "blocked") && r.SessionID == "") {
		return nil
	}
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return ignoreGone(err)
	}
	if r.Dialog != nil {
		if err := d.DialogShown(ctx, a, *r.Dialog); err != nil {
			l.event(ctx, id, "permission-error", "Error: "+err.Error())
		}
		return nil
	}
	return d.DialogClosed(ctx, a)
}

// Inputs is the handling of suggested input the hooks report (src/permissions.ts promptSubmitted and typeHeldInput),
// which the server sets.
type Inputs interface {
	PromptSubmitted(ctx context.Context, agentID, prompt string)
	TypeHeldInput(ctx context.Context, agentID string) error
	// WithdrawPending withdraws the agent's suggestions still pending, when it stops, is archived or is forgotten (S-3830).
	WithdrawPending(ctx context.Context, a db.Agent, note string) error
}

// SetInputs sets the handling of suggested input; without it, the hooks check and type none.
func (l *Lifecycle) SetInputs(in Inputs) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.inputs = in
}

// withdrawInputs withdraws the suggestions an agent that stopped, was archived or was forgotten still has pending, so
// no ask waits on an agent that can't answer it (src/permissions.ts withdrawPendingInputs). A failure is a
// permission-error event.
func (l *Lifecycle) withdrawInputs(ctx context.Context, a db.Agent, note string) {
	l.mu.Lock()
	in := l.inputs
	l.mu.Unlock()
	if in == nil {
		return
	}
	if err := in.WithdrawPending(ctx, a, note); err != nil {
		l.event(ctx, a.ID, "permission-error", "Error: "+err.Error())
	}
}

// hookInputs is src/daemon.ts onHook's suggested-input steps (S-422): the prompt a typed suggestion submitted is
// checked against its text, and a suggestion the human approved while the agent was busy is typed at its next idle or
// wait, in the background (a failure is a permission-error event).
func (l *Lifecycle) hookInputs(ctx context.Context, id, ev string, p *jsjson.Object, activity string) {
	l.mu.Lock()
	in := l.inputs
	l.mu.Unlock()
	if in == nil {
		return
	}
	if ev == "UserPromptSubmit" && p != nil {
		if prompt, ok := p.Get("prompt"); ok {
			if text, ok := prompt.(string); ok {
				in.PromptSubmitted(ctx, id, text)
			}
		}
	}
	if activity == "idle" || activity == "waiting" {
		l.Go(func(lctx context.Context) {
			if err := in.TypeHeldInput(lctx, id); err != nil {
				l.event(lctx, id, "permission-error", "Error: "+err.Error())
			}
		})
	}
}

// applyHookWaits is what src/adapters/claude.ts onHook does to the agent's hook waits before the daemon writes the hook's
// activity: a new process drops them, a Stop replaces them with Claude Code's own lists (a turn ending with some open
// then ends waiting), and a prompt clears the job or one-shot timer that started its turn.
func (l *Lifecycle) applyHookWaits(ctx context.Context, id string, w claude.HookWaits) error {
	if w.Clear {
		if err := l.db.ClearHookWaits(ctx, id); err != nil {
			return err
		}
	}
	if w.Jobs != nil {
		if err := l.db.ReplaceHookWaits(ctx, id, "job", w.Jobs); err != nil {
			return err
		}
	}
	if w.Timers != nil {
		if err := l.db.ReplaceHookWaits(ctx, id, "timer", w.Timers); err != nil {
			return err
		}
	}
	if w.Prompt == nil {
		return nil
	}
	waits, err := l.db.ListWaits(ctx, id)
	if err != nil {
		return err
	}
	var hooked []db.Wait
	for _, x := range waits {
		if x.Source == "hook" {
			hooked = append(hooked, x)
		}
	}
	if len(hooked) == 0 {
		return nil
	}
	// Working first, so clearing the last wait doesn't pass through idle and tell the parents.
	if err := l.db.UpdateAgent(ctx, id, db.Field{Col: "activity", Val: "working"}, db.Field{Col: "activity_detail", Val: nil}); err != nil {
		return err
	}
	if job, ended, ok := claude.StartedJob(*w.Prompt); ok {
		if ended {
			_, err = l.db.ClearWaits(ctx, id, "job", &job)
		}
		return err
	}
	for _, x := range hooked {
		if x.Kind == "timer" && claude.FiredTimer(x.Data, *w.Prompt) {
			if _, err := l.db.ClearWait(ctx, x.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func knownHarness(h string) bool { return h == "claude" || h == "codex" || h == "opencode" }

// sliceUTF16 is s.slice(0, n), counting UTF-16 units; a surrogate pair cut in half keeps its first half, as JS does,
// which UTF-8 writes as U+FFFD.
func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

// sameWindow is src/statusline-gate.ts SAME_MS: an unchanged report inside it is skipped.
const sameWindow = 10 * time.Second

// statusGate is src/statusline-gate.ts: per agent, a report whose relevant fields equal the last processed one's
// within sameWindow is skipped, any other processed at once.
type statusGate struct {
	mu      sync.Mutex
	slots   map[string]gateSlot
	sweptAt time.Time
}

type gateSlot struct {
	key string
	at  time.Time
}

// relevantKey is src/statusline-gate.ts relevantKey: the fields onStatusLine and the usage tables read.
func relevantKey(p *jsjson.Object) string {
	field := func(o *jsjson.Object, key string) jsjson.Value {
		if o == nil {
			return nil
		}
		v, _ := o.Get(key)
		return v
	}
	cw, _ := field(p, "context_window").(*jsjson.Object)
	cost, _ := field(p, "cost").(*jsjson.Object)
	return jsjson.Stringify([]jsjson.Value{field(p, "transcript_path"), field(cw, "context_window_size"), field(cw, "current_usage"),
		field(cost, "total_cost_usd"), field(p, "rate_limits")}, "")
}

// pass is whether the report in slot is processed; it records it when it is.
func (g *statusGate) pass(slot string, p *jsjson.Object, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.slots == nil {
		g.slots = map[string]gateSlot{}
	}
	// Slots older than sameWindow can't skip anything: dropped, so forgotten agents don't leak.
	if now.Sub(g.sweptAt) >= sameWindow {
		g.sweptAt = now
		for k, v := range g.slots {
			if now.Sub(v.at) >= sameWindow {
				delete(g.slots, k)
			}
		}
	}
	key := relevantKey(p)
	if last, ok := g.slots[slot]; ok && last.key == key && now.Sub(last.at) < sameWindow {
		return false
	}
	g.slots[slot] = gateSlot{key: key, at: now}
	return true
}

func (g *statusGate) drop(slot string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.slots, slot)
}

// clientCache is src/tmux-clients.ts: whether a tmux client has the agent's session open, kept for 5 s.
type clientCache struct {
	mu   sync.Mutex
	seen map[string]clientSeen
}

type clientSeen struct {
	open bool
	at   time.Time
}

const clientTTL = 5 * time.Second

func (l *Lifecycle) clientsOpen(ctx context.Context, id string) bool {
	c := &l.clients
	c.mu.Lock()
	if s, ok := c.seen[id]; ok && time.Since(s.at) < clientTTL {
		c.mu.Unlock()
		return s.open
	}
	c.mu.Unlock()
	open := l.tmux.HasClients(ctx, id)
	c.mu.Lock()
	if c.seen == nil {
		c.seen = map[string]clientSeen{}
	}
	c.seen[id] = clientSeen{open: open, at: time.Now()}
	c.mu.Unlock()
	return open
}

// OnStatusLine is POST /api/statusline/:h/:id's work: a Claude Code report past the gate sets the agent's context size
// and window, records its cost, tokens and subscription windows in the usage tables, then runs the context watcher
// (onContext) and the cold-turn and cache-window measures on the session's transcript. It returns whether anyone views
// the agent; only tmux clients count here (the server adds the web view and web terminals).
func (l *Lifecycle) OnStatusLine(ctx context.Context, harness string, a db.Agent, payload jsjson.Value) (bool, error) {
	if harness == "claude" {
		p, _ := payload.(*jsjson.Object)
		slot := harness + "/" + a.ID
		if l.gate.pass(slot, p, time.Now()) {
			// The work runs to its end whatever the request does: the status-line script gives up after a second,
			// and a cancel mid-way would leave a level without its event or notice.
			wctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), statusLineTimeout)
			err := l.applyStatusLine(wctx, a, p)
			cancel()
			if err != nil {
				l.gate.drop(slot)
				return false, err
			}
		}
	}
	return l.clientsOpen(ctx, a.ID), nil
}

// statusLineTimeout bounds one report's work, which no longer ends with its request.
const statusLineTimeout = 30 * time.Second

// statusLock is the agent's status-line lock: TS handles one report at a time, and two at once would both read the old
// level or the same pending mark, and record context:threshold or cache:cold twice.
func (l *Lifecycle) statusLock(id string) *sync.Mutex {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.statusLocks == nil {
		l.statusLocks = map[string]*sync.Mutex{}
	}
	m := l.statusLocks[id]
	if m == nil {
		m = &sync.Mutex{}
		l.statusLocks[id] = m
	}
	return m
}

func (l *Lifecycle) applyStatusLine(ctx context.Context, a db.Agent, p *jsjson.Object) error {
	lock := l.statusLock(a.ID)
	lock.Lock()
	defer lock.Unlock()
	// The row as it is now, as TS reads it for each report: the usage baseline the report before this one wrote.
	a, err := l.db.GetAgent(ctx, a.ID)
	if errors.Is(err, db.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	f := claude.OnStatusLine(p)
	// The transcript path is the session's identity; the reader runs on every report, as TS's onStatusLine reads the
	// session's tokens, so the cache window is up to date below.
	session := f.Session
	if !f.HasSession {
		session = deref(a.TranscriptPath)
	}
	r := usageReport{counts: [len(counters)]*float64{f.Cost}}
	if totals, ok := l.transcripts.Tokens(session); ok {
		r.counts[1], r.counts[2], r.counts[3], r.counts[4] = &totals.Input, &totals.Output, &totals.CacheRead, &totals.CacheWrite
	}
	if session != "" {
		r.session = &session
	}
	if f.ContextTokens != nil || f.HasWindow {
		if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "context_tokens", Val: sqlNumber(f.ContextTokens)},
			db.Field{Col: "context_window", Val: sqlNumber(f.ContextWindow)}); err != nil {
			return err
		}
	}
	// The usage tables are accounting: a failure there is logged, and the context work goes on.
	if err := l.reportStatusline(ctx, a, r, f.RateLimits); err != nil {
		slog.Warn("lifecycle: usage report failed", "agent", a.ID, "err", err)
	}
	if n, ok := f.ContextTokens.(float64); ok {
		l.onContext(ctx, a.ID, n)
	}
	if session != "" {
		l.onCacheTurn(ctx, a.ID, session)
	}
	l.onCacheTTL(ctx, a.ID, l.transcripts.TTL(session))
	return nil
}

// sqlNumber is how better-sqlite3 binds a JSON value: an integral number as an integer, another number as a real,
// null as NULL, a string as text, and anything else as its JSON text (TS would refuse it; a report never sends one).
func sqlNumber(v jsjson.Value) any {
	switch x := v.(type) {
	case nil:
		return nil
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1<<53 {
			return int64(x)
		}
		return x
	case string:
		return x
	}
	return jsjson.Stringify(v, "")
}

// ownerPaused is whether a human or an agent paused the agent: a pause owner other than the rest. A rest takes the push
// on coming up idle, and a cost pause has no owner (admit decides its turns, probes included).
func ownerPaused(a db.Agent) bool {
	if a.Lifecycle != "paused" {
		return false
	}
	for _, o := range pauseOwners(a) {
		if o != restOwner {
			return true
		}
	}
	return false
}
