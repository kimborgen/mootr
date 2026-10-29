package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/instructions"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/peers"
	"stam/internal/templates"
)

// The system prompt's parts (S-3776): what one agent receives, for the web UI's Instructions view
// (src/agent-instructions.ts), the same split into blocks for the inventory (src/inventory.ts), and the slots a launch
// fills (src/adapters/claude.ts launch). One instructions.Prompts serves all three, so the lessons a launch warms are the
// ones the routes show.

// homeReadTimeout is src/itsa-owners.ts loadOwned's deadline on each read from the ITSA home.
const homeReadTimeout = 2500 * time.Millisecond

func (s *Server) promptRoutes() {
	s.handle("GET /api/agents/{id}/instructions", agentPath(s.agentInstructions))
	s.handle("GET /api/agents/{id}/inventory", agentPath(s.agentInventory))
	s.handle("GET /api/types/{type}/inventory", s.typeInventory)
}

// newPrompts is the server's instructions.Prompts over the templates t: the search index finds lessons, the loaded
// processes render a brief's next steps, and the tiny block-summary step summarizes the inventory's blocks.
func (s *Server) newPrompts(t *templates.Set) *instructions.Prompts {
	return &instructions.Prompts{
		Templates: t,
		DB:        s.db,
		Settings:  s.settings.Get,
		Skills:    skillPaths(s.cfg.Home),
		IsHome:    s.isHome,
		Home:      &instructions.HomeItsas{},
		Index:     s.index,
		NextSteps: s.typeNextSteps,
		Summarize: s.tiny.BlockSummary,
	}
}

// promptSet is the server's Prompts; a server without templates answers 501.
func (s *Server) promptSet() (*instructions.Prompts, error) {
	if s.prompts == nil {
		return nil, unported("the templates aren't available on this daemon")
	}
	return s.prompts, nil
}

// homeGet reads one GET route from the ITSA home for Prompts.Load (src/itsa-owners.ts toHome): an answer of 300 or
// more is TS's `the ITSA home NAME refused: WHY` error. Load logs it, and the home's text (or a proxy's in front of it)
// could echo the bearer this daemon sent. peers.Call already redacts a refusal's body (S-3994); the peer's tokens are
// redacted here again, as defence in depth.
func (s *Server) homeGet(ctx context.Context, path string) (jsfmt.Value, error) {
	p, ok := s.homePeer()
	if !ok {
		return jsfmt.Value{}, fmt.Errorf("the ITSA home '%s' is not a configured peer", s.settings.Get().Itsa.Home)
	}
	r, err := s.peers.Call(ctx, p, http.MethodGet, path, nil, homeReadTimeout, false, nil)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if r.Status >= 300 {
		// TS's `${r.data?.error ?? r.status}`; an error that isn't a string is the status here.
		why := strconv.Itoa(r.Status)
		if v, ok := r.Data.Get("error"); ok && v.Kind == jsfmt.String {
			why = v.Str
		}
		return jsfmt.Value{}, errors.New(peers.Redact(p, "the ITSA home "+s.settings.Get().Itsa.Home+" refused: "+why))
	}
	return r.Data, nil
}

// promptAgent is the agent in the path with its ITSA slot read from the home first (itsaOwners.loadOwned), as both
// routes do in TS.
func (s *Server) promptAgent(r *http.Request) (*instructions.Prompts, db.Agent, error) {
	p, err := s.promptSet()
	if err != nil {
		return nil, db.Agent{}, err
	}
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, db.Agent{}, err
	}
	p.Load(r.Context(), a.ID, s.homeGet)
	return p, a, nil
}

// agentInstructions is GET /api/agents/:id/instructions: everything the agent receives, in order. Who may read it is
// the acting gate's (agent_routes.go); an agent on another machine was relayed before this. The answer is {parts}, as
// TS's agentInstructionParts returns it.
func (s *Server) agentInstructions(r *http.Request, _ auth.Resolved) (any, error) {
	p, a, err := s.promptAgent(r)
	if err != nil {
		return nil, err
	}
	parts, err := p.AgentInstructionParts(r.Context(), a)
	if err != nil {
		return nil, err
	}
	return struct {
		Parts []instructions.Part `json:"parts"`
	}{parts}, nil
}

