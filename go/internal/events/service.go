package events

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"

	"zombiezen.com/go/sqlite"
)

// Commit is a delivery's own write, which a Host runs in the transaction that stores the mail, with the mail's id: the
// delivery's removal from its queue commits with the mail or not at all. A Host that doesn't run it (the mail went
// elsewhere) tells the service so, which removes the lines itself.
type Commit func(conn *sqlite.Conn, mailID string) error

// Host is what the service asks of the daemon around it: the ways a delivery reaches its subscriber.
type Host interface {
	// QueueNoticeRow queues a notice for a working agent (it reaches it after its next tool call). row is the answer
	// notice that holds its text until the agent has it (0 for none); the service stored it in the delivery's transaction.
	QueueNoticeRow(ctx context.Context, agentID, text string, row int64)
	// MailAgent is stam's own mail from the watch sender to an agent that is not working; commit runs in its transaction.
	MailAgent(ctx context.Context, agentID, subject, body string, commit Commit) error
	// MailHuman mails the human from the watch sender; replyTo "" starts a thread, else the mail replies into it. It
	// returns the mail's id; commit runs in its transaction.
	MailHuman(ctx context.Context, subject, body, replyTo string, commit Commit) (string, error)
	// PostItsa is stam's quiet post into an ITSA's thread, for its agents only. gone is true when the ITSA doesn't exist.
	// The post and the removal of its lines from the queue are two writes, so a crash between them posts again.
	PostItsa(ctx context.Context, itsaID, body string) (gone bool, err error)
	// Render is a template's text.
	Render(name string, vars map[string]string) (string, error)
	// WithFailureRetro appends the failure retro reminder to a notice while reminders are on.
	WithFailureRetro(text string) string
}

// Timers starts the fold and retry timers; a test injects its own, so none of them sleeps.
type Timers interface {
	// AfterFunc runs f once after d, on a goroutine of its own, until stop is called.
	AfterFunc(d time.Duration, f func()) (stop func() bool)
}

type realTimers struct{}

func (realTimers) AfterFunc(d time.Duration, f func()) func() bool {
	t := time.AfterFunc(d, f)
	return t.Stop
}

// Options is a service's parts.
type Options struct {
	DB   *db.DB
	Host Host
	// Fold is the fold window (STAM_EVENT_FOLD_MS, 20 s by default): the events of one subscription closer than this go
	// out together. 0 delivers each at once.
	Fold   func() time.Duration
	Timers Timers
	// Now is the clock; time.Now when nil.
	Now func() time.Time
	// RetryAfter is how long a delivery that failed waits before it is tried again; a minute by default.
	RetryAfter time.Duration
}

// DefaultFold is the fold window when STAM_EVENT_FOLD_MS is not set.
const DefaultFold = 20 * time.Second

// MaxAttempts is how many deliveries of one folded batch may fail in a row before the failure is logged as persistent.
// The batch is kept, whatever the count, and tried again after a longer wait each time, up to MaxBackoff.
const MaxAttempts = 5

// MaxBackoff is the longest wait between two tries of a batch that keeps failing.
const MaxBackoff = time.Hour

// Service stores external events and delivers them (src/watch.ts).
type Service struct {
	o Options

	// mu guards the timers, closed and forgot.
	mu     sync.Mutex
	timers map[string]func() bool
	closed bool
	// forgot counts, per agent, the times ForgetAgent ran: bumped synchronously at the archive, outside the state of any
	// delivery, and read by a delivery before each of its steps.
	forgot map[string]uint64

	// deliverMu runs one delivery or one forget at a time: a delivery's recheck of its agent and the send that follows
	// are one step to ForgetAgent, which waits for it.
	deliverMu sync.Mutex

	base   context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// hooks a test sets to land an interleaving at a named step; nil does nothing.
	hookBeforeSend func(agentID string)
	// hookAfterRecheck runs after the delivery's last read of the agent and before the transaction that makes it: an
	// archive that lands here is caught by the transaction's own read.
	hookAfterRecheck func(agentID string)
	hookAfterRead    func(subID string)
	// hookWaitNotice, when it returns false, skips queueing a cleared wait's notice: a crash between the clear and the
	// notice.
	hookWaitNotice func() bool
}

