package server

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The ITSA routes of src/daemon.ts over src/itsa.ts (S-2849, PR 1): the status set, list, get, create and set.
//
// Not ported yet, and each answers 501 naming it: the proxy to another ITSA home, fields (their values in a create or a
// set, and their routes), links and the post, thread and act routes, the peer-only routes, search, queue, attention and
// cost, and the moves that run what TS runs on a status change: the human's ask when an ITSA enters or leaves a human
// status, the retro and process proposals and requirement approvals (kind proposal, requirement-approval), and the epic
// retro offered on closing a project or initiative.
//
// Left out without an error, as in the mail slices: the notice to a parent ITSA's owner when a child is blocked, waits on
// the human or closes, the observers of a change (decision steps, requirement checks, the search index, the process
// runner), and agents that live on a peer (an owner, participant or actor not known here answers "no agent").

// itsaCategories is src/itsa.ts CATEGORIES: board columns and roll-up buckets, in order.
var itsaCategories = []string{"backlog", "ready", "active", "review", "closed"}

const (
	retroKind  = "retro"
	reportKind = "feedback-report"
)

var (
	reItsaID = regexp.MustCompile(`^[\w-]+$`)
	// reSystemActor is src/itsa.ts systemActor's name rule.
	reSystemActor = regexp.MustCompile(`^[a-z][a-z-]{1,39}$`)
	// refusedKinds are the kinds whose status changes and creates run code this daemon does not have (retro-loop.ts,
	// process-proposal.ts, req-approval.ts).
	refusedKinds = map[string]bool{"proposal": true}
	epicKinds    = map[string]bool{"project": true, "initiative": true}
)

// agentRefused are the reads an agent's token may not make, by route, with what notAgentToken says it can't do.
var agentRefused = map[string]string{
	"GET /api/itsas/queue":     "read the merge queue",
	"GET /api/itsas/attention": "read what waits on the human",
	"GET /api/itsas/{id}/cost": "read an ITSA's cost",
}

func (s *Server) itsaRoutes() {
	s.handle("GET /api/itsas/statuses", s.itsaStatusRoute)
	s.handle("GET /api/processes", s.processesRoute)
	s.handle("POST /api/processes/{id}/proposal", s.processProposalRoute)
	s.handle("GET /api/itsas", s.itsaListRoute)
	s.handle("POST /api/itsas", s.itsaCreateRoute)
	s.handle("GET /api/itsas/{id}", s.itsaGetRoute)
	s.handle("PATCH /api/itsas/{id}", s.itsaSetRoute)
	s.linkRoutes()
	s.ringRoutes()
	s.fieldRoutes()
	s.handle("POST /api/itsas/{id}/post", s.itsaPostRoute)
	s.handle("POST /api/itsas/{id}/act", s.itsaActRoute)
	s.handle("GET /api/itsas/{id}/thread", s.itsaThreadRoute)
	s.handle("GET /api/itsas/{id}/threads", s.itsaThreadsRoute)
	s.handle("GET /api/itsas/attention", s.itsaAttentionRoute)
	s.handle("GET /api/itsas/search", s.itsaSearchRoute)
	s.handle("GET /api/itsas/{id}/plus-ones", s.itsaPlusOnesRoute)
	s.handle("GET /api/itsas/{id}/incident", s.itsaIncidentRoute)
	s.peerHookRoutes()
	// The routes this daemon does not carry yet. Each is listed by its method and path so that a path TS has no route for
	// stays "no route", and none is read as an ITSA's key.
	for _, p := range []string{
		"GET /api/itsas/queue", "GET /api/itsas/open-agents",
		"GET /api/itsas/{id}/cost",
	} {
		what := p[strings.Index(p, " ")+1:]
		s.handle(p, func(_ *http.Request, c auth.Resolved) (any, error) {
			// TS refuses an agent's token on these three reads before anything else (src/daemon.ts notAgentToken).
			if verb, ok := agentRefused[p]; ok {
				if msg := auth.NotAgentToken(c.Caller, verb); msg != "" {
					return nil, Errorf(http.StatusForbidden, "%s", msg)
				}
			}
			return nil, Errorf(http.StatusNotImplemented, "%s is not ported to the Go daemon yet", what)
		})
	}
}

// itsaErr maps a failure as src/daemon.ts itsaRoute does: a missing ITSA, link or field is 404, a status that moved is
// 409, anything else 400.
func itsaErr(format string, args ...any) *Error {
	e := Errorf(http.StatusBadRequest, format, args...)
	switch {
	case strings.HasPrefix(e.Message, "no ITSA ") || strings.HasPrefix(e.Message, "no link ") || strings.HasPrefix(e.Message, "no field "):
		e.Status = http.StatusNotFound
	case strings.HasPrefix(e.Message, "status changed"), strings.HasPrefix(e.Message, textChanged), strings.HasPrefix(e.Message, "the owner changed"), strings.HasPrefix(e.Message, "the parent changed"):
		e.Status = http.StatusConflict
	}
	return e
}

// asItsaErr turns an error from the db layer or a plan into the route's: an *Error stays, a plain error is mapped by its text.
func asItsaErr(err error) error {
	var e *Error
	if err == nil || errors.As(err, &e) {
		return err
	}
	var np *db.NotPorted
	if errors.As(err, &np) {
		return Errorf(http.StatusNotImplemented, "%s", np.Msg)
	}
	if strings.HasPrefix(err.Error(), "db: ") {
		return err
	}
	return itsaErr("%s", err.Error())
}

// notHome is the backstop of the ITSA-home proxy (relay.go itsaHome), which answers a request a daemon that is not the home
// would proxy before it reaches a route: only a settings change between the two can get here.
func (s *Server) notHome(c auth.Resolved) error {
	if home := s.settings.Get().Itsa.Home; !c.Local && home != s.cfg.Machine {
		return Errorf(http.StatusNotImplemented, "this daemon is not the ITSA home (%s)", home)
	}
	return nil
}

// --- settings ---

// itsaStatuses is src/itsa.ts statuses(): the configured statuses in the five known categories.
func (s *Server) itsaStatuses() []config.ItsaStatus {
	var out []config.ItsaStatus
	for _, st := range s.settings.Get().Itsa.Statuses {
		for _, c := range itsaCategories {
			if st.Category == c {
				out = append(out, st)
				break
			}
		}
	}
	return out
}

func (s *Server) statusOf(name string) (config.ItsaStatus, bool) {
	for _, st := range s.itsaStatuses() {
		if st.Name == name {
			return st, true
		}
	}
	return config.ItsaStatus{}, false
}

func (s *Server) isClosedStatus(name string) bool {
	st, ok := s.statusOf(name)
	return ok && st.Category == "closed"
}

func (s *Server) statusNames() string {
	var names []string
	for _, st := range s.itsaStatuses() {
		names = append(names, st.Name)
	}
	return strings.Join(names, ", ")
}

// actionsOf is src/itsa.ts actionsOf: what the human can do in a status, none unless it waits on them.
func (s *Server) actionsOf(status string) []config.HumanAction {
	st, ok := s.statusOf(status)
	if !ok || !st.Human {
		return nil
	}
	listed, has := s.settings.Get().Itsa.Actions[status]
	if !has {
		closed := "done"
		for _, x := range s.itsaStatuses() {
			if x.Category == "closed" {
				closed = x.Name
				break
			}
		}
		listed = []config.HumanAction{
			{ID: "approve", Label: "Approve", To: closed, Text: "optional"},
			{ID: "changes", Label: "Request changes", To: "in_progress", Text: "required"},
		}
	}
	var out []config.HumanAction
	for _, a := range listed {
		if _, ok := s.statusOf(a.To); ok {
			out = append(out, a)
		}
	}
	return out
}