// agentInventory is GET /api/agents/:id/inventory (S-877, S-879): the agent's prompt split into blocks with token
// estimates, hashes and summaries. A summary never holds the request up: a miss is queued and shows as pending.
func (s *Server) agentInventory(r *http.Request, _ auth.Resolved) (any, error) {
	p, a, err := s.promptAgent(r)
	if err != nil {
		return nil, err
	}
	inv, err := p.AgentInventory(r.Context(), a)
	if err != nil {
		return nil, err
	}
	return p.WithSummaries(r.Context(), inv)
}

// typeInventory is GET /api/types/:type/inventory[?harness=]: the inventory of a synthetic agent of the type; an
// unknown type is a 404 and an unknown harness a 400. Every token may read it, as in TS.
func (s *Server) typeInventory(r *http.Request, _ auth.Resolved) (any, error) {
	name := r.PathValue("type")
	if !agentRef.MatchString(name) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	p, err := s.promptSet()
	if err != nil {
		return nil, err
	}
	types, _ := s.registry().Get("types")
	if v, _ := at(types, name); !jsjson.Truthy(v) {
		return nil, Errorf(http.StatusNotFound, "no agent type %s", name)
	}
	q := r.URL.Query()
	harness := q.Get("harness")
	if q.Has("harness") {
		hs, _ := s.registry().Get("harnesses")
		o, _ := hs.(*jsjson.Object)
		if _, ok := o.Get(harness); o == nil || !ok {
			return nil, Errorf(http.StatusBadRequest, "unknown harness %s", harness)
		}
	}
	inv, err := p.TypeInventory(r.Context(), name, harness)
	if errors.Is(err, instructions.ErrNoType) {
		return nil, Errorf(http.StatusNotFound, "%s", err.Error())
	}
	if err != nil {
		return nil, err
	}
	return p.WithSummaries(r.Context(), inv)
}

// launchPrompts is what the lifecycle asks for a launch's system prompt (lifecycle.Prompts).
type launchPrompts struct{ s *Server }

// LaunchParts is the slots src/adapters/claude.ts launch fills: the ITSA slot read from the home first, then the org
// paragraph, the manager's cost section, the lessons (warmed now, kept for the routes), the workspace, the ITSAs, the
// requirements and the workspaces shared with the agent.
func (l launchPrompts) LaunchParts(ctx context.Context, a db.Agent) (claude.Parts, error) {
	return l.s.promptParts(ctx, a, false)
}

// promptParts is the system prompt's slots for the agent. The lessons are warmed now (a launch), or the block last
// computed is reused when there is one (cached: the OpenCode plugin's per-request read, src/daemon.ts
// `cachedLessons(a.id) ?? await warmLessons(a)`).
func (s *Server) promptParts(ctx context.Context, a db.Agent, cached bool) (claude.Parts, error) {
	p, err := s.promptSet()
	if err != nil {
		return claude.Parts{}, err
	}
	p.Load(ctx, a.ID, s.homeGet)
	var out claude.Parts
	if out.Org, err = p.OrgPrompt(ctx, a); err != nil {
		return claude.Parts{}, err
	}
	if out.Cost, err = p.ManagerCostPrompt(ctx, a); err != nil {
		return claude.Parts{}, err
	}
	if block, ok := p.CachedLessons(a.ID); cached && ok {
		out.Lessons = block
	} else {
		out.Lessons = p.WarmLessons(ctx, a)
	}
	if out.Workspace, err = p.WorkspacePrompt(ctx, a); err != nil {
		return claude.Parts{}, err
	}
	if out.Itsa, err = p.ItsaPrompt(ctx, a.ID); err != nil {
		return claude.Parts{}, err
	}
	if out.Requirements, err = p.RequirementsPrompt(); err != nil {
		return claude.Parts{}, err
	}
	if out.Granted, err = p.GrantedPaths(ctx, a.ID); err != nil {
		return claude.Parts{}, err
	}
	return out, nil
}

// ForgetLessons drops an archived agent's cached lessons (src/lifecycle.ts archive's forgetLessons).
func (l launchPrompts) ForgetLessons(id string) {
	if p := l.s.prompts; p != nil {
		p.ForgetLessons(id)
	}
}
