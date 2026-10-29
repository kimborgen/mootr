package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
)

// ownerModel drives one agent's owner through three actors, each a chain of the owner's own transitions, the same
// methods production calls, with the I/O between them left out:
//   - a launch: its generation, its release of the session, its turn of the slot, its pane;
//   - a quit: its generation, the kill of the pane begun and ended, its row write (unlessLaunched), its stop listed (a
//     separate step, so a launch can land between them), the slot taken, the stop's keep before its interrupt, its
//     outcome published (a failure, the stubborn case), the slot given back;
//   - a one-shot interrupt: registered, the slot taken, its keep before its call, the slot given back.
//
// A step that would wait (a slot held, a pane while a kill is in flight) makes that ordering one that can't happen, and
// it is skipped: the same steps run later in another ordering. After every step the invariants hold, judged by what
// the model knows of the actors (which generation each took), not by the owner's own fields.
type ownerModel struct {
	t    *testing.T
	o    *owner
	path []string
	// The actors' state.
	lgen, qgen, igen    int
	lslot, sslot, islot *sessionSlot
	stop                *turnStop
	iop                 *slotOp
	killing, paneBegun  bool
	wrote               bool
	stopHolds, intHolds bool
	stopDone            bool
	holders             int
}

const modelSid = "ses_m"

var errWait = errors.New("would wait")

func (m *ownerModel) fail(format string, args ...any) {
	m.t.Helper()
	m.t.Fatalf("%s: %s", strings.Join(m.path, " "), fmt.Sprintf(format, args...))
}

// take is the production takeSlotNow for op, counted: errWait when another holds the slot.
func (m *ownerModel) take(s *sessionSlot, op *slotOp) (slotTake, error) {
	t := m.o.takeSlotNow(s, op)
	switch t {
	case slotWait:
		return t, errWait
	case slotTaken:
		m.holders++
		if m.holders > 1 {
			m.fail("two slot holders")
		}
	}
	return t, nil
}

func (m *ownerModel) leave(s *sessionSlot, op *slotOp) {
	m.holders--
	m.o.leaveSlot(s, op)
}

// newer is whether the launch took a generation later than gen.
func (m *ownerModel) newer(gen int) bool { return m.lgen > gen }

// The launch's steps.
func (m *ownerModel) launchSteps() []func() error {
	return []func() error{
		func() error { m.lgen = m.o.beginLaunch(); return nil },
		func() error {
			stopWasCancelled := m.stop != nil && m.stop.cancelled.Load()
			intWasCancelled := m.iop != nil && m.iop.cancelled.Load()
			m.lslot = m.o.release(m.lgen, modelSid)
			stale := m.qgen > m.lgen
			if stale && m.lslot != nil {
				m.fail("a stale launch's release was let through")
			}
			if stale && ((m.stop != nil && m.stop.cancelled.Load() && !stopWasCancelled) || (m.iop != nil && m.iop.cancelled.Load() && !intWasCancelled)) {
				m.fail("a stale launch's release cancelled a newer operation")
			}
			if !stale && m.lslot == nil {
				m.fail("a current launch's release was refused")
			}
			if !stale {
				m.o.mu.Lock()
				for op := range m.lslot.ops {
					if !op.cancelled.Load() {
						m.fail("a current launch's release left a registered operation uncancelled")
					}
				}
				m.o.mu.Unlock()
			}
			return nil
		},
		func() error {
			// The release's turn of the slot (drainSlot's step): once whatever held it has published, given straight back.
			if m.lslot == nil {
				return nil
			}
			if _, err := m.take(m.lslot, nil); err != nil {
				return err
			}
			m.leave(m.lslot, nil)
			return nil
		},
		func() error {
			if m.lslot == nil {
				return nil
			}
			m.o.mu.Lock()
			kills := m.o.kills
			begun, wait := m.o.tryPane(m.lgen)
			m.o.mu.Unlock()
			if wait {
				return errWait
			}
			if begun && kills > 0 {
				m.fail("a pane began while a kill was in flight")
			}
			if begun && m.qgen > m.lgen {
				m.fail("a pane began after a newer quit")
			}
			m.paneBegun = begun
			return nil
		},
	}
}

// The quit's steps, with its stop.
func (m *ownerModel) quitSteps() []func() error {
	return []func() error{
		func() error { m.qgen = m.o.invalidate(); return nil },
		func() error {
			m.killing = m.o.beginKill(m.qgen, false)
			if m.killing && m.newer(m.qgen) {
				m.fail("a kill began after a newer launch")
			}
			if m.killing && m.paneBegun {
				// The newer quit kills the older launch's pane, as it should; the pane began before the kill.
				m.paneBegun = false
			}
			return nil
		},
		func() error {
			if m.killing {
				m.o.endKill()
				m.killing = false
			}
			return nil
		},
		func() error {
			// The quit's row write (updateUnlessLaunched).
			m.wrote, _ = m.o.unlessLaunched(m.qgen, func() (bool, error) { return true, nil })
			if m.wrote && m.newer(m.qgen) {
				m.fail("the quit wrote its row after a newer launch")
			}
			return nil
		},
		func() error {
			// Its stop, listed after the write: a launch may have landed between them.
			if !m.wrote {
				m.stopDone = true
				return nil
			}
			var started bool
			m.stop, m.sslot, started = m.o.startStop(modelSid, m.qgen)
			if !started {
				m.fail("a fresh stop joined another")
			}
			return nil
		},
		func() error {
			if m.stopDone {
				return nil
			}
			t, err := m.take(m.sslot, &m.stop.slotOp)
			if err != nil {
				return err
			}
			if t == slotGivenUp {
				m.publish()
				return nil
			}
			m.stopHolds = true
			return nil
		},
		func() error {
			if !m.stopHolds {
				return nil
			}
			// The stop's keep, before its interrupt.
			if m.o.keep(&m.stop.slotOp, m.qgen) && m.newer(m.qgen) && m.lslot != nil {
				m.fail("a stop sent an interrupt after a newer launch's release")
			}
			return nil
		},
		func() error {
			if m.stopDone {
				return nil
			}
			m.publish()
			return nil
		},
		func() error {
			if m.stopHolds {
				m.leave(m.sslot, &m.stop.slotOp)
				m.stopHolds = false
			}
			return nil
		},
	}
}

