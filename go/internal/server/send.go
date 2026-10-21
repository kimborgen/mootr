package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// POST /api/mail for this daemon's own agents, the human and `all` (src/daemon.ts, src/mail.ts sendMail; S-2824 slice B).
// Not ported, and each answers 501 naming it: mail forwarded by a peer, a recipient on a peer, attachments, a reply in an
// ITSA's thread or a send that names an ITSA, supersedes, the web UI's notes (routing_uncertain, looking_at), the stam-only
// fields (itsa_id, kind, health, permission_id, mail_id, thread_id, interrupt, title, summary), the ```embed blocks, and
// the mail check on mail to the human (answered 501 unless the send carries an `override`, or no check would run).
// Left out without an error: the ```pane capture, the web push, the title and the mail
// check after delivery, the search index, the link to the ITSAs the text names, the notice to the parent of a stopped
// recipient, and the peer outbox.

// stamFields is src/mail.ts DAEMON_FIELDS: the fields only stam sets, refused from an agent's token.
var stamFields = []string{"forwarded", "relay", "thread_id", "itsa_id", "mail_id", "from_stam", "permission_id", "interrupt", "inferred", "kind", "health", "auto_threaded", "about_itsa", "title", "summary", "system"}

// notPorted are the body fields a human or the shared token may set that this daemon does not carry out yet.
var notPorted = []string{"relay", "thread_id", "itsa_id", "mail_id", "permission_id", "interrupt", "kind", "health", "auto_threaded", "about_itsa", "title", "summary", "only", "supersedes", "itsa", "routing_uncertain", "looking_at"}

var systemSenders = []string{"deploy-watch", "full-suite"}

var (
	reSystemName = regexp.MustCompile(`^[a-z][a-z-]{1,39}$`)
	reRe         = regexp.MustCompile(`(?i)^(re:\s*)+`)
	reEmbed      = regexp.MustCompile("```(embed|video|audio|image|file|compare)")
	reStamSubj   = regexp.MustCompile(`^\[stam\]`)
)

func (s *Server) sendRoutes() {
	s.sends = newSendDedup()
	s.handle("POST /api/mail", s.sendMailRoute)
}

// isHuman is the route's `human`: the request is the human's (src/daemon.ts). The owner counts, and without
// auth.humanStrict so does any non-agent caller sending x-stam-human.
func (s *Server) isHuman(r *http.Request, c auth.Resolved) bool {
	if c.Caller.IsAgent() {
		return false
	}
	owned := c.Kind == auth.Owner
	if s.settings.Get().Auth.HumanStrict {
		return owned && r.Header.Get("X-Stam-Local") != "1"
	}
	return r.Header.Get("X-Stam-Human") == "1" || owned
}

// actor is src/daemon.ts actor: the agent a request is made as, from its credential and what it claims.
func (s *Server) actor(ctx context.Context, c auth.Caller, claim string) (string, error) {
	switch c.Kind {
	case auth.Agent:
		if claim == "" {
			return c.Agent, nil
		}
		if a, err := s.db.GetAgent(ctx, claim); claim == c.Agent || (err == nil && a.ID == c.Agent) {
			return c.Agent, nil
		}
		return "", Errorf(http.StatusForbidden, "agent %s can't act as %s", s.agentLabel(ctx, c.Agent), claim)
	case auth.OpenCode:
		if a, err := s.db.GetAgent(ctx, claim); claim != "" && err == nil && a.Harness == "opencode" {
			return a.ID, nil
		}
		no := claim
		if no == "" {
			no = "no one"
		}
		return "", Errorf(http.StatusForbidden, "the OpenCode server can't act as %s", no)
	case auth.Shared:
		if claim != "" && claim != humanBox {
			if !s.settings.Get().Auth.SharedTokenClaims {
				return "", Errorf(http.StatusForbidden, "the shared token can't act as %s: settings.auth.sharedTokenClaims is off", claim)
			}
			// An empty token_hash is no token (TS reads it falsy), and an agent remembered from a peer has its own.
			if a, err := s.db.GetAgent(ctx, claim); err == nil && a.TokenHash != nil && *a.TokenHash != "" {
				return "", Errorf(http.StatusForbidden, "the shared token can't act as %s: it has its own token", claim)
			}
			if peer, err := s.db.HasPeerAgent(ctx, claim); err != nil {
				return "", err
			} else if peer {
				return "", Errorf(http.StatusForbidden, "the shared token can't act as %s: it has its own token", claim)
			}
		}
	}
	return claim, nil
}

// field is a body member's JS String(v), with whether it was there at all (null counts as there).
func field(body jsfmt.Value, k string) (string, bool) {
	v, ok := body.Get(k)
	if !ok {
		return "", false
	}
	if v.Kind == jsfmt.Null {
		return "", true
	}
	return anyString(v), true
}

