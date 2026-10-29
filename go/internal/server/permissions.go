package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Permission requests (src/permissions.ts, S-2848 B3a): an agent whose harness blocked something it needs asks through
// stam. A 'delegate' ask goes to the agent's parent and the chief of staff only, and reaches the human when they
// escalate it, or when neither is live; a 'human' ask goes to the human, and the reviewers get a quiet notice and may
// deny it, never approve it. A harness dialog is a delegate ask whose yes is still the human's alone, and goes to the
// human when nobody answers it in time. The answer reaches the agent as a notice that says who answered.
//
// Each settling write is conditional on the request's state and carries its waits (db.DecidePermissionRequest), and
// permMu runs one answer, escalation, dialog report or timeout at a time, so the check before a write and the keys typed
// into a dialog belong to the answer that wins.
//
// A delegate ask whose live reviewer runs on another machine mails it through its peer, and an answer to a request another
// machine holds is relayed there (permission_relay.go).

// reviewers is src/permissions.ts reviewers: the agent's parent (here or remembered from a peer) and the chief of staff.
func (s *Server) reviewers(ctx context.Context, a db.Agent) ([]string, error) {
	var out []string
	if a.ParentID != nil && *a.ParentID != "" {
		p := *a.ParentID
		known := false
		if _, err := s.db.GetAgent(ctx, p); err == nil {
			known = true
		} else if !errors.Is(err, db.ErrNotFound) {
			return nil, err
		} else if n, err := s.db.PeerAgentName(ctx, p); err != nil {
			return nil, err
		} else {
			known = n != ""
		}
		if known {
			out = append(out, p)
		}
	}
	if cos := s.chiefOfStaffID(ctx); cos != "" && cos != a.ID && !contains(out, cos) {
		out = append(out, cos)
	}
	return out, nil
}

// liveReviewers is src/permissions.ts liveReviewers: the reviewers that can decide now, a local one active, one on
// another machine unless its last known lifecycle says otherwise.
func (s *Server) liveReviewers(ctx context.Context, a db.Agent) ([]string, error) {
	if s.liveReviewersHook != nil {
		return s.liveReviewersHook(ctx, a)
	}
	all, err := s.reviewers(ctx, a)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, id := range all {
		if x, err := s.db.GetAgent(ctx, id); err == nil {
			if x.Lifecycle == "active" {
				out = append(out, id)
			}
			continue
		}
		life, known, err := s.db.PeerAgentLifecycle(ctx, id)
		if err != nil {
			return nil, err
		}
		if !known || life == "active" {
			out = append(out, id)
		}
	}
	return out, nil
}

// nameOf is `getAgent(id)?.name ?? findPeerAgent(id)?.name`, "" for neither.
func (s *Server) nameOf(ctx context.Context, id string) string {
	if a, err := s.db.GetAgent(ctx, id); err == nil {
		return a.Name
	}
	n, _ := s.db.PeerAgentName(ctx, id)
	return n
}

var backticks = regexp.MustCompile("`+")

// fenced is src/permissions.ts fenced: the fence is longer than any run of backticks in the text, so the text can't
// close it and render as markdown.
func fenced(details, lang string) string {
	if details == "" {
		return ""
	}
	n := 3
	for _, run := range backticks.FindAllString(details, -1) {
		if len(run)+1 > n {
			n = len(run) + 1
		}
	}
	fence := strings.Repeat("`", n)
	return fence + lang + "\n" + details + "\n" + fence
}

// timedOutWhy is src/permissions.ts timedOutWhy: why a dialog went on to the human by itself.
func timedOutWhy(n float64) string {
	if n <= 0 {
		return "stam's settings send dialogs on without waiting for an answer"
	}
	unit := "minutes"
	if n == 1 {
		unit = "minute"
	}
	return "nobody answered within " + jsjson.Number(n) + " " + unit
}

// dialogRoute is src/permissions.ts dialogMail's route: the request's id, who sent it on and why, or how long it waited.
type dialogRoute struct {
	id, escalator, reason string
	timedOut              *float64
}

var anySpace = regexp.MustCompile(jsSpaceClass + `+`)

