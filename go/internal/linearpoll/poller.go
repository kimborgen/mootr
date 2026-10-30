// Package linearpoll is the Linear event source (src/sources/linear.ts, S-56, S-4331): a poller that turns changes on the
// Linear issues and teams agents and ITSAs watch into external events. Every interval it polls each `linear:TEAM-123` and
// `linear:team:KEY` subject that something watches, through Linear's MCP server (the `linear` entry in mcpServers, logged
// in once through the shared OAuth), keeps one snapshot per subject in watch_state, and posts one event per change with a
// dedupe key that names the change's time. The first poll of an issue records its snapshot silently; the first poll of a
// team records a cursor and lists no history.
//
// The rules of a poll, which the tests pin:
//   - A tick never overlaps the previous one (ErrBusy), and Close waits for the tick in flight, so the database can close after.
//   - A poll's events and its snapshot are stored in one transaction, so a stop leaves both or neither: none is missed and none
//     repeats (TS stores the snapshot first, so a stop between the two loses the events).
//   - A failed call or list stores nothing, so the cursor never moves on an error. A rate limit (HTTP 429, or a message that
//     says so) also pauses every poll for five minutes.
//   - Events and snapshot are stored only if someone watches the subject when the transaction begins, so a watch removed during
//     a poll does not get its row back. The rows of a subject (an issue's, or a team's cursor and snapshots) that nobody has
//     watched for a week are dropped at the end of a tick, after any poll of it has finished (the tick is one step at a
//     time); TS never drops them.
//   - No credential reaches a log line, an error, an event or the stored state (see mcpclient.go).
package linearpoll

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"stam/internal/events"
	"stam/internal/jsjson"
)

// Server is the stam name of the Linear MCP server in mcpServers.
const Server = "linear"

// Tools are the names of the MCP tools the poller calls (settings watch.linearTools).
type Tools struct{ Issue, Comments, TeamIssues string }

// DefaultTools are the tool names when the settings name none.
var DefaultTools = Tools{Issue: "get_issue", Comments: "list_comments", TeamIssues: "list_issues"}

// Row is a subject's row in watch_state.
type Row struct{ State, UpdatedAt string }

// Store is the poller's ground: the subjects watched, the rows of the poll state, and the writes to them.
type Store interface {
	// Watched is every subject a live subscription or an open event wait names.
	Watched(ctx context.Context) ([]string, error)
	// Row is a subject's row; ok false when it has none.
	Row(ctx context.Context, subject string) (Row, bool, error)
	// Apply stores a poll's events and state as subject's row in ONE transaction, unless nobody watches `watched` when it
	// begins. subject is `watched` itself, or a row under it (a team's issue). Events may be none (a cursor). A repeat of a
	// dedupe key is dropped. A stop leaves both or neither, so a restart repeats nothing and misses nothing. written is
	// false when the watch is gone and nothing was stored.
	Apply(ctx context.Context, watched, subject string, evs []events.Input, state string) (stored int, written bool, err error)
	// StateSubjects is the subjects with a row that start with prefix.
	StateSubjects(ctx context.Context, prefix string) ([]string, error)
	// DropTree deletes the rows of the given subjects and the rows under them (`subject/...`), for each subject that
	// nobody watches and whose own row was last written before olderThan, checked in the delete's transaction.
	DropTree(ctx context.Context, subjects []string, olderThan time.Time) error
}

// Caller calls a tool on an MCP server (Client).
type Caller interface {
	CallTool(ctx context.Context, name, tool string, args *jsjson.Object) (*jsjson.Object, error)
}

// Options is a poller's parts.
type Options struct {
	Store  Store
	Client Caller
	// Tools are the tool names, read at each tick; DefaultTools when nil.
	Tools func() Tools
	// Interval is the tick interval; Start does nothing for 0 or less.
	Interval time.Duration
	Now      func() time.Time
}

// Poller polls the watched Linear subjects.
type Poller struct {
	o Options

	running atomic.Bool

	mu           sync.Mutex
	backoffUntil time.Time
	logged       map[string]bool
	cancel       context.CancelFunc
	started      bool
	closed       bool

	wg sync.WaitGroup

	// hooks a test sets to land an interleaving at a named step; nil does nothing.
	hookAfterPoll  func(subject string)
	hookBeforeDrop func()
}

