package lifecycle

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/proctree"
)

// The pause paths cost blockers use (src/lifecycle.ts pauseNow and resumeNow, S-2848 B4a). The human's and an agent's
// pause and unpause routes aren't ported: only stam pauses and resumes here, for its blockers.

// pauseOwners is src/lifecycle.ts pauseOwners: who paused the agent, "human" or agent ids. A paused_by that can't be
// read counts as none.
func pauseOwners(a db.Agent) []string {
	owners, err := a.PausedByOf()
	if err != nil {
		return nil
	}
	return owners
}

// isHeld is src/lifecycle.ts isHeld: someone paused the agent, or it has cost blockers its account's probe turn doesn't
// run past. Blockers that can't be read hold it, so a database error never lets a blocked agent run.
func (l *Lifecycle) isHeld(ctx context.Context, a db.Agent) bool {
	if len(pauseOwners(a)) > 0 {
		return true
	}
	rows, err := l.holding(ctx, a.ID)
	return err != nil || len(rows) > 0
}

// blockerKinds is db.blockerRows(id).map((b) => b.kind), for the launch-held event; empty when they can't be read.
func (l *Lifecycle) blockerKinds(ctx context.Context, id string) []string {
	rows, _ := l.db.BlockerRows(ctx, id)
	kinds := make([]string, 0, len(rows))
	for _, b := range rows {
		kinds = append(kinds, b.Kind)
	}
	return kinds
}

type serialKey struct{ id string }

// serial is src/lifecycle.ts serial: one agent's pause transitions, and the blocker changes inside them, run one at a
// time, so a blocker's add and clear and the pause and resume they cause see one consistent state. fn gets a ctx that
// marks the agent's serial as held, so what it calls (a resume's relaunch) runs inside it rather than waiting on it.
func (l *Lifecycle) serial(ctx context.Context, id string, fn func(ctx context.Context) error) error {
	if ctx.Value(serialKey{id}) != nil {
		return fn(ctx)
	}
	l.mu.Lock()
	if l.serialLocks == nil {
		l.serialLocks = map[string]*serialLock{}
	}
	m := l.serialLocks[id]
	if m == nil {
		m = &serialLock{}
		l.serialLocks[id] = m
	}
	m.users++
	waiting := l.serialWaiting
	l.mu.Unlock()
	// The lock leaves the map once no one holds or waits for it, so the map doesn't grow with every agent ever seen.
	defer func() {
		l.mu.Lock()
		if m.users--; m.users == 0 && l.serialLocks[id] == m {
			delete(l.serialLocks, id)
		}
		l.mu.Unlock()
	}()
	if waiting != nil {
		waiting(id)
	}
	m.Lock()
	defer m.Unlock()
	return fn(context.WithValue(ctx, serialKey{id}, true))
}

// serialLock is one agent's serial lock and how many hold or wait for it, under the Lifecycle's mu.
type serialLock struct {
	sync.Mutex
	users int
}

type pauseEvent struct {
	Owner   string `json:"owner"`
	Already bool   `json:"already,omitempty"`
}

// pauseNow is src/lifecycle.ts pauseNow, within serial. An empty owner is stam pausing for its cost blockers, which
// adds no owner. Pausing a paused agent only adds the owner. The state is written before the agent is told, so a
// transition queued behind this one sees it.
func (l *Lifecycle) pauseNow(ctx context.Context, id, owner string) (string, error) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return "", err
	}
	owners := pauseOwners(a)
	next := owners
	if owner != "" && !contains(owners, owner) {
		next = append(append([]string{}, owners...), owner)
	}
	who := owner
	if who == "" {
		who = "stam"
	}
	if a.Lifecycle == "paused" {
		if len(next) != len(owners) {
			if err := l.db.UpdateAgent(ctx, id, db.Field{Col: "paused_by", Val: jsonText(next)}); err != nil {
				return "", err
			}
		}
		l.event(ctx, id, "pause", pauseEvent{Owner: who, Already: true})
		return "paused", nil
	}
	if a.Lifecycle != "active" {
		return "", fmt.Errorf("%s is %s", a.Name, a.Lifecycle)
	}
	var pausedBy any
	if len(next) > 0 {
		pausedBy = jsonText(next)
	}
	if err := l.db.UpdateAgent(ctx, id, db.Field{Col: "lifecycle", Val: "paused"}, db.Field{Col: "paused_by", Val: pausedBy}); err != nil {
		return "", err
	}
	l.event(ctx, id, "pause", pauseEvent{Owner: who})
	text, err := l.render("pause", nil)
	if err != nil {
		return "", err
	}
	l.prompt(ctx, a, text, "")
	return "paused", nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// resumeNow is src/lifecycle.ts resumeNow, within serial, once nothing holds the agent: text is what it is told. One
