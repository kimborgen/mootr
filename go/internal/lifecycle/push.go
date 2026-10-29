package lifecycle

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"stam/internal/db"
)

// The push of mail, notices and stam's own prompts (src/mail.ts schedulePush, pushIfIdle, inTurnNotice and
// holdingPushes, src/lifecycle.ts prompt, S-2848 B1). An idle agent makes no tool calls, so its unread mail it hasn't
// been prompted about and its queued notices go to it as a prompt over its shim's stream; a working agent gets them in
// its next PostToolUse hook's answer instead. A prompt that reaches no stream leaves the mail unpushed and the notices
// queued, for the next push: the shim connecting, the turn ending, new mail or a new notice.
//
// Not ported: the rest clock's wake, passive and ring notices, and the push into Codex and OpenCode agents.

// pushDebounce is src/mail.ts PUSH_DEBOUNCE_MS: mail and notices that arrive close together go in one prompt.
const pushDebounce = 2 * time.Second

// noticeList is src/mail.ts NOTICE_LIST: how many unread mails a prompt or notice lists.
const noticeList = 10

type pushedEvent struct {
	Mail    bool `json:"mail"`
	Notices int  `json:"notices"`
}

type promptEvent struct {
	Kind string `json:"kind"`
}

// promptNullEvent is prompt:sent's {kind: null}.
type promptNullEvent struct {
	Kind *string `json:"kind"`
}

// SchedulePush is src/mail.ts schedulePush: the agent's push runs pushDebounce after the last call.
func (l *Lifecycle) SchedulePush(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.pushTimers == nil {
		l.pushTimers = map[string]*time.Timer{}
	}
	if t := l.pushTimers[id]; t != nil {
		t.Stop()
	}
	var t *time.Timer
	t = time.AfterFunc(l.debounce, func() {
		l.mu.Lock()
		if l.pushTimers[id] != t {
			l.mu.Unlock()
			return
		}
		delete(l.pushTimers, id)
		// Counted under mu, where Wait marks its start, so a push either runs before Wait returns or not at all.
		if l.waited || l.ctx.Err() != nil {
			l.mu.Unlock()
			return
		}
		l.bg.Add(1)
		if l.pushRuns == nil {
			l.pushRuns = map[string]int{}
		}
		l.pushRuns[id]++
		l.mu.Unlock()
		defer l.bg.Done()
		defer func() {
			l.mu.Lock()
			if l.pushRuns[id]--; l.pushRuns[id] <= 0 {
				delete(l.pushRuns, id)
			}
			l.mu.Unlock()
		}()
		l.pushIfIdle(l.ctx, id)
	})
	l.pushTimers[id] = t
}

// HoldingPushes is src/mail.ts holdingPushes: while fn types into the agent's input, no prompt is pushed to it, so a
// pushed turn can't start in the middle of the typing. The hold is taken under the agent's push lock, so a push already
// past its hold check finishes before fn starts (TS's push runs from the check to the prompt with no await); a push
// that comes while fn runs sees the hold and waits for the next one.
func (l *Lifecycle) HoldingPushes(id string, fn func() error) error {
	lock := l.pushLock(id)
	lock.Lock()
	l.mu.Lock()
	if l.pushHolds == nil {
		l.pushHolds = map[string]int{}
	}
	l.pushHolds[id]++
	l.mu.Unlock()
	lock.Unlock()
	defer func() {
		l.mu.Lock()
		if l.pushHolds[id]--; l.pushHolds[id] <= 0 {
			delete(l.pushHolds, id)
		}
		l.mu.Unlock()
	}()
	return fn()
}

func (l *Lifecycle) pushLock(id string) *sync.Mutex {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.pushLocks == nil {
		l.pushLocks = map[string]*sync.Mutex{}
	}
	m := l.pushLocks[id]
	if m == nil {
		m = &sync.Mutex{}
		l.pushLocks[id] = m
	}
	return m
}

