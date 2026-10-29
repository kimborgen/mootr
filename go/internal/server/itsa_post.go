package server

import (
	"context"
	"errors"
	"net/http"
	neturl "net/url"
	"strconv"
	"strings"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// POST /api/itsas/:ref/post (src/daemon.ts over src/itsa.ts post, S-2849 PR 3b): a comment or update in the ITSA's mail
// thread, created with the first post. Recipients are the participants minus the sender plus those named in `to`; posting
// makes the sender a participant. The mail interrupts a working recipient only when it names them as `@name`, comes from the
// human, or comes from the ITSA's owner; the rest arrives with the idle batch.
//
// Stam's own post (`from_stam`) and the ask mail (kind ask) stand in as the oldest active agent. A sender on a peer's post
// is relayed (forwarded with relay): sent from here as that agent. Answered 501, before anything is stored: the shapes of
// `to`, `only`, `inferred` and `subject` that TS would coerce.

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
	return s.postShown(ctx, ref, in, ask, "", "")
}

// postShown is post with src/itsa.ts post's opts.shown: the ITSA text the body renders and its revision (shownText). The
// revision is recorded for the mail once it is sent (S-2998), and only if the stored body is the body sent, uncut. A rev
// of "" records nothing.
func (s *Server) postShown(ctx context.Context, ref string, in jsfmt.Value, ask bool, shownText, shownRev string) (jsfmt.Value, error) {
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
	var attachments []jsfmt.Value
	if v, ok := in.Get("attachments"); ok && v.Kind == jsfmt.Array {
		attachments = v.Items
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
			} else if known, ok, _ := s.db.PeerAgentByID(ctx, r); ok {
				// A peer's recipient was looked up, and remembered, when it was found deliverable or named: no second ask.
				names[1] = known.Name
			}
		}
		if mentions(body, names) {
			interrupt = append(interrupt, r)
		}
	}

	// only_to is the people the sender's daemon checked a reach-limited agent's post against (reachRefusal): one the post
	// would reach outside it (a participant added since, or the successor one forwards its mail to) refuses the post before
	// anything is stored or sent. send checks the final recipients again, and a peer its own. It only narrows delivery, so
	// it counts from any caller.
	var onlyTo []string
	hasOnlyTo := false
	if v, ok := in.Get("only_to"); ok && v.Kind != jsfmt.Null {
		var err error
		if onlyTo, err = stringList(in, "only_to"); err != nil {
			return jsfmt.Value{}, err
		}
		hasOnlyTo = true
		for _, r := range recipients {
			target, err := s.db.ForwardTarget(ctx, r)
			if err != nil {
				return jsfmt.Value{}, err
			}
			for _, id := range []string{r, target} {
				if !contains(onlyTo, id) {
					return jsfmt.Value{}, Errorf(http.StatusConflict, "the ITSA's people changed since the post was checked (%s is new to it); try again", s.agentLabel(ctx, id))
				}
			}
		}
	}

	// What send would answer 501 comes first, so a post that is not ported leaves the thread and the sender's place in it as
	// they were (a refusal TS itself makes still follows the allocation, as in TS).
	override = sliceUnits(strings.TrimSpace(override), 500)
	if err := s.sendNotPorted(ctx, by, body, kind, override, recipients, asStam, itsaID); err != nil {
		return jsfmt.Value{}, err
	}

	// Allocate the thread before sending, so two first posts can't start two threads.
	threadID, first, err := s.db.AllocateItsaThread(ctx, itsaID)
	if err != nil {
		return jsfmt.Value{}, err
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
		itsa: &itsaMail{id: itsaID, threadID: threadID, kind: kind, health: health, interrupt: interrupt}, attachments: attachments,
		onlyTo: onlyTo, hasOnlyTo: hasOnlyTo,
	}
	// The sender of a remote agent's post is relayed: its id isn't in this registry (itsa.ts post remoteName).
	if remoteName, ok, err := s.remoteSenderName(ctx, by, sys, asStam); err != nil {
		return jsfmt.Value{}, err
	} else if ok {
		mailIn.forwarded, mailIn.relay, mailIn.fwdFromName, mailIn.fwdThreadID = true, true, remoteName, threadID
		mailIn.relayRoute = parseRelayRoute(in)
	}
	sent, err := s.send(ctx, mailIn)
	// The sender joins once its mail is sent: a refused post (S-4163) leaves the ITSA's people as they were.
	if err == nil && sys == "" && !asStam && !ask {
		if err := s.db.EnsureItsaParticipant(ctx, itsaID, by); err != nil {
			return jsfmt.Value{}, err
		}
	}
	if err != nil || shownRev == "" {
		return sent, err
	}
	// Only an uncut body counts: the mail cap may cut it, and a copy of the text elsewhere in it doesn't.
	stored, ok, err := s.db.GetMail(ctx, sent.Text("id"))
	if err != nil || !ok || !strings.Contains(body, shownText) || stored.Text("body") != body {
		return sent, err
	}
	return sent, s.recordShownRev(ctx, sent.Text("id"), itsaID, shownRev, body, shownText)
}

