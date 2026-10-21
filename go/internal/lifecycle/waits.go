package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/cron"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// Declared waits and timers, and the scheduler that fires them (src/waits.ts, S-2848 B2a). An agent declares a wait for
// a reply itself (wait_for): it clears when the awaited mail arrives (db.StoreMail's clearDeclaredWaits), or on a
// timeout, which tells the agent. An agent schedules a wake-up with wake_me: a one-off note, or a cron or periodic
// timer that fires its note each time and stays until wait_done. Each notice goes out after the write that made it
// commits.
//
// Not ported, refused by the routes before any write: a wait on an external event, a target on another machine, and
// rest. Nor are daemon-owned timers (a tag).

// ErrWait is a wait the request can't make: the route answers 400 with its text.
type ErrWait struct{ Msg string }

func (e ErrWait) Error() string { return e.Msg }

func badWait(format string, args ...any) error { return ErrWait{fmt.Sprintf(format, args...)} }

func minutesFrom(t time.Time, n float64) string {
	return iso(t.Add(time.Duration(n * float64(time.Minute))))
}

// Declare is a wait_for on an agent or the human (src/waits.ts declare): On is "agent" or "human".
type Declare struct {
	On string
	// Target is the awaited agent, here (On "agent"); "" for the human.
	Target db.Agent
	// Thread is the mail thread to wait in, "" for any.
	Thread string
	Note   string
	// Timeout and Expect are minutes, nil when not given; the route checked they are positive.
	Timeout, Expect *float64
}

type declaredEvent struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	Target         *string  `json:"target"`
	Thread         *string  `json:"thread"`
	TimeoutMinutes *float64 `json:"timeout_minutes"`
}

type nudgedEvent struct {
	Waiter string  `json:"waiter"`
	Thread *string `json:"thread"`
	Mail   string  `json:"mail"`
}

// DeclareWait is src/waits.ts declare for a reply wait: the wait, the agent awaited nudged once per ask (the nudge
// claimed in the wait's transaction), and the wait:declared event. A wait on the human from an agent with a request
// pending with them is tied to that request.
func (l *Lifecycle) DeclareWait(ctx context.Context, a db.Agent, d Declare) (db.Wait, error) {
	now := time.Now()
	var target *string
	targetName := "your user"
	if d.On == "agent" {
		target, targetName = &d.Target.ID, d.Target.Name
	}
	if d.On == "human" {
		if d.Thread == "" {
			settled, err := l.settledNamed(ctx, a.ID, d.Note)
			if err != nil {
				return db.Wait{}, err
			}
			if settled != nil {
				return db.Wait{}, badWait("request %s is already %s, so your user has nothing left to answer for it. To wait for their reply to a mail, pass that mail's thread", settled.ID, settled.Status)
			}
		}
		r, err := l.requestWaitedOn(ctx, a.ID, d.Note, d.Thread, "")
		if err != nil {
			return db.Wait{}, err
		}
		if r != nil {
			target = &r.ID
		}
	}
	detail := d.Note
	if detail == "" {
		detail = "reply from " + targetName
		if d.On == "human" {
			detail = "your user's reply"
		}
	}
	data := jsjson.NewObject("on", d.On)
	if target != nil {
		data.Set("target", *target)
	}
	if d.Thread != "" {
		data.Set("thread", d.Thread)
	}
	if d.Timeout != nil {
		data.Set("timeout_minutes", *d.Timeout)
	}
	if d.Expect != nil {
		data.Set("expect_at", minutesFrom(now, *d.Expect))
	}
	var until *string
	if d.Timeout != nil {
		u := minutesFrom(now, *d.Timeout)
		until = &u
	}
	var thread *string
	if d.Thread != "" {
		thread = &d.Thread
	}
	var nudge *nudgedEvent
	if d.On == "agent" {
		var err error
		if nudge, err = l.nudgeDue(ctx, d.Target.ID, a.ID, d.Thread); err != nil {
			return db.Wait{}, err
		}
	}
	nudged := false
	text := jsjson.Stringify(data, "")
	w, err := l.db.AddWaitWith(ctx, db.NewWait{AgentID: a.ID, Kind: d.On, Source: "declared", Target: target, Detail: &detail, Until: until, Data: &text},
		func(tx db.WaitTx, w db.Wait) error {
			if nudge != nil {
				claimed, err := tx.ClaimNudge(d.Target.ID, a.ID, deref(nudge.Thread), nudge.Mail)
				if err != nil {
					return err
				}
				if claimed {
					nudged = true
					if err := tx.AddEvent(d.Target.ID, "wait:nudged", nudge); err != nil {
						return err
					}
				}
			}
			return tx.AddEvent(a.ID, "wait:declared", declaredEvent{ID: w.ID, Kind: d.On, Target: target, Thread: thread, TimeoutMinutes: d.Timeout})
		})
	if err != nil {
		return db.Wait{}, err
	}
	if nudged {
		in := ""
		if d.Thread != "" {
			in = " (thread " + d.Thread + ")"
		}
		if msg, err := l.render("wait-for", map[string]string{"name": a.Name, "thread": in}); err != nil {
			slog.Error("wait_for notice", "for", targetName, "err", err)
		} else {
			l.QueueNotice(ctx, d.Target.ID, msg, false)
		}
	}
	return w, nil
}