// New is a poller that has not started.
func New(o Options) *Poller {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Tools == nil {
		o.Tools = func() Tools { return DefaultTools }
	}
	return &Poller{o: o, logged: map[string]bool{}}
}

// logOnce logs a message once per daemon, so a missing login doesn't repeat every tick.
func (p *Poller) logOnce(msg string) {
	p.mu.Lock()
	seen := p.logged[msg]
	p.logged[msg] = true
	p.mu.Unlock()
	if !seen {
		slog.Error("linear: " + msg)
	}
}

const (
	teamPage = 50
	// teamCommentsPerTick is the comment calls one tick makes for a team; the changes past them carry over to the next tick.
	teamCommentsPerTick = 10
	// teamPagesMax is the pages one list may read. A list that never ends (a server that ignores `after`, or never runs
	// out) fails at this cap instead of hanging the tick.
	teamPagesMax = 200
	// stateRetention is how long the rows of a subject nobody watches are kept: a watch that comes back sooner reuses its
	// cursor or snapshot.
	stateRetention = 7 * 24 * time.Hour
	// rateBackoff is how long a rate-limited reply pauses every poll.
	rateBackoff = 5 * time.Minute
)

// rateLimitedText matches a 429 only as the client words it ("HTTP 429") or as a rate-limit message, never a bare 429: an
// issue id such as ENG-429 is in no error text, but a tool's message may name one.
var rateLimitedText = regexp.MustCompile(`(?i)\bHTTP 429\b|rate.?limit`)

// rateLimited is whether err is a 429 from the server or a rate-limit message.
func rateLimited(err error) bool {
	var se *StatusError
	if errors.As(err, &se) && se.Status == 429 {
		return true
	}
	return rateLimitedText.MatchString(err.Error())
}

// ResetBackoff ends a rate-limit pause (tests).
func (p *Poller) ResetBackoff() {
	p.mu.Lock()
	p.backoffUntil = time.Time{}
	p.mu.Unlock()
}

// BackoffUntil is when the poller polls again after a rate-limited reply; zero when it isn't paused.
func (p *Poller) BackoffUntil() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.backoffUntil
}

func (p *Poller) setBackoff() {
	p.mu.Lock()
	p.backoffUntil = p.o.Now().Add(rateBackoff)
	p.mu.Unlock()
}

// ErrBusy is a tick asked for while another still runs: ticks never overlap.
var ErrBusy = errors.New("a tick is still running")

func isLinear(s string) bool { return strings.HasPrefix(s, "linear:") }

// Tick is one poll of every watched Linear issue and team, then the cleanup of the teams nobody watches. It returns how many
// events it ingested. Only one tick runs at a time (ErrBusy otherwise); a subject's poll, its events and its snapshot are
// one step of the tick, so the cleanup that follows never meets a poll in flight.
//
// Contexts: ctx is the poller's own (cancelled at Close), for every step: the calls to Linear carry a 20 s timeout per
// request inside the client, and the ingest and the snapshot write do not, so a timed-out call never cuts an event or a write.
func (p *Poller) Tick(ctx context.Context) (int, error) {
	if !p.running.CompareAndSwap(false, true) {
		return 0, ErrBusy
	}
	defer p.running.Store(false)
	if p.o.Now().Before(p.BackoffUntil()) {
		return 0, nil
	}
	watched, err := p.o.Store.Watched(ctx)
	if err != nil {
		return 0, err
	}
	sort.Strings(watched)
	ingested := 0
	for _, subject := range watched {
		if !isLinear(subject) {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		var n int
		var err error
		if key, ok := ParseTeamSubject(subject); ok {
			n, err = p.tickTeam(ctx, subject, key)
		} else if _, ok := ParseSubject(subject); ok {
			n, err = p.tickIssue(ctx, subject)
		} else {
			p.logOnce("ignoring subject " + subject + ": only linear:TEAM-123 issues and linear:team:KEY are polled")
			continue
		}
		ingested += n
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			msg := err.Error()
			limited := rateLimited(err)
			if limited {
				p.setBackoff()
			}
			kind := "poll "
			if strings.HasPrefix(subject, "linear:team:") {
				kind = "team "
			}
			p.logOnce(kind + subject + " poll failed: " + msg)
			if limited {
				break
			}
		}
	}
	if ctx.Err() == nil {
		p.dropUnwatched(ctx)
	}
	return ingested, nil
}

