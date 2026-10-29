package lifecycle

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"stam/internal/agentview"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The model test of the OpenCode view's sends (S-4237 PR 6): a prompt and a permission reply from the view, crossed with the
// agent moving on (a stop, a new session, the same session resumed, a stop begun, a launch in flight) at each place the send
// reads the session or the generation: before the binding (the caller's row is old by now: "view-start"), and between the
// binding and the check with the session's slot held, right before the call ("view-slot"). An intrusion before the binding is
// the agent as the send finds it (served only while it runs a session and no launch is in flight, and then in the session it
// runs now); one after it leaves the send refused, with nothing sent anywhere. Every read the view makes:
//   - Page and Status read the row's session at the call (a read, no action),
//   - the bind reads the session and the generation together under the owner's lock (ViewSend, "view-start" is just before),
//   - the check with the slot held reads them again (keep and still, "view-slot" is just before),
//   - the call itself holds the slot: a stop or a relaunch's release takes its turn of the slot after the call returns
//     (TestViewSendHoldsTheSlot),
//   - Interrupt reads the row itself (openCodeInterrupt) and is the lifecycle's own, with its stop tests.

func TestOpenCodeViewSendModel(t *testing.T) {
	sends := []struct {
		name string
		do   func(o *agentview.OpenCode, a db.Agent) error
		sent func(s *stopLive) []string
	}{
		{"prompt", func(o *agentview.OpenCode, a db.Agent) error {
			return o.Prompt(context.Background(), a, "hello", "queue")
		}, (*stopLive).promptsOf},
		{"reply", func(o *agentview.OpenCode, a db.Agent) error {
			return o.AnswerPermission(context.Background(), a, "per_1", "once")
		}, (*stopLive).gotReplies},
	}
	for _, send := range sends {
		for _, step := range []string{"view-start", "view-slot"} {
			for _, in := range ocIntruders {
				switch in.name {
				case "stop", "newsession", "samesession", "stopping", "launching":
				default:
					continue
				}
				t.Run(send.name+"/"+step+"/"+in.name, func(t *testing.T) {
					id := "atv1"
					s, _ := newJobLive(t, id)
					ocSeed(s, id)
					a := s.agent(id)
					o := &agentview.OpenCode{DB: s.db, Call: s.life.OpenCodeCall, Send: s.life.ViewSend}
					fired := false
					s.life.turnStep = func(aid, at string) {
						if at == step && aid == id && !fired {
							fired = true
							in.apply(s, id, 2, false)
						}
					}
					err := send.do(o, a)
					s.life.turnStep = nil
					if !fired {
						t.Fatalf("the send never reached %s", step)
					}
					sent := send.sent(s)
					// Where the intrusion left the agent, and so where a send that goes belongs.
					now := s.agent(id)
					running := (now.Lifecycle == "active" || now.Lifecycle == "paused") && now.SessionID != nil
					served := false
					switch step {
					case "view-start":
						// The binding is taken after the intrusion: it finds the agent as it is.
						served = running && in.name != "launching"
					}
					if served {
						want := "ses_" + id
						if now.SessionID != nil {
							want = *now.SessionID
						}
						if err != nil || len(sent) != 1 || !strings.HasPrefix(sent[0], want) {
							t.Errorf("a send to the agent as it is: err %v, sent %v, session %s", err, sent, want)
						}
						return
					}
					if e, ok := agentview.AsError(err); !ok || e.Status != 409 {
						t.Errorf("a stale send: %v", err)
					}
					if len(sent) != 0 {
						t.Errorf("a stale send reached the server: %v", sent)
					}
				})
			}
		}
	}
}

