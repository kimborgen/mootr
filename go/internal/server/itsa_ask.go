package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// What happens when an ITSA waits on the human (src/itsa-human.ts onStatus and askHuman, src/withdraw.ts; S-2849): an
// agent's or a script's move into a status flagged `human` adds the human as a participant and mails them once, in the
// ITSA's thread, saying what is asked; a move out of one settles the ask without them. The human's own moves send
// nothing. Left out without an error: the web push that closes the phones' notifications of a withdrawn ask, and the push
// into the human's open view. A withdrawal of mail held on a peer asks that peer (withdraw).

// askMail is the ask mail of an ITSA that entered a human status.
type askMail struct {
	sender, body, subject, replyTo string
	// shown is the ITSA text the ask shows and shownRev its revision (shownText); "" for a body too long to show.
	shown, shownRev string
	// stam is whether no agent asks, so stam asks in a stand-in's name (the mail is stam's own).
	stam bool
}

func isAskAgent(id string) bool { return id != "" && id != humanBox }

// latestMail is itsa-human.ts latestMail: the latest comment or update `who` left in the ITSA's thread since the status
// change `skip` changes back, or none.
func (s *Server) latestMail(ctx context.Context, x jsfmt.Value, who string, skip int) (jsfmt.Value, bool, error) {
	tid := x.Text("thread_id")
	if tid == "" {
		return jsfmt.Value{}, false, nil
	}
	mails, err := s.db.ThreadMail(ctx, tid, "")
	if err != nil {
		return jsfmt.Value{}, false, err
	}
	since, err := s.db.ItsaStatusSince(ctx, x.Text("id"), x.Text("created_at"), skip)
	if err != nil {
		return jsfmt.Value{}, false, err
	}
	for i := len(mails) - 1; i >= 0; i-- {
		m := mails[i]
		if k := m.Text("kind"); m.Text("from_id") == who && (k == "comment" || k == "update") && m.Text("created_at") >= since {
			return m, true, nil
		}
	}
	return jsfmt.Value{}, false, nil
}

// askFor is the mail itsa-human.ts askHuman sends for the ITSA x, which entered its status by `actor`'s move; nil when the
// status does not wait on the human or no agent can send it. skip says how many status changes back the owner's comment is
// looked for (the change before the latest, once the move is written).
func (s *Server) askFor(ctx context.Context, x jsfmt.Value, actor string, skip int) (*askMail, error) {
	st, ok := s.statusOf(x.Text("status"))
	if !ok || !st.Human {
		return nil, nil
	}
	owner := x.Text("owner")
	sender := ""
	switch {
	case isAskAgent(actor):
		sender = actor
	case isAskAgent(owner):
		sender = owner
	default:
		id, found, err := s.db.FirstActiveAgentID(ctx)
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, nil
		}
		sender = id
	}
	var labels []string
	for _, a := range s.actionsOf(x.Text("status")) {
		labels = append(labels, a.Label)
	}
	actions := "reply here"
	if len(labels) > 0 {
		actions = strings.Join(labels, ", ")
	}
	repeated, has, err := s.latestMail(ctx, x, sender, skip)
	if err != nil {
		return nil, err
	}
	stam := !isAskAgent(actor) && !isAskAgent(owner)
	asker := "stam"
	if !stam {
		asker = s.agentLabel(ctx, sender)
	}
	latest := "The owner left no comment."
	if has {
		latest = db.JSTrim(repeated.Text("body"))
	}
	if s.tpl == nil {
		return nil, Errorf(http.StatusNotImplemented, "the templates the ask is written from are not loaded in this server")
	}
	body, err := s.tpl.Render("itsa-human", map[string]string{
		"asker": asker, "key": x.Text("key"), "title": escHTML(x.Text("title")), "status": strings.ReplaceAll(x.Text("status"), "_", " "),
		"latest": latest, "actions": actions,
	}, "")
	if err != nil {
		return nil, err
	}
	// The ask shows the text it asks about, from this snapshot, and records its revision (S-2998). It comes first, so no
	// markup in the owner's comment can hide it, and the title is escaped.
	shown, rev := shownText(x)
	body = shown + "\n\n" + body
	a := &askMail{sender: sender, body: body, subject: x.Text("key") + " " + x.Text("title"), stam: stam, shown: shown, shownRev: rev}
	if has {
		a.replyTo = repeated.Text("id")
	}
	return a, nil
}