func actionsValue(list []config.HumanAction) jsfmt.Value {
	items := make([]jsfmt.Value, 0, len(list))
	for _, a := range list {
		o := jsfmt.Value{Kind: jsfmt.Object}
		o.Set("id", jsfmt.StringValue(a.ID))
		o.Set("label", jsfmt.StringValue(a.Label))
		o.Set("to", jsfmt.StringValue(a.To))
		o.Set("text", jsfmt.StringValue(a.Text))
		items = append(items, o)
	}
	return jsfmt.ArrayValue(items)
}

func (s *Server) itsaStatusRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	cats := make([]jsfmt.Value, 0, len(itsaCategories))
	for _, c := range itsaCategories {
		cats = append(cats, jsfmt.StringValue(c))
	}
	sts := []jsfmt.Value{}
	for _, st := range s.itsaStatuses() {
		o := jsfmt.Value{Kind: jsfmt.Object}
		o.Set("name", jsfmt.StringValue(st.Name))
		o.Set("category", jsfmt.StringValue(st.Category))
		o.Set("human", jsfmt.Value{Kind: jsfmt.Bool, Bool: st.Human})
		sts = append(sts, o)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("categories", jsfmt.ArrayValue(cats))
	out.Set("statuses", jsfmt.ArrayValue(sts))
	return out, nil
}

// --- people and lookups ---

// person is src/itsa.ts person: an owner or participant, an agent id or name, or `human`, as an id; "" for none. An agent
// on another machine resolves through the peers (findAgentPeerFresh), as mail resolves remote recipients, so the home can
// store and edit an ITSA a remote agent owns. An agent no one has is an error, and so is a name two agents match.
func (s *Server) person(ctx context.Context, v jsfmt.Value, present bool) (string, error) {
	if !present || v.Kind == jsfmt.Null {
		return "", nil
	}
	ref := strings.TrimSpace(anyString(v))
	if ref == "" {
		return "", nil
	}
	if ref == humanBox || strings.ToLower(ref) == "the human" {
		return humanBox, nil
	}
	a, err := s.db.GetAgent(ctx, ref)
	if errors.Is(err, db.ErrNotFound) {
		hit, err := s.peers.LocateFresh(ctx, s.db, ref)
		var amb *peers.AmbiguousError
		switch {
		case errors.As(err, &amb):
			return "", itsaErr("%s", amb.Msg)
		case err != nil:
			return "", err
		case hit != nil:
			return hit.Agent.ID, nil
		}
		return "", itsaErr("no agent %s (pass an agent id or name, or 'human')", ref)
	}
	if err != nil {
		return "", err
	}
	return a.ID, nil
}

var (
	// reAnswers is retro-loop.ts answersOf's line, reMemory memoryTypesIn's header. Go's \s is ASCII only, so \p{Z} adds the
	// Unicode spaces JS's \s has, and the line breaks JS's ^ honours are turned into \n first.
	reAnswers = regexp.MustCompile(`(?m)^[\s\p{Z}\x{feff}]*Answers:`)
	reMemory  = regexp.MustCompile(`(?m)^(?:diff --git a/|\+\+\+ b/)blocks/type-[\w-]+/99-memory\.md`)
	reBreaks  = strings.NewReplacer("\r\n", "\n", "\r", "\n", "\u2028", "\n", "\u2029", "\n")
)

// retroGate answers 501 where retro-loop.ts would act: its gate runs for any actor but the human on a body that changes a
// type's memory block (a diff header naming blocks/type-NAME/99-memory.md) or answers retro items (an Answers: line), and
// closeAnswered closes the items an ITSA answers when it reaches done. Neither is ported, so no such write is made.
func retroGate(body string, byHuman, toDone bool) error {
	body = reBreaks.Replace(body)
	if !byHuman && reMemory.MatchString(body) {
		return Errorf(http.StatusNotImplemented, "a body that changes a type's memory block is checked by the retro gate, which is not ported to the Go daemon yet")
	}
	if (!byHuman || toDone) && reAnswers.MatchString(body) {
		return Errorf(http.StatusNotImplemented, "a body with an Answers: line is checked by the retro gate, and closing it closes the retro items it answers (closeAnswered); neither is ported to the Go daemon yet")
	}
	return nil
}

func (s *Server) personOf(ctx context.Context, body jsfmt.Value, key string) (string, error) {
	v, ok := body.Get(key)
	return s.person(ctx, v, ok)
}

func (s *Server) mustItsa(ctx context.Context, ref string) (jsfmt.Value, error) {
	x, ok, err := s.db.FindItsa(ctx, ref)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !ok {
		return jsfmt.Value{}, itsaErr("no ITSA %s", ref)
	}
	return x, nil
}

// ancestorsOf is src/itsa.ts ancestorsOf: an ITSA's ancestors, its parent first, stopping at a loop.
func (s *Server) ancestorsOf(ctx context.Context, x jsfmt.Value) ([]jsfmt.Value, error) {
	var out []jsfmt.Value
	seen := map[string]bool{x.Text("id"): true}
	for pid := x.Text("parent_id"); pid != ""; {
		p, ok, err := s.db.FindItsa(ctx, pid)
		if err != nil {
			return nil, err
		}
		if !ok || seen[p.Text("id")] {
			break
		}
		seen[p.Text("id")] = true
		out = append(out, p)
		pid = p.Text("parent_id")
	}
	return out, nil
}

func strs(list []string) jsfmt.Value {
	items := make([]jsfmt.Value, 0, len(list))
	for _, x := range list {
		items = append(items, jsfmt.StringValue(x))
	}
	return jsfmt.ArrayValue(items)
}

