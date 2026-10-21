package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	"stam/internal/db"
)

// Context management (src/context.ts): threshold notices, the forced compaction past the enforcement threshold, and
// the compaction of agents idle long enough for their prompt cache to expire. Not ported: the forced compaction's
// lessons and personal-workspace blocks (the Go spawn renders neither yet), and resting agents, whose compaction runs
// headless (compactResting) in the rest clock, which isn't ported: the idle sweep leaves rest-owned agents alone.

// IdleSweepEvery is how often the idle compaction sweep runs (src/daemon.ts: every 60 s).
const IdleSweepEvery = time.Minute

// measuredWindow is how far back the average post-compaction size looks (src/context.ts avgAfterCompaction: 5 days).
const measuredWindow = 5 * 24 * time.Hour

// thousands is src/context.ts k: `${Math.round(n / 1000)}k`.
func thousands(n float64) string { return fmt.Sprintf("%dk", int64(math.Floor(n/1000+0.5))) }

// historyOf is src/context.ts historyOf for a Claude agent: its transcript, else "not available".
func historyOf(a db.Agent) string {
	if a.TranscriptPath != nil {
		return *a.TranscriptPath
	}
	return "not available"
}

// levelOf is src/context.ts levelOf: the level the context is at (0 to 3). After a compaction a threshold counts only
// once the context grew growthTokens past its size right after it (base), so an agent whose summary alone is above a
// threshold isn't compacted again on every turn, throwing its prompt cache away for nothing.
func (l *Lifecycle) levelOf(tokens, base float64) (level int, floor float64) {
	set := l.settings.Get()
	if base != 0 {
		floor = base + math.Max(0, set.IdleCompaction.GrowthTokens)
	}
	at := func(t float64) bool { return tokens >= math.Max(t, floor) }
	switch {
	case at(set.Context.EnforceTokens):
		level = 3
	case at(set.Context.InstructTokens):
		level = 2
	case at(set.Context.WarnTokens):
		level = 1
	}
	return level, floor
}

type measuredEvent struct {
	Tokens float64 `json:"tokens"`
}

type thresholdEvent struct {
	Level  int     `json:"level"`
	Tokens float64 `json:"tokens"`
	Floor  float64 `json:"floor,omitempty"`
}

// onContext is src/context.ts onContext: a size report moves the agent's context level; going up a level records
// context:threshold and warns (1), tells the agent to round off and compact itself (2), or compacts it by force at
// its turn end (3). The first report after a compaction is its measured size.
func (l *Lifecycle) onContext(ctx context.Context, id string, tokens float64) {
	// A harness reports 0 before its first model call, as Claude Code does right after a compaction's relaunch: no
	// size, so it neither measures nor lowers the level.
	if !(tokens > 0) {
		return
	}
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return
	}
	var base float64
	if a.TokensAfterCompaction != nil {
		base = float64(*a.TokensAfterCompaction)
	}
	l.mu.Lock()
	measure := l.measureNext[id]
	delete(l.measureNext, id)
	l.mu.Unlock()
	if measure {
		base = tokens
		l.update(ctx, id, db.Field{Col: "tokens_after_compaction", Val: sqlNumber(tokens)})
		l.event(ctx, id, "compaction:measured", measuredEvent{Tokens: tokens})
	}
	level, floor := l.levelOf(tokens, base)
	if level == a.ContextLevel {
		return
	}
	l.update(ctx, id, db.Field{Col: "context_level", Val: level})
	if level < a.ContextLevel {
		return
	}
	set := l.settings.Get()
	vars := map[string]string{"tokens": thousands(tokens), "instruct": thousands(math.Max(set.Context.InstructTokens, floor)),
		"enforce": thousands(math.Max(set.Context.EnforceTokens, floor)), "history": historyOf(a)}
	l.event(ctx, id, "context:threshold", thresholdEvent{Level: level, Tokens: tokens, Floor: floor})
	switch level {
	case 1:
		if text, err := l.render("context-warning", vars); err == nil {
			l.QueueNotice(ctx, id, l.withRetroReminder(text), false)
		}
	case 2:
		if text, err := l.renderWithRetro("context-instruct", vars); err == nil {
			l.QueueNotice(ctx, id, text, false)
		}
	case 3:
		// The lessons and workspace blocks aren't ported (see above): the note renders without them.
		vars["lessons"], vars["workspace"] = "", ""
		text, err := l.render("compacted-forced", vars)
		if err != nil {
			return
		}
		prompt := l.withRetroReminder(text)
		// TS doesn't wait for it, and drops its failure.
		l.bg.Add(1)
		go func() {
			defer l.bg.Done()
			// The row read above is a report old by now: the request acts on the agent as it is.
			fresh, err := l.db.GetAgent(l.ctx, id)
			if err != nil {
				return
			}
			if _, err := l.requestCompaction(l.ctx, fresh, "", prompt, "enforcement threshold"); err != nil {
				slog.Warn("lifecycle: forced compaction failed", "agent", id, "err", err)
			}
		}()
	}
}

// idleSweep is src/context.ts idleSweep: agents idle longer than the cache lifetime are compacted, once per idle
// period. Rest-owned agents are left alone (resting isn't ported).
func (l *Lifecycle) idleSweep(ctx context.Context) {
	set := l.settings.Get().IdleCompaction
	if !set.Enabled {
		return
	}
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return
	}
	avg, hasAvg := l.avgAfterCompaction(ctx)
	now := time.Now()
	for _, a := range agents {
		if (a.Lifecycle != "active" && a.Lifecycle != "paused") || a.IdleSince == nil || *a.IdleSince == "" || a.ContextTokens == nil || restOwned(a) {
			continue
		}
		// An idle_since that won't parse is NaN in TS, and `now - NaN < x` is false: it counts as idle long enough.
		if since, err := time.Parse(time.RFC3339Nano, *a.IdleSince); err == nil && now.Sub(since) < time.Duration(set.IdleMinutes*float64(time.Minute)) {
			continue
		}
		if l.cacheCompactionHeld(ctx, a, now) {
			continue
		}
		l.idleCompactIfDue(ctx, a, "idle past the cache lifetime", avg, hasAvg)
	}
}

