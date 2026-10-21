package server

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"stam/internal/db"
	"stam/internal/process"
)

// Agent nodes (src/process-run.ts agentRunner, S-1037, S-1038): entering one mails the standing agent that holds the lane, or spawns
// the lane's type for the ITSA. The mail is carried out. A spawn is decided here (the claim, the hourly cap, the working limit) but
// its start is not ported: it needs agent types, ITSAs and workspaces in the Go daemon's spawn, so a runner entry that would spawn
// answers 501 before the stage is written (stageEntryRefusal), and agentRun's spawn is a hook only the tests set.

// maxWorkingAgents is src/process-run.ts MAX_WORKING_AGENTS: the most working agents a machine runs before a process spawn is refused.
const maxWorkingAgents = 8

// errSpawnNotPorted is what the spawn of a process agent answers by default.
var errSpawnNotPorted = errors.New("starting an agent for a process is not ported to the Go daemon yet")

// spawnInput is what a process spawn asks of the daemon's spawn.
type spawnInput struct {
	Type, Itsa, Prompt, Parent, Machine string
}

func (s *Server) spawnAgent(ctx context.Context, in spawnInput) (string, error) {
	if s.runner.spawnAgent != nil {
		return s.runner.spawnAgent(ctx, in)
	}
	return "", errSpawnNotPorted
}

// liveAgent is the agent a reference names when it is alive (active or paused: src/db.ts isLive).
func (s *Server) liveAgent(ctx context.Context, ref string) (db.Agent, bool) {
	if ref == "" {
		return db.Agent{}, false
	}
	a, err := s.db.GetAgent(ctx, ref)
	if err != nil || (a.Lifecycle != "active" && a.Lifecycle != "paused") {
		return db.Agent{}, false
	}
	return a, true
}

// agentContext is the daemon's agentOf: what an agent node needs about the ITSA, nil when it is gone.
func (s *Server) agentContext(ctx context.Context, id string) *process.AgentContext {
	return s.agentContextAs(ctx, id, nil)
}

// agentContextAs is agentContext with the owner a change in flight is giving the ITSA (nil: the stored one): the change is not
// committed yet, so a read can't see it.
func (s *Server) agentContextAs(ctx context.Context, id string, owner *string) *process.AgentContext {
	x, found, err := s.db.FindItsa(ctx, id)
	if err != nil || !found {
		return nil
	}
	types := map[string]bool{}
	reviewers := map[string]bool{}
	if s.tpl != nil {
		if all, err := s.tpl.Types(); err == nil {
			for n, t := range all {
				types[n] = true
				reviewers[n] = t.Review
			}
		}
	}
	a := &process.AgentContext{ID: x.Text("id"), Key: x.Text("key"), Cos: s.chiefOfStaffID(ctx),
		TypeKnown:      func(t string) bool { return types[t] },
		IsReviewerType: func(t string) bool { return reviewers[t] }}
	own := x.Text("owner")
	if owner != nil {
		own = *owner
	}
	_, a.OwnerLive = s.liveAgent(ctx, own)
	itsas := []string{x.Text("id")}
	if parent := x.Text("parent_id"); parent != "" {
		if p, found, err := s.db.FindItsa(ctx, parent); err == nil && found {
			a.ParentOwner = p.Text("owner")
		}
		itsas = append(itsas, parent)
	}
	// A live reviewer on this ITSA or its parent ITSA (a reviewer of the parent covers its children).
	for _, itsa := range itsas {
		people, err := s.db.ItsaParticipants(ctx, itsa)
		if err != nil {
			continue
		}
		for _, p := range people {
			if ag, ok := s.liveAgent(ctx, p); ok && s.isReviewerAgent(ag, reviewers) {
				a.ReviewerLive = true
			}
		}
	}
	return a
}

// isReviewerAgent is src/cost-fallback.ts isReviewer: its type is a reviewer type, or with no type, the legacy role.
func (s *Server) isReviewerAgent(a db.Agent, reviewers map[string]bool) bool {
	if a.Type != nil && *a.Type != "" {
		return reviewers[*a.Type]
	}
	return a.Role == "reviewer"
}

// agentRefusal answers 501 when the runner's entry into `to` would spawn an agent: the start is not ported. A mail, a skip and an
// entry by anyone else are fine. id is the ITSA ("" when it does not exist yet: the runner never creates one, so a runner-actor create
// at an agent node is refused outright, as it has no context to decide a skip on). owner is the owner the same change gives it.
func (s *Server) agentRefusal(ctx context.Context, id string, p *process.Def, to, actor string, owner *string) error {
	if s.runMode() != "on" || actor != process.RunnerActor {
		return nil
	}
	if id == "" {
		return unported("process.run is on and a create entering the agent node %s of process %s as the runner would act on it, which is not ported to the Go daemon yet", to, p.ID)
	}
	for _, a := range process.EntryActions(p, to, nil, "", s.agentContextAs(ctx, id, owner)) {
		if a.Do == "spawn" {
			return unported("process.run is on and the runner entering the agent node %s of process %s spawns a %s, which is not ported to the Go daemon yet", to, p.ID, a.Type)
		}
	}
	return nil
}

