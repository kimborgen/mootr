package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/requirements"
)

// The approval of a draft an agent wrote (src/req-approval.ts). It reaches the human the way every other ask does: an ITSA of
// kind `requirement-approval`, linked to the requirement, moved to needs_approval with a comment that carries the statement.
// With settings.requirements.approval `cos` the chief of staff owns the ask instead, by mail through the same ITSA. An
// approval applies to the draft that was shown: the ask records the requirement's `rev`, and Approve passes it back.

func logApproval(what string, err error) {
	slog.Error("requirement approval: "+what, "err", err)
}

// approval is the outcome of raising an ask: the ITSA's key and who is asked, or why no ask was made.
type approval struct{ key, to, err string }

func (a approval) value() jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	if a.err != "" {
		v.Set("error", jsfmt.StringValue(a.err))
		return v
	}
	v.Set("itsa", jsfmt.StringValue(a.key))
	v.Set("to", jsfmt.StringValue(a.to))
	return v
}

// reqActor is `(await itsa.person(by)) ?? by`: the agent id a name stands for, else what was given.
func (s *Server) reqActor(ctx context.Context, by string) string {
	if p, err := s.person(ctx, jsfmt.StringValue(by), true); err == nil && p != "" {
		return p
	}
	return by
}

func (s *Server) agentName(ctx context.Context, id string) string {
	if id == humanBox {
		return "your user"
	}
	if a, err := s.db.GetAgent(ctx, id); err == nil {
		return a.Name
	}
	return id
}

func requirementLink(key string) jsfmt.Value {
	l := jsfmt.Value{Kind: jsfmt.Object}
	l.Set("system", jsfmt.StringValue("requirement"))
	l.Set("external_id", jsfmt.StringValue(key))
	l.Set("url", jsfmt.StringValue("stam:requirement/"+key))
	return l
}

// askItsa makes the ITSA of an ask, waiting; a failure is the message, with no ITSA behind.
func (s *Server) askItsa(ctx context.Context, title, summary, text, owner string, participants []string, links []jsfmt.Value, by string) (jsfmt.Value, error) {
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("title", jsfmt.StringValue(title))
	if summary != "" {
		body.Set("summary", jsfmt.StringValue(summary))
	}
	body.Set("body", jsfmt.StringValue(text))
	body.Set("kind", jsfmt.StringValue(requirements.ApprovalKind))
	body.Set("status", jsfmt.StringValue("waiting"))
	body.Set("owner", jsfmt.StringValue(owner))
	body.Set("participants", jsfmt.ArrayValue(stringValues(participants)))
	body.Set("links", jsfmt.ArrayValue(links))
	out, err := s.createItsa(ctx, body, by)
	if err != nil {
		return jsfmt.Value{}, err
	}
	return out.(jsfmt.Value), nil
}

func (s *Server) postAs(ctx context.Context, itsaID, by, text string) error {
	in := jsfmt.Value{Kind: jsfmt.Object}
	in.Set("by", jsfmt.StringValue(by))
	in.Set("body", jsfmt.StringValue(text))
	_, err := s.post(ctx, itsaID, in, false)
	return err
}

func (s *Server) moveItsa(ctx context.Context, itsaID, by string, fields ...string) (jsfmt.Value, error) {
	f := jsfmt.Value{Kind: jsfmt.Object}
	for i := 0; i+1 < len(fields); i += 2 {
		f.Set(fields[i], jsfmt.StringValue(fields[i+1]))
	}
	out, err := s.setItsa(ctx, itsaID, f, by)
	if err != nil {
		return jsfmt.Value{}, err
	}
	return out.(jsfmt.Value), nil
}

func errText(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Message
	}
	return err.Error()
}

// cancelAsk leaves no orphan ITSA behind an ask that couldn't be raised.
func (s *Server) cancelAsk(ctx context.Context, made jsfmt.Value, by string) {
	if made.Kind == jsfmt.Object {
		_, _ = s.moveItsa(ctx, made.Text("id"), by, "status", "canceled")
	}
}

