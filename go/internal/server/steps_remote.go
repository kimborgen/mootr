package server

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// indexPoll is how often a daemon that is not the ITSA home refreshes its copy of the home's enforced-tools index
// (src/req-check.ts INDEX_POLL_MS).
func indexPoll() time.Duration {
	if ms, err := strconv.Atoi(os.Getenv("STAM_REQ_INDEX_MS")); err == nil && ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return 60 * time.Second
}

// remoteIndex is the copy of the home's enforced-tools index this daemon keeps; none until first fetched.
type remoteIndex struct {
	mu       sync.Mutex
	tools    map[string]bool
	have     bool
	fetching bool
}

func (s *Server) forwardError(ctx context.Context, ref string, msg string) {
	data := jsfmt.Value{Kind: jsfmt.Object}
	data.Set("subject", jsfmt.StringValue(ref))
	data.Set("error", jsfmt.StringValue("home: "+msg))
	_ = s.db.AddEvent(context.WithoutCancel(ctx), "stam", "req:error", data)
}

func (s *Server) homePeer() (config.Peer, bool) {
	home := s.settings.Get().Itsa.Home
	for _, p := range s.peers.Peers() {
		if p.Name == home {
			return p, true
		}
	}
	return config.Peer{}, false
}

// fetchIndex reads the home's `GET /api/requirements/enforced-tools` (5 s), at most one at a time.
func (s *Server) fetchIndex(ctx context.Context) {
	if s.isHome() || !s.requirements.Enabled() {
		return
	}
	ri := &s.remoteIdx
	ri.mu.Lock()
	if ri.fetching {
		ri.mu.Unlock()
		return
	}
	ri.fetching = true
	ri.mu.Unlock()
	defer func() { ri.mu.Lock(); ri.fetching = false; ri.mu.Unlock() }()
	p, ok := s.homePeer()
	if !ok {
		s.forwardError(ctx, "index", fmt.Sprintf("the ITSA home '%s' is not a configured peer", s.settings.Get().Itsa.Home))
		return
	}
	r, err := s.peers.Call(ctx, p, "GET", "/api/requirements/enforced-tools", nil, 5*time.Second, false, nil)
	list, isList := r.Data.Get("tools")
	if err != nil || r.Status != 200 || !isList || list.Kind != jsfmt.Array {
		msg := "answered " + fmt.Sprint(r.Status) + ": " + r.Data.Text("error")
		if err != nil {
			msg = err.Error()
		}
		s.forwardError(ctx, "index", msg)
		return
	}
	tools := map[string]bool{}
	for _, t := range list.Items {
		if t.Kind == jsfmt.String {
			tools[t.Str] = true
		}
	}
	ri.mu.Lock()
	ri.tools, ri.have = tools, true
	ri.mu.Unlock()
}

// remoteToolCheck is src/req-check.ts remoteCheckTool: with no copy of the home's index yet the call goes through and the
// copy is fetched; a tool not in it goes through; a tool in it is asked of the home in the time left. A home that cannot be
// reached logs a `req:error` and allows. The returned denial is the home's, as it answered.
func (s *Server) remoteToolCheck(ctx context.Context, agentID, tool string, args jsfmt.Value, left time.Duration) *jsfmt.Value {
	ri := &s.remoteIdx
	ri.mu.Lock()
	have, listed := ri.have, ri.tools[tool]
	ri.mu.Unlock()
	if !have {
		// Off the request: the fetch outlives the check.
		go s.fetchIndex(context.WithoutCancel(ctx))
	}
	if !have || !listed {
		return nil
	}
	ref := "tool:" + tool
	p, ok := s.homePeer()
	if !ok {
		s.forwardError(ctx, ref, fmt.Sprintf("the ITSA home '%s' is not a configured peer", s.settings.Get().Itsa.Home))
		return nil
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("agent", jsfmt.StringValue(agentID))
	actor, _ := jsfmt.Parse([]byte(jsjson.Stringify(s.steps.ActorOf(ctx, agentID).Value(), "")))
	body.Set("actor", actor)
	body.Set("tool", jsfmt.StringValue(tool))
	body.Set("args", args)
	body.Set("budgetMs", jsfmt.IntValue(left.Milliseconds()))
	r, err := s.peers.Call(ctx, p, "POST", "/api/requirements/check-tool", body, left, false, nil)
	if err != nil || r.Status != 200 {
		msg := fmt.Sprintf("answered %d: %s", r.Status, r.Data.Text("error"))
		if err != nil {
			msg = err.Error()
		}
		s.forwardError(ctx, ref, msg)
		return nil
	}
	if a, _ := r.Data.Get("allow"); a.Kind == jsfmt.Bool && !a.Bool && r.Data.Text("error") != "" {
		denial := jsfmt.Value{Kind: jsfmt.Object}
		denial.Set("allow", a)
		for _, k := range []string{"requirement", "p", "error"} {
			if v, ok := r.Data.Get(k); ok {
				denial.Set(k, v)
			}
		}
		return &denial
	}
	return nil
}
