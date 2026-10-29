package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	neturl "net/url"
	"regexp"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/peers"
)

// The relay of a request about an agent on another machine to the daemon that owns it (src/daemon.ts, "A request about an
// agent on another machine goes to the daemon that owns it", S-232 and after). It runs after the caller is known and
// before the route table, as in TS: what the body claims is resolved and the mailbox and wait routes' mayActAs is checked
// in ServeHTTP first (S-238, S-242), so a request is never forwarded under an identity the caller may not take.
//
// The peer trusts x-stam-local, x-stam-human and the agent headers only because the peer token sent them (peers.Client);
// an agent's own token proves none of them (auth.Resolve refuses the headers from it).
//
// A human-on-machine refusal carries the peer's serve origin (peerServeOrigin): HTTPS on its tailnet name, or in a test
// daemon with STAM_TEST_HUMAN_KEY set, the peer's own URL.

// agentPathRe is the paths the relay looks at: /api/agents/ID, /api/agents/ID/SUB and /api/agents/ID/view/SUB.
var agentPathRe = regexp.MustCompile(`^/api/agents/([\w-]+)(/[\w-]+|/view/[\w-]+)?$`)

// viewSendRe is the view routes that send as the human, which a relay never carries: only trustedHuman on the daemon the
// browser reaches proves the human.
var viewSendRe = regexp.MustCompile(`^/view/(prompt|interrupt|permission)$`)

// strictLogEvery is how often a would-refuse line is logged per request pattern.
const strictLogEvery = time.Minute

// relay answers a request that belongs to a peer. It returns true when it wrote the response (a relayed answer or an
// error), and false when the request is this daemon's to route; the body it read is put back for the route.
func (s *Server) relay(w http.ResponseWriter, r *http.Request, c auth.Resolved) bool {
	path := r.URL.EscapedPath()
	am := agentPathRe.FindStringSubmatch(path)
	spawnPath := r.Method == http.MethodPost && path == "/api/agents"
	if am == nil && !spawnPath {
		return false
	}
	switch err := s.relayRequest(w, r, c, path, am); {
	case errors.Is(err, errNotRelayed):
		return false
	case err != nil:
		writeError(w, err)
	}
	return true
}

// errNotRelayed is what relayRequest returns when the request is the route's.
var errNotRelayed = errors.New("not relayed")

