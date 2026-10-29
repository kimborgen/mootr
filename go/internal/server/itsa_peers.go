package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
)

// The peer hooks of src/daemon.ts: what a peer's daemon calls on the ITSA home (join-parent, join, leave, may-participate,
// owner-stopped, unown-agent, switch-owner, incident-marked). Only a peer reaches them (x-stam-local, checked in ServeHTTP
// before any route), and each checks its body as TS does before it acts:
//
//   - join-parent joins a peer's new agent to its parent's open ITSA (joinParentLocal); join, leave and may-participate act
//     for a peer's spawn as the agent that asked for it (the peer's x-stam-agent), checked as mayAssign checks a spawn here;
//   - owner-stopped and unown-agent report an agent a peer holds, and switch-owner a cost_switch a peer ran: some peer must
//     hold the agent in the state claimed (guardPeerReport, moveSwitchedItsas). Which peer is calling is not known, as in TS:
//     every peer sends the same peer token, so the agent is bound to no host until S-4127 (senderPeer);
//   - incident-marked is a read of this daemon's ITSAs.
func (s *Server) peerHookRoutes() {
	for _, p := range []string{
		"POST /api/itsas/join-parent", "POST /api/itsas/join", "POST /api/itsas/leave", "POST /api/itsas/may-participate",
		"POST /api/itsas/owner-stopped", "POST /api/itsas/unown-agent", "POST /api/itsas/switch-owner", "GET /api/itsas/incident-marked",
	} {
		s.handle(p, s.peerHook(p))
	}
}

// peerNeeds is what TS says a body lacks, by route.
var peerNeeds = map[string]struct {
	keys []string
	msg  string
}{
	"POST /api/itsas/join-parent":     {[]string{"agent", "parent"}, "join-parent needs agent and parent"},
	"POST /api/itsas/join":            {[]string{"itsa", "agent"}, "join needs itsa and agent"},
	"POST /api/itsas/leave":           {[]string{"itsa", "agent"}, "leave needs itsa and agent"},
	"POST /api/itsas/may-participate": {[]string{"itsa"}, "may-participate needs itsa"},
	"POST /api/itsas/switch-owner":    {[]string{"from", "to"}, "switch-owner needs from and to"},
}