// New is a service that has not started: Start replays what a restart finds.
func New(o Options) *Service {
	if o.Timers == nil {
		o.Timers = realTimers{}
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Fold == nil {
		o.Fold = func() time.Duration { return DefaultFold }
	}
	if o.RetryAfter == 0 {
		o.RetryAfter = time.Minute
	}
	base, cancel := context.WithCancel(context.Background())
	return &Service{o: o, timers: map[string]func() bool{}, forgot: map[string]uint64{}, base: base, cancel: cancel}
}

// Start replays what the last run left: every folded delivery waiting gets its timer, and every cleared event wait's
// notice that never reached its agent is queued again. A notice that had reached an agent and wasn't acknowledged yet
// reaches it once more, as mail would; a delivery is never dropped by a restart.
func (s *Service) Start(ctx context.Context) error {
	ids, err := s.o.DB.QueueIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.arm(id)
	}
	notices, err := s.o.DB.WaitNotices(ctx)
	if err != nil {
		return err
	}
	for _, n := range notices {
		s.deliverWaitNotice(s.base, n)
	}
	return nil
}

// Close stops the timers and waits for the deliveries in flight; a delivery that is left stays in its queue.
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	for id, stop := range s.timers {
		stop()
		delete(s.timers, id)
	}
	s.mu.Unlock()
	// A delivery in flight is let finish, so a send isn't cut between its mail and its removal from the queue; one that
	// hangs is cancelled after closeWait.
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(closeWait):
	}
	s.cancel()
	<-done
}

// closeWait is how long Close waits for a delivery in flight before it cancels its context.
var closeWait = 10 * time.Second

// Input is an event as a source posts it.
type Input struct {
	Source, Type string
	Subjects     []string
	Actor, URL   *string
	Summary      *string
	// Payload is the parsed payload; Has says it was given.
	Payload    jsjson.Value
	HasPayload bool
	DedupeKey  string
}

// Result is src/watch.ts ingest's answer.
type Result struct {
	Stored  bool
	Event   db.ExtEvent
	Matched int
}

// ErrInvalid is an event that can't be stored: its message is the caller's to show.
type ErrInvalid struct{ Msg string }

func (e *ErrInvalid) Error() string { return e.Msg }

func eventOf(ev db.ExtEvent, payload jsjson.Value) Event {
	e := Event{Source: ev.Source, Type: ev.Type, Subjects: ev.Subjects, Summary: ev.Summary, Payload: payload}
	if ev.Actor != nil && *ev.Actor != "" {
		e.Actor, e.HasActor = *ev.Actor, true
	}
	if ev.URL != nil {
		e.URL = *ev.URL
	}
	return e
}