// relayRequest is the checks and the relay. A nil error means the response is written; errNotRelayed means it is not.
func (s *Server) relayRequest(w http.ResponseWriter, r *http.Request, c auth.Resolved, path string, am []string) error {
	ctx := r.Context()
	var wr write
	var raw []byte
	if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch || r.Method == http.MethodDelete {
		var err error
		if raw, err = readBody(r); err != nil {
			return err
		}
		if wr, err = s.parseWrite(r, c, raw); err != nil {
			return err
		}
		// A route that takes over reads the body as resolveBody left it.
		r.Body = io.NopCloser(bytes.NewReader(raw))
	}
	body := wr.body
	field := func(k string) jsjson.Value {
		if body == nil {
			return nil
		}
		v, _ := body.Get(k)
		return v
	}
	human := s.isHuman(r, c)
	var here *db.Agent
	if am != nil {
		a, err := s.db.GetAgent(ctx, am[1])
		switch {
		case err == nil:
			here = &a
		case !errors.Is(err, db.ErrNotFound):
			return err
		}
	}
	// An id two machines' agents both have can't say which is meant (S-577): refuse it, naming both, rather than act on
	// the local one. An agent naming itself is not ambiguous, and a name is unique, so only another exact id is checked.
	if here != nil && here.ID == am[1] && c.Caller.Agent != here.ID {
		if err := peers.RefuseAmbiguousID(ctx, s.db, here.ID, here.Name, here.Machine); err != nil {
			return ambiguous(err)
		}
	}
	machine := ""
	spawnElsewhere := false
	if r.Method == http.MethodPost && path == "/api/agents" {
		if m := field("machine"); jsjson.Truthy(m) {
			machine = claude.JSString(m)
			spawnElsewhere = machine != s.cfg.Machine
		}
	}
	sub := ""
	if am != nil {
		sub = am[2]
	}
	// A notice is queued by a peer's daemon for its own agent, never relayed for a caller.
	if !c.Local && !human && sub == "/notice" {
		return Errorf(http.StatusForbidden, "only a peer can queue a notice")
	}
	// The human's own preferences about an agent (its default view) stay on the daemon the web talks to, which lists them
	// for peers' agents too.
	mine := sub == "/default-view"
	if c.Local || !((am != nil && am[1] != humanName && !mine && here == nil) || spawnElsewhere) {
		return errNotRelayed
	}

	var peer config.Peer
	if spawnElsewhere {
		p, ok := s.peers.ByName(machine)
		if !ok {
			return Errorf(http.StatusNotFound, "no peer machine %s", machine)
		}
		peer = p
	} else {
		hit, found, err := s.peers.Locate(ctx, s.db, am[1])
		if err != nil {
			return ambiguous(err)
		}
		if found != peers.Found || hit.Peer == nil {
			return Errorf(http.StatusNotFound, "no agent %s", am[1])
		}
		peer = *hit.Peer
	}
	if viewSendRe.MatchString(sub) {
		return Errorf(http.StatusConflict, "%s runs on %s; send to its view from stam on %s", am[1], peer.Name, peer.Name)
	}
	via := s.viaOf(ctx, c)
	// The agent view's event stream stays open, so it's piped rather than read whole.
	if r.Method == http.MethodGet && sub == "/view" {
		return s.peers.Stream(r, peer, path+search(r), w, via)
	}
	isWrite := r.Method != http.MethodGet
	// A peer takes a no-`by` write from a peer as the peer's own, so this daemon refuses the shared token's here (S-543).
	if isWrite && !jsjson.Truthy(field("by")) && s.strictRefuses("a write relayed to a peer with no by", !human && !(c.Local && c.Kind == auth.Shared) && c.Kind != auth.Agent) {
		return Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), controls another machine's agent")
	}
	what := r.Method + " " + path
	if am != nil {
		what = r.Method + " " + am[0]
	}
	by := field("by")
	acts := !jsjson.Truthy(by) || by == humanName
	carry, err := s.relayHuman(peer, human, isWrite, what, acts)
	if err != nil {
		return err
	}

	var reply peers.Reply
	warning := ""
	if spawnElsewhere {
		// A spawn on a stopped peer starts it first (S-234), and a peer on another release is deployed to this one (S-236); a
		// failed deploy doesn't stop the spawn: it warns. The new agent is remembered here (S-235).
		if err := s.peers.EnsureUp(peer); err != nil {
			return Errorf(http.StatusServiceUnavailable, "%s", err.Error())
		}
		warning = s.peers.EnsureCurrent(peer)
		// A caller that gives up does not cancel a spawn under way: the call has its own deadline, and the new agent is
		// remembered whatever became of the caller.
		spawnCtx := context.WithoutCancel(ctx)
		reply, err = s.peers.Call(spawnCtx, peer, http.MethodPost, "/api/agents", forwardBody(body, raw), peers.RelayTimeout, carry, via)
		if err == nil && reply.Status < 300 {
			s.peers.RememberSpawned(spawnCtx, s.db, peer, reply.Data)
		}
	} else {
		reply, err = s.peers.Call(ctx, peer, r.Method, path+search(r), forwardBody(body, raw), peers.RelayTimeout, carry, via)
	}
	if err != nil {
		return err
	}
	// A peer's agent forgotten through this daemon takes this daemon's preferences with it.
	if sub == "/forget" && reply.Status < 300 {
		if err := s.db.ClearAgentView(ctx, am[1]); err != nil {
			return err
		}
	}
	data := ownRefusal(reply.Status, reply.Data)
	if warning != "" && reply.Status < 300 {
		data = reply.Data
		if data.Kind == jsfmt.Object {
			data.Set("warning", jsfmt.StringValue(warning))
		}
	}
	writeJSON(w, reply.Status, data)
	return nil
}

// ambiguous is a lookup's *AmbiguousError as the 409 it answers; any other error is the caller's.
func ambiguous(err error) error {
	var amb *peers.AmbiguousError
	if errors.As(err, &amb) {
		return Errorf(http.StatusConflict, "%s", amb.Msg)
	}
	return err
}

// search is the request's query as `url.search`: "?" and the query, or "".
func search(r *http.Request) string {
	if r.URL.RawQuery == "" {
		return ""
	}
	return "?" + r.URL.RawQuery
}