// pushIfIdle is src/mail.ts pushIfIdle: an active or paused agent that is idle or waiting, with unpushed mail or queued
// notices, gets them as one prompt, if the admission gate lets a turn start. Only once the prompt reached the agent's
// stream are the notices it held dropped and the mail it named marked pushed; anything that arrived meanwhile waits for
// the next push.
func (l *Lifecycle) pushIfIdle(ctx context.Context, id string) {
	// The hold is checked under the push lock, which HoldingPushes takes to set it: no hold can start between the check
	// and the push.
	lock := l.pushLock(id)
	lock.Lock()
	defer lock.Unlock()
	l.mu.Lock()
	held := l.pushHolds[id] > 0
	l.mu.Unlock()
	if held {
		l.SchedulePush(id)
		return
	}
	a, err := l.db.GetAgent(ctx, id)
	if err != nil || !running(a) || (a.Activity != "idle" && a.Activity != "waiting") {
		return
	}
	// The mail it marks is the mail the prompt counts, read together: a mail that arrives meanwhile is neither named
	// twice nor marked unnamed.
	mail, count, list, err := l.db.PushMail(ctx, id, noticeList)
	if err != nil {
		return
	}
	l.mu.Lock()
	pending := append([]notice(nil), l.notices[id]...)
	l.mu.Unlock()
	if len(mail) == 0 && len(pending) == 0 {
		return
	}
	kind := "mail"
	for _, n := range pending {
		if n.Ring {
			kind = "ring"
		}
	}
	if ok, _ := l.admit(ctx, id, kind); !ok {
		return
	}
	var parts []string
	for _, n := range pending {
		parts = append(parts, n.Text)
	}
	if len(mail) > 0 {
		text, err := l.renderMailList(ctx, "mail-prompt", count, list)
		if err != nil {
			return
		}
		parts = append(parts, text)
	}
	if l.pushing != nil {
		l.pushing(id)
	}
	if !l.pushPrompt(ctx, a, strings.Join(parts, "\n\n")) {
		return
	}
	l.dropNotices(id, pending)
	l.forgetRows(ctx, pending)
	if err := l.db.MarkPushed(ctx, id, mail); err != nil {
		l.event(ctx, id, "push-error", "Error: "+err.Error())
	}
	l.event(ctx, id, "pushed", pushedEvent{Mail: len(mail) > 0, Notices: len(pending)})
}