// A send holds its session's slot while its call is made: a relaunch's release (drainSlot) or a stop's turn of the slot,
// begun after the check and before the call, waits for the call to return, so the send reaches the session it was bound to
// before the agent's next one takes over, and a send that finds the slot cancelled sends nothing.
func TestViewSendHoldsTheSlot(t *testing.T) {
	id := "atv2"
	s, _ := newJobLive(t, id)
	ocSeed(s, id)
	o := s.life.ownerOf(id)
	sid := "ses_" + id
	drained := make(chan struct{})
	s.life.turnStep = func(aid, at string) {
		if at == "view-slot" && aid == id {
			go func() {
				// A relaunch's release of the session: its turn of the slot comes after the holder's.
				if err := o.drainSlot(s.ctx, o.joinSlot(sid, nil)); err != nil {
					t.Error(err)
				}
				close(drained)
			}()
		}
	}
	called := false
	sent, err := s.life.ViewSend(s.ctx, id, "per_1", func(got string) error {
		select {
		case <-drained:
			t.Error("the slot's turn came while the call was being made")
		case <-time.After(200 * time.Millisecond):
		}
		called = got == sid
		return nil
	})
	s.life.turnStep = nil
	if !sent || err != nil || !called {
		t.Fatalf("sent %v, err %v, called with the bound session %v", sent, err, called)
	}
	select {
	case <-drained:
	case <-time.After(10 * time.Second):
		t.Fatal("the slot was never given back")
	}
	// The reply was marked in flight and sent.
	o.mu.Lock()
	state := o.answering["per_1"]
	o.mu.Unlock()
	if state != answerSent {
		t.Errorf("the reply's mark is %v, want sent", state)
	}
}

// A send waiting for the slot of a session that a launch has released sends nothing.
func TestViewSendCancelledByRelease(t *testing.T) {
	id := "atv3"
	s, _ := newJobLive(t, id)
	ocSeed(s, id)
	o := s.life.ownerOf(id)
	sid := "ses_" + id
	s.life.turnStep = func(aid, at string) {
		if at == "view-start" && aid == id {
			// Another operation holds the slot, and the launch's release cancels the ops registered on it: the send's join
			// comes after the hold, and the release before the send's turn.
			s.life.turnStep = nil
			held := make(chan struct{})
			slot := o.joinSlot(sid, nil)
			slot.held <- struct{}{}
			go func() {
				close(held)
				for {
					o.mu.Lock()
					n := len(slot.ops)
					o.mu.Unlock()
					if n > 0 {
						break
					}
					time.Sleep(time.Millisecond)
				}
				o.mu.Lock()
				for op := range slot.ops {
					op.cancel()
				}
				o.mu.Unlock()
				<-slot.held
			}()
			<-held
		}
	}
	sent, err := s.life.ViewSend(s.ctx, id, "", func(string) error {
		t.Error("a send cancelled by a release was made")
		return nil
	})
	if sent || err != nil {
		t.Errorf("sent %v, err %v", sent, err)
	}
}

// A permission reply from the view settles the ask raised for its permission: the mark in flight makes permission.replied
// for it ignored, so the view's reply closes the ask itself (the one for that permission only), also when the event came
// before the call returned; a reply that failed leaves it open.
func TestViewReplyClosesTheAsk(t *testing.T) {
	id := "avr1"
	s, fd := newAskLive(t, id, "per_a", "per_b", "per_c")
	sid := "ses_" + id
	o := &agentview.OpenCode{DB: s.db, Call: s.life.OpenCodeCall, Send: s.life.ViewSend}
	s.event(asked(sid, "per_a"))
	if got, n := fd.state(); got == "" || n != 1 {
		t.Fatalf("the ask was not raised: %q (%d)", got, n)
	}
	// The event of the reply comes while the call is in flight (the server tells of it before it answers).
	var during func()
	s.life.turnStep = func(aid, at string) {
		if at == "view-slot" && aid == id {
			during = func() { s.event(replied(sid, "per_a")) }
		}
	}
	// Told of from inside the call: wrap the source's call.
	call := o.Call
	o.Call = func(ctx context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
		if strings.HasSuffix(path, "/reply") && during != nil {
			during()
		}
		return call(ctx, method, path, body)
	}
	if err := o.AnswerPermission(s.ctx, s.agent(id), "per_a", "once"); err != nil {
		t.Fatal(err)
	}
	s.life.turnStep = nil
	if got := s.gotReplies(); len(got) != 1 || got[0] != sid+" per_a once" {
		t.Fatalf("replies %q", got)
	}
	if got, _ := fd.state(); got != "" {
		t.Errorf("the view's reply left the ask open: %q", got)
	}
	// A reply for another permission closes no other ask; one that failed closes none.
	s.event(asked(sid, "per_b"))
	details, _ := fd.state()
	failing := &agentview.OpenCode{DB: s.db, Send: s.life.ViewSend, Call: func(context.Context, string, string, jsjson.Value) (jsjson.Value, error) {
		return nil, errors.New("POST: 500")
	}}
	if err := failing.AnswerPermission(s.ctx, s.agent(id), "per_b", "once"); err == nil {
		t.Fatal("a failed reply reported none")
	}
	if got, _ := fd.state(); got != details {
		t.Errorf("a failed reply closed the ask: %q", got)
	}
	// A successful reply for another permission leaves this ask open.
	if err := o.AnswerPermission(s.ctx, s.agent(id), "per_c", "once"); err != nil {
		t.Fatal(err)
	}
	if got, _ := fd.state(); got != details {
		t.Errorf("a reply for per_c closed per_b's ask: %q", got)
	}
}