// forwardBody is the body of a relayed write: the parsed and resolved JSON, as TS forwards its parsed body. A read has none.
func forwardBody(body *jsjson.Object, raw []byte) any {
	switch {
	case body != nil:
		return []byte(jsjson.Stringify(body, ""))
	case len(raw) > 0:
		// Valid JSON that is no object (only the human's or a peer's token may send it): as it came.
		return raw
	}
	return nil
}

// viaOf is src/daemon.ts viaOf: the identity a request forwarded to a peer carries (S-239), the agent whose own token the
// request came with, and whether it is this daemon's chief of staff or assistant. None for the human, the shared token or
// an owner, and for a daemon's own calls, which the peer checks as they are.
func (s *Server) viaOf(ctx context.Context, c auth.Resolved) *peers.Via {
	if c.Kind != auth.Agent || c.Caller.Agent == "" {
		return nil
	}
	id := c.Caller.Agent
	assistant := s.isAssistant(ctx, id)
	return &peers.Via{Agent: id, Boss: s.chiefOfStaffID(ctx) == id || assistant, Assistant: assistant, Scope: c.Caller.Scope}
}

// strictRefuses is src/daemon.ts strictRefuses: a refusal that only auth.humanStrict makes (S-543). Whether or not strict
// is on, it is logged once a minute per `what`; it returns true, to refuse, only with strict in effect.
func (s *Server) strictRefuses(what string, cond bool) bool {
	if !cond {
		return false
	}
	s.logOnce(what, func(prefix string) string { return prefix + ": " + what })
	return s.settings.Get().Auth.HumanStrict
}

// logOnce logs a strict line once a minute per key.
func (s *Server) logOnce(key string, line func(prefix string) string) {
	s.strictMu.Lock()
	defer s.strictMu.Unlock()
	if time.Since(s.strictLogged[key]) < strictLogEvery {
		return
	}
	if s.strictLogged == nil {
		s.strictLogged = map[string]time.Time{}
	}
	s.strictLogged[key] = time.Now()
	prefix := "auth.humanStrict off (this was allowed; turning it on would refuse it)"
	if s.settings.Get().Auth.HumanStrict {
		prefix = "auth.humanStrict refuses"
	}
	slog.Info(line(prefix))
}

// relayHuman is src/daemon.ts relayHuman: whether a relay to a peer carries `human` (S-544). The human is only
// trustedHuman on the daemon the browser reaches, so under auth.humanStrict no relay carries it: a human write is
// answered 409 naming the machine and its serve origin (for the web to send there directly), and a human read goes on as
// an ordinary local call. Off, the relay carries it as before and the daemon logs it. `acts` is false when the call names
// an agent (`by`): it is that agent's, not the human's.
func (s *Server) relayHuman(peer config.Peer, human, write bool, what string, acts bool) (bool, error) {
	if !human {
		return false, nil
	}
	if !s.settings.Get().Auth.HumanStrict {
		if acts {
			key := "relay " + peer.Name + " " + what
			s.logOnce(key, func(prefix string) string {
				return fmt.Sprintf("%s: relaying %s to %s as the human", prefix, what, peer.Name)
			})
		}
		return true, nil
	}
	if write && acts {
		e := HumanOnMachine(fmt.Sprintf("%s on %s is the human's; do it from stam's web UI on %s", what, peer.Name, peer.Name), peer.Name, s.peerServeOrigin(peer.URL))
		// TS leaves an unknown origin out of the body; the schema's null is for the routes that spell it out.
		if e.Extra["origin"].(*string) == nil {
			delete(e.Extra, "origin")
		}
		return false, e
	}
	return false, nil
}

// peerServeOrigin is src/web-origins.ts peerServeOrigin: the origin the human's browser reaches a peer's UI at (`stam
// web serve`), HTTPS on its full tailnet name; none when tailscale doesn't know the peer, since an http://host:port
// address is no proof of the human. Only a test daemon, with the test key set, names the peer's own daemon URL.
func (s *Server) peerServeOrigin(peerURL string) *string {
	own, ok := webOrigin(peerURL)
	if !ok {
		return nil
	}
	u, _ := neturl.Parse(own)
	if names := tailnetNames(u.Hostname(), s.tailnetNodes(context.Background())); len(names) > 0 {
		o := "https://" + names[0]
		return &o
	}
	if s.cfg.TestHumanKey == "" {
		return nil
	}
	return &own
}

