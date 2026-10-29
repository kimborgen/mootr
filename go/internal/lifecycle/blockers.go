package lifecycle

import (
	"context"
	"fmt"
	"time"

	"stam/internal/db"
)

// Cost blockers (src/blockers.ts, S-2848 B4a): why stam keeps an agent paused. Each agent carries independent
// blockers, each with its own clear condition, in the blockers table, so they survive a restart. The first pauses the
// agent with stam as the owner; when the last clears, stam resumes it, unless the human or an agent also paused it, a
// pause stam never lifts. Every change runs in serial, with the agent's other pause transitions, and the agent's manager
// hears of a new blocker and of every clear (blockerChanged, costnotices.go).

// BlockerKinds is src/blockers.ts BLOCKER_KINDS.
var BlockerKinds = []string{"window", "paid-forbidden", "budget", "credits-out", "billing-unknown", "error", "taken-over", "manual"}

// NewBlocker is addBlocker's b: Account is "" when none, Clear the clear condition's JSON text (nil for none), and
// Clears the windows the change cleared.
type NewBlocker struct {
	Kind, Account, Reason string
	Clear                 *string
	Clears                *db.WindowClears
}

type blockerAddEvent struct {
	Kind    string `json:"kind"`
	Account string `json:"account"`
	Reason  string `json:"reason"`
}

type blockerClearEvent struct {
	Kind    string `json:"kind"`
	Account string `json:"account"`
	Cleared string `json:"cleared"`
}

// AddBlocker is src/blockers.ts addBlocker: it adds a blocker, or refreshes its reason and clear condition while
// keeping its since. An active agent is paused with stam as the owner; any other state only records it.
func (l *Lifecycle) AddBlocker(ctx context.Context, id string, b NewBlocker) (db.Blocker, error) {
	if !contains(BlockerKinds, b.Kind) {
		return db.Blocker{}, fmt.Errorf("unknown blocker kind %s", b.Kind)
	}
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return db.Blocker{}, fmt.Errorf("no agent %s", id)
	}
	var out db.Blocker
	err = l.serial(ctx, a.ID, func(ctx context.Context) error {
		row, existed, err := l.db.PutBlocker(ctx, db.Blocker{AgentID: a.ID, Kind: b.Kind, Account: b.Account, Reason: b.Reason, Clear: b.Clear}, b.Clears)
		if err != nil {
			return err
		}
		out = row
		l.event(ctx, a.ID, "blocker:add", blockerAddEvent{Kind: b.Kind, Account: b.Account, Reason: b.Reason})
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		if now.Lifecycle == "active" {
			if _, err := l.pauseNow(ctx, a.ID, ""); err != nil {
				return err
			}
		}
		// A refresh keeps its since; only a new blocker notifies the manager.
		if !existed {
			l.blockerChanged(ctx, a.ID, b.Kind, b.Account, "set", b.Reason, row.Since, time.Now())
		}
		return nil
	})
	return out, err
}

// ClearBlocker is src/blockers.ts clearBlocker: it removes a blocker, and when it was the last and no one else paused
// the agent, resumes it with cost-resumed.md naming what cleared it; cleared says how, such as "a fresh reading". It
// returns whether the agent was resumed. The mail and notices the blockers held back go in once none is left, even to
// an agent that stays paused for the human or a parent.
func (l *Lifecycle) ClearBlocker(ctx context.Context, id, kind, account, cleared string, clears *db.WindowClears) (bool, error) {
	return l.clearBlocker(ctx, id, kind, account, cleared, clears, nil)
}

// clearBlocker is ClearBlocker with a last check: still, when not nil, runs inside the agent's serial right before the
// drop, and false leaves the blocker in place (a probe success a newer failure overtook).
func (l *Lifecycle) clearBlocker(ctx context.Context, id, kind, account, cleared string, clears *db.WindowClears, still func(ctx context.Context) bool) (bool, error) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return false, fmt.Errorf("no agent %s", id)
	}
	resumed := false
	err = l.serial(ctx, a.ID, func(ctx context.Context) error {
		if still != nil && !still(ctx) {
			return nil
		}
		gone, left, err := l.db.DropBlocker(ctx, a.ID, kind, account, clears)
		if err != nil || gone == nil {
			return err
		}
		l.event(ctx, a.ID, "blocker:clear", blockerClearEvent{Kind: kind, Account: account, Cleared: cleared})
		// The blocked agent's manager hears the blocker cleared, whoever cleared it.
		told := cleared
		if told == "" {
			told = gone.Reason
		}
		l.blockerChanged(ctx, a.ID, kind, account, "clear", told, iso(time.Now()), time.Now())
		// Scheduled on the way out, after any resume below, so its prompt goes in before the held mail.
		if left == 0 {
			defer l.SchedulePush(a.ID)
		}
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		if now.Lifecycle != "paused" || l.isHeld(ctx, now) {
			return nil
		}
		blocker := kind
		if account != "" {
			blocker = kind + " on " + account
		}
		why := cleared
		if why == "" {
			why = "its condition cleared"
		}
		text, err := l.render("cost-resumed", map[string]string{"blocker": blocker, "reason": gone.Reason, "cleared": why})
		if err != nil {
			return err
		}
		if l.resuming != nil {
			l.resuming(a.ID)
		}
		if _, err := l.resumeNow(ctx, a.ID, text); err != nil {
			return err
		}
		resumed = true
		return nil
	})
	return resumed, err
}