// Ingest is src/watch.ts ingest: the event is stored (a repeat of its dedupe_key is dropped), every unexpired
// subscription it fits queues its line for delivery after the fold window, and the event waits it fits clear, in one
// transaction. ctx must not end with a request that may hang up: the transaction is the event's whole effect.
func (s *Service) Ingest(ctx context.Context, in Input) (Result, error) {
	if in.Source == "" {
		return Result{}, &ErrInvalid{"an event needs a source"}
	}
	if in.Type == "" {
		return Result{}, &ErrInvalid{"an event needs a type"}
	}
	if in.DedupeKey == "" {
		return Result{}, &ErrInvalid{"an event needs a dedupe_key"}
	}
	summary := in.Source + " " + in.Type
	if in.Summary != nil {
		summary = jsjson.Trim(*in.Summary)
	}
	subjects := dedupe(in.Subjects)
	var payload *string
	if in.HasPayload {
		p := jsjson.Stringify(in.Payload, "")
		payload = &p
	}
	row := db.IngestIn{Source: in.Source, Type: in.Type, Subjects: subjects, Actor: in.Actor, URL: in.URL, Summary: summary, Payload: payload, DedupeKey: in.DedupeKey}
	hooks := db.IngestHooks{
		Now: func() (int64, string) {
			t := s.o.Now()
			return t.UnixMilli(), t.UTC().Format("2006-01-02T15:04:05.000Z")
		},
		Fit: func(sub db.Subscription, ev db.ExtEvent) db.Decision {
			f := ParseFilter(sub.Filter)
			e := eventOf(ev, in.Payload)
			if !Fits(sub.SubscriberKind, sub.SubscriberID, f, e) {
				return db.Decision{}
			}
			ends := f.Ends(ev.Type)
			return db.Decision{Match: true, Ends: ends, Line: db.QueueLine{Text: Line(e), Ended: ends, Failed: IsFailure(e)}}
		},
		Wait: func(w db.Wait, ev db.ExtEvent) (string, bool) {
			if !waitFilter(w).Matches(eventOf(ev, in.Payload)) {
				return "", false
			}
			what := "an external event"
			if w.Detail != nil {
				what = *w.Detail
			}
			text, err := s.o.Host.Render("wait-event", map[string]string{"what": what, "event": Line(eventOf(ev, in.Payload))})
			if err != nil {
				text = "[stam] Your wait for " + what + " cleared: an event you waited for arrived.\n\n" + Line(eventOf(ev, in.Payload))
			}
			return text, true
		},
	}
	out, err := s.o.DB.IngestEvent(ctx, row, hooks)
	if err != nil || !out.Stored {
		return Result{}, err
	}
	// The queue and the notices are stored: what follows only makes the deliveries, and a restart makes them again.
	for _, id := range out.Queued {
		s.arm(id)
	}
	for _, c := range out.Cleared {
		if s.hookWaitNotice != nil && !s.hookWaitNotice() {
			continue
		}
		s.deliverWaitNotice(ctx, c.Notice)
	}
	return Result{Stored: true, Event: out.Event, Matched: out.Matched}, nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// waitFilter is src/watch.ts waitFilter: the filter an event wait's data holds, empty when it holds none.
func waitFilter(w db.Wait) Filter {
	if w.Data == nil {
		return Filter{}
	}
	v, err := jsjson.Parse([]byte(*w.Data))
	o, _ := v.(*jsjson.Object)
	if err != nil || o == nil {
		return Filter{}
	}
	f, _ := o.Get("filter")
	return Sanitize(f)
}

// WaitFilter is the filter of an event wait's data, as the wait is matched.
func WaitFilter(w db.Wait) Filter { return waitFilter(w) }

// deliverWaitNotice hands a cleared event wait's notice to its agent: one transaction stores it as an answer notice,
// which the lifecycle keeps until the agent has it and puts back after a restart, and removes the stored copy; then it
// is queued. A crash before the transaction leaves the stored copy for the next start; after it, the answer notice. An
// agent that is archived or gone gets none, and the stored copy goes.
func (s *Service) deliverWaitNotice(ctx context.Context, n db.WaitNotice) {
	s.deliverMu.Lock()
	defer s.deliverMu.Unlock()
	row, err := s.o.DB.DeliverWaitNotice(ctx, n.WaitID, n.Agent, n.Text)
	if err != nil {
		slog.Error("event wait notice not delivered", "wait", n.WaitID, "err", err)
		return
	}
	if row != 0 {
		s.o.Host.QueueNoticeRow(ctx, n.Agent, n.Text, row)
	}
}

// arm starts the fold timer of a subscription's queue unless it has one: the first event of a batch starts the window.
func (s *Service) arm(subID string) { s.armAfter(subID, s.o.Fold()) }

func (s *Service) armAfter(subID string, d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if _, ok := s.timers[subID]; ok {
		return
	}
	s.timers[subID] = s.o.Timers.AfterFunc(d, func() { s.fired(subID) })
}

func (s *Service) fired(subID string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	delete(s.timers, subID)
	s.wg.Add(1)
	s.mu.Unlock()
	defer s.wg.Done()
	s.flushOne(s.base, subID)
}

// Flush delivers every folded batch now, instead of waiting for its timer. Tests call it.
func (s *Service) Flush(ctx context.Context) error {
	ids, err := s.o.DB.QueueIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.mu.Lock()
		if stop, ok := s.timers[id]; ok {
			stop()
			delete(s.timers, id)
		}
		s.mu.Unlock()
		s.flushOne(ctx, id)
	}
	return nil
}