// nudgeDue is src/waits.ts nudgeDue: the nudge a wait_for due now sends the awaited agent, keyed by what it answers, or
// nil for none. The ask is the waiter's newest mail to it (in the wait's thread, or any), the answer its newest mail to
// the waiter; an answer newer than the ask needs no nudge, an unanswered ask one, keyed by its id; with no ask, one per
// thread ever, once the awaited agent answered there, or with no thread one per answer.
func (l *Lifecycle) nudgeDue(ctx context.Context, target, waiter, thread string) (*nudgedEvent, error) {
	threadID := ""
	if thread != "" {
		threadID = thread
		ts, err := l.db.MailThreadIDs(ctx, []string{thread})
		if err != nil {
			return nil, err
		}
		if t, ok := ts[thread]; ok {
			threadID = t
		}
	}
	ask, err := l.db.LatestMailBetween(ctx, waiter, target, threadID, true)
	if err != nil {
		return nil, err
	}
	answer, err := l.db.LatestMailBetween(ctx, target, waiter, threadID, false)
	if err != nil {
		return nil, err
	}
	var th *string
	if threadID != "" {
		th = &threadID
	}
	ev := &nudgedEvent{Waiter: waiter, Thread: th}
	if ask == nil {
		if threadID != "" {
			if answer == nil {
				return nil, nil
			}
			ev.Mail = "declare:"
			return ev, nil
		}
		ev.Mail = "declare:"
		if answer != nil {
			ev.Mail += answer.ID
		}
		return ev, nil
	}
	if answer != nil && answer.Seq > ask.Seq {
		return nil, nil
	}
	ev.Mail = ask.ID
	return ev, nil
}

var requestID = regexp.MustCompile(`\bp[0-9a-f]{6}\b`)

func named(note string) map[string]bool {
	out := map[string]bool{}
	for _, id := range requestID.FindAllString(note, -1) {
		out[id] = true
	}
	return out
}