// publish publishes the stop's failure (a stubborn session) and checks what it wrote and what its waiter hears.
func (m *ownerModel) publish() {
	m.o.publish(modelSid, m.stop, errors.New("still runs"), nil, func(err error, givenUp bool) {
		if (err != nil || !givenUp) && m.newer(m.stop.gen) {
			m.fail("a stop older than the last launch published its outcome")
		}
		if err != nil && givenUp {
			m.fail("a stop given up published a failure")
		}
	})
	if m.o.stopOf(modelSid) == m.stop {
		m.fail("a published stop is still listed")
	}
	if err := m.o.await(context.Background(), m.stop); m.newer(m.stop.gen) && err != errStopGivenUp {
		m.fail("a stop older than the last launch was awaited as %v", err)
	}
	m.stopDone = true
}

// The one-shot interrupt's steps.
func (m *ownerModel) interruptSteps() []func() error {
	return []func() error{
		func() error {
			m.igen = m.o.now()
			m.iop = &slotOp{stop: make(chan struct{})}
			m.islot = m.o.joinSlot(modelSid, m.iop)
			return nil
		},
		func() error {
			t, err := m.take(m.islot, m.iop)
			if err != nil {
				return err
			}
			m.intHolds = t == slotTaken
			return nil
		},
		func() error {
			// openCodeInterrupt's keep, before its call.
			if m.intHolds && m.o.keep(m.iop, m.igen) && m.newer(m.igen) {
				m.fail("an interrupt sent its call after a newer launch")
			}
			return nil
		},
		func() error {
			if m.intHolds {
				m.leave(m.islot, m.iop)
				m.intHolds = false
			}
			return nil
		},
	}
}

// interleavings calls run with every merge of chains of the given lengths, as the chain index of each step.
func interleavings(lens []int, run func(order []int)) {
	left := append([]int(nil), lens...)
	total := 0
	for _, n := range lens {
		total += n
	}
	order := make([]int, 0, total)
	var walk func()
	walk = func() {
		if len(order) == total {
			run(order)
			return
		}
		for c := range left {
			if left[c] == 0 {
				continue
			}
			left[c]--
			order = append(order, c)
			walk()
			order = order[:len(order)-1]
			left[c]++
		}
	}
	walk()
}

// Every ordering of a launch, a quit with its stop, and a one-shot interrupt on one agent keeps the owner's invariants:
// a stale launch's release cancels nothing and is refused; a current one cancels every operation; a stop older than
// the last launch publishes nothing; no kill begins after a newer launch; no pane begins while a kill is in flight or
// after a newer quit; at most one slot holder; an interrupt never acts after a newer launch.
func TestOwnerInterleavings(t *testing.T) {
	runs, skipped := 0, 0
	interleavings([]int{4, 9, 4}, func(order []int) {
		o := &owner{stops: map[string]*turnStop{}, slots: map[string]*sessionSlot{}}
		o.paneFree = sync.NewCond(&o.mu)
		m := &ownerModel{t: t, o: o}
		chains := [][]func() error{m.launchSteps(), m.quitSteps(), m.interruptSteps()}
		names := []string{"L", "Q", "I"}
		next := make([]int, len(chains))
		for _, c := range order {
			m.path = append(m.path, fmt.Sprintf("%s%d", names[c], next[c]+1))
			if err := chains[c][next[c]](); err == errWait {
				skipped++
				return
			}
			next[c]++
		}
		runs++
	})
	if runs == 0 {
		t.Fatal("no ordering ran")
	}
	t.Logf("%d orderings ran, %d can't happen", runs, skipped)
}

// beginKill under own is a launch's kill of its own pane: only while its generation is still current, and never once a
// newer launch or quit took the agent. Without own, only a newer launch refuses it.
func TestOwnerKillOwn(t *testing.T) {
	o := &owner{stops: map[string]*turnStop{}, slots: map[string]*sessionSlot{}}
	o.paneFree = sync.NewCond(&o.mu)
	l := o.beginLaunch()
	if !o.beginKill(l, true) {
		t.Fatal("a current launch can't kill its own pane")
	}
	o.endKill()
	q := o.invalidate()
	if o.beginKill(l, true) {
		t.Error("a launch a quit superseded killed its own pane")
	}
	if !o.beginKill(l, false) {
		t.Error("a kill under an older launch's generation, with no newer launch, was refused")
	}
	o.endKill()
	o.beginLaunch()
	if o.beginKill(q, false) || o.beginKill(q, true) {
		t.Error("a kill older than the latest launch began")
	}
	if o.kills != 0 {
		t.Errorf("%d kills in flight", o.kills)
	}
}