func (s *Server) peerHook(route string) func(*http.Request, auth.Resolved) (any, error) {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		if !c.Local {
			return nil, Errorf(http.StatusForbidden, "only a peer can call this")
		}
		ctx := context.WithoutCancel(r.Context())
		if route == "GET /api/itsas/incident-marked" {
			out := jsfmt.Value{Kind: jsfmt.Object}
			out.Set("marked", jsfmt.Value{Kind: jsfmt.Bool, Bool: s.incidentMarkedHere(ctx, r.URL.Query().Get("itsa"))})
			return out, nil
		}
		body, err := jsonBody(r)
		if err != nil {
			return nil, err
		}
		if need, ok := peerNeeds[route]; ok {
			for _, k := range need.keys {
				if truthyString(body, k) == "" {
					return nil, Errorf(http.StatusBadRequest, "%s", need.msg)
				}
			}
		}
		by := truthyString(body, "by")
		switch route {
		case "POST /api/itsas/join-parent":
			key, err := s.joinParentItsa(ctx, truthyString(body, "agent"), truthyString(body, "parent"), by)
			if err != nil {
				return nil, asItsaErr(err)
			}
			out := jsfmt.Value{Kind: jsfmt.Object}
			out.Set("key", strOrNull(key, key != ""))
			return out, nil
		case "POST /api/itsas/join", "POST /api/itsas/leave", "POST /api/itsas/may-participate":
			ref, via := truthyString(body, "itsa"), s.peerVia(ctx, c)
			err := func() error {
				if route == "POST /api/itsas/may-participate" {
					if _, err := s.mustItsa(ctx, ref); err != nil {
						return err
					}
				}
				if err := s.mayAssign(ctx, ref, via); err != nil {
					return err
				}
				switch route {
				case "POST /api/itsas/join":
					_, err := s.addParticipant(ctx, ref, truthyString(body, "agent"), by)
					return err
				case "POST /api/itsas/leave":
					_, err := s.removeParticipant(ctx, ref, truthyString(body, "agent"), by)
					return err
				}
				return nil
			}()
			if err != nil {
				return nil, asItsaErr(err)
			}
			return okTrue(), nil
		case "POST /api/itsas/switch-owner":
			moved, err := s.moveSwitchedItsas(ctx, c, truthyString(body, "from"), truthyString(body, "to"))
			if err != nil {
				return nil, err
			}
			out := jsfmt.Value{Kind: jsfmt.Object}
			out.Set("moved", jsfmt.ArrayValue(stringValues(moved)))
			return out, nil
		case "POST /api/itsas/owner-stopped":
			id, name := strOrUndefined(body, "id"), strOrUndefined(body, "name")
			return nil, s.guardPeerReport(ctx, c, id, []string{"active", "paused", "shut_down", "archived"}, "that agent can report its stop", func() error {
				return s.stopped(ctx, id, name, strOrUndefined(body, "what"))
			})
		}
		// unown-agent
		how, lifecycles := "archived", []string{"archived"}
		if v, ok := body.Get("how"); ok && v.Kind == jsfmt.String && v.Str == "forgotten" {
			how, lifecycles = "forgotten", []string{"shut_down", "archived"}
		}
		id := strOrUndefined(body, "id")
		a := db.Agent{ID: id, Name: strOrUndefined(body, "name")}
		if v, ok := body.Get("parent"); ok && v.Kind == jsfmt.String {
			a.ParentID = &v.Str
		}
		if v, ok := body.Get("type"); ok && v.Kind == jsfmt.String {
			a.Type = &v.Str
		}
		return nil, s.guardPeerReport(ctx, c, id, lifecycles, "that archived agent can unown its ITSAs", func() error {
			return s.unownAgent(ctx, a, how)
		})
	}
}

func okTrue() jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("ok", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	return out
}

// peerVia is src/daemon.ts viaOf for a peer's call: the agent the peer forwarded (x-stam-agent), with whether it is this
// daemon's chief of staff or assistant. None when the peer forwarded no agent: its daemon's own call.
func (s *Server) peerVia(ctx context.Context, c auth.Resolved) *itsaVia {
	v := s.viaOf(ctx, c)
	if v == nil {
		return nil
	}
	return &itsaVia{agent: v.Agent, boss: v.Boss}
}

// senderPeer is the peer that made this call, when it can be told. It can't yet: every peer sends this daemon's one peer
// token, so a peer hook accepts an agent any peer holds, as TS does. S-4127 gives each peer its own token; then a hook
// takes an agent only from the peer that holds it (holderMismatch).
func (s *Server) senderPeer(c auth.Resolved) (string, bool) { return "", false }

// holderMismatch is whether the caller is known and is not the peer that holds the agent.
func (s *Server) holderMismatch(c auth.Resolved, holder string) bool {
	sender, known := s.senderPeer(c)
	return known && sender != holder
}

// peerHolds is src/itsa-owners.ts peerHolds: whether a peer holds the agent with this exact id, in one of lifecycles.
// "no" is final; "unknown" means a peer that may hold it didn't answer. An agent of this machine is no peer's, nor is
// a row here for one whose id another machine minted too.
func (s *Server) peerHolds(ctx context.Context, c auth.Resolved, id string, lifecycles []string) (string, error) {
	mine, err := s.db.GetAgent(ctx, id)
	switch {
	case err == nil && (mine.Machine == "" || mine.Machine == s.cfg.Machine):
		return "no", nil
	case err != nil && !errors.Is(err, db.ErrNotFound):
		return "", err
	}
	if s.peers == nil {
		return "no", nil
	}
	hit, located, err := s.peers.Locate(ctx, s.db, id)
	switch {
	case err != nil:
		// Two agents answer to it: not one a peer holds.
		return "no", nil
	case located == peers.Unreachable:
		return "unknown", nil
	case located != peers.Found || hit == nil || hit.Peer == nil || hit.Agent.ID != id || s.holderMismatch(c, hit.Peer.Name):
		return "no", nil
	}
	if contains(lifecycles, hit.Agent.Lifecycle) {
		return "yes", nil
	}
	return "no", nil
}