const jsSpaceClass = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// dialogMail is src/permissions.ts dialogMail: the vars of the permission-dialog template. A harness dialog's request
// carries the hook's JSON as its details: the mail says in a line what the agent wants, shows the command or target in a
// block, and says who has looked.
func (s *Server) dialogMail(ctx context.Context, requester string, told []string, action, details, fallbackWhy string, route dialogRoute) map[string]string {
	tool := strings.TrimPrefix(action, "Claude Code asks to allow ")
	var names []string
	for _, id := range told {
		if n := s.nameOf(ctx, id); n != "" {
			names = append(names, n)
		}
	}
	tagged := make([]string, len(names))
	for i, n := range names {
		tagged[i] = "@" + n
	}
	var seen string
	switch {
	case route.escalator != "":
		seen = "@" + route.escalator + " looked first and sent it on to you: " + route.reason
	case route.timedOut != nil:
		to := strings.Join(tagged, " and ")
		if to == "" {
			to = "its parent and the chief of staff"
		}
		seen = "It went to " + to + " first, and " + timedOutWhy(*route.timedOut) + ", so it comes to you."
	case len(names) > 0:
		seen = "It came to " + strings.Join(tagged, " and ") + " first; the human hasn't seen it. Nobody has decided yet."
	default:
		seen = "Nobody else has seen it."
	}
	next := ""
	if len(names) > 0 && route.escalator == "" && route.timedOut == nil {
		next = "_Answer with `answer_permission` and id `" + route.id + "`: deny it, with a note on what " + requester + " does instead, or escalate it to the human with a one-line reason when " + requester + " needs it and only a yes unblocks it. Only the human approves a dialog. Never leave it waiting: " + requester + " is blocked until someone answers._"
	}
	out := map[string]string{"requester": requester, "seen": seen, "next": next, "id": route.id}
	parsed, err := jsjson.Parse([]byte(details))
	if err != nil {
		out["line"], out["shown"], out["why"], out["subject"] = "wants an answer to this dialog: "+action, fenced(details, ""), fallbackWhy, "Permission: "+action
		return out
	}
	var input jsjson.Value = jsjson.NewObject()
	var inputObj *jsjson.Object
	switch j := parsed.(type) {
	case *jsjson.Object:
		if t, ok := get(j, "tool").(string); ok {
			tool = t
		}
		switch in := get(j, "input").(type) {
		case *jsjson.Object:
			input, inputObj = in, in
		case []jsjson.Value:
			input = in
		}
	case []jsjson.Value:
		// An array is an object to typeof: no tool or input in it.
	}
	target := ""
	for _, k := range []string{"command", "file_path", "url", "pattern"} {
		if v, ok := get(inputObj, k).(string); ok {
			target = v
			break
		}
	}
	// A question dialog shows its question and options, numbered as the choice is typed (S-3978).
	q, isQuestion := "", false
	var options []string
	if tool == "AskUserQuestion" {
		q, options, isQuestion = claude.DialogQuestion(inputObj)
	}
	line := "wants to use " + tool + "."
	switch {
	case isQuestion:
		line = "asks a question, with these options."
	case tool == "Bash":
		line = "wants to run a shell command."
	case target != "":
		line = "wants to use " + tool + " with this input."
	}
	shown := fenced(jsjson.Stringify(input, "  "), "json")
	if target != "" {
		shown = fenced(target, "bash")
	}
	if isQuestion {
		lines := []string{q, ""}
		for i, o := range options {
			lines = append(lines, strconv.Itoa(i+1)+". "+o)
		}
		shown = fenced(strings.Join(lines, "\n"), "")
	}
	why := "Claude Code gave no reason with this dialog; ask the agent, or read its last message in its terminal."
	if d, ok := get(inputObj, "description").(string); ok && jsjson.Trim(d) != "" {
		why = jsjson.Trim(d)
	}
	subject := requester + " asks to use " + tool
	switch {
	case isQuestion:
		subject = requester + " asks: " + anySpace.ReplaceAllString(q, " ")
	case tool == "Bash" && target != "":
		subject = requester + " wants to run"
	}
	if target != "" && !isQuestion {
		subject += ": " + anySpace.ReplaceAllString(target, " ")
	}
	if utf16Len(subject) > 90 {
		subject = sliceUnits(subject, 89) + "…"
	}
	out["line"], out["shown"], out["why"], out["subject"] = line, shown, why, subject
	return out
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func get(o *jsjson.Object, k string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(k)
	return v
}

// queueNotice is src/mail.ts queueNotice for an agent here.
func (s *Server) queueNotice(ctx context.Context, id, text string) {
	if s.noticeHook != nil {
		s.noticeHook(id, text)
	} else if s.life != nil {
		s.life.QueueNotice(ctx, id, text, false)
	}
}

// queueAnswerNotice is queueNotice for an answer's notice (S-3923): the lifecycle also stores it until the agent is handed
// it, so a restart before then delivers it once. src/permissions.ts queues these with { answer: true }.
func (s *Server) queueAnswerNotice(ctx context.Context, id, text string) {
	if s.noticeHook != nil {
		s.noticeHook(id, text)
	} else if s.life != nil {
		s.life.QueueAnswerNotice(ctx, id, text)
	}
}

// queueAnswerRow queues an answer's notice whose answer_notices row was written with the answer (S-3923), 0 for none.
func (s *Server) queueAnswerRow(ctx context.Context, id, text string, row int64) {
	if s.noticeHook != nil {
		s.noticeHook(id, text)
	} else if s.life != nil {
		s.life.QueueAnswerRow(ctx, id, text, row)
	}
}

// withFailureRetro is src/templates.ts withFailureRetro: a notice that reports a failure, with the failure retro reminder
// appended while reminders are on.
func (s *Server) withFailureRetro(text string) string {
	if !s.settings.Get().RetroReminders {
		return text
	}
	r, err := s.tpl.Render("retro-reminder-failure", nil, "")
	if err != nil || r == "" {
		return text
	}
	return text + "\n\n" + r
}

func (s *Server) render(name string, vars map[string]string) (string, error) {
	return s.tpl.Render(name, vars, "")
}

// orgResync is src/org.ts syncChildrenWaits and announceTreeIdle after the agent's requests changed.
func (s *Server) orgResync(ctx context.Context, id string) {
	if s.life != nil {
		s.life.OrgResync(ctx, id)
	}
}

// withdrawQuietly is src/withdraw.ts withdrawQuietly: the human's copies of the mails are withdrawn, a failure logged.
func (s *Server) withdrawQuietly(ctx context.Context, ids []string, by, note string) {
	if err := s.withdrawFromHuman(ctx, ids, by, note, false); err != nil {
		slog.Error("withdraw: "+note, "err", err)
	}
}

func (s *Server) publicRequest(ctx context.Context, id string) (jsfmt.Value, error) {
	r, ok, err := s.db.PermissionRequestByID(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !ok {
		return jsfmt.Value{}, fmt.Errorf("no permission request %s", id)
	}
	return s.db.PublicRequest(ctx, r, s.cfg.Machine)
}

// unportedAsk refuses an ask before anything is written: with no templates (501), or a delegate ask whose live reviewer is
// on a machine that isn't a configured peer (503), which no mail can reach. A reviewer on a configured peer gets the
// request's mail through it, like any mail to an agent there (mail_peers.go).
func (s *Server) unportedAsk(ctx context.Context, a db.Agent, audience string, live []string) error {
	if s.tpl == nil {
		return unported("permission requests need the templates, which this server has not loaded")
	}
	if audience != "delegate" {
		return nil
	}
	for _, id := range live {
		_, err := s.db.GetAgent(ctx, id)
		if err == nil {
			continue
		}
		if !errors.Is(err, db.ErrNotFound) {
			return err
		}
		p, known, err := s.db.FindPeerAgent(ctx, id)
		if err != nil {
			return err
		}
		if _, ok := s.peers.ByName(p.Machine); !known || !ok {
			return Errorf(http.StatusServiceUnavailable, "%s's reviewer %s runs on %s, which isn't a configured peer, so the request can't reach it", a.Name, s.agentLabel(ctx, id), orUnknown(p.Machine))
		}
	}
	return nil
}

func orUnknown(machine string) string {
	if machine == "" {
		return "a machine this daemon doesn't know"
	}
	return machine
}

// routesToHuman is the routing rule of an ask (src/permissions.ts refusalFor): a delegate ask with a live reviewer goes
// to that reviewer, and any other ask reaches the human. requestPermission routes with it too, so the refusal and the
// routing can't drift.
func routesToHuman(audience string, live []string) bool {
	return audience != "delegate" || len(live) == 0
}

// askRefusalMsg is src/permissions.ts askRefusal: why a request can't be sent, or "" when it can (S-3203). A blank action
// is refused at any audience, a blank reason where the request reaches the human.
func askRefusalMsg(action, reason string, toHuman bool) string {
	if jsjson.Trim(action) == "" {
		return "request_permission: `action` is required (what you need to do, in one line; put the exact command in `details`)"
	}
	if toHuman && jsjson.Trim(reason) == "" {
		return "request_permission: `reason` is required when the request reaches your user (why only your user's consent unblocks it)"
	}
	return ""
}

// askRefusalFor is src/permissions.ts refusalFor for an ask, given the live reviewers that requestPermission routes it by
// (live, and the error of that lookup). A failed lookup counts as reaching the human, so the reason is required (fail
// closed). Nothing is logged here: the action and reason can hold what the agent is about to run.
func askRefusalFor(action, reason, audience string, live []string, lookupErr error) string {
	toHuman := lookupErr != nil || routesToHuman(audience, live)
	return askRefusalMsg(action, reason, toHuman)
}

// requestPermission is src/permissions.ts requestPermission for a request or a dialog: the request and its wait, the
// children waits above the agent, the request's mail in a thread of its own, the reviewers' notice of a human ask, and
// the permission:requested event. The refusal and the routing both read the one lookup of the live reviewers, so a
// reviewer that pauses meanwhile can't change the answer between them.
func (s *Server) requestPermission(ctx context.Context, a db.Agent, action, reason, details string, dialog bool, audience string) (jsfmt.Value, error) {
	return s.requestPermissionWith(ctx, a, action, reason, details, dialog, audience, permExtra{})
}

// permExtra is src/permissions.ts requestPermission's extra: a settings change's payload, which makes the ask the
// human's whatever its audience, and the fence the details are shown in.
type permExtra struct {
	payload *string
	fence   string
}

// requestPermissionWith is requestPermission with extra.
func (s *Server) requestPermissionWith(ctx context.Context, a db.Agent, action, reason, details string, dialog bool, audience string, extra permExtra) (jsfmt.Value, error) {
	if extra.payload != nil {
		audience = "human"
	}
	live, lookupErr := s.liveReviewers(ctx, a)
	if msg := askRefusalFor(action, reason, audience, live, lookupErr); msg != "" {
		return jsfmt.Value{}, Errorf(http.StatusBadRequest, "%s", msg)
	}
	if lookupErr != nil {
		return jsfmt.Value{}, lookupErr
	}
	if err := s.unportedAsk(ctx, a, audience, live); err != nil {
		return jsfmt.Value{}, err
	}
	delegate := !routesToHuman(audience, live)
	noDelegate := audience == "delegate" && !delegate && !dialog
	n := db.NewRequest{AgentID: a.ID, Action: action, Reason: reason, Details: details, Dialog: dialog, Payload: extra.payload}
	if delegate {
		n.Reviewer = live[0]
	}
	r, err := s.db.CreatePermissionRequest(ctx, n)
	if err != nil {
		return jsfmt.Value{}, err
	}
	// undo drops the request this call made, and its waits, when its mail can't be made or reaches no one, so the agent
	// isn't left waiting on an ask nobody holds and has no id for.
	undo := func(err error) (jsfmt.Value, error) {
		if drop := s.db.DropPermissionRequest(context.WithoutCancel(ctx), a.ID, r.ID); drop != nil {
			return jsfmt.Value{}, errors.Join(err, drop)
		}
		s.orgResync(ctx, a.ID)
		return jsfmt.Value{}, err
	}
	s.orgResync(ctx, a.ID)
	why := ""
	if noDelegate {
		why = "_" + a.Name + " has no parent or chief of staff to decide, so this comes to you._\n\n"
	}
	footer := "_The human decides this. Only the human approves: deny with `answer_permission` and id `" + r.ID + "` if it must not happen._"
	switch {
	case delegate:
		footer = "_You decide this: answer with `answer_permission` and id `" + r.ID + "`, with decision approve, deny or escalate (escalate it to the human, with a one-line reason, when only the human can decide). Never leave it waiting: " + a.Name + " is blocked until someone answers._"
	case len(live) > 0:
		footer = "_The human decides this. Reviewing agents may only deny it: deny with `answer_permission` and id `" + r.ID + "` if it must not happen._"
	}
	subject, body := "Permission: "+action, ""
	if dialog {
		told := []string{}
		if delegate {
			told = live
		}
		d := s.dialogMail(ctx, a.Name, told, action, details, reason, dialogRoute{id: r.ID})
		subject = d["subject"]
		body, err = s.render("permission-dialog", d)
	} else {
		body, err = s.render("permission-request", map[string]string{"requester": a.Name, "action": action, "reason": reason, "details": fenced(details, extra.fence), "id": r.ID, "why": why, "footer": footer})
	}
	if err != nil {
		return undo(err)
	}
	to := []string{humanBox}
	if delegate {
		to = live
	}
	if s.askMailHook != nil {
		s.askMailHook(r.ID)
	}
	if _, err := s.send(ctx, &sendIn{from: a.ID, to: to, subject: sliceUnits(subject, 200), body: body, permissionID: r.ID, newThread: true, inferred: map[string]bool{}}); err != nil {
		// Its mail reached no one: a reviewer on a peer that is down or refused it.
		return undo(err)
	}
	// Closed while its mail was being stored (S-3979): the mail is withdrawn at once, as the close would have pulled it had it been there.
	if cur, ok, err := s.db.PermissionRequestByID(ctx, r.ID); err != nil {
		return jsfmt.Value{}, err
	} else if ok && cur.Status != "pending" {
		ids, err := s.db.PermissionMailIDs(ctx, r.ID)
		if err != nil {
			return jsfmt.Value{}, err
		}
		s.withdrawQuietly(ctx, ids, "stam", "Withdrawn: closed while it was being sent")
	}
	// A paused reviewer hears of a human ask too, when it next takes a turn.
	if !delegate {
		all, err := s.reviewers(ctx, a)
		if err != nil {
			return jsfmt.Value{}, err
		}
		for _, id := range all {
			if _, err := s.db.GetAgent(ctx, id); err != nil {
				continue
			}
			text, err := s.render("permission-human-notice", map[string]string{"requester": a.Name, "action": action, "id": r.ID})
			if err != nil {
				return jsfmt.Value{}, err
			}
			s.queueNotice(ctx, id, text)
		}
	}
	if err := s.db.AddEvent(ctx, a.ID, "permission:requested", requestedEvent{ID: r.ID, Action: action, Audience: r.Audience}); err != nil {
		return jsfmt.Value{}, err
	}
	return s.publicRequest(ctx, r.ID)
}

// peerVouch is what a peer says of its agent that answers a request here (src/permissions.ts `peer`): whether it is
// that machine's chief of staff or assistant.
type peerVouch struct{ boss bool }

// checkedRequest is src/permissions.ts checked: the pending request, its agent, and whether `by` may answer for it.
type checkedRequest struct {
	r               db.PermissionRequest
	a               db.Agent
	assistant, boss bool
}

func (s *Server) checked(ctx context.Context, id, by string, peer *peerVouch) (checkedRequest, error) {
	r, ok, err := s.db.PermissionRequestByID(ctx, id)
	if err != nil {
		return checkedRequest{}, err
	}
	if !ok {
		return checkedRequest{}, fmt.Errorf("no permission request %s", id)
	}
	if r.Status != "pending" {
		return checkedRequest{}, fmt.Errorf("request %s is already %s", id, r.Status)
	}
	a, err := s.db.GetAgent(ctx, r.AgentID)
	if errors.Is(err, db.ErrNotFound) {
		return checkedRequest{}, fmt.Errorf("the requesting agent is gone, so request %s is closed", id)
	}
	if err != nil {
		return checkedRequest{}, err
	}
	assistant := by != humanBox && s.isAssistantRef(ctx, by)
	parent := deref(a.ParentID)
	boss := peer != nil && peer.boss && by != parent
	if by != humanBox && !assistant && !boss && !(peer != nil && by == parent) {
		all, err := s.reviewers(ctx, a)
		if err != nil {
			return checkedRequest{}, err
		}
		if !contains(all, by) {
			return checkedRequest{}, fmt.Errorf("%s can't answer for %s; only the human, the assistant, its parent, or the chief of staff can", by, a.Name)
		}
	}
	return checkedRequest{r: r, a: a, assistant: assistant, boss: boss}, nil
}

// isAssistantRef is `db.getAgent(by)?.kind === 'assistant'`, by id or name.
func (s *Server) isAssistantRef(ctx context.Context, ref string) bool {
	a, err := s.db.GetAgent(ctx, ref)
	return err == nil && a.Kind != nil && *a.Kind == "assistant"
}

// byName is `getAgent(by)?.name ?? findPeerAgent(by)?.name ?? by`.
func (s *Server) byName(ctx context.Context, by string) string {
	if n := s.nameOf(ctx, by); n != "" {
		return n
	}
	return by
}

// escalatePermission is src/permissions.ts escalatePermission: a reviewer sends a delegate ask to the human, with a
// one-line reason.
func (s *Server) escalatePermission(ctx context.Context, id, by, reason string, peer *peerVouch) (jsfmt.Value, error) {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	if by == humanBox {
		return jsfmt.Value{}, errors.New("the human decides it; escalating is for reviewing agents")
	}
	c, err := s.checked(ctx, id, by, peer)
	if err != nil {
		return jsfmt.Value{}, err
	}
	name := s.byName(ctx, by)
	if c.r.Audience != "delegate" {
		return jsfmt.Value{}, fmt.Errorf("request %s is already with the human", id)
	}
	why := jsjson.Trim(anySpace.ReplaceAllString(reason, " "))
	if why == "" {
		return jsfmt.Value{}, errors.New("say why you escalate it: a one-line reason is required")
	}
	if s.tpl == nil {
		return jsfmt.Value{}, unported("permission requests need the templates, which this server has not loaded")
	}
	moved, err := s.db.EscalatePermissionRequest(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !moved {
		return jsfmt.Value{}, fmt.Errorf("request %s is already with the human", id)
	}
	subject, body := "Permission: "+c.r.Action, ""
	if c.r.Dialog {
		d := s.dialogMail(ctx, c.a.Name, nil, c.r.Action, c.r.Details, c.r.Reason, dialogRoute{id: id, escalator: name, reason: why})
		subject = d["subject"]
		body, err = s.render("permission-dialog", d)
	} else {
		body, err = s.render("permission-escalated", map[string]string{"requester": c.a.Name, "action": c.r.Action, "reason": c.r.Reason, "details": fenced(c.r.Details, ""), "id": id, "escalator": name, "why": why})
	}
	if err != nil {
		return jsfmt.Value{}, err
	}
	if err := s.handToHuman(ctx, c.r, c.a, subject, body, name, why); err != nil {
		return jsfmt.Value{}, err
	}
	if err := s.db.AddEvent(ctx, c.a.ID, "permission:escalated", escalatedEvent{ID: id, By: by, Why: why}); err != nil {
		return jsfmt.Value{}, err
	}
	return s.publicRequest(ctx, id)
}

// handToHuman is src/permissions.ts handToHuman, after the move (db.EscalatePermissionRequest moved the waits too): the
// children waits follow, the human gets one mail that stands alone, and the requester hears who sent it on and why.
func (s *Server) handToHuman(ctx context.Context, r db.PermissionRequest, a db.Agent, subject, body, escalator, why string) error {
	s.orgResync(ctx, a.ID)
	if _, err := s.send(ctx, &sendIn{from: a.ID, to: []string{humanBox}, subject: sliceUnits(subject, 200), body: body, permissionID: r.ID, newThread: true, inferred: map[string]bool{}}); err != nil {
		return err
	}
	text, err := s.render("permission-escalation-notice", map[string]string{"id": r.ID, "action": r.Action, "escalator": escalator, "why": why})
	if err != nil {
		return err
	}
	s.queueNotice(ctx, a.ID, text)
	return nil
}

// The events' data keeps TS's key order (JSON.stringify writes keys as inserted; a Go map writes them sorted).
type escalatedEvent struct {
	ID     string    `json:"id"`
	By     string    `json:"by"`
	Why    string    `json:"why"`
	Waited *[]string `json:"waited,omitempty"`
}

type requestedEvent struct {
	ID       string `json:"id"`
	Action   string `json:"action"`
	Audience string `json:"audience"`
}

type defaultedEvent struct {
	ID       string `json:"id"`
	Audience string `json:"audience"`
}

// escalateStaleDialogs is src/permissions.ts escalateStaleDialogs: a harness dialog with the parent and the chief of
// staff that none of them answered within settings.dialogEscalateMinutes goes to the human, in the same dialog mail; a
// dialog whose agent was shut down or archived is withdrawn instead, since nothing is on screen to answer.
func (s *Server) escalateStaleDialogs(ctx context.Context) error {
	if s.tpl == nil {
		return nil
	}
	limit := s.settings.Get().DialogEscalateMinutes
	cutoff := time.Now().Add(-time.Duration(limit * float64(time.Minute))).UTC().Format("2006-01-02T15:04:05.000Z")
	dialogs, err := s.db.PendingDialogs(ctx)
	if err != nil {
		return err
	}
	for _, r := range dialogs {
		if err := s.escalateStale(ctx, r, limit, cutoff); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) escalateStale(ctx context.Context, r db.PermissionRequest, limit float64, cutoff string) error {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	a, err := s.db.GetAgent(ctx, r.AgentID)
	if errors.Is(err, db.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if a.Lifecycle != "active" && a.Lifecycle != "paused" {
		return s.withdrawDialog(ctx, a, r, a.Name+" is "+strings.Replace(string(a.Lifecycle), "_", " ", 1))
	}
	if r.Audience != "delegate" || r.CreatedAt > cutoff {
		return nil
	}
	moved, err := s.db.EscalatePermissionRequest(ctx, r.ID)
	if err != nil || !moved {
		return err
	}
	waited, err := s.db.PermissionMailRecipients(ctx, r.ID)
	if err != nil {
		return err
	}
	if waited == nil {
		waited = []string{}
	}
	why := timedOutWhy(limit)
	d := s.dialogMail(ctx, a.Name, waited, r.Action, r.Details, r.Reason, dialogRoute{id: r.ID, timedOut: &limit})
	body, err := s.render("permission-dialog", d)
	if err == nil {
		err = s.handToHuman(ctx, r, a, d["subject"], body, "stam", why)
	}
	if err != nil {
		if err := s.db.AddEvent(ctx, a.ID, "permission-error", "Error: "+err.Error()); err != nil {
			return err
		}
	}
	return s.db.AddEvent(ctx, a.ID, "permission:escalated", escalatedEvent{ID: r.ID, By: "stam", Why: why, Waited: &waited})
}

// StartPermissions runs escalateStaleDialogs and, apart, retryHeldInputs every 5 s until ctx ends, in the daemon's
// background work.
func (s *Server) StartPermissions(ctx context.Context) {
	if s.life == nil {
		return
	}
	every := func(run func(context.Context)) {
		s.life.Go(func(lctx context.Context) {
			t := time.NewTicker(5 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-lctx.Done():
					return
				case <-t.C:
					run(ctx)
				}
			}
		})
	}
	every(func(ctx context.Context) {
		if err := s.escalateStaleDialogs(ctx); err != nil {
			slog.Error("dialog timeout", "err", err)
		}
	})
	every(s.retryHeldInputs)
}

// DialogShown is src/permissions.ts dialogShown, for the lifecycle's hook: a harness dialog becomes a delegate ask. A
// hook that names its dialog (replaces) withdraws a pending request for another one; the same dialog reported again
// keeps its request. A dialog that chooses (Choose) names the dialog to show first, under the same hold, or none.
//
// A dialog the Go daemon can't route (no templates, or a live reviewer on another machine) is refused 501 before
// anything is written: an earlier dialog's request stays as it was, the hook records a permission-error event, and
// the dialog waits on screen for someone to answer it in the terminal.
func (s *Server) DialogShown(ctx context.Context, a db.Agent, d claude.Dialog) error {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	pending, ok, err := s.db.PendingDialog(ctx, a.ID)
	if err != nil {
		return err
	}
	if d.Choose != nil {
		if d = d.Choose(); d.Details == "" {
			return nil
		}
	}
	if ok && (!d.Replaces || (pending.Action == d.Action && pending.Details == d.Details)) {
		return nil
	}
	live, err := s.liveReviewers(ctx, a)
	if err != nil {
		return err
	}
	if err := s.unportedAsk(ctx, a, "delegate", live); err != nil {
		return err
	}
	// The earlier dialog's request is withdrawn only once the newer one reached its reviewer, so a reviewer that can't be
	// reached leaves the earlier request as it was.
	if _, err := s.requestPermission(ctx, a, d.Action, "its harness shows a dialog that blocks it", d.Details, true, "delegate"); err != nil {
		return err
	}
	if ok {
		return s.withdrawDialog(ctx, a, pending, "a newer dialog replaced it")
	}
	return nil
}

// DialogClosed is src/permissions.ts dialogClosed: the agent moved on, so its dialog needs no answer through stam.
func (s *Server) DialogClosed(ctx context.Context, a db.Agent) error {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	r, ok, err := s.db.PendingDialog(ctx, a.ID)
	if err != nil || !ok {
		return err
	}
	return s.withdrawDialog(ctx, a, r, "closed outside stam")
}

// DialogClosedIf is DialogClosed for the pending dialog whose details match accepts, read and withdrawn under one hold
// of permMu (src/adapters/opencode.ts checks the row's permission id before dialogClosed).
func (s *Server) DialogClosedIf(ctx context.Context, a db.Agent, match func(details string) bool) error {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	r, ok, err := s.db.PendingDialog(ctx, a.ID)
	if err != nil || !ok || !match(r.Details) {
		return err
	}
	return s.withdrawDialog(ctx, a, r, "closed outside stam")
}

// withdrawDialog is src/permissions.ts withdrawDialog: the request closes with its waits, the human's copy of its mail
// is withdrawn, and the org settles. A request settled meanwhile is left as it is.
func (s *Server) withdrawDialog(ctx context.Context, a db.Agent, r db.PermissionRequest, note string) error {
	ok, err := s.db.WithdrawPermissionRequest(ctx, r.ID, note)
	if err != nil || !ok {
		return err
	}
	ids, err := s.db.PermissionMailIDs(ctx, r.ID)
	if err != nil {
		return err
	}
	s.withdrawQuietly(ctx, ids, "stam", "Withdrawn: "+note)
	if err := s.db.AddEvent(ctx, a.ID, "permission:withdrawn", map[string]string{"id": r.ID, "note": note}); err != nil {
		return err
	}
	s.orgResync(ctx, a.ID)
	return nil
}

// answerPermission is src/permissions.ts answerPermission: `by` is an agent id or the human. Someone else's answer to
// the human's ask pulls the human's mail about it.
func (s *Server) answerPermission(ctx context.Context, id string, approve bool, by, note string, peer *peerVouch) (jsfmt.Value, error) {
	s.permMu.Lock()
	defer s.permMu.Unlock()
	delegate := false
	if r, ok, err := s.db.PermissionRequestByID(ctx, id); err != nil {
		return jsfmt.Value{}, err
	} else if ok {
		delegate = r.Audience == "delegate"
	}
	out, err := s.answer(ctx, id, approve, by, note, peer)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if by != humanBox && !delegate {
		ids, err := s.db.PermissionMailIDs(ctx, id)
		if err != nil {
			return jsfmt.Value{}, err
		}
		verdict := "denied"
		if approve {
			verdict = "approved"
		}
		s.withdrawQuietly(ctx, ids, by, "Answered by @"+s.byName(ctx, by)+": "+verdict)
	}
	return out, nil
}

// approvedTyped is src/permissions.ts approvedTyped: the line typed into an agent when the human approves. It names the
// request and starts with "I authorize" (auto mode takes only typed input as the user's consent); a note other than the
// default is appended.
func (s *Server) approvedTyped(id, action, note string) (string, error) {
	kept := trailingDots.ReplaceAllString(jsjson.Trim(note), "")
	short := action
	if utf16Len(action) > 200 {
		short = sliceUnits(action, 200) + "…"
	}
	extra := ""
	if kept != "" && strings.ToLower(kept) != "i authorize" {
		extra = " The user's note: " + kept + "."
	}
	return s.render("permission-typed", map[string]string{"id": id, "action": short, "note": extra})
}

var trailingDots = regexp.MustCompile(`(?:` + jsSpaceClass + `|[.!])+$`)

// answeredNext is src/permissions.ts answeredNext: the closing line of the answered notice.
func answeredNext(approve bool) string {
	if approve {
		return "Go ahead; don't request it again."
	}
	return "Don't do it; continue without it."
}

func (s *Server) answeredNotice(id, action string, approve bool, who, text string) (string, error) {
	verdict := "denied"
	if approve {
		verdict = "approved"
	}
	n, err := s.render("permission-answered", map[string]string{"id": id, "action": action, "verdict": verdict, "who": who, "note": text, "next": answeredNext(approve)})
	if err != nil || approve {
		return n, err
	}
	return s.withFailureRetro(n), nil
}

type answeredEvent struct {
	ID      string `json:"id"`
	Approve bool   `json:"approve"`
	By      string `json:"by"`
	Typed   bool   `json:"typed"`
}

func withTyped(v jsfmt.Value, typed bool) jsfmt.Value {
	v.Set("typed", jsfmt.Value{Kind: jsfmt.Bool, Bool: typed})
	return v
}

// answer is src/permissions.ts answer for a request or a dialog.
func (s *Server) answer(ctx context.Context, id string, approve bool, by, note string, peer *peerVouch) (jsfmt.Value, error) {
	c, err := s.checked(ctx, id, by, peer)
	if err != nil {
		return jsfmt.Value{}, err
	}
	r, a := c.r, c.a
	text := note
	if text == "" {
		text = "Denied"
		if approve {
			text = "I authorize"
		}
	}
	name := s.byName(ctx, by)
	who := "your user (the human), in stam"
	if by != humanBox {
		role := "the chief of staff agent"
		switch {
		case c.assistant:
			role = "your user's executive assistant"
		case by == deref(a.ParentID):
			role = "your parent agent"
		case c.boss:
			role = "the chief of staff agent on another machine"
		}
		who = name + ", " + role
	}
	if s.tpl == nil {
		return jsfmt.Value{}, unported("permission requests need the templates, which this server has not loaded")
	}
	if r.Payload != nil {
		return s.answerSettings(ctx, r, a, approve, by, text, who)
	}
	if r.Dialog {
		// A question dialog's choice is the note: the option the human picked. Empty when none was given.
		return s.answerDialog(ctx, r, a, approve, by, text, who, note)
	}
	if r.Kind == "input" {
		return s.denyInput(ctx, r, a, approve, by, text, who)
	}
	// The audience is checked again in the decision's transaction: an escalation between the two can't let an agent's
	// yes through.
	agentsYes := func(r db.PermissionRequest) error {
		if approve && by != humanBox && r.Audience == "human" {
			return fmt.Errorf("request %s is the human's to approve: leave it to the human, or deny it if it must not happen", id)
		}
		return nil
	}
	if err := agentsYes(r); err != nil {
		return jsfmt.Value{}, err
	}
	n, err := s.answeredNotice(id, r.Action, approve, who, text)
	if err != nil {
		return jsfmt.Value{}, err
	}
	// The decision and its notice's row commit together (S-3923): no answer exists without its row.
	decided, row, err := s.db.DecidePermissionRequestNoticed(ctx, id, approve, by, text, agentsYes, &db.NewAnswerNotice{AgentID: a.ID, Text: n})
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !decided {
		return jsfmt.Value{}, s.notPending(ctx, id)
	}
	// The human's approval is typed into the agent's input when that's safe, since auto mode takes only typed input as the
	// user's consent. Agents' answers stay notices.
	typed := false
	if approve && by == humanBox && s.life != nil {
		s.life.AdmitHuman(ctx, a.ID)
		line, err := s.approvedTyped(id, r.Action, note)
		if err != nil {
			return jsfmt.Value{}, err
		}
		typed = s.life.TypeHumanInput(ctx, a, line)
	}
	if typed {
		if row != 0 {
			if err := s.db.DeleteAnswerNotice(ctx, row); err != nil {
				return jsfmt.Value{}, err
			}
		}
	} else {
		s.queueAnswerRow(ctx, a.ID, n, row)
	}
	if err := s.db.AddEvent(ctx, a.ID, "permission:answered", answeredEvent{ID: id, Approve: approve, By: by, Typed: typed}); err != nil {
		return jsfmt.Value{}, err
	}
	s.orgResync(ctx, a.ID)
	out, err := s.publicRequest(ctx, id)
	return withTyped(out, typed), err
}

// notPending is checked's refusal for a request settled after it was read.
func (s *Server) notPending(ctx context.Context, id string) error {
	r, ok, err := s.db.PermissionRequestByID(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("no permission request %s", id)
	}
	return fmt.Errorf("request %s is already %s", id, r.Status)
}

// answerDialog is src/permissions.ts answerDialog: a harness dialog's answer is a key typed into it. Only the human's
// approval is a yes; anyone reviewing can deny it. A dialog no longer on screen closes the request instead; an answer
// that can't be tied to the request's dialog types nothing and leaves it pending (a no too, unlike TS, so it never lands
// on a dialog that replaced it). What the screen shows instead never closes it, as in TS.
func (s *Server) answerDialog(ctx context.Context, r db.PermissionRequest, a db.Agent, approve bool, by, text, who, choice string) (jsfmt.Value, error) {
	if approve && by != humanBox {
		then := "leave it to the human"
		if r.Audience == "delegate" {
			then = "escalate it to the human with a one-line reason"
		}
		return jsfmt.Value{}, fmt.Errorf("only the human approves a harness dialog; deny it so %s carries on without it, or %s", a.Name, then)
	}
	done := "gone"
	if s.life != nil {
		fresh, err := s.db.GetAgent(ctx, a.ID)
		if err != nil {
			return jsfmt.Value{}, err
		}
		done = s.life.AnswerDialog(ctx, fresh, r.Details, approve, choice)
	}
	// The human can look at the terminal; a reviewing agent can't, and escalates instead.
	then := "look at its terminal, then try again or answer it there"
	switch {
	case by != humanBox && r.Audience == "delegate":
		then = "escalate it to the human with a one-line reason, who can answer it in the terminal"
	case by != humanBox:
		then = "leave it to the human, who can answer it in the terminal"
	}
	if done == "failed" && a.Harness == "opencode" {
		return jsfmt.Value{}, fmt.Errorf("stam couldn't answer %s's OpenCode permission (a call to the server failed or timed out, or the agent ran again meanwhile), so it may not have been answered and request %s stays pending; %s", a.Name, r.ID, then)
	}
	switch done {
	case "failed":
		return jsfmt.Value{}, fmt.Errorf("stam couldn't type into %s's dialog (a tmux call failed or timed out, or its session changed meanwhile), so the key may not have been typed and request %s stays pending; %s", a.Name, r.ID, then)
	case "unsure":
		return jsfmt.Value{}, fmt.Errorf("stam can't confirm that %s's screen shows this request's dialog (it may show another one), so nothing was typed and request %s stays pending; %s", a.Name, r.ID, then)
	case "unsafe":
		return jsfmt.Value{}, fmt.Errorf("%s's dialog on screen doesn't show exactly this request's action or question with the answer given, so nothing was typed; deny it, or answer it in the terminal", a.Name)
	case "gone":
		if err := s.withdrawDialog(ctx, a, r, "no dialog on screen"); err != nil {
			return jsfmt.Value{}, err
		}
		return jsfmt.Value{}, fmt.Errorf("%s no longer shows this dialog, so request %s is closed and nothing was typed", a.Name, r.ID)
	}
	// A bare approval says nothing more than the key typed; one with a comment says it in the same notice (S-3829). The
	// notice is written with the decision (S-3923).
	var notice *db.NewAnswerNotice
	var noticeText string
	if !approve || commentOf(text) != "" {
		n, err := s.answeredNotice(r.ID, r.Action, approve, who, text)
		if err != nil {
			return jsfmt.Value{}, err
		}
		noticeText, notice = n, &db.NewAnswerNotice{AgentID: a.ID, Text: n}
	}
	decided, row, err := s.db.DecidePermissionRequestNoticed(ctx, r.ID, approve, by, text, nil, notice)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !decided {
		return jsfmt.Value{}, s.notPending(ctx, r.ID)
	}
	if err := s.db.AddEvent(ctx, a.ID, "permission:answered", answeredEvent{ID: r.ID, Approve: approve, By: by, Typed: true}); err != nil {
		return jsfmt.Value{}, err
	}
	// Claude Code reads Esc as an interrupt, which runs no hook: the agent is idle now, and the notice saying why starts
	// its next turn. OpenCode carries on after a rejected permission, or ends the turn, and its events say which (S-4237):
	// nothing is written for it here, so a launch since never has its state overwritten.
	if !approve && a.Harness != "opencode" {
		if err := s.db.UpdateAgent(ctx, a.ID, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "activity_detail", Val: "dialog denied"}); err != nil {
			return jsfmt.Value{}, err
		}
	}
	if notice != nil {
		s.queueAnswerRow(ctx, a.ID, noticeText, row)
	}
	s.orgResync(ctx, a.ID)
	out, err := s.publicRequest(ctx, r.ID)
	return withTyped(out, true), err
}

// commentOf is src/permissions.ts commentOf: the human's comment on an answer, unless it is the default a bare Approve or
// Deny sends (S-3829).
func commentOf(note string) string {
	kept := jsjson.Trim(note)
	if kept == "" || strings.ToLower(kept) == "i authorize" || kept == "Denied" {
		return ""
	}
	return kept
}

func (s *Server) permissionRoutes() {
	s.handle("GET /api/permissions", s.listPermissions)
	s.handle("POST /api/permissions", s.postPermission)
	s.handle("POST /api/permissions/{id}/answer", s.answerRoute)
	s.handle("POST /api/suggest-input", s.suggestInputRoute)
}

// textOf is `String(body[k] ?? "")`.
func textOf(body *jsjson.Object, k string) string {
	v := get(body, k)
	if v == nil {
		return ""
	}
	return claude.JSString(v)
}

// listPermissions is GET /api/permissions: the requests with ?status (else the newest 100), with ?audience. An agent's
// token lists its own requests and its tree's; the bosses and the human list all.
func (s *Server) listPermissions(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	audience := q.Get("audience")
	var own map[string]bool
	if viewer, ok := s.usageViewer(ctx, c, q.Get("as")); ok {
		own = map[string]bool{viewer: true}
		if a, err := s.db.GetAgent(ctx, viewer); err == nil {
			own = map[string]bool{a.ID: true}
			kids, err := s.descendants(ctx, a.ID)
			if err != nil {
				return nil, err
			}
			for k := range kids {
				own[k] = true
			}
		}
	}
	rs, err := s.db.ListPermissionRequests(ctx, q.Get("status"))
	if err != nil {
		return nil, err
	}
	out := []jsfmt.Value{}
	for _, x := range rs {
		if (audience != "" && x.Audience != audience) || (own != nil && !own[x.AgentID]) {
			continue
		}
		v, err := s.db.PublicRequest(ctx, x, s.cfg.Machine)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return jsfmt.ArrayValue(out), nil
}

// usageViewer is src/daemon.ts usageViewer: the agent whose tree an agent's token reads, false for the bosses, the
// human and every other caller.
func (s *Server) usageViewer(ctx context.Context, c auth.Resolved, as string) (string, bool) {
	if c.Kind != auth.Agent && c.Kind != auth.OpenCode {
		return "", false
	}
	me := as
	if c.Kind == auth.Agent {
		me = c.Agent
	}
	if c.Boss || (me != "" && (s.chiefOfStaffID(ctx) == me || s.isAssistant(ctx, me))) {
		return "", false
	}
	return me, true
}

// postPermission is POST /api/permissions: the agent (its own, or the one it names as `agent`) asks. A request with no
// audience comes from an agent whose tool schema predates the field: it is a delegate ask.
func (s *Server) postPermission(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	id, err := s.actor(ctx, c.Caller, textOf(w.body, "agent"))
	if err != nil {
		return nil, err
	}
	a, err := s.mustAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	raw := get(w.body, "audience")
	omitted := raw == nil || raw == ""
	audience, _ := raw.(string)
	if !omitted && audience != "human" && audience != "delegate" {
		return nil, Errorf(http.StatusBadRequest, "audience must be 'human' when only your user's consent unblocks it (a harness or auto-mode safety block, an irreversible or outward action, spend above the caps), or 'delegate' when your parent or the chief of staff can decide it (they escalate to your user if needed)")
	}
	if omitted {
		audience = "delegate"
	}
	out, err := s.requestPermission(ctx, a, textOf(w.body, "action"), textOf(w.body, "reason"), textOf(w.body, "details"), false, audience)
	if err != nil {
		return nil, err
	}
	if omitted {
		if err := s.db.AddEvent(ctx, a.ID, "permission:audience-defaulted", defaultedEvent{ID: out.Text("id"), Audience: out.Text("audience")}); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// answerRoute is POST /api/permissions/:id/answer: the human or a reviewing agent approves, denies or escalates.
func (s *Server) answerRoute(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	id := r.PathValue("id")
	pr, held, err := s.db.PermissionRequestByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if held && pr.Kind == "input" && jsjson.Truthy(get(w.body, "approve")) {
		return s.approveInputRoute(ctx, w, c, id)
	}
	// A request from an agent on another machine is answered by the daemon that owns it.
	if !w.local && !held && textOf(w.body, "machine") != s.cfg.Machine {
		if out, done, err := s.relayAnswer(ctx, r, c, w); done {
			return out, err
		}
	}
	// A daemon that doesn't hold the request says so before any auth check, so a probe finds the holder.
	if w.local && !held {
		return nil, Errorf(http.StatusNotFound, "no permission request %s", id)
	}
	byRaw := textOf(w.body, "by")
	peerAgent := false
	if w.local && c.Kind == auth.Agent && byRaw != "" && byRaw == c.Agent {
		if _, err := s.db.GetAgent(ctx, byRaw); errors.Is(err, db.ErrNotFound) {
			peerAgent = true
		}
	}
	by := ""
	switch {
	case peerAgent:
		by = byRaw
	case jsjson.Truthy(get(w.body, "by")):
		a, err := s.mustAgent(ctx, byRaw)
		if err != nil {
			return nil, err
		}
		by = a.ID
	case w.human:
		by = humanBox
	}
	if by == "" {
		return nil, Errorf(http.StatusForbidden, "an answer must come from the human or a reviewing agent; the human answers %s", s.humanWays("stam"))
	}
	var peer *peerVouch
	if peerAgent {
		peer = &peerVouch{boss: c.Boss}
	}
	note := textOf(w.body, "note")
	decision := get(w.body, "decision")
	var out jsfmt.Value
	switch {
	case decision == "escalate":
		out, err = s.escalatePermission(ctx, id, by, note, peer)
	case jsjson.Truthy(decision) && decision != "approve" && decision != "deny":
		err = errors.New("decision must be approve, deny or escalate")
	default:
		approve := jsjson.Truthy(get(w.body, "approve"))
		if jsjson.Truthy(decision) {
			approve = decision == "approve"
		}
		out, err = s.answerPermission(ctx, id, approve, by, note, peer)
	}
	if err != nil {
		var he *Error
		if errors.As(err, &he) {
			return nil, err
		}
		return nil, Errorf(http.StatusConflict, "%s", err.Error())
	}
	return out, nil
}
