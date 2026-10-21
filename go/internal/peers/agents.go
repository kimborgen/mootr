package peers

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
)

// Store is the peer_agents directory (go/internal/db): a *db.DB.
type Store interface {
	PeerAgentByID(ctx context.Context, id string) (db.PeerAgentRef, bool, error)
	RememberPeerAgent(ctx context.Context, a db.PeerAgentSeen) error
}

// Agent is what the lookups need of an agent: the fields of its reply that decide which one a name means.
type Agent struct {
	ID, Name, Machine, Lifecycle string
	// Raw is the peer's whole reply.
	Raw jsfmt.Value
}

// Live is an agent that is not archived or shut down.
func (a Agent) Live() bool { return a.Lifecycle != "archived" && a.Lifecycle != "shut_down" }

// Hit is an agent a name means: Peer is nil when it is on this daemon.
type Hit struct {
	Peer  *config.Peer
	Agent Agent
}

// AmbiguousError is a name or id that more than one agent matches (S-288, S-577). A caller answers it 409 with the message.
type AmbiguousError struct{ Msg string }

func (e *AmbiguousError) Error() string { return e.Msg }

// RefuseAmbiguousID is refuseAmbiguousId: an id that an agent here and an agent on another machine both have cannot say
// which one is meant (S-577), so callers refuse it rather than resolve it to the local one, naming both as
// `name (machine)` and telling the caller to use the name. Names are unique, so only exact ids are checked, against the
// remembered peer registry (peer_agents); a row for this very machine is not a twin (a peer that relayed a lookup could
// have stored our own agent).
func RefuseAmbiguousID(ctx context.Context, d Store, id, name, machine string) error {
	twin, ok, err := d.PeerAgentByID(ctx, id)
	if err != nil {
		return err
	}
	if ok && twin.Machine != machine {
		return &AmbiguousError{fmt.Sprintf("%s matches an agent on more than one machine: %s (%s) and %s (%s); address it by name, not by id", id, name, machine, twin.Name, twin.Machine)}
	}
	return nil
}

// Pick is pickAgent: the one agent a name means, out of its exact matches (by id or name; never a partial name). An exact
// id names one agent, live or not; lifecycle only decides between name matches, where a live agent beats one that is not.
// Two that still match is an error that lists them with their ids, rather than a guess (S-288).
func Pick(ref string, hits []Hit) (*Hit, error) {
	var byID []Hit
	for _, h := range hits {
		if h.Agent.ID == ref {
			byID = append(byID, h)
		}
	}
	if len(byID) == 1 {
		return &byID[0], nil
	}
	var live []Hit
	for _, h := range hits {
		if h.Agent.Live() {
			live = append(live, h)
		}
	}
	pool := live
	if len(live) == 0 {
		pool = hits
	}
	if len(pool) > 1 {
		var parts []string
		for _, h := range pool {
			parts = append(parts, fmt.Sprintf("%s (%s, %s, %s)", h.Agent.Name, h.Agent.ID, h.Agent.Machine, h.Agent.Lifecycle))
		}
		return nil, &AmbiguousError{fmt.Sprintf("%s matches more than one agent: %s", ref, strings.Join(parts, ", "))}
	}
	if len(pool) == 0 {
		return nil, nil
	}
	return &pool[0], nil
}

// EncodeURIComponent is JavaScript's: letters, digits and -_.!~*'() stay as they are.
func EncodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', strings.IndexByte("-_.!~*'()", c) >= 0:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func agentOf(v jsfmt.Value) Agent {
	return Agent{ID: v.Text("id"), Name: v.Text("name"), Machine: v.Text("machine"), Lifecycle: v.Text("lifecycle"), Raw: v}
}

// Hits is peerHits: the exact matches for ref on every peer. unreachable is true when a peer that did not answer may hold
// one. Only another machine's agent is remembered (S-577): a peer that relayed the lookup back to us can return our own
// agent, which must not be stored as a twin of itself.
func (c *Client) Hits(ctx context.Context, d Store, ref string) (hits []Hit, unreachable bool) {
	peers := c.Peers()
	type result struct {
		hit    *Hit
		absent bool
	}
	results := make([]result, len(peers))
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := c.Call(ctx, p, http.MethodGet, "/api/agents/"+EncodeURIComponent(ref), nil, FanOutTimeout, false, nil)
			switch {
			case err == nil && r.Status == 200:
				results[i].hit = &Hit{Peer: &p, Agent: agentOf(r.Data)}
			case err == nil && r.Status == 404:
				results[i].absent = true
			}
		}()
	}
	wg.Wait()
	for _, r := range results {
		switch {
		case r.hit != nil:
			hits = append(hits, *r.hit)
		case !r.absent:
			unreachable = true
		}
	}
	for _, h := range hits {
		if h.Agent.Machine != c.machine {
			_ = d.RememberPeerAgent(ctx, seen(h.Agent))
		}
	}
	return hits, unreachable
}

