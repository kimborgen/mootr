package server

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// POST /api/itsas/:ref/post (src/daemon.ts over src/itsa.ts post, S-2849 PR 3b): a comment or update in the ITSA's mail
// thread, created with the first post. Recipients are the participants minus the sender plus those named in `to`; posting
// makes the sender a participant. The mail interrupts a working recipient only when it names them as `@name`, comes from the
// human, or comes from the ITSA's owner; the rest arrives with the idle batch.
//
// Stam's own post (`from_stam`) and the ask mail (kind ask) stand in as the oldest active agent. Answered 501, before
// anything is stored: a sender, owner or participant on a peer; attachments; and the shapes of `to`, `only`, `inferred` and
// `subject` that TS would coerce.

var healths = []string{"on_track", "at_risk", "off_track"}

// refuseStamFields is src/daemon.ts refuseStamFields: the fields only stam sets, refused from an agent's token (a peer's own
// call may carry them).
func refuseStamFields(body jsfmt.Value, c auth.Resolved, fields []string, what string) error {
	if !c.Caller.IsAgent() || c.Local {
		return nil
	}
	var own []string
	for _, f := range fields {
		if _, ok := body.Get(f); ok {
			own = append(own, f)
		}
	}
	if len(own) == 0 {
		return nil
	}
	verb := "is"
	if len(own) > 1 {
		verb = "are"
	}
	return Errorf(http.StatusForbidden, "%s %s set only by stam, not in an agent's %s", strings.Join(own, ", "), verb, what)
}

func (s *Server) itsaPostRoute(r *http.Request, c auth.Resolved) (any, error) {
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
	if err := s.resolveItsaActors(ctx, c, &body); err != nil {
		return nil, err
	}
	human := s.isHuman(r, c)
	// Only stam posts as stam: the daemon itself, or a peer's daemon forwarding its post (S-480).
	if _, ok := body.Get("from_stam"); ok && !(c.Local && c.Kind == auth.Shared) {
		return nil, Errorf(http.StatusForbidden, "from_stam is set only by stam")
	}
	// The same fields as mail (S-945), but kind and health are a post's own: a comment or an update.
	var own []string
	for _, f := range stamFields {
		if f != "kind" && f != "health" {
			own = append(own, f)
		}
	}
	if err := refuseStamFields(body, c, own, "post"); err != nil {
		return nil, err
	}
	by, err := itsaActor(body, human, systemBodyOK(c, human, body))
	if err != nil {
		return nil, err
	}
	if err := s.mayActOn(ctx, c, by, ref, true); err != nil {
		return nil, err
	}
	body.Set("by", jsfmt.StringValue(by))
	run := func() (any, error) {
		sent, err := s.post(ctx, ref, body, false)
		if err != nil {
			return nil, asItsaErr(err)
		}
		return sent, nil
	}
	clientID := ""
	if v, ok := body.Get("client_id"); ok && v.Kind == jsfmt.String {
		clientID = v.Str
	}
	return s.sends.run(string(c.Kind)+":"+c.Agent+"|"+r.URL.Path, clientID, run)
}

