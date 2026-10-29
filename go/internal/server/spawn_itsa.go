package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	neturl "net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// A spawn's ITSAs and a forgotten agent's (src/itsa-owners.ts, S-3732): the ITSA a spawn names (`itsa`), the ITSAs it
// joins (`participate`), the parent's open ITSA a spawn with a parent joins under settings.itsa.required, the incident
// mark an urgent incident spawn needs, and the unown before a forget. Off the ITSA home each is asked of the home
// (toHome), which checks the asking agent as it would here.

// itsaVia is src/peers.ts Via: the agent asking for a spawn, which may give the new agent only an ITSA it may change.
type itsaVia struct {
	agent string
	boss  bool
}

// spawnItsaErr is spawnAgentIn's catch around an ITSA step: a refusal is a 403, anything else a 400 with its message. A
// 501 stays one.
func spawnItsaErr(err error) error {
	var e *Error
	if errors.As(err, &e) && (e.Status == http.StatusForbidden || e.Status == http.StatusNotImplemented) {
		return e
	}
	return Errorf(http.StatusBadRequest, "%s", err.Error())
}

// ownedItsa is ownerBlock's answer: the ITSA's id and key, its owner as read, and the first-prompt block.
type ownedItsa struct {
	id, key, owner, block string
	// participant: a reviewer spawn, which joins the ITSA as a participant and leaves its owner (S-501).
	participant bool
}

// ownerBlock is src/itsa-owners.ts ownerBlock: the ITSA a spawn names and the block that tells the new owner what it owns
// (a participant's block for a reviewer, which takes part instead).
func (s *Server) ownerBlock(ctx context.Context, ref string, asParticipant bool) (ownedItsa, error) {
	var v jsfmt.Value
	if s.isHome() {
		x, err := s.mustItsa(ctx, ref)
		if err != nil {
			return ownedItsa{}, err
		}
		if v, err = s.itsaView(ctx, x); err != nil {
			return ownedItsa{}, err
		}
	} else {
		var err error
		if v, err = s.toHome(ctx, "GET", "/api/itsas/"+neturl.PathEscape(ref), nil, homeTimeout, nil); err != nil {
			return ownedItsa{}, err
		}
	}
	chain := ""
	if pc, _ := v.Get("parent_chain"); len(pc.Items) > 0 {
		parts := make([]string, 0, len(pc.Items))
		for _, p := range pc.Items {
			parts = append(parts, p.Text("key")+" "+p.Text("title")+" ("+p.Text("status")+")")
		}
		chain = "Parent chain: " + strings.Join(parts, " > ") + "\n"
	}
	links := ""
	if ls, _ := v.Get("links"); len(ls.Items) > 0 {
		parts := make([]string, 0, len(ls.Items))
		for _, l := range ls.Items {
			parts = append(parts, "- "+l.Text("system")+": "+l.Text("url"))
		}
		links = "Links:\n" + strings.Join(parts, "\n")
	}
	summary := "(none)"
	if sv, ok := v.Get("summary"); ok && sv.Kind != jsfmt.Null {
		summary = anyString(sv)
	}
	tpl := "itsa-owner"
	if asParticipant {
		tpl = "itsa-participant"
	}
	if s.tpl == nil {
		return ownedItsa{}, errors.New("the templates are not loaded in this server")
	}
	block, err := s.tpl.Render(tpl, map[string]string{"key": v.Text("key"), "title": v.Text("title"), "status": v.Text("status"), "chain": chain,
		"summary": summary, "body": v.Text("body"), "links": links}, "")
	if err != nil {
		return ownedItsa{}, err
	}
	return ownedItsa{id: v.Text("id"), key: v.Text("key"), owner: v.Text("owner"), block: block, participant: asParticipant}, nil
}

// mayAssign is src/itsa-owners.ts mayAssign: whether the agent asking for a spawn may give the new agent this ITSA (S-480),
// only one the ITSA lets change it. A 403 names who may.
func (s *Server) mayAssign(ctx context.Context, ref string, via *itsaVia) error {
	if via == nil || via.boss || !s.isHome() {
		return nil
	}
	x, err := s.mustItsa(ctx, ref)
	if err != nil {
		return err
	}
	ok, err := s.isMember(ctx, via.agent, x, !isOpenBoard(x.Text("kind")))
	if err != nil || ok {
		return err
	}
	msg, err := s.itsaRefusal(ctx, via.agent, x, "change")
	if err != nil {
		return err
	}
	return Errorf(http.StatusForbidden, "%s", msg)
}

