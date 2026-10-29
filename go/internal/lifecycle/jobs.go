package lifecycle

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// OpenCode job waits (src/adapters/opencode.ts trackJobs, syncJobWaits, readJobs, S-4237). The background shells and
// sub-agents (child sessions) of an agent's session that still run when its execution ends are its waits of kind job,
// source hook, so it ends waiting, not idle. When one of them ends OpenCode queues a completion notice that starts a new
// execution, which replaces the waits from what is tracked then; if none starts within the grace, the wait clears.
//
// Ownership: jobTracker is the one owner of what is tracked (shells, children, and the ids an event touched while a seed
// reads), under its own lock mu. Event handling (track), a seed's result being applied (applySeed) and a grace expiring
// (expire) are its only transitions, and every job wait write is made under mu too, so writes follow the tracking in the
// order it changed. The seed's HTTP reads run outside mu; only applying them is serialized, and it keeps what an event
// touched since the seed began. A write for an agent goes through its owner (owner.writeIf), which rechecks the agent's
// session and generation in the write's own step: never after a stop, a launch or an archive that came first.
//
// Lock order: jobTracker.mu, then Lifecycle.mu (the owner lookup), then owner.mu, then the db. Nothing that holds
// owner.mu or Lifecycle.mu takes jobTracker.mu, so no path takes the owner and then calls into the tracker: an
// execution's end binds the session and generation (owner.endExec, released), syncs the waits (tracker, then owner), then
// writes the idle (owner), one lock at a time; a stop, launch or archive takes the owner alone and never reads the
// job list.

// jobGrace is how long a finished job's wait stays when no execution of its agent starts (TS: 30 s).
const jobGrace = 30 * time.Second

type jobShell struct {
	session, command string
	seq              int
}

type jobChild struct {
	parent, title string
	running       bool
	seq           int
}

type jobTracker struct {
	mu       sync.Mutex
	shells   map[string]*jobShell
	children map[string]*jobChild
	// seq numbers what is tracked in the order it came, so the waits are written in it.
	seq int
	// touched is the ids an event touched since the running seed began; nil while no seed runs.
	touched map[string]bool
	// ran is, for a child session an event touched that nothing tracked (its session.created came before the stream
	// connected), whether the last execution event said it runs: the seed adopts it from its listing with that state.
	ran map[string]bool
	// again is whether a connect came while a seed ran: its reads predate that connect, so one more seed follows it.
	again bool
}

func newJobTracker() *jobTracker {
	return &jobTracker{shells: map[string]*jobShell{}, children: map[string]*jobChild{}}
}

// jobWaitsOf is the agent's session's running jobs as hook waits, shells and child sessions each in the order they came.
func (t *jobTracker) jobWaitsOf(session string) []db.HookWait {
	type item struct {
		seq  int
		wait db.HookWait
	}
	var shells, children []item
	for id, s := range t.shells {
		if s.session == session {
			data := `{"type":"shell"}`
			shells = append(shells, item{s.seq, db.HookWait{Target: id, Detail: `background command "` + s.command + `"`, Data: &data}})
		}
	}
	for id, c := range t.children {
		if c.parent == session && c.running {
			data := `{"type":"subagent"}`
			children = append(children, item{c.seq, db.HookWait{Target: id, Detail: `sub-agent "` + c.title + `"`, Data: &data}})
		}
	}
	var out []db.HookWait
	for _, list := range [][]item{shells, children} {
		sort.Slice(list, func(i, j int) bool { return list[i].seq < list[j].seq })
		for _, it := range list {
			out = append(out, it.wait)
		}
	}
	return out
}

// beginSeed starts a seed's record of what events touch, under t.mu.
func (t *jobTracker) beginSeed() {
	t.touched, t.ran = map[string]bool{}, map[string]bool{}
}

func (t *jobTracker) running(session, target string) bool {
	for _, w := range t.jobWaitsOf(session) {
		if w.Target == target {
			return true
		}
	}
	return false
}

func (t *jobTracker) touch(ids ...string) {
	if t.touched == nil {
		return
	}
	for _, id := range ids {
		if id != "" {
			t.touched[id] = true
		}
	}
}

// ocStrOK is o's string at key and whether it has one.
func ocStrOK(o *jsjson.Object, key string) (string, bool) {
	s, ok := ocField(o, key).(string)
	return s, ok
}