// dropUnwatched forgets the rows of a subject (an issue's snapshot, or a team's cursor and its issues' snapshots) once no
// subscription has watched it for a week. The delete reads the watchers itself, so a watch added after the list was read keeps
// its rows, and it keeps a row written within the retention, so a watch that comes back reuses it.
func (p *Poller) dropUnwatched(ctx context.Context) {
	// Read now, not at the start of the tick: a watch that went during the tick is judged by this tick's cleanup.
	now, err := p.o.Store.Watched(ctx)
	if err != nil {
		slog.Error("linear: watched subjects not listed", "err", err)
		return
	}
	watched := map[string]bool{}
	for _, s := range now {
		watched[s] = true
	}
	rows, err := p.o.Store.StateSubjects(ctx, "linear:")
	if err != nil {
		slog.Error("linear: poll state not listed", "err", err)
		return
	}
	var stale []string
	for _, s := range rows {
		if !strings.Contains(s, "/") && !watched[s] {
			stale = append(stale, s)
		}
	}
	if len(stale) == 0 {
		return
	}
	if p.hookBeforeDrop != nil {
		p.hookBeforeDrop()
	}
	if err := p.o.Store.DropTree(ctx, stale, p.o.Now().Add(-stateRetention)); err != nil {
		slog.Error("linear: poll state not dropped", "err", err)
	}
}