// postOnHome is itsa.ts postRouted off the home: an answer in an ITSA's thread is posted on the home, as the agent `from`
// (via), which the home checks; the human's carries the human as relayHuman allows. A 403 is the home's refusal, with its
// message; any other failure names the home, never its URL or a token. Files attached by path go as their content.
func (s *Server) postOnHome(ctx context.Context, ref string, req jsfmt.Value, from, cos string) (jsfmt.Value, error) {
	home := s.settings.Get().Itsa.Home
	peer, ok := s.homePeer()
	if !ok {
		return jsfmt.Value{}, errors.New("ITSA home '" + home + "' is not a configured peer")
	}
	to, err := stringList(req, "to")
	if err != nil {
		return jsfmt.Value{}, err
	}
	checked, err := s.reachRefusal(ctx, from, ref, to)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if checked != nil {
		req.Set("only_to", jsfmt.ArrayValue(stringValues(checked)))
	}
	if v, ok := req.Get("attachments"); ok && v.Kind == jsfmt.Array {
		atts, err := attachmentsB64(v.Items)
		if err != nil {
			return jsfmt.Value{}, err
		}
		req.Set("attachments", jsfmt.ArrayValue(atts))
	}
	var via *peers.Via
	if from != humanBox && !strings.HasPrefix(from, "system:") {
		via = &peers.Via{Agent: from, Boss: from == cos || s.isAssistant(ctx, from)}
	}
	carry, err := s.relayHuman(peer, from == humanBox, true, "POST /api/itsas/:id/post", true)
	if err != nil {
		return jsfmt.Value{}, err
	}
	// The routing facts of this daemon's agent, for the home to apply the S-548 rule to a relayed original (S-4163).
	if facts, ok, err := s.relayRouteOf(ctx, from); err != nil {
		return jsfmt.Value{}, err
	} else if ok {
		req.Set("relay_route", facts.value())
	}
	r, err := s.peers.Call(ctx, peer, http.MethodPost, "/api/itsas/"+neturl.PathEscape(ref)+"/post", req, itsaHomeTimeout, carry, via)
	if err != nil {
		return jsfmt.Value{}, Errorf(http.StatusServiceUnavailable, "%s (the ITSA home) is unreachable", home)
	}
	if r.Status != http.StatusOK {
		why := r.Data.Text("error")
		if why == "" {
			why = home + ": HTTP " + strconv.Itoa(r.Status)
		}
		why = s.scrubPeerURLs(s.peers.RedactText(peer, why))
		// A 409 on a checked post is the home finding the ITSA's people changed since the check: refused, never sent unchecked.
		if r.Status == http.StatusForbidden || (checked != nil && r.Status == http.StatusConflict) {
			return jsfmt.Value{}, Errorf(http.StatusForbidden, "%s", why)
		}
		return jsfmt.Value{}, errors.New(why)
	}
	return r.Data, nil
}

// reachRefusal is the check the home can't make for a post off the home by an agent here whose parent limited whom it may
// reach (visibility reach parent or tree): the home sends the post to the ITSA's participants and has no row for the
// sender. The participants are read from the home, as the agent; the post is refused (403) when one of them other than
// the sender, or a recipient it names in to, is outside the limit, and when the home doesn't answer (503), never sent
// unchecked. TS doesn't check it at all (S-4100 2c-3 review). An agent with no limit, or none here, isn't checked.
//
// It returns the people it checked (nil when it checked nothing): the post carries them as only_to, so the home refuses
// it if the participants changed between this read and the post (409), which the caller answers 403.
func (s *Server) reachRefusal(ctx context.Context, id, ref string, to []string) ([]string, error) {
	a, err := s.db.GetAgent(ctx, id)
	if errors.Is(err, db.ErrNotFound) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	allowed, limited, err := s.reachable(ctx, a)
	if err != nil || !limited {
		return nil, err
	}
	x, err := s.toHome(ctx, http.MethodGet, "/api/itsas/"+neturl.PathEscape(ref), nil, homeTimeout, &itsaVia{agent: a.ID})
	switch {
	case isHomeRefusal(err):
		return nil, err
	case err != nil:
		return nil, Errorf(http.StatusServiceUnavailable, "%s, so %s's post can't be checked against the limit its parent set; try again", err.Error(), a.Name)
	}
	var people []string
	if v, ok := x.Get("participants"); ok && v.Kind == jsfmt.Array {
		for _, p := range v.Items {
			people = append(people, anyString(p))
		}
	}
	cos := s.chiefOfStaffID(ctx)
	which := "its tree"
	if a.VisibilityOf().Reach == "parent" {
		which = "its parents"
	}
	checked := []string{a.ID}
	for _, ref := range append(people, to...) {
		p, err := s.recipientID(ctx, ref)
		if err != nil {
			return nil, err
		}
		if p == humanBox || p == a.ID || p == cos || allowed[p] {
			checked = append(checked, p)
			continue
		}
		return nil, Errorf(http.StatusForbidden, "%s may not post on this ITSA: its parent limited it to %s, and the post would reach %s. Mail your parent instead", a.Name, which, s.agentLabel(ctx, p))
	}
	return checked, nil
}