// resolveBodyActors is src/daemon.ts resolveActors for a JSON object body (readWrite does the same for the lifecycle routes): the identity a request claims. The OpenCode server
// names its agent, an agent's token is that agent, and the shared token may name only an agent without a token of its own.
// The body's by, from and self are rewritten in place to the identity the caller may act as.
func (s *Server) resolveBodyActors(ctx context.Context, c auth.Resolved, body *jsfmt.Value) error {
	if c.Kind == auth.OpenCode {
		named := false
		for _, k := range []string{"by", "from", "self"} {
			if _, ok := body.Get(k); ok {
				named = true
			}
		}
		if !named {
			return Errorf(http.StatusForbidden, "the OpenCode server's request must name its agent (by, from, or self)")
		}
	}
	for _, k := range []string{"by", "from", "self"} {
		claim, has := field(*body, k)
		if !has && c.Kind != auth.Agent {
			continue
		}
		v, err := s.actor(ctx, c.Caller, claim)
		if err != nil {
			return err
		}
		if v != "" {
			body.Set(k, jsfmt.StringValue(v))
		}
	}
	// The OpenCode server names its agent once, in any of the three; all three are then that agent (S-480).
	if c.Kind == auth.OpenCode {
		named := ""
		for _, k := range []string{"by", "from", "self"} {
			if v, ok := body.Get(k); ok && v.Kind != jsfmt.Null {
				named = anyString(v)
				break
			}
		}
		for _, k := range []string{"by", "from", "self"} {
			if v, ok := body.Get(k); !ok || v.Kind == jsfmt.Null {
				body.Set(k, jsfmt.StringValue(named))
			}
		}
	}
	return nil
}

func (s *Server) sendMailRoute(r *http.Request, c auth.Resolved) (any, error) {
	// A client that hangs up must not leave half a send, or a retry with the same client_id a mail stored and unanswered:
	// the whole route runs without the request's cancellation.
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
		return nil, err
	}
	if c.Local {
		return nil, Errorf(http.StatusNotImplemented, "mail forwarded by a peer is not ported to the Go daemon yet")
	}
	if err := s.resolveBodyActors(ctx, c, &body); err != nil {
		return nil, err
	}

	// The fields only stam sets, refused from an agent's or the OpenCode server's token (S-466).
	if c.Caller.IsAgent() {
		var own []string
		for _, f := range stamFields {
			if _, ok := body.Get(f); ok {
				own = append(own, f)
			}
		}
		if len(own) > 0 {
			verb := "is"
			if len(own) > 1 {
				verb = "are"
			}
			return nil, Errorf(http.StatusForbidden, "%s %s set only by stam, not in an agent's mail", strings.Join(own, ", "), verb)
		}
	}
	if _, ok := body.Get("from_stam"); ok {
		return nil, Errorf(http.StatusForbidden, "from_stam is set only by stam")
	}
	if v, ok := body.Get("forwarded"); ok && v.Truthy() {
		return nil, Errorf(http.StatusNotImplemented, "forwarded mail is not ported to the Go daemon yet")
	}
	human := s.isHuman(r, c)
	from, _ := field(body, "from")
	if from == humanBox && !human {
		return nil, Errorf(http.StatusForbidden, "only the human mails as the human")
	}
	if sys, has := field(body, "system"); has {
		watcher := !c.Caller.IsAgent() && contains(systemSenders, sys)
		if !human && !watcher {
			return nil, Errorf(http.StatusForbidden, "only the human mails as a system sender")
		}
	}
	for _, f := range notPorted {
		if v, ok := body.Get(f); ok && v.Truthy() {
			return nil, Errorf(http.StatusNotImplemented, "%s is not ported to the Go daemon yet", f)
		}
	}
	if v, ok := body.Get("attachments"); ok && v.Kind == jsfmt.Array && len(v.Items) > 0 {
		return nil, Errorf(http.StatusNotImplemented, "attachments are not ported to the Go daemon yet")
	}

	in, err := s.normalize(body)
	if err != nil {
		return nil, err
	}
	run := func() (any, error) {
		sent, err := s.send(ctx, in)
		if err != nil {
			return nil, err
		}
		// A thread the human starts waits in the archive until an answer comes: the first reply to the human brings it back
		// (archive hides only the messages it recorded). The human's own follow-ups in it stay archived and deferred too.
		if in.from == humanBox {
			if tid, id := sent.Text("thread_id"), sent.Text("id"); tid != "" && id != "" {
				if in.newThread {
					err = s.db.ArchiveHumanThread(ctx, tid, id)
				} else {
					err = s.db.KeepHumanThread(ctx, tid, id)
				}
				if err != nil {
					return nil, err
				}
			}
		}
		return sent, nil
	}
	scope := string(c.Kind) + ":" + c.Agent + "|/api/mail"
	// What an unthreaded send from `from` would thread into depends on the mail it has read in the last 30 minutes, so a
	// retry (which reads nothing in between) keeps the key and the same words after reading other mail do not (S-1663).
	if fv, _ := body.Get("from"); in.replyTo == "" && !in.newThread && fv.Kind == jsfmt.String {
		at, err := s.db.LastReadSince(ctx, in.from, minutesAgo(30))
		if err != nil {
			return nil, err
		}
		scope += "|" + at
	}
	clientID, _ := body.Get("client_id")
	id := ""
	if clientID.Kind == jsfmt.String {
		id = clientID.Str
	}
	return s.sends.run(scope, id, run)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// sendIn is src/mail-input.ts normalizeMailInput's result, for the fields this daemon carries out.
type sendIn struct {
	from, fromShown string
	to              []string
	subject, body   string
	replyTo         string
	newThread       bool
	inferred        map[string]bool
	override        string
	system          string
	hasSystem       bool
	// fromStam marks stam's own mail (src/mail.ts from_stam): the sender only stands in for stam, so the mail is a notice, is
	// not rerouted, gated or looked at by the observers of an agent's mail.
	fromStam bool
	// permissionID is the permission request the mail carries (src/mail.ts permission_id): like stam's own mail it is
	// not rerouted, gated or looked at by the decision steps, but it is the agent's mail, not a notice.
	permissionID string
	// itsa is set for an ITSA's comment (itsa.post): its thread is given, nobody need be told, and the mail is linked to it.
	itsa *itsaMail
}

