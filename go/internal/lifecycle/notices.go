package lifecycle

import (
	"context"
	"errors"
	"log/slog"

	"stam/internal/db"
)

// notice is one stam notice queued for an agent (src/mail.ts queueNotice): an idle-only one is a new task, which waits
// for a fresh turn instead of riding on another tool's result. seq tells notices apart, so a push removes only the ones
// it delivered.
type notice struct {
	Text     string
	IdleOnly bool
	// Ring marks a ring's turn (src/ring.ts): the push is admitted as kind `ring`.
	Ring bool
	// Row is the answer_notices row of an answer's notice (S-3923), 0 for any other; it goes when the notice is handed over.
	Row int64
	seq uint64
}

type noticeEvent struct {
	Text string `json:"text"`
}

// QueueNotice is src/mail.ts queueNotice: the notice is kept for the agent, recorded as notice:queued (its text cut to
// 120 UTF-16 units), and the agent's push is scheduled. It reaches a working agent after its next tool call
// (InTurnNotice), an idle one as a prompt (pushIfIdle). The queue is in memory, as in TS: a restart loses it, while
// unread mail stays unpushed in the database and is pushed again.
func (l *Lifecycle) QueueNotice(ctx context.Context, id, text string, idleOnly bool) {
	l.queue(ctx, id, text, idleOnly, false, 0)
}

// QueueRingNotice is QueueNotice for a ring's turn or moderation (idleOnly, ring: true).
func (l *Lifecycle) QueueRingNotice(ctx context.Context, id, text string) {
	l.queue(ctx, id, text, true, true, 0)
}

// QueueAnswerNotice is QueueNotice for an answer's notice (S-3923) whose row isn't written yet: the row is written
// first, then the notice is queued. A failed write still queues the notice in memory, as before, and is logged.
func (l *Lifecycle) QueueAnswerNotice(ctx context.Context, id, text string) {
	row, err := l.db.AddAnswerNotice(ctx, id, text)
	if err != nil {
		slog.Error("answer notice not stored", "agent", id, "err", err)
	}
	l.queue(ctx, id, text, false, false, row)
}

// QueueAnswerNoticeStored is QueueAnswerNotice whose row keeps `stored` instead of the text (S-3923): a draft's text is
// shown to the agent, and never stored.
func (l *Lifecycle) QueueAnswerNoticeStored(ctx context.Context, id, text, stored string) {
	row, err := l.db.AddAnswerNotice(ctx, id, stored)
	if err != nil {
		slog.Error("answer notice not stored", "agent", id, "err", err)
	}
	l.queue(ctx, id, text, false, false, row)
}

// QueueAnswerRow queues an answer's notice whose answer_notices row (row, 0 for none) was written with the answer, in
// the same transaction (S-3923).
func (l *Lifecycle) QueueAnswerRow(ctx context.Context, id, text string, row int64) {
	l.queue(ctx, id, text, false, false, row)
}

// AckNotice is the hook client's acknowledgement (S-3923): it printed the response that carried row, so the agent has the
// notice, and the row goes. A row the agent doesn't hold unconfirmed is left alone.
func (l *Lifecycle) AckNotice(ctx context.Context, id string, row int64) {
	l.mu.Lock()
	var kept []int64
	found := false
	for _, r := range l.unconfirmed[id] {
		if r == row {
			found = true
		} else {
			kept = append(kept, r)
		}
	}
	if found {
		if len(kept) > 0 {
			l.unconfirmed[id] = kept
		} else {
			delete(l.unconfirmed, id)
		}
	}
	l.mu.Unlock()
	if !found {
		return
	}
	if err := l.db.DeleteAnswerNotice(ctx, row); err != nil {
		slog.Error("answer notice not cleared", "row", row, "err", err)
	}
}

// ForgetAgentNotices drops an archived or forgotten agent's queued notices and its answer rows (S-3923).
func (l *Lifecycle) ForgetAgentNotices(ctx context.Context, id string) {
	l.mu.Lock()
	delete(l.notices, id)
	delete(l.unconfirmed, id)
	l.mu.Unlock()
	if err := l.db.DeleteAnswerNoticesOf(ctx, id); err != nil {
		slog.Error("answer notices not dropped", "agent", id, "err", err)
	}
}