// askRefusal answers 501 for the ask a move would send, before the move is written: the checks the ask's send makes of what
// this daemon does not carry. A move that sends none, or the human's, passes.
func (s *Server) askRefusal(ctx context.Context, cur jsfmt.Value, newStatus, newOwner, actor string) error {
	next := cur
	next.Set("status", jsfmt.StringValue(newStatus))
	if newOwner != "" {
		next.Set("owner", jsfmt.StringValue(newOwner))
	} else {
		next.Set("owner", jsfmt.NullValue())
	}
	// The change before the latest, once the move is written, is the latest one before it.
	a, err := s.askFor(ctx, next, actor, 0)
	if err != nil || a == nil {
		return err
	}
	// The move's actor was resolved before the transaction; a peer's agent is looked up there, and that lookup writes, so it isn't
	// asked again inside the transaction (S-4178).
	if !strings.HasPrefix(a.sender, "system:") && a.sender != actor {
		if _, err := s.person(ctx, jsfmt.StringValue(a.sender), true); err != nil {
			return err
		}
	}
	// The ask is routed as its send will route it: by the ITSA's owner as the move leaves it (S-4163), not as it is now.
	if err := embedRefusal(a.body); err != nil {
		return err
	}
	if a.stam {
		return nil
	}
	// The owner the move leaves must be the one the relayed route was read for (S-4178): an owner set since aborts the move.
	if facts := relayRouteFrom(ctx); facts != nil && facts.routed && next.Text("owner") != facts.owner {
		return itsaErr("the owner changed: %s is owned by %s now, not %s as the move was routed; set it again", cur.Text("key"), next.Text("owner"), facts.owner)
	}
	direct, err := s.askDirect(ctx, a.sender, cur.Text("id"), cur.Text("thread_id"), next.Text("owner"), relayRouteFrom(ctx))
	if err != nil {
		return err
	}
	return s.humanRefusals(ctx, a.sender, "ask", "", direct)
}

// relayRouteKey is the context key of the routing facts a peer attached to a move it relayed (S-4178).
type relayRouteKey struct{}

// withRelayRoute carries the facts of a relayed move on ctx: the ask the move sends is routed by them (askRefusal, askHuman).
func withRelayRoute(ctx context.Context, facts *relayRouteFacts) context.Context {
	return context.WithValue(ctx, relayRouteKey{}, facts)
}

// relayRouteFrom is the routing facts of the relayed move ctx carries, or nil for a move no peer relayed (main's delivery).
func relayRouteFrom(ctx context.Context) *relayRouteFacts {
	facts, _ := ctx.Value(relayRouteKey{}).(*relayRouteFacts)
	return facts
}

// askDirect is whether an ask an agent sends for an ITSA reaches the human directly, as sendNotPorted would route it, once the
// move leaves the ITSA owned by owner. The human joins the ITSA for the ask (askHuman), so only the owner rule and the parent reroute are left to check.
// relay is the facts of a move a peer relayed, for a sender with no row here (relayedAskDirect).
func (s *Server) askDirect(ctx context.Context, sender, itsaID, thread, owner string, relay *relayRouteFacts) (bool, error) {
	a, err := s.db.GetAgent(ctx, sender)
	if errors.Is(err, db.ErrNotFound) {
		return s.relayedAskDirect(ctx, sender, itsaID, thread, owner, relay)
	}
	if err != nil {
		return false, err
	}
	if humanExempt(a, s.chiefOfStaffID(ctx)) {
		return true, nil
	}
	if itsaID != "" {
		own, err := s.askOwns(ctx, a.ID, string(a.Lifecycle), itsaID, thread, owner)
		if err != nil || own {
			return own, err
		}
	}
	// Not the owner: the mail goes direct when there is no parent to reroute it to, as humanReroute sends it.
	_, rerouted, err := s.parentReroute(ctx, a, s.chiefOfStaffID(ctx))
	return !rerouted, err
}

// relayedAskDirect is humanRerouteTo (src/mail.ts) for an ask whose sender is a peer's agent (S-4178): direct for an exempt
// sender or the ITSA's owner as the move leaves it, and with no facts (an older peer) as on main. Anyone else reroutes to the
// parent its daemon named, and is refused before the move when that parent can't be reached.
func (s *Server) relayedAskDirect(ctx context.Context, sender, itsaID, thread, owner string, relay *relayRouteFacts) (bool, error) {
	if relay == nil || relay.exempt {
		return true, nil
	}
	lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, sender)
	if err != nil {
		return false, err
	}
	if itsaID != "" {
		own, err := s.askOwns(ctx, sender, lifecycle, itsaID, thread, owner)
		if err != nil || own {
			return own, err
		}
	}
	// A parent on this daemon is checked here, as it is now, so a stale pre-transaction answer can't refuse or allow it. One on a
	// peer was resolved before the transaction (setItsaMode), and its remembered lifecycle is checked again here: a change since
	// aborts the move, since no peer lookup can run inside the transaction.
	if a, err := s.db.GetAgent(ctx, relay.parent); err == nil && a.Lifecycle != "archived" {
		return false, nil
	} else if err != nil && !errors.Is(err, db.ErrNotFound) {
		return false, err
	}
	if !relay.parentFound {
		return false, refused("%s can't mail your user through this ITSA, and its parent can't be reached from here. Mail its parent instead; it decides what reaches your user.", sender)
	}
	// As the route read it (TS peerAgentLifecycle ?? the snapshot): a parent with no remembered lifecycle is unchanged.
	now, known, err := s.db.PeerAgentLifecycle(ctx, relay.parent)
	if err != nil {
		return false, err
	}
	if !known {
		now = relay.parentLife
	}
	if now != relay.parentLife {
		return false, itsaErr("the parent changed: the ask of %s reroutes to %s, which changed since it was routed; set it again", itsaID, relay.parent)
	}
	return false, nil
}

