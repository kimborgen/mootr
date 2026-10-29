package server

import (
	"context"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// A mailbox's thread list and its archive, defer and unread state, the decision mails waiting on the human, and the
// thread reads the web UI and the peers make (src/daemon.ts over src/db.ts and src/decision-mail.ts; S-3734). The archive
// and defer state lives on the daemon that serves the list; the peers add the mail they hold.

func (s *Server) threadRoutes() {
	s.handle("GET /api/agents/{id}/threads", agentPath(s.threadsRoute))
	for _, verb := range []string{"archive", "unarchive", "defer", "undefer"} {
		s.handle("POST /api/agents/{id}/threads/{tid}/"+verb, agentPath(s.threadStateRoute(verb)))
	}
	s.handle("POST /api/agents/{id}/threads/{tid}/unread", agentPath(s.unreadRoute))
	s.handle("GET /api/threads/about/{id}", s.aboutThreadsRoute)
	s.handle("GET /api/mail/{id}/thread", s.mailThreadRoute)
	s.handle("GET /api/mail/decisions", s.decisionsRoute)
	s.handle("GET /api/asks", s.asksRoute)
	s.handle("GET /api/mail/human-waits", s.humanWaitsRoute)
	s.handle("POST /api/mail/{id}/withdraw-ask", s.withdrawAskRoute)
	s.handle("POST /api/mail/withdraw", s.peerWithdrawRoute)
	s.handle("POST /api/mail/{id}/attach", s.attachRoute)
	s.mux.Handle("GET /api/mail/{id}/attachments/{name}", s.stream(s.attachmentRoute))
	s.handle("POST /api/mail/resolved", s.resolvedRoute)
	s.handle("POST /api/mail/archive-resolved", s.archiveResolvedRoute)
}

// threadMail is db.ThreadMail with the permission request each mail carries (src/db.ts withRecipients' `permission`).
func (s *Server) threadMail(ctx context.Context, tid, box string) ([]jsfmt.Value, error) {
	mails, err := s.db.ThreadMail(ctx, tid, box)
	if err != nil {
		return nil, err
	}
	for i := range mails {
		pid := mails[i].Text("permission_id")
		if pid == "" {
			continue
		}
		r, ok, err := s.db.PermissionRequestByID(ctx, pid)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		p, err := s.db.PublicRequest(ctx, r, s.cfg.Machine)
		if err != nil {
			return nil, err
		}
		mails[i].Set("permission", p)
	}
	return mails, nil
}

// withPermissions adds each mail's permission request to thread groups db read.
func (s *Server) withPermissions(ctx context.Context, groups []db.ThreadGroup) error {
	for i := range groups {
		mails, err := s.threadMail(ctx, groups[i].ThreadID, "")
		if err != nil {
			return err
		}
		groups[i].Mails = mails
	}
	return nil
}

// groupsValue is thread groups as their JSON: [{thread_id, mails}].
func groupsValue(groups []db.ThreadGroup) jsfmt.Value {
	out := make([]jsfmt.Value, 0, len(groups))
	for _, g := range groups {
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("thread_id", jsfmt.StringValue(g.ThreadID))
		mails := g.Mails
		if mails == nil {
			mails = []jsfmt.Value{}
		}
		v.Set("mails", jsfmt.ArrayValue(mails))
		out = append(out, v)
	}
	return jsfmt.ArrayValue(out)
}

// clone is a deep copy of a JSON value.
func clone(v jsfmt.Value) jsfmt.Value {
	out := v
	if v.Keys != nil {
		out.Keys = append([]string(nil), v.Keys...)
	}
	if v.Items != nil {
		out.Items = make([]jsfmt.Value, len(v.Items))
		for i, x := range v.Items {
			out.Items[i] = clone(x)
		}
	}
	return out
}

// nullish is a member that is missing or null.
func nullish(m jsfmt.Value, k string) bool {
	v, ok := m.Get(k)
	return !ok || v.Kind == jsfmt.Null
}

// hasItems is a member that is a non-empty array.
func hasItems(m jsfmt.Value, k string) bool {
	v, ok := m.Get(k)
	return ok && v.Kind == jsfmt.Array && len(v.Items) > 0
}

// foldMails is src/db.ts foldMails: copies of one mail (the same id, on several daemons, each with its own recipients)
// fold into one. Recipients join, read on any copy counts, and the first copy's attachments, permission, verdict,
// override, title, summary and shown are kept, else another copy's.
func foldMails(mails []jsfmt.Value) []jsfmt.Value {
	var out []jsfmt.Value
	at := map[string]int{}
	for _, m := range mails {
		id := m.Text("id")
		i, seen := at[id]
		if !seen {
			at[id] = len(out)
			out = append(out, clone(m))
			continue
		}
		have := &out[i]
		rs, _ := have.Get("recipients")
		if theirs, ok := m.Get("recipients"); ok && theirs.Kind == jsfmt.Array {
			for _, r := range theirs.Items {
				found := false
				for j := range rs.Items {
					if rs.Items[j].Text("id") != r.Text("id") {
						continue
					}
					found = true
					if nullish(rs.Items[j], "read_at") {
						v, _ := r.Get("read_at")
						rs.Items[j].Set("read_at", v)
					}
					break
				}
				if !found {
					rs.Items = append(rs.Items, clone(r))
				}
			}
			if rs.Kind == jsfmt.Array {
				have.Set("recipients", rs)
			}
		}
		if !hasItems(*have, "attachments") && hasItems(m, "attachments") {
			v, _ := m.Get("attachments")
			have.Set("attachments", clone(v))
		}
		if p, ok := have.Get("permission"); (!ok || !p.Truthy()) && !nullish(m, "permission") {
			v, _ := m.Get("permission")
			if v.Truthy() {
				have.Set("permission", clone(v))
			}
		}
		for _, k := range []string{"verdict", "override", "title", "summary"} {
			if nullish(*have, k) && !nullish(m, k) {
				v, _ := m.Get(k)
				have.Set(k, clone(v))
			}
		}
		if sh, ok := have.Get("shown"); (!ok || !sh.Truthy()) && m.Text("body") == have.Text("body") {
			if v, ok := m.Get("shown"); ok && v.Truthy() {
				have.Set("shown", clone(v))
			}
		}
	}
	return out
}

// byCreated sorts mails oldest first, keeping the order of equal times.
func byCreated(mails []jsfmt.Value) {
	sort.SliceStable(mails, func(i, j int) bool { return mails[i].Text("created_at") < mails[j].Text("created_at") })
}

// groupsOf reads thread groups a peer answered.
func groupsOf(rows []jsfmt.Value) []db.ThreadGroup {
	var out []db.ThreadGroup
	for _, r := range rows {
		ms, _ := r.Get("mails")
		out = append(out, db.ThreadGroup{ThreadID: r.Text("thread_id"), Mails: ms.Items})
	}
	return out
}

// viaBox is src/daemon.ts viaBox: the identity a mail read as `box` carries to a peer. The OpenCode server has no agent of
// its own, so the peer checks the box it named.
func (s *Server) viaBox(ctx context.Context, c auth.Resolved, box string) *peers.Via {
	if c.Kind == auth.OpenCode && box != "" {
		assistant := s.isAssistant(ctx, box)
		return &peers.Via{Agent: box, Boss: s.chiefOfStaffID(ctx) == box || assistant, Assistant: assistant}
	}
	return s.viaOf(ctx, c)
}

// withBox is src/daemon.ts withBox: the path with ?box= when a box is named.
func withBox(path, box string) string {
	if box == "" {
		return path
	}
	return path + "?box=" + url.QueryEscape(box)
}

// mailboxThreads is src/daemon.ts mailboxThreads: a mailbox's threads as its list shows them, merged from every daemon
// and split by this daemon's archive and defer state. Every source is asked for the page plus the mailbox's archived and
// deferred threads, so filtering can't leave the page short. via is how peers check the box is read as; viaDecisions how
// they check the decision list.
func (s *Server) mailboxThreads(ctx context.Context, box string, limit int, via, viaDecisions *peers.Via, with string) (active, archived, deferred []db.ThreadGroup, err error) {
	na, err := s.db.ArchivedCount(ctx, box)
	if err != nil {
		return nil, nil, nil, err
	}
	nd, err := s.db.DeferredCount(ctx, box)
	if err != nil {
		return nil, nil, nil, err
	}
	capN := limit + na + nd
	here, err := s.db.Threads(ctx, box, capN, with)
	if err != nil {
		return nil, nil, nil, err
	}
	if err := s.withPermissions(ctx, here); err != nil {
		return nil, nil, nil, err
	}
	q := "/api/agents/" + box + "/threads?limit=" + strconv.Itoa(capN)
	if with != "" {
		q += "&with=" + url.QueryEscape(with)
	}
	var order []string
	merged := map[string][]jsfmt.Value{}
	for _, t := range append(here, groupsOf(s.peers.FanOut(ctx, q, via))...) {
		if _, ok := merged[t.ThreadID]; !ok {
			order = append(order, t.ThreadID)
		}
		merged[t.ThreadID] = append(merged[t.ThreadID], t.Mails...)
	}
	all := make([]db.ThreadGroup, 0, len(order))
	for _, tid := range order {
		ms := foldMails(merged[tid])
		byCreated(ms)
		all = append(all, db.ThreadGroup{ThreadID: tid, Mails: ms})
	}
	// A thread's place is its newest message the mailbox sent or received: mail between others in it doesn't move it up
	// (S-542).
	last := func(ms []jsfmt.Value) string {
		for i := len(ms) - 1; i >= 0; i-- {
			if ms[i].Text("from_id") == box || sentToBox(ms[i], box) {
				return ms[i].Text("created_at")
			}
		}
		if len(ms) == 0 {
			return ""
		}
		return ms[len(ms)-1].Text("created_at")
	}
	sort.SliceStable(all, func(i, j int) bool { return last(all[i].Mails) > last(all[j].Mails) })
	var keep map[string]bool
	if box == humanBox {
		if keep, err = s.askThreadIDs(ctx); err != nil {
			return nil, nil, nil, err
		}
		ds, err := s.decisionMailsAll(ctx, false, viaDecisions)
		if err != nil {
			return nil, nil, nil, err
		}
		for _, d := range ds {
			keep[d.Text("thread_id")] = true
		}
	}
	act, archived, err := s.db.SplitArchived(ctx, box, all, keep)
	if err != nil {
		return nil, nil, nil, err
	}
	// An ask or a decision can be deferred too (S-1068), so `keep` doesn't apply.
	active, deferred, err = s.db.SplitDeferred(ctx, box, act)
	return active, archived, deferred, err
}

// sentToBox is whether the box is among the mail's recipients.
func sentToBox(m jsfmt.Value, box string) bool {
	rs, _ := m.Get("recipients")
	for _, r := range rs.Items {
		if r.Text("id") == box {
			return true
		}
	}
	return false
}

// askThreadIDs is src/itsa-human.ts askThreadIds: the threads of the latest asks of the ITSAs waiting on the human.
func (s *Server) askThreadIDs(ctx context.Context) (map[string]bool, error) {
	waiting, err := s.waitingItsas(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, x := range waiting {
		since, err := s.db.ItsaStatusSince(ctx, x.Text("id"), x.Text("created_at"), 0)
		if err != nil {
			return nil, err
		}
		_, thread, has, err := s.db.LatestAsk(ctx, x.Text("id"), since)
		if err != nil {
			return nil, err
		}
		if has {
			out[thread] = true
		}
	}
	return out, nil
}

// waitingItsas is src/itsa-human.ts waiting: the ITSAs in a human status.
func (s *Server) waitingItsas(ctx context.Context) ([]jsfmt.Value, error) {
	var names []string
	for _, st := range s.itsaStatuses() {
		if st.Human {
			names = append(names, st.Name)
		}
	}
	return s.db.ItsasInStatuses(ctx, names)
}

// decisionMailsAll is src/daemon.ts decisionMailsAll: the unanswered decision mails across the daemons (S-352), by mail
// id, without those about an ITSA in a human status on any home, oldest first. A peer's own request gets its local list.
func (s *Server) decisionMailsAll(ctx context.Context, local bool, via *peers.Via) ([]jsfmt.Value, error) {
	mine, err := s.db.DecisionMails(ctx)
	if err != nil {
		return nil, err
	}
	if local {
		return mine, nil
	}
	theirs := s.peers.FanOut(ctx, "/api/mail/decisions", via)
	held := map[string]bool{}
	waiting, err := s.waitingItsas(ctx)
	if err != nil {
		return nil, err
	}
	for _, x := range waiting {
		held[x.Text("id")] = true
	}
	for _, x := range s.peers.FanOut(ctx, "/api/itsas/attention", via) {
		held[x.Text("id")] = true
	}
	var order []string
	byID := map[string]jsfmt.Value{}
	for _, m := range append(mine, theirs...) {
		id := m.Text("mail_id")
		if _, ok := byID[id]; !ok {
			order = append(order, id)
		}
		byID[id] = m
	}
	out := []jsfmt.Value{}
	for _, id := range order {
		m := byID[id]
		if a := m.Text("about_itsa"); a != "" && held[a] {
			continue
		}
		out = append(out, m)
	}
	byCreated(out)
	return out, nil
}

// decisionThreads is the threads with an unanswered decision mail, which archive can't hide.
func (s *Server) decisionThreads(ctx context.Context, local bool, via *peers.Via) (map[string]bool, error) {
	ds, err := s.decisionMailsAll(ctx, local, via)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, d := range ds {
		out[d.Text("thread_id")] = true
	}
	return out, nil
}

// threadsRoute is GET /api/agents/:id/threads: the threads a mailbox takes part in, each with all its messages, for the
// web UI. archived=1 lists the threads archive hides and deferred=1 the deferred ones; with=ID keeps the threads where
// that agent sent or received a message (S-1121). A peer's own request gets every thread here, to sort by its own state.
func (s *Server) threadsRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	limit := number(q.Get("limit"), q.Has("limit"), 50)
	box := s.boxRef(ctx, r.PathValue("id"))
	with := ""
	if w := q.Get("with"); w != "" {
		with = s.boxRef(ctx, w)
	}
	if c.Local {
		groups, err := s.db.Threads(ctx, box, limit, with)
		if err != nil {
			return nil, err
		}
		if err := s.withPermissions(ctx, groups); err != nil {
			return nil, err
		}
		return groupsValue(groups), nil
	}
	active, archived, deferred, err := s.mailboxThreads(ctx, box, limit, s.viaBox(ctx, c, box), s.viaOf(ctx, c), with)
	if err != nil {
		return nil, err
	}
	list := active
	if q.Get("archived") == "1" {
		list = archived
	} else if q.Get("deferred") == "1" {
		list = deferred
	}
	if limit >= 0 && len(list) > limit {
		list = list[:limit]
	}
	return groupsValue(list), nil
}

// wholeThread is a thread's mail here, plus the peers' part unless the request is a peer's own.
func (s *Server) wholeThread(ctx context.Context, c auth.Resolved, tid string) ([]jsfmt.Value, error) {
	here, err := s.threadMail(ctx, tid, "")
	if err != nil || c.Local {
		return here, err
	}
	return append(here, s.peers.FanOut(ctx, "/api/threads/"+tid, s.viaOf(ctx, c))...), nil
}

// threadStateRoute is POST /api/agents/:id/threads/:tid/(archive|unarchive|defer|undefer). Archive hides a thread from a
// mailbox's list; unarchive brings it back; defer sets it aside for later. The human archives the human mailbox; an agent
// its own mailbox or a child's. A pending permission request, or the human's open decision, must be answered before its
// thread archives; defer sets it aside only.
func (s *Server) threadStateRoute(verb string) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		ctx := r.Context()
		body, err := jsonBody(r)
		if err != nil {
			return nil, err
		}
		box := s.boxRef(ctx, r.PathValue("id"))
		tid := r.PathValue("tid")
		if !agentRef.MatchString(tid) {
			return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
		}
		human := s.isHuman(r, c)
		if box == humanBox {
			if !human {
				return nil, Errorf(http.StatusForbidden, "only the human archives the human mailbox")
			}
		} else {
			a, err := s.mustAgent(ctx, r.PathValue("id"))
			if err != nil {
				return nil, err
			}
			by := ""
			if v, ok := body.Get("by"); ok && v.Truthy() {
				b, err := s.mustAgent(ctx, anyString(v))
				if err != nil {
					return nil, err
				}
				by = b.ID
			}
			if by == "" && s.strictRefuses("thread archive with no by", !human && !(c.Local && c.Kind == auth.Shared) && c.Kind != auth.Agent) {
				return nil, Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), archives a thread")
			}
			if by != "" && !s.isAssistant(ctx, by) && by != a.ID {
				parents, err := s.db.ParentsOf(ctx, a)
				if err != nil {
					return nil, err
				}
				if !contains(parents, by) {
					return nil, Errorf(http.StatusForbidden, "%s may archive only its own mailbox or its children's", by)
				}
			}
		}
		switch verb {
		case "undefer":
			if err := s.db.UndeferThread(ctx, box, tid); err != nil {
				return nil, err
			}
			// Mail that came back is pushed to an idle agent (S-1880).
			if box != humanBox && s.life != nil {
				s.life.SchedulePush(box)
			}
		case "archive", "defer":
			all, err := s.wholeThread(ctx, c, tid)
			if err != nil {
				return nil, err
			}
			if verb == "archive" {
				for _, m := range all {
					if pendingPermission(m) {
						return nil, Errorf(http.StatusConflict, "answer the permission request in this thread before archiving it")
					}
				}
				// Defer sets aside an ask or a decision too (S-1068): it stays listed under To answer, unanswered.
				if box == humanBox {
					open, err := s.decisionThreads(ctx, c.Local, s.viaOf(ctx, c))
					if err != nil {
						return nil, err
					}
					if open[tid] {
						return nil, Errorf(http.StatusConflict, "answer the decision in this thread before archiving it")
					}
				}
			}
			ids := make([]string, 0, len(all))
			for _, m := range all {
				ids = append(ids, m.Text("id"))
			}
			if verb == "defer" {
				err = s.db.DeferThread(ctx, box, tid, ids)
			} else if err = s.db.ArchiveThread(ctx, box, tid, ids); err == nil {
				err = s.db.ForgetAutoArchived(ctx, box, tid)
			}
			if err != nil {
				return nil, err
			}
		default:
			if err := s.db.UnarchiveThread(ctx, box, tid); err != nil {
				return nil, err
			}
			// The human took it back: auto-archive leaves it alone until it has new mail for them (S-637).
			if box == humanBox {
				all, err := s.wholeThread(ctx, c, tid)
				if err != nil {
					return nil, err
				}
				ids := make([]string, 0, len(all))
				for _, m := range all {
					ids = append(ids, m.Text("id"))
				}
				if err := s.db.KeepOpen(ctx, box, tid, ids); err != nil {
					return nil, err
				}
			}
		}
		if verb == "defer" || verb == "undefer" {
			return map[string]bool{"deferred": verb == "defer"}, nil
		}
		return map[string]bool{"archived": verb == "archive"}, nil
	}
}