// rollup is src/itsa.ts rollupOf: the counts of an ITSA's direct children by category.
func (s *Server) rollup(ctx context.Context, id string) (jsfmt.Value, error) {
	counts, err := s.db.ItsaStatusCounts(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	by := map[string]int{}
	for status, n := range counts {
		if st, ok := s.statusOf(status); ok {
			by[st.Category] += n
		}
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, c := range itsaCategories {
		out.Set(c, jsfmt.IntValue(int64(by[c])))
	}
	return out, nil
}

// itsaView is src/itsa.ts get: the row, its participants and links, its chain of ancestors (root first), the roll-up of
// its children, each child with the roll-up of its own, its latest events and the human's actions.
func (s *Server) itsaView(ctx context.Context, x jsfmt.Value) (jsfmt.Value, error) {
	id := x.Text("id")
	anc, err := s.ancestorsOf(ctx, x)
	if err != nil {
		return jsfmt.Value{}, err
	}
	chain := make([]jsfmt.Value, 0, len(anc))
	for i := len(anc) - 1; i >= 0; i-- {
		o := jsfmt.Value{Kind: jsfmt.Object}
		for _, k := range []string{"id", "key", "title", "status"} {
			v, _ := anc[i].Get(k)
			o.Set(k, v)
		}
		chain = append(chain, o)
	}
	kidRows, err := s.db.ItsaChildren(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	kids := make([]jsfmt.Value, 0, len(kidRows))
	for _, k := range kidRows {
		ru, err := s.rollup(ctx, k.Text("id"))
		if err != nil {
			return jsfmt.Value{}, err
		}
		k.Set("rollup", ru)
		kids = append(kids, k)
	}
	people, err := s.db.ItsaParticipants(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	links, err := s.db.ItsaLinks(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	events, err := s.db.ItsaEvents(ctx, id, 100)
	if err != nil {
		return jsfmt.Value{}, err
	}
	values, err := s.db.ItsaFieldValues(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	ru, err := s.rollup(ctx, id)
	if err != nil {
		return jsfmt.Value{}, err
	}
	fields, ok := values[id]
	if !ok {
		fields = jsfmt.Value{Kind: jsfmt.Object}
	}
	x.Set("participants", strs(people))
	x.Set("links", jsfmt.ArrayValue(nonNilValues(links)))
	x.Set("parent_chain", jsfmt.ArrayValue(chain))
	x.Set("rollup", ru)
	x.Set("children", jsfmt.ArrayValue(kids))
	x.Set("events", jsfmt.ArrayValue(nonNilValues(events)))
	x.Set("actions", actionsValue(s.actionsOf(x.Text("status"))))
	x.Set("fields", fields)
	x.Set("rev", jsfmt.StringValue(revOf(x)))
	return x, nil
}

func nonNilValues(v []jsfmt.Value) []jsfmt.Value {
	if v == nil {
		return []jsfmt.Value{}
	}
	return v
}

// --- who acts ---

// systemBodyOK is src/daemon.ts systemBodies: the shared token (not the human) may send an ITSA action as one of the local
// scripts that are allowed a system sender.
func systemBodyOK(c auth.Resolved, human bool, body jsfmt.Value) bool {
	if c.Kind != auth.Shared || human {
		return false
	}
	v, ok := body.Get("as_system")
	return ok && contains(systemSenders, anyString(v))
}

// itsaActor is src/daemon.ts itsaActor: the actor an ITSA request acts as. `as_system` names a local script (only the human,
// or the shared token as an allowed script, sends one); else `by`, which only a human request may set to the human; else the
// human for a human request.
func itsaActor(body jsfmt.Value, human, systemOK bool) (string, error) {
	if v, ok := body.Get("as_system"); ok {
		if !human && !systemOK {
			return "", Errorf(http.StatusForbidden, "only the human sends an ITSA action as a system sender")
		}
		name := ""
		if v.Kind != jsfmt.Null {
			name = anyString(v)
		}
		if !reSystemActor.MatchString(name) {
			return "", Errorf(http.StatusBadRequest, "bad system sender %s", name)
		}
		return "system:" + name, nil
	}
	if v, ok := body.Get("by"); ok && v.Truthy() {
		b := strings.TrimSpace(anyString(v))
		if !human && (b == humanBox || strings.ToLower(b) == "the human") {
			return "", Errorf(http.StatusForbidden, "only your user acts as the human on an ITSA")
		}
		if strings.HasPrefix(b, "system:") {
			return "", Errorf(http.StatusForbidden, "a system sender is named with system, not by")
		}
		if b != "" {
			return b, nil
		}
	} else if human {
		return humanBox, nil
	}
	return "", Errorf(http.StatusForbidden, "an ITSA action needs an agent (by) or the human")
}

// humanMailBlock is src/mail.ts humanMailBlock: the agent whose model may not mail the human, with its parent (or the
// chief of staff) named.
func (s *Server) humanMailBlock(ctx context.Context, agentID string) (model, parent string, blocked bool, err error) {
	a, err := s.db.GetAgent(ctx, agentID)
	if errors.Is(err, db.ErrNotFound) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if s.mayMailHuman(a.Model) {
		return "", "", false, nil
	}
	parents, err := s.db.ParentsOf(ctx, a)
	if err != nil {
		return "", "", false, err
	}
	pid := s.chiefOfStaffID(ctx)
	if len(parents) > 0 {
		pid = parents[0]
	}
	if pid != "" {
		parent = s.agentLabel(ctx, pid)
	}
	return *a.Model, parent, true, nil
}

func handTo(parent string) string {
	if parent == "" {
		return ""
	}
	return " (" + parent + ")"
}

// --- membership (src/mail-visibility.ts) ---

func isOpenBoard(kind string) bool { return kind == retroKind || kind == reportKind }

// isMember is src/mail-visibility.ts isMember: whether the agent id is one an ITSA belongs to.
func (s *Server) isMember(ctx context.Context, me string, x jsfmt.Value, participants bool) (bool, error) {
	if s.chiefOfStaffID(ctx) == me || s.isAssistant(ctx, me) {
		return true, nil
	}
	if x.Text("owner") == me {
		return true, nil
	}
	if participants {
		if x.Text("created_by") == me {
			return true, nil
		}
		people, err := s.db.ItsaParticipants(ctx, x.Text("id"))
		if err != nil {
			return false, err
		}
		if contains(people, me) {
			return true, nil
		}
	}
	anc, err := s.ancestorsOf(ctx, x)
	if err != nil {
		return false, err
	}
	for _, p := range anc {
		if p.Text("owner") == me {
			return true, nil
		}
	}
	return false, nil
}

// mayReadItsaThreads is src/mail-visibility.ts mayReadItsaThreads.
func (s *Server) mayReadItsaThreads(ctx context.Context, me, itsaID string) (bool, error) {
	x, err := s.mustItsa(ctx, itsaID)
	if err != nil {
		return false, err
	}
	return s.isMember(ctx, me, x, true)
}

func (s *Server) itsaName(ctx context.Context, id string) string { return s.agentLabel(ctx, id) }

// itsaRefusal is src/mail-visibility.ts itsaRefusal: why an agent may not change an ITSA, and who may.
func (s *Server) itsaRefusal(ctx context.Context, me string, x jsfmt.Value, verb string) (string, error) {
	anc, err := s.ancestorsOf(ctx, x)
	if err != nil {
		return "", err
	}
	var owners []string
	for _, o := range append([]jsfmt.Value{x}, anc...) {
		if v := o.Text("owner"); v != "" {
			owners = append(owners, v)
		}
	}
	boardOnly := verb == "change" && isOpenBoard(x.Text("kind"))
	if !boardOnly {
		people, err := s.db.ItsaParticipants(ctx, x.Text("id"))
		if err != nil {
			return "", err
		}
		owners = append(owners, people...)
	}
	var who []string
	seen := map[string]bool{}
	for _, o := range owners {
		if !seen[o] {
			seen[o] = true
			if o != humanBox {
				who = append(who, s.itsaName(ctx, o))
			}
		}
	}
	may := "only its owner and participants, the owners of its parent ITSAs, the chief of staff, the assistant, and the human may"
	how := "Ask one of them to add you as a participant."
	if verb == "post to" {
		how = s.joinAsk(ctx, me, x)
	}
	if boardOnly {
		may = "only its owner, the owners of its parent ITSAs, the chief of staff, the assistant, and the human may change it"
		how = "Ask one of them to make the change."
	}
	list := ""
	if len(who) > 0 {
		list = " (" + strings.Join(who, ", ") + ")"
	}
	return s.itsaName(ctx, me) + " can't " + verb + " " + x.Text("key") + ": " + may + list + ". " + how, nil
}

// joinAsk is src/mail-visibility.ts joinAsk: the fix named when an agent may not post to an ITSA (S-2424).
func (s *Server) joinAsk(ctx context.Context, me string, x jsfmt.Value) string {
	var asked []string
	if o := x.Text("owner"); o != "" && o != humanBox {
		asked = append(asked, "the owner, "+s.itsaName(ctx, o))
	}
	if a, err := s.db.GetAgent(ctx, me); err == nil && a.ParentID != nil {
		asked = append(asked, "the agent that spawned you ("+s.itsaName(ctx, *a.ParentID)+")")
	}
	who := "one of them"
	if len(asked) > 0 {
		who = strings.Join(asked, ", or ")
	}
	return "Ask " + who + " to add you with itsa_set participants."
}

// mayPostItsa is src/mail-visibility.ts mayPostItsa: anyone may post to an open board, else those the ITSA belongs to.
func (s *Server) mayPostItsa(ctx context.Context, me string, x jsfmt.Value) (bool, error) {
	if isOpenBoard(x.Text("kind")) {
		return true, nil
	}
	return s.isMember(ctx, me, x, true)
}

// mayActOnItsa is src/daemon.ts mayActOnItsa for an edit: an agent changes only an ITSA it belongs to (S-480).
func (s *Server) mayActOnItsa(ctx context.Context, c auth.Resolved, by, ref string) error {
	return s.mayActOn(ctx, c, by, ref, false)
}

// mayActOn is mayActOnItsa(caller, by, ref, act): a post is allowed where the agent may post (any participant of an open
// board may), an edit where it may change the ITSA.
func (s *Server) mayActOn(ctx context.Context, c auth.Resolved, by, ref string, post bool) error {
	if !c.Caller.IsAgent() || c.Caller.Boss {
		return nil
	}
	x, err := s.mustItsa(ctx, ref)
	if err != nil {
		return err
	}
	var ok bool
	verb := "change"
	if post {
		verb = "post to"
		ok = isOpenBoard(x.Text("kind"))
	}
	if ok {
		return nil
	}
	if ok, err = s.isMember(ctx, by, x, !(isOpenBoard(x.Text("kind")) && !post)); err != nil || ok {
		return err
	}
	msg, err := s.itsaRefusal(ctx, by, x, verb)
	if err != nil {
		return err
	}
	return Errorf(http.StatusForbidden, "%s", msg)
}

// --- events ---

// itsaEvent is src/itsa.ts itsaEvent: the itsa.changed payload.
func (s *Server) emitItsaChanged(ctx context.Context, x jsfmt.Value) {
	values, err := s.db.ItsaFieldValues(ctx, x.Text("id"))
	if err != nil {
		// The change is written already, so the event goes out without fields, and the log says why.
		slog.Error("ITSA changed event: fields", "itsa", x.Text("id"), "err", err)
	}
	_ = s.hub.Emit("itsa.changed", itsaChangedPayload(x, values, err))
}

// itsaChangedPayload is the itsa.changed payload: the ITSA's id, key, status and owner, and its fields. A read error leaves the
// fields key out, so the web keeps the card's fields rather than blanking them (web/src/store.ts) (S-3233).
func itsaChangedPayload(x jsfmt.Value, values map[string]jsfmt.Value, readErr error) jsfmt.Value {
	ev := jsfmt.Value{Kind: jsfmt.Object}
	for _, k := range []string{"id", "key", "status", "owner"} {
		v, _ := x.Get(k)
		ev.Set(k, v)
	}
	if readErr != nil {
		return ev
	}
	fields, ok := values[x.Text("id")]
	if !ok {
		fields = jsfmt.Value{Kind: jsfmt.Object}
	}
	ev.Set("fields", fields)
	return ev
}

// --- list and get ---

func (s *Server) itsaListRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := r.Context()
	q := r.URL.Query()
	var f db.ItsaFilter
	if q.Has("parent") {
		switch p := q.Get("parent"); p {
		case "", "root", "none":
			f.Root = true
		default:
			x, err := s.mustItsa(ctx, p)
			if err != nil {
				return nil, err
			}
			f.Parent = x.Text("id")
		}
	}
	if q.Has("subtree") {
		x, err := s.mustItsa(ctx, q.Get("subtree"))
		if err != nil {
			return nil, err
		}
		f.Subtree = x.Text("id")
	}
	if q.Has("status") {
		st := q.Get("status")
		f.Status = &st
	}
	if q.Has("category") {
		for _, st := range s.itsaStatuses() {
			if st.Category == q.Get("category") {
				f.Statuses = append(f.Statuses, st.Name)
			}
		}
		if len(f.Statuses) == 0 {
			return []jsfmt.Value{}, nil
		}
		f.StatusesGiven = true
	}
	if q.Has("owner") {
		o, err := s.person(ctx, jsfmt.StringValue(q.Get("owner")), true)
		if err != nil {
			return nil, err
		}
		f.Owner = o
	}
	if q.Has("participant") {
		p, err := s.person(ctx, jsfmt.StringValue(q.Get("participant")), true)
		if err != nil {
			return nil, err
		}
		f.Participant = p
	}
	if q.Has("kind") {
		k := q.Get("kind")
		f.Kind = &k
	}
	text, hasText := q.Get("text"), q.Has("text")
	if !hasText {
		text, hasText = q.Get("q"), q.Has("q")
	}
	if hasText {
		f.Text = strings.TrimSpace(text)
	}
	if q.Has("since") {
		since, err := sinceTime(q.Get("since"), time.Now())
		if err != nil {
			return nil, err
		}
		f.Since = &since
	}
	list, err := s.db.ListItsas(ctx, f)
	if err != nil {
		return nil, err
	}
	return nonNilValues(list), nil
}

// The `since` regexps and units of src/itsa.ts sinceTime: four digits at most, so an age stays in time.Duration's range.
var (
	sinceAge   = regexp.MustCompile(`^(\d{1,4})([mhdw])$`)
	sinceISO   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$`)
	sinceUnits = map[string]time.Duration{"m": time.Minute, "h": time.Hour, "d": 24 * time.Hour, "w": 7 * 24 * time.Hour}
)

// sinceTime is a `since` filter's time (S-1396) in created_at's form: an age back from now (90m, 24h, 2d, 1w), or an ISO
// date or a date-time with its zone. A bad one is a 400, not an empty list.
func sinceTime(text string, now time.Time) (string, error) {
	var t time.Time
	var err error
	if m := sinceAge.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		t = now.Add(-time.Duration(n) * sinceUnits[m[2]])
	} else if !sinceISO.MatchString(text) {
		err = errors.New("not an ISO time")
	} else if strings.Contains(text, "T") {
		t, err = time.Parse(time.RFC3339Nano, text)
	} else {
		t, err = time.Parse("2006-01-02", text)
	}
	if err != nil {
		return "", itsaErr("since expects an ISO time (2026-10-21, or 2026-10-21T08:00:00Z) or an age (90m, 24h, 2d, 1w); got %q", text)
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}

func (s *Server) itsaGetRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ref := r.PathValue("id")
	if !reItsaID.MatchString(ref) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	x, err := s.mustItsa(r.Context(), ref)
	if err != nil {
		return nil, err
	}
	v, err := s.itsaView(r.Context(), x)
	if err != nil {
		return nil, err
	}
	// The open ask this ITSA holds, as its mail and kind (S-3982): the text an agent reads of it (itsa_get), never the ask's text.
	held, err := s.heldItsas(r.Context())
	if err != nil {
		return nil, err
	}
	_, itsas, err := s.openAskLinks(r.Context(), held)
	if err != nil {
		return nil, err
	}
	ask, ok := itsas[v.Text("id")]
	v.Set("open_ask_detail", askDetail(ask, ok))
	return v, nil
}

// --- create ---

// optText is a body member as an optional text: absent or null is nil.
func optText(body jsfmt.Value, key string) *string {
	v, ok := body.Get(key)
	if !ok || v.Kind == jsfmt.Null {
		return nil
	}
	t := anyString(v)
	return &t
}

func (s *Server) itsaCreateRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	human := s.isHuman(r, c)
	// The ITSA's thread is stam's to start, with the first post (S-480): from an agent, a thread_id would alias another
	// ITSA's thread, to read and post there through this one.
	if _, has := body.Get("thread_id"); has && c.Caller.IsAgent() {
		return nil, Errorf(http.StatusForbidden, "thread_id is set only by stam")
	}
	actorID, err := itsaActor(body, human, systemBodyOK(c, human, body))
	if err != nil {
		return nil, err
	}

	return s.createItsa(ctx, body, actorID)
}

// createItsa is src/itsa.ts create on the home daemon: body is the request's (actors already resolved), actorID who creates.
func (s *Server) createItsa(ctx context.Context, body jsfmt.Value, actorID string) (any, error) {
	// src/itsa.ts create: validate and resolve everything first, then write once.
	titleV, _ := body.Get("title")
	title := ""
	if titleV.Kind != jsfmt.Null {
		title = strings.TrimSpace(anyString(titleV))
	}
	if title == "" {
		return nil, itsaErr("an ITSA needs a title")
	}
	status := ""
	if v, ok := body.Get("status"); ok && v.Truthy() {
		status = anyString(v)
	} else {
		status = s.defaultStatus()
	}
	st, ok := s.statusOf(status)
	if !ok {
		return nil, itsaErr("unknown status %s; statuses: %s", status, s.statusNames())
	}
	owner, err := s.personOf(ctx, body, "owner")
	if err != nil {
		return nil, err
	}
	by, err := s.person(ctx, jsfmt.StringValue(actorID), true)
	if err != nil {
		return nil, err
	}
	if by == "" {
		by = humanBox
	}
	var people []string
	if v, ok := body.Get("participants"); ok && v.Kind != jsfmt.Null {
		if v.Kind != jsfmt.Array {
			return nil, itsaErr("participants must be a list")
		}
		for _, p := range v.Items {
			id, err := s.person(ctx, p, true)
			if err != nil {
				return nil, err
			}
			if id != "" {
				people = append(people, id)
			}
		}
	}
	if owner != "" {
		people = append(people, owner)
	}
	people = dedup(people)
	var links []db.NewLink
	if v, ok := body.Get("links"); ok && v.Kind != jsfmt.Null {
		if v.Kind != jsfmt.Array {
			return nil, itsaErr("links must be a list")
		}
		for _, l := range v.Items {
			nl, err := s.validateLink(l)
			if err != nil {
				return nil, err
			}
			links = append(links, nl)
		}
	}
	if st.Human && by != humanBox {
		model, parent, blocked, err := s.humanMailBlock(ctx, by)
		if err != nil {
			return nil, err
		}
		if blocked {
			return nil, itsaErr("%s can't be created as %s: it would mail your user, and %s may not (Settings › Mail to you). Hand it to your parent%s with itsa_post or send_mail; it decides.", title, status, model, handTo(parent))
		}
	}
	parentID := ""
	if v, ok := body.Get("parent"); ok && v.Truthy() {
		p, err := s.mustItsa(ctx, anyString(v))
		if err != nil {
			return nil, err
		}
		parentID = p.Text("id")
	}
	kind := ""
	if v, ok := body.Get("kind"); ok && v.Truthy() {
		kind = anyString(v)
	}
	newBody := ""
	if p := optText(body, "body"); p != nil {
		newBody = *p
	}
	if refusedKinds[kind] {
		if processProposalOf(kind, newBody) == "" {
			return nil, Errorf(http.StatusNotImplemented, "an ITSA of kind %s runs code a status change triggers, which is not ported to the Go daemon yet", kind)
		}
		// A process change is filed by its own route (process_proposal.go); the retro gate still applies to the creator.
		if err := proposalGate(nil, nil, kind, status, newBody, by); err != nil {
			return nil, err
		}
	}
	if err := retroGate(newBody, by == humanBox, status == "done"); err != nil {
		return nil, err
	}
	// Created into a human status by an agent (or a script), it would mail the human its ask.
	if st.Human && by != humanBox {
		return nil, Errorf(http.StatusNotImplemented, "creating an ITSA in a status that waits on your user (it mails the ask) is not ported to the Go daemon yet")
	}
	if err := s.db.Inspect(ctx, func(tx db.ItsaTx) error {
		return s.observedRefusal(tx, observed{created: true, statusChanged: true, status: status, parentID: parentID, owner: owner, ownerChanged: owner != "", actor: by})
	}); err != nil {
		return nil, asItsaErr(err)
	}
	// Created at a stage, it enters that node: the entry the runner cannot act on yet is refused before the write.
	if fv, ok := body.Get("fields"); ok && fv.Kind == jsfmt.Object {
		if v, ok := fv.Get("stage"); ok && v.Kind == jsfmt.String {
			if err := s.stageEntryRefusal(ctx, "", kind, v.Str, by); err != nil {
				return nil, err
			}
		}
	}
	n := db.NewItsa{KeyPrefix: s.settings.Get().Itsa.KeyPrefix, Title: title, Status: status, Closed: st.Category == "closed",
		Owner: owner, Parent: parentID, By: by, Participants: people, Links: links,
		Summary: optText(body, "summary"), Body: optText(body, "body")}
	if kind != "" {
		n.Kind = &kind
	}
	if v, ok := body.Get("thread_id"); ok && v.Kind != jsfmt.Null {
		n.ThreadID = anyString(v)
	}
	if v, ok := body.Get("fields"); ok {
		n.Fields = &v
	}
	// Created at a stage, it enters that node in commit order like a set does.
	var start func()
	if n.Fields != nil {
		s.stages.queued.Add(1)
		s.stages.order.Lock()
		s.stages.queued.Add(-1)
	}
	created, err := s.db.CreateItsa(ctx, n)
	if err != nil {
		if n.Fields != nil {
			s.stages.order.Unlock()
		}
		return nil, asItsaErr(err)
	}
	if n.Fields != nil {
		if stage, err := s.db.ItsaStage(ctx, created.Text("id")); err != nil {
			slog.Error("process-run: stage", "itsa", created.Text("key"), "err", err)
		} else if stage != "" {
			start = s.onStage(ctx, stageEntry{id: created.Text("id"), key: created.Text("key"), kind: created.Text("kind"), to: stage, actor: by})
		}
		s.stages.order.Unlock()
	}
	s.syncItsaSubscriptions(ctx, created.Text("id"))
	s.emitItsaChanged(ctx, created)
	s.ownerStatusNotice(ctx, created, by)
	s.afterItsaChange(ctx, created, "created", by, "", "")
	s.indexItsa(created)
	if start != nil {
		start()
	}
	return created, nil
}

// defaultStatus is src/itsa.ts defaultStatus: `backlog` when it exists, else the first configured status.
func (s *Server) defaultStatus() string {
	all := s.itsaStatuses()
	for _, st := range all {
		if st.Name == "backlog" {
			return st.Name
		}
	}
	if len(all) > 0 {
		return all[0].Name
	}
	return "backlog"
}

func dedup(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, x := range in {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

// --- set ---

// jsNumber is JS Number(v) for a decoded JSON value: ok is false for NaN and the infinities.
func jsNumber(v jsfmt.Value) (float64, bool) {
	var f float64
	switch v.Kind {
	case jsfmt.Number:
		f, _ = strconv.ParseFloat(v.Num, 64)
	case jsfmt.Bool:
		if v.Bool {
			f = 1
		}
	case jsfmt.String:
		t := strings.TrimSpace(v.Str)
		if t == "" {
			return 0, true
		}
		var err error
		if f, err = strconv.ParseFloat(t, 64); err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return f, !math.IsNaN(f) && !math.IsInf(f, 0)
}

func numberValue(f float64) jsfmt.Value {
	return jsfmt.Value{Kind: jsfmt.Number, Num: strconv.FormatFloat(f, 'f', -1, 64)}
}

// strOrNull is a column's value as an optional string.
func strOrNull(v string, has bool) jsfmt.Value {
	if !has {
		return jsfmt.NullValue()
	}
	return jsfmt.StringValue(v)
}

func (s *Server) itsaSetRoute(r *http.Request, c auth.Resolved) (any, error) {
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
	by, err := itsaActor(body, human, systemBodyOK(c, human, body))
	if err != nil {
		return nil, err
	}
	// S-4178: the routing facts of a move a peer relayed come from that peer's DB (relay.go), never from an agent's body; they
	// ride the context, not the fields, and only a peer's relayed move carries them (relayRouteFrom).
	if err := refuseStamFields(body, c, []string{"relay_route"}, "edit"); err != nil {
		return nil, err
	}
	if c.Local {
		ctx = withRelayRoute(ctx, parseRelayRoute(body))
	}
	// `action` is recorded only by the human's act route, never from a request; `system` is not a field.
	f := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range body.Keys {
		if k != "action" && k != "system" && k != "relay_route" {
			f.Set(k, body.Items[i])
		}
	}
	if err := s.mayActOnItsa(ctx, c, by, ref); err != nil {
		return nil, err
	}
	if _, ok := f.Get("incident"); ok && !human && (by == "" || by != s.chiefOfStaffID(ctx)) {
		return nil, Errorf(http.StatusForbidden, "only the chief of staff or the human marks an ITSA as an incident (S-2406)")
	}
	if kv, ok := f.Get("kind"); ok && c.Caller.IsAgent() && !c.Caller.Boss {
		cur, err := s.mustItsa(ctx, ref)
		if err != nil {
			return nil, err
		}
		toBoard := kv.Kind == jsfmt.String && isOpenBoard(kv.Str)
		if toBoard != isOpenBoard(cur.Text("kind")) && s.chiefOfStaffID(ctx) != by && !s.isAssistant(ctx, by) {
			return nil, Errorf(http.StatusForbidden, "only the chief of staff or the assistant makes an ITSA a retro item or feedback report, or turns one into another kind")
		}
	}
	res, err := s.setItsa(ctx, ref, f, by)
	if err != nil {
		return nil, err
	}
	// Closing a project or initiative offers its epic retro (S-163), in the same result.
	out, _ := res.(jsfmt.Value)
	changes, _ := out.Get("changes")
	after, _ := out.Get("itsa")
	if _, ok := changes.Get("status"); ok && s.isClosedStatus(after.Text("status")) {
		offer, err := s.epicRetroOffer(ctx, after)
		if err != nil {
			return nil, err
		}
		if offer != "" {
			out.Set("retro_offer", jsfmt.StringValue(offer))
		}
	}
	return out, nil
}

func (s *Server) setItsa(ctx context.Context, ref string, f jsfmt.Value, by string) (any, error) {
	return s.setItsaMode(ctx, ref, f, by, false)
}

// setItsaMode is setItsa; with dry it runs the update's checks, which are where every 501 of a change comes from, and
// writes nothing: it returns the error the change would answer, or nil.
func (s *Server) setItsaMode(ctx context.Context, ref string, f jsfmt.Value, by string, dry bool) (any, error) {
	// Resolve the actor, owner and participants first (src/itsa.ts set), then read and write in one transaction.
	actor := by
	if !strings.HasPrefix(by, "system:") {
		p, err := s.person(ctx, jsfmt.StringValue(by), true)
		if err != nil {
			return nil, err
		}
		if actor = p; actor == "" {
			actor = humanBox
		}
	}
	system := strings.HasPrefix(actor, "system:")
	ownerV, hasOwner := f.Get("owner")
	owner := ""
	if hasOwner {
		o, err := s.person(ctx, ownerV, true)
		if err != nil {
			return nil, err
		}
		owner = o
	}
	var resolved []string
	partsV, hasParts := f.Get("participants")
	if hasParts {
		if partsV.Kind != jsfmt.Null && partsV.Kind != jsfmt.Array {
			return nil, itsaErr("participants must be a list")
		}
		for _, p := range partsV.Items {
			id, err := s.person(ctx, p, true)
			if err != nil {
				return nil, err
			}
			if id != "" {
				resolved = append(resolved, id)
			}
		}
		resolved = dedup(resolved)
	}
	statusV, hasStatus := f.Get("status")
	newStatus := ""
	if hasStatus {
		newStatus = anyString(statusV)
	}
	var blockModel, blockParent string
	blocked := false
	if hasStatus && actor != humanBox && !system {
		if st, ok := s.statusOf(newStatus); ok && st.Human {
			var err error
			if blockModel, blockParent, blocked, err = s.humanMailBlock(ctx, actor); err != nil {
				return nil, err
			}
		}
	}

	// S-4178: a relayed move's ask is routed by the owner the move leaves and, when it reroutes, by the parent. Both are read here,
	// before the transaction (a peer lookup writes, which can't run inside it), and the transaction checks them again.
	if facts := relayRouteFrom(ctx); facts != nil && hasStatus && actor != humanBox && !system {
		if st, ok := s.statusOf(newStatus); ok && st.Human {
			cur, err := s.mustItsa(ctx, ref)
			if err != nil {
				return nil, err
			}
			facts.routed = true
			facts.owner = cur.Text("owner")
			if hasOwner {
				facts.owner = owner
			}
			lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, actor)
			if err != nil {
				return nil, err
			}
			// The parent is needed only when the ask reroutes: the sender owns every ITSA the thread holds, as askOwns checks them.
			own, err := s.askOwns(ctx, actor, lifecycle, cur.Text("id"), cur.Text("thread_id"), facts.owner)
			if err != nil {
				return nil, err
			}
			if !facts.exempt && facts.parent != "" && !own {
				hit, res, err := s.resolveRecipient(ctx, facts.parent, false)
				if err != nil {
					return nil, err
				}
				facts.parentFound = res == foundAgent
				facts.parentLife = hit.Agent.Lifecycle
			}
		}
	}

	stageKinds, hasStage, err := s.db.ItsaFieldKinds(ctx, "stage")
	if err != nil {
		return nil, err
	}
	plan := func(tx db.ItsaTx, cur jsfmt.Value) (db.ItsaUpdate, error) {
		var u db.ItsaUpdate
		curKey, curStatus := cur.Text("key"), cur.Text("status")
		// The human's ask: an agent or a script moving an ITSA into or out of a human status mails (or settles) it, after the
		// move. What the ask's send does not carry is answered first, before anything is written, on the row this move changes.
		if hasStatus && actor != humanBox && !dry {
			from, fromOK := s.statusOf(curStatus)
			to, toOK := s.statusOf(newStatus)
			if toOK && to.Name != curStatus && ((fromOK && from.Human) || to.Human) {
				next := owner
				if !hasOwner {
					next = cur.Text("owner")
				}
				if err := s.askRefusal(ctx, cur, to.Name, next, actor); err != nil {
					return u, asItsaErr(err)
				}
			}
		}
		curOwner, _ := cur.Get("owner")
		if v, ok := f.Get("ifOwner"); ok {
			same := (v.Kind == jsfmt.Null && curOwner.Kind == jsfmt.Null) || (v.Kind == jsfmt.String && curOwner.Kind == jsfmt.String && v.Str == curOwner.Str)
			if !same {
				had := "nobody"
				if curOwner.Kind != jsfmt.Null {
					had = curOwner.Str
				}
				want := "nobody"
				if v.Kind != jsfmt.Null {
					want = anyString(v)
				}
				return u, itsaErr("owner changed: %s is owned by %s, not %s", curKey, had, want)
			}
		}
		if v, ok := f.Get("ifStatus"); ok && (v.Kind != jsfmt.String || v.Str != curStatus) {
			return u, itsaErr("status changed: %s is %s now, not %s", curKey, curStatus, anyString(v))
		}
		if v, ok := f.Get("ifRev"); ok && (v.Kind != jsfmt.String || v.Str != revOf(cur)) {
			return u, itsaErr("%s: %s changed since it was shown", textChanged, curKey)
		}
		if blocked && newStatus != curStatus {
			return u, itsaErr("%s can't move to %s: it would mail your user, and %s may not (Settings › Mail to you). Hand it to your parent%s with itsa_post or send_mail; it decides.", curKey, newStatus, blockModel, handTo(blockParent))
		}
		if hasStatus && actor != humanBox && newStatus != curStatus {
			if st, ok := s.statusOf(newStatus); ok && st.Human {
				done, err := tx.CommentedSince(cur, actor)
				if err != nil {
					return u, err
				}
				if !done {
					return u, itsaErr("%s is moving to %s, which waits on your user: post a comment first with itsa_post (what you did and what you need), then set the status", curKey, newStatus)
				}
			}
		}
		add := func(field string, from, to jsfmt.Value) {
			u.Changes = append(u.Changes, db.ItsaChange{Field: field, From: from, To: to})
		}
		col := func(name string, v any) { u.Cols = append(u.Cols, db.ItsaCol{Name: name, Value: v}) }
		nullable := func(x string) any {
			if x == "" {
				return nil
			}
			return x
		}
		curVal := func(k string) jsfmt.Value { v, _ := cur.Get(k); return v }
		hasText := func(k string) bool { return curVal(k).Kind != jsfmt.Null }

		if v, ok := f.Get("title"); ok {
			title := ""
			if v.Kind != jsfmt.Null {
				title = strings.TrimSpace(anyString(v))
			}
			if title == "" {
				return u, itsaErr("an ITSA needs a title")
			}
			if title != cur.Text("title") {
				col("title", title)
				add("title", curVal("title"), jsfmt.StringValue(title))
			}
		}
		if v, ok := f.Get("summary"); ok {
			next := ""
			if v.Kind != jsfmt.Null {
				next = anyString(v)
			}
			if next != cur.Text("summary") || hasText("summary") != (next != "") {
				col("summary", nullable(next))
				add("summary", curVal("summary"), strOrNull(next, next != ""))
			}
		}
		if v, ok := f.Get("body"); ok {
			if v.Kind == jsfmt.Null {
				if hasText("body") {
					col("body", nil)
					add("body", curVal("body"), jsfmt.NullValue())
				}
			} else if t := anyString(v); !hasText("body") || t != cur.Text("body") {
				col("body", t)
				add("body", curVal("body"), jsfmt.StringValue(t))
			}
		}
		nextKind := cur.Text("kind")
		if v, ok := f.Get("kind"); ok {
			next := ""
			if v.Kind != jsfmt.Null {
				next = anyString(v)
			}
			if next != cur.Text("kind") || hasText("kind") != (next != "") {
				col("kind", nullable(next))
				add("kind", curVal("kind"), strOrNull(next, next != ""))
				nextKind = next
			}
		}
		statusChanged := false
		if hasStatus {
			st, ok := s.statusOf(newStatus)
			if !ok {
				return u, itsaErr("unknown status %s; statuses: %s", newStatus, s.statusNames())
			}
			if st.Name != curStatus {
				statusChanged = true
				col("status", st.Name)
				add("status", jsfmt.StringValue(curStatus), jsfmt.StringValue(st.Name))
				if st.Category == "closed" {
					closedAt := cur.Text("closed_at")
					if closedAt == "" {
						closedAt = db.Now()
					}
					col("closed_at", closedAt)
				} else {
					col("closed_at", nil)
				}
			}
		}
		if hasOwner && owner != cur.Text("owner") {
			col("owner", nullable(owner))
			add("owner", curOwner, strOrNull(owner, owner != ""))
		}
		if v, ok := f.Get("rank"); ok {
			var rank jsfmt.Value
			if v.Kind == jsfmt.Null {
				rank = jsfmt.NullValue()
			} else {
				n, ok := jsNumber(v)
				if !ok {
					return u, itsaErr("rank must be a number")
				}
				rank = numberValue(n)
			}
			cr := curVal("rank")
			if (rank.Kind == jsfmt.Null) != (cr.Kind == jsfmt.Null) || (rank.Kind != jsfmt.Null && rank.Num != cr.Num) {
				if rank.Kind == jsfmt.Null {
					col("rank", nil)
				} else {
					n, _ := strconv.ParseFloat(rank.Num, 64)
					col("rank", n)
				}
				add("rank", cr, rank)
			}
		}
		if v, ok := f.Get("parent"); ok {
			raw := ""
			if v.Kind != jsfmt.Null {
				raw = anyString(v)
			}
			parentID := ""
			if raw != "" && raw != "none" && raw != "root" {
				p, found, err := tx.Find(raw)
				if err != nil {
					return u, err
				}
				if !found {
					return u, itsaErr("no ITSA %s", raw)
				}
				if p.Text("id") == cur.Text("id") {
					return u, itsaErr("an ITSA cannot be its own parent")
				}
				seen := map[string]bool{}
				for n, hasN := p, true; hasN && !seen[n.Text("id")]; {
					if n.Text("id") == cur.Text("id") {
						return u, itsaErr("reparenting would create a cycle")
					}
					seen[n.Text("id")] = true
					if n.Text("parent_id") == "" {
						break
					}
					n, hasN, err = tx.Find(n.Text("parent_id"))
					if err != nil {
						return u, err
					}
				}
				parentID = p.Text("id")
			}
			if parentID != cur.Text("parent_id") {
				col("parent_id", nullable(parentID))
				add("parent", curVal("parent_id"), strOrNull(parentID, parentID != ""))
			}
		}

		// The incident mark (S-2406) is set by the chief of staff or the human, and closing the ITSA clears it.
		curIncident := int64(0)
		if iv := curVal("incident"); iv.Kind == jsfmt.Number {
			curIncident, _ = strconv.ParseInt(iv.Num, 10, 64)
		}
		incident := curIncident
		if v, ok := f.Get("incident"); ok {
			incident = 0
			if v.Truthy() {
				incident = 1
			}
		}
		if statusChanged && s.isClosedStatus(newStatus) {
			incident = 0
		}
		if incident != curIncident {
			col("incident", incident)
			add("incident", jsfmt.IntValue(curIncident), jsfmt.IntValue(incident))
		}

		// Closing leaves the process at its end node (S-1398), in the same change as the status, unless the caller names a stage.
		fv, hasFields := f.Get("fields")
		if statusChanged && s.isClosedStatus(newStatus) && hasStage && !(hasFields && fv.Kind == jsfmt.Object && hasKey(fv, "stage")) &&
			(!hasFields || fv.Kind == jsfmt.Null || fv.Kind == jsfmt.Object) {
			applies, err := db.FieldApplies(stageKinds, nextKind)
			if err != nil {
				return u, err
			}
			if end := s.closeNodeOfKind(nextKind); applies && end != "" {
				withStage := jsfmt.Value{Kind: jsfmt.Object}
				if hasFields && fv.Kind == jsfmt.Object {
					for i, k := range fv.Keys {
						withStage.Set(k, fv.Items[i])
					}
				}
				withStage.Set("stage", jsfmt.StringValue(end))
				fv, hasFields = withStage, true
			}
		}
		if hasFields {
			ch, changed, err := tx.ApplyFieldValues(cur.Text("id"), fv, actor, nextKind)
			if err != nil {
				return u, err
			}
			if st, ok := ch.To.Get("stage"); changed && ok && st.Kind == jsfmt.String {
				from := ""
				if v, ok := ch.From.Get("stage"); ok && v.Kind == jsfmt.String {
					from = v.Str
				}
				if err := s.stageGuard(nextKind, newStatusOrCur(statusChanged, newStatus, curStatus), from, st.Str); err != nil {
					return u, asGuard(err)
				}
				if err := s.stageEntryRefusalAs(ctx, cur.Text("id"), nextKind, st.Str, actor, ownerPtr(hasOwner, owner)); err != nil {
					return u, err
				}
			}
			if changed {
				add("fields", ch.From, ch.To)
			}
		}
		if statusChanged && actor == humanBox {
			stage, err := tx.Stage(cur.Text("id"))
			if err != nil {
				return u, err
			}
			if err := s.answerRefusal(ctx, answerEntry{id: cur.Text("id"), kind: nextKind, stage: stage, actor: actor, from: curStatus, to: newStatus, owner: ownerPtr(hasOwner, owner)}); err != nil {
				return u, err
			}
		}
		if len(u.Changes) > 0 && hasAny(u.Changes, "kind", "status", "body", "parent") {
			curKind := cur.Text("kind")
			if refusedKinds[curKind] || refusedKinds[nextKind] {
				// A process proposal (src/process-proposal.ts) is ported: its gate applies to anyone but the human. Any other
				// proposal runs the retro loop, which is not.
				nextBody := cur.Text("body")
				for _, c := range u.Cols {
					if c.Name == "body" {
						nextBody, _ = c.Value.(string)
					}
				}
				curProc := processProposalOf(curKind, cur.Text("body")) != ""
				if (refusedKinds[curKind] && !curProc) || (refusedKinds[nextKind] && processProposalOf(nextKind, nextBody) == "") {
					return u, Errorf(http.StatusNotImplemented, "an ITSA of kind %s runs code a change triggers, which is not ported to the Go daemon yet", nextKind)
				}
				events, err := tx.Events(cur.Text("id"), 1000)
				if err != nil {
					return u, err
				}
				if err := proposalGate(events, &gateCur{key: cur.Text("key"), kind: curKind, body: cur.Text("body")}, nextKind, newStatusOrCur(statusChanged, newStatus, curStatus), nextBody, actor); err != nil {
					return u, asGuard(err)
				}
			}
		}
		// The observers of a change (decision steps, requirement checks, the owner notice, the wake of a resting owner).
		finalParent := cur.Text("parent_id")
		for _, c := range u.Cols {
			if c.Name == "parent_id" {
				finalParent, _ = c.Value.(string)
			}
		}
		if err := s.observedRefusal(tx, observed{id: cur.Text("id"), statusChanged: statusChanged, edited: hasAny(u.Changes, "title", "summary", "body"),
			ownerChanged: hasOwner && owner != cur.Text("owner"), fromStatus: curStatus, status: newStatusOrCur(hasStatus, newStatus, curStatus), parentID: finalParent, owner: owner, actor: actor}); err != nil {
			return u, err
		}
		// The retro gate runs, as in TS, only when the kind, status, body or parent changes: on the body as it will be.
		if hasAny(u.Changes, "kind", "status", "body", "parent") {
			nextBody := cur.Text("body")
			for _, c := range u.Cols {
				if c.Name == "body" {
					nextBody, _ = c.Value.(string)
				}
			}
			if err := retroGate(nextBody, actor == humanBox, statusChanged && newStatus == "done"); err != nil {
				return u, err
			}
		}

		finalOwner := cur.Text("owner")
		for _, c := range u.Cols {
			if c.Name == "owner" {
				finalOwner = ""
				if o, ok := c.Value.(string); ok {
					finalOwner = o
				}
			}
		}
		if hasParts {
			before, err := tx.Participants(cur.Text("id"))
			if err != nil {
				return u, err
			}
			next := append([]string(nil), resolved...)
			if finalOwner != "" && !contains(next, finalOwner) {
				next = append(next, finalOwner)
			}
			if !sameSet(next, before) {
				u.SetParticipants, u.Participants = true, next
				add("participants", strs(before), strs(next))
			}
		} else if finalOwner != "" {
			u.EnsureParticipant = finalOwner
		}
		// The human's act route names the action (src/itsa.ts set: f.action); the event is written with a status change.
		if a, ok := f.Get("action"); ok && a.Truthy() {
			u.Action = db.JSStr(a)
		}
		return u, nil
	}
	if dry {
		return nil, asItsaErr(s.db.PlanItsa(ctx, ref, actor, plan))
	}
	// A change that may set the stage (a stage field, or a status: closing sets it) takes the stage order from its commit to the
	// end of its listeners, so the process runner sees the entries in commit order.
	ordered := hasKey(f, "status")
	if fv, ok := f.Get("fields"); ok && hasKey(fv, "stage") {
		ordered = true
	}
	if ordered {
		s.stages.queued.Add(1)
		s.stages.order.Lock()
		s.stages.queued.Add(-1)
	}
	after, changes, err := s.db.UpdateItsa(ctx, ref, actor, plan)
	if err != nil {
		if ordered {
			s.stages.order.Unlock()
		}
		return nil, asItsaErr(err)
	}
	var starts []func()
	later := func(f func()) {
		if f != nil {
			starts = append(starts, f)
		}
	}
	// Under the order lock only the stage listeners run: they touch this database and nothing else. The observers of a status change
	// (the ask mail, the owner notices, the requirement checks) may wait on a peer or the network, so they run after it is released.
	for _, ch := range changes {
		if ch.Field == "status" {
			stage, err := s.db.ItsaStage(ctx, after.Text("id"))
			if err != nil {
				slog.Error("process-run: stage", "itsa", after.Text("key"), "err", err)
			}
			later(s.onAnswer(ctx, answerEntry{id: after.Text("id"), kind: after.Text("kind"), stage: stage, actor: actor, from: anyString(ch.From), to: anyString(ch.To)}))
		}
	}
	for _, ch := range changes {
		if st, ok := ch.To.Get("stage"); ch.Field == "fields" && ok {
			from, _ := ch.From.Get("stage")
			to := ""
			if st.Kind == jsfmt.String {
				to = st.Str
			}
			later(s.onStage(ctx, stageEntry{id: after.Text("id"), key: after.Text("key"), kind: after.Text("kind"), from: strOf(from), to: to, actor: actor}))
		}
	}
	if ordered {
		s.stages.order.Unlock()
	}
	if h := s.stages.beforeObservers; h != nil {
		h()
	}
	action := ""
	if a, ok := f.Get("action"); ok && a.Truthy() {
		action = db.JSStr(a)
	}
	for _, ch := range changes {
		if ch.Field == "status" {
			s.onStatus(ctx, after, actor, anyString(ch.From))
			s.ownerStatusNotice(ctx, after, actor)
			s.onApprovalStatus(ctx, after, actor, anyString(ch.From), action == "approve")
			s.onProposalStatus(ctx, after, actor, anyString(ch.From))
			s.afterItsaChange(ctx, after, "status", actor, anyString(ch.From), anyString(ch.To))
		}
	}
	// What the stage entry does for real starts only now: an ask it opens must not meet the observers of this same write.
	for _, start := range starts {
		start()
	}
	if hasAny(changes, "title", "summary", "body") {
		s.afterItsaChange(ctx, after, "edit", actor, "", "")
		s.indexItsa(after)
	}
	if len(changes) > 0 {
		s.syncItsaSubscriptions(ctx, after.Text("id"))
		s.emitItsaChanged(ctx, after)
	}
	co := jsfmt.Value{Kind: jsfmt.Object}
	for _, ch := range changes {
		e := jsfmt.Value{Kind: jsfmt.Object}
		e.Set("from", ch.From)
		e.Set("to", ch.To)
		co.Set(ch.Field, e)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("itsa", after)
	out.Set("changes", co)
	return out, nil
}

func newStatusOrCur(has bool, next, cur string) string {
	if has {
		return next
	}
	return cur
}

func hasKey(v jsfmt.Value, k string) bool { _, ok := v.Get(k); return ok }

func hasAny(changes []db.ItsaChange, fields ...string) bool {
	for _, c := range changes {
		for _, f := range fields {
			if c.Field == f {
				return true
			}
		}
	}
	return false
}

// sameSet is whether two lists hold the same strings (src/itsa.ts compares their sorted JSON).
func sameSet(a, b []string) bool {
	x, y := append([]string(nil), a...), append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// ownerPtr is the owner a change sets, nil when it doesn't set one.
func ownerPtr(has bool, owner string) *string {
	if !has {
		return nil
	}
	return &owner
}