// chiefOfStaffAgent is the chief of staff when approval is `cos`.
func (s *Server) approvalCos(ctx context.Context) (id, name string) {
	if s.settings.Get().Requirements.Approval != "cos" {
		return "", ""
	}
	id = s.chiefOfStaffID(ctx)
	if id == "" {
		return "", ""
	}
	return id, s.agentName(ctx, id)
}

func approvalOff(approval string) bool { return approval != "human" && approval != "cos" }

// askApproval is src/req-approval.ts ask: raises the ask for a draft an agent made.
func (s *Server) askApproval(ctx context.Context, r requirements.Req, by string) approval {
	ctx = context.WithoutCancel(ctx)
	if by == humanBox || r.Status() != "draft" || approvalOff(s.settings.Get().Requirements.Approval) {
		return approval{err: "no ask needed"}
	}
	// The chief of staff can't approve its own draft, so that one goes to the human.
	cos, cosName := s.approvalCos(ctx)
	via, owner, participants := "human", by, []string{by}
	if cos != "" && cos != by {
		via, owner, participants = "cos", cos, []string{by, cos}
	}
	summary := ""
	if v, ok := r.Get("text"); ok && v.Kind == jsfmt.String {
		summary = v.Str
	}
	made, err := s.askItsa(ctx, "Approve requirement "+r.Key()+": "+r.Text("title"), summary, requirements.Statement(r, via), owner, participants, []jsfmt.Value{requirementLink(r.Key())}, by)
	if err != nil {
		return approval{err: errText(err)}
	}
	fail := func(err error) approval {
		s.cancelAsk(ctx, made, by)
		return approval{err: errText(err)}
	}
	if err := s.requirements.SetStamp(ctx, made.Text("id"), r, via); err != nil {
		return fail(err)
	}
	if via == "cos" {
		// The author's post carries the statement and names the chief of staff, which mails it and interrupts it.
		if err := s.postAs(ctx, made.Text("id"), by, "@"+cosName+" a draft needs your approval.\n\n"+requirements.Statement(r, via)); err != nil {
			return fail(err)
		}
		return approval{key: made.Text("key"), to: "chief of staff"}
	}
	// The comment comes first: the move into a human status mails the ask with it.
	if err := s.postAs(ctx, made.Text("id"), by, requirements.Statement(r, via)); err != nil {
		return fail(err)
	}
	moved, err := s.moveItsa(ctx, made.Text("id"), by, "status", "needs_approval")
	if err != nil {
		return fail(err)
	}
	x, _ := moved.Get("itsa")
	return approval{key: x.Text("key"), to: "human"}
}

// askApprovalBatch is src/req-approval.ts askBatch: one ask for a batch of drafts an agent made.
func (s *Server) askApprovalBatch(ctx context.Context, rs []requirements.Req, by string) approval {
	ctx = context.WithoutCancel(ctx)
	var drafts []requirements.Req
	for _, r := range rs {
		if r.Status() == "draft" {
			drafts = append(drafts, r)
		}
	}
	if by == humanBox || len(drafts) == 0 || approvalOff(s.settings.Get().Requirements.Approval) {
		return approval{err: "no ask needed"}
	}
	cos, cosName := s.approvalCos(ctx)
	via, owner, participants := "human", by, []string{by}
	if cos != "" && cos != by {
		via, owner, participants = "cos", cos, []string{by, cos}
	}
	span := drafts[0].Key()
	if len(drafts) > 1 {
		span = drafts[0].Key() + " to " + drafts[len(drafts)-1].Key()
	}
	var links []jsfmt.Value
	for _, r := range drafts {
		links = append(links, requirementLink(r.Key()))
	}
	statement := requirements.BatchStatement(drafts, via, s.reqKeyOf(ctx))
	made, err := s.askItsa(ctx, fmt.Sprintf("Approve %d requirements: %s", len(drafts), span), fmt.Sprintf("%d requirement drafts for approval as one batch.", len(drafts)), statement, owner, participants, links, by)
	if err != nil {
		return approval{err: errText(err)}
	}
	fail := func(err error) approval {
		s.cancelAsk(ctx, made, by)
		return approval{err: errText(err)}
	}
	if err := s.requirements.StampBatch(ctx, made.Text("id"), drafts, via); err != nil {
		return fail(err)
	}
	if via == "cos" {
		if err := s.postAs(ctx, made.Text("id"), by, "@"+cosName+" a batch of drafts needs your approval.\n\n"+statement); err != nil {
			return fail(err)
		}
		return approval{key: made.Text("key"), to: "chief of staff"}
	}
	if err := s.postAs(ctx, made.Text("id"), by, statement); err != nil {
		return fail(err)
	}
	moved, err := s.moveItsa(ctx, made.Text("id"), by, "status", "needs_approval")
	if err != nil {
		return fail(err)
	}
	x, _ := moved.Get("itsa")
	return approval{key: x.Text("key"), to: "human"}
}