// ForgetAgent drops an archived or forgotten agent's subscriptions with the deliveries they have folded and the notices
// of its cleared waits. A delivery already in flight for the agent finishes first; one that starts after drops itself.
func (s *Service) ForgetAgent(ctx context.Context, agentID string) {
	s.mu.Lock()
	s.forgot[agentID]++
	s.mu.Unlock()
	s.deliverMu.Lock()
	defer s.deliverMu.Unlock()
	dropped, err := s.o.DB.ForgetAgentEvents(ctx, agentID)
	if err != nil {
		slog.Error("agent's event subscriptions not dropped", "agent", agentID, "err", err)
		return
	}
	s.mu.Lock()
	for _, id := range dropped {
		if stop, ok := s.timers[id]; ok {
			stop()
			delete(s.timers, id)
		}
	}
	s.mu.Unlock()
}

// RemoveSubscription deletes a subscription and the delivery it still has folded, and stops its timer. A delivery of it in
// flight finishes first.
func (s *Service) RemoveSubscription(ctx context.Context, id string) (bool, error) {
	s.deliverMu.Lock()
	defer s.deliverMu.Unlock()
	removed, err := s.o.DB.RemoveSubscription(ctx, id)
	s.mu.Lock()
	if stop, ok := s.timers[id]; ok {
		stop()
		delete(s.timers, id)
	}
	s.mu.Unlock()
	return removed, err
}

// RemoveSubscriptionBy is RemoveSubscription for a caller that must be authorized: the check and the delete are one
// transaction (db.RemoveSubscriptionBy). allowed is false when the caller may not remove it.
func (s *Service) RemoveSubscriptionBy(ctx context.Context, id, by, chiefName string) (removed, allowed bool, err error) {
	s.deliverMu.Lock()
	defer s.deliverMu.Unlock()
	removed, allowed, err = s.o.DB.RemoveSubscriptionBy(ctx, id, by, chiefName)
	if !allowed {
		return removed, allowed, err
	}
	s.mu.Lock()
	if stop, ok := s.timers[id]; ok {
		stop()
		delete(s.timers, id)
	}
	s.mu.Unlock()
	return removed, allowed, err
}

func (s *Service) forgotCount(agentID string) uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.forgot[agentID]
}

type outcome int

const (
	// sent: the batch reached its subscriber.
	sent outcome = iota
	// dropped: the batch has no one to go to (an agent archived, an ITSA gone) and is removed.
	dropped
	// retry: the delivery failed; the batch stays and is tried again after a longer wait.
	retry
	// again: the subscriber changed since it was read; the batch stays and goes again at once.
	again
	// later: the agent's generation moved (an archive or forget is under way); the batch stays and is looked at again
	// after a wait, by which time ForgetAgent has removed it, or the agent is still there and it is delivered.
	later
)

// backoff is the wait before the next try of a batch that has failed attempts times in a row.
func (s *Service) backoff(attempts int) time.Duration {
	d := s.o.RetryAfter
	for i := 1; i < attempts && d < MaxBackoff; i++ {
		d *= 2
	}
	return min(d, MaxBackoff)
}