// guardPeerReport is src/itsa-owners.ts guardPeerReport: a peer's report about an agent it holds runs act only when a peer
// holds that agent in one of lifecycles. 403 (final) when none does; 503 (try again) when a peer that may hold it didn't
// answer, or act failed for any reason but a refusal, which stays 403.
func (s *Server) guardPeerReport(ctx context.Context, c auth.Resolved, id string, lifecycles []string, what string, act func() error) error {
	v, err := s.peerHolds(ctx, c, id, lifecycles)
	switch {
	case err != nil || v == "unknown":
		return Errorf(http.StatusServiceUnavailable, "no peer answered about %s; try again", id)
	case v == "no":
		return Errorf(http.StatusForbidden, "only a peer holding %s", what)
	}
	return holderErr(act())
}

// holderErr is TS's HolderRefusal for a failed act: a refusal (403) stays one, anything else is 503 so the peer retries.
func holderErr(err error) error {
	if err == nil {
		return nil
	}
	var e *Error
	if errors.As(err, &e) && e.Status == http.StatusForbidden {
		return Errorf(http.StatusForbidden, "%s", e.Message)
	}
	return Errorf(http.StatusServiceUnavailable, "%s", err.Error())
}

// moveSwitchedItsas is src/itsa-owners.ts moveSwitchedItsas (S-3636), on the home: a peer ran a cost_switch, so from's open
// ITSAs go to to. The proof is the holder's own word: one peer must hold from with forwarded_to naming to, and hold to too,
// so a crafted call can't take an agent's ITSAs. Each moves by compare-and-set on the owner, so a repeat moves what is left
// and nothing twice. 403 (final) when no peer shows the switch; 503 (try again) when a peer that may hold them didn't answer.
func (s *Server) moveSwitchedItsas(ctx context.Context, c auth.Resolved, from, to string) ([]string, error) {
	refuse := Errorf(http.StatusForbidden, "only a peer holding a switched agent can move its ITSAs")
	if from == to {
		return nil, refuse
	}
	// Neither end may be this machine's agent: setItsa resolves an id to the local row first, so a successor id the home
	// has too would hand the ITSAs to the home's own agent.
	for _, id := range []string{from, to} {
		switch mine, err := s.db.GetAgent(ctx, id); {
		case err == nil && (mine.Machine == "" || mine.Machine == s.cfg.Machine):
			return nil, refuse
		case err != nil && !errors.Is(err, db.ErrNotFound):
			return nil, Errorf(http.StatusServiceUnavailable, "no peer answered about %s; try again", id)
		}
	}
	if s.peers == nil {
		return nil, refuse
	}
	type located struct {
		hit *peers.Hit
		at  peers.Located
		err error
	}
	look := func(ref string) located {
		hit, at, err := s.peers.Locate(ctx, s.db, ref)
		return located{hit, at, err}
	}
	a, b := look(from), look(to)
	if a.err == nil && b.err == nil && (a.at == peers.Unreachable || b.at == peers.Unreachable) {
		return nil, Errorf(http.StatusServiceUnavailable, "no peer answered about %s; try again", from)
	}
	if a.err != nil || b.err != nil || a.at != peers.Found || b.at != peers.Found || a.hit.Peer == nil || b.hit.Peer == nil ||
		a.hit.Agent.ID != from || b.hit.Agent.ID != to || a.hit.Peer.Name != b.hit.Peer.Name ||
		a.hit.Agent.Raw.Text("forwarded_to") != to || s.holderMismatch(c, a.hit.Peer.Name) {
		return nil, refuse
	}
	// Final: ITSAs never land on an archived successor. A shut-down one can be resumed, so it takes them.
	if b.hit.Agent.Lifecycle == "archived" {
		return nil, Errorf(http.StatusForbidden, "%s is archived, so it can't take ITSAs", b.hit.Agent.Name)
	}
	moved := []string{}
	owned, err := s.db.ListItsas(ctx, db.ItsaFilter{Owner: from})
	if err != nil {
		return nil, holderErr(err)
	}
	for _, x := range owned {
		if s.isClosedStatus(x.Text("status")) {
			continue
		}
		f := jsfmt.Value{Kind: jsfmt.Object}
		f.Set("owner", jsfmt.StringValue(to))
		f.Set("ifOwner", jsfmt.StringValue(from))
		if _, err := s.setItsa(ctx, x.Text("id"), f, from); err != nil {
			if strings.Contains(err.Error(), "owner changed") {
				continue
			}
			return nil, holderErr(err)
		}
		if _, err := s.addParticipant(ctx, x.Text("id"), to, from); err != nil {
			slog.Error("ITSA owners: couldn't add "+to+" to "+x.Text("key"), "err", err)
		}
		if err := s.db.AddItsaEvent(ctx, x.Text("id"), from, "handoff", jsfmt.StringValue("Owner @"+a.hit.Agent.Name+" was switched; ownership passed to @"+b.hit.Agent.Name+".")); err != nil {
			slog.Error("ITSA owners: handoff event on "+x.Text("key"), "err", err)
		}
		moved = append(moved, x.Text("key"))
	}
	// The open ITSAs from only took part in: to joins them, as the local switch does.
	joined, err := s.db.ListItsas(ctx, db.ItsaFilter{Participant: from})
	if err != nil {
		return nil, holderErr(err)
	}
	for _, x := range joined {
		if s.isClosedStatus(x.Text("status")) || x.Text("owner") == from {
			continue
		}
		if _, err := s.addParticipant(ctx, x.Text("id"), to, from); err != nil {
			slog.Error("ITSA owners: couldn't add "+to+" to "+x.Text("key"), "err", err)
		}
	}
	return moved, nil
}

