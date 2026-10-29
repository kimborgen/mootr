package server

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
)

// An archived or forgotten agent's ITSAs off the ITSA home (src/itsa-owners.ts queueUnown, sendUnown, retryPendingUnowns):
// the unown is written first (itsa_pending_unown, with an archive's lifecycle change), then sent to the home, and the row
// stays until the home acknowledges it. A row the home hasn't taken is sent again every retry interval, backing off per
// agent, until it does, its agent runs again, or the home refuses it for good.

// unownRetry is the retry's state: one pass at a time, and per agent the failures in a row and when to try again, and the
// agents whose unown is being queued, sent or retried right now (inFlight): one claim per agent at a time. In memory
// only; a restart tries at once.
type unownRetry struct {
	mu       sync.Mutex
	retrying bool
	backoff  map[string]switchBackoff
	inFlight map[string]bool
	// freed is signalled under mu when a claim ends.
	freed *sync.Cond
	// queued, for a test, runs between an unown's queue and its send; claimed, when a retry pass has claimed an agent.
	queued  func()
	claimed func(agentID string)
}

// claim marks agentID's unown in flight, exclusive either way: a retry pass (only) skips an agent already claimed, and
// an unown waits for the claim before it to end, so neither judges or drops the other's row mid-way. The release it
// returns ends the claim.
func (u *unownRetry) claim(agentID string, only bool) (release func(), ok bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.freed == nil {
		u.freed = sync.NewCond(&u.mu)
	}
	for u.inFlight[agentID] {
		if only {
			return nil, false
		}
		u.freed.Wait()
	}
	if u.inFlight == nil {
		u.inFlight = map[string]bool{}
	}
	u.inFlight[agentID] = true
	return func() {
		u.mu.Lock()
		defer u.mu.Unlock()
		delete(u.inFlight, agentID)
		u.freed.Broadcast()
	}, true
}

// unownViaHome is src/itsa-owners.ts unownAgent off the home: the unown is queued, then sent, in flight from one to the
// other, so a retry pass can't take the forget's row for a refused one and drop it in between. A failure leaves the row
// for the retry and is returned, so a forget waits for the home.
func (s *Server) unownViaHome(ctx context.Context, a db.Agent, how string) error {
	release, _ := s.unowns.claim(a.ID, false)
	defer release()
	if err := s.db.QueueUnown(ctx, a.ID, a.Name, how, a.Type); err != nil {
		return err
	}
	if s.unowns.queued != nil {
		s.unowns.queued()
	}
	return s.sendUnown(ctx, a.ID)
}

// sendUnown is src/itsa-owners.ts sendUnown: the home is told (15 s), and only the row this call read is deleted once it
// answers, so a retry and a new request can't remove each other's. The type is the one queued: a forgotten agent's row
// is gone by the time a retry sends it. No row is an error, never a send that went through.
func (s *Server) sendUnown(ctx context.Context, agentID string) error {
	rows, err := s.db.PendingUnowns(ctx, agentID)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return errors.New("no unown of " + agentID + " is queued for the ITSA home")
	}
	row := rows[0]
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("id", jsfmt.StringValue(row.AgentID))
	body.Set("name", jsfmt.StringValue(row.Name))
	body.Set("how", jsfmt.StringValue(row.How))
	parent := jsfmt.Value{Kind: jsfmt.Null}
	if a, err := s.db.GetAgent(ctx, row.AgentID); err == nil && a.ParentID != nil {
		parent = jsfmt.StringValue(*a.ParentID)
	}
	body.Set("parent", parent)
	typ := jsfmt.Value{Kind: jsfmt.Null}
	if row.Type != nil {
		typ = jsfmt.StringValue(*row.Type)
	}
	body.Set("type", typ)
	if _, err := s.toHome(ctx, "POST", "/api/itsas/unown-agent", body, 15*time.Second, nil); err != nil {
		return err
	}
	return s.db.DonePendingUnown(ctx, row.AgentID, row.CreatedAt)
}

// dropPendingUnown is src/itsa-owners.ts dropPendingUnown: a resumed agent keeps its ITSAs, so its pending unown is void.
func (s *Server) dropPendingUnown(ctx context.Context, agentID string) error {
	u := &s.unowns
	u.mu.Lock()
	delete(u.backoff, agentID)
	u.mu.Unlock()
	return s.db.DropPendingUnown(ctx, agentID)
}