// pendingPermission is whether the mail carries a permission request still pending.
func pendingPermission(m jsfmt.Value) bool {
	p, ok := m.Get("permission")
	return ok && p.Kind == jsfmt.Object && p.Text("status") == "pending"
}

// unreadRoute is POST /api/agents/:id/threads/:tid/unread: the human marks its own copies of a thread's mail unread
// again (S-2246). Each daemon marks the ones it holds; a request from the web asks the peers for the rest.
func (s *Server) unreadRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	if !agentRef.MatchString(r.PathValue("tid")) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	box, err := s.mailboxID(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	// A verified peer may ask too: Local is set only with the peer's token and x-stam-local, never by an agent's token.
	if box != humanBox || !(s.isHuman(r, c) || c.Local) {
		return nil, Errorf(http.StatusForbidden, "only the human marks its mail unread")
	}
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	var ids []string
	if v, ok := body.Get("ids"); ok && v.Kind == jsfmt.Array {
		for _, x := range v.Items {
			ids = append(ids, anyString(x))
		}
	}
	if len(ids) == 0 {
		return nil, Errorf(http.StatusBadRequest, "name the mail to mark unread")
	}
	tid := r.PathValue("tid")
	thread, err := s.db.ThreadMail(ctx, tid, "")
	if err != nil {
		return nil, err
	}
	held := map[string]bool{}
	for _, m := range thread {
		held[m.Text("id")] = true
	}
	var mine, missing []string
	for _, id := range ids {
		if held[id] {
			mine = append(mine, id)
		} else {
			missing = append(missing, id)
		}
	}
	marked, err := s.db.MarkUnread(ctx, humanBox, mine)
	if err != nil {
		return nil, err
	}
	if c.Local || len(missing) == 0 {
		return map[string][]string{"marked": marked}, nil
	}
	for _, p := range s.peers.Peers() {
		reply, err := s.peers.Call(ctx, p, http.MethodPost, "/api/agents/human/threads/"+tid+"/unread", map[string][]string{"ids": missing}, peers.DefaultTimeout, false, nil)
		if err != nil {
			slog.Error("mark unread: " + p.Name + " unreachable: " + err.Error())
			continue
		}
		if reply.Status >= 300 {
			slog.Error("mark unread: " + p.Name + " answered " + strconv.Itoa(reply.Status) + " for " + strconv.Itoa(len(missing)) + " mail")
		}
		if m, ok := reply.Data.Get("marked"); ok && m.Kind == jsfmt.Array {
			for _, x := range m.Items {
				marked = append(marked, anyString(x))
			}
		}
	}
	return map[string][]string{"marked": marked}, nil
}