// post is src/itsa.ts post on the home daemon: in is the request's body (by already resolved to the actor).
func (s *Server) post(ctx context.Context, ref string, in jsfmt.Value, ask bool) (jsfmt.Value, error) {
	// Stam's own post stands in as the oldest active agent and never joins the ITSA as a participant.
	asStam := false
	if v, ok := in.Get("from_stam"); ok && v.Truthy() {
		asStam = true
	}
	byV, hasBy := in.Get("by")
	by, sys := "", ""
	if asStam {
		id, ok, err := s.db.FirstActiveAgentID(ctx)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if !ok {
			return jsfmt.Value{}, errors.New("no running agent to stand in as stam")
		}
		by = id
	} else if hasBy && byV.Kind == jsfmt.String && strings.HasPrefix(byV.Str, "system:") {
		by, sys = byV.Str, strings.TrimPrefix(byV.Str, "system:")
	} else {
		p, err := s.person(ctx, byV, hasBy)
		if err != nil {
			return jsfmt.Value{}, err
		}
		by = p
		if by == "" {
			by = humanBox
		}
	}
	bodyV, hasBody := in.Get("body")
	body := ""
	if hasBody && bodyV.Kind != jsfmt.Null {
		body = db.JSStr(bodyV)
	}
	if db.JSTrim(body) == "" {
		return jsfmt.Value{}, errors.New("a post needs a body")
	}
	kind := "comment"
	if v, ok := in.Get("kind"); ok && v.Truthy() {
		kind = db.JSStr(v)
	}
	// Only stam's own ask has kind ask: an agent's post naming it would skip the mail gate (S-983).
	if ask {
		kind = "ask"
	}
	if kind != "comment" && kind != "update" && !(kind == "ask" && ask) {
		return jsfmt.Value{}, errors.New("unknown kind " + kind + "; use comment or update")
	}
	health := ""
	hv, hasHealth := in.Get("health")
	if kind == "update" {
		if hasHealth && hv.Kind != jsfmt.Null {
			health = db.JSStr(hv)
		}
		if !contains(healths, health) {
			return jsfmt.Value{}, errors.New("an update needs a health: " + strings.Join(healths, ", "))
		}
	} else if hasHealth && hv.Truthy() {
		return jsfmt.Value{}, errors.New("only an update has a health")
	}
	toList, err := stringList(in, "to")
	if err != nil {
		return jsfmt.Value{}, err
	}
	guessedList, err := stringList(in, "inferred")
	if err != nil {
		return jsfmt.Value{}, err
	}
	guessed := map[string]bool{}
	for _, g := range guessedList {
		guessed[g] = true
	}
	var extra []string
	for _, r := range toList {
		if guessed[r] {
			continue
		}
		p, err := s.person(ctx, jsfmt.StringValue(r), true)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if p != "" {
			extra = append(extra, p)
		}
	}
	if v, ok := in.Get("attachments"); ok && v.Truthy() {
		return jsfmt.Value{}, Errorf(http.StatusNotImplemented, "attachments are not ported to the Go daemon yet")
	}
	subject, hasSubject, err := optString(in, "subject")
	if err != nil {
		return jsfmt.Value{}, err
	}
	replyTo, _, err := optString(in, "reply_to")
	if err != nil {
		return jsfmt.Value{}, err
	}
	override, _, err := optString(in, "override")
	if err != nil {
		return jsfmt.Value{}, err
	}
	only, hasOnly := in.Get("only")
	if hasOnly && only.Truthy() && only.Kind != jsfmt.Array {
		return jsfmt.Value{}, Errorf(http.StatusNotImplemented, "an `only` that is not a list is not ported to the Go daemon yet")
	}

	x, err := s.mustItsa(ctx, ref)
	if err != nil {
		return jsfmt.Value{}, err
	}
	itsaID := x.Text("id")
	// An agent whose model may not mail the human still comments in the thread; the human just isn't a recipient.
	quiet := false
	if sys == "" && by != humanBox && !asStam && !ask {
		_, _, blocked, err := s.humanMailBlock(ctx, by)
		if err != nil {
			return jsfmt.Value{}, err
		}
		quiet = blocked
	}
	// A participant that is gone (archived, forgotten) is skipped: the post still lands for the rest (S-281).
	var live []string
	onlyList := by == humanBox && hasOnly && only.Truthy()
	// An ask goes to the human alone, so the participants (and whether each is gone) do not matter to it.
	if !onlyList && !ask {
		people, err := s.db.ItsaParticipants(ctx, itsaID)
		if err != nil {
			return jsfmt.Value{}, err
		}
		for _, p := range people {
			ok, err := s.deliverable(ctx, p)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if ok {
				live = append(live, p)
			}
		}
	}
	// So is a recipient the sender didn't name, such as the web UI's reply to the thread's senders (S-603).
	for _, r := range guessedList {
		if !contains(toList, r) {
			continue
		}
		p, err := s.inferredPerson(ctx, r)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if p == "" {
			continue
		}
		ok, err := s.deliverable(ctx, p)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if ok {
			live = append(live, p)
		}
	}
	// An agent's comment never mails the human unless it names them: the move to a human status mails them once.
	agentsOnly := false
	if v, ok := in.Get("agents_only"); ok {
		agentsOnly = v.Truthy()
	}
	toHuman := !agentsOnly && (asStam || ask || by == humanBox || contains(extra, humanBox))
	var recipients []string
	seen := map[string]bool{}
	candidates := append(append([]string(nil), live...), extra...)
	if ask {
		candidates = []string{humanBox}
	}
	for _, p := range candidates {
		if seen[p] {
			continue
		}
		seen[p] = true
		if p != by && !(quiet && p == humanBox) && (p != humanBox || toHuman) {
			recipients = append(recipients, p)
		}
	}
	everyone := by == humanBox || by == x.Text("owner")
	var interrupt []string
	for _, r := range recipients {
		if everyone {
			interrupt = append(interrupt, r)
			continue
		}
		var names []string
		if r != humanBox {
			names = []string{r, ""}
			if a, err := s.db.GetAgent(ctx, r); err == nil {
				names[1] = a.Name
			}
		}
		if mentions(body, names) {
			interrupt = append(interrupt, r)
		}
	}

	// What send would answer 501 comes first, so a post that is not ported leaves the thread and the sender's place in it as
	// they were (a refusal TS itself makes still follows the allocation, as in TS).
	override = sliceUnits(strings.TrimSpace(override), 500)
	if err := s.sendNotPorted(ctx, by, body, kind, override, recipients, asStam); err != nil {
		return jsfmt.Value{}, err
	}

	// Allocate the thread before sending, so two first posts can't start two threads.
	threadID, first, err := s.db.AllocateItsaThread(ctx, itsaID)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if sys == "" && !asStam && !ask {
		if err := s.db.EnsureItsaParticipant(ctx, itsaID, by); err != nil {
			return jsfmt.Value{}, err
		}
	}
	root := x.Text("key") + " " + x.Text("title")
	if !hasSubject || subject == "" {
		subject = "Re: " + root
		if first {
			subject = root
		}
	}
	inferred := map[string]bool{}
	for _, p := range recipients {
		if !contains(extra, p) {
			inferred[p] = true
		}
	}
	mailIn := &sendIn{
		from: by, fromShown: by, to: recipients, subject: subject, body: body, replyTo: replyTo, inferred: inferred,
		override: override, system: sys, hasSystem: sys != "", fromStam: asStam,
		itsa: &itsaMail{id: itsaID, threadID: threadID, kind: kind, health: health, interrupt: interrupt},
	}
	return s.send(ctx, mailIn)
}