// restOwned is src/db.ts restOwned: paused with the rest among its pause owners.
func restOwned(a db.Agent) bool {
	if a.Lifecycle != "paused" {
		return false
	}
	for _, o := range heldBy(a) {
		if o == restOwner {
			return true
		}
	}
	return false
}

// avgAfterCompaction is src/context.ts avgAfterCompaction: the average measured post-compaction size over 5 days.
func (l *Lifecycle) avgAfterCompaction(ctx context.Context) (float64, bool) {
	since := time.Now().Add(-measuredWindow).UTC().Format("2006-01-02T15:04:05.000Z")
	avg, err := l.db.AvgMeasuredTokens(ctx, since)
	if err != nil || avg == nil {
		return 0, false
	}
	return *avg, true
}

// churnWakes is src/lifecycle.ts CHURN_WAKES: an agent woken this many times within an hour stays up for an hour.
const churnWakes = 3

// cacheCompactionHeld is src/lifecycle.ts cacheCompactionHeld: no idle compaction for an agent the churn guard keeps
// up, or one with a pushed turn since it went idle.
func (l *Lifecycle) cacheCompactionHeld(ctx context.Context, a db.Agent, now time.Time) bool {
	if l.churning(ctx, a.ID, now) {
		return true
	}
	if a.IdleSince == nil {
		return false
	}
	at, err := l.db.LastEventAt(ctx, a.ID, []string{"pushed", "prompt:sent", "view-prompt"})
	return err == nil && at != nil && *at >= *a.IdleSince
}

// churning is src/lifecycle.ts churning: the third wake within an hour of the first, that last one under an hour ago.
func (l *Lifecycle) churning(ctx context.Context, id string, now time.Time) bool {
	ts, err := l.db.EventTimes(ctx, id, "standing:wake", now.Add(-2*time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"))
	if err != nil {
		return false
	}
	wakes := make([]time.Time, 0, len(ts))
	for _, s := range ts {
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			wakes = append(wakes, t)
		}
	}
	for i := churnWakes - 1; i < len(wakes); i++ {
		if now.Sub(wakes[i]) < time.Hour && wakes[i].Sub(wakes[i-churnWakes+1]) < time.Hour {
			return true
		}
	}
	return false
}

type idleCompactionEvent struct {
	Tokens    int     `json:"tokens"`
	Threshold float64 `json:"threshold"`
	Reason    string  `json:"reason"`
}

// idleCompactIfDue is src/context.ts idleCompactIfDue: the agent is compacted, once per idle period (across daemon
// restarts too, by its context:idle-compaction event), when its context grew past the threshold: growthTokens over its
// measured post-compaction size, else over the recent average, else minTokens. true when it asked for one.
func (l *Lifecycle) idleCompactIfDue(ctx context.Context, a db.Agent, reason string, avg float64, hasAvg bool) bool {
	set := l.settings.Get().IdleCompaction
	if !set.Enabled || a.IdleSince == nil || *a.IdleSince == "" || a.ContextTokens == nil {
		return false
	}
	l.mu.Lock()
	done := l.idleCompacted[a.ID] == *a.IdleSince
	l.mu.Unlock()
	if done {
		return false
	}
	if last, err := l.db.LastEventAt(ctx, a.ID, []string{"context:idle-compaction"}); err != nil || (last != nil && *last >= *a.IdleSince) {
		return false
	}
	// A stored 0 dates from before onContext ignored it: no measurement.
	threshold := set.MinTokens
	switch {
	case a.TokensAfterCompaction != nil && *a.TokensAfterCompaction != 0:
		threshold = float64(*a.TokensAfterCompaction) + set.GrowthTokens
	case hasAvg:
		threshold = avg + set.GrowthTokens
	}
	if float64(*a.ContextTokens) <= threshold {
		return false
	}
	l.mu.Lock()
	if l.idleCompacted == nil {
		l.idleCompacted = map[string]string{}
	}
	l.idleCompacted[a.ID] = *a.IdleSince
	l.mu.Unlock()
	l.event(ctx, a.ID, "context:idle-compaction", idleCompactionEvent{Tokens: *a.ContextTokens, Threshold: threshold, Reason: reason})
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		// The sweep's row may be stale by now (TS runs this synchronously): the request acts on the agent as it is,
		// and compactNow claims it idle only if it still is.
		fresh, err := l.db.GetAgent(l.ctx, a.ID)
		if err != nil {
			return
		}
		if _, err := l.RequestCompaction(l.ctx, fresh, "", reason); err != nil && l.ctx.Err() == nil {
			l.event(l.ctx, a.ID, "compaction-error", "Error: "+err.Error())
		}
	}()
	return true
}

// startIdleSweep runs the idle compaction sweep every IdleSweepEvery until the daemon's context ends.
func (l *Lifecycle) startIdleSweep() {
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		t := time.NewTicker(IdleSweepEvery)
		defer t.Stop()
		for {
			select {
			case <-l.ctx.Done():
				return
			case <-t.C:
			}
			ctx, cancel := context.WithTimeout(l.ctx, reconcileTimeout)
			l.idleSweep(ctx)
			cancel()
		}
	}()
}