// trackJobs is TS trackJobs: it follows the shells and child sessions the events tell of, which aren't an agent's own
// session, and starts the grace of one that ended. While a seed reads, only an event that says something about a job's
// state (created, exited, started, ended) marks its id touched, so the seed's listing is kept for the rest: an event
// that changes no state (a tool call, say) never discards the seed's record of a job the tracker doesn't know. Unlike TS,
// which marks every id an event names.
func (l *Lifecycle) trackJobs(ctx context.Context, ev openCodeEventView) {
	t := l.jobs
	t.mu.Lock()
	defer t.mu.Unlock()
	d := ev.data
	info, _ := ocField(d, "info").(*jsjson.Object)
	switch ev.typ {
	case "shell.created":
		meta, _ := ocField(info, "metadata").(*jsjson.Object)
		id, session := ocStr(info, "id"), ocStr(meta, "sessionID")
		if id != "" && session != "" {
			t.touch(id)
			s := t.shells[id]
			if s == nil {
				t.seq++
				s = &jobShell{seq: t.seq}
				t.shells[id] = s
			}
			s.session, s.command = session, ocStr(info, "command")
		}
	case "shell.exited":
		id := ocStr(d, "id")
		t.touch(id)
		if s := t.shells[id]; s != nil {
			delete(t.shells, id)
			l.jobEnded(ctx, s.session, id)
		}
	case "session.created":
		parent, id := ocStr(d, "parentID"), ocStr(d, "sessionID")
		if parent != "" && id != "" {
			t.touch(id)
			title, ok := ocStrOK(d, "title")
			if !ok {
				if title, ok = ocStrOK(d, "slug"); !ok {
					title = id
				}
			}
			c := t.children[id]
			if c == nil {
				t.seq++
				c = &jobChild{seq: t.seq}
				t.children[id] = c
			}
			c.parent, c.title, c.running = parent, title, false
		}
	case "session.execution.started":
		id := ocStr(d, "sessionID")
		t.touch(id)
		if c := t.children[id]; c != nil {
			c.running = true
		} else if t.touched != nil {
			t.ran[id] = true
		}
	case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
		id := ocStr(d, "sessionID")
		t.touch(id)
		if c := t.children[id]; c != nil && c.running {
			c.running = false
			l.jobEnded(ctx, c.parent, id)
		} else if c == nil && t.touched != nil {
			t.ran[id] = false
		}
	}
}

// openCodeEventView is the part of an event trackJobs reads.
type openCodeEventView struct {
	typ  string
	data *jsjson.Object
}

// jobEnded starts the grace of a job of session that ended (TS jobEnded), under t.mu: the agent that runs the session
// now, bound with its generation. After the grace its wait clears, only while it is still the agent's, expire.
func (l *Lifecycle) jobEnded(ctx context.Context, session, target string) {
	a, err := l.db.AgentBySession(ctx, session)
	if err != nil {
		return
	}
	sid, gen := l.ownerOf(a.ID).bind(l.runningTurn(ctx, a.ID))
	if sid != session {
		return
	}
	grace := l.jobGrace
	if grace <= 0 {
		grace = jobGrace
	}
	fire := func() { l.expireJob(a.ID, session, gen, target) }
	if l.jobAfter != nil {
		l.jobAfter(grace, fire)
		return
	}
	time.AfterFunc(grace, fire)
}

// expireJob clears the wait of a job that ended, once its grace is out (TS jobEnded's timer): only while the agent
// still runs the session it ended in, under the launch it ended in (owner.writeIf), is still waiting, and the job isn't
// running again. Only that target's wait goes.
func (l *Lifecycle) expireJob(id, session string, gen int, target string) {
	if l.ctx.Err() != nil {
		return
	}
	t := l.jobs
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.running(session, target) {
		return
	}
	_, err := l.ownerOf(id).writeIf(gen, session, l.runningTurn(l.ctx, id), func() error {
		_, err := l.db.ClearHookWaitWhile(l.ctx, id, "job", target, "waiting")
		return err
	})
	if err != nil && l.ctx.Err() == nil && !errors.Is(err, db.ErrNotFound) {
		slog.Error("opencode: job wait not cleared", "agent", id, "err", err)
	}
	l.jobAt(id, "expired")
}

// syncJobWaits is TS syncJobWaits: the agent's job waits made exactly the running jobs of its session sid, written
// under the agent's owner while it still runs sid under gen, as bound by the caller (owner.bind, startExec or endExec). It reports whether it
// wrote.
func (l *Lifecycle) syncJobWaits(ctx context.Context, id, sid string, gen int) bool {
	t := l.jobs
	t.mu.Lock()
	defer t.mu.Unlock()
	return l.syncLocked(ctx, id, sid, gen)
}

// syncLocked writes the waits under t.mu; with activities, only while the agent's activity is one of them, checked in
// the write's transaction (a seed resyncs only agents between executions).
func (l *Lifecycle) syncLocked(ctx context.Context, id, sid string, gen int, activities ...string) bool {
	if sid == "" {
		return false
	}
	want := l.jobs.jobWaitsOf(sid)
	wrote := false
	_, err := l.ownerOf(id).writeIf(gen, sid, l.runningTurn(ctx, id), func() (err error) {
		wrote, err = l.db.ReplaceHookWaitsWhile(ctx, id, "job", want, activities...)
		return err
	})
	if err != nil && ctx.Err() == nil {
		slog.Error("opencode: job waits not written", "agent", id, "err", err)
	}
	l.jobAt(id, "synced")
	return wrote && err == nil
}

// jobAt runs a test's hook at a step of a job wait's write.
func (l *Lifecycle) jobAt(id, step string) {
	if l.jobStep != nil {
		l.jobStep(id, step)
	}
}