// aboutThreadsRoute is GET /api/threads/about/:id: a peer's part of an ITSA's mail threads, raw by thread.
func (s *Server) aboutThreadsRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	if !agentRef.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	if !c.Local {
		if err := s.mayReadThreads(ctx, c, id, r.URL.Query().Get("as")); err != nil {
			return nil, err
		}
	}
	groups, err := s.db.AboutItsaThreads(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.withPermissions(ctx, groups); err != nil {
		return nil, err
	}
	return groupsValue(groups), nil
}

// mailThreadRoute is GET /api/mail/:id/thread: the thread a mail belongs to and its subject, for links to it; [] if no
// daemon has it, or the viewer may not read it (S-388).
func (s *Server) mailThreadRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	if !agentRef.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	x, ok, err := s.db.GetMail(ctx, id)
	if err != nil {
		return nil, err
	}
	if !ok {
		if c.Local {
			return []jsfmt.Value{}, nil
		}
		box, err := s.viewerBox(ctx, c, r.URL.Query().Get("box"))
		if err != nil {
			return nil, err
		}
		rows := s.peers.FanOut(ctx, withBox(r.URL.Path, box), s.viaBox(ctx, c, box))
		if len(rows) > 1 {
			rows = rows[:1]
		}
		return rows, nil
	}
	if may, err := s.mayReadMailAs(ctx, c, r.URL.Query().Get("box"), x); err != nil || !may {
		if err != nil {
			return nil, err
		}
		return []jsfmt.Value{}, nil
	}
	tid := x.Text("thread_id")
	if tid == "" {
		tid = x.Text("id")
	}
	subject, _ := x.Get("subject")
	if t, ok, err := s.db.GetMail(ctx, tid); err != nil {
		return nil, err
	} else if ok {
		subject, _ = t.Get("subject")
	}
	row := jsfmt.Value{Kind: jsfmt.Object}
	row.Set("thread_id", jsfmt.StringValue(tid))
	row.Set("subject", subject)
	return []jsfmt.Value{row}, nil
}