// ownRefusal is src/daemon.ts ownRefusal: a peer's 409 naming a machine and origin is the peer's own refusal; only this
// daemon names an origin (S-544), so a peer can't send the page somewhere else. Other bodies pass as they are.
func ownRefusal(status int, data jsfmt.Value) jsfmt.Value {
	if status != http.StatusConflict || data.Kind != jsfmt.Object || data.Text("refusal") != "human-on-machine" {
		return data
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range data.Keys {
		if k != "refusal" && k != "machine" && k != "origin" {
			out.Keys, out.Items = append(out.Keys, k), append(out.Items, data.Items[i])
		}
	}
	return out
}

// The ITSA-home proxy (src/daemon.ts, "Every ITSA lives on its home daemon"). Another machine's daemon proxies there, as
// it does for an agent it doesn't own. `/api/processes` rides along: its counts are ITSAs. A peer's own request is never
// proxied (it would loop).

// itsaHomeTimeout is a proxied request's deadline.
const itsaHomeTimeout = 30 * time.Second

var (
	// itsaProxied is the paths the home answers.
	itsaProxied = regexp.MustCompile(`^/api/(itsas|requirements)|^/api/retros$|^/api/processes(/|$)`)
	// itsaTokenReads is the reads an agent's token never makes: refused before the proxy, which would forward them without a
	// via (the OpenCode server's read would reach the home as a peer's, S-587).
	itsaTokenReads = regexp.MustCompile(`^/api/itsas/(queue|attention|[\w-]+/cost)$`)
	itsaThreadRead = regexp.MustCompile(`^/api/itsas/[\w-]+/threads?$`)
	itsaLinkPost   = regexp.MustCompile(`^/api/itsas/[\w-]+/links$`)
	itsaPostPath   = regexp.MustCompile(`^/api/itsas/[^/]+/post$`)
	// itsaItemPath is an ITSA itself: a move (PATCH) of it carries the routing facts too (S-4178).
	itsaItemPath = regexp.MustCompile(`^/api/itsas/[^/]+$`)
	// idInPath is a request's id, for the log line of a relayed human.
	idInPath = regexp.MustCompile(`/[0-9a-f]{6,}|/S-\d+`)
)

// requirementsOff is requirements.OFF_MESSAGE.
const requirementsOff = "requirements are off (settings.requirements.enabled)"

// itsaGuards are the refusals TS makes before the proxy, on every daemon.
func (s *Server) itsaGuards(r *http.Request, c auth.Resolved) error {
	path := r.URL.Path
	// Requirements are off unless enabled: answered here, before any proxy or table.
	if strings.HasPrefix(path, "/api/requirements") && !s.settings.Get().RequirementsEnabled {
		return Errorf(http.StatusNotFound, "%s", requirementsOff)
	}
	if r.Method == http.MethodGet && itsaTokenReads.MatchString(path) {
		what := "read what waits on the human"
		switch {
		case strings.HasSuffix(path, "/cost"):
			what = "read an ITSA's cost"
		case strings.HasSuffix(path, "/queue"):
			what = "read the merge queue"
		}
		if msg := auth.NotAgentToken(c.Caller, what); msg != "" {
			return Errorf(http.StatusForbidden, "%s", msg)
		}
	}
	return nil
}

// itsaHome proxies a request about an ITSA to the daemon that is its home. It returns true when it wrote the response.
func (s *Server) itsaHome(w http.ResponseWriter, r *http.Request, c auth.Resolved) bool {
	path := r.URL.Path
	home := s.settings.Get().Itsa.Home
	if c.Local || home == s.cfg.Machine || !itsaProxied.MatchString(path) {
		return false
	}
	if err := s.proxyToHome(w, r, c, path, home); err != nil {
		writeError(w, err)
	}
	return true
}

func (s *Server) proxyToHome(w http.ResponseWriter, r *http.Request, c auth.Resolved, path, home string) error {
	ctx := r.Context()
	var wr write
	var raw []byte
	isWrite := r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch || r.Method == http.MethodDelete
	if isWrite {
		var err error
		if raw, err = readBody(r); err != nil {
			return err
		}
		if wr, err = s.parseWrite(r, c, raw); err != nil {
			return err
		}
	}
	field := func(k string) jsjson.Value {
		if wr.body == nil {
			return nil
		}
		v, _ := wr.body.Get(k)
		return v
	}
	peer, ok := s.peers.ByName(home)
	if !ok {
		return Errorf(http.StatusServiceUnavailable, "ITSA home '%s' is not a configured peer", home)
	}
	by := field("by")
	carry, err := s.relayHuman(peer, s.isHuman(r, c), r.Method != http.MethodGet, r.Method+" "+idInPath.ReplaceAllString(path, "/:id"), !jsjson.Truthy(by) || by == humanName)
	if err != nil {
		return err
	}
	// The OpenCode server's request carries the agent it names (S-480): with no via, the home would take it for this
	// daemon's own call. Reading an ITSA's threads needs that agent named.
	named := ""
	if c.Kind == auth.OpenCode {
		// `body.by ?? body.from ?? body.self ?? ?as`: the first that is not null or missing, an empty one included.
		found := false
		for _, v := range []jsjson.Value{field("by"), field("from"), field("self")} {
			if v != nil {
				named, found = claude.JSString(v), true
				break
			}
		}
		if as := r.URL.Query()["as"]; !found && len(as) > 0 {
			named = as[0]
		}
		if named == "" && itsaThreadRead.MatchString(path) {
			return Errorf(http.StatusForbidden, "the OpenCode server must name the agent that reads the threads")
		}
	}
	via := s.viaOf(ctx, c)
	if c.Kind == auth.OpenCode && named != "" {
		via = &peers.Via{Agent: named, Boss: s.chiefOfStaffID(ctx) == named || s.isAssistant(ctx, named)}
	}
	// An agent here whose reach is limited may post through the home only to those it may reach, which the home can't
	// check (reachRefusal).
	onlyTo := false
	if r.Method == http.MethodPost && itsaPostPath.MatchString(path) {
		poster := ""
		if via != nil {
			poster = via.Agent
		} else if by != nil {
			poster = claude.JSString(by)
		}
		var to []string
		switch v := field("to").(type) {
		case string:
			to = []string{v}
		case []any:
			for _, x := range v {
				to = append(to, claude.JSString(x))
			}
		}
		checked, err := s.reachRefusal(ctx, poster, strings.Split(strings.TrimPrefix(path, "/api/itsas/"), "/")[0], to)
		if err != nil {
			return err
		}
		if checked != nil && wr.body == nil {
			return Errorf(http.StatusBadRequest, "a post's body must be a JSON object")
		}
		if checked != nil {
			list := make([]jsjson.Value, len(checked))
			for i, id := range checked {
				list[i] = id
			}
			wr.body.Set("only_to", list)
			onlyTo = true
		}
	}
	// A branch link's owner check needs this daemon's agents: its answer rides along (S-581), which is not ported.
	if via != nil && !via.Boss && r.Method == http.MethodPost && itsaLinkPost.MatchString(path) && field("system") == "branch" {
		return Errorf(http.StatusNotImplemented, "linking a branch through the ITSA home needs this daemon's branch owners, which is not ported to the Go daemon yet")
	}
	// S-4163, S-4178: the routing facts a post or a move relayed to the home carries are this daemon's, from its authenticated
	// agent: any the body brought is dropped, so an agent can't claim to be exempt (relayRouteOf).
	relayedMove := (r.Method == http.MethodPost && itsaPostPath.MatchString(path)) || (r.Method == http.MethodPatch && itsaItemPath.MatchString(path))
	if relayedMove && wr.body != nil {
		wr.body.Delete("relay_route")
		if via != nil {
			facts, ok, err := s.relayRouteOf(ctx, via.Agent)
			if err != nil {
				return err
			}
			if ok {
				routed := jsjson.NewObject("exempt", facts.exempt)
				if facts.parent != "" {
					routed.Set("parent", facts.parent)
				}
				wr.body.Set("relay_route", routed)
			}
		}
	}
	reply, err := s.peers.Call(ctx, peer, r.Method, path+search(r), forwardBody(wr.body, raw), itsaHomeTimeout, carry, via)
	if err != nil {
		return Errorf(http.StatusServiceUnavailable, "%s (the ITSA home) is unreachable: %s", home, err.Error())
	}
	// A 409 on a checked post is the home finding the ITSA's people changed since the check: refused, never sent unchecked.
	if onlyTo && reply.Status == http.StatusConflict {
		writeJSON(w, http.StatusForbidden, ownRefusal(reply.Status, reply.Data))
		return nil
	}
	writeJSON(w, reply.Status, ownRefusal(reply.Status, reply.Data))
	return nil
}