// reqKeyOf names a requirement's key by its id, "" when it has none.
func (s *Server) reqKeyOf(ctx context.Context) func(id string) string {
	return func(id string) string {
		if r, err := s.requirements.Find(ctx, id); err == nil && r != nil {
			return r.Key()
		}
		return ""
	}
}

// openAskItsa is the open approval ITSA of a requirement, if any: the first of the ITSAs (newest first) not closed.
func (s *Server) openAskItsa(ctx context.Context, ids []string) (jsfmt.Value, bool) {
	for _, id := range ids {
		x, ok, err := s.db.FindItsa(ctx, id)
		if err == nil && ok && !s.isClosedStatus(x.Text("status")) {
			return x, true
		}
	}
	return jsfmt.Value{}, false
}

// draftsOf are the batch members that are still drafts and not dropped, in the batch's order.
func (s *Server) draftsOf(ctx context.Context, members []requirements.Member) []requirements.Req {
	var out []requirements.Req
	for _, m := range members {
		if m.Dropped {
			continue
		}
		if r, err := s.requirements.Find(ctx, m.ReqKey); err == nil && r != nil && r.Status() == "draft" {
			out = append(out, *r)
		}
	}
	return out
}

// refreshApproval is src/req-approval.ts refresh: the draft changed (by `by`) while an ask for it is open, or an Approve found
// it changed: the same ITSA carries the new statement, and asks again if it isn't waiting. The human's own edit only moves
// the stamp.
func (s *Server) refreshApproval(ctx context.Context, key, by string) {
	ctx = context.WithoutCancel(ctx)
	if err := s.refreshApprovalErr(ctx, key, by); err != nil {
		logApproval("refreshing the ask for "+key, err)
	}
}

func (s *Server) refreshApprovalErr(ctx context.Context, key, by string) error {
	single, batch, err := s.requirements.AskItsas(ctx, key)
	if err != nil {
		return err
	}
	if b, ok := s.openAskItsa(ctx, batch); ok {
		return s.refreshBatch(ctx, b, by)
	}
	x, ok := s.openAskItsa(ctx, single)
	r, err := s.requirements.Find(ctx, key)
	if err != nil || !ok || r == nil || r.Status() != "draft" {
		return err
	}
	stamp, err := s.requirements.StampOf(ctx, x.Text("id"))
	if err != nil {
		return err
	}
	via := "human"
	if stamp != nil {
		via = stamp.Via
	}
	if err := s.requirements.SetStamp(ctx, x.Text("id"), *r, via); err != nil {
		return err
	}
	if by == humanBox {
		return nil
	}
	// A human ask is owned by the draft's author. A chief-of-staff ask is owned by the chief of staff, so the editor posts,
	// naming it, and the ask never moves to a human status.
	owner := x.Text("owner")
	sender := owner
	if via == "cos" || owner == "" || owner == humanBox {
		sender = by
	}
	summary := ""
	if v, ok := r.Get("text"); ok && v.Kind == jsfmt.String {
		summary = v.Str
	}
	if _, err := s.moveItsa(ctx, x.Text("id"), sender, "body", requirements.Statement(*r, via), "summary", summary); err != nil {
		return err
	}
	mention := ""
	if via == "cos" && owner != "" {
		if a, err := s.db.GetAgent(ctx, owner); err == nil {
			mention = "@" + a.Name + " "
		}
	}
	if err := s.postAs(ctx, x.Text("id"), sender, mention+"The draft changed. This is the text now:\n\n"+requirements.Statement(*r, via)); err != nil {
		return err
	}
	if via == "human" && x.Text("status") != "needs_approval" {
		_, err = s.moveItsa(ctx, x.Text("id"), sender, "status", "needs_approval")
		return err
	}
	return nil
}

