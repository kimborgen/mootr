package lifecycle

import (
	"context"
	"errors"
	"regexp"
	"sort"

	"stam/internal/db"
)

// The waits stam derives from its own data, rebuilt at daemon start (src/org.ts rebuildWaits, settleRequestAsks), so a
// restart neither loses nor leaves stale ones. StartOrg runs it before the org observer is installed, so it tells
// nobody; recoverTreeIdle does that after.

var delegateData = regexp.MustCompile(`^p[0-9a-f]{6}$`)

func (l *Lifecycle) rebuildWaits(ctx context.Context) error {
	// children: one per agent whose subtree is not quiet. A wait turns an idle agent waiting, which is busy to the
	// agents above it, so the pass repeats until no wait changes; the bound stops a cycle that keeps itself waiting.
	for pass := 0; pass < 50; pass++ {
		parents, err := l.db.ParentMap(ctx)
		if err != nil {
			return err
		}
		counts, err := l.busyCounts(ctx, parents)
		if err != nil {
			return err
		}
		due := map[string]bool{}
		for id := range counts {
			due[id] = true
		}
		byAgent, err := l.db.WaitsByAgent(ctx)
		if err != nil {
			return err
		}
		for id, ws := range byAgent {
			for _, w := range ws {
				if isChildrenWait(w) {
					due[id] = true
				}
			}
		}
		ids := make([]string, 0, len(due))
		for id := range due {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		changed := false
		for _, id := range ids {
			if _, err := l.db.GetAgent(ctx, id); errors.Is(err, db.ErrNotFound) {
				continue
			} else if err != nil {
				return err
			}
			c, err := l.syncChildrenWait(ctx, id, counts[id])
			if err != nil {
				return err
			}
			changed = changed || c != ""
		}
		if !changed {
			break
		}
	}
	if err := l.rebuildRequestWaits(ctx); err != nil {
		return err
	}
	return l.settleRequestAsks(ctx)
}

// rebuildRequestWaits: one stam 'human' wait per request pending with the human, and one stam 'agent' wait (keyed by
// the request in its data) per delegate ask; a stam wait whose request is gone or answered is cleared. Declared waits
// are left alone.
func (l *Lifecycle) rebuildRequestWaits(ctx context.Context) error {
	pending, err := l.db.PendingRequests(ctx)
	if err != nil {
		return err
	}
	ids, delegates := map[string]bool{}, map[string]bool{}
	for _, r := range pending {
		ids[r.ID] = true
		if r.Audience == "delegate" {
			delegates[r.ID] = true
		}
	}
	byAgent, err := l.db.WaitsByAgent(ctx)
	if err != nil {
		return err
	}
	agentIDs := make([]string, 0, len(byAgent))
	for id := range byAgent {
		agentIDs = append(agentIDs, id)
	}
	sort.Strings(agentIDs)
	for _, id := range agentIDs {
		if _, err := l.db.GetAgent(ctx, id); errors.Is(err, db.ErrNotFound) {
			continue
		} else if err != nil {
			return err
		}
		for _, w := range byAgent[id] {
			if w.Source != "stam" {
				continue
			}
			stale := w.Kind == "human" && !ids[deref(w.Target)] ||
				w.Kind == "agent" && delegateData.MatchString(deref(w.Data)) && !delegates[deref(w.Data)]
			if stale {
				if _, err := l.db.ClearWait(ctx, w.ID); err != nil {
					return err
				}
			}
		}
	}
	for _, r := range pending {
		a, err := l.db.GetAgent(ctx, r.AgentID)
		if errors.Is(err, db.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		ws, err := l.db.ListWaits(ctx, a.ID)
		if err != nil {
			return err
		}
		has := false
		for _, w := range ws {
			if r.Audience == "delegate" && deref(w.Data) == r.ID || r.Audience != "delegate" && w.Source == "stam" && w.Kind == "human" && deref(w.Target) == r.ID {
				has = true
			}
		}
		if has {
			continue
		}
		id := r.ID
		w := db.NewWait{AgentID: a.ID, Kind: "human", Source: "stam", Target: &id, Detail: ptr("your approval")}
		if r.Audience == "delegate" {
			w = db.NewWait{AgentID: a.ID, Kind: "agent", Source: "stam", Target: a.ParentID, Detail: ptr("your parent or the chief of staff"), Data: &id}
			if w.Target == nil {
				if cos := l.settings.Get().ChiefOfStaff; cos != "" {
					w.Target = &cos
				}
			}
		}
		if _, err := l.db.AddWait(ctx, w); err != nil {
			return err
		}
	}
	return nil
}

func ptr(s string) *string { return &s }

// settleRequestAsks is src/org.ts settleRequestAsks: an agent's own asks about a request settle with it. A declared
// wait on the human about a settled request clears, one about a pending request it isn't tied to yet is tied to it;
// and the decision mails about a request settled after them stop waiting on the human. A second run changes nothing.
func (l *Lifecycle) settleRequestAsks(ctx context.Context) error {
	byAgent, err := l.db.WaitsByAgent(ctx)
	if err != nil {
		return err
	}
	agentIDs := make([]string, 0, len(byAgent))
	for id := range byAgent {
		agentIDs = append(agentIDs, id)
	}
	sort.Strings(agentIDs)
	for _, id := range agentIDs {
		if _, err := l.db.GetAgent(ctx, id); errors.Is(err, db.ErrNotFound) {
			continue
		} else if err != nil {
			return err
		}
		for _, w := range byAgent[id] {
			if w.Source != "declared" || w.Kind != "human" {
				continue
			}
			thread := ""
			if data, ok := waitData(w.Data); ok {
				if th, isStr := get(data, "thread").(string); isStr {
					thread = th
				}
			}
			var r *db.RequestState
			switch {
			case w.Target != nil && *w.Target != "":
				got, found, err := l.db.GetRequest(ctx, *w.Target)
				if err != nil {
					return err
				}
				if found {
					r = &got
				}
			default:
				if r, err = l.requestWaitedOn(ctx, id, deref(w.Detail), thread, w.Since); err != nil {
					return err
				}
				// A note naming only a settled request, with no thread, is refused now; one from before is stale.
				if r == nil && thread == "" {
					if r, err = l.settledNamed(ctx, id, deref(w.Detail)); err != nil {
						return err
					}
				}
			}
			if r == nil {
				continue
			}
			if r.Status != "pending" {
				if _, err := l.db.ClearWait(ctx, w.ID); err != nil {
					return err
				}
			} else if w.Target == nil || *w.Target == "" {
				if err := l.db.SetWaitTarget(ctx, w.ID, r.ID); err != nil {
					return err
				}
			}
		}
	}
	oldest, err := l.db.OldestDecisionMails(ctx)
	if err != nil {
		return err
	}
	for _, o := range oldest {
		agent, since := o[0], o[1]
		reqs, err := l.db.AgentRequests(ctx, agent)
		if err != nil {
			return err
		}
		for _, r := range reqs {
			if r.Status != "pending" && r.DecidedAt != nil && *r.DecidedAt != "" && *r.DecidedAt >= since {
				if err := l.db.ClearRequestDecisionMails(ctx, agent, r.ID, *r.DecidedAt); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
