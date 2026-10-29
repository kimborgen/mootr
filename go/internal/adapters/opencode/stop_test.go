package opencode

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// turnFake is a server's session states for the stop's calls: which sessions are active, whether an interrupt stops
// them (stubborn: it doesn't), whether the active list can be read (broken: a 500), and the interrupts each got.
type turnFake struct {
	mu         sync.Mutex
	active     map[string]bool
	stubborn   bool
	broken     bool
	interrupts map[string]int
	// odd, when set, is the active list's whole answer; "EMPTY" is an empty body.
	odd string
}

func newTurnFake(t *testing.T, active ...string) (*Server, *turnFake) {
	t.Helper()
	f := &turnFake{active: map[string]bool{}, interrupts: map[string]int{}}
	for _, sid := range active {
		f.active[sid] = true
	}
	s := testServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.URL.Path == "/api/session/active" && f.broken:
			w.WriteHeader(500)
			fmt.Fprint(w, `{"name":"UnknownError","data":{"message":"sk-or-v1-leak"}}`)
		case r.URL.Path == "/api/session/active" && f.odd == "EMPTY":
		case r.URL.Path == "/api/session/active" && f.odd != "":
			fmt.Fprint(w, f.odd)
		case r.URL.Path == "/api/session/active":
			fmt.Fprint(w, `{"data":{`)
			sep := ""
			for sid := range f.active {
				fmt.Fprintf(w, `%s%q:{"type":"busy"}`, sep, sid)
				sep = ","
			}
			fmt.Fprint(w, `}}`)
		case r.Method == "POST" && len(r.URL.Path) > len("/api/session/") && r.URL.Path[len(r.URL.Path)-len("/interrupt"):] == "/interrupt":
			sid := r.URL.Path[len("/api/session/") : len(r.URL.Path)-len("/interrupt")]
			f.interrupts[sid]++
			if !f.stubborn {
				delete(f.active, sid)
			}
			fmt.Fprint(w, `{"data":{}}`)
		default:
			w.WriteHeader(404)
		}
	}))
	s.Sleep = func(ctx context.Context, d time.Duration) error { return ctx.Err() }
	return s, f
}

func (f *turnFake) set(fn func(f *turnFake)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func (f *turnFake) interruptsOf(sid string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.interrupts[sid]
}

// Active is whether the server lists the session; an unreadable list is an error, never "idle", and quotes nothing the
// server answered.
func TestActive(t *testing.T) {
	ctx := context.Background()
	s, f := newTurnFake(t, "ses_a")
	if on, err := s.Active(ctx, "ses_a"); err != nil || !on {
		t.Errorf("listed: %v %v", on, err)
	}
	if on, err := s.Active(ctx, "ses_b"); err != nil || on {
		t.Errorf("not listed: %v %v", on, err)
	}
	// The real server's answers: OpenCode 2.0.26's, recorded from a throwaway `opencode serve` with no session and with one
	// idle one, and its running entry as spikes/opencode/opencode.md records it. Its openapi schema requires data, an
	// object of SessionActive objects keyed ^ses, and nothing else.
	for _, c := range []struct {
		answer string
		on     bool
	}{{`{"data":{}}`, false}, {`{"data":{"ses_a":{"type":"running"}}}`, true}, {`{"data":{"ses_b":{"type":"running"}}}`, false}} {
		f.set(func(f *turnFake) { f.odd = c.answer })
		if on, err := s.Active(ctx, "ses_a"); err != nil || on != c.on {
			t.Errorf("%s: %v %v; want %v", c.answer, on, err, c.on)
		}
	}
	f.set(func(f *turnFake) { f.odd = "" })
	f.set(func(f *turnFake) { f.broken = true })
	if _, err := s.Active(ctx, "ses_a"); err == nil || err.Error() != "OpenCode GET /api/session/active: 500 Internal Server Error" {
		t.Errorf("unreadable: %v", err)
	}
	// An answer of another shape is no answer either, not an empty list.
	for _, odd := range []string{"EMPTY", `{}`, `{"ses_b":{"type":"busy"}}`, `{"data":null}`, `{"data":["ses_b"]}`, `{"data":"sk-or-v1-leak"}`,
		`{"data":{"ses_b":"busy"}}`, `{"data":{"ses_a":null}}`, `[]`, `null`, `7`, `not json sk-or-v1-leak`,
		`{"data":{"msg_x":{"type":"busy"}}}`, `{"data":{"ses_a":{"type":"busy"},"msg_x":{"type":"busy"}}}`} {
		f.set(func(f *turnFake) { f.broken = false; f.odd = odd })
		if _, err := s.Active(ctx, "ses_b"); err == nil || strings.Contains(err.Error(), "sk-or") {
			t.Errorf("%s: %v", odd, err)
		}
		if s.Interrupt(ctx, "ses_b") {
			t.Errorf("%s: the interrupt was confirmed", odd)
		}
	}
}

// InterruptSession interrupts until the server no longer lists the session, at most attempts times; a session it can't
// be asked about is never taken for stopped; keep false sends no more interrupts.
func TestInterruptSession(t *testing.T) {
	ctx := context.Background()
	t.Run("stops", func(t *testing.T) {
		s, f := newTurnFake(t, "ses_a")
		if !s.InterruptSession(ctx, "ses_a", StopAttempts, nil) || f.interruptsOf("ses_a") != 1 {
			t.Errorf("interrupts %d", f.interruptsOf("ses_a"))
		}
		if !s.Interrupt(ctx, "ses_idle") || f.interruptsOf("ses_idle") != 1 {
			t.Errorf("an idle session: not confirmed, or %d interrupts", f.interruptsOf("ses_idle"))
		}
	})
	t.Run("stubborn", func(t *testing.T) {
		s, f := newTurnFake(t, "ses_a")
		f.set(func(f *turnFake) { f.stubborn = true })
		if s.InterruptSession(ctx, "ses_a", StopAttempts, nil) || f.interruptsOf("ses_a") != StopAttempts {
			t.Errorf("confirmed, or %d interrupts; want %d", f.interruptsOf("ses_a"), StopAttempts)
		}
		if s.Interrupt(ctx, "ses_a") {
			t.Error("Interrupt confirmed a session still listed")
		}
	})
	t.Run("unreadable", func(t *testing.T) {
		s, f := newTurnFake(t, "ses_a")
		f.set(func(f *turnFake) { f.broken = true })
		if s.InterruptSession(ctx, "ses_a", 2, nil) || f.interruptsOf("ses_a") != 2 {
			t.Errorf("confirmed with no answer, or %d interrupts", f.interruptsOf("ses_a"))
		}
	})
	t.Run("kept", func(t *testing.T) {
		s, f := newTurnFake(t, "ses_a")
		f.set(func(f *turnFake) { f.stubborn = true })
		keep := func() bool { return f.interruptsOf("ses_a") < 2 }
		if s.InterruptSession(ctx, "ses_a", StopAttempts, keep) || f.interruptsOf("ses_a") != 2 {
			t.Errorf("kept: %d interrupts; want 2", f.interruptsOf("ses_a"))
		}
	})
	t.Run("ended", func(t *testing.T) {
		s, f := newTurnFake(t, "ses_a")
		f.set(func(f *turnFake) { f.stubborn = true })
		s.Sleep = nil
		ended, cancel := context.WithCancel(ctx)
		cancel()
		if s.InterruptSession(ended, "ses_a", StopAttempts, nil) {
			t.Error("an ended context confirmed the stop")
		}
	})
}