// dropNotices removes the delivered notices from the agent's queue, keeping any queued since.
func (l *Lifecycle) dropNotices(id string, delivered []notice) {
	gone := map[uint64]bool{}
	for _, n := range delivered {
		gone[n.seq] = true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	var kept []notice
	for _, n := range l.notices[id] {
		if !gone[n.seq] {
			kept = append(kept, n)
		}
	}
	if len(kept) > 0 {
		l.notices[id] = kept
	} else {
		delete(l.notices, id)
	}
}

// pushPrompt is the adapter's pushPrompt: a Claude Code agent's prompt goes over its own shim's stream (src/adapters/
// claude.ts), never into a pane, and an OpenCode agent's into its session through the server (pushOpenCode). Codex
// isn't ported, so nothing reaches it.
func (l *Lifecycle) pushPrompt(ctx context.Context, a db.Agent, text string) bool {
	if a.Harness == "opencode" {
		return l.pushOpenCode(ctx, a, text)
	}
	if a.Harness != "claude" {
		return false
	}
	return l.streams.Push(ctx, a.ID, text, map[string]string{"kind": "mail"})
}

// prompt is src/lifecycle.ts prompt: stam's own prompt into the agent, through the admission gate under kind; an empty
// kind (TS's null, as for the pause notice) skips the gate. A prompt on its way is recorded as prompt:sent.
func (l *Lifecycle) prompt(ctx context.Context, a db.Agent, text, kind string) bool {
	if kind != "" {
		if ok, _ := l.admit(ctx, a.ID, kind); !ok {
			return false
		}
	}
	if !l.pushPrompt(ctx, a, text) {
		return false
	}
	if kind == "" {
		l.event(ctx, a.ID, "prompt:sent", promptNullEvent{})
	} else {
		l.event(ctx, a.ID, "prompt:sent", promptEvent{Kind: kind})
	}
	return true
}

// InTurnNotice is src/mail.ts inTurnNotice: the agent's queued notices, all but the idle-only ones, then the note of
// its unread mail when it has loud mail (ITSA comments and updates wait for the idle push), for a hook that runs after
// a tool call; "" when there is nothing new. The notices leave the queue. Mail that can't be read now is noted at a
// later tool call.
func (l *Lifecycle) InTurnNotice(ctx context.Context, id string) string {
	text, _ := l.InTurnTake(ctx, id)
	return text
}

// InTurnTake is InTurnNotice for one hook (S-3923): its text, and the answer rows it carried. The rows stay until the
// hook's client acknowledges them (AckNotice), since the response may not reach the agent.
func (l *Lifecycle) InTurnTake(ctx context.Context, id string) (string, []int64) {
	return l.inTurnTakeIf(ctx, id, nil)
}

// inTurnTakeIf is InTurnTake that takes nothing unless held (nil: always) says so, checked under the lifecycle's lock, in
// the one step with the take: a notice queued since is not in it, and one taken is the agent's at that step. The check
// reads the owner's state (owner.mu follows Lifecycle.mu in the lock order).
func (l *Lifecycle) inTurnTakeIf(ctx context.Context, id string, held func() bool) (string, []int64) {
	l.mu.Lock()
	if held != nil && !held() {
		l.mu.Unlock()
		return "", nil
	}
	var parts []string
	var kept, taken []notice
	var rows []int64
	for _, n := range l.notices[id] {
		if n.IdleOnly {
			kept = append(kept, n)
		} else {
			parts = append(parts, n.Text)
			taken = append(taken, n)
			if n.Row != 0 {
				rows = append(rows, n.Row)
			}
		}
	}
	if len(kept) > 0 {
		l.notices[id] = kept
	} else {
		delete(l.notices, id)
	}
	l.heldRows(id, taken)
	l.mu.Unlock()
	if count, _, err := l.db.MailNotice(ctx, id, true, 0); err == nil && count > 0 {
		if list, err := l.mailList(ctx, id, "mail-notice", true); err == nil {
			parts = append(parts, list)
		}
	}
	return strings.Join(parts, "\n\n"), rows
}

// mailList renders the template with src/mail.ts noticeList's count and list of the agent's unread mail.
func (l *Lifecycle) mailList(ctx context.Context, id, template string, loudOnly bool) (string, error) {
	count, mails, err := l.db.MailNotice(ctx, id, loudOnly, noticeList)
	if err != nil {
		return "", err
	}
	return l.renderMailList(ctx, template, count, mails)
}

// renderMailList renders the template with a count of unread mail and its list.
func (l *Lifecycle) renderMailList(ctx context.Context, template string, count int, mails []db.NoticeMail) (string, error) {
	lines := make([]string, len(mails))
	for i, m := range mails {
		lines[i] = fmt.Sprintf("- %s from %s: %s", m.ID, l.senderName(ctx, m), m.Subject)
	}
	return l.render(template, map[string]string{"count": fmt.Sprint(count), "list": strings.Join(lines, "\n")})
}

// senderName is src/mail.ts `m.from_name ?? senderName(m.from_id)`.
func (l *Lifecycle) senderName(ctx context.Context, m db.NoticeMail) string {
	if m.FromName != nil {
		return *m.FromName
	}
	if m.FromID == "human" {
		return "the human"
	}
	if a, err := l.db.GetAgent(ctx, m.FromID); err == nil {
		return a.Name
	}
	return m.FromID
}

// ServeStream is GET /api/agents/:id/stream's work (src/push.ts addStream): the agent's shim gets its push stream, and
// the agent's push is scheduled once the stream can take it. It returns when the shim goes away or the daemon stops;
// false when this lifecycle has no streams.
func (l *Lifecycle) ServeStream(w http.ResponseWriter, r *http.Request, id string) bool {
	if l.streams == nil {
		return false
	}
	l.streams.Serve(l.ctx, w, r, id, func() { l.SchedulePush(id) })
	return true
}
