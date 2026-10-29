package server

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The notices to a parent ITSA's owner (src/itsa-owners.ts, S-2848 B2c): a child ITSA that is blocked, waits on the
// human, or closed tells its parent's owner; an owner that was shut down or errored tells the owner of each parent of
// the ITSAs it holds. The owner is told here, or on the daemon that holds it (tellWhere).

// parentOwner is src/itsa-owners.ts parentOwner: the agent that hears about child, the owner of its parent ITSA when
// that is an agent running here or on a peer. The human and nobody hear nothing here.
func (s *Server) parentOwner(ctx context.Context, child jsfmt.Value) (string, jsfmt.Value, bool) {
	parentID := child.Text("parent_id")
	if !s.settings.Get().Itsa.OwnerNotices || parentID == "" {
		return "", jsfmt.Value{}, false
	}
	parent, found, err := s.db.FindItsa(ctx, parentID)
	owner := parent.Text("owner")
	if err != nil || !found || owner == "" || owner == humanBox {
		return "", jsfmt.Value{}, false
	}
	running := func(life string) bool { return life == "active" || life == "paused" }
	a, err := s.db.GetAgent(ctx, owner)
	switch {
	case err == nil:
		return a.ID, parent, running(string(a.Lifecycle))
	case !errors.Is(err, db.ErrNotFound):
		return "", jsfmt.Value{}, false
	}
	hit, located, err := s.peers.Locate(ctx, s.db, owner)
	if err != nil || located != peers.Found || hit == nil {
		return "", jsfmt.Value{}, false
	}
	return hit.Agent.ID, parent, running(hit.Agent.Lifecycle)
}

// ownerStatusNotice is src/itsa-owners.ts statusChanged, after an ITSA's status changed (or it was created): a child
// that is blocked, waits on the human, or closed tells its parent's owner, unless the owner made the change. Off the
// request, since the owner may be on a peer. It says whether a notice was started.
func (s *Server) ownerStatusNotice(ctx context.Context, x jsfmt.Value, actor string) bool {
	st, ok := s.statusOf(x.Text("status"))
	if !ok {
		return false
	}
	var why string
	switch {
	case st.Category == "closed":
		why = " (closed)"
	case st.Human:
		why = " (waits on the human)"
	case x.Text("status") == "blocked":
	default:
		return false
	}
	// As in TS, the settings are read at the change, before the lookup that may wait on a peer.
	if !s.settings.Get().Itsa.OwnerNotices || x.Text("parent_id") == "" {
		return false
	}
	tell := func(ctx context.Context) {
		if err := s.tellParentOwner(ctx, x, actor, why); err != nil {
			slog.Error("ITSA owners: notice for "+x.Text("key"), "err", err)
		}
	}
	// In the daemon's background work, so its shutdown waits for the notice.
	if s.life != nil {
		s.life.Go(tell)
		return true
	}
	go tell(context.WithoutCancel(ctx))
	return true
}

// tellParentOwner tells x's parent owner that x is now in its status, with why after it, unless the owner made the change.
func (s *Server) tellParentOwner(ctx context.Context, x jsfmt.Value, actor, why string) error {
	id, parent, ok := s.parentOwner(ctx, x)
	if !ok || id == actor || s.tpl == nil {
		return nil
	}
	text, err := s.tpl.Render("itsa-child-status", map[string]string{"key": x.Text("key"), "title": x.Text("title"), "parent": parent.Text("key"), "status": x.Text("status"), "why": why}, "")
	if err != nil {
		return err
	}
	_, err = s.tellWhere(ctx, id, text, "")
	return err
}

// ownerStopped is src/itsa-owners.ts reportStop, the lifecycle's hook for an agent here that stopped: on the ITSA home,
// the owner of each parent ITSA is told (stopped); elsewhere the home is asked to (POST /api/itsas/owner-stopped).
func (s *Server) ownerStopped(ctx context.Context, id, name, what string) {
	if s.isHome() {
		if err := s.stopped(ctx, id, name, what); err != nil {
			slog.Error("ITSA owners: report that "+name+" "+what, "err", err)
		}
		return
	}
	p, ok := s.homePeer()
	if !ok {
		slog.Error("ITSA owners: report that "+name+" "+what, "err", "the ITSA home '"+s.settings.Get().Itsa.Home+"' is not a configured peer")
		return
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("id", jsfmt.StringValue(id))
	body.Set("name", jsfmt.StringValue(name))
	body.Set("what", jsfmt.StringValue(what))
	r, err := s.peers.Call(ctx, p, "POST", "/api/itsas/owner-stopped", body, 8*time.Second, false, nil)
	switch {
	case err != nil:
		slog.Error("ITSA owners: report that "+name+" "+what, "err", err)
	case r.Status >= 300:
		slog.Error("ITSA owners: report that "+name+" "+what, "err", r.Data.Text("error"))
	}
}

// stopped is src/itsa-owners.ts stopped, on the home: tells the owner of each parent ITSA, once with all the children,
// that the owner of those open ITSAs stopped.
func (s *Server) stopped(ctx context.Context, id, name, what string) error {
	owned, err := s.db.ListItsas(ctx, db.ItsaFilter{Owner: id})
	if err != nil {
		return err
	}
	return s.stoppedOnly(ctx, id, name, what, owned)
}

// stoppedOnly is stopped about these ITSAs only (TS's `only`): the rows an unown changed, as they were before it.
func (s *Server) stoppedOnly(ctx context.Context, id, name, what string, owned []jsfmt.Value) error {
	type group struct {
		parent jsfmt.Value
		kids   []string
	}
	var order []string
	byOwner := map[string]*group{}
	for _, x := range owned {
		if st, ok := s.statusOf(x.Text("status")); ok && st.Category == "closed" {
			continue
		}
		to, parent, ok := s.parentOwner(ctx, x)
		if !ok || to == id {
			continue
		}
		g := byOwner[to]
		if g == nil {
			g = &group{parent: parent}
			byOwner[to] = g
			order = append(order, to)
		}
		g.kids = append(g.kids, x.Text("key")+` "`+x.Text("title")+`" (`+x.Text("status")+`)`)
	}
	if s.tpl == nil && len(order) > 0 {
		return errors.New("the templates are not loaded in this server")
	}
	for _, to := range order {
		g := byOwner[to]
		text, err := s.tpl.Render("itsa-owner-stopped", map[string]string{"what": name + " " + what, "parent": g.parent.Text("key"), "list": strings.Join(g.kids, ", ")}, "")
		if err != nil {
			return err
		}
		if _, err := s.tellWhere(ctx, to, text, ""); err != nil {
			return err
		}
	}
	return nil
}
