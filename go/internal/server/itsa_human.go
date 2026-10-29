package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// The routes of an ITSA's thread and of the human acting on it (src/daemon.ts over src/itsa.ts and src/itsa-human.ts;
// S-2849): the thread for the UI, the mail threads about the ITSA, the human's act on an ITSA that waits on them, and the
// list of what waits. The ask a move into a human status sends is in itsa_ask.go; the peers' parts of a thread are left out
// (this daemon has no peers).

// mayReadThreads is src/daemon.ts mayReadItsaThreads: an agent's token, or the OpenCode server naming its agent with `as`,
// reads an ITSA's threads only as one the ITSA belongs to.
func (s *Server) mayReadThreads(ctx context.Context, c auth.Resolved, id, as string) error {
	if !c.Caller.IsAgent() {
		return nil
	}
	me := as
	if c.Caller.Kind == auth.Agent {
		me = c.Caller.Agent
	}
	if me == "" {
		return Errorf(http.StatusForbidden, "the OpenCode server must name the agent that reads the threads")
	}
	if c.Caller.Boss {
		return nil
	}
	if ok, err := s.mayReadItsaThreads(ctx, me, id); err != nil || ok {
		return err
	}
	x, err := s.mustItsa(ctx, id)
	if err != nil {
		return err
	}
	msg, err := s.itsaRefusal(ctx, me, x, "read the threads of")
	if err != nil {
		return err
	}
	return Errorf(http.StatusForbidden, "%s", msg)
}

// itsaRead is the start of a read of an ITSA's threads: the home, the ITSA, the caller's right to read.
func (s *Server) itsaRead(r *http.Request, c auth.Resolved) (context.Context, jsfmt.Value, error) {
	if err := s.notHome(c); err != nil {
		return nil, jsfmt.Value{}, err
	}
	ctx := context.WithoutCancel(r.Context())
	ref := r.PathValue("id")
	if !reItsaID.MatchString(ref) {
		return nil, jsfmt.Value{}, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	x, err := s.mustItsa(ctx, ref)
	if err != nil {
		return nil, jsfmt.Value{}, asItsaErr(err)
	}
	if err := s.mayReadThreads(ctx, c, x.Text("id"), r.URL.Query().Get("as")); err != nil {
		return nil, jsfmt.Value{}, err
	}
	return ctx, x, nil
}

// jsText is a member as a JS template string shows it: `${d.from}`.
func jsText(v jsfmt.Value, present bool) string {
	switch {
	case !present:
		return "undefined"
	case v.Kind == jsfmt.Null:
		return "null"
	}
	return db.JSStr(v)
}

// eventName is src/itsa.ts threadEvents name(): who an event names.
func (s *Server) eventName(ctx context.Context, v jsfmt.Value, present bool) string {
	switch {
	case !present || v.Kind == jsfmt.Null:
		return "nobody"
	case v.Kind == jsfmt.String && v.Str == humanBox:
		return "the human"
	}
	return s.agentLabel(ctx, db.JSStr(v))
}

// threadEvents is src/itsa.ts threadEvents: the ITSA's status and owner changes as one-line events.
func (s *Server) threadEvents(ctx context.Context, id string) ([]jsfmt.Value, error) {
	evts, err := s.db.ItsaEvents(ctx, id, 1000)
	if err != nil {
		return nil, err
	}
	out := []jsfmt.Value{}
	for _, e := range evts {
		typ := e.Text("type")
		if typ != "status" && typ != "owner" {
			continue
		}
		var d jsfmt.Value
		if data := e.Text("data"); data != "" {
			if d, err = jsfmt.Parse([]byte(data)); err != nil {
				return nil, err
			}
			if d.Kind != jsfmt.Object {
				return nil, fmt.Errorf("db: ITSA event %s has data that is not an object", e.Text("id"))
			}
		} else {
			d = jsfmt.Value{Kind: jsfmt.Object}
			d.Set("from", jsfmt.NullValue())
			d.Set("to", jsfmt.NullValue())
		}
		actor, hasActor := e.Get("actor")
		who := s.eventName(ctx, actor, hasActor)
		from, hasFrom := d.Get("from")
		to, hasTo := d.Get("to")
		text := who + " changed owner from " + s.eventName(ctx, from, hasFrom) + " to " + s.eventName(ctx, to, hasTo)
		if typ == "status" {
			text = who + " changed status from " + jsText(from, hasFrom) + " to " + jsText(to, hasTo)
		}
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("type", jsfmt.StringValue("event"))
		ts, _ := e.Get("ts")
		ev.Set("ts", ts)
		idv, _ := e.Get("id")
		ev.Set("id", idv)
		ev.Set("actor", actor)
		ev.Set("event", jsfmt.StringValue(typ))
		ev.Set("text", jsfmt.StringValue(text))
		out = append(out, ev)
	}
	return out, nil
}

// permissionRefusal answers 501 for a thread holding a mail that carries a permission request, which this daemon does not
// attach to a mail.
func permissionRefusal(mails []jsfmt.Value) error {
	for _, m := range mails {
		if v, ok := m.Get("permission_id"); ok && v.Kind != jsfmt.Null && v.Truthy() {
			return Errorf(http.StatusNotImplemented, "a mail that carries a permission request is not ported to the Go daemon yet")
		}
	}
	return nil
}

// itsaThreadRoute is GET /api/itsas/:id/thread: the ITSA's mails and its status and owner changes as one list, by time.
func (s *Server) itsaThreadRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, x, err := s.itsaRead(r, c)
	if err != nil {
		return nil, err
	}
	var mails []jsfmt.Value
	if tid := x.Text("thread_id"); tid != "" {
		if mails, err = s.db.ThreadMail(ctx, tid, ""); err != nil {
			return nil, err
		}
	}
	if err := permissionRefusal(mails); err != nil {
		return nil, err
	}
	evts, err := s.threadEvents(ctx, x.Text("id"))
	if err != nil {
		return nil, err
	}
	// Mails first, then events, by time (mergeThread: a stable sort on ts).
	items := make([]jsfmt.Value, 0, len(mails)+len(evts))
	for _, m := range mails {
		it := jsfmt.Value{Kind: jsfmt.Object}
		it.Set("type", jsfmt.StringValue("mail"))
		ts, _ := m.Get("created_at")
		it.Set("ts", ts)
		it.Set("mail", m)
		items = append(items, it)
	}
	items = append(items, evts...)
	sort.SliceStable(items, func(i, j int) bool { return items[i].Text("ts") < items[j].Text("ts") })

	head := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"id", "key", "title", "thread_id"} {
		v, _ := x.Get(k)
		head.Set(k, v)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("itsa", head)
	out.Set("items", jsfmt.ArrayValue(items))
	return out, nil
}

