package server

import (
	"context"
	"errors"
	"net/http"

	"stam/internal/db"
	"stam/internal/peers"
)

// spawnParent is the parent a spawn names, here or on another machine (src/daemon.ts spawnAgent: ids are unique across
// machines). It is resolved before any workspace exists, so a parent nobody has leaves no worktree behind. A spawn relayed
// from a peer names the peer's agent as its parent (`by` or `parent`), which only the peer has.
//
// It fails closed: a read error here is that error, an ambiguous name a 409, and a parent that may sit on a peer that did
// not answer a 503, never a spawn with no parent.
func (s *Server) spawnParent(ctx context.Context, ref string) (id, name string, err error) {
	a, err := s.db.GetAgent(ctx, ref)
	switch {
	case err == nil:
		return a.ID, a.Name, nil
	case !errors.Is(err, db.ErrNotFound):
		return "", "", err
	}
	hit, found, err := s.peers.Locate(ctx, s.db, ref)
	switch {
	case err != nil:
		return "", "", ambiguous(err)
	case found == peers.Found && hit != nil:
		return hit.Agent.ID, hit.Agent.Name, nil
	case found == peers.Unreachable:
		return "", "", Errorf(http.StatusServiceUnavailable, "no agent %s here, and a peer that may have it is unreachable", ref)
	}
	return "", "", Errorf(http.StatusNotFound, "no agent %s", ref)
}
