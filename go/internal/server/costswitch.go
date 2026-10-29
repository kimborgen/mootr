package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/peers"
)

// costSwitch is POST /api/cost/switch (src/daemon.ts): a manager (by) or the human moves an agent's work to another
// preset with a handover (lifecycle.StartSwitch). Refusals come back at once, a permission one as a 403 and any other
// as a 400; a working agent's switch goes on in the background after its soft stop, and its outcome reaches the
// manager. An agent of another machine is switched there (S-923): its stop, its successor and the move of its mail all
// happen on the daemon that runs it, which takes the manager from the forward.
func (s *Server) costSwitch(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	field := func(k string) string {
		v, _ := w.body.Get(k)
		if v == nil {
			return ""
		}
		return claude.JSString(v)
	}
	if ref := field("agent"); !c.Local && ref != "" && s.peers != nil {
		if _, err := s.db.GetAgent(ctx, ref); errors.Is(err, db.ErrNotFound) {
			if out, relayed, err := s.costSwitchOnPeer(ctx, c, w, ref); relayed || err != nil {
				return out, err
			}
		} else if err != nil {
			return nil, err
		}
	}
	var by string
	var remote *lifecycle.RemoteManager
	if v, _ := w.body.Get("by"); jsjson.Truthy(v) {
		ref := claude.JSString(v)
		if _, err := s.db.GetAgent(ctx, ref); errors.Is(err, db.ErrNotFound) {
			remote = s.remoteManager(ctx, c, ref)
		}
		if remote != nil {
			by = remote.Agent
		} else {
			a, err := s.mustAgent(ctx, ref)
			if err != nil {
				return nil, err
			}
			by = a.ID
		}
	} else if w.human {
		by = humanBox
	} else {
		return nil, Errorf(http.StatusForbidden, "cost_switch needs an agent (by) or the human")
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "cost switches aren't available on this daemon")
	}
	o := lifecycle.SwitchOptions{Agent: field("agent"), Preset: field("preset"), By: by, Remote: remote}
	if v, _ := w.body.Get("soft_stop_minutes"); v != nil {
		m := jsjson.ToNumber(v)
		o.SoftStopMinutes = &m
	}
	out, err := s.life.StartSwitch(ctx, o)
	if lifecycle.IsForbidden(err) {
		return nil, Errorf(http.StatusForbidden, "%s", err.Error())
	}
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	return out, nil
}

// costSwitchOnPeer is src/daemon.ts's relay of a cost_switch on another machine's agent to the daemon that runs it, as
// the manager the call names (via) or the human. relayed is false when no peer has the agent: the switch is then this
// daemon's, which answers "no agent". A peer that may hold it and doesn't answer is a 503 naming its machine.
func (s *Server) costSwitchOnPeer(ctx context.Context, c auth.Resolved, w write, ref string) (any, bool, error) {
	hit, found, err := s.peers.Locate(ctx, s.db, ref)
	if err != nil {
		return nil, false, ambiguous(err)
	}
	if found == peers.Absent {
		if hit, err = s.peers.LocateFresh(ctx, s.db, ref); err != nil {
			return nil, false, ambiguous(err)
		}
		if hit != nil {
			found = peers.Found
		}
	}
	if found == peers.Unreachable {
		machine := "another machine"
		if pa, ok, _ := s.db.FindPeerAgent(ctx, ref); ok {
			machine = pa.Machine
		}
		return nil, false, Errorf(http.StatusServiceUnavailable, "%s runs on %s, which doesn't answer, so it can't be switched now", ref, machine)
	}
	if found != peers.Found || hit == nil || hit.Peer == nil {
		return nil, false, nil
	}
	peer := *hit.Peer
	byV, _ := w.body.Get("by")
	by := ""
	if jsjson.Truthy(byV) {
		by = claude.JSString(byV)
	}
	if by == "" && s.strictRefuses("a cost_switch relayed to a peer with no by", !w.human && !(c.Local && c.Kind == auth.Shared) && c.Kind != auth.Agent) {
		return nil, false, Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), switches another machine's agent")
	}
	carry, err := s.relayHuman(peer, w.human, true, "POST /api/cost/switch", by == "" || by == humanName)
	if err != nil {
		return nil, false, err
	}
	box := ""
	if c.Kind == auth.OpenCode {
		box = by
	}
	reply, err := s.peers.Call(ctx, peer, http.MethodPost, "/api/cost/switch", forwardBody(w.body, nil), peers.RelayTimeout, carry, s.viaBox(ctx, c, box))
	if err != nil {
		return nil, false, Errorf(http.StatusServiceUnavailable, "%s is unreachable, so %s can't be switched now", peer.Name, ref)
	}
	if reply.Status >= 300 {
		msg := ownRefusal(reply.Status, reply.Data).Text("error")
		if msg == "" {
			msg = "HTTP " + strconv.Itoa(reply.Status)
		}
		return nil, false, Errorf(reply.Status, "%s", msg)
	}
	return reply.Data, true, nil
}

