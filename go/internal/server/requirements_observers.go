package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/peers"
	"stam/internal/requirements"
	"stam/internal/steps"
)

// The requirement checks of a stored mail and of an ITSA change (src/req-check.ts maybeCheckMail, watch, tellActor, capNotice).
// They run after the write, on a context of their own, so a check that fails or takes long never fails or delays the send or
// the change that caused it; like TS, a check that was running when the daemon stopped is lost.

// jv is a decoded value as the ordered kind jsjson holds: a string stays one, null is nil.
func jv(v jsfmt.Value, ok bool) jsjson.Value {
	if !ok || v.Kind == jsfmt.Null {
		return nil
	}
	if v.Kind == jsfmt.String {
		return v.Str
	}
	return toJSJSON(v)
}

// mailSubject is src/req-check.ts mailSubject.
func (s *Server) mailSubject(ctx context.Context, id, from, subject, body, thread string, toHuman bool) requirements.Subject {
	kind := "mail"
	if toHuman {
		kind = "mail-to-human"
	}
	var t jsjson.Value
	if thread != "" {
		t = thread
	}
	return requirements.Subject{
		Kind: kind, Ref: "mail:" + id, Content: jsjson.NewObject("subject", subject, "body", body, "thread", t),
		Actor: s.steps.ActorOf(ctx, from), ActorID: from,
	}
}

// itsaKeys is the ITSA's key and its ancestors' keys, nearest first (src/req-check.ts itsaKeys).
func (s *Server) itsaKeys(ctx context.Context, x jsfmt.Value) []string {
	keys := []string{x.Text("key")}
	seen := map[string]bool{x.Text("id"): true}
	for cur := x; cur.Text("parent_id") != ""; {
		p, ok, err := s.db.FindItsa(ctx, cur.Text("parent_id"))
		if err != nil || !ok || seen[p.Text("id")] {
			break
		}
		seen[p.Text("id")] = true
		keys = append(keys, p.Text("key"))
		cur = p
	}
	return keys
}

// itsaPayload is src/steps.ts itsaPayload.
func (s *Server) itsaPayload(ctx context.Context, x jsfmt.Value) *jsjson.Object {
	var owner jsjson.Value
	if o := x.Text("owner"); o != "" {
		owner = s.steps.ActorOf(ctx, o).Name
	}
	o := jsjson.NewObject("key", x.Text("key"), "title", x.Text("title"))
	for _, k := range []string{"kind", "summary", "body"} {
		v, ok := x.Get(k)
		o.Set(k, jv(v, ok))
	}
	o.Set("status", x.Text("status"))
	o.Set("owner", owner)
	p, ok := x.Get("parent_id")
	o.Set("parent", jv(p, ok))
	return o
}

// itsaSubject is src/req-check.ts itsaSubject: event is created, status or edit; from and to are a status change's.
func (s *Server) itsaSubject(ctx context.Context, x jsfmt.Value, event, actor, from, to string) requirements.Subject {
	content := jsjson.NewObject("event", event)
	payload := s.itsaPayload(ctx, x)
	for _, k := range payload.Keys() {
		v, _ := payload.Get(k)
		content.Set(k, v)
	}
	if event == "status" {
		content.Set("from", from)
		content.Set("to", to)
	}
	return requirements.Subject{Kind: "itsa", Ref: "itsa:" + x.Text("key"), Content: content, Actor: s.steps.ActorOf(ctx, actor), ActorID: actor, Itsa: s.itsaKeys(ctx, x)}
}

// afterMail is src/req-check.ts maybeCheckMail, called once a mail is stored: stam's own mail and the human's are not
// checked; on a daemon that is not the ITSA home the subject is forwarded to the home.
func (s *Server) afterMail(ctx context.Context, id, from, subject, body, thread string, toHuman, fromStam bool) {
	if fromStam || from == humanBox || !s.requirements.Enabled() {
		return
	}
	sub := s.mailSubject(ctx, id, from, subject, body, thread, toHuman)
	bg := context.WithoutCancel(ctx)
	if !s.isHome() {
		go s.forwardSubject(bg, sub)
		return
	}
	go s.requirements.Check(bg, sub, requirements.CheckOptions{})
}