// requestWaitedOn is src/waits.ts requestWaitedOn: of the agent's requests to the human that were pending when the wait
// began (since, an ISO time; "" for a new wait, now), the one the note names, else the one whose thread it waits in,
// else (waiting in no thread) the newest; nil for none.
func (l *Lifecycle) requestWaitedOn(ctx context.Context, agentID, note, thread, since string) (*db.RequestState, error) {
	all, err := l.db.AgentRequests(ctx, agentID)
	if err != nil {
		return nil, err
	}
	var open []db.RequestState
	for _, r := range all {
		if r.Audience != "human" {
			continue
		}
		if since == "" && r.Status == "pending" ||
			since != "" && r.CreatedAt <= since && (r.Status == "pending" || r.DecidedAt != nil && *r.DecidedAt != "" && *r.DecidedAt >= since) {
			open = append(open, r)
		}
	}
	ids := named(note)
	for _, r := range open {
		if ids[r.ID] {
			return &r, nil
		}
	}
	if thread != "" {
		th := thread
		ts, err := l.db.MailThreadIDs(ctx, []string{thread})
		if err != nil {
			return nil, err
		}
		if t, ok := ts[thread]; ok {
			th = t
		}
		id, err := l.db.RequestOfThread(ctx, th)
		if err != nil || id == "" {
			return nil, err
		}
		for _, r := range open {
			if r.ID == id {
				return &r, nil
			}
		}
		return nil, nil
	}
	if len(open) > 0 {
		return &open[0], nil
	}
	return nil, nil
}

// settledNamed is src/waits.ts settledNamed: a settled request of the agent's that the note names, when it names none
// still pending; nil otherwise.
func (l *Lifecycle) settledNamed(ctx context.Context, agentID, note string) (*db.RequestState, error) {
	ids := named(note)
	if len(ids) == 0 {
		return nil, nil
	}
	all, err := l.db.AgentRequests(ctx, agentID)
	if err != nil {
		return nil, err
	}
	var mine []db.RequestState
	for _, r := range all {
		if ids[r.ID] {
			if r.Status == "pending" {
				return nil, nil
			}
			mine = append(mine, r)
		}
	}
	if len(mine) == 0 {
		return nil, nil
	}
	return &mine[0], nil
}

// Wake is a wake_me timer (src/waits.ts wake): exactly one of the four schedules, already read and checked by the route
// except the cron spec.
type Wake struct {
	Note string
	// Mode is in_minutes, at, cron or every_minutes.
	Mode string
	// Minutes is in_minutes' or every_minutes' value, At the time `at` names, Cron the spec, trimmed.
	Minutes float64
	At      time.Time
	Cron    string
}

type wakeEvent struct {
	ID    string `json:"id"`
	Mode  string `json:"mode"`
	Until string `json:"until"`
	Note  string `json:"note"`
}

// WakeAt is src/waits.ts wake: a stam timer for the agent, with its schedule kept in data so a restart can recompute the
// next fire, and the wait:wake event. A bad cron spec is an ErrWait.
func (l *Lifecycle) WakeAt(ctx context.Context, agentID string, w Wake) (db.Wait, error) {
	now := time.Now()
	data := jsjson.NewObject()
	var until string
	switch w.Mode {
	case "in_minutes":
		data.Set("in_minutes", w.Minutes)
		until = minutesFrom(now, w.Minutes)
	case "at":
		until = iso(w.At)
		data.Set("at", until)
	case "cron":
		next, err := cron.Next(w.Cron, now)
		if err != nil {
			return db.Wait{}, ErrWait{err.Error()}
		}
		data.Set("cron", w.Cron)
		until = iso(next)
	case "every_minutes":
		data.Set("every_minutes", w.Minutes)
		until = minutesFrom(now, w.Minutes)
	default:
		return db.Wait{}, badWait("wake_me needs exactly one of in_minutes, at, cron, every_minutes")
	}
	text := jsjson.Stringify(data, "")
	note := w.Note
	return l.db.AddWaitWith(ctx, db.NewWait{AgentID: agentID, Kind: "timer", Source: "stam", Detail: &note, Until: &until, Data: &text},
		func(tx db.WaitTx, added db.Wait) error {
			return tx.AddEvent(agentID, "wait:wake", wakeEvent{ID: added.ID, Mode: w.Mode, Until: until, Note: sliceUTF16(note, 120)})
		})
}

type timeoutEvent struct {
	ID     string  `json:"id"`
	Kind   string  `json:"kind"`
	Target *string `json:"target"`
}