// itsaMail is what src/itsa.ts post adds to a sendMail call: itsa_id, thread_id, kind, health and interrupt.
type itsaMail struct {
	id, threadID, kind, health string
	interrupt                  []string
}

// normalize is src/mail-input.ts normalizeMailInput: the text may be `body`, `message` or `content`, one recipient a
// string; a mail with no text is refused.
func (s *Server) normalize(body jsfmt.Value) (*sendIn, error) {
	in := &sendIn{inferred: map[string]bool{}}
	text := ""
	found := false
	for _, k := range []string{"body", "message", "content"} {
		if v, ok := body.Get(k); ok && v.Kind == jsfmt.String && strings.TrimSpace(v.Str) != "" {
			text, found = v.Str, true
			break
		}
	}
	atts, _ := body.Get("attachments")
	if !found && !(atts.Kind == jsfmt.Array && len(atts.Items) > 0) {
		return nil, Errorf(http.StatusBadRequest, "body is required: the mail's text")
	}
	in.body = text
	in.from, _ = field(body, "from")
	in.fromShown = "undefined"
	if v, ok := body.Get("from"); ok {
		in.fromShown = anyString(v)
	}
	in.subject, _ = field(body, "subject")
	in.replyTo, _ = field(body, "reply_to")
	if v, ok := body.Get("new_thread"); ok {
		in.newThread = v.Truthy()
	}
	in.system, in.hasSystem = field(body, "system")
	if ov, ok := body.Get("override"); ok && ov.Kind == jsfmt.String {
		in.override = sliceUnits(strings.TrimSpace(ov.Str), 500)
	}
	if v, ok := body.Get("inferred"); ok && v.Kind == jsfmt.Array {
		for _, x := range v.Items {
			in.inferred[anyString(x)] = true
		}
	}
	to, ok := body.Get("to")
	switch {
	case ok && to.Kind == jsfmt.String:
		in.to = []string{to.Str}
	case ok && to.Kind == jsfmt.Array:
		for _, x := range to.Items {
			in.to = append(in.to, anyString(x))
		}
	default:
		return nil, Errorf(http.StatusBadRequest, "to must be a recipient or a list of them")
	}
	return in, nil
}