// sendNotPorted is the 501s send makes for a mail to recipients from `by` (the embed, the mail gate and the observers of a
// stored mail), asked before a post writes anything.
func (s *Server) sendNotPorted(ctx context.Context, by, body, kind, override string, recipients []string, fromStam bool) error {
	if err := embedRefusal(body); err != nil {
		return err
	}
	// Stam's own mail is not rerouted, gated or looked at by the observers of an agent's mail.
	if fromStam {
		return nil
	}
	toHuman := contains(recipients, humanBox)
	if sender, err := s.db.GetAgent(ctx, by); err == nil {
		if toHuman {
			if _, ok, err := s.humanReroute(ctx, sender, s.chiefOfStaffID(ctx)); err != nil {
				return err
			} else if ok {
				toHuman = false
			}
		}
	} else if !errors.Is(err, db.ErrNotFound) {
		return err
	}
	if toHuman && by != humanBox && !strings.HasPrefix(by, "system:") && override == "" {
		if err := s.gateRefusal(kind == "ask"); err != nil {
			return err
		}
	}
	return s.mailObserverRefusal(ctx, by, toHuman)
}

// deliverable is itsa.ts deliverable for a participant: the human always, a local agent unless archived. An agent this
// daemon remembers from a peer would be asked of that peer, which this daemon cannot do yet.
func (s *Server) deliverable(ctx context.Context, id string) (bool, error) {
	if id == humanBox {
		return true, nil
	}
	a, err := s.db.GetAgent(ctx, id)
	if err == nil {
		return a.Lifecycle != "archived", nil
	}
	if !errors.Is(err, db.ErrNotFound) {
		return false, err
	}
	if peer, err := s.db.HasPeerAgent(ctx, id); err != nil {
		return false, err
	} else if peer {
		return false, Errorf(http.StatusNotImplemented, "%s is an agent of a peer machine, and posting to a peer's agent is not ported to the Go daemon yet", id)
	}
	return false, nil
}