// afterItsaChange is the req-check.watch observer: a created, status or edit change is checked, off the write.
func (s *Server) afterItsaChange(ctx context.Context, x jsfmt.Value, event, actor, from, to string) {
	if !s.requirements.Enabled() {
		return
	}
	bg := context.WithoutCancel(ctx)
	go s.requirements.Check(bg, s.itsaSubject(bg, x, event, actor, from, to), requirements.CheckOptions{})
	if event == "status" && to == "ready_to_merge" {
		go s.checkBranches(bg, x)
	}
}

// subjectValue is a subject as a peer's forward carries it (JSON.stringify of src/req-check.ts CheckSubject).
func subjectValue(sub requirements.Subject) jsfmt.Value {
	content, _ := jsfmt.Parse([]byte(jsjson.Stringify(sub.Content, "")))
	actor, _ := jsfmt.Parse([]byte(jsjson.Stringify(sub.Actor.Value(), "")))
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("kind", jsfmt.StringValue(sub.Kind))
	out.Set("ref", jsfmt.StringValue(sub.Ref))
	out.Set("content", content)
	out.Set("actor", actor)
	if sub.ActorID != "" {
		out.Set("actorId", jsfmt.StringValue(sub.ActorID))
	}
	return out
}

// forwardSubject sends a mail subject to the ITSA home (10 s, src/req-check.ts forwardSubject). A forward never delays or fails
// the caller; an unreachable home logs a `req:error` and the check is dropped.
func (s *Server) forwardSubject(ctx context.Context, sub requirements.Subject) {
	p, ok := s.homePeer()
	if !ok {
		s.forwardError(ctx, sub.Ref, fmt.Sprintf("the ITSA home '%s' is not a configured peer", s.settings.Get().Itsa.Home))
		return
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("subject", subjectValue(sub))
	r, err := s.peers.Call(ctx, p, "POST", "/api/requirements/check-subject", body, 10*time.Second, false, nil)
	switch {
	case err != nil:
		s.forwardError(ctx, sub.Ref, err.Error())
	case r.Status >= 300:
		s.forwardError(ctx, sub.Ref, fmt.Sprintf("answered %d: %s", r.Status, r.Data.Text("error")))
	}
}

// checkSubject is the home's side of a forward: a mail subject from a peer, checked off the request. Only the mail kinds are
// taken, so a peer can't make the home check anything else on its say (src/req-check.ts acceptForwarded).
func (s *Server) checkSubject(r *http.Request, _ auth.Resolved) (any, error) {
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	accepted := s.acceptForwarded(context.WithoutCancel(r.Context()), body)
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("accepted", jsfmt.Value{Kind: jsfmt.Bool, Bool: accepted})
	return out, nil
}

func (s *Server) acceptForwarded(ctx context.Context, body jsfmt.Value) bool {
	in, ok := body.Get("subject")
	if !ok || in.Kind != jsfmt.Object {
		return false
	}
	kind, ref := in.Text("kind"), ""
	if v, ok := in.Get("ref"); ok && v.Kind == jsfmt.String {
		ref = v.Str
	}
	actor, okActor := peerActor(in)
	if (kind != "mail" && kind != "mail-to-human") || ref == "" || !okActor || !s.requirements.Enabled() || !s.isHome() {
		return false
	}
	content, has := in.Get("content")
	sub := requirements.Subject{Kind: kind, Ref: ref, Content: jv(content, has), Actor: actor}
	if v, ok := in.Get("actorId"); ok && v.Kind == jsfmt.String {
		sub.ActorID = v.Str
	}
	go s.requirements.Check(ctx, sub, requirements.CheckOptions{})
	return true
}

// resolveSubject is src/req-check.ts manual for a `mail:ID` or `itsa:KEY` ref (a branch is PR 6): silent, as the human.
func (s *Server) resolveSubject(ctx context.Context, ref string) (requirements.Subject, error) {
	switch {
	case strings.HasPrefix(ref, "mail:"):
		m, ok, err := s.db.GetMail(ctx, ref[5:])
		if err != nil {
			return requirements.Subject{}, err
		}
		if !ok {
			return requirements.Subject{}, fmt.Errorf("no mail %s", ref[5:])
		}
		return s.mailSubject(ctx, m.Text("id"), m.Text("from_id"), m.Text("subject"), m.Text("body"), m.Text("thread_id"), false), nil
	case strings.HasPrefix(ref, "itsa:"):
		x, ok, err := s.db.FindItsa(ctx, ref[5:])
		if err != nil {
			return requirements.Subject{}, err
		}
		if !ok {
			return requirements.Subject{}, fmt.Errorf("no ITSA %s", ref[5:])
		}
		sub := s.itsaSubject(ctx, x, "manual", humanBox, "", "")
		sub.ActorID = ""
		return sub, nil
	}
	m := reBranchRef.FindStringSubmatch(ref)
	if m == nil {
		return requirements.Subject{}, fmt.Errorf("a branch subject is branch:REPO/NAME")
	}
	diff := s.branchDiff(ctx, m[1], m[2])
	if diff == nil {
		return requirements.Subject{}, fmt.Errorf("can't read the diff of %s in %s", m[2], m[1])
	}
	paths := filePaths(diff.files)
	return requirements.Subject{
		Kind: "branch", Ref: "branch:" + m[1] + "/" + m[2] + "@" + diff.head,
		Content: jsjson.NewObject("repo", m[1], "branch", m[2], "head", diff.head, "files", paths),
		Actor:   steps.Actor{Name: "human"}, Paths: paths, Repo: m[1], Files: diff.files,
	}, nil
}

var reBranchRef = regexp.MustCompile(`^branch:([^/]+)/(.+)$`)

// tellViolation is src/req-check.ts tellActor: the notice to the actor, an indication from a model and never a finding of fact.
func (s *Server) tellViolation(ctx context.Context, sub requirements.Subject, hits []requirements.Hit) {
	lines := make([]string, len(hits))
	for i, h := range hits {
		owner := "human"
		if o := h.Req.Owner(); o != "" {
			owner = s.steps.ActorOf(ctx, o).Name
		}
		text := h.Req.Text("title")
		if v, ok := h.Req.Get("text"); ok && v.Kind == jsfmt.String {
			text = v.Str
		}
		lines[i] = fmt.Sprintf("%s likely not met (p %s): %s. If this is wrong, say so to the requirement's owner (%s).", h.Req.Key(), steps.ToFixed2(h.P), text, owner)
	}
	found := "a likely problem"
	if len(hits) > 1 {
		found = "these likely problems"
	}
	text := fmt.Sprintf("A model check of your %s found %s. It is an indication, not proof.\n\n%s", sub.Ref, found, strings.Join(lines, "\n"))
	go func() {
		if err := s.tellAnywhere(context.WithoutCancel(ctx), sub.ActorID, text); err != nil {
			slog.Warn("requirement notice", "agent", sub.ActorID, "err", err)
		}
	}()
}

// tellAnywhere is src/mail.ts tellAnywhere: a notice for an agent here, or sent to the peer that holds it.
func (s *Server) tellAnywhere(ctx context.Context, agentID, text string) error {
	_, err := s.tellWhere(ctx, agentID, text, "")
	return err
}

// tellWhere is src/mail.ts tellAnywhere with its outcome: "told", "absent" (no machine has the agent) or "unreachable"
// (a peer that may hold it did not answer); an error is a peer that refused the notice. want, when set, is the
// child-notices mode the agent must have (src/org.ts tell's want), read on the record of the daemon that holds it.
func (s *Server) tellWhere(ctx context.Context, agentID, text, want string) (string, error) {
	if a, err := s.db.GetAgent(ctx, agentID); err == nil {
		mode := ""
		if a.ChildNotices != nil {
			mode = string(*a.ChildNotices)
		}
		if want != "" && s.childNoticesOf(mode) != want {
			return "told", nil
		}
		if s.noticeHook != nil {
			s.noticeHook(a.ID, text)
		} else if s.life != nil {
			s.life.QueueNotice(ctx, a.ID, text, false)
		}
		return "told", nil
	}
	hit, found, err := s.peers.Locate(ctx, s.db, agentID)
	switch {
	case err != nil:
		return "", err
	case found == peers.Unreachable:
		return "unreachable", nil
	case found != peers.Found || hit == nil:
		return "absent", nil
	}
	if want != "" {
		mode := ""
		if v, ok := hit.Agent.Raw.Get("child_notices"); ok && v.Kind == jsfmt.String {
			mode = v.Str
		}
		if s.childNoticesOf(mode) != want {
			return "told", nil
		}
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("text", jsfmt.StringValue(text))
	r, err := s.peers.Call(ctx, *hit.Peer, "POST", "/api/agents/"+peers.EncodeURIComponent(hit.Agent.ID)+"/notice", body, 10*time.Second, false, nil)
	if err != nil {
		return "unreachable", nil
	}
	if r.Status >= 300 {
		return "", fmt.Errorf("%s refused the notice: %s", hit.Peer.Name, r.Data.Text("error"))
	}
	return "told", nil
}

// childNoticesOf is src/org.ts childNoticesOf: the agent's own setting, else settings.childNotices.
func (s *Server) childNoticesOf(mode string) string {
	switch mode {
	case "turn", "tree-idle", "none":
		return mode
	}
	return s.settings.Get().ChildNotices
}

// sendFromSystemMail is src/mail.ts sendFromSystemMail: stam's own mail from the system:NAME sender, in a new thread,
// marked as stam's (a notice, not gated or checked), as sendMail marks every system sender's mail; with the mail's id.
func (s *Server) sendFromSystemMail(ctx context.Context, name string, to []string, subject, body string) (string, bool) {
	m, err := s.send(ctx, &sendIn{system: name, hasSystem: true, to: to, subject: subject, body: body, newThread: true, fromStam: true, inferred: map[string]bool{}})
	if err != nil {
		return "", false
	}
	return m.Text("id"), true
}

// sendFromSystem is src/mail.ts sendFromSystem: sendFromSystemMail without the id.
func (s *Server) sendFromSystem(ctx context.Context, name string, to []string, subject, body string) bool {
	_, ok := s.sendFromSystemMail(ctx, name, to, subject, body)
	return ok
}

// capNotice is src/req-check.ts capNotice: one notice a day when the cap stops checks. Mail from system:requirements goes
// to the chief of staff when there is one, else to the human, held back by the human's mail settings like the other stam
// notices.
func (s *Server) capNotice(ctx context.Context, spent, cap float64) {
	s.capMu.Lock()
	defer s.capMu.Unlock()
	since := time.Now().UTC().Format("2006-01-02") + "T00:00:00"
	if n, err := s.db.CountEvents(ctx, "req:cap", since); err != nil || n > 0 {
		return
	}
	data := jsfmt.Value{Kind: jsfmt.Object}
	data.Set("spent", numberValue(spent))
	data.Set("cap", numberValue(cap))
	if err := s.db.AddEvent(ctx, "stam", "req:cap", data); err != nil {
		return
	}
	body := fmt.Sprintf("Requirement checks stopped for today: they spent $%s of the $%s daily cap (settings.requirements.dailyCapUsd). Verdicts already stored still count; nothing new is recorded until tomorrow or the cap is raised.", steps.ToFixed(spent, 4), jsjson.Number(cap))
	subject := "[stam] Requirement checks reached the daily cap"
	if cos := s.chiefOfStaffID(ctx); cos != "" {
		go s.sendFromSystem(context.WithoutCancel(ctx), "requirements", []string{cos}, subject, body)
	} else if s.settings.Get().HumanMail.Allows("important") {
		go s.sendFromSystem(context.WithoutCancel(ctx), "requirements", []string{humanBox}, subject, body)
	}
}

// tellDemotion is the notice of src/requirements.ts demoteIfImprecise: the human hears in the requirement's own thread (the ITSA
// of its approval ask), or not at all, never in separate mail; an agent hears wherever it lives.
func (s *Server) tellDemotion(ctx context.Context, owner, key, text string) error {
	if owner == humanBox {
		ids, err := s.db.RequirementAskItsa(ctx, key)
		if err != nil || ids == "" {
			return err
		}
		in := jsfmt.Value{Kind: jsfmt.Object}
		in.Set("from_stam", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
		in.Set("body", jsfmt.StringValue(text))
		_, err = s.post(ctx, ids, in, false)
		return err
	}
	return s.tellAnywhere(ctx, owner, text)
}