// mayParticipate is src/itsa-owners.ts mayParticipate: whether the asking agent may add the new agent to each ITSA.
func (s *Server) mayParticipate(ctx context.Context, refs []string, via *itsaVia) error {
	for _, ref := range refs {
		if !s.isHome() {
			body := jsfmt.Value{Kind: jsfmt.Object}
			body.Set("itsa", jsfmt.StringValue(ref))
			if _, err := s.toHome(ctx, "POST", "/api/itsas/may-participate", body, homeTimeout, via); err != nil {
				return err
			}
			continue
		}
		if _, err := s.mustItsa(ctx, ref); err != nil {
			return err
		}
		if err := s.mayAssign(ctx, ref, via); err != nil {
			return err
		}
	}
	return nil
}

// assignOwner is src/itsa-owners.ts assignOwner: sets the owner ("" for none) and returns who owned it just before, as the
// write saw it. ifOwner, when set, makes it a compare-and-set in the write's transaction.
func (s *Server) assignOwner(ctx context.Context, ref, agentID, by string, ifOwner *string, via *itsaVia) (string, error) {
	if err := s.mayAssign(ctx, ref, via); err != nil {
		return "", err
	}
	f := jsfmt.Value{Kind: jsfmt.Object}
	f.Set("owner", strOrNull(agentID, agentID != ""))
	if ifOwner != nil {
		f.Set("ifOwner", strOrNull(*ifOwner, *ifOwner != ""))
	}
	var r jsfmt.Value
	if s.isHome() {
		out, err := s.setItsa(ctx, ref, f, by)
		if err != nil {
			return "", err
		}
		r = out.(jsfmt.Value)
	} else {
		// The home checks by against the asking agent (via), as mayAssign does here.
		f.Set("by", jsfmt.StringValue(by))
		var err error
		if r, err = s.toHome(ctx, "PATCH", "/api/itsas/"+neturl.PathEscape(ref), f, homeTimeout, via); err != nil {
			return "", err
		}
	}
	if ch, _ := r.Get("changes"); hasKey(ch, "owner") {
		o, _ := ch.Get("owner")
		return o.Text("from"), nil
	}
	x, _ := r.Get("itsa")
	return x.Text("owner"), nil
}