// itsaThreadsRoute is GET /api/itsas/:id/threads: one row per mail thread about the ITSA, newest activity first, without its
// own thread.
func (s *Server) itsaThreadsRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx, x, err := s.itsaRead(r, c)
	if err != nil {
		return nil, err
	}
	groups, err := s.db.AboutItsaThreads(ctx, x.Text("id"))
	if err != nil {
		return nil, err
	}
	own := x.Text("thread_id")
	rows := []jsfmt.Value{}
	for _, g := range groups {
		if len(g.Mails) == 0 || (own != "" && g.ThreadID == own) {
			continue
		}
		if err := permissionRefusal(g.Mails); err != nil {
			return nil, err
		}
		var people []string
		unread := int64(0)
		add := func(id string) {
			if !contains(people, id) {
				people = append(people, id)
			}
		}
		for _, m := range g.Mails {
			add(m.Text("from_id"))
			rc, _ := m.Get("recipients")
			toHuman := false
			for _, rec := range rc.Items {
				add(rec.Text("id"))
				if rec.Text("id") == humanBox {
					if ra, ok := rec.Get("read_at"); !ok || !ra.Truthy() {
						toHuman = true
					}
				}
			}
			if toHuman {
				unread++
			}
		}
		row := jsfmt.Value{Kind: jsfmt.Object}
		row.Set("thread_id", jsfmt.StringValue(g.ThreadID))
		subject, _ := g.Mails[0].Get("subject")
		row.Set("subject", subject)
		row.Set("participants", jsfmt.ArrayValue(stringValues(people)))
		last, _ := g.Mails[len(g.Mails)-1].Get("created_at")
		row.Set("last_at", last)
		row.Set("unread", jsfmt.IntValue(unread))
		rows = append(rows, row)
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Text("last_at") > rows[j].Text("last_at") })
	return jsfmt.ArrayValue(rows), nil
}