func (l *Lifecycle) queue(ctx context.Context, id, text string, idleOnly, ring bool, row int64) {
	l.mu.Lock()
	if l.notices == nil {
		l.notices = map[string][]notice{}
	}
	l.noticeSeq++
	l.notices[id] = append(l.notices[id], notice{Text: text, IdleOnly: idleOnly, Ring: ring, Row: row, seq: l.noticeSeq})
	l.mu.Unlock()
	l.event(ctx, id, "notice:queued", noticeEvent{Text: sliceUTF16(text, 120)})
	l.SchedulePush(id)
}

// RestoreAnswerNotices puts back the answer notices a restart found unread (S-3923), oldest first, each agent's queue as
// it was. A row for an agent that is gone (archived, or forgotten) is dropped here; a resting agent keeps its rows.
func (l *Lifecycle) RestoreAnswerNotices(ctx context.Context) error {
	rows, err := l.db.AnswerNotices(ctx)
	if err != nil {
		return err
	}
	for _, r := range rows {
		a, err := l.db.GetAgent(ctx, r.AgentID)
		if errors.Is(err, db.ErrNotFound) || (err == nil && a.Lifecycle == "archived") {
			if err := l.db.DeleteAnswerNotice(ctx, r.ID); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		l.mu.Lock()
		if l.notices == nil {
			l.notices = map[string][]notice{}
		}
		l.noticeSeq++
		l.notices[r.AgentID] = append(l.notices[r.AgentID], notice{Text: r.Text, Row: r.ID, seq: l.noticeSeq})
		l.mu.Unlock()
		l.SchedulePush(r.AgentID)
	}
	return nil
}

// forgetRows drops the answer_notices rows of notices a push delivered: the push returned ok (S-3923).
func (l *Lifecycle) forgetRows(ctx context.Context, handed []notice) {
	for _, n := range handed {
		if n.Row == 0 {
			continue
		}
		if err := l.db.DeleteAnswerNotice(ctx, n.Row); err != nil {
			slog.Error("answer notice not cleared", "row", n.Row, "err", err)
		}
	}
}

// heldRows records the rows an in-turn take handed over, kept until the hook's client acknowledges them (AckNotice). Called
// under mu.
func (l *Lifecycle) heldRows(id string, taken []notice) {
	for _, n := range taken {
		if n.Row == 0 {
			continue
		}
		if l.unconfirmed == nil {
			l.unconfirmed = map[string][]int64{}
		}
		l.unconfirmed[id] = append(l.unconfirmed[id], n.Row)
	}
}

// Notices is the notices queued for the agent, oldest first.
func (l *Lifecycle) Notices(id string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, n := range l.notices[id] {
		out = append(out, n.Text)
	}
	return out
}

// chiefOfStaff is src/org.ts chiefOfStaff()?.id: the agent settings.chiefOfStaff names, while it runs; "" for none.
func (l *Lifecycle) chiefOfStaff(ctx context.Context) string {
	name := l.settings.Get().ChiefOfStaff
	if name == "" {
		return ""
	}
	a, err := l.db.GetAgent(ctx, name)
	if err != nil || (a.Lifecycle != "active" && a.Lifecycle != "paused") {
		return ""
	}
	return a.ID
}

// parentOrChief is `db.parentsOf(a)[0] ?? chiefOfStaff()?.id`: who hears about an agent no caller waits on.
func (l *Lifecycle) parentOrChief(ctx context.Context, a db.Agent) string {
	if parents, err := l.db.ParentsOf(ctx, a); err == nil && len(parents) > 0 {
		return parents[0]
	}
	return l.chiefOfStaff(ctx)
}

// tellParent queues text for the agent's parent, else the chief of staff, when there is one.
func (l *Lifecycle) tellParent(ctx context.Context, a db.Agent, text string) {
	if p := l.parentOrChief(ctx, a); p != "" {
		l.QueueNotice(ctx, p, text, false)
	}
}