// sliceUnits is JS slice(0, n) on a string of UTF-16 units, cut at a character.
func sliceUnits(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func minutesAgo(n int) string {
	return time.Now().Add(-time.Duration(n) * time.Minute).UTC().Format("2006-01-02T15:04:05.000Z")
}

func refused(format string, args ...any) error { return Errorf(http.StatusBadRequest, format, args...) }

// senderName is src/mail.ts senderName: the name a mail is shown to be from.
func (s *Server) senderName(ctx context.Context, id string) string {
	if id == humanBox {
		return "the human"
	}
	return s.agentLabel(ctx, id)
}

// ordered is a JS Set of strings: insertion order, each once.
type ordered struct {
	list []string
	has  map[string]bool
}

func (o *ordered) add(x string) {
	if o.has == nil {
		o.has = map[string]bool{}
	}
	if !o.has[x] {
		o.has[x] = true
		o.list = append(o.list, x)
	}
}

func (o *ordered) del(x string) {
	if !o.has[x] {
		return
	}
	delete(o.has, x)
	for i, y := range o.list {
		if y == x {
			o.list = append(o.list[:i], o.list[i+1:]...)
			break
		}
	}
}

// reachable is src/org.ts reachable: the agents `a` may mail under its visibility rules; ok false means everyone.
func (s *Server) reachable(ctx context.Context, a db.Agent) (map[string]bool, bool, error) {
	v := a.VisibilityOf()
	if v.Reach == "all" {
		return nil, false, nil
	}
	parents, err := s.db.ParentsOf(ctx, a)
	if err != nil {
		return nil, false, err
	}
	out := map[string]bool{}
	if v.Reach == "parent" {
		for _, p := range parents {
			out[p] = true
		}
		return out, true, nil
	}
	extra, err := s.db.ExtraParents(ctx)
	if err != nil {
		return nil, false, err
	}
	anc, _ := s.ancestors(ctx, a, extra)
	for id := range anc {
		out[id] = true
	}
	below, err := s.descendants(ctx, a.ID)
	if err != nil {
		return nil, false, err
	}
	for id := range below {
		out[id] = true
	}
	if v.Siblings {
		for _, p := range parents {
			kids, err := s.db.ChildrenOf(ctx, p)
			if err != nil {
				return nil, false, err
			}
			for _, k := range kids {
				if k != a.ID {
					out[k] = true
				}
			}
		}
	}
	return out, true, nil
}

// descendants is src/tree.ts descendantsOf for this daemon's agents.
func (s *Server) descendants(ctx context.Context, id string) (map[string]bool, error) {
	seen := map[string]bool{}
	var walk func(id string) error
	walk = func(id string) error {
		kids, err := s.db.ChildrenOf(ctx, id)
		if err != nil {
			return err
		}
		for _, k := range kids {
			if seen[k] {
				continue
			}
			seen[k] = true
			if err := walk(k); err != nil {
				return err
			}
		}
		return nil
	}
	return seen, walk(id)
}

// checkCanMail is src/org.ts checkCanMail: the human, the chief of staff and an agent's parents are always reachable.
func (s *Server) checkCanMail(ctx context.Context, from, to string) error {
	if from == humanBox || to == humanBox {
		return nil
	}
	a, err := s.db.GetAgent(ctx, from)
	if err != nil {
		return nil
	}
	allowed, limited, err := s.reachable(ctx, a)
	if err != nil {
		return err
	}
	if !limited || allowed[to] || to == s.chiefOfStaffID(ctx) {
		return nil
	}
	which := "its tree"
	if a.VisibilityOf().Reach == "parent" {
		which = "its parents"
	}
	return fmt.Errorf("%s may not mail %s: its parent limited it to %s", a.Name, s.agentLabel(ctx, to), which)
}

// mayReadMail is src/mail-visibility.ts mayReadMail for a reader that is the box itself: if the box, or an agent under
// it, sent or received the mail, or the box's cost_switch successor did; or if it may read the mail's ITSA threads or its whole thread.
func (s *Server) mayReadMail(ctx context.Context, box string, x jsfmt.Value) (bool, error) {
	tid := x.Text("thread_id")
	if tid == "" {
		tid = x.Text("id")
	}
	thread, err := s.db.ThreadMail(ctx, tid, "")
	if err != nil {
		return false, err
	}
	var holders []string
	for _, y := range thread {
		if y.Text("id") != x.Text("id") {
			continue
		}
		holders = append(holders, y.Text("from_id"))
		if rc, ok := y.Get("recipients"); ok {
			for _, r := range rc.Items {
				holders = append(holders, r.Text("id"))
			}
		}
		break
	}
	extra, err := s.db.ExtraParents(ctx)
	if err != nil {
		return false, err
	}
	for _, h := range holders {
		if h == box {
			return true, nil
		}
		a, err := s.db.GetAgent(ctx, h)
		if err != nil {
			continue
		}
		if anc, _ := s.ancestors(ctx, a, extra); anc[box] {
			return true, nil
		}
		if t, err := s.db.ForwardTarget(ctx, h); err == nil && t == box {
			return true, nil
		}
	}
	if it, ok := x.Get("itsa_id"); ok && it.Truthy() {
		// A mail of an ITSA the reader belongs to; an ITSA that is gone (mayReadItsaThreads throws) just doesn't open it.
		if ok, err := s.mayReadItsaThreads(ctx, box, it.Str); err == nil && ok {
			return true, nil
		}
	}
	return s.mayReadWholeThreadAs(ctx, box, box, tid)
}

// guessParent is src/mail.ts guessParent: the mail an agent's message most likely answers, when it named none. A mail
// from a recipient the agent read in the last 30 minutes and hasn't answered, else a thread whose subject it matches in
// the last week; ambiguous reads are asked about.
func (s *Server) guessParent(ctx context.Context, from string, to []string, subject string) (jsfmt.Value, bool, error) {
	var senders []string
	for _, t := range to {
		if t == "all" {
			continue
		}
		if t == humanBox {
			senders = append(senders, humanBox)
		} else if a, err := s.db.GetAgent(ctx, t); err == nil {
			senders = append(senders, a.ID)
		} else {
			senders = append(senders, t)
		}
	}
	recent, err := s.db.MailFrom(ctx, from, senders, minutesAgo(7*24*60))
	if err != nil {
		return jsfmt.Value{}, false, err
	}
	base := func(x string) string { return strings.ToLower(strings.TrimSpace(reRe.ReplaceAllString(x, ""))) }
	answered := func(m jsfmt.Value) bool { v, _ := m.Get("answered"); return v.Truthy() }
	cut := minutesAgo(30)
	var justRead []jsfmt.Value
	for _, m := range recent {
		if ra := m.Text("read_at"); !answered(m) && ra != "" && ra > cut {
			justRead = append(justRead, m)
		}
	}
	sub := base(subject)
	matches := func(m jsfmt.Value) bool {
		return sub != "" && (base(m.Text("root_subject")) == sub || base(m.Text("subject")) == sub)
	}
	if len(justRead) > 0 {
		for _, m := range justRead {
			if matches(m) {
				return m, true, nil
			}
		}
		threads := map[string]bool{}
		var list []string
		for _, m := range justRead {
			t := m.Text("thread_id")
			if t == "" {
				t = m.Text("id")
			}
			threads[t] = true
			list = append(list, fmt.Sprintf(`"%s" (%s)`, m.Text("subject"), m.Text("id")))
		}
		if len(threads) > 1 {
			return jsfmt.Value{}, false, fmt.Errorf("Your mail could answer any of %d threads you read in the last 30 minutes: %s. Pass reply_to to say which one you mean.", len(threads), strings.Join(list, ", "))
		}
		return justRead[0], true, nil
	}
	for _, m := range recent {
		if matches(m) {
			return m, true, nil
		}
	}
	if subject == "" || strings.HasPrefix(strings.ToLower(subject), "re:") {
		for _, m := range recent {
			if !answered(m) {
				return m, true, nil
			}
		}
		if len(recent) > 0 {
			return recent[0], true, nil
		}
	}
	return jsfmt.Value{}, false, nil
}

// notRunning is src/mail.ts notRunning: an agent no mail can reach until it is started again.
func notRunning(a db.Agent) bool {
	return a.Lifecycle == "shut_down" || (a.Lifecycle == "active" && a.Activity == "unknown" && a.ActivityDetail != nil && *a.ActivityDetail == "session ended")
}

// bodyLimit is src/mail.ts BODY_LIMIT_CHARS: about 5,000 tokens. Overflow becomes an attachment.
func bodyLimit() int {
	if n, err := strconv.Atoi(os.Getenv("STAM_MAIL_BODY_CHARS")); err == nil && n > 0 {
		return n
	}
	return 20000
}

// mayMailHuman is src/settings.ts mayMailHuman for an agent's model: a nil or empty model may.
func (s *Server) mayMailHuman(model *string) bool {
	return model == nil || s.settings.Get().HumanMail.MayMail(*model)
}

// gateWouldRun is whether the mail gate (S-983) would check an agent's mail to the human: the setting is on and stam has
// an OpenRouter key (the environment, then the secret store, then opencode.env: config.KeyFor). Fails closed: with a key
// the check would run, and this daemon cannot run it, so the send is refused.
func (s *Server) gateWouldRun() bool {
	return s.settings.Get().MailGate && config.KeyFor(s.cfg.Home, "OPENROUTER_API_KEY", os.Getenv) != ""
}

// embedRefusal answers 501 for a body that embeds files.
func embedRefusal(body string) error {
	if reEmbed.MatchString(body) {
		return Errorf(http.StatusNotImplemented, "embedded files in a mail body are not ported to the Go daemon yet")
	}
	return nil
}

// gateRefusal answers 501 where the mail gate would check an agent's mail to the human: the caller has found it goes to
// them, from an agent, with no override. An ask is never checked.
func (s *Server) gateRefusal(ask bool) error {
	if !ask && s.gateWouldRun() {
		return Errorf(http.StatusNotImplemented, "the mail check on mail to your user is not ported to the Go daemon yet; resend with `override: \"why\"`")
	}
	return nil
}

// humanReroute is the S-548 rule of src/mail.ts: only the chief of staff, the assistant, and managers mail the human
// directly; any other agent's mail to the human goes to its first parent (else the chief of staff), when that agent is here.
func (s *Server) humanReroute(ctx context.Context, sender db.Agent, cos string) (db.Agent, bool, error) {
	if (sender.Kind != nil && *sender.Kind == "assistant") || sender.ID == cos ||
		(sender.Type != nil && (*sender.Type == "manager" || *sender.Type == "coordinator")) {
		return db.Agent{}, false, nil
	}
	parents, err := s.db.ParentsOf(ctx, sender)
	if err != nil {
		return db.Agent{}, false, err
	}
	parent := cos
	if len(parents) > 0 {
		parent = parents[0]
	}
	if parent == "" || parent == sender.ID {
		return db.Agent{}, false, nil
	}
	a, err := s.db.GetAgent(ctx, parent)
	if errors.Is(err, db.ErrNotFound) {
		return db.Agent{}, false, nil
	}
	return a, err == nil, err
}

// send is src/mail.ts sendMail for this daemon's own agents.
func (s *Server) send(ctx context.Context, in *sendIn) (jsfmt.Value, error) {
	to := in.to[:0:0]
	for _, t := range in.to {
		// A system sender has no mailbox: a reply that names it goes to the rest.
		if !strings.HasPrefix(t, "system:") {
			to = append(to, t)
		}
	}
	from, fromName := "", ""
	switch {
	case in.from == humanBox:
		from = humanBox
	case in.from != "":
		if a, err := s.db.GetAgent(ctx, in.from); err == nil {
			from = a.ID
		}
	}
	if from != "" {
		fromName = s.senderName(ctx, from)
	}
	if from == "" && in.hasSystem {
		if !reSystemName.MatchString(in.system) {
			return jsfmt.Value{}, fmt.Errorf("bad system sender %s", in.system)
		}
		from, fromName = "system:"+in.system, in.system
	}
	if from == "" {
		return jsfmt.Value{}, fmt.Errorf("no sender %s", in.fromShown)
	}
	sender, senderErr := s.db.GetAgent(ctx, from)
	isAgent := senderErr == nil
	if senderErr != nil && !errors.Is(senderErr, db.ErrNotFound) {
		return jsfmt.Value{}, senderErr
	}

	// resolve is src/mail.ts resolveRecipient without peers: an agent by id or name, here, or none.
	resolve := func(ref string) (db.Agent, bool, error) {
		a, err := s.db.GetAgent(ctx, ref)
		if errors.Is(err, db.ErrNotFound) {
			return db.Agent{}, false, nil
		}
		return a, err == nil, err
	}
	// The human's mail to an agent nobody has any more is refused up front, in words the human can act on.
	if from == humanBox {
		for _, ref := range to {
			if ref == humanBox || ref == "all" || in.inferred[ref] {
				continue
			}
			if _, ok, err := resolve(ref); err != nil {
				return jsfmt.Value{}, err
			} else if ok {
				continue
			}
			name, err := s.db.LastSenderName(ctx, ref)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if name == "" {
				name = ref
			}
			return jsfmt.Value{}, refused("%s no longer exists. Reply to someone else, or copy your text.", name)
		}
	}
	if err := embedRefusal(in.body); err != nil {
		return jsfmt.Value{}, err
	}

	cos := s.chiefOfStaffID(ctx)
	// The mail replied to; an agent's reply finds it only if the agent may see it. The human and a local script see any.
	subject, replyTo, threadID := in.subject, in.replyTo, ""
	autoThreaded := false
	var replied jsfmt.Value
	haveReplied, hidden := false, false
	if replyTo != "" {
		x, found, err := s.db.GetMail(ctx, replyTo)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if found {
			boss := from == cos || s.isAssistant(ctx, from)
			if isAgent && !boss {
				ok, err := s.mayReadMail(ctx, from, x)
				if err != nil {
					return jsfmt.Value{}, err
				}
				hidden = !ok
			}
			if !hidden {
				replied, haveReplied = x, true
			}
		}
	}
	toHuman := false
	for _, t := range to {
		toHuman = toHuman || t == humanBox
	}
	// An agent's reply to the human's mail reaches them only when it names them (S-542); the agent hears so.
	missesHuman := haveReplied && replied.Text("from_id") == humanBox && isAgent && !in.fromStam && in.permissionID == "" && !toHuman
	// Answering a mail in an ITSA's thread is a comment on the ITSA: the ITSA module.
	asComment := func(parent jsfmt.Value) (jsfmt.Value, bool, error) {
		v, ok := parent.Get("itsa_id")
		if !ok || !v.Truthy() {
			return jsfmt.Value{}, false, nil
		}
		// An agent's reply posts only where the agent may post (S-480); the human and a local script are not checked.
		if from != humanBox && !strings.HasPrefix(from, "system:") && from != cos && !s.isAssistant(ctx, from) {
			x, err := s.mustItsa(ctx, v.Str)
			if err != nil {
				return jsfmt.Value{}, false, err
			}
			if may, err := s.mayPostItsa(ctx, from, x); err != nil {
				return jsfmt.Value{}, false, err
			} else if !may {
				msg, err := s.itsaRefusal(ctx, from, x, "post to")
				if err != nil {
					return jsfmt.Value{}, false, err
				}
				return jsfmt.Value{}, false, Errorf(http.StatusForbidden, "%s", msg)
			}
		}
		req := jsfmt.Value{Kind: jsfmt.Object}
		req.Set("by", jsfmt.StringValue(from))
		req.Set("to", jsfmt.ArrayValue(stringValues(to)))
		var inferred []string
		for _, t := range in.to {
			if in.inferred[t] {
				inferred = append(inferred, t)
			}
		}
		req.Set("inferred", jsfmt.ArrayValue(stringValues(inferred)))
		if in.subject != "" {
			req.Set("subject", jsfmt.StringValue(in.subject))
		}
		req.Set("body", jsfmt.StringValue(in.body))
		req.Set("reply_to", jsfmt.StringValue(parent.Text("id")))
		if in.override != "" {
			req.Set("override", jsfmt.StringValue(in.override))
		}
		posted, err := s.post(ctx, v.Str, req, false)
		return posted, true, err
	}
	if in.itsa != nil {
		// An ITSA's comment is stored in the ITSA's thread, whatever mail it names in reply_to.
		threadID = in.itsa.threadID
	}
	if replyTo != "" && in.itsa == nil {
		if haveReplied {
			posted, done, err := asComment(replied)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if done {
				if missesHuman {
					posted.Set("misses_human", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
				}
				return posted, nil
			}
		}
		if hidden {
			return jsfmt.Value{}, fmt.Errorf("mail %s isn't visible to you (you aren't in its thread), so you can't reply to it. Start a new thread with new_thread: true, or ask whoever pointed you to it to forward that mail to you.", replyTo)
		}
		if !haveReplied {
			return jsfmt.Value{}, fmt.Errorf("no mail %s to reply to", replyTo)
		}
		threadID = replied.Text("thread_id")
		if threadID == "" {
			threadID = replied.Text("id")
		}
		if subject == "" {
			subject = "Re: " + reRe.ReplaceAllString(replied.Text("subject"), "")
		}
	}
	// Like a reply in a Slack thread, an agent's answer lands in the thread it answers, whether or not it named it.
	if threadID == "" && replyTo == "" && !in.newThread && from != humanBox && in.itsa == nil {
		parent, ok, err := s.guessParent(ctx, from, to, subject)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if ok {
			posted, done, err := asComment(parent)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if done {
				return posted, nil
			}
			threadID = parent.Text("thread_id")
			if threadID == "" {
				threadID = parent.Text("id")
			}
			replyTo = parent.Text("id")
			if subject == "" {
				subject = "Re: " + reRe.ReplaceAllString(parent.Text("root_subject"), "")
			}
			autoThreaded = true
		}
	}
	if subject == "" {
		return jsfmt.Value{}, fmt.Errorf("subject is required for a new thread")
	}

	var local, named ordered
	var skipped []string
	for _, ref := range to {
		switch {
		case ref == humanBox:
			local.add(humanBox)
		case ref == "all":
			agents, err := s.db.ListAgents(ctx)
			if err != nil {
				return jsfmt.Value{}, err
			}
			for _, a := range agents {
				if a.Lifecycle != "archived" && a.ForwardedTo == nil && a.ID != from {
					local.add(a.ID)
				}
			}
		default:
			a, ok, err := resolve(ref)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if ok {
				// An agent whose work moved to a successor (cost_switch) has its mail forwarded there.
				target, err := s.db.ForwardTarget(ctx, a.ID)
				if err != nil {
					return jsfmt.Value{}, err
				}
				local.add(target)
				named.add(target)
				continue
			}
			// A recipient the sender didn't name doesn't sink the mail for the rest of the thread (S-603).
			if in.inferred[ref] {
				name, err := s.db.LastSenderName(ctx, ref)
				if err != nil {
					return jsfmt.Value{}, err
				}
				if name == "" {
					name = ref
				}
				skipped = append(skipped, name)
				continue
			}
			return jsfmt.Value{}, refused("no agent %s", ref)
		}
	}
	if len(local.list) == 0 && in.itsa == nil {
		switch {
		case len(skipped) == 0:
			return jsfmt.Value{}, refused("no recipients")
		case from == humanBox:
			return jsfmt.Value{}, refused("%s no longer exists. Reply to someone else, or copy your text.", strings.Join(skipped, ", "))
		}
		return jsfmt.Value{}, refused("no recipients: %s can't get mail any more. Name someone in to.", strings.Join(skipped, ", "))
	}
	// A parent may have limited whom this agent can reach; 'all' then means everyone it may reach.
	if isAgent && contains(to, "all") {
		limits, limited, err := s.reachable(ctx, sender)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if limited {
			for _, id := range append([]string(nil), local.list...) {
				if id != humanBox && !limits[id] {
					local.del(id)
				}
			}
		}
	}
	// S-548: only the chief of staff, the assistant, and managers mail the human directly; any other agent's mail to the
	// human goes to its first parent, who forwards it if it is needed.
	rerouted := ""
	body := in.body
	if isAgent && local.has[humanBox] && !in.fromStam && in.permissionID == "" {
		a, ok, err := s.humanReroute(ctx, sender, cos)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if ok {
			target, err := s.db.ForwardTarget(ctx, a.ID)
			if err != nil {
				return jsfmt.Value{}, err
			}
			local.del(humanBox)
			local.add(target)
			rerouted = a.Name
			body = "Meant for your user. Forward it only if they need it. Subject: " + subject + "\n\n" + body
		}
	}
	for _, id := range local.list {
		if err := s.checkCanMail(ctx, from, id); err != nil {
			return jsfmt.Value{}, err
		}
	}
	// The full suite's failure triage mails agents and comments on ITSAs, never the human.
	if from == "system:full-suite" && local.has[humanBox] {
		return jsfmt.Value{}, refused("%s may mail agents and comment on ITSAs, not your user", from)
	}
	// An agent's mail to the human may be refused for the model it runs.
	if local.has[humanBox] && from != humanBox && isAgent && !in.fromStam && in.permissionID == "" && !s.mayMailHuman(sender.Model) {
		parents, err := s.db.ParentsOf(ctx, sender)
		if err != nil {
			return jsfmt.Value{}, err
		}
		parent := cos
		if len(parents) > 0 {
			parent = parents[0]
		}
		hint := ""
		if parent != "" {
			hint = " (" + s.agentLabel(ctx, parent) + ")"
		}
		return jsfmt.Value{}, fmt.Errorf("%s runs %s, which may not mail your user (Settings › Mail to you). Mail your parent%s instead; it decides what reaches your user.", sender.Name, *sender.Model, hint)
	}
	// S-983: the mail gate checks an agent's mail that still goes to the human before it is stored.
	override := ""
	if local.has[humanBox] && from != humanBox && !strings.HasPrefix(from, "system:") && !in.fromStam && in.permissionID == "" {
		if in.override != "" {
			override = in.override
		} else if err := s.gateRefusal(in.itsa != nil && in.itsa.kind == "ask"); err != nil {
			return jsfmt.Value{}, err
		}
	}

	// The observers of a stored mail that this daemon does not carry (requirement checks, decision steps).
	if !in.fromStam && in.permissionID == "" {
		if err := s.mailObserverRefusal(ctx, from, local.has[humanBox]); err != nil {
			return jsfmt.Value{}, err
		}
	}

	id := db.NewMailID()
	if threadID == "" {
		threadID = id
	}
	if autoThreaded {
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("id", jsfmt.StringValue(id))
		ev.Set("thread_id", jsfmt.StringValue(threadID))
		ev.Set("reply_to", jsfmt.StringValue(replyTo))
		if err := s.db.AddEvent(ctx, from, "mail:auto_threaded", ev); err != nil {
			return jsfmt.Value{}, err
		}
	}

	// The body becomes an attachment past its limit (about 5,000 tokens).
	var files []db.MailFile
	stored := body
	if utf16Len(body) > bodyLimit() {
		dir := filepath.Join(s.cfg.Home, "attachments", id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return jsfmt.Value{}, err
		}
		p := filepath.Join(dir, "full-body.md")
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			return jsfmt.Value{}, err
		}
		info, err := os.Stat(p)
		if err != nil {
			return jsfmt.Value{}, err
		}
		files = append(files, db.MailFile{Name: "full-body.md", Path: p, Size: info.Size()})
		stored = sliceUnits(body, bodyLimit()) + "\n\n[stam: body truncated at about 5,000 tokens; the full text is in the attachment full-body.md]"
	}
	sendToHuman := local.has[humanBox]
	kind, itsaID, health := "", "", ""
	var quiet []string
	if in.itsa != nil {
		kind, itsaID, health = in.itsa.kind, in.itsa.id, in.itsa.health
		for _, r := range local.list {
			if !contains(in.itsa.interrupt, r) {
				quiet = append(quiet, r)
			}
		}
	}
	m := db.Stored{
		ItsaID: itsaID, Kind: kind, Health: health, Quiet: quiet, LinkText: subject + "\n" + body,
		ID: id, ThreadID: threadID, From: from, FromName: fromName, Subject: subject, Body: stored, ReplyTo: replyTo, PermissionID: in.permissionID,
		AutoThreaded: autoThreaded, Notice: (in.hasSystem && in.system != "") || in.fromStam, FromStam: in.fromStam, Override: override, To: local.list, Files: files,
		FromHuman: from == humanBox, DeferThread: from == humanBox && isDeferralOnly(stored, len(files)),
		ToHuman: sendToHuman, DecisionMail: sendToHuman && from != humanBox && kind != "ask" && !in.fromStam && in.permissionID == "" && !reStamSubj.MatchString(subject) && hasDecisionBlock(stored),
	}
	mail, err := s.db.StoreMail(ctx, m)
	if err != nil {
		return jsfmt.Value{}, err
	}
	// notify's idle push: each agent that got it is prompted once it's idle.
	if s.life != nil {
		for _, r := range local.list {
			if r != humanBox {
				s.life.SchedulePush(r)
			}
		}
	}

	// The requirement checks of a stored mail run off the send (src/mail.ts maybeCheckRequirements).
	s.afterMail(ctx, id, from, subject, stored, threadID, local.has[humanBox], in.fromStam)

	// The system view's mail flight: the send is stored and the sender may see it.
	ev := jsfmt.Value{Kind: jsfmt.Object}
	ev.Set("id", jsfmt.StringValue(id))
	ev.Set("from", jsfmt.StringValue(from))
	ev.Set("to", jsfmt.ArrayValue(stringValues(local.list)))
	ev.Set("thread", jsfmt.StringValue(threadID))
	if itsaID != "" {
		ev.Set("itsa", jsfmt.StringValue(itsaID))
	} else {
		ev.Set("itsa", jsfmt.NullValue())
	}
	ev.Set("ask", jsfmt.Value{Kind: jsfmt.Bool, Bool: sendToHuman && (kind == "ask" || hasDecisionBlock(body))})
	ev.Set("subject", jsfmt.StringValue(subject))
	ev.Set("at", jsfmt.StringValue(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
	_ = s.hub.Emit("mail.sent", ev)

	// The sender hears which recipients are not running, so the mail waits unread.
	var stopped []jsfmt.Value
	for _, r := range named.list {
		if a, err := s.db.GetAgent(ctx, r); err == nil && notRunning(a) {
			stopped = append(stopped, jsfmt.StringValue(a.Name))
		}
	}
	if len(stopped) > 0 {
		mail.Set("not_running", jsfmt.ArrayValue(stopped))
	}
	if rerouted != "" {
		mail.Set("rerouted", jsfmt.StringValue(rerouted))
	}
	if len(skipped) > 0 {
		mail.Set("skipped", jsfmt.ArrayValue(stringValues(skipped)))
	}
	if missesHuman {
		mail.Set("misses_human", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	return mail, nil
}

func stringValues(list []string) []jsfmt.Value {
	out := make([]jsfmt.Value, 0, len(list))
	for _, x := range list {
		out = append(out, jsfmt.StringValue(x))
	}
	return out
}

// sendDedup is src/client-dedup.ts: a client that retries a send tags each request with a `client_id`. The first request
// with an id runs; a repeat within the TTL from the same caller on the same path, whether the first is still running or
// already answered, gets the first one's answer and does not run again. A failed first request is forgotten, so the retry
// runs. The caller is part of the key, so one credential can't take another's answer. The map is in memory: a restart
// forgets every id.
type sendDedup struct {
	mu   sync.Mutex
	seen map[string]*dedupEntry
}

type dedupEntry struct {
	at   time.Time
	done chan struct{}
	val  any
	err  error
}

const dedupTTL = 5 * time.Minute

func newSendDedup() *sendDedup { return &sendDedup{seen: map[string]*dedupEntry{}} }

func (d *sendDedup) run(scope, clientID string, fn func() (any, error)) (any, error) {
	if clientID == "" || utf16Len(clientID) > 100 {
		return fn()
	}
	key := scope + "|" + clientID
	d.mu.Lock()
	now := time.Now()
	for k, e := range d.seen {
		if now.Sub(e.at) > dedupTTL {
			delete(d.seen, k)
		}
	}
	if hit := d.seen[key]; hit != nil {
		d.mu.Unlock()
		<-hit.done
		if hit.err == nil {
			return hit.val, nil
		}
		return fn()
	}
	e := &dedupEntry{at: now, done: make(chan struct{})}
	d.seen[key] = e
	d.mu.Unlock()
	e.val, e.err = fn()
	if e.err != nil {
		d.mu.Lock()
		if d.seen[key] == e {
			delete(d.seen, key)
		}
		d.mu.Unlock()
	}
	close(e.done)
	return e.val, e.err
}

// mailHumanFromStam is stam's own mail to the human from an agent (src/mail.ts sendMail with from_stam): the org
// observers' word of an agent's trouble when it has no parent and there is no chief of staff.
func (s *Server) mailHumanFromStam(ctx context.Context, from, subject, body string) error {
	_, err := s.send(ctx, &sendIn{from: from, to: []string{humanBox}, subject: subject, body: body, fromStam: true, inferred: map[string]bool{}})
	return err
}