// refreshBatch: a draft in the batch changed, or an Approve found one changed: the same ITSA gets the batch as it is now,
// with every rev stamped again, and asks again. The human's own edit only moves the stamps.
func (s *Server) refreshBatch(ctx context.Context, x jsfmt.Value, by string) error {
	members, err := s.requirements.Members(ctx, x.Text("id"))
	if err != nil {
		return err
	}
	via := "human"
	if len(members) > 0 {
		via = members[0].Via
	}
	drafts := s.draftsOf(ctx, members)
	if len(drafts) == 0 {
		return nil
	}
	if err := s.requirements.StampBatch(ctx, x.Text("id"), drafts, via); err != nil {
		return err
	}
	if by == humanBox {
		return nil
	}
	owner := x.Text("owner")
	sender := owner
	if via == "cos" || owner == "" || owner == humanBox {
		sender = by
	}
	statement := requirements.BatchStatement(drafts, via, s.reqKeyOf(ctx))
	if _, err := s.moveItsa(ctx, x.Text("id"), sender, "body", statement); err != nil {
		return err
	}
	mention := ""
	if via == "cos" && owner != "" {
		if a, err := s.db.GetAgent(ctx, owner); err == nil {
			mention = "@" + a.Name + " "
		}
	}
	if err := s.postAs(ctx, x.Text("id"), sender, mention+"A draft in this batch changed. This is the batch now:\n\n"+statement); err != nil {
		return err
	}
	if via == "human" && x.Text("status") != "needs_approval" {
		_, err = s.moveItsa(ctx, x.Text("id"), sender, "status", "needs_approval")
		return err
	}
	return nil
}

// approvedElsewhere is src/req-approval.ts approvedElsewhere: a requirement reached `in_force` without going through the ask
// (the human set it directly, or the chief of staff did): its open ask closes as done, with a one-line comment.
func (s *Server) approvedElsewhere(ctx context.Context, key, by string) {
	ctx = context.WithoutCancel(ctx)
	if err := s.approvedElsewhereErr(ctx, key, by); err != nil {
		logApproval("closing the ask for "+key, err)
	}
}

func (s *Server) approvedElsewhereErr(ctx context.Context, key, by string) error {
	single, batch, err := s.requirements.AskItsas(ctx, key)
	if err != nil {
		return err
	}
	// A batch ask closes once none of its drafts is left a draft.
	if b, ok := s.openAskItsa(ctx, batch); ok {
		members, err := s.requirements.Members(ctx, b.Text("id"))
		if err != nil {
			return err
		}
		if len(s.draftsOf(ctx, members)) > 0 {
			return nil
		}
		if err := s.postAs(ctx, b.Text("id"), by, fmt.Sprintf("Every draft in this batch is now out of draft (the last, %s, by %s); closing this ask.", key, s.agentName(ctx, by))); err != nil {
			logApproval("commenting on the ask for "+key, err)
		}
		_, err = s.moveItsa(ctx, b.Text("id"), by, "status", "done")
		return err
	}
	x, ok := s.openAskItsa(ctx, single)
	if !ok {
		return nil
	}
	if err := s.postAs(ctx, x.Text("id"), by, key+" was put in force by "+s.agentName(ctx, by)+"; closing this ask."); err != nil {
		logApproval("commenting on the ask for "+key, err)
	}
	_, err = s.moveItsa(ctx, x.Text("id"), by, "status", "done")
	return err
}

// approvalSnap is what the human was shown when they pressed Approve: the stamp of a single ask or the stamped member revs of
// a batch, read as the action lands and not after, so a later edit of the draft cannot be approved unseen.
type approvalSnap struct {
	stamp   *requirements.Stamp
	members []requirements.Member
}