// remoteManager is src/daemon.ts remoteManager: a cost_switch manager that runs on another machine (S-923). Only a
// peer's forward names one (the peer token with x-stam-local and the agent header), it must be the agent the forward
// acts for, and a peer must answer for it with that id. It is a boss as this daemon's chief of staff by name, or as the
// assistant the peer vouches for; whether it may switch the agent is the lifecycle's call. nil for anyone else.
func (s *Server) remoteManager(ctx context.Context, c auth.Resolved, by string) *lifecycle.RemoteManager {
	if c.Verified != auth.Peer || !c.Local || c.Kind != auth.Agent || c.Caller.Agent != by || s.peers == nil {
		return nil
	}
	hit, found, err := s.peers.Locate(ctx, s.db, by)
	if err != nil || found != peers.Found || hit == nil || hit.Agent.ID != by {
		return nil
	}
	cos := s.settings.Get().ChiefOfStaff
	return &lifecycle.RemoteManager{Agent: by, Boss: (cos != "" && hit.Agent.Name == cos) || c.Caller.Assistant}
}

// switchedState is the hand-offs to the ITSA home still owed (src/itsa-owners.ts pendingSwitched and switchBackoff):
// predecessors whose hand-off failed, seeded from the events at start so a restart keeps them, and per predecessor its
// failures in a row and when to ask again, in memory only (a restart asks at once). Under mu.
type switchedState struct {
	mu       sync.Mutex
	pending  map[string]bool
	backoff  map[string]switchBackoff
	retrying bool
	// passes counts the retry passes that finished, for a test to wait on.
	passes int
}

type switchBackoff struct {
	fails int
	next  time.Time
}

// itsaRetryEvery is src/itsa-owners.ts's retry interval: STAM_ITSA_RETRY_MS (MOOTR_ first), else 30 s.
func itsaRetryEvery(getenv func(string) string) time.Duration {
	v := getenv("MOOTR_ITSA_RETRY_MS")
	if v == "" {
		v = getenv("STAM_ITSA_RETRY_MS")
	}
	if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && n > 0 {
		return time.Duration(n * float64(time.Millisecond))
	}
	return 30 * time.Second
}

// retryDelay is src/itsa-owners.ts retryDelay: the wait before the next try after fails failures in a row, doubling
// from every, at most an hour.
func retryDelay(every time.Duration, fails int) time.Duration {
	d := every
	for i := 1; i < fails && d < time.Hour; i++ {
		d *= 2
	}
	return min(d, time.Hour)
}

type itsaOwnerEvent struct {
	Step  string `json:"step"`
	To    string `json:"to"`
	Itsas int    `json:"itsas"`
}

type itsaOwnerFailedEvent struct {
	Step  string `json:"step"`
	To    string `json:"to"`
	Error string `json:"error"`
}