// call runs one tool and returns what it answered with, parsed.
func (p *Poller) call(ctx context.Context, tool string, args *jsjson.Object) (jsjson.Value, error) {
	res, err := p.o.Client.CallTool(ctx, Server, tool, args)
	if err != nil {
		return nil, err
	}
	return JSONOf(res), nil
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// inputs is the events a poll found, as the events service takes them.
func inputs(evs []Event) []events.Input {
	out := make([]events.Input, 0, len(evs))
	for _, e := range evs {
		in := events.Input{Source: "linear", Type: e.Type, Subjects: []string{e.Subject}, Actor: e.Actor, URL: e.URL, DedupeKey: e.DedupeKey}
		summary := e.Summary
		in.Summary = &summary
		if e.Issue != "" {
			in.Payload, in.HasPayload = jsjson.NewObject("issue", e.Issue), true
		}
		out = append(out, in)
	}
	return out
}

func marshal(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// tickIssue polls one issue: its fields and comments through the Linear MCP server, then posts the events its changes make
// and stores the snapshot. A failed call stores nothing, so the old snapshot stays.
func (p *Poller) tickIssue(ctx context.Context, subject string) (int, error) {
	id, _ := ParseSubject(subject)
	row, ok, err := p.o.Store.Row(ctx, subject)
	if err != nil {
		return 0, err
	}
	var prev *Snapshot
	if ok {
		prev = ParseSnapshot(row.State)
	}
	tools := p.o.Tools()
	raw, err := p.call(ctx, tools.Issue, jsjson.NewObject("id", id))
	if err != nil {
		return 0, err
	}
	issue := NormalizeIssue(raw, id)
	raw, err = p.call(ctx, tools.Comments, jsjson.NewObject("issueId", id))
	if err != nil {
		return 0, err
	}
	comments := NormalizeComments(raw)
	evs := DiffIssue(subject, prev, issue, comments, "")
	state := marshal(MakeSnapshot(issue, comments, prev))
	if p.hookAfterPoll != nil {
		p.hookAfterPoll(subject)
	}
	// The events and the snapshot go in one transaction that checks the watch when it begins: a watch that went while the calls
	// were out stores neither. It counts each event handed over, as TS does, whether or not it was new.
	_, written, err := p.o.Store.Apply(ctx, subject, subject, inputs(evs), state)
	if err != nil || !written {
		return 0, err
	}
	return len(evs), nil
}

// teamRow is a team's own row: its cursor, and the baseline it was first polled at.
type teamRow struct {
	Cursor   string `json:"cursor"`
	Baseline string `json:"baseline"`
}

func parseTeamRow(raw string) teamRow {
	v, err := jsjson.Parse([]byte(raw))
	o, ok := v.(*jsjson.Object)
	if err != nil || !ok {
		return teamRow{}
	}
	str := func(k string) string {
		if v, _ := o.Get(k); jsjson.Truthy(v) {
			return jsjson.ToString(v)
		}
		return ""
	}
	return teamRow{Cursor: str("cursor"), Baseline: str("baseline")}
}

// listTeamIssues is the team's issues changed since `since`, oldest first. It returns an error when a page fails, when a
// page's endCursor is the one it was asked for (the list did not move on), and past teamPagesMax pages.
func (p *Poller) listTeamIssues(ctx context.Context, key, since string) ([]Issue, error) {
	tool := p.o.Tools().TeamIssues
	var out []Issue
	after := ""
	for page := 1; ; page++ {
		if page > teamPagesMax {
			return nil, errors.New("linear team " + key + ": more than 200 pages of changes")
		}
		args := jsjson.NewObject("team", key, "updatedAt", since, "orderBy", "updatedAt", "limit", float64(teamPage))
		if after != "" {
			args.Set("after", after)
		}
		o, err := p.call(ctx, tool, args)
		if err != nil {
			return nil, err
		}
		var list []jsjson.Value
		if l, ok := o.([]jsjson.Value); ok {
			list = l
		} else if l, ok := prop(o, "issues").([]jsjson.Value); ok {
			list = l
		} else if l, ok := prop(o, "nodes").([]jsjson.Value); ok {
			list = l
		}
		for _, raw := range list {
			if _, ok := raw.(*jsjson.Object); !ok {
				continue
			}
			id := ""
			if v := firstOf(prop(raw, "identifier"), prop(raw, "id")); v != nil {
				id = jsjson.ToString(v)
			}
			out = append(out, NormalizeIssue(raw, id))
		}
		info := prop(o, "pageInfo")
		if !jsjson.Truthy(prop(info, "hasNextPage")) {
			break
		}
		endV := prop(info, "endCursor")
		end := ""
		if jsjson.Truthy(endV) {
			end = jsjson.ToString(endV)
		}
		if end == "" || end == after {
			return nil, errors.New("linear team " + key + ": the list did not move past page " + jsjson.Number(float64(page)))
		}
		after = end
	}
	kept := out[:0]
	for _, i := range out {
		if i.ID != "" {
			kept = append(kept, i)
		}
	}
	sort.SliceStable(kept, func(a, b int) bool { return strVal(kept[a].UpdatedAt) < strVal(kept[b].UpdatedAt) })
	return kept, nil
}

func teamEvent(typ, team, subject, summary, key string, cur Issue) Event {
	return Event{Type: typ, Subject: team, URL: cur.URL, Summary: summary, DedupeKey: key, Issue: subject}
}

// tickTeam is one poll of a team. The first poll sets the team's cursor and baseline to now and lists nothing, so the history
// before it is not replayed. Each later poll lists the issues changed since the cursor, every page of them, sorted locally (so
// Linear's order does not matter), and works through them oldest first with at most teamCommentsPerTick comment calls; the rest
// carry over to the next tick. An issue already snapshotted at its updatedAt takes no call and no cap. The cursor moves only
// past the issues processed, and never on a failed list. Each issue's snapshot is `${team}/${id}`, so the issue's own subject is
// never touched. It returns how many events it ingested.
func (p *Poller) tickTeam(ctx context.Context, subject, key string) (int, error) {
	tools := p.o.Tools()
	row, ok, err := p.o.Store.Row(ctx, subject)
	if err != nil {
		return 0, err
	}
	var tr teamRow
	if ok {
		tr = parseTeamRow(row.State)
	}
	if tr.Cursor == "" {
		// The first poll: the cursor and the baseline are now, and no history is read.
		now := iso(p.o.Now())
		_, _, err := p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: now, Baseline: now}))
		return 0, err
	}
	baseline := tr.Baseline
	if baseline == "" {
		baseline = tr.Cursor
	}
	issues, err := p.listTeamIssues(ctx, key, tr.Cursor)
	if err != nil {
		return 0, err
	}
	next := tr.Cursor
	ingested, calls := 0, 0
	loop := func() error {
		for _, cur := range issues {
			snapSubject := subject + "/" + cur.ID
			snapRow, ok, err := p.o.Store.Row(ctx, snapSubject)
			if err != nil {
				return err
			}
			var prev *Snapshot
			if ok {
				prev = ParseSnapshot(snapRow.State)
			}
			upd := strVal(cur.UpdatedAt)
			// A snapshot already at this updatedAt has nothing new: no comment call, no cap, and the cursor moves past it.
			// Without this, ten issues sharing one updatedAt would hold the cursor for good.
			if prev != nil && upd != "" && prev.UpdatedAt != nil && *prev.UpdatedAt == upd {
				if next == "" || upd > next {
					next = upd
				}
				continue
			}
			if calls >= teamCommentsPerTick {
				return nil
			}
			raw, err := p.call(ctx, tools.Comments, jsjson.NewObject("issueId", cur.ID))
			if err != nil {
				return err
			}
			comments := NormalizeComments(raw)
			calls++
			issueSubject := "linear:" + cur.ID
			evs := DiffIssue(issueSubject, prev, cur, comments, subject)
			if prev == nil {
				created, updated := strVal(cur.CreatedAt), upd
				if created != "" && created > baseline {
					evs = append(evs, teamEvent("issue.created", subject, issueSubject, strings.TrimSpace(cur.ID+" created: "+strVal(cur.Title)), "issue.created:"+subject+":"+issueSubject, cur))
				} else if updated != "" && updated > baseline {
					evs = append(evs, teamEvent("issue.updated", subject, issueSubject, strings.TrimSpace(cur.ID+" updated: "+strVal(cur.Title)), "issue.updated:"+subject+":"+issueSubject+":"+updated, cur))
				}
			}
			if p.hookAfterPoll != nil {
				p.hookAfterPoll(subject)
			}
			_, written, err := p.o.Store.Apply(ctx, subject, snapSubject, inputs(evs), marshal(MakeSnapshot(cur, comments, prev)))
			if err != nil || !written {
				return err
			}
			ingested += len(evs)
			if upd != "" && (next == "" || upd > next) {
				next = upd
			}
		}
		return nil
	}
	loopErr := loop()
	// The cursor is stored after every successful list (as TS does), whatever stopped the loop (a failed call included), moved
	// past the issues processed so far. A quiet team's row keeps a fresh updated_at, so the retention never mistakes a team
	// watched all week for one unwatched all week.
	if _, _, err := p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: next, Baseline: baseline})); err != nil && loopErr == nil {
		loopErr = err
	}
	return ingested, loopErr
}