// seedJobs is TS seedJobs, on each (re)connect to the event stream, before its first event: it reads what the server
// runs now and replaces the tracking with it. Seeds coalesce: a connect while one runs marks it dirty (again), and one
// more seed follows the running one, since its reads predate the connect (TS joins the running one, which a reconnect
// after a server restart can leave with the old server's answer). The reads run off the stream.
func (l *Lifecycle) seedJobs() {
	t := l.jobs
	t.mu.Lock()
	if t.touched != nil {
		t.again = true
		t.mu.Unlock()
		return
	}
	t.beginSeed()
	t.mu.Unlock()
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		for l.readJobs(l.ctx) {
		}
	}()
}

// readJobs is TS readJobs. The server is read outside any lock; a failed read logs and leaves the tracking as it is. It
// reports whether a connect came meanwhile, whose seed it has begun (touched is set again before the lock is let go).
func (l *Lifecycle) readJobs(ctx context.Context) bool {
	t := l.jobs
	agents, err := l.seedAgents(ctx)
	var shells []seedShell
	var children []seedChild
	if err == nil {
		shells, children, err = l.readServerJobs(ctx, agents)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err != nil {
		t.touched, t.ran = nil, nil
		if ctx.Err() == nil {
			slog.Error("opencode: can't read running jobs", "err", err)
		}
	} else {
		l.applySeed(ctx, agents, shells, children)
	}
	again := t.again && ctx.Err() == nil
	t.again = false
	if again {
		t.beginSeed()
	}
	return again
}

type seedShell struct {
	id string
	jobShell
}

type seedChild struct {
	id string
	jobChild
}

// seedAgents is the OpenCode agents with a session that aren't archived.
func (l *Lifecycle) seedAgents(ctx context.Context) ([]db.Agent, error) {
	all, err := l.db.ListLiveAgents(ctx)
	var out []db.Agent
	for _, a := range all {
		if a.Harness == "opencode" && deref(a.SessionID) != "" {
			out = append(out, a)
		}
	}
	return out, err
}

func (l *Lifecycle) readServerJobs(ctx context.Context, agents []db.Agent) ([]seedShell, []seedChild, error) {
	active, err := l.opencode.ActiveSessions(ctx)
	if err != nil {
		return nil, nil, err
	}
	var shells []seedShell
	var children []seedChild
	dirs := map[string]bool{}
	for _, a := range agents {
		if dirs[a.Cwd] {
			continue
		}
		dirs[a.Cwd] = true
		list, err := l.opencode.RunningShells(ctx, a.Cwd)
		if err != nil {
			return nil, nil, err
		}
		for _, s := range list {
			shells = append(shells, seedShell{s.ID, jobShell{session: s.Session, command: s.Command}})
		}
	}
	for _, a := range agents {
		list, err := l.opencode.ChildSessions(ctx, *a.SessionID)
		if err != nil {
			return nil, nil, err
		}
		for _, c := range list {
			children = append(children, seedChild{c.ID, jobChild{parent: *a.SessionID, title: c.Title, running: active[c.ID]}})
		}
	}
	return shells, children, nil
}

// applySeed replaces the tracking with what the seed read, under t.mu, keeping what an event touched since the seed
// began (a stale read never revives an ended job nor drops a newer one), and ends the seed; then it resyncs the waits of
// the agents that are idle or waiting.
func (l *Lifecycle) applySeed(ctx context.Context, agents []db.Agent, shells []seedShell, children []seedChild) {
	t := l.jobs
	touched, ran := t.touched, t.ran
	t.touched, t.ran = nil, nil
	nowShells := map[string]bool{}
	for _, s := range shells {
		nowShells[s.id] = true
	}
	for id := range t.shells {
		if !nowShells[id] && !touched[id] {
			delete(t.shells, id)
		}
	}
	for _, s := range shells {
		if touched[s.id] {
			continue
		}
		cur := t.shells[s.id]
		if cur == nil {
			t.seq++
			cur = &jobShell{seq: t.seq}
			t.shells[s.id] = cur
		}
		cur.session, cur.command = s.session, s.command
	}
	nowChildren := map[string]bool{}
	for _, c := range children {
		nowChildren[c.id] = true
	}
	for id := range t.children {
		if !nowChildren[id] && !touched[id] {
			delete(t.children, id)
		}
	}
	for _, c := range children {
		if touched[c.id] {
			// An event touched it and nothing tracked it: the listing says whose it is and its title, the events how it ran.
			if ran, ok := ran[c.id]; ok && t.children[c.id] == nil {
				t.seq++
				c.running = ran
				cc := c.jobChild
				cc.seq = t.seq
				t.children[c.id] = &cc
			}
			continue
		}
		cur := t.children[c.id]
		if cur == nil {
			t.seq++
			cur = &jobChild{seq: t.seq}
			t.children[c.id] = cur
		}
		cur.parent, cur.title, cur.running = c.parent, c.title, c.running
	}
	for _, a := range agents {
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			continue
		}
		sid, gen := l.ownerOf(a.ID).bind(l.runningTurn(ctx, a.ID))
		if sid != "" && sid == deref(now.SessionID) {
			l.jobAt(a.ID, "seed-bound")
			l.syncLocked(ctx, a.ID, sid, gen, "idle", "waiting")
		}
	}
}