// askOwns is ownsItsaWithHuman (send.go) for an ask whose move leaves ITSA itsaID owned by owner: the sender owns that ITSA as the
// move leaves it, and owns every other ITSA the thread holds too, as the send checks them (mail.ts inOwnItsa). The human joins the
// ITSA for the ask, so it isn't checked here.
func (s *Server) askOwns(ctx context.Context, sender, lifecycle, itsaID, thread, owner string) (bool, error) {
	if owner != sender || lifecycle == "archived" {
		return false, nil
	}
	if thread == "" {
		return true, nil
	}
	ids, err := s.db.ThreadItsaIDs(ctx, thread)
	if err != nil {
		return false, err
	}
	var others []string
	for _, id := range ids {
		if id != itsaID {
			others = append(others, id)
		}
	}
	if len(others) == 0 {
		return true, nil
	}
	return s.ownsItsaWithHuman(ctx, sender, lifecycle, others)
}

// onStatus is itsa-human.ts onStatus, run after a change of status is written: an agent's move out of a human status settles
// the human's ask, and a move into one mails the ask. Errors are logged, never returned into the move that caused them.
func (s *Server) onStatus(ctx context.Context, x jsfmt.Value, actor, from string) {
	status := x.Text("status")
	if actor == humanBox || from == status {
		return
	}
	if fs, ok := s.statusOf(from); ok && fs.Human {
		if id, found, err := s.db.LastAsk(ctx, x.Text("id")); err != nil {
			slog.Error("ITSA human: last ask", "itsa", x.Text("key"), "err", err)
		} else if found {
			to, _ := s.statusOf(status)
			note := "@" + s.agentLabel(ctx, actor) + " moved " + x.Text("key") + " to " + status
			if err := s.withdrawFromHuman(ctx, []string{id}, actor, note, to.Human); err != nil {
				slog.Error("withdraw: "+note, "err", err)
			}
		}
	}
	if err := s.askHuman(ctx, x, actor); err != nil {
		slog.Error("ITSA human: mail for "+x.Text("key"), "err", err)
		// An ask refused after the move committed is recorded on the ITSA, so the stuck ask can be seen (S-4178).
		data := jsfmt.Value{Kind: jsfmt.Object}
		data.Set("to", jsfmt.StringValue(x.Text("status")))
		data.Set("error", jsfmt.StringValue(err.Error()))
		if aerr := s.db.AddItsaEvent(ctx, x.Text("id"), "", "ask_refused", data); aerr != nil {
			slog.Error("ITSA human: ask refused event", "itsa", x.Text("key"), "err", aerr)
		}
	}
}

// askHuman is itsa-human.ts askHuman: mails the human about an ITSA that just entered a human status. The sender is the agent
// that made the change, else the owner, else the agent standing in for stam.
func (s *Server) askHuman(ctx context.Context, x jsfmt.Value, actor string) error {
	a, err := s.askFor(ctx, x, actor, 1)
	if err != nil || a == nil {
		return err
	}
	if err := s.db.EnsureItsaParticipant(ctx, x.Text("id"), humanBox); err != nil {
		return err
	}
	in := jsfmt.Value{Kind: jsfmt.Object}
	in.Set("by", jsfmt.StringValue(a.sender))
	in.Set("body", jsfmt.StringValue(a.body))
	in.Set("subject", jsfmt.StringValue(a.subject))
	in.Set("from_stam", jsfmt.Value{Kind: jsfmt.Bool, Bool: a.stam})
	// A move a peer relayed carries its sender's routing facts, so the ask is routed as the send of that sender's mail (S-4178).
	if facts := relayRouteFrom(ctx); facts != nil {
		in.Set("relay_route", facts.value())
	}
	if a.replyTo != "" {
		in.Set("reply_to", jsfmt.StringValue(a.replyTo))
	}
	// The ask is stamped after the move's event, as in TS, where its send takes longer than a millisecond: a thread sorts by
	// time, and mail before event on a tie.
	time.Sleep(time.Millisecond)
	_, err = s.postShown(ctx, x.Text("id"), in, true, a.shown, a.shownRev)
	return err
}