// inferredPerson is itsa.ts inferredPerson: the id of a recipient the sender didn't name, or "" when nobody has it any more.
func (s *Server) inferredPerson(ctx context.Context, ref string) (string, error) {
	if ref == humanBox {
		return humanBox, nil
	}
	if a, err := s.db.GetAgent(ctx, ref); err == nil {
		return a.ID, nil
	}
	if peer, err := s.db.HasPeerAgent(ctx, ref); err != nil {
		return "", err
	} else if peer {
		return "", Errorf(http.StatusNotImplemented, "%s is an agent of a peer machine, and posting to a peer's agent is not ported to the Go daemon yet", ref)
	}
	return "", nil
}

// stringList reads a body member that is a list of strings; a missing or null one is empty. Anything else TS would coerce.
func stringList(in jsfmt.Value, key string) ([]string, error) {
	v, ok := in.Get(key)
	if !ok || v.Kind == jsfmt.Null {
		return nil, nil
	}
	if v.Kind != jsfmt.Array {
		return nil, Errorf(http.StatusNotImplemented, "a `%s` that is not a list is not ported to the Go daemon yet", key)
	}
	var out []string
	for _, it := range v.Items {
		if it.Kind != jsfmt.String {
			return nil, Errorf(http.StatusNotImplemented, "a `%s` with an entry that is not a string is not ported to the Go daemon yet", key)
		}
		out = append(out, it.Str)
	}
	return out, nil
}

// optString reads a body member that is a string; absent, null and "" read as empty. Another type TS would coerce.
func optString(in jsfmt.Value, key string) (string, bool, error) {
	v, ok := in.Get(key)
	if !ok || v.Kind == jsfmt.Null {
		return "", false, nil
	}
	if v.Kind != jsfmt.String {
		if !v.Truthy() {
			return "", false, nil
		}
		return "", false, Errorf(http.StatusNotImplemented, "a `%s` that is not a string is not ported to the Go daemon yet", key)
	}
	return v.Str, v.Str != "", nil
}

// mentions is itsa.ts mentions: whether the body names one of the names as `@name` (or `@id`), not inside a longer word,
// ignoring case: /(^|[^\w-])@NAME(?![\w-])/i.
func mentions(body string, names []string) bool {
	for _, n := range names {
		if n == "" {
			continue
		}
		for i := 0; i < len(body); i++ {
			if body[i] != '@' || (i > 0 && isKeyChar(body[i-1])) {
				continue
			}
			end := i + 1 + len(n)
			if end > len(body) || !strings.EqualFold(body[i+1:end], n) {
				continue
			}
			if end == len(body) || !isKeyChar(body[end]) {
				return true
			}
		}
	}
	return false
}

func isKeyChar(c byte) bool {
	return c == '-' || c == '_' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}