// handOffSwitchedItsas is src/itsa-owners.ts handOffSwitchedItsas, on the machine that ran the switch: the ITSA home is
// asked to pass the predecessor's open ITSAs to the successor (POST /api/itsas/switch-owner, 15 s). On the home the
// switch's own transaction did it. Soft: a home that is down or refuses is logged and leaves an event, never fails the
// switch; a refusal (403) is final, anything else is asked again by the retry loop. Messages carry no URL or token.
func (s *Server) handOffSwitchedItsas(ctx context.Context, from, to db.Agent) {
	home := s.settings.Get().Itsa.Home
	if home == "" || home == s.cfg.Machine {
		return
	}
	st := &s.switched
	moved, final, msg := 0, false, ""
	if p, ok := s.homePeer(); !ok {
		msg = "the ITSA home did not answer"
	} else {
		body := jsfmt.Value{Kind: jsfmt.Object}
		body.Set("from", jsfmt.StringValue(from.ID))
		body.Set("to", jsfmt.StringValue(to.ID))
		r, err := s.peers.Call(ctx, p, "POST", "/api/itsas/switch-owner", body, 15*time.Second, false, nil)
		switch {
		case err != nil:
			msg = "the ITSA home did not answer"
		case r.Status >= 300:
			why := r.Data.Text("error")
			if why == "" {
				why = strconv.Itoa(r.Status)
			}
			msg, final = "the ITSA home "+home+" refused: "+why, r.Status == http.StatusForbidden
		default:
			if list, ok := r.Data.Get("moved"); ok && list.Kind == jsfmt.Array {
				moved = len(list.Items)
			}
		}
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if msg == "" || final {
		delete(st.pending, from.ID)
		delete(st.backoff, from.ID)
		if msg == "" {
			s.addEvent(ctx, from.ID, "cost:switch", itsaOwnerEvent{Step: "itsa-owner", To: to.Name, Itsas: moved})
			return
		}
	}
	slog.Error("ITSA owners: couldn't move "+from.Name+"'s ITSAs to "+to.Name, "err", msg)
	if final {
		// The home's final answer: asking again can't change it. The event keeps a restart from seeding it again.
		s.addEvent(ctx, from.ID, "cost:switch", itsaOwnerFailedEvent{Step: "itsa-owner-refused", To: to.Name, Error: msg})
		return
	}
	// One event per outage: the retry loop doesn't write another while the home stays down.
	if !st.pending[from.ID] {
		s.addEvent(ctx, from.ID, "cost:switch", itsaOwnerFailedEvent{Step: "itsa-owner-failed", To: to.Name, Error: msg})
	}
	if st.pending == nil {
		st.pending, st.backoff = map[string]bool{}, map[string]switchBackoff{}
	}
	st.pending[from.ID] = true
	fails := st.backoff[from.ID].fails + 1
	st.backoff[from.ID] = switchBackoff{fails: fails, next: time.Now().Add(retryDelay(itsaRetryEvery(os.Getenv), fails))}
}

func (s *Server) addEvent(ctx context.Context, id, typ string, data any) {
	if err := s.db.AddEvent(context.WithoutCancel(ctx), id, typ, data); err != nil {
		slog.Error("event not recorded", "agent", id, "type", typ, "err", err)
	}
}

// seedSwitchedItsas is src/itsa-owners.ts seedSwitchedItsas: a predecessor whose latest hand-off event is a failure
// is still owed one.
func (s *Server) seedSwitchedItsas(ctx context.Context) {
	agents, err := s.db.ListAgents(ctx)
	if err != nil {
		slog.Error("ITSA owners: seed switched", "err", err)
		return
	}
	st := &s.switched
	for _, a := range agents {
		if a.ForwardedTo == nil || *a.ForwardedTo == "" {
			continue
		}
		events, err := s.db.ListEvents(ctx, a.ID, 500, "")
		if err != nil {
			continue
		}
		last := ""
		for _, e := range events {
			if e.Type == "cost:switch" && e.Data != nil && strings.Contains(*e.Data, `"step":"itsa-owner`) {
				last = *e.Data
			}
		}
		if strings.Contains(last, `"step":"itsa-owner-failed"`) {
			st.mu.Lock()
			if st.pending == nil {
				st.pending, st.backoff = map[string]bool{}, map[string]switchBackoff{}
			}
			st.pending[a.ID] = true
			st.mu.Unlock()
		}
	}
}

// retrySwitchedItsas is src/itsa-owners.ts retrySwitchedItsas: each owed hand-off whose wait is over is asked again
// (the home's move is idempotent); one whose predecessor or successor is gone is dropped. One pass at a time.
func (s *Server) retrySwitchedItsas(ctx context.Context) {
	st := &s.switched
	st.mu.Lock()
	if st.retrying {
		st.mu.Unlock()
		return
	}
	st.retrying = true
	ids := make([]string, 0, len(st.pending))
	for id := range st.pending {
		ids = append(ids, id)
	}
	st.mu.Unlock()
	defer func() {
		st.mu.Lock()
		st.retrying = false
		st.passes++
		st.mu.Unlock()
	}()
	for _, id := range ids {
		a, err := s.db.GetAgent(ctx, id)
		var succ db.Agent
		if err == nil && a.ForwardedTo != nil && *a.ForwardedTo != "" {
			succ, err = s.db.GetAgent(ctx, *a.ForwardedTo)
		} else if err == nil {
			err = db.ErrNotFound
		}
		st.mu.Lock()
		if err != nil {
			delete(st.pending, id)
			delete(st.backoff, id)
			st.mu.Unlock()
			continue
		}
		due := !time.Now().Before(st.backoff[id].next)
		st.mu.Unlock()
		if due {
			s.handOffSwitchedItsas(ctx, a, succ)
		}
	}
}

// StartSwitchedItsas is src/itsa-owners.ts watchOwnerStops' part for switches (S-3636): the hand-offs a restart left
// owed are seeded from the events, asked at once, and again every retry interval until ctx ends.
func (s *Server) StartSwitchedItsas(ctx context.Context) {
	if s.life == nil {
		return
	}
	s.life.Go(func(lctx context.Context) {
		s.seedSwitchedItsas(ctx)
		s.retrySwitchedItsas(ctx)
		t := time.NewTicker(itsaRetryEvery(os.Getenv))
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-lctx.Done():
				return
			case <-t.C:
				s.retrySwitchedItsas(ctx)
			}
		}
	})
}