// agentRun is src/process-run.ts agentRunner: it performs a spawn or a mail for real. A refusal (repeat, cap, working limit) is
// logged, noted on the ITSA and leaves it where it is; a failed spawn mails the parent once and is not retried. The check and the
// claim happen under one lock and one transaction, so two entries can't both pass the same check, and the first one's in-flight
// spawn is already counted for the second.
func (s *Server) agentRun(ctx context.Context, id string, p *process.Def, a process.EntryAction) {
	ctx = context.WithoutCancel(ctx)
	s.goLive(func() {
		refuse := func(why string) {
			logRun(fmt.Sprintf("process-run: %s: %s", id, why))
			s.noteProcessRun(ctx, id, "process "+p.ID+": "+why)
		}
		failed := func(err error) { logRun(fmt.Sprintf("process-run: %s: agent node failed: %v", id, err)) }
		// The entry is read first: the stage-change event it names is the latest one only until the next change.
		entry, err := s.db.ProcessEntry(ctx, id)
		if err != nil {
			failed(err)
			return
		}
		cap := s.settings.Get().Process.MaxSpawnsPerHour
		if a.Do == "mail" {
			switch c, err := s.db.ClaimProcessAgent(ctx, id, "mail", a.Node, entry, fmt.Sprintf("process %s: mailing %s about %s at `%s`", p.ID, a.To, a.Itsa, a.Node), cap, "", nil); {
			case err != nil:
				failed(err)
			case c == db.AlreadyClaimed:
				refuse(a.Node + ": this entry was already acted on; ignored")
			default:
				if !s.sendFromStam(ctx, []string{a.To}, a.Itsa+" entered "+a.Node,
					fmt.Sprintf("The process %s moved %s to `%s`. It is yours: take the next step.", p.ID, a.Itsa, a.Node)) {
					failed(errors.New("no agent can stand in as sender of stam's mail"))
				}
			}
			return
		}
		where := a.Machine
		if where == "" {
			where = "this machine"
		}
		if a.Machine != "" && a.Machine != s.cfg.Machine {
			refuse(fmt.Sprintf("not spawning a %s on %s: can't read how many agents work there (no peer machine %s)", a.Type, where, a.Machine))
			return
		}
		if h := s.runner.claimStep; h != nil {
			h(id, "before")
		}
		s.runner.mu.Lock()
		busy := 0
		claim, err := s.db.ClaimProcessAgent(ctx, id, "spawn", a.Node, entry, fmt.Sprintf("process %s: spawning a %s for %s", p.ID, a.Type, a.Itsa), cap, s.cfg.Machine, func(working int) bool {
			if h := s.runner.claimStep; h != nil {
				h(id, "inside")
			}
			busy = working + s.runner.inFlight[a.Machine]
			return busy >= maxWorkingAgents
		})
		if err == nil && claim == db.Claimed {
			if s.runner.inFlight == nil {
				s.runner.inFlight = map[string]int{}
			}
			s.runner.inFlight[a.Machine]++
		}
		s.runner.mu.Unlock()
		switch {
		case err != nil:
			failed(err)
			return
		case claim == db.AlreadyClaimed:
			refuse(a.Node + ": this entry was already acted on; ignored")
			return
		case claim == db.OverCap:
			refuse(fmt.Sprintf("not spawning a %s: %d process spawns in the last hour", a.Type, cap))
			return
		case claim == db.Busy:
			refuse(fmt.Sprintf("not spawning a %s: %d agents already working on %s", a.Type, busy, where))
			return
		}
		defer func() {
			s.runner.mu.Lock()
			s.runner.inFlight[a.Machine]--
			s.runner.mu.Unlock()
		}()
		prompt := a.Prompt
		parentName := "your parent"
		if a.Parent != "" {
			parentName = a.Parent
			if ag, err := s.db.GetAgent(ctx, a.Parent); err == nil {
				parentName = ag.Name
			}
		}
		prompt = strings.ReplaceAll(prompt, "{{parent}}", parentName)
		name, err := s.spawnAgent(ctx, spawnInput{Type: a.Type, Itsa: a.Itsa, Prompt: prompt, Parent: a.Parent, Machine: a.Machine})
		if err == nil {
			s.noteProcessRun(ctx, id, fmt.Sprintf("process %s: spawned %s (%s) for %s", p.ID, name, a.Type, a.Itsa))
			return
		}
		logRun(fmt.Sprintf("process-run: %s: spawning a %s failed: %v", id, a.Type, err))
		s.noteProcessRun(ctx, id, fmt.Sprintf("process %s: spawning a %s for %s failed: %v", p.ID, a.Type, a.Itsa, err))
		if a.Parent != "" {
			s.sendFromStam(ctx, []string{a.Parent}, "Process spawn for "+a.Itsa+" failed",
				fmt.Sprintf("The process %s could not spawn a %s for %s: %v\n\nIt will not retry; the ITSA is unchanged.", p.ID, a.Type, a.Itsa, err))
		}
	})
}