// itsaAttentionRoute is GET /api/itsas/attention: the ITSAs in a human status, oldest first, with their actions.
func (s *Server) itsaAttentionRoute(r *http.Request, c auth.Resolved) (any, error) {
	// Not an agent's to read (S-587): refused before the proxy.
	if msg := auth.NotAgentToken(c.Caller, agentRefused["GET /api/itsas/attention"]); msg != "" {
		return nil, Errorf(http.StatusForbidden, "%s", msg)
	}
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	out, err := s.attention(context.WithoutCancel(r.Context()))
	if err != nil {
		return nil, err
	}
	return jsfmt.ArrayValue(out), nil
}

// attention is src/itsa-human.ts attention: every ITSA in a human status, oldest first, with its actions and latest ask.
func (s *Server) attention(ctx context.Context) ([]jsfmt.Value, error) {
	waiting, err := s.waitingItsas(ctx)
	if err != nil {
		return nil, asItsaErr(err)
	}
	deferred, err := s.db.DeferredThreadIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]jsfmt.Value, 0, len(waiting))
	for _, x := range waiting {
		id, status := x.Text("id"), x.Text("status")
		evts, err := s.db.ItsaEvents(ctx, id, 1000)
		if err != nil {
			return nil, err
		}
		since := x.Text("created_at")
		for i := len(evts) - 1; i >= 0; i-- {
			if evts[i].Text("type") != "status" || evts[i].Text("data") == "" {
				continue
			}
			d, err := jsfmt.Parse([]byte(evts[i].Text("data")))
			if err != nil {
				return nil, err
			}
			if to, ok := d.Get("to"); ok && to.Kind == jsfmt.String && to.Str == status {
				since = evts[i].Text("ts")
				break
			}
		}
		askSince, err := s.db.ItsaStatusSince(ctx, id, x.Text("created_at"), 0)
		if err != nil {
			return nil, err
		}
		askID, askThread, has, err := s.db.LatestAsk(ctx, id, askSince)
		if err != nil {
			return nil, err
		}
		row := x
		row.Set("since", jsfmt.StringValue(since))
		row.Set("actions", actionsValue(s.actionsOf(status)))
		if has {
			row.Set("ask_thread_id", jsfmt.StringValue(askThread))
			row.Set("ask_mail_id", jsfmt.StringValue(askID))
		} else {
			row.Set("ask_thread_id", jsfmt.NullValue())
			row.Set("ask_mail_id", jsfmt.NullValue())
		}
		row.Set("deferred", jsfmt.Value{Kind: jsfmt.Bool, Bool: has && deferred[askThread]})
		out = append(out, row)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Text("since") < out[j].Text("since") })
	return out, nil
}

// itsaActRoute is POST /api/itsas/:id/act: the human takes an action on an ITSA that waits on them, { action, text }.
func (s *Server) itsaActRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	ref := r.PathValue("id")
	if !reItsaID.MatchString(ref) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if !s.isHuman(r, c) {
		return nil, Errorf(http.StatusForbidden, "only the human acts on an ITSA that waits on them")
	}
	text := func(key string) string {
		if v, ok := body.Get(key); ok && v.Kind != jsfmt.Null {
			return db.JSStr(v)
		}
		return ""
	}
	// Approve needs if_rev, the revision of the text it showed (S-2998); a missing one is refused.
	// A mail thread names the newest mail it showed instead (shown_mail).
	ifRev, shownMail := "", ""
	if v, ok := body.Get("if_rev"); ok && v.Kind == jsfmt.String {
		ifRev = v.Str
	}
	if v, ok := body.Get("shown_mail"); ok && v.Kind == jsfmt.String {
		shownMail = v.Str
	}
	out, err := s.act(ctx, ref, text("action"), text("text"), ifRev, shownMail)
	return out, asItsaErr(err)
}