// recipientID is the id of a recipient as a post names it: the human, an agent here, or one a peer has (remembered, else
// asked); a name nobody has stays as it is, and so is outside every limit.
func (s *Server) recipientID(ctx context.Context, ref string) (string, error) {
	if ref == humanBox || strings.ToLower(strings.TrimSpace(ref)) == "the human" {
		return humanBox, nil
	}
	if a, err := s.db.GetAgent(ctx, ref); err == nil {
		return a.ID, nil
	} else if !errors.Is(err, db.ErrNotFound) {
		return "", err
	}
	if known, ok, err := s.db.FindPeerAgent(ctx, ref); err != nil || ok {
		return known.ID, err
	}
	if hit, found, err := s.peers.Locate(ctx, s.db, ref); err == nil && found == peers.Found {
		return hit.Agent.ID, nil
	}
	return ref, nil
}

// remoteSenderName is the name of a post's sender that is an agent of another machine, as its peer answers for it, else
// its id; ok is false for the human, a system sender, stam's own post and an agent here.
func (s *Server) remoteSenderName(ctx context.Context, by, sys string, asStam bool) (string, bool, error) {
	if by == humanBox || sys != "" || asStam {
		return "", false, nil
	}
	if _, err := s.db.GetAgent(ctx, by); err == nil {
		return "", false, nil
	} else if !errors.Is(err, db.ErrNotFound) {
		return "", false, err
	}
	hit, found, err := s.peers.Locate(ctx, s.db, by)
	if err != nil {
		return "", false, ambiguous(err)
	}
	if found == peers.Found {
		return hit.Agent.Name, true, nil
	}
	return by, true, nil
}

// sendNotPorted is the 501s send makes for a mail to recipients from `by` (the embed, the mail gate and the observers of a
// stored mail), asked before a post writes anything. itsaID is the ITSA the post is in ("" for none).
func (s *Server) sendNotPorted(ctx context.Context, by, body, kind, override string, recipients []string, fromStam bool, itsaID string) error {
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
			var itsas []string
			if itsaID != "" {
				itsas = []string{itsaID}
			}
			if _, ok, err := s.humanReroute(ctx, sender, s.chiefOfStaffID(ctx), itsas); err != nil {
				return err
			} else if ok {
				toHuman = false
			}
		}
	} else if !errors.Is(err, db.ErrNotFound) {
		return err
	}
	return s.humanRefusals(ctx, by, kind, override, toHuman)
}

// humanRefusals is the gate and the observers' refusals of a mail from by, given whether it reaches the human directly.
func (s *Server) humanRefusals(ctx context.Context, by, kind, override string, toHuman bool) error {
	if toHuman && by != humanBox && !strings.HasPrefix(by, "system:") && override == "" {
		if err := s.gateRefusal(kind == "ask"); err != nil {
			return err
		}
	}
	return s.mailObserverRefusal(ctx, by, toHuman)
}

// deliverable is itsa.ts deliverable for a participant: the human always, an agent here unless archived, and an agent of
// another machine as its peer answers for it; when no peer answers, the lifecycle last seen of it (S-281).
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
	hit, found, err := s.peers.Locate(ctx, s.db, id)
	switch {
	case err != nil:
		return false, ambiguous(err)
	case found == peers.Found:
		return hit.Agent.Lifecycle != "archived", nil
	case found == peers.Unreachable:
		lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, id)
		return err == nil && lifecycle != "archived", err
	}
	return false, nil
}

// inferredPerson is itsa.ts inferredPerson: the id of a recipient the sender didn't name, or "" when nobody has it any
// more. Unlike person, an agent this daemon remembers from a peer that doesn't answer still counts (S-603).
func (s *Server) inferredPerson(ctx context.Context, ref string) (string, error) {
	if ref == humanBox {
		return humanBox, nil
	}
	if a, err := s.db.GetAgent(ctx, ref); err == nil {
		return a.ID, nil
	}
	if known, ok, err := s.db.FindPeerAgent(ctx, ref); err != nil {
		return "", err
	} else if ok {
		return known.ID, nil
	}
	// person(ref).catch(() => null): any failure is no one.
	id, err := s.person(ctx, jsfmt.StringValue(ref), true)
	if err != nil {
		return "", nil
	}
	return id, nil
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