// StateView is what the dashboard shows of a polled issue (src/sources/linear.ts stateFor): its state, assignee, priority,
// title and url, and when the row was stored.
type StateView struct {
	State     *string `json:"state"`
	Assignee  *string `json:"assignee"`
	Priority  *string `json:"priority"`
	Title     *string `json:"title"`
	URL       *string `json:"url"`
	UpdatedAt string  `json:"updated_at"`
}

// NoState is a subject with no row.
type NoState struct {
	UpdatedAt *string `json:"updated_at"`
}

// StateFor is, per requested subject, what the dashboard shows (S-65): a StateView, or a NoState.
func StateFor(ctx context.Context, st Store, subjects []string) (map[string]any, error) {
	out := map[string]any{}
	for _, subject := range subjects {
		row, ok, err := st.Row(ctx, subject)
		if err != nil {
			return nil, err
		}
		if !ok {
			out[subject] = NoState{}
			continue
		}
		s := ParseSnapshot(row.State)
		if s == nil {
			s = &Snapshot{}
		}
		out[subject] = StateView{State: s.State, Assignee: s.Assignee, Priority: s.Priority, Title: s.Title, URL: s.URL, UpdatedAt: row.UpdatedAt}
	}
	return out, nil
}

// Start runs a tick every Interval until Close. It does nothing for an interval of 0 or less, or once started.
func (p *Poller) Start(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.started || p.closed || !(p.o.Interval > 0) {
		return
	}
	p.started = true
	ctx, p.cancel = context.WithCancel(ctx)
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		t := time.NewTicker(p.o.Interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if _, err := p.Tick(ctx); err != nil && !errors.Is(err, ErrBusy) && ctx.Err() == nil {
					slog.Error("linear: tick failed", "err", err)
				}
			}
		}
	}()
}

// Close stops the ticks and waits for the one in flight, so the database can close after it. The tick's context is cancelled
// first, which ends its calls to Linear; an event or a snapshot it was writing is cut whole by its transaction, and the next
// start polls it again.
func (p *Poller) Close() {
	p.mu.Lock()
	p.closed = true
	cancel := p.cancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	p.wg.Wait()
}