type wokeEvent struct {
	ID    string  `json:"id"`
	Until *string `json:"until"`
}

// TickWaits is src/waits.ts tick: every wait whose until has passed fires. A declared wait times out and tells its agent;
// a timer sends its note and moves to its next fire time, or clears when it was a one-off. It returns how many fired.
func (l *Lifecycle) TickWaits(ctx context.Context, now time.Time) (int, error) {
	due, err := l.db.DueWaits(ctx, iso(now))
	if err != nil {
		return 0, err
	}
	fired := 0
	var errs []error
	for _, w := range due {
		data, _ := waitData(w.Data)
		var notice string
		var ok bool
		if w.Source == "declared" {
			minutes := get(data, "timeout_minutes")
			if minutes == nil {
				minutes = math.Round(float64(parseISO(deref(w.Until)).Sub(parseISO(w.Since))) / float64(time.Minute))
			}
			what := w.Kind + " reply"
			if w.Detail != nil {
				what = *w.Detail
			}
			if notice, err = l.render("wait-timeout", map[string]string{"what": what, "minutes": claude.JSString(minutes)}); err != nil {
				errs = append(errs, err)
				continue
			}
			ok, err = l.db.FireWait(ctx, w, nil, "wait:timeout", timeoutEvent{ID: w.ID, Kind: w.Kind, Target: w.Target})
		} else {
			notice = "timer"
			if w.Detail != nil {
				notice = *w.Detail
			}
			next, nerr := nextFire(data, now)
			if nerr != nil {
				// A stored schedule that no longer parses fires this once and clears, as a one-off: left due, it would
				// fail every tick. (TS stops its tick there, and fires it again each second.)
				errs = append(errs, fmt.Errorf("timer %s cleared: %w", w.ID, nerr))
				next = nil
			}
			ok, err = l.db.FireWait(ctx, w, next, "wait:woke", wokeEvent{ID: w.ID, Until: next})
		}
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !ok {
			continue
		}
		l.QueueNotice(ctx, w.AgentID, notice, false)
		fired++
	}
	return fired, errors.Join(errs...)
}

// nextFire is a repeating timer's next fire time from now; nil for a one-off.
func nextFire(data *jsjson.Object, now time.Time) (*string, error) {
	if c := get(data, "cron"); jsjson.Truthy(c) {
		next, err := cron.Next(claude.JSString(c), now)
		if err != nil {
			return nil, err
		}
		s := iso(next)
		return &s, nil
	}
	if n, ok := get(data, "every_minutes").(float64); ok && n > 0 {
		s := minutesFrom(now, n)
		return &s, nil
	}
	return nil, nil
}

// waitData is a wait's data parsed, src/waits.ts parseData: an empty object for none or for text that isn't JSON.
func waitData(raw *string) (*jsjson.Object, bool) {
	if raw == nil || *raw == "" {
		return jsjson.NewObject(), false
	}
	v, err := jsjson.Parse([]byte(*raw))
	if o, ok := v.(*jsjson.Object); err == nil && ok {
		return o, true
	}
	return jsjson.NewObject(), false
}

func get(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

func parseISO(s string) time.Time {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}

// waitTick is how often the scheduler looks for due waits (src/waits.ts startScheduler).
var waitTick = time.Second

// StartWaits starts the waits' scheduler: its first tick runs at once, so timers that came due while the daemon was down
// fire once (the next fire is computed from now, never per missed tick), then one a second until the daemon stops.
func (l *Lifecycle) StartWaits() {
	l.bg.Add(1)
	go func() {
		defer l.bg.Done()
		t := time.NewTicker(waitTick)
		defer t.Stop()
		for {
			if _, err := l.TickWaits(l.ctx, time.Now()); err != nil && l.ctx.Err() == nil {
				slog.Error("waits", "err", err)
			}
			select {
			case <-l.ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}