// withdrawFromHuman is src/withdraw.ts withdrawFromHuman: the human's copy of each mail is read and marked withdrawn by
// `by`, and the thread is archived (a later reply brings it back) unless keepThread, where a new ask joins it at once.
func (s *Server) withdrawFromHuman(ctx context.Context, ids []string, by, note string, keepThread bool) error {
	_, err := s.withdraw(ctx, ids, by, note, withdrawOpts{keepThread: keepThread})
	return err
}

// withdrawOpts are src/withdraw.ts withdrawFromHuman's options: fromPeer for a peer's own call, which asks no peer;
// keepThread leaves the thread open, as a new ask joins it at once; closeKept closes the withdrawn mails' notifications
// while the thread stays open (S-1304).
type withdrawOpts struct{ fromPeer, keepThread, closeKept bool }

// withdraw is src/withdraw.ts withdrawFromHuman: the mails this daemon holds are withdrawn here, the rest asked of each
// peer (unless fromPeer). Archive records each thread's mail by identity, taken by the daemon that holds it in the same
// step that withdraws it (S-413). It returns the mails withdrawn anywhere. The web push is not ported, so no notification
// closes.
func (s *Server) withdraw(ctx context.Context, ids []string, by, note string, o withdrawOpts) ([]db.Withdrawn, error) {
	if by == humanBox {
		return nil, Errorf(http.StatusBadRequest, "the human's own answer isn't withdrawn")
	}
	var uniq []string
	for _, id := range ids {
		if !contains(uniq, id) {
			uniq = append(uniq, id)
		}
	}
	if len(uniq) == 0 {
		return []db.Withdrawn{}, nil
	}
	held, fresh, at, err := s.db.WithdrawFromHuman(ctx, uniq, by, sliceUnits(note, 500))
	if err != nil {
		return nil, err
	}
	for _, w := range fresh {
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(w.ID))
		ev.Set("by", jsfmt.StringValue(humanBox))
		ev.Set("at", jsfmt.StringValue(at))
		_ = s.hub.Emit("mail.read", ev)
	}
	done := append([]db.Withdrawn{}, fresh...)
	var missing []string
	for _, id := range uniq {
		if !contains(held, id) {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 && !o.fromPeer {
		body := map[string]any{"ids": missing, "by": by, "note": note, "keep_thread": o.keepThread, "close_kept": o.closeKept}
		for _, p := range s.peers.Peers() {
			r, err := s.peers.Call(ctx, p, http.MethodPost, "/api/mail/withdraw", body, peers.DefaultTimeout, false, nil)
			if err != nil {
				continue
			}
			done = append(done, withdrawnOf(r.Data)...)
		}
	}
	if o.keepThread {
		return done, nil
	}
	byThread := map[string][]string{}
	var order []string
	for _, w := range done {
		if _, seen := byThread[w.ThreadID]; !seen {
			order = append(order, w.ThreadID)
		}
		byThread[w.ThreadID] = append(byThread[w.ThreadID], append([]string{w.ID}, w.IDs...)...)
	}
	for _, t := range order {
		var all []string
		for _, id := range byThread[t] {
			if !contains(all, id) {
				all = append(all, id)
			}
		}
		if err := s.db.ArchiveThread(ctx, humanBox, t, all); err != nil {
			return nil, err
		}
	}
	return done, nil
}

// withdrawnOf reads a peer's {withdrawn: [{id, thread_id, ids}]}.
func withdrawnOf(data jsfmt.Value) []db.Withdrawn {
	var out []db.Withdrawn
	list, ok := data.Get("withdrawn")
	if !ok || list.Kind != jsfmt.Array {
		return nil
	}
	for _, w := range list.Items {
		x := db.Withdrawn{ID: w.Text("id"), ThreadID: w.Text("thread_id")}
		if ids, ok := w.Get("ids"); ok && ids.Kind == jsfmt.Array {
			for _, id := range ids.Items {
				x.IDs = append(x.IDs, anyString(id))
			}
		}
		out = append(out, x)
	}
	return out
}

// withdrawnValue is the withdrawn mails as src/withdraw.ts returns them: [{id, thread_id, ids?}].
func withdrawnValue(ws []db.Withdrawn) jsfmt.Value {
	out := make([]jsfmt.Value, 0, len(ws))
	for _, w := range ws {
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("id", jsfmt.StringValue(w.ID))
		v.Set("thread_id", jsfmt.StringValue(w.ThreadID))
		if w.IDs != nil {
			v.Set("ids", jsfmt.ArrayValue(stringValues(w.IDs)))
		}
		out = append(out, v)
	}
	return jsfmt.ArrayValue(out)
}