// incidentMarkedHere is itsa-owners.ts incidentMarkedHere: whether the ITSA, or an ancestor of it, carries the incident
// mark. An ITSA this daemon cannot read, a missing parent and a chain that loops are no mark.
func (s *Server) incidentMarkedHere(ctx context.Context, ref string) bool {
	if ref == "" {
		return false
	}
	x, ok, err := s.db.FindItsa(ctx, ref)
	if err != nil || !ok {
		return false
	}
	seen := map[string]bool{x.Text("id"): true}
	marked := incidentOf(x)
	for cur := x; truthyString(cur, "parent_id") != ""; {
		p, ok, err := s.db.FindItsa(ctx, cur.Text("parent_id"))
		if err != nil || !ok || seen[p.Text("id")] {
			return false
		}
		seen[p.Text("id")] = true
		marked = marked || incidentOf(p)
		cur = p
	}
	return marked
}

func incidentOf(x jsfmt.Value) bool {
	v, ok := x.Get("incident")
	return ok && v.Kind == jsfmt.Number && v.Num == "1"
}

// truthyString is a body member that is a non-empty string, else "" (String(body?.k ?? ”) for what a peer sends).
func truthyString(v jsfmt.Value, key string) string {
	m, ok := v.Get(key)
	if !ok || m.Kind == jsfmt.Null {
		return ""
	}
	if m.Kind == jsfmt.String {
		return m.Str
	}
	return jsfmtString(m)
}

// strOrUndefined is String(body?.key): a missing member is "undefined".
func strOrUndefined(v jsfmt.Value, key string) string {
	m, ok := v.Get(key)
	if !ok {
		return "undefined"
	}
	if m.Kind == jsfmt.Null {
		return "null"
	}
	return jsfmtString(m)
}

func jsfmtString(m jsfmt.Value) string {
	if m.Kind == jsfmt.String {
		return m.Str
	}
	return jsfmt.Compact(m)
}