// seen is what a peer's reply tells rememberPeerAgent: a listing carries every parent, a spawn's reply only parent_id.
func seen(a Agent) db.PeerAgentSeen {
	s := db.PeerAgentSeen{ID: a.ID, Name: a.Name, Machine: a.Machine, Lifecycle: a.Lifecycle}
	if ps, ok := a.Raw.Get("parents"); ok && ps.Kind == jsfmt.Array {
		s.Parents = []string{}
		for _, p := range ps.Items {
			if p.Kind == jsfmt.String {
				s.Parents = append(s.Parents, p.Str)
			}
		}
	}
	s.ParentID = a.Raw.Text("parent_id")
	s.Activity = a.Raw.Text("activity")
	if n, ok := a.Raw.Get("pending_requests"); ok && n.Kind == jsfmt.Number {
		s.PendingRequests = int(numberOf(n))
	}
	s.PausedBy = a.Raw.Text("paused_by")
	if w, ok := a.Raw.Get("waits"); ok && w.Kind == jsfmt.Array {
		s.Waits = len(w.Items)
	}
	return s
}

// Located is what Locate found.
type Located int

const (
	// Found: the agent is on a peer.
	Found Located = iota
	// Absent: every peer answered 404.
	Absent
	// Unreachable: it may sit on a peer that did not answer.
	Unreachable
)

// Locate is locateAgent: which peer owns an agent, by id or name, telling an agent no peer has from one that may sit on a
// peer that did not answer. An ambiguous name is an *AmbiguousError.
func (c *Client) Locate(ctx context.Context, d Store, ref string) (*Hit, Located, error) {
	hits, unreachable := c.Hits(ctx, d, ref)
	found, err := Pick(ref, hits)
	if err != nil {
		return nil, Absent, err
	}
	switch {
	case found != nil:
		return found, Found, nil
	case unreachable:
		return nil, Unreachable, nil
	}
	return nil, Absent, nil
}

// MachineOf is peerMachineOf: the other machine whose daemon knows an agent named ref, for a set-parent that names an agent
// no one here has (S-2453). Read only and never remembered, so a refusal changes no row. A peer that does not answer in
// time, or answers anything but that agent, is no match: "", not a guess.
func (c *Client) MachineOf(ctx context.Context, ref string) string {
	peers := c.Peers()
	found := make([]string, len(peers))
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := c.Call(ctx, p, http.MethodGet, "/api/agents/"+EncodeURIComponent(ref), nil, FanOutTimeout, false, nil)
			if err == nil && r.Status == 200 {
				if id, ok := r.Data.Get("id"); ok && id.Kind == jsfmt.String {
					if m := r.Data.Text("machine"); m != "" {
						found[i] = m
					} else {
						found[i] = p.Name
					}
				}
			}
		}()
	}
	wg.Wait()
	for _, m := range found {
		if m != "" && m != c.machine {
			return m
		}
	}
	return ""
}

func numberOf(v jsfmt.Value) float64 {
	f, _ := strconv.ParseFloat(v.Num, 64)
	return f
}

// RememberSpawned is spawnOnPeer's memory of a new agent (S-235): the agent a peer's spawn reply describes is remembered
// here, unless it is on this machine (a peer that relayed the spawn back). A ring spawned on a peer has no machine of its
// own: its members and moderator are the agents to remember, on that peer.
func (c *Client) RememberSpawned(ctx context.Context, d Store, p config.Peer, data jsfmt.Value) {
	if data.Text("id") != "" && data.Text("kind") != "ring" && data.Text("machine") != c.machine {
		_ = d.RememberPeerAgent(ctx, seen(agentOf(data)))
	}
	if data.Text("kind") != "ring" {
		return
	}
	var members []jsfmt.Value
	if m, ok := data.Get("members"); ok && m.Kind == jsfmt.Array {
		members = m.Items
	}
	if mod, ok := data.Get("moderator"); ok {
		members = append(members, mod)
	}
	for _, a := range members {
		if a.Kind == jsfmt.Object && a.Text("id") != "" && a.Text("name") != "" {
			_ = d.RememberPeerAgent(ctx, db.PeerAgentSeen{ID: a.Text("id"), Name: a.Text("name"), Machine: p.Name})
		}
	}
}