// flushOne delivers one subscription's folded batch: it reads the queue, makes the delivery, and removes the lines it
// delivered, in the delivery's own transaction where there is one. A line that joined the queue meanwhile stays, with a
// timer of its own. A failing batch is never dropped: it is kept and tried again after a longer wait.
func (s *Service) flushOne(ctx context.Context, subID string) {
	s.deliverMu.Lock()
	defer s.deliverMu.Unlock()
	q, ok, err := s.o.DB.ReadQueue(ctx, subID)
	if err != nil {
		slog.Error("event delivery: queue", "subscription", subID, "err", err)
		s.armAfter(subID, s.o.RetryAfter)
		return
	}
	if !ok || len(q.Lines) == 0 {
		return
	}
	if s.hookAfterRead != nil {
		s.hookAfterRead(subID)
	}
	n := len(q.Lines)
	var lines []string
	ended, failed := false, false
	for _, l := range q.Lines {
		lines = append(lines, l.Text)
		ended = ended || l.Ended
		failed = failed || l.Failed
	}
	out, left, acked := s.deliver(ctx, q.Sub, n, lines, ended, failed)
	// A stop in the middle leaves the batch queued for the next start, whatever the delivery made of it.
	if ctx.Err() != nil {
		return
	}
	switch out {
	case again:
		s.armAfter(subID, 0)
		return
	case later:
		s.armAfter(subID, s.o.RetryAfter)
		return
	case retry:
		attempts, err := s.o.DB.FailQueue(ctx, subID)
		if err != nil {
			slog.Error("event delivery: failure not counted", "subscription", subID, "err", err)
			s.armAfter(subID, s.o.RetryAfter)
			return
		}
		if attempts == MaxAttempts {
			slog.Error("event delivery keeps failing; the batch is kept and tried again later", "subscription", subID, "events", n, "attempts", attempts)
		}
		s.armAfter(subID, s.backoff(attempts))
		return
	}
	if !acked {
		if left, err = s.o.DB.AckQueue(ctx, subID, n); err != nil {
			slog.Error("event delivery not cleared", "subscription", subID, "err", err)
			return
		}
	}
	if left > 0 {
		s.arm(subID)
	}
}

func subjectFor(sub db.QueueSub, n int) string {
	what := "external"
	if sub.Note != nil {
		what = *sub.Note
	} else if sub.Source != "" {
		what = sub.Source
	}
	plural := "s"
	if n == 1 {
		plural = ""
	}
	return fmt.Sprintf("[stam] %d %s event%s", n, what, plural)
}

func (s *Service) body(intro string, lines []string) string {
	text, err := s.o.Host.Render("event-notice", map[string]string{"intro": intro, "events": strings.Join(lines, "\n")})
	if err != nil {
		return intro + "\n\n" + strings.Join(lines, "\n")
	}
	return text
}

