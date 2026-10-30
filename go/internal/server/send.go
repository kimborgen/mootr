package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"

	"zombiezen.com/go/sqlite"
)

// POST /api/mail for this daemon's own agents, the human, `all` and recipients on a peer, and a peer's forwarded mail
// (src/daemon.ts, src/mail.ts sendMail; S-2824 slice B, S-4100). Not ported, and each answers 501 naming it: supersedes, the web UI's notes (routing_uncertain, looking_at), the stam-only fields (itsa_id, health,
// permission_id, mail_id, thread_id, interrupt, title, summary) except on a peer's forwarded mail, the ```embed blocks,
// and the mail check on mail to the human (answered 501 unless the send carries an `override`, or no check would run).
// Left out without an error: the ```pane capture, the web push, the title and the mail check after delivery, the link to
// the ITSAs the text names, and the notice to the parent of a stopped recipient.

// stamFields is src/mail.ts DAEMON_FIELDS: the fields only stam sets, refused from an agent's token.
var stamFields = []string{"forwarded", "relay", "relay_route", "thread_id", "itsa_id", "mail_id", "from_stam", "permission_id", "interrupt", "inferred", "kind", "health", "auto_threaded", "about_itsa", "title", "summary", "system"}

// notPorted are the body fields a human or the shared token may set that this daemon does not carry out yet.
var notPorted = []string{"thread_id", "itsa_id", "mail_id", "permission_id", "interrupt", "health", "auto_threaded", "about_itsa", "title", "summary", "only", "supersedes", "routing_uncertain", "looking_at"}

// Mail kinds stam sends under (src/mail-visibility.ts ASK_NOTE): stam's note to the human under an ask placed in another
// thread, sealed like the ask so the thread's other readers never see it (S-3830).
const askNoteKind = "ask-note"

// sealedKinds are the kinds src/mail-visibility.ts seals (ASK_LINK, ASK_REPLY, ASK_NOTE): only the holders of a placed ask
// see them. The Go readers don't filter them yet (S-3928), so the send doesn't take them from the human or the shared token.
var sealedKinds = []string{"ask-link", "ask-reply", "ask-note"}

func isSealedKind(k string) bool { return contains(sealedKinds, k) }

var systemSenders = []string{"deploy-watch", "full-suite"}

// fwdFields are the notPorted fields a peer's forwarded mail carries, which this daemon stores as given.
var fwdFields = map[string]bool{"thread_id": true, "mail_id": true, "about_itsa": true, "permission_id": true, "auto_threaded": true, "itsa_id": true, "kind": true, "health": true, "interrupt": true}

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