// resume at a time per agent (acquire), so two that interleave never launch it twice. An agent whose terminal went
// down with the tmux server while it was paused is launched again on its conversation. Mail and notices that waited
// go in after, as for any idle agent. The wake of a resting agent isn't ported.
func (l *Lifecycle) resumeNow(ctx context.Context, id, text string) (string, error) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return "", err
	}
	release, err := l.acquire(a, "resume")
	if err != nil {
		return "", err
	}
	defer release()
	if l.acquired != nil {
		l.acquired(id)
	}
	if a, err = l.db.GetAgent(ctx, id); err != nil {
		return "", err
	}
	if err := l.assertNotTakenOver(ctx, a); err != nil {
		return "", err
	}
	if a.Lifecycle != "paused" {
		return "", fmt.Errorf("%s is %s", a.Name, a.Lifecycle)
	}
	if ok, reason := l.admit(ctx, id, "unpause"); !ok {
		return "", fmt.Errorf("%s stays paused: %s", a.Name, reason)
	}
	if err := l.db.UpdateAgent(ctx, id, db.Field{Col: "paused_by", Val: nil}); err != nil {
		return "", err
	}
	if a.Workspace != nil && *a.Workspace != "" && !l.tmux.HasSession(ctx, id) {
		if a.SessionID == nil || *a.SessionID == "" {
			return "", fmt.Errorf("%s has no session to resume", a.Name)
		}
		// A compaction a restart cut off may still write to the session: stopped and repaired first (S-2238).
		if err := l.clearInterruptedCompaction(ctx, a); err != nil {
			return "", err
		}
		now, err := l.db.GetAgent(ctx, id)
		if err != nil {
			return "", err
		}
		if err := l.StartHarness(ctx, now, text, true, "unpause"); err != nil {
			return "", err
		}
		l.event(ctx, id, "unpause", nil)
		l.SchedulePush(id)
		return "active", nil
	}
	if err := l.db.UpdateAgent(ctx, id, db.Field{Col: "lifecycle", Val: "active"}); err != nil {
		return "", err
	}
	l.prompt(ctx, a, text, "unpause")
	l.event(ctx, id, "unpause", nil)
	l.SchedulePush(id)
	return "active", nil
}

// clearInterruptedCompaction is src/lifecycle.ts clearInterruptedCompaction: a compactor a daemon restart cut off may
// still run on the session; it is stopped and confirmed gone, and the session repaired, before the agent relaunches.
func (l *Lifecycle) clearInterruptedCompaction(ctx context.Context, a db.Agent) error {
	if l.compactionRunning(a.ID) || a.SessionID == nil || *a.SessionID == "" {
		return nil
	}
	op, ok := l.compactionInterrupted(ctx, a)
	if !ok {
		return nil
	}
	if left := proctree.CompactorProcesses(a.ID, *a.SessionID, a.Cwd); len(left) > 0 {
		pids := make([]int, 0, len(left))
		for pid := range left {
			pids = append(pids, pid)
		}
		sort.Ints(pids)
		l.event(ctx, a.ID, "compact:killed", pidsEvent{Pids: pids})
		if err := proctree.StopAndConfirm(ctx, left, 5*time.Second); err != nil {
			return err
		}
	}
	if err := repairSession(a); err != nil {
		return err
	}
	l.event(ctx, a.ID, "compact:failed", opFailedEvent{Op: op, Error: "cut off by a daemon restart"})
	return nil
}