// retryPendingUnowns is src/itsa-owners.ts retryPendingUnowns: every pending unown is sent to the home, one pass at a
// time. A row whose agent runs again, is gone, or was to be forgotten but is still here (a refused forget) is dropped
// instead; a row the home refuses (403) is given up, once.
func (s *Server) retryPendingUnowns(ctx context.Context) {
	if s.isHome() {
		return
	}
	u := &s.unowns
	u.mu.Lock()
	if u.retrying {
		u.mu.Unlock()
		return
	}
	u.retrying = true
	u.mu.Unlock()
	defer func() { u.mu.Lock(); u.retrying = false; u.mu.Unlock() }()
	rows, err := s.db.PendingUnowns(ctx, "")
	if err != nil {
		slog.Error("ITSA owners: retry", "err", err)
		return
	}
	every := itsaRetryEvery(os.Getenv)
	for _, r := range rows {
		s.retryClaimed(ctx, r, every)
	}
}

// retryClaimed is retryUnown under its agent's claim, released even if the row's retry panics; an agent claimed by an
// unown under way is left to it.
func (s *Server) retryClaimed(ctx context.Context, r db.PendingUnown, every time.Duration) {
	release, ok := s.unowns.claim(r.AgentID, true)
	if !ok {
		return
	}
	defer release()
	if s.unowns.claimed != nil {
		s.unowns.claimed(r.AgentID)
	}
	// Read again under the claim: an unown that held it before may have sent and removed the row.
	rows, err := s.db.PendingUnowns(ctx, r.AgentID)
	if err != nil || len(rows) == 0 {
		return
	}
	s.retryUnown(ctx, rows[0], every)
}

// retryUnown is one row of a retry pass, with its agent's unown claimed: the row is dropped when its agent runs again, is
// gone, or was to be forgotten but is still here (a refused forget); else it is sent when its wait is over.
func (s *Server) retryUnown(ctx context.Context, r db.PendingUnown, every time.Duration) {
	u := &s.unowns
	a, err := s.db.GetAgent(ctx, r.AgentID)
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		return
	}
	if err != nil || a.Lifecycle == "active" || a.Lifecycle == "paused" || r.How == "forgotten" {
		if err := s.dropPendingUnown(ctx, r.AgentID); err != nil {
			slog.Error("ITSA owners: drop "+r.Name+"'s pending unown", "err", err)
		}
		return
	}
	u.mu.Lock()
	b, waiting := u.backoff[r.AgentID]
	u.mu.Unlock()
	if waiting && time.Now().Before(b.next) {
		return
	}
	err = s.sendUnown(ctx, r.AgentID)
	if isHomeRefusal(err) {
		// Asking again can't change a final refusal: give up on this row, once.
		slog.Error("ITSA owners: giving up on unowning "+r.Name+"'s ITSAs", "err", err)
		if err := s.dropPendingUnown(ctx, r.AgentID); err != nil {
			slog.Error("ITSA owners: drop "+r.Name+"'s pending unown", "err", err)
		}
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if err == nil {
		delete(u.backoff, r.AgentID)
		return
	}
	fails := b.fails + 1
	if u.backoff == nil {
		u.backoff = map[string]switchBackoff{}
	}
	u.backoff[r.AgentID] = switchBackoff{fails: fails, next: time.Now().Add(retryDelay(every, fails))}
	slog.Error("ITSA owners: still can't unown "+r.Name+"'s ITSAs", "try", fails, "err", err)
}

// StartPendingUnowns is src/itsa-owners.ts watchOwnerStops' part for unowns: the rows a restart left are sent at once, and
// again every retry interval (STAM_ITSA_RETRY_MS, 30 s) until ctx ends.
func (s *Server) StartPendingUnowns(ctx context.Context) {
	if s.life == nil {
		return
	}
	s.life.Go(func(lctx context.Context) {
		s.retryPendingUnowns(ctx)
		t := time.NewTicker(itsaRetryEvery(os.Getenv))
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-lctx.Done():
				return
			case <-t.C:
				s.retryPendingUnowns(ctx)
			}
		}
	})
}
