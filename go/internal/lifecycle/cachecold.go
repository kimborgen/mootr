package lifecycle

import "context"

// Cold-wake measurement (src/cache-cold.ts, S-2236): which turns re-wrote most of the prompt cache after a wake or a
// compaction, and which cache window (1 h or 5 min) each Claude agent's transcript shows. It measures only; nothing
// here changes when an agent rests or compacts.

// coldShare is src/cache-cold.ts COLD_SHARE: a cache write over this share of the context counts as a cold turn.
const coldShare = 0.8

// coldMark is a `cache:mark` event's data: the cause, and `seen`, the id of the transcript's latest model turn when the
// mark was set; only a later turn counts, so a status line that still reports the old usage isn't measured.
type coldMark struct {
	Cause string `json:"cause"`
	Seen  string `json:"seen,omitempty"`
}

type coldEvent struct {
	Tokens  float64 `json:"tokens"`
	Context float64 `json:"context"`
	Cause   string  `json:"cause"`
}

type ttlEvent struct {
	TTL string `json:"ttl"`
}

// markCompacted is src/context.ts markCompacted: the next turn follows a compaction, so it is marked cold, and the
// next size report becomes the post-compaction size (onContext).
func (l *Lifecycle) markCompacted(ctx context.Context, id string) {
	l.markCold(ctx, id, "compaction")
	l.mu.Lock()
	if l.measureNext == nil {
		l.measureNext = map[string]bool{}
	}
	l.measureNext[id] = true
	l.mu.Unlock()
}

// markCold is src/cache-cold.ts markCold: the agent's next model turn follows a wake or a compaction. A compaction mark
// is kept when a wake mark follows it, and the same cause isn't marked twice, so stam's compaction and the hook for it
// count once.
func (l *Lifecycle) markCold(ctx context.Context, id, cause string) {
	if m, ok := l.pendingColdMark(ctx, id); ok && (m.Cause == cause || cause == "wake") {
		return
	}
	// TS marks the agent it holds; one that can't be read (gone) gets no mark.
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return
	}
	l.event(ctx, id, "cache:mark", coldMark{Cause: cause, Seen: l.transcripts.LastID(deref(a.TranscriptPath))})
}

// pendingColdMark is the agent's latest cache:mark with no cache:cold or cache:warm after it (src/cache-cold.ts
// pendingMark); it lives in the events, so a daemon restart keeps it.
func (l *Lifecycle) pendingColdMark(ctx context.Context, id string) (coldMark, bool) {
	var m coldMark
	e, err := l.db.LatestEvent(ctx, id, []string{"cache:mark", "cache:cold", "cache:warm"})
	if err != nil || e == nil || e.Type != "cache:mark" {
		return m, false
	}
	if e.Data != nil && e.Decode(&m) != nil {
		return m, false
	}
	return m, true
}

// onCacheTurn is src/cache-cold.ts onCacheTurn: on a status line for the agent's session (its transcript file), the
// first model turn after the pending mark is measured, even when several were written since the last report.
func (l *Lifecycle) onCacheTurn(ctx context.Context, id, session string) bool {
	m, ok := l.pendingColdMark(ctx, id)
	if !ok {
		return false
	}
	t, ok := l.transcripts.TurnAfter(session, m.Seen)
	if !ok {
		return false
	}
	return l.onCacheUsage(ctx, id, t.CacheWrite, t.Total, t.ID)
}

// onCacheUsage is src/cache-cold.ts onCacheUsage: the first new turn after a mark either wrote most of its context
// (cache:cold) or didn't (cache:warm). true when it was cold.
func (l *Lifecycle) onCacheUsage(ctx context.Context, id string, cacheWrite, total float64, turn string) bool {
	if !(total > 0) || turn == "" {
		return false
	}
	m, ok := l.pendingColdMark(ctx, id)
	if !ok || m.Seen == turn {
		return false
	}
	cold := cacheWrite > coldShare*total
	typ := "cache:warm"
	if cold {
		typ = "cache:cold"
	}
	l.event(ctx, id, typ, coldEvent{Tokens: cacheWrite, Context: total, Cause: m.Cause})
	return cold
}

// onCacheTTL is src/cache-cold.ts onCacheTtl: the agent's detected window, recorded as cache:ttl when it differs from
// the last one.
func (l *Lifecycle) onCacheTTL(ctx context.Context, id, ttl string) {
	if ttl == "" {
		return
	}
	if e, err := l.db.LatestEvent(ctx, id, []string{"cache:ttl"}); err == nil && e != nil {
		var last ttlEvent
		if e.Decode(&last) == nil && last.TTL == ttl {
			return
		}
	}
	l.event(ctx, id, "cache:ttl", ttlEvent{TTL: ttl})
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