// onApprovalStatus is req-approval.ts onStatus: the human's Approve on the ask puts the requirement in force and closes the
// ITSA, if the draft is still the one that was shown. approve is whether this status change carries the Approve action (the
// act route names it); a plain move out of needs_approval approves nothing. The stamps are read here, before the work goes
// off the request; the rest runs after the move, off it, and errors are logged.
func (s *Server) onApprovalStatus(ctx context.Context, x jsfmt.Value, actor, from string, approve bool) {
	if x.Text("kind") != requirements.ApprovalKind || from != "needs_approval" || actor != humanBox || !approve || !s.requirements.Enabled() {
		return
	}
	bg := context.WithoutCancel(ctx)
	snap, err := s.snapApproval(bg, x)
	if err != nil {
		logApproval("approving for "+x.Text("key"), err)
		return
	}
	if s.startApprove != nil {
		s.startApprove()
	}
	go func() {
		if s.afterApprove != nil {
			defer s.afterApprove()
		}
		if s.beforeApprove != nil {
			s.beforeApprove()
		}
		if err := s.approveAsk(bg, x, snap); err != nil {
			logApproval("approving for "+x.Text("key"), err)
		}
	}()
}

func (s *Server) snapApproval(ctx context.Context, x jsfmt.Value) (approvalSnap, error) {
	var snap approvalSnap
	members, err := s.requirements.Members(ctx, x.Text("id"))
	if err != nil {
		return snap, err
	}
	snap.members = members
	if len(members) == 0 {
		snap.stamp, err = s.requirements.StampOf(ctx, x.Text("id"))
	}
	return snap, err
}

func (s *Server) approveAsk(ctx context.Context, x jsfmt.Value, snap approvalSnap) error {
	if len(snap.members) > 0 {
		return s.approveBatch(ctx, x, snap.members)
	}
	var key string
	links, err := s.db.ItsaLinks(ctx, x.Text("id"))
	if err != nil {
		return err
	}
	for _, l := range links {
		if l.Text("system") == "requirement" {
			key = l.Text("external_id")
			break
		}
	}
	stamp := snap.stamp
	if key == "" || stamp == nil {
		return nil
	}
	// No rev recorded (an ask from before it existed): never matches, so the ask is raised again.
	rev := int64(-1)
	if stamp.Rev != nil {
		rev = *stamp.Rev
	}
	in := jsjson.NewObject("status", "in_force", "ifRev", float64(rev))
	if _, err := s.requirements.Set(ctx, key, requirements.Input(in.Get), requirements.Human); err != nil {
		if !strings.Contains(err.Error(), "changed since it was shown") {
			return err
		}
		// Not approved: it changed after the ask. Ask again, on this ITSA, with the new text.
		owner := x.Text("owner")
		if owner == "" {
			owner = humanBox
		}
		s.refreshApproval(ctx, key, owner)
		if cur, ok, _ := s.db.FindItsa(ctx, x.Text("id")); ok && cur.Text("status") != "needs_approval" {
			logApproval(key+" changed, but its ask could not be raised again", errors.New("no human status"))
		}
		return nil
	}
	_, err = s.moveItsa(ctx, x.Text("id"), humanBox, "status", "done")
	return err
}

// approveBatch is the human's Approve on a batch ask: every draft in force at the rev it was shown at, or none. The members and
// the drafts are read and written in one transaction in the store, so a drop cannot land between them.
func (s *Server) approveBatch(ctx context.Context, x jsfmt.Value, members []requirements.Member) error {
	shown := map[string]int64{}
	for _, m := range members {
		shown[m.ReqKey] = m.Rev
	}
	_, stale, err := s.requirements.ApproveBatch(ctx, x.Text("id"), shown)
	if err != nil {
		return err
	}
	if len(stale) > 0 {
		owner := x.Text("owner")
		if owner == "" {
			owner = humanBox
		}
		return s.refreshBatch(ctx, x, owner)
	}
	_, err = s.moveItsa(ctx, x.Text("id"), humanBox, "status", "done")
	return err
}

// --- the routes ---