// act is src/itsa-human.ts act. The text is posted first: if delivery fails nothing has changed. The status then moves
// only if the ITSA is still in the status the action was offered for (a stale button gets 409; the comment stays).
//
// Approve carries ifRev, the revision of the text it showed (revOf, S-2998): text that changed since, or no revision at
// all, refuses it before anything is posted, and the status move checks it again in the same transaction. A mail thread
// names the newest mail it showed (shownMail): the revision is the one recorded at or before it (shownRev).
func (s *Server) act(ctx context.Context, ref, actionID, text, ifRev, shownMail string) (any, error) {
	x, err := s.mustItsa(ctx, ref)
	if err != nil {
		return nil, err
	}
	status := x.Text("status")
	var action *struct{ id, label, to, text string }
	for _, a := range s.actionsOf(status) {
		if a.ID == actionID {
			action = &struct{ id, label, to, text string }{a.ID, a.Label, a.To, a.Text}
			break
		}
	}
	if action == nil {
		return nil, errors.New(x.Text("key") + " is in " + status + ", which has no action " + actionID)
	}
	approve := action.id == "approve"
	if approve && ifRev == "" && shownMail != "" {
		if ifRev, err = s.shownRev(ctx, x.Text("id"), shownMail); err != nil {
			return nil, err
		}
	}
	if approve && ifRev == "" {
		return nil, errors.New(textChanged + ": Approve didn't say which text of " + x.Text("key") + " it saw; reload it")
	}
	if approve && ifRev != revOf(x) {
		return nil, errors.New(textChanged + ": " + x.Text("key") + " changed since it was shown")
	}
	body := db.JSTrim(text)
	if action.text == "required" && body == "" {
		return nil, errors.New(action.label + " needs a comment: say what you want")
	}
	if action.text == "none" && body != "" {
		return nil, errors.New(action.label + " takes no comment")
	}
	f := jsfmt.Value{Kind: jsfmt.Object}
	f.Set("status", jsfmt.StringValue(action.to))
	f.Set("ifStatus", jsfmt.StringValue(status))
	f.Set("action", jsfmt.StringValue(action.id))
	if approve {
		f.Set("ifRev", jsfmt.StringValue(ifRev))
	}
	if body != "" {
		// What this daemon does not carry (every 501 of a change is found in its checks) is answered before the comment
		// lands, so a retry does not post it twice. A stale button (409) is still found after the post, as in TS.
		if _, err := s.setItsaMode(ctx, x.Text("id"), f, humanBox, true); err != nil {
			var e *Error
			if errors.As(err, &e) && e.Status == http.StatusNotImplemented {
				return nil, err
			}
		}
		// Approve's comment goes only after its guarded move succeeds, so a refusal leaves nothing behind.
		if !approve {
			if err := s.postHuman(ctx, x.Text("id"), body); err != nil {
				return nil, err
			}
		}
	}
	if actBeforeSet != nil {
		actBeforeSet()
	}
	set, err := s.setItsa(ctx, x.Text("id"), f, humanBox)
	if err != nil {
		return nil, err
	}
	if body != "" && approve {
		if err := s.postHuman(ctx, x.Text("id"), body); err != nil {
			return nil, err
		}
	}
	moved, _ := set.(jsfmt.Value).Get("itsa")
	which := jsfmt.Value{Kind: jsfmt.Object}
	which.Set("id", jsfmt.StringValue(action.id))
	which.Set("label", jsfmt.StringValue(action.label))
	which.Set("to", jsfmt.StringValue(action.to))
	which.Set("text", jsfmt.StringValue(action.text))
	res := jsfmt.Value{Kind: jsfmt.Object}
	res.Set("itsa", moved)
	res.Set("action", which)
	return res, nil
}

// postHuman posts the human's comment on an action into the ITSA's thread.
func (s *Server) postHuman(ctx context.Context, id, body string) error {
	in := jsfmt.Value{Kind: jsfmt.Object}
	in.Set("by", jsfmt.StringValue(humanBox))
	in.Set("body", jsfmt.StringValue(body))
	_, err := s.post(ctx, id, in, false)
	return err
}
