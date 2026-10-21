package lifecycle

import (
	"context"

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
	seq  uint64
}

type noticeEvent struct {
	Text string `json:"text"`
}

// QueueNotice is src/mail.ts queueNotice: the notice is kept for the agent, recorded as notice:queued (its text cut to
// 120 UTF-16 units), and the agent's push is scheduled. It reaches a working agent after its next tool call
// (InTurnNotice), an idle one as a prompt (pushIfIdle). The queue is in memory, as in TS: a restart loses it, while
// unread mail stays unpushed in the database and is pushed again.
func (l *Lifecycle) QueueNotice(ctx context.Context, id, text string, idleOnly bool) {
	l.queue(ctx, id, text, idleOnly, false)
}

// QueueRingNotice is QueueNotice for a ring's turn or moderation (idleOnly, ring: true).
func (l *Lifecycle) QueueRingNotice(ctx context.Context, id, text string) {
	l.queue(ctx, id, text, true, true)
}

func (l *Lifecycle) queue(ctx context.Context, id, text string, idleOnly, ring bool) {
	l.mu.Lock()
	if l.notices == nil {
		l.notices = map[string][]notice{}
	}
	l.noticeSeq++
	l.notices[id] = append(l.notices[id], notice{Text: text, IdleOnly: idleOnly, Ring: ring, seq: l.noticeSeq})
	l.mu.Unlock()
	l.event(ctx, id, "notice:queued", noticeEvent{Text: sliceUTF16(text, 120)})
	l.SchedulePush(id)
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