// isHuman is the route's `human`: the request is the human's (src/daemon.ts). The human's proof counts, with or
// without a token beside it, and without auth.humanStrict so does any non-agent caller sending x-stam-human.
func (s *Server) isHuman(r *http.Request, c auth.Resolved) bool {
	if c.Caller.IsAgent() {
		return false
	}
	if s.settings.Get().Auth.HumanStrict {
		return c.Owned && r.Header.Get("X-Stam-Local") != "1"
	}
	return r.Header.Get("X-Stam-Human") == "1" || c.Owned
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

func (s *Server) sendMailRoute(r *http.Request, c auth.Resolved) (any, error) {
	// A client that hangs up must not leave half a send, or a retry with the same client_id a mail stored and unanswered:
	// the whole route runs without the request's cancellation.
	ctx := context.WithoutCancel(r.Context())
	body, err := jsonBody(r)
	if err != nil {
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
	// from_stam marks stam's own notice (S-2033). Only a peer's daemon sending its own mail may set it.
	fromStam, hasFromStam := body.Get("from_stam")
	if hasFromStam && !(c.Local && c.Kind == auth.Shared) {
		return nil, Errorf(http.StatusForbidden, "from_stam is set only by stam")
	}
	// `forwarded` is a peer's relay of its own sender's mail, and `relay` one this daemon sends on. Both skip checks the
	// sender's own daemon made (the reroute to its parent, the model block, the gate of a forwarded copy) and may name any
	// sender, so they count only from a peer (the peer token with x-stam-local), whatever auth.humanStrict says (S-543,
	// S-4100 review).
	fwdV, _ := body.Get("forwarded")
	fwd := fwdV.Truthy()
	if relayV, _ := body.Get("relay"); (fwd || relayV.Truthy()) && !(c.Verified == auth.Peer && c.Local) {
		return nil, Errorf(http.StatusForbidden, "forwarded mail comes only from a peer")
	}
	human := s.isHuman(r, c)
	from, _ := field(body, "from")
	if from == humanBox && !human && !fwd {
		return nil, Errorf(http.StatusForbidden, "only the human mails as the human")
	}
	if sys, has := field(body, "system"); has {
		watcher := !c.Caller.IsAgent() && contains(systemSenders, sys)
		if !human && !watcher && !fwd {
			return nil, Errorf(http.StatusForbidden, "only the human mails as a system sender")
		}
	}
	// A peer forwards its own system senders' mail as `system:NAME` (S-1239): the name must be a valid one.
	if fwd && strings.HasPrefix(from, "system:") && !reSystemName.MatchString(strings.TrimPrefix(from, "system:")) {
		return nil, Errorf(http.StatusBadRequest, "bad system sender %s", from)
	}
	for _, f := range notPorted {
		// A forwarded mail carries the id, thread and ITSA its sender's daemon gave it, and the permission request it is.
		if fwd && fwdFields[f] {
			continue
		}
		if v, ok := body.Get(f); ok && v.Truthy() {
			return nil, Errorf(http.StatusNotImplemented, "%s is not ported to the Go daemon yet", f)
		}
	}
	// A sealed kind (src/mail-visibility.ts) from the human or the shared token is refused as it was before the port: the
	// Go readers don't filter sealed mail for its holders yet (S-3928). A peer's copy of one is stored with no kind, below.
	if kv, ok := body.Get("kind"); ok && kv.Truthy() && !fwd && isSealedKind(anyString(kv)) {
		return nil, Errorf(http.StatusNotImplemented, "kind is not ported to the Go daemon yet")
	}
	in, err := s.normalize(body)
	if err != nil {
		return nil, err
	}
	if fwd {
		if err := checkFwdItsa(body); err != nil {
			return nil, err
		}
	}
	in.fromStam = fromStam.Truthy()
	if fwd {
		in.peerSender, in.peerKnown = s.senderPeer(c)
	}
	// The ITSA the sender names is the mail's about_itsa (src/mail.ts sendMail).
	if v, ok := body.Get("itsa"); ok && v.Truthy() {
		if in.aboutItsa, err = s.itsaIDOf(ctx, anyString(v)); err != nil {
			return nil, err
		}
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
		// Mail to or from the human can resolve a thread: the auto-archive pass runs soon after (S-637).
		if in.from == humanBox || contains(in.to, humanBox) {
			s.nudgeAutoArchive()
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
	// kind is the mail's kind (src/mail.ts kind): stam's ask-note under a placed ask, or an ITSA's kind. Only the human, the
	// shared token, and a peer's forwarded copy may set it (sendMailRoute refuses it from an agent's token).
	kind string
	// itsa is set for an ITSA's comment (itsa.post): its thread is given, nobody need be told, and the mail is linked to it.
	itsa *itsaMail
	// aboutItsa is the ITSA the sender named (`itsa`), by id.
	aboutItsa string
	// attachments are the files the sender attached: each a path to copy, or its content as text or base64.
	attachments []jsfmt.Value
	// forwarded is a peer's copy of its sender's mail (src/mail.ts forwarded): already routed and checked where it was sent,
	// with the id and thread that daemon gave it. fwdFromName is the sender's name there.
	forwarded                        bool
	fwdFromName, mailID, fwdThreadID string
	autoThreaded                     bool
	// relay marks a forwarded mail this daemon sends on (src/mail.ts relay): an ITSA post the home sends for an agent on a
	// peer. Its recipients are looked up on the peers too, and it is gated here like the sender's own mail.
	relay bool
	// relayRoute is the routing facts the peer that sent a relayed original attached (S-4163): whether the S-548 rule exempts
	// its sender, and the parent its mail to the human reroutes to. Nil on an older peer, whose relay keeps main's delivery.
	relayRoute *relayRouteFacts
	// onlyTo is the people a reach-limited agent's post was checked against (itsa_post.go only_to): the mail's final
	// recipients, after forwarding, must be among them. A peer's copy carries it, so the peer checks its own.
	onlyTo    []string
	hasOnlyTo bool
	// inTx runs in the transaction that stores the mail here, with its id (db.Stored.InTx): a delivery that must commit
	// with the mail.
	inTx func(conn *sqlite.Conn, mailID string) error
	// peerSender is the peer that sent a forwarded mail, when it can be told (senderPeer); peerKnown says it can.
	peerSender string
	peerKnown  bool
}

// peerSent is whether a forwarded mail is really from its sender (S-4332), so it may clear a wait_for on that sender. It
// fails closed:
//   - a sender this daemon holds reaches its waiters here directly; a forwarded copy naming it is only the ITSA home's
//     relay of its ITSA post, so it counts only with an ITSA, when the home is a configured peer other than this machine
//     (an itsa_id alone in the body is not enough), and, once the sender peer can be told, sent by that home;
//   - a sender on a peer counts only when a configured peer holds it (a peer_agents row on one), and, once the sender
//     peer can be told, when that is the peer that sent it. Until S-4127 gives each peer its own token the sender peer
//     can't be told (senderPeer), so any configured peer's word for an agent a peer holds is taken.
func (s *Server) peerSent(ctx context.Context, in *sendIn, sender db.Agent, isAgent bool) bool {
	if isAgent && (sender.Machine == "" || sender.Machine == s.cfg.Machine) {
		home, ok := s.homePeer()
		return in.itsa != nil && ok && home.Name != s.cfg.Machine && (!in.peerKnown || in.peerSender == home.Name)
	}
	lookup := s.db.PeerAgentByID
	if s.peerAgentByID != nil {
		lookup = s.peerAgentByID
	}
	ref, ok, err := lookup(ctx, in.from)
	if err != nil || !ok || !s.isPeer(ref.Machine) {
		return false
	}
	return !in.peerKnown || ref.Machine == in.peerSender
}

// isPeer is whether name is a configured peer.
func (s *Server) isPeer(name string) bool {
	if s.peers == nil {
		return false
	}
	for _, p := range s.peers.Peers() {
		if p.Name == name {
			return true
		}
	}
	return false
}

// itsaMail is what src/itsa.ts post adds to a sendMail call: itsa_id, thread_id, kind, health and interrupt.
type itsaMail struct {
	id, threadID, kind, health string
	interrupt                  []string
}

// mailKind is the kind the mail is stored and sent under: an ITSA's post has its ITSA's kind (src/itsa.ts post), any other
// mail the kind it was given.
func (in *sendIn) mailKind() string {
	if in.itsa != nil {
		return in.itsa.kind
	}
	return in.kind
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
	if atts.Kind == jsfmt.Array {
		in.attachments = atts.Items
	}
	in.from, _ = field(body, "from")
	in.fromShown = "undefined"
	if v, ok := body.Get("from"); ok {
		in.fromShown = anyString(v)
	}
	in.subject, _ = field(body, "subject")
	in.kind, _ = field(body, "kind")
	in.replyTo, _ = field(body, "reply_to")
	if v, ok := body.Get("new_thread"); ok {
		in.newThread = v.Truthy()
	}
	in.system, in.hasSystem = field(body, "system")
	if v, ok := body.Get("forwarded"); ok && v.Truthy() {
		in.forwarded = true
		if r, ok := body.Get("relay"); ok {
			in.relay = r.Truthy()
		}
		in.relayRoute = parseRelayRoute(body)
		if v.Kind == jsfmt.Object {
			in.fwdFromName = v.Text("from_name")
		}
		in.mailID, _ = field(body, "mail_id")
		in.fwdThreadID, _ = field(body, "thread_id")
		in.aboutItsa, _ = field(body, "about_itsa")
		in.permissionID, _ = field(body, "permission_id")
		if a, ok := body.Get("auto_threaded"); ok {
			in.autoThreaded = a.Truthy()
		}
		if v, ok := body.Get("only_to"); ok && v.Kind != jsfmt.Null {
			list, err := stringList(body, "only_to")
			if err != nil {
				return nil, err
			}
			in.onlyTo, in.hasOnlyTo = list, true
		}
		// An ITSA's post the home sent on to this machine's agents keeps its ITSA, kind and health, and interrupts only those
		// it names (src/mail.ts storeMail).
		if itsaID, _ := field(body, "itsa_id"); itsaID != "" {
			in.itsa = &itsaMail{id: itsaID, threadID: in.fwdThreadID}
			in.itsa.kind, _ = field(body, "kind")
			in.itsa.health, _ = field(body, "health")
			if v, ok := body.Get("interrupt"); ok && v.Kind == jsfmt.Array {
				for _, x := range v.Items {
					if x.Kind == jsfmt.String {
						in.itsa.interrupt = append(in.itsa.interrupt, x.Str)
					}
				}
			}
		}
	}
	// A peer's copy of a sealed kind is stored with none (S-3928), as before the kind port.
	if in.forwarded && isSealedKind(in.kind) {
		in.kind = ""
	}
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
	// A forwarded post interrupts only its recipients here.
	if in.itsa != nil {
		var keep []string
		for _, x := range in.itsa.interrupt {
			if contains(in.to, x) {
				keep = append(keep, x)
			}
		}
		in.itsa.interrupt = keep
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

// fwdItsaFields are the fields an ITSA's post adds to the mail the home forwards (src/itsa.ts post). The kind is the mail's
// own (mailKind): on a mail with no ITSA it is any kind, so it is checked only with an ITSA's fields.
var fwdItsaFields = []string{"itsa_id", "health", "interrupt"}

var reFwdItsaID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// fwdItsaField is a forwarded ITSA field that is set: TS forwards its input as it is, so a null is no field.
func fwdItsaField(body jsfmt.Value, f string) (jsfmt.Value, bool) {
	v, ok := body.Get(f)
	return v, ok && v.Kind != jsfmt.Null
}

func hasFwdItsaField(body jsfmt.Value) bool {
	for _, f := range fwdItsaFields {
		if _, ok := fwdItsaField(body, f); ok {
			return true
		}
	}
	return false
}

// checkFwdItsa refuses a forwarded mail's ITSA fields unless they are what the home's post sends: an ITSA id, a kind it
// posts (comment, update or ask) with a health only on an update, and interrupt as a list of ids. An id in interrupt
// that is not one of the mail's recipients here is ignored (normalize keeps only those): a TS home sends the whole list.
func checkFwdItsa(body jsfmt.Value) error {
	if !hasFwdItsaField(body) {
		return nil
	}
	id, ok := fwdItsaField(body, "itsa_id")
	if !ok || id.Kind != jsfmt.String || !reFwdItsaID.MatchString(id.Str) {
		return refused("a forwarded ITSA post needs an itsa_id")
	}
	kind := "comment"
	if v, ok := fwdItsaField(body, "kind"); ok {
		if v.Kind != jsfmt.String {
			return refused("bad kind on a forwarded ITSA post")
		}
		kind = v.Str
	}
	health := ""
	if v, ok := fwdItsaField(body, "health"); ok {
		if v.Kind != jsfmt.String {
			return refused("bad health on a forwarded ITSA post")
		}
		health = v.Str
	}
	switch {
	case kind == "update" && !contains(healths, health):
		return refused("a forwarded update needs a health: %s", strings.Join(healths, ", "))
	case kind == "comment" || kind == "ask":
		if health != "" {
			return refused("only an update has a health")
		}
	case kind != "update":
		return refused("unknown kind %s on a forwarded ITSA post", kind)
	}
	if v, ok := fwdItsaField(body, "interrupt"); ok {
		if v.Kind != jsfmt.Array {
			return refused("interrupt is a list of agent ids")
		}
		for _, x := range v.Items {
			if x.Kind != jsfmt.String {
				return refused("interrupt is a list of agent ids")
			}
		}
	}
	return nil
}

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

// mayReadMail is src/mail-visibility.ts mayReadMail for a reader that is the box itself.
func (s *Server) mayReadMail(ctx context.Context, box string, x jsfmt.Value) (bool, error) {
	return s.mayReadMailBy(ctx, box, box, x)
}

// mayReadMailBy is src/mail-visibility.ts mayReadMail: if the box, or an agent under it, sent or received the mail, or the
// box's cost_switch successor did; or if reader, the agent asking, may read the mail's ITSA threads or its whole thread.
func (s *Server) mayReadMailBy(ctx context.Context, box, reader string, x jsfmt.Value) (bool, error) {
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
		if ok, err := s.mayReadItsaThreads(ctx, reader, it.Str); err == nil && ok {
			return true, nil
		}
	}
	return s.mayReadWholeThreadAs(ctx, reader, box, tid)
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
// itsas are the ITSAs the mail is in: the owner of all of them mails the human directly (S-4163, ownsItsaWithHuman).
func (s *Server) humanReroute(ctx context.Context, sender db.Agent, cos string, itsas []string) (rerouteTo, bool, error) {
	if humanExempt(sender, cos) {
		return rerouteTo{}, false, nil
	}
	owns, err := s.ownsItsaWithHuman(ctx, sender.ID, string(sender.Lifecycle), itsas)
	if err != nil || owns {
		return rerouteTo{}, false, err
	}
	return s.parentReroute(ctx, sender, cos)
}

// parentReroute is the parent part of humanReroute: the first parent of sender (else cos) when it is here or on a peer. No
// reroute when that parent is absent, is sender itself, or can't be resolved, so the mail goes to the human directly; the
// ask pre-check (askDirect) calls it too, so it predicts the same send.
func (s *Server) parentReroute(ctx context.Context, sender db.Agent, cos string) (rerouteTo, bool, error) {
	parents, err := s.db.ParentsOf(ctx, sender)
	if err != nil {
		return rerouteTo{}, false, err
	}
	parent := cos
	if len(parents) > 0 {
		parent = parents[0]
	}
	if parent == "" || parent == sender.ID {
		return rerouteTo{}, false, nil
	}
	// The parent may be on a peer (a storage agent's parent runs on the home daemon), so it is resolved like any recipient.
	hit, res, err := s.resolveRecipient(ctx, parent, false)
	if err != nil || res != foundAgent {
		return rerouteTo{}, false, err
	}
	return rerouteTo{ID: hit.Agent.ID, Name: hit.Agent.Name, peer: hit.Peer}, true, nil
}

// relayRouteFacts are the routing facts a relayed original carries (S-4163, src/mail.ts relay_route).
type relayRouteFacts struct {
	exempt bool
	parent string
	// parentFound is whether parent resolves here or on a peer, and parentLife the lifecycle its lookup gave, both set before a
	// relayed move's transaction (S-4178). routed is whether the move asks the human, and owner the owner it leaves.
	parentFound bool
	parentLife  string
	routed      bool
	owner       string
}

// parseRelayRoute reads relay_route from a body: the facts a peer attached, or nil when it has none.
func parseRelayRoute(body jsfmt.Value) *relayRouteFacts {
	v, ok := body.Get("relay_route")
	if !ok || v.Kind != jsfmt.Object {
		return nil
	}
	ex, _ := v.Get("exempt")
	return &relayRouteFacts{exempt: ex.Kind == jsfmt.Bool && ex.Bool, parent: v.Text("parent")}
}

// relayRouteOf is src/mail.ts relayRouteOf (S-4163): the routing facts of a local agent its daemon attaches to a relayed post,
// read here from the DB. ok is false for an agent this daemon doesn't have.
func (s *Server) relayRouteOf(ctx context.Context, id string) (relayRouteFacts, bool, error) {
	a, err := s.db.GetAgent(ctx, id)
	if errors.Is(err, db.ErrNotFound) {
		return relayRouteFacts{}, false, nil
	}
	if err != nil {
		return relayRouteFacts{}, false, err
	}
	cos := s.chiefOfStaffID(ctx)
	out := relayRouteFacts{exempt: (a.Kind != nil && *a.Kind == "assistant") || a.ID == cos || (a.Type != nil && (*a.Type == "manager" || *a.Type == "coordinator"))}
	parents, err := s.db.ParentsOf(ctx, a)
	if err != nil {
		return relayRouteFacts{}, false, err
	}
	parent := cos
	if len(parents) > 0 {
		parent = parents[0]
	}
	if parent != "" && parent != a.ID {
		out.parent = parent
	}
	return out, true, nil
}

// value is the facts as a body's relay_route in the TS daemon's shape: exempt, and parent when there is one.
func (f relayRouteFacts) value() jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("exempt", jsfmt.Value{Kind: jsfmt.Bool, Bool: f.exempt})
	if f.parent != "" {
		out.Set("parent", jsfmt.StringValue(f.parent))
	}
	return out
}

// rerouteTo is the parent an agent's mail to the human goes to instead: here, or on a peer.
type rerouteTo struct {
	ID, Name string
	peer     *config.Peer
}

// humanExempt is the S-548 exemption: the chief of staff, the assistant, managers and coordinators mail the human directly.
func humanExempt(sender db.Agent, cos string) bool {
	return (sender.Kind != nil && *sender.Kind == "assistant") || sender.ID == cos ||
		(sender.Type != nil && (*sender.Type == "manager" || *sender.Type == "coordinator"))
}

// ownsItsaWithHuman is itsa.ts ownsItsaWithHuman (S-4163): the agent is live, owns every ITSA in itsas, and the human takes
// part in each. Read from the DB at send time, so a reassigned ITSA or an archived agent doesn't qualify.
func (s *Server) ownsItsaWithHuman(ctx context.Context, agentID, lifecycle string, itsas []string) (bool, error) {
	if len(itsas) == 0 || lifecycle == "archived" {
		return false, nil
	}
	for _, id := range itsas {
		x, ok, err := s.db.FindItsa(ctx, id)
		if err != nil || !ok || x.Text("owner") != agentID {
			return false, err
		}
		people, err := s.db.ItsaParticipants(ctx, x.Text("id"))
		if err != nil || !contains(people, humanBox) {
			return false, err
		}
	}
	return true, nil
}

// mailItsaIDs are the ITSAs a mail is in, for ownsItsaWithHuman (src/mail.ts inOwnItsa): the one it posts to, the one its
// `itsa` field names, the one it replies to, and those whose thread it is in.
func (s *Server) mailItsaIDs(ctx context.Context, in *sendIn, replied jsfmt.Value, haveReplied bool, threadID string) ([]string, error) {
	var ids []string
	if in.itsa != nil {
		ids = append(ids, in.itsa.id)
	}
	if in.aboutItsa != "" {
		ids = append(ids, in.aboutItsa)
	}
	if haveReplied && replied.Text("itsa_id") != "" {
		ids = append(ids, replied.Text("itsa_id"))
	}
	if threadID != "" {
		more, err := s.db.ThreadItsaIDs(ctx, threadID)
		if err != nil {
			return nil, err
		}
		ids = append(ids, more...)
	}
	return ids, nil
}

// send is src/mail.ts sendMail for this daemon's own agents.
func (s *Server) send(ctx context.Context, in *sendIn) (jsfmt.Value, error) {
	if err := checkForwardedIDs(in); err != nil {
		return jsfmt.Value{}, err
	}
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
	if from == "" && in.forwarded {
		from, fromName = in.from, in.fwdFromName
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

	// The human's mail to an agent nobody has any more is refused up front, in words the human can act on.
	if from == humanBox && !in.forwarded {
		for _, ref := range to {
			if ref == humanBox || ref == "all" || in.inferred[ref] {
				continue
			}
			if _, res, err := s.resolveRecipient(ctx, ref, false); err != nil {
				return jsfmt.Value{}, err
			} else if res != foundAbsent {
				continue
			}
			name, err := s.goneName(ctx, ref)
			if err != nil {
				return jsfmt.Value{}, err
			}
			return jsfmt.Value{}, refused("%s no longer exists. Reply to someone else, or copy your text.", name)
		}
	}
	if !in.forwarded {
		if err := embedRefusal(in.body); err != nil {
			return jsfmt.Value{}, err
		}
	}

	cos := s.chiefOfStaffID(ctx)
	// The mail replied to; an agent's reply finds it only if the agent may see it. The human and a local script see any.
	subject, replyTo, threadID := in.subject, in.replyTo, ""
	autoThreaded := false
	var replied jsfmt.Value
	haveReplied, hidden, unreachable := false, false, false
	if replyTo != "" && !in.forwarded {
		// An agent's reply asks the peers as that agent, which checks what it may see.
		var via *peers.Via
		if isAgent {
			via = &peers.Via{Agent: from, Boss: from == cos || s.isAssistant(ctx, from)}
		}
		var err error
		if replied, haveReplied, unreachable, hidden, err = s.replyParent(ctx, replyTo, via); err != nil {
			return jsfmt.Value{}, err
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
		if !ok || !v.Truthy() || in.forwarded {
			return jsfmt.Value{}, false, nil
		}
		// S-4163: an explicit `itsa` that isn't the ITSA the reply is in would be dropped by the comment, so it is refused.
		if in.aboutItsa != "" && v.Str != in.aboutItsa {
			return jsfmt.Value{}, false, refused("mail %s is in another ITSA than the one you named: reply without itsa, or name the ITSA it is in", parent.Text("id"))
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
		if len(in.attachments) > 0 {
			req.Set("attachments", jsfmt.ArrayValue(in.attachments))
		}
		req.Set("reply_to", jsfmt.StringValue(parent.Text("id")))
		if in.override != "" {
			req.Set("override", jsfmt.StringValue(in.override))
		}
		// Off the home the post is the home's, which checks the agent as via (itsa.ts postRouted).
		if !s.isHome() {
			posted, err := s.postOnHome(ctx, v.Str, req, from, cos)
			return posted, true, err
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
		posted, err := s.post(ctx, v.Str, req, false)
		return posted, true, err
	}
	if in.itsa != nil {
		// An ITSA's comment is stored in the ITSA's thread, whatever mail it names in reply_to.
		threadID = in.itsa.threadID
	}
	// A peer's forwarded copy already carries its thread.
	if in.forwarded {
		threadID = in.fwdThreadID
	}
	if replyTo != "" && in.itsa == nil && !in.forwarded {
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
			why := ""
			if unreachable {
				why = " (a peer was unreachable)"
			}
			return jsfmt.Value{}, fmt.Errorf("no mail %s to reply to%s", replyTo, why)
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
	if threadID == "" && replyTo == "" && !in.newThread && from != humanBox && in.itsa == nil && !in.forwarded {
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
	// The peers' recipients, each peer's in order; inferredIDs are those the sender didn't name, by id, so a peer skips
	// them too.
	var remote remoteSends
	inferredIDs := map[string]bool{}
	// A peer's forwarded copy names only agents here; a relayed one is sent on, so its recipients are looked up on the peers.
	skipPeers := in.forwarded && !in.relay
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
			if !in.forwarded {
				for _, p := range s.peers.Peers() {
					remote.add(p, "all")
				}
			}
		default:
			hit, res, err := s.resolveRecipient(ctx, ref, skipPeers)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if res == foundAgent && hit.Peer != nil {
				remote.add(*hit.Peer, hit.Agent.ID)
				if in.inferred[ref] {
					inferredIDs[hit.Agent.ID] = true
				}
				continue
			}
			if res == foundAgent {
				// An agent whose work moved to a successor (cost_switch) has its mail forwarded there.
				target, err := s.db.ForwardTarget(ctx, hit.Agent.ID)
				if err != nil {
					return jsfmt.Value{}, err
				}
				local.add(target)
				named.add(target)
				continue
			}
			// Known on a peer that doesn't answer: its mail waits in the outbox (S-235). An agent no peer has, or one a peer
			// answered 404 for, is forgotten and fails as before.
			if res == foundUnreachable && !in.forwarded {
				known, ok, err := s.db.FindPeerAgent(ctx, ref)
				if err != nil {
					return jsfmt.Value{}, err
				}
				if ok {
					lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, known.ID)
					if err != nil {
						return jsfmt.Value{}, err
					}
					if p, configured := s.peers.ByName(known.Machine); configured && lifecycle != "archived" {
						remote.add(p, known.ID)
						if in.inferred[ref] {
							inferredIDs[known.ID] = true
						}
						continue
					}
					if lifecycle == "archived" && !in.inferred[ref] {
						return jsfmt.Value{}, refused("no agent %s: %s is archived and %s doesn't answer", ref, known.Name, known.Machine)
					}
				}
			}
			if res == foundAbsent && !skipPeers {
				if err := s.db.ForgetPeerAgent(ctx, ref); err != nil {
					return jsfmt.Value{}, err
				}
			}
			// A recipient the sender didn't name doesn't sink the mail for the rest of the thread (S-603).
			if in.inferred[ref] {
				name, err := s.goneName(ctx, ref)
				if err != nil {
					return jsfmt.Value{}, err
				}
				skipped = append(skipped, name)
				continue
			}
			return jsfmt.Value{}, refused("no agent %s", ref)
		}
	}
	if len(local.list) == 0 && len(remote.peers) == 0 && in.itsa == nil {
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
			// A peer can't tell what this sender may reach (it isn't an agent there), so its `all` isn't forwarded: the
			// agents on peers it may reach get the mail by id instead (S-4100 review; TS forwards `all`).
			remote.dropAll()
			ids := make([]string, 0, len(limits))
			for id := range limits {
				ids = append(ids, id)
			}
			slices.Sort(ids)
			for _, id := range ids {
				if local.has[id] || contains(remote.ids(), id) {
					continue
				}
				if _, err := s.db.GetAgent(ctx, id); err == nil {
					continue
				} else if !errors.Is(err, db.ErrNotFound) {
					return jsfmt.Value{}, err
				}
				known, ok, err := s.db.FindPeerAgent(ctx, id)
				if err != nil {
					return jsfmt.Value{}, err
				}
				if !ok || known.ID != id {
					continue
				}
				lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, id)
				if err != nil {
					return jsfmt.Value{}, err
				}
				if p, configured := s.peers.ByName(known.Machine); configured && lifecycle != "archived" {
					remote.addFromAll(p, id)
				}
			}
		}
	}
	// S-548: only the chief of staff, the assistant, and managers mail the human directly; any other agent's mail to the
	// human goes to its first parent, who forwards it if it is needed.
	rerouted := ""
	body := in.body
	// S-4163: a relayed original (an ITSA post an agent on a peer relays here) follows the S-548 rule with the facts its sending
	// daemon attached: an exempt sender goes direct as before, the ITSA's owner goes direct, and anyone else reroutes to the parent
	// that daemon named. Without facts (an older peer) it keeps main's delivery.
	if in.forwarded && in.relay && in.relayRoute != nil && local.has[humanBox] && !isAgent && from != humanBox && !strings.HasPrefix(from, "system:") && !in.fromStam && in.permissionID == "" && !in.relayRoute.exempt {
		lifecycle, _, err := s.db.PeerAgentLifecycle(ctx, from)
		if err != nil {
			return jsfmt.Value{}, err
		}
		itsas, err := s.mailItsaIDs(ctx, in, replied, haveReplied, threadID)
		if err != nil {
			return jsfmt.Value{}, err
		}
		owns, err := s.ownsItsaWithHuman(ctx, from, lifecycle, itsas)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if !owns {
			hit, res, err := s.resolveRecipient(ctx, in.relayRoute.parent, false)
			if err != nil {
				return jsfmt.Value{}, err
			}
			if res != foundAgent {
				return jsfmt.Value{}, refused("%s can't mail your user through this ITSA, and its parent can't be reached from here. Mail its parent instead; it decides what reaches your user.", fromName)
			}
			local.del(humanBox)
			if hit.Peer != nil {
				remote.add(*hit.Peer, hit.Agent.ID)
			} else {
				target, err := s.db.ForwardTarget(ctx, hit.Agent.ID)
				if err != nil {
					return jsfmt.Value{}, err
				}
				local.add(target)
			}
			rerouted = hit.Agent.Name
			body = "Meant for your user. Forward it only if they need it. Subject: " + subject + "\n\n" + body
		}
	}
	if isAgent && local.has[humanBox] && !in.fromStam && in.permissionID == "" && (!in.forwarded || in.relay) {
		itsas, err := s.mailItsaIDs(ctx, in, replied, haveReplied, threadID)
		if err != nil {
			return jsfmt.Value{}, err
		}
		a, ok, err := s.humanReroute(ctx, sender, cos, itsas)
		if err != nil {
			return jsfmt.Value{}, err
		}
		if ok && a.peer != nil {
			local.del(humanBox)
			remote.add(*a.peer, a.ID)
			rerouted = a.Name
			body = "Meant for your user. Forward it only if they need it. Subject: " + subject + "\n\n" + body
		} else if ok {
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
	for _, id := range append(append([]string(nil), local.list...), remote.ids()...) {
		if id == "all" {
			continue
		}
		if err := s.checkCanMail(ctx, from, id); err != nil {
			return jsfmt.Value{}, err
		}
		// A reach-checked post reaches only those it was checked against, after forwarding too: an agent that moved its work
		// to a successor (cost_switch) forwards to one nobody checked.
		if in.hasOnlyTo && !contains(in.onlyTo, id) {
			return jsfmt.Value{}, Errorf(http.StatusConflict, "the ITSA's people changed since the post was checked (%s is new to it); try again", s.agentLabel(ctx, id))
		}
	}
	// The full suite's failure triage mails agents and comments on ITSAs, never the human.
	if from == "system:full-suite" && local.has[humanBox] {
		return jsfmt.Value{}, refused("%s may mail agents and comment on ITSAs, not your user", from)
	}
	// An agent's mail to the human may be refused for the model it runs.
	if local.has[humanBox] && from != humanBox && isAgent && !in.fromStam && in.permissionID == "" && !in.forwarded && !s.mayMailHuman(sender.Model) {
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
	// S-983: the mail gate checks an agent's mail that still goes to the human before it is stored. A peer's forwarded copy
	// was gated where it was sent; a relayed one is sent from here, so it is gated here.
	override := ""
	if local.has[humanBox] && from != humanBox && !strings.HasPrefix(from, "system:") && !in.fromStam && in.permissionID == "" && (!in.forwarded || in.relay) {
		if in.override != "" {
			override = in.override
		} else if err := s.gateRefusal(in.mailKind() == "ask"); err != nil {
			return jsfmt.Value{}, err
		}
	}

	// The observers of a stored mail that this daemon does not carry (requirement checks, decision steps).
	if !in.fromStam && in.permissionID == "" {
		if err := s.mailObserverRefusal(ctx, from, local.has[humanBox]); err != nil {
			return jsfmt.Value{}, err
		}
	}

	id := s.newMailID()
	if in.forwarded && in.mailID != "" {
		id = in.mailID
	}
	// A forwarded mail that is here already keeps its files: this arrival only adds recipients. Arrivals of one id run one
	// at a time from this check to the store, so a second one finds the first's mail and merges rather than finding its
	// folder and failing (S-4100 review).
	var err error
	again := false
	if in.forwarded {
		defer s.forwardedIDs.lock(id)()
		if _, again, err = s.db.GetMail(ctx, id); err != nil {
			return jsfmt.Value{}, err
		}
	}
	// The mail's files go in a folder this call makes (S-4100 review): os.Mkdir claims attachments/<id> or fails if it is
	// there, so a new id is drawn rather than writing into, or later removing, another mail's folder. A forwarded mail
	// keeps its id, so a folder already there refuses it. The folder goes again unless the mail is stored here.
	over := utf16Len(body) > bodyLimit()
	dir := ""
	if !again && (over || hasAttachments(in.attachments)) {
		root := filepath.Join(s.cfg.Home, "attachments")
		if err := os.MkdirAll(root, 0o755); err != nil {
			return jsfmt.Value{}, err
		}
		for tries := 0; dir == ""; tries++ {
			err := os.Mkdir(filepath.Join(root, id), 0o755)
			switch {
			case err == nil:
				dir = filepath.Join(root, id)
			case !errors.Is(err, fs.ErrExist):
				return jsfmt.Value{}, err
			case in.forwarded || tries == 3:
				return jsfmt.Value{}, Errorf(http.StatusConflict, "mail %s's attachments folder is already there", id)
			default:
				id = s.newMailID()
			}
		}
	}
	filesKept := false
	defer func() {
		if dir != "" && !filesKept {
			_ = os.RemoveAll(dir)
		}
	}()
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
	if over && dir != "" {
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
	if dir != "" {
		saved, err := saveAttachments(dir, in.attachments)
		if err != nil {
			return jsfmt.Value{}, err
		}
		files = append(files, saved...)
	}
	sendToHuman := local.has[humanBox]
	kind, itsaID, health := in.mailKind(), "", ""
	var quiet []string
	if in.itsa != nil {
		itsaID, health = in.itsa.id, in.itsa.health
		for _, r := range local.list {
			if !contains(in.itsa.interrupt, r) {
				quiet = append(quiet, r)
			}
		}
	}
	m := db.Stored{
		ForeignSender: in.forwarded && !s.peerSent(ctx, in, sender, isAgent),
		ItsaID:        itsaID, AboutItsa: in.aboutItsa, Kind: kind, Health: health, Quiet: quiet, LinkText: subject + "\n" + body,
		ID: id, ThreadID: threadID, From: from, FromName: fromName, Subject: subject, Body: stored, ReplyTo: replyTo, PermissionID: in.permissionID,
		AutoThreaded: autoThreaded, Notice: (in.hasSystem && in.system != "") || in.fromStam, FromStam: in.fromStam, Override: override, To: local.list, Files: files,
		InTx: in.inTx, FromHuman: from == humanBox, DeferThread: from == humanBox && isDeferralOnly(stored, len(files)),
		ToHuman: sendToHuman, DecisionMail: sendToHuman && from != humanBox && kind != "ask" && !in.fromStam && in.permissionID == "" && !reStamSubj.MatchString(subject) && hasDecisionBlock(stored),
	}
	// The peers before the store here (S-4100 review): a send that fails before any destination took it is a clean failure,
	// with nothing stored and the folder this call made removed. The files are written first, so a write that fails can't
	// follow a peer's delivery. Once a peer has taken the mail, a later failure doesn't undo that: the send succeeds and
	// says where the mail wasn't delivered (not_delivered), so a client_id retry gets that answer instead of a second mail.
	var copyTo, failedTo []string
	var undelivered []jsfmt.Value
	var peerMail jsfmt.Value
	// queuedTo is the peers' recipients whose mail waits in the outbox (S-235). Mail an agent or the human sends for
	// itself, not stam's own mail, a permission relay or a peer's forwarded mail, may start a stopped peer (S-245).
	var queuedTo []string
	direct := (from == humanBox || isAgent) && !in.fromStam && in.permissionID == "" && !in.forwarded
	if len(remote.peers) > 0 {
		atts, err := attachmentsB64(in.attachments)
		if err != nil {
			return jsfmt.Value{}, err
		}
		for _, p := range remote.peers {
			sentTo := remote.to[p.Name]
			payload := s.forwardPayload(in, from, fromName, subject, body, replyTo, threadID, id, autoThreaded, sentTo, inferredIDs, atts)
			// A broadcast (`all`, or what a limited `all` expanded to) skips a peer that doesn't answer; mail to named agents
			// waits in the outbox, which counts as taken: the sender's copy records them (copy_to). bcast is the broadcast part.
			var named, bcast []string
			for _, x := range sentTo {
				if x != "all" && !remote.fromAll[p.Name+"\x00"+x] {
					named = append(named, x)
				} else {
					bcast = append(bcast, x)
				}
			}
			// Only the named part waits in the outbox; the sender's copy records what was queued, not the broadcast part.
			queue := func() error {
				q := s.forwardPayload(in, from, fromName, subject, body, replyTo, threadID, id, autoThreaded, named, inferredIDs, atts)
				if err := s.db.QueueOutbox(ctx, id, p.Name, jsfmt.Compact(q)); err != nil {
					return err
				}
				queuedTo = append(queuedTo, named...)
				copyTo = append(copyTo, named...)
				return s.startForQueued(ctx, p, from, fromName, direct, sentTo, named)
			}
			// Mail already waiting for this peer goes behind it, so the peer gets its mail in order. A broadcast part is
			// never queued: it goes now, under the same id (the peer merges the recipients), or is skipped if the peer
			// doesn't answer.
			if len(named) > 0 {
				waiting, err := s.db.OutboxHasPeer(ctx, p.Name)
				if err != nil {
					return jsfmt.Value{}, err
				}
				if waiting {
					if err := queue(); err != nil {
						return jsfmt.Value{}, err
					}
					s.drainOutbox()
					if len(bcast) > 0 {
						bp := s.forwardPayload(in, from, fromName, subject, body, replyTo, threadID, id, autoThreaded, bcast, inferredIDs, atts)
						r, err := s.peers.Call(ctx, p, http.MethodPost, "/api/mail", bp, peers.DefaultTimeout, false, nil)
						switch {
						case err != nil:
						case r.Status == http.StatusOK:
							copyTo = append(copyTo, bcast...)
						default:
							failedTo = append(failedTo, bcast...)
							miss := jsfmt.Value{Kind: jsfmt.Object}
							miss.Set("peer", jsfmt.StringValue(p.Name))
							miss.Set("to", jsfmt.ArrayValue(stringValues(bcast)))
							miss.Set("error", jsfmt.StringValue(s.peers.RedactText(p, replyError(r))))
							undelivered = append(undelivered, miss)
						}
					}
					continue
				}
			}
			r, err := s.peers.Call(ctx, p, http.MethodPost, "/api/mail", payload, peers.DefaultTimeout, false, nil)
			var failure error
			switch {
			case err != nil && ctx.Err() != nil && len(copyTo) == 0:
				return jsfmt.Value{}, ctx.Err()
			case err != nil && len(named) == 0:
				// A broadcast skips a peer that doesn't answer, as TS's does.
				continue
			case err != nil:
				if err := queue(); err != nil {
					return jsfmt.Value{}, err
				}
				continue
			case r.Status != http.StatusOK:
				// The peer's 4xx is its refusal (it checked the sender or the recipient): a 400 for the sender (S-590).
				msg := r.Data.Text("error")
				if msg == "" {
					msg = strconv.Itoa(r.Status)
				}
				if r.Status == http.StatusConflict && in.hasOnlyTo {
					// The peer forwards to one the post wasn't checked against: the same refusal as here.
					failure = Errorf(http.StatusConflict, "%s: %s", p.Name, msg)
				} else if r.Status >= 400 && r.Status < 500 {
					failure = refused("%s: %s", p.Name, msg)
				} else {
					failure = fmt.Errorf("%s: %s", p.Name, msg)
				}
			default:
				copyTo = append(copyTo, sentTo...)
				// A forwarded relay with no copy here answers with the peer's stored mail.
				if peerMail.Kind != jsfmt.Object {
					peerMail = r.Data
				}
				continue
			}
			if len(copyTo) == 0 {
				return jsfmt.Value{}, failure
			}
			failedTo = append(failedTo, sentTo...)
			miss := jsfmt.Value{Kind: jsfmt.Object}
			miss.Set("peer", jsfmt.StringValue(p.Name))
			miss.Set("to", jsfmt.ArrayValue(stringValues(sentTo)))
			miss.Set("error", jsfmt.StringValue(s.peers.RedactText(p, errorText(failure))))
			undelivered = append(undelivered, miss)
		}
	}

	m.CopyTo = copyTo
	var mail jsfmt.Value
	kept, merged := false, false
	// arrived is the local recipients this send reached: every one, or for a forwarded mail that was here already, the
	// ones this arrival added.
	arrived := local.list
	switch {
	case len(local.list) > 0 || (in.itsa != nil && len(remote.peers) == 0):
		if in.forwarded {
			if s.forwardStoreHook != nil {
				s.forwardStoreHook(id)
			}
			mail, arrived, merged, err = s.db.StoreForwarded(ctx, m)
			if errors.Is(err, db.ErrMailIDTaken) {
				return jsfmt.Value{}, Errorf(http.StatusConflict, "mail %s here is another sender's", id)
			}
		} else {
			mail, err = s.db.StoreMail(ctx, m)
		}
		if err != nil && len(copyTo) > 0 {
			// The peers have it: the send answers what was delivered, and that the recipients here didn't get it.
			slog.Warn("mail stored on the peers, not here", "id", id, "err", s.peers.RedactAny(err.Error()))
			undelivered = append(undelivered, s.missedHere(local.list, err))
			failedTo = append(failedTo, local.list...)
			mail = jsfmt.Value{Kind: jsfmt.Object}
			mail.Set("id", jsfmt.StringValue(id))
			mail.Set("thread_id", jsfmt.StringValue(threadID))
			arrived, err = nil, nil
			break
		}
		if err != nil {
			return jsfmt.Value{}, err
		}
		kept, filesKept = true, true
	case len(copyTo) > 0 && !in.forwarded:
		// The sender's copy (S-241): a mail that went only to peers is also stored here, with no local recipients, so the
		// sender's threads, reply_to and read_thread see it. It records the agents it went to (copy_to, S-2663). A
		// forwarded mail's copy is the sending peer's.
		c := m
		c.To, c.Quiet, c.ToHuman, c.DecisionMail = nil, nil, false, false
		if mail, err = s.db.StoreMail(ctx, c); err != nil {
			// The peers have it, so the send succeeded; only the sender's copy here is missing, which not_delivered names.
			slog.Warn("mail delivered to the peers, the sender's copy not kept", "id", id, "err", s.peers.RedactAny(err.Error()))
			undelivered = append(undelivered, s.missedHere([]string{from}, err))
			mail = jsfmt.Value{}
			break
		}
		kept, filesKept = true, true
	}
	if mail.Kind != jsfmt.Object {
		mail = peerMail
	}
	// A broadcast no peer answered, with no one here to get it, is still a send: its id and thread.
	if mail.Kind != jsfmt.Object {
		mail = jsfmt.Value{Kind: jsfmt.Object}
		mail.Set("id", jsfmt.StringValue(id))
		mail.Set("thread_id", jsfmt.StringValue(threadID))
	}
	if kept && !merged {
		// Queued for search by meaning, off the send (src/vectors.ts indexMail).
		s.index.IndexMail(id)
	}
	// notify's idle push: each agent that got it is prompted once it's idle.
	if s.life != nil {
		for _, r := range arrived {
			if r != humanBox {
				s.life.SchedulePush(r)
			}
		}
	}

	// The requirement checks of a stored mail run off the send (src/mail.ts maybeCheckRequirements).
	if len(arrived) > 0 {
		s.afterMail(ctx, id, from, subject, m.Body, threadID, contains(arrived, humanBox), in.fromStam)
	}

	// The system view's mail flight: the send is stored and the sender may see it. A peer re-storing a forwarded mail is a
	// delivery, not a send.
	ev := jsfmt.Value{Kind: jsfmt.Object}
	ev.Set("id", jsfmt.StringValue(id))
	ev.Set("from", jsfmt.StringValue(from))
	var flown []string
	for _, x := range append(append([]string(nil), local.list...), remote.ids()...) {
		if !contains(failedTo, x) {
			flown = append(flown, x)
		}
	}
	// Mail that waits in the outbox flies to its queued recipients (src/mail.ts: queuedTo ?? every recipient).
	if queuedTo != nil {
		flown = queuedTo
	}
	ev.Set("to", jsfmt.ArrayValue(stringValues(flown)))
	ev.Set("thread", jsfmt.StringValue(threadID))
	if itsaID != "" {
		ev.Set("itsa", jsfmt.StringValue(itsaID))
	} else {
		ev.Set("itsa", jsfmt.NullValue())
	}
	ev.Set("ask", jsfmt.Value{Kind: jsfmt.Bool, Bool: sendToHuman && (kind == "ask" || hasDecisionBlock(body))})
	ev.Set("subject", jsfmt.StringValue(subject))
	ev.Set("at", jsfmt.StringValue(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
	if !in.forwarded {
		_ = s.hub.Emit("mail.sent", ev)
	}

	// Mail that waits in the outbox answers with what was queued, not the copy (src/mail.ts).
	if queuedTo != nil {
		mail = jsfmt.Value{Kind: jsfmt.Object}
		mail.Set("id", jsfmt.StringValue(id))
		mail.Set("thread_id", jsfmt.StringValue(threadID))
		mail.Set("to", jsfmt.ArrayValue(stringValues(queuedTo)))
		mail.Set("queued", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
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
	if len(undelivered) > 0 {
		mail.Set("not_delivered", jsfmt.ArrayValue(undelivered))
	}
	if len(skipped) > 0 {
		mail.Set("skipped", jsfmt.ArrayValue(stringValues(skipped)))
	}
	if missesHuman {
		mail.Set("misses_human", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	}
	return mail, nil
}

// errorText is an error's message as its sender reads it: an *Error's message without its status.
func errorText(err error) string {
	var he *Error
	if errors.As(err, &he) {
		return he.Message
	}
	return err.Error()
}

func (s *Server) newMailID() string {
	if s.mailIDHook != nil {
		return s.mailIDHook()
	}
	return db.NewMailID()
}

// missedHere is the not_delivered entry for this machine: the mail reached the peers, but couldn't be stored here for to.
func (s *Server) missedHere(to []string, err error) jsfmt.Value {
	miss := jsfmt.Value{Kind: jsfmt.Object}
	miss.Set("peer", jsfmt.StringValue(s.cfg.Machine))
	miss.Set("to", jsfmt.ArrayValue(stringValues(to)))
	miss.Set("error", jsfmt.StringValue(s.peers.RedactAny(err.Error())))
	return miss
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