// restoreOwner is src/itsa-owners.ts restoreOwner: after a failed launch, gives the ITSA back to previous, but only while
// the agent that never ran still owns it.
func (s *Server) restoreOwner(ctx context.Context, ref, failed, previous, by string) (bool, error) {
	if _, err := s.assignOwner(ctx, ref, previous, by, &failed, nil); err != nil {
		if strings.Contains(err.Error(), "owner changed") {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// addParticipant is src/itsa.ts addParticipant: who joins the ITSA (a row that left is a member again), with a
// participants event when it was not one.
func (s *Server) addParticipant(ctx context.Context, ref, who, by string) (bool, error) {
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return false, err
	}
	added := false
	_, _, err = s.db.UpdateItsa(ctx, ref, actor, func(tx db.ItsaTx, cur jsfmt.Value) (db.ItsaUpdate, error) {
		before, err := tx.Participants(cur.Text("id"))
		if err != nil {
			return db.ItsaUpdate{}, err
		}
		u := db.ItsaUpdate{EnsureParticipant: who}
		if added = !contains(before, who); added {
			to := append(append([]string{}, before...), who)
			sort.Strings(to)
			u.Changes = []db.ItsaChange{{Field: "participants", From: strs(before), To: strs(to)}}
		}
		return u, nil
	})
	return added, asItsaErr(err)
}

// removeParticipant is src/itsa.ts removeParticipant: the undo of a join a failed spawn made (S-2441), that agent's row
// only, with an event when it removes one.
func (s *Server) removeParticipant(ctx context.Context, ref, who, by string) (bool, error) {
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return false, err
	}
	removed := false
	_, _, err = s.db.UpdateItsa(ctx, ref, actor, func(tx db.ItsaTx, cur jsfmt.Value) (db.ItsaUpdate, error) {
		before, err := tx.Participants(cur.Text("id"))
		if err != nil || !contains(before, who) {
			return db.ItsaUpdate{}, err
		}
		removed = true
		rest := make([]string, 0, len(before))
		for _, p := range before {
			if p != who {
				rest = append(rest, p)
			}
		}
		return db.ItsaUpdate{SetParticipants: true, Participants: rest, Changes: []db.ItsaChange{{Field: "participants", From: strs(before), To: strs(rest)}}}, nil
	})
	return removed, asItsaErr(err)
}

// leaveParticipant is src/itsa.ts leaveParticipant: ends who's part in the ITSA without removing its row, so spend and
// reviewer counts still attribute it (S-3015), with a participants event when it was a member.
func (s *Server) leaveParticipant(ctx context.Context, ref, who, by string) (bool, error) {
	actor, err := s.actorOf(ctx, by)
	if err != nil {
		return false, err
	}
	left := false
	_, _, err = s.db.UpdateItsa(ctx, ref, actor, func(tx db.ItsaTx, cur jsfmt.Value) (db.ItsaUpdate, error) {
		before, err := tx.Participants(cur.Text("id"))
		if err != nil || !contains(before, who) {
			return db.ItsaUpdate{}, err
		}
		left = true
		rest := make([]string, 0, len(before))
		for _, p := range before {
			if p != who {
				rest = append(rest, p)
			}
		}
		return db.ItsaUpdate{LeaveParticipant: who, Changes: []db.ItsaChange{{Field: "participants", From: strs(before), To: strs(rest)}}}, nil
	})
	return left, asItsaErr(err)
}

// releaseReviewer is src/itsa-owners.ts releaseReviewer with no scope: a reviewer leaves each ITSA it joined and doesn't
// own (a soft leave). It returns how many it left. The caller checks the agent is a reviewer.
func (s *Server) releaseReviewer(ctx context.Context, agentID, by string) (int, error) {
	ids, err := s.db.JoinedNotOwned(ctx, agentID)
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if _, err := s.leaveParticipant(ctx, id, agentID, by); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

// guardRefusal is src/itsa.ts GuardRefusal: a change a guard (the stage guard, the proposal gate) refused, unlike a
// failure to make it. It answers as its *Error.
type guardRefusal struct{ err *Error }

func (g *guardRefusal) Error() string { return g.err.Error() }
func (g *guardRefusal) Unwrap() error { return g.err }

// asGuard marks a guard's refusal.
func asGuard(err error) error {
	var e *Error
	if errors.As(err, &e) {
		return &guardRefusal{e}
	}
	return err
}

// joinItsa is src/itsa-owners.ts joinItsa: the new agent takes part in the ITSA, the owner unchanged.
func (s *Server) joinItsa(ctx context.Context, ref, agentID, by string, via *itsaVia) error {
	if err := s.mayAssign(ctx, ref, via); err != nil {
		return err
	}
	if !s.isHome() {
		_, err := s.toHome(ctx, "POST", "/api/itsas/join", homeJoin(ref, agentID, by), homeTimeout, via)
		return err
	}
	_, err := s.addParticipant(ctx, ref, agentID, by)
	return err
}

// homeJoin is the body of a join or leave asked of the home.
func homeJoin(ref, agentID, by string) jsfmt.Value {
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("itsa", jsfmt.StringValue(ref))
	body.Set("agent", jsfmt.StringValue(agentID))
	body.Set("by", jsfmt.StringValue(by))
	return body
}

// leaveItsa is src/itsa-owners.ts leaveItsa: undoes a join a failed spawn made.
func (s *Server) leaveItsa(ctx context.Context, ref, agentID, by string, via *itsaVia) error {
	if err := s.mayAssign(ctx, ref, via); err != nil {
		return err
	}
	if !s.isHome() {
		_, err := s.toHome(ctx, "POST", "/api/itsas/leave", homeJoin(ref, agentID, by), homeTimeout, via)
		return err
	}
	_, err := s.removeParticipant(ctx, ref, agentID, by)
	return err
}

// parentItsaFor is src/itsa-owners.ts parentItsaFor: the parent's most recently updated open ITSA that it owns, else the
// most recently updated open one it takes part in; ok is false when it has neither.
func (s *Server) parentItsaFor(ctx context.Context, parentID string) (jsfmt.Value, bool, error) {
	for _, f := range []db.ItsaFilter{{Owner: parentID}, {Participant: parentID}} {
		list, err := s.db.ListItsas(ctx, f)
		if err != nil {
			return jsfmt.Value{}, false, err
		}
		sort.SliceStable(list, func(i, j int) bool { return list[i].Text("updated_at") > list[j].Text("updated_at") })
		for _, x := range list {
			if !s.isClosedStatus(x.Text("status")) {
				return x, true, nil
			}
		}
	}
	return jsfmt.Value{}, false, nil
}

// joinParentItsa is src/itsa-owners.ts joinParentItsa (joinParentLocal on the home): the new agent joins its parent's
// open ITSA as a participant. It returns the key joined, "" when the parent has none or ITSAs aren't required.
func (s *Server) joinParentItsa(ctx context.Context, agentID, parentID, by string) (string, error) {
	if !s.isHome() {
		body := jsfmt.Value{Kind: jsfmt.Object}
		body.Set("agent", jsfmt.StringValue(agentID))
		body.Set("parent", jsfmt.StringValue(parentID))
		body.Set("by", jsfmt.StringValue(by))
		r, err := s.toHome(ctx, "POST", "/api/itsas/join-parent", body, homeTimeout, nil)
		if err != nil {
			return "", err
		}
		return r.Text("key"), nil
	}
	if !s.settings.Get().Itsa.Required {
		return "", nil
	}
	x, ok, err := s.parentItsaFor(ctx, parentID)
	if err != nil || !ok {
		return "", err
	}
	if _, err := s.addParticipant(ctx, x.Text("id"), agentID, by); err != nil {
		return "", err
	}
	return x.Text("key"), nil
}

// undoJoins is src/daemon.ts undoJoins: after a failed spawn, removes the rows it added on the ITSAs it joined or owned,
// and on the parent's ITSA it joined, once that join has settled, so the undo lands after it. A failed undo is logged,
// never returned.
func (s *Server) undoJoins(ctx context.Context, agentID string, refs []string, parentJoin func() string, by string, via *itsaVia) {
	undo := func(ref string, v *itsaVia) {
		if err := s.leaveItsa(ctx, ref, agentID, by, v); err != nil {
			slog.Error("ITSA "+ref+": couldn't undo the join of "+agentID, "err", err)
		}
	}
	for _, ref := range refs {
		undo(ref, via)
	}
	// The parent's join is made on the home, not as the asking agent, so its undo has no via either.
	if parentJoin == nil {
		return
	}
	if parentKey := parentJoin(); parentKey != "" {
		undo(parentKey, nil)
	}
}

// incidentRefusal is src/developer-cap.ts incidentRefusal for an urgent incident spawn.
const incidentRefusal = "urgent: incident needs an ITSA, or one of its parents, that the chief of staff or the human has marked as an incident; no mark was found, or the ITSA home did not answer yes, so this spawn is refused. Use urgent red-main, deploy-hold or approved-pr, or ask the chief of staff."

// incidentMarked is src/itsa-owners.ts incidentMarked: whether the ITSA a spawn names, or an ancestor, carries the
// incident mark; read here on the home, else asked of the home (S-2421), where only a 200 with marked true is a yes.
func (s *Server) incidentMarked(ctx context.Context, ref string) bool {
	if ref == "" {
		return false
	}
	if home := s.settings.Get().Itsa.Home; home == "" || home == s.cfg.Machine {
		return s.incidentMarkedHere(ctx, ref)
	}
	p, ok := s.homePeer()
	if !ok || s.peers == nil {
		return false
	}
	r, err := s.peers.Call(ctx, p, "GET", "/api/itsas/incident-marked?itsa="+neturl.QueryEscape(ref), nil, 5*time.Second, false, nil)
	if err != nil || r.Status != http.StatusOK {
		return false
	}
	m, ok := r.Data.Get("marked")
	return ok && m.Kind == jsfmt.Bool && m.Bool
}

// spawnNames is src/daemon.ts NAMES: the names a nameless spawn takes, in order.
var spawnNames = strings.Fields("otter heron lynx wren fox badger hare kestrel marten finch puffin raven seal stoat swift vole crane ibis lark newt orca owl pika robin tern yak")

// freeName is src/daemon.ts freeName: the first of spawnNames no agent has and no queued spawn waits or launches under,
// then NAME-2, NAME-3 and on.
func (s *Server) freeName(ctx context.Context) (string, error) {
	agents, err := s.db.ListAgents(ctx)
	if err != nil {
		return "", err
	}
	taken := make(map[string]bool, len(agents))
	for _, a := range agents {
		taken[a.Name] = true
	}
	s.devSlots.mu.Lock()
	for _, w := range s.devSlots.q.waiting {
		taken[w.Name] = true
	}
	for n := range s.devSlots.q.launching {
		taken[n] = true
	}
	s.devSlots.mu.Unlock()
	for _, n := range spawnNames {
		if !taken[n] {
			return n, nil
		}
	}
	for i := 2; ; i++ {
		for _, n := range spawnNames {
			if name := n + "-" + strconv.Itoa(i); !taken[name] {
				return name, nil
			}
		}
	}
}

// unowning serializes the unowns: TS chains each agent's on the one before, so a second never reads ITSAs the first is
// still handing off.
var unowning sync.Mutex

// unownAgent is src/itsa-owners.ts unownAgent on the home (unownLocal), the lifecycle's hook before a forget: each ITSA
// the agent owns passes to its heir (its parent if live, else the nearest live ancestor, else the chief of staff) with
// its status kept, a handoff event and a notice to the heir for the active ones. With no heir an ITSA becomes unowned and
// an active one goes back to ready; the parent ITSAs' owners hear it once. Off the home the unown is queued and sent to
// the home (unownViaHome); until the home takes it, a forget is refused.
func (s *Server) unownAgent(ctx context.Context, a db.Agent, how string) error {
	if !s.isHome() {
		return s.unownViaHome(ctx, a, how)
	}
	unowning.Lock()
	defer unowning.Unlock()
	ready := ""
	for _, st := range s.itsaStatuses() {
		if st.Name == "ready" {
			ready = st.Name
			break
		}
	}
	if ready == "" {
		for _, st := range s.itsaStatuses() {
			if st.Category == "ready" {
				ready = st.Name
				break
			}
		}
	}
	heir, err := s.heir(ctx, a)
	if err != nil {
		return err
	}
	owned, err := s.db.ListItsas(ctx, db.ItsaFilter{Owner: a.ID})
	if err != nil {
		return err
	}
	var changed []jsfmt.Value
	var givenOrder []string
	given := map[string][]jsfmt.Value{}
	for _, x := range owned {
		st, _ := s.statusOf(x.Text("status"))
		active, open := st.Category == "active", st.Category != "closed"
		tries := []*heirAgent{nil}
		if heir != nil && open {
			tries = []*heirAgent{heir, nil}
		}
		for _, to := range tries {
			f := jsfmt.Value{Kind: jsfmt.Object}
			if to != nil {
				f.Set("owner", jsfmt.StringValue(to.id))
			} else {
				f.Set("owner", jsfmt.Value{Kind: jsfmt.Null})
			}
			f.Set("ifOwner", jsfmt.StringValue(a.ID))
			if to == nil && active && ready != "" {
				f.Set("status", jsfmt.StringValue(ready))
			}
			if _, err := s.setItsa(ctx, x.Text("id"), f, a.ID); err != nil {
				if strings.Contains(err.Error(), "owner changed") {
					break
				}
				if to != nil {
					slog.Error("ITSA owners: couldn't hand "+x.Text("key")+" to "+to.name+", unowning it", "err", err)
					continue
				}
				// A guard's refusal skips this ITSA, so the agent's others still get unowned; any other failure keeps the agent.
				var g *guardRefusal
				if !errors.As(err, &g) {
					return err
				}
				slog.Error("ITSA owners: couldn't unown "+x.Text("key"), "err", err)
				break
			}
			if !open {
				break
			}
			if to != nil {
				if _, err := s.addParticipant(ctx, x.Text("id"), to.id, a.ID); err != nil {
					slog.Error("ITSA owners: couldn't add "+to.name+" to "+x.Text("key"), "err", err)
				}
				if err := s.db.AddItsaEvent(ctx, x.Text("id"), a.ID, "handoff", jsfmt.StringValue("Owner @"+a.Name+" "+how+"; ownership passed to @"+to.name+".")); err != nil {
					slog.Error("ITSA owners: handoff event on "+x.Text("key"), "err", err)
				}
				if active {
					if _, ok := given[to.id]; !ok {
						givenOrder = append(givenOrder, to.id)
					}
					given[to.id] = append(given[to.id], x)
				}
			} else {
				changed = append(changed, x)
			}
			break
		}
	}
	// S-3015: a reviewer that is unowned leaves its ITSAs too. A failure is logged, and the unown above stands.
	if a.Type != nil && s.isReviewerType(*a.Type) {
		if _, err := s.releaseReviewer(ctx, a.ID, a.ID); err != nil {
			slog.Error("ITSA owners: couldn't take "+a.Name+" out of its ITSAs", "err", err)
		}
	}
	for _, id := range givenOrder {
		if s.tpl == nil {
			break
		}
		text, err := s.tpl.Render("itsa-owner-handoff", map[string]string{"what": a.Name + " was " + how, "list": itsaList(given[id])}, "")
		if err == nil {
			_, err = s.tellWhere(ctx, id, text, "")
		}
		if err != nil {
			slog.Error("ITSA owners: handoff notice to "+id, "err", err)
		}
	}
	if len(changed) > 0 {
		return s.stoppedOnly(ctx, a.ID, a.Name, "was "+how+", so its ITSAs are now unowned", changed)
	}
	return nil
}

// itsaList is `KEY "title" (status)` for each, comma-separated, as the owner notices list ITSAs.
func itsaList(list []jsfmt.Value) string {
	parts := make([]string, 0, len(list))
	for _, k := range list {
		parts = append(parts, k.Text("key")+` "`+k.Text("title")+`" (`+k.Text("status")+`)`)
	}
	return strings.Join(parts, ", ")
}

type heirAgent struct{ id, name string }

// heir is src/itsa-owners.ts heir: who takes over an agent's ITSAs, its parent if live (not archived), else the nearest
// live ancestor, else the chief of staff. Nil when none is live, and also when a peer that may hold one didn't answer, so
// a briefly down machine isn't passed over.
func (s *Server) heir(ctx context.Context, a db.Agent) (*heirAgent, error) {
	type found struct {
		id, name, lifecycle, parent string
	}
	// lookup is the agent here or on a peer; unreachable when a peer that may hold it didn't answer.
	lookup := func(ref string) (f found, absent, unreachable bool, err error) {
		if x, err := s.db.GetAgent(ctx, ref); err == nil {
			parent := ""
			if x.ParentID != nil {
				parent = *x.ParentID
			}
			return found{x.ID, x.Name, string(x.Lifecycle), parent}, false, false, nil
		} else if !errors.Is(err, db.ErrNotFound) {
			return f, false, false, err
		}
		if s.peers == nil {
			return f, true, false, nil
		}
		hit, located, err := s.peers.Locate(ctx, s.db, ref)
		switch {
		case err != nil:
			return f, false, true, nil
		case located == peers.Unreachable:
			return f, false, true, nil
		case located != peers.Found || hit == nil:
			return f, true, false, nil
		}
		return found{hit.Agent.ID, hit.Agent.Name, hit.Agent.Lifecycle, hit.Agent.Raw.Text("parent_id")}, false, false, nil
	}
	seen := map[string]bool{a.ID: true}
	next := ""
	if a.ParentID != nil {
		next = *a.ParentID
	}
	for next != "" && !seen[next] {
		seen[next] = true
		f, absent, unreachable, err := lookup(next)
		if err != nil || unreachable {
			return nil, err
		}
		if absent {
			break
		}
		if f.lifecycle != "archived" {
			return &heirAgent{f.id, f.name}, nil
		}
		next = f.parent
	}
	cos := s.settings.Get().ChiefOfStaff
	if cos == "" {
		return nil, nil
	}
	f, absent, unreachable, err := lookup(cos)
	if err != nil || absent || unreachable || f.lifecycle == "archived" || seen[f.id] {
		return nil, err
	}
	return &heirAgent{f.id, f.name}, nil
}

// isReviewerType is src/agent-types.ts isReviewerType: a type with a truthy `review`.
func (s *Server) isReviewerType(name string) bool {
	if s.tpl == nil {
		return false
	}
	all, err := s.tpl.Types()
	return err == nil && all[name].Review
}