// batchItems is a batch ask's drafts as the human sees them (src/req-approval.ts batchOf); ok is false when the ITSA isn't a
// batch ask.
func (s *Server) batchItems(ctx context.Context, ref string) (jsfmt.Value, jsfmt.Value, bool, error) {
	x, ok, err := s.db.FindItsa(ctx, ref)
	if err != nil || !ok || x.Text("kind") != requirements.ApprovalKind {
		return jsfmt.Value{}, jsfmt.Value{}, false, err
	}
	members, err := s.requirements.Members(ctx, x.Text("id"))
	if err != nil || len(members) == 0 {
		return jsfmt.Value{}, jsfmt.Value{}, false, err
	}
	items := jsfmt.Value{Kind: jsfmt.Array}
	for _, m := range members {
		r, err := s.requirements.Find(ctx, m.ReqKey)
		if err != nil || r == nil {
			continue
		}
		it := jsfmt.Value{Kind: jsfmt.Object}
		it.Set("key", jsfmt.StringValue(r.Key()))
		it.Set("title", jsfmt.StringValue(r.Text("title")))
		for _, k := range []string{"text", "rationale"} {
			v, ok := r.Get(k)
			if !ok {
				v = jsfmt.NullValue()
			}
			it.Set(k, v)
		}
		it.Set("rev", jsfmt.IntValue(m.Rev))
		it.Set("status", jsfmt.StringValue(r.Status()))
		it.Set("dropped", jsfmt.Value{Kind: jsfmt.Bool, Bool: m.Dropped})
		items.Items = append(items.Items, it)
	}
	return x, items, true, nil
}

func (s *Server) showAsk(r *http.Request, _ auth.Resolved) (any, error) {
	ref := r.PathValue("id")
	if !agentRef.MatchString(ref) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	if !s.requirements.Enabled() {
		return nil, reqErr(requirements.Off{})
	}
	x, items, ok, err := s.batchItems(r.Context(), ref)
	if err != nil {
		return nil, reqErr(err)
	}
	if !ok {
		return nil, reqErr(fmt.Errorf("no requirement approval %s", ref))
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("itsa", jsfmt.StringValue(x.Text("key")))
	out.Set("items", items)
	return out, nil
}

// humanWays is src/daemon.ts humanWays, without the tailscale serve origin.
func (s *Server) humanWays() string {
	if s.settings.Get().Auth.LocalHuman {
		return "through stam's login page at http://127.0.0.1:" + strconv.Itoa(s.cfg.Port) + "/"
	}
	return "through stam's login page, once local login is on (auth.localHuman in settings.json), or through tailscale serve"
}

// dropFromBatch is POST /api/requirements/asks/:id/drop: the human takes one draft out of an open batch ask. Only the human as
// the owner proves it: a shared token with x-stam-human proves nothing, and a peer's request doesn't come from the human.
func (s *Server) dropFromBatch(r *http.Request, c auth.Resolved) (any, error) {
	ref := r.PathValue("id")
	if !agentRef.MatchString(ref) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	if !s.requirements.Enabled() {
		return nil, reqErr(requirements.Off{})
	}
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if c.Kind != auth.Owner || c.Caller.IsAgent() {
		return nil, reqErr(Errorf(http.StatusForbidden, "only the human drops a draft from an approval, %s", s.humanWays()))
	}
	v, _ := body.Get("if_rev")
	f, ok := jsNumber(v)
	if v.Kind != jsfmt.Number || !ok || f != float64(int64(f)) {
		return nil, reqErr(Errorf(http.StatusBadRequest, "if_rev is the rev of the draft shown, a whole number"))
	}
	key := ""
	if k, ok := body.Get("key"); ok {
		key = db.JSStr(k)
	}
	obsolete := false
	if o, ok := body.Get("obsolete"); ok && o.Kind == jsfmt.Bool && o.Bool {
		obsolete = true
	}
	id, posted, err := s.requirements.DropMember(ctx, ref, key, obsolete, int64(f), s.isClosedStatus)
	if err != nil {
		return nil, reqErr(err)
	}
	if posted {
		what := "stays a draft"
		if obsolete {
			what = "marked obsolete"
		}
		if err := s.postAs(ctx, id, humanBox, key+" is dropped from this batch and "+what+". Approve all approves what is left."); err != nil {
			return nil, reqErr(err)
		}
	}
	_, items, _, err := s.batchItems(ctx, ref)
	if err != nil {
		return nil, reqErr(err)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	if items.Kind != jsfmt.Array {
		items = jsfmt.Value{Kind: jsfmt.Array}
	}
	out.Set("items", items)
	return out, nil
}