// mayReadMailAs is src/daemon.ts mayReadMail: the viewer's box reads the mail if it is none (the human, the CLI, a peer),
// the chief of staff's, the assistant's, or a boss's, or as src/mail-visibility.ts mayReadMail says.
func (s *Server) mayReadMailAs(ctx context.Context, c auth.Resolved, raw string, x jsfmt.Value) (bool, error) {
	box, err := s.viewerBox(ctx, c, raw)
	if err != nil {
		return false, err
	}
	if box == "" || c.Caller.Boss || s.chiefOfStaffID(ctx) == box || s.isAssistant(ctx, box) {
		return true, nil
	}
	// The reader is the agent whose token asks, not a box it may act for (src/daemon.ts readerOf, S-480).
	reader := s.boxRef(ctx, box)
	if c.Caller.Kind == auth.Agent && c.Caller.Agent != "" {
		reader = s.boxRef(ctx, c.Caller.Agent)
	}
	return s.mayReadMailBy(ctx, s.boxRef(ctx, box), reader, x)
}

// decisionsRoute is GET /api/mail/decisions: the agents' mail to the human that holds a decision and waits for their
// reply (src/decision-mail.ts).
func (s *Server) decisionsRoute(r *http.Request, c auth.Resolved) (any, error) {
	return s.decisionMailsAll(r.Context(), c.Local, s.viaOf(r.Context(), c))
}

// humanWaitsRoute is GET /api/mail/human-waits: the open waits on the human this daemon holds (S-637). Auto-archive asks
// every daemon for them.
func (s *Server) humanWaitsRoute(r *http.Request, c auth.Resolved) (any, error) {
	if msg := auth.NotAgentToken(c.Caller, "read what waits on the human"); msg != "" {
		return nil, Errorf(http.StatusForbidden, "%s", msg)
	}
	return s.db.OpenHumanWaits(r.Context())
}