// deliver makes one batch's delivery to its subscriber (src/watch.ts deliver). The subscriber is read again here, and
// once more inside the transaction that makes the delivery, so an agent archived or gone since the timer was armed gets
// nothing, and a notice is never made for an agent that has gone idle. acked is whether the lines are already off the
// queue (they went in the delivery's transaction), left the lines still queued then.
func (s *Service) deliver(ctx context.Context, sub db.QueueSub, n int, lines []string, ended, failed bool) (out outcome, left int, acked bool) {
	subject := subjectFor(sub, len(lines))
	switch sub.Kind {
	case "agent":
		g := s.forgotCount(sub.SubscriberID)
		note := ""
		if sub.Note != nil {
			note = " (" + *sub.Note + ")"
		}
		intro := "New events for your subscription" + note + ". Manage it with `list_subscriptions` and `unsubscribe " + sub.ID + "`."
		if ended {
			intro = "New events for your subscription" + note + ". It ended with these, so there is nothing to unsubscribe."
		}
		body := s.body(intro, lines)
		// A failure in the batch marks it for a retro (S-726); only this agent's copy, not an ITSA's.
		if failed {
			body = s.o.Host.WithFailureRetro(body)
		}
		a, err := s.o.DB.GetAgent(ctx, sub.SubscriberID)
		if errors.Is(err, db.ErrNotFound) {
			return dropped, 0, false
		}
		if err != nil {
			slog.Error("event delivery: agent", "agent", sub.SubscriberID, "err", err)
			return retry, 0, false
		}
		if s.hookBeforeSend != nil {
			s.hookBeforeSend(a.ID)
		}
		// The agent is read again, and the generation compared: an archive under way holds the batch back for ForgetAgent.
		cur, err := s.o.DB.GetAgent(ctx, a.ID)
		if errors.Is(err, db.ErrNotFound) || (err == nil && cur.Lifecycle == "archived") {
			return dropped, 0, false
		}
		if err != nil {
			return retry, 0, false
		}
		if s.forgotCount(a.ID) != g {
			return later, 0, false
		}
		if s.hookAfterRecheck != nil {
			s.hookAfterRecheck(cur.ID)
		}
		// The delivery and the removal of its lines are one transaction, which reads the agent once more (the archive may
		// land after the read above): a notice is stored with the answer notice that outlives a restart, mail with its row.
		if cur.Lifecycle == "active" && cur.Activity == "working" {
			row, left, err := s.o.DB.DeliverNotice(ctx, sub.ID, n, cur.ID, body)
			switch {
			case errors.Is(err, db.ErrAgentGone):
				return dropped, 0, false
			case errors.Is(err, db.ErrDeliveryStale):
				return again, 0, false
			case err != nil:
				slog.Error("event delivery: notice", "agent", cur.ID, "err", err)
				return retry, 0, false
			}
			s.o.Host.QueueNoticeRow(ctx, cur.ID, body, row)
			return sent, left, true
		}
		ran := false
		commit := func(conn *sqlite.Conn, id string) error {
			ran = true
			return db.MailCommit(sub.ID, n, cur.ID, &left)(conn, id)
		}
		err = s.o.Host.MailAgent(ctx, cur.ID, subject, body, commit)
		switch {
		case errors.Is(err, db.ErrAgentGone):
			return dropped, 0, false
		case errors.Is(err, db.ErrDeliveryStale):
			return again, 0, false
		case err != nil:
			slog.Error("event delivery: mail", "agent", cur.ID, "err", err)
			return retry, 0, false
		}
		return sent, left, ran
	case "human":
		body := s.body("You asked to hear about these events.", lines)
		// One thread per subscription: the first delivery starts it, later ones reply into it. The mail, the thread's
		// pointer and the removal of the lines commit together, so a crash never starts a second thread.
		live, err := s.o.DB.FindSubscription(ctx, sub.ID)
		replyTo := ""
		if err == nil && live.LastMailID != nil {
			replyTo = *live.LastMailID
		}
		ran := false
		commit := func(conn *sqlite.Conn, id string) error {
			ran = true
			return db.MailCommit(sub.ID, n, "", &left)(conn, id)
		}
		id, err := s.o.Host.MailHuman(ctx, subject, body, replyTo, commit)
		switch {
		case errors.Is(err, db.ErrDeliveryStale):
			return again, 0, false
		case err != nil:
			slog.Error("event delivery: mail to the human", "err", err)
			return retry, 0, false
		}
		if !ran {
			if err := s.o.DB.SetSubscriptionMail(ctx, sub.ID, id); err != nil {
				slog.Error("event delivery: thread not recorded", "subscription", sub.ID, "err", err)
			}
		}
		return sent, left, ran
	}
	// An ITSA: a quiet post into its thread, as stam, for its agents only (S-511).
	body := s.body("Events you asked to hear about.", lines)
	gone, err := s.o.Host.PostItsa(ctx, sub.SubscriberID, body)
	if err != nil {
		slog.Error("event delivery: ITSA post", "itsa", sub.SubscriberID, "err", err)
		return retry, 0, false
	}
	if gone {
		return dropped, 0, false
	}
	return sent, 0, false
}