// ctxDialogs are the dialogs as the real ones act on a request that has ended: a close under a cancelled context fails.
type ctxDialogs struct{ *fakeDialogs }

func (c ctxDialogs) DialogClosedIf(ctx context.Context, a db.Agent, match func(string) bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return c.fakeDialogs.DialogClosedIf(ctx, a, match)
}

// The client leaves right after the reply went through (its request's context ends before ViewSend returns): the ask is
// closed all the same, since nothing else will close it.
func TestViewReplyClosesTheAskAfterTheRequestEnds(t *testing.T) {
	id := "avr2"
	s, fd := newAskLive(t, id, "per_a")
	s.life.SetDialogs(ctxDialogs{fd})
	sid := "ses_" + id
	s.event(asked(sid, "per_a"))
	if got, _ := fd.state(); got == "" {
		t.Fatal("the ask was not raised")
	}
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	o := &agentview.OpenCode{DB: s.db, Send: s.life.ViewSend, Call: func(c context.Context, method, path string, body jsjson.Value) (jsjson.Value, error) {
		v, err := s.life.OpenCodeCall(c, method, path, body)
		if strings.HasSuffix(path, "/reply") {
			cancel()
		}
		return v, err
	}}
	if err := o.AnswerPermission(ctx, s.agent(id), "per_a", "once"); err != nil {
		t.Fatal(err)
	}
	if got, _ := fd.state(); got != "" {
		t.Errorf("a request that ended after its reply left the ask open: %q", got)
	}
}

// slowDialogs are dialogs whose close waits for its context to end, as one stuck on a lock does.
type slowDialogs struct{ *fakeDialogs }

func (slowDialogs) DialogClosedIf(ctx context.Context, _ db.Agent, _ func(string) bool) error {
	<-ctx.Done()
	return ctx.Err()
}

// The close of the ask after a view reply runs out of its time: the failure is recorded as a permission-error event all the
// same (under a context of its own, not the expired one), with the error's text only: no ask text, no key.
func TestViewReplyCloseTimesOut(t *testing.T) {
	id := "avr3"
	s, fd := newAskLive(t, id, "per_a")
	sid := "ses_" + id
	s.event(asked(sid, "per_a"))
	if got, _ := fd.state(); got == "" {
		t.Fatal("the ask was not raised")
	}
	s.life.SetDialogs(slowDialogs{fd})
	was := viewCloseTimeout
	viewCloseTimeout = 50 * time.Millisecond
	defer func() { viewCloseTimeout = was }()
	o := &agentview.OpenCode{DB: s.db, Call: s.life.OpenCodeCall, Send: s.life.ViewSend}
	if err := o.AnswerPermission(s.ctx, s.agent(id), "per_a", "once"); err != nil {
		t.Fatal(err)
	}
	got := lastEvent(t, s.live, id, "permission-error")
	if !strings.Contains(got, "deadline exceeded") {
		t.Fatalf("the failed close left no permission-error event: %q", got)
	}
	for _, leak := range []string{"make test", "sk-or-v1-leak", "per_a"} {
		if strings.Contains(got, leak) {
			t.Errorf("the event holds %q: %s", leak, got)
		}
	}
}
