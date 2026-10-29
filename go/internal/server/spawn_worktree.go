package server

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
)

// A spawn's workspace (src/daemon.ts spawnAgentIn, src/workspace.ts spawnWorkspaceSpec, S-627, S-894, S-990): the cwd, a
// git worktree of its own (which the developer type and the reviewer types default to), the directory a workspace script
// prints, or the cwd with instructions to make its own; and apart from it, a personal workspace folder. A developer spawn
// takes a slot of the developer cap first (src/developer-cap.ts, S-2008), or waits in the slot queue (slotqueue.go) at
// the cap or on a host without room (S-2120). Not ported: linking a worktree's dependencies (S-4087).

// idleHold is src/developer-cap.ts IDLE_HOLD_MS: how long an idle or waiting developer keeps its slot.
const idleHold = 5 * time.Minute

// devSlots is src/developer-cap.ts reserved: the developer spawns in flight, which hold a slot until their row (with its
// worktree) exists. The count and the reservation run under mu, so two spawns at the cap's last slot can't both pass.
// names holds the name of every spawn in flight, of any type, so a second spawn of a name is refused before its first
// git run, as one with a row is.
type devSlots struct {
	mu       fifoLock
	reserved map[string]bool
	names    map[string]bool
	// q is the developer slot queue (slotqueue.go), under mu too.
	q slotQueue
	// inCount, when set, runs under mu once a developer spawn has counted the holders, before it reserves or queues: a
	// test holds the lock there.
	inCount func(name string)
	// afterReserve, when set, runs once a spawn holds its slot, before its worktree is made: a test holds a spawn there.
	afterReserve func(name string)
	// afterTree, when set, runs once a spawn's worktree exists: a test holds a spawn there.
	afterTree func(name string)
	// beforeStore, when set, runs after the spawn's row exists and before it holds the workspace: a test fails a spawn there.
	beforeStore func(name string) error
}

// reservePersonal is src/daemon.ts spawnAgentIn's holder check for a personal workspace: the live (not archived) agent
// whose folder path is, as a 409, else path held for this spawn until release. Held under the same lock as the names,
// so two spawns naming one workspace can't both pass while neither row exists yet.
func (s *Server) reservePersonal(ctx context.Context, name, path string) (release func(), err error) {
	slots := &s.devSlots
	slots.mu.Lock()
	defer slots.mu.Unlock()
	agents, err := s.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	for _, a := range agents {
		if a.PersonalWorkspace != nil && *a.PersonalWorkspace == path && a.Lifecycle != "archived" {
			return nil, Errorf(http.StatusConflict, "workspace %s is held by %s", name, a.Name)
		}
	}
	// A key no agent name can be (names are lowercase letters, digits and dashes).
	key := "workspace " + path
	if slots.names[key] {
		return nil, Errorf(http.StatusConflict, "workspace %s is held by a spawn in progress", name)
	}
	if slots.names == nil {
		slots.names = map[string]bool{}
	}
	slots.names[key] = true
	return func() {
		slots.mu.Lock()
		delete(slots.names, key)
		slots.mu.Unlock()
	}, nil
}

// reserveName refuses a name an agent has (a row), a spawn in flight holds, or a queued spawn waits or launches under
// (but a granted waiter's own launch passes), else holds it for this spawn until release, by which time its row exists
// or it failed. The check and the hold run under one lock, so two spawns of a name can't both pass and race each
// other's worktree.
func (s *Server) reserveName(ctx context.Context, name string, granted bool) (release func(), err error) {
	slots := &s.devSlots
	slots.mu.Lock()
	defer slots.mu.Unlock()
	if _, err := s.db.GetAgent(ctx, name); err == nil || slots.names[name] || slots.q.queuedName(name, granted) {
		return nil, Errorf(http.StatusConflict, "name %s is taken", name)
	}
	if slots.names == nil {
		slots.names = map[string]bool{}
	}
	slots.names[name] = true
	return func() {
		slots.mu.Lock()
		delete(slots.names, name)
		slots.mu.Unlock()
	}, nil
}

// developerHolders is src/developer-cap.ts developerHolders: the active developer agents on this machine that hold a
// slot now, working ones and ones idle or waiting for less than idleHold. Beyond TS, which frees the slot when the
// harness stops, a developer whose archive is in flight holds its slot, whatever its row says, until the archive has
// removed its worktree and marked it archived; and one whose archive failed after the harness stopped (shut down,
// `archive failed: ...`, its worktree kept) holds it until it is archived or runs again. A plain shutdown frees it.
func (s *Server) developerHolders(agents []db.Agent, now time.Time) []string {
	types, _ := s.registry().Get("types")
	var archiving map[string]bool
	if s.life != nil {
		archiving = s.life.Archiving()
	}
	var out []string
	for _, a := range agents {
		failedArchive := a.Lifecycle == "shut_down" && a.ActivityDetail != nil && strings.HasPrefix(*a.ActivityDetail, lifecycle.ArchiveFailedDetail)
		inArchive := (archiving[a.ID] || failedArchive) && a.Lifecycle != "archived"
		if (a.Lifecycle != "active" && !inArchive) || (a.Machine != "" && a.Machine != s.cfg.Machine) {
			continue
		}
		if ws, err := a.WorkspaceOf(); err != nil || ws == nil || ws.Worktree == nil {
			continue
		}
		if a.Type != nil {
			if t, _ := at(types, *a.Type); t != nil {
				if rv, _ := at(t, "review"); jsjson.Truthy(rv) {
					continue
				}
			}
		}
		// An unknown or unparsable idle_since holds the slot, as NaN does in TS.
		if !inArchive && (a.Activity == "idle" || a.Activity == "waiting") && a.IdleSince != nil {
			if since := jsMS(*a.IdleSince); !math.IsNaN(since) && float64(now.UnixMilli())-since >= float64(idleHold.Milliseconds()) {
				continue
			}
		}
		out = append(out, a.Name)
	}
	return out
}

// reserveDeveloper is src/daemon.ts spawnAgentIn's cap step, with src/developer-cap.ts developerCapRefusal and
// reserveSlot, under one lock from the count to the reservation: a developer spawn at the cap, behind waiters, or on a
// host without room waits in the slot queue (its reply, queued) when w.queue, else is a 409; the human's spawn always
// passes, and a granted waiter's passes on the slot its grant reserved. Otherwise the slot is held for name until
// release. owner is the caller the queue keys the spawn by; original is the body as it was asked.
func (s *Server) reserveDeveloper(ctx context.Context, name string, w write, original *jsjson.Object, owner string) (release func(), queued *queuedReply, err error) {
	cap := s.settings.Get().DeveloperCap
	host := hostReading{freeBytes: math.Inf(1)}
	if !w.granted && !w.human {
		host = s.hostReading()
	}
	slots := &s.devSlots
	slots.mu.Lock()
	release = func() {
		slots.mu.Lock()
		delete(slots.reserved, name)
		slots.mu.Unlock()
	}
	if !w.granted && !w.human {
		agents, err := s.db.ListAgents(ctx)
		if err != nil {
			slots.mu.Unlock()
			return nil, nil, err
		}
		holders, info := s.slotHolders(agents, time.Now())
		if slots.inCount != nil {
			slots.inCount(name)
		}
		full := cap > 0 && len(holders) >= cap
		// A spawn behind others in the queue waits too, even with a slot free, so it can't jump them.
		behind := cap > 0 && len(slots.q.waiting) > 0
		room := host.roomRefusal()
		if full || behind || room != "" {
			if !w.queue {
				slots.mu.Unlock()
				switch {
				case full:
					return nil, nil, Errorf(http.StatusConflict, "developer slots full on %s (%d of %d in use, developerCap in settings to change); holders: %s. Archive holders whose work is done, or retry when one finishes: wait_for a holder, or wake_me and spawn again.",
						s.cfg.Machine, len(holders), cap, strings.Join(holders, ", "))
				case room != "":
					return nil, nil, Errorf(http.StatusConflict, "%s", room)
				}
				return nil, nil, Errorf(http.StatusConflict, "developer spawns are queued on %s; %d waiting", s.cfg.Machine, len(slots.q.waiting))
			}
			r, err := s.queueSpawnLocked(original, name, room, owner, holders, info, cap)
			slots.mu.Unlock()
			return nil, r, err
		}
	}
	if slots.reserved == nil {
		slots.reserved = map[string]bool{}
	}
	slots.reserved[name] = true
	hook := slots.afterReserve
	slots.mu.Unlock()
	if hook != nil {
		hook(name)
	}
	return release, nil, nil
}

// workspaceSpec is src/workspace.ts WorkspaceSpec: a worktree (tree), a script that prints the directory (script), text
// telling the agent to make its own (instructions), or else the cwd.
type workspaceSpec struct {
	tree                 *lifecycle.WorktreeSpec
	script, instructions string
}

// spawnWorkspaceSpec is src/workspace.ts spawnWorkspaceSpec: an explicit `worktree` wins; else a workspace script or
// instructions, with no worktree; else the type's default, which for a reviewer type falls back to the cwd outside a git
// repo. A base without a worktree is a 400.
func spawnWorkspaceSpec(ctx context.Context, body *jsjson.Object, typ *jsjson.Object, base string) (workspaceSpec, error) {
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	review := false
	if typ != nil {
		rv, _ := typ.Get("review")
		review = jsjson.Truthy(rv)
	}
	script, instructions := field("workspace_script"), field("workspace_instructions")
	var worktree bool
	if v := field("worktree"); v != nil {
		worktree = jsjson.Truthy(v)
	} else if !jsjson.Truthy(script) && !jsjson.Truthy(instructions) {
		worktree = typ != nil && typeWantsWorktree(typ) && (!review || inGitRepo(ctx, base))
	}
	if !worktree {
		if jsjson.Truthy(field("base")) {
			return workspaceSpec{}, Errorf(http.StatusBadRequest, "base needs a worktree spawn")
		}
		if jsjson.Truthy(script) {
			return workspaceSpec{script: claude.JSString(script)}, nil
		}
		if jsjson.Truthy(instructions) {
			return workspaceSpec{instructions: claude.JSString(instructions)}, nil
		}
		return workspaceSpec{}, nil
	}
	spec := &lifecycle.WorktreeSpec{Repo: base}
	// A reviewer keeps its own branch (S-3113): it is cut from the developer's PR branch while the developer holds it.
	if v := field("branch"); jsjson.Truthy(v) {
		spec.Branch = claude.JSString(v)
	} else if review {
		spec.Branch = "new"
	}
	if v := field("base"); jsjson.Truthy(v) {
		spec.Base = claude.JSString(v)
	}
	return workspaceSpec{tree: spec}, nil
}

// createWorktree makes the spawn's worktree (src/workspace.ts createWorkspaceFetched); a failure is the 400
// `workspace: …`.
func (s *Server) createWorktree(ctx context.Context, spec lifecycle.WorktreeSpec, name string) (*lifecycle.CreatedWorktree, error) {
	set := s.settings.Get()
	var peers []string
	for _, p := range set.Peers {
		peers = append(peers, p.Name)
	}
	env := lifecycle.WorktreeEnv{Home: s.cfg.Home, Storage: func(remotes []string) string {
		return lifecycle.StorageRemote(set.Itsa.PrOpenStorage, peers, remotes)
	}}
	c, err := lifecycle.CreateWorktree(ctx, env, spec, name)
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "workspace: %s", err.Error())
	}
	return c, nil
}

// liveCheckoutRefusal is src/workspace.ts spawnWorkspaceRefusal for a spawn without a worktree: a type that wants one may
// not work in the live deploy checkout (S-627, S-990).
func (s *Server) liveCheckoutRefusal(ctx context.Context, typ *jsjson.Object, cwd string) error {
	if typ == nil || !typeWantsWorktree(typ) {
		return nil
	}
	if why := lifecycle.LiveCheckoutRefusal(ctx, cwd, s.deployCheckout(), s.cfg.DeployRepo != ""); why != "" {
		return Errorf(http.StatusBadRequest, "%s", why)
	}
	return nil
}

// workspaceJSON is JSON.stringify of src/workspace.ts Workspace, keys in TS's order: the agents.workspace column, which
// a restart and the archive read. cwd is where the spawn works (a script's directory, else base, else the worktree).
func workspaceJSON(base, cwd string, kind workspaceSpec, c *lifecycle.CreatedWorktree) string {
	switch {
	case kind.script != "":
		return jsjson.Stringify(jsjson.NewObject("spec", jsjson.NewObject("kind", "script", "command", kind.script, "cwd", base), "cwd", cwd), "")
	case kind.instructions != "":
		return jsjson.Stringify(jsjson.NewObject("spec", jsjson.NewObject("kind", "instructions", "text", kind.instructions, "cwd", base), "cwd", base), "")
	case kind.tree == nil:
		return jsjson.Stringify(jsjson.NewObject("spec", jsjson.NewObject("kind", "dir", "path", base), "cwd", base), "")
	}
	spec := kind.tree
	sp := jsjson.NewObject("kind", "worktree", "repo", spec.Repo)
	if spec.Branch != "" {
		sp.Set("branch", spec.Branch)
	}
	if spec.Base != "" {
		sp.Set("base", spec.Base)
	}
	w := c.Worktree
	tree := jsjson.NewObject("repo", w.Repo, "path", w.Path, "branch", w.Branch)
	if w.Base != "" {
		tree.Set("base", w.Base)
	}
	if w.Continues {
		tree.Set("continues", true)
	}
	if w.Suffixed {
		tree.Set("suffixed", true)
	}
	ws := jsjson.NewObject("spec", sp, "cwd", c.Cwd, "worktree", tree, "deps", []jsjson.Value{})
	if b := baseUsedJSON(c.BaseUsed); b != nil {
		ws.Set("baseUsed", b)
	}
	return jsjson.Stringify(ws, "")
}

// baseUsedJSON is src/workspace.ts BaseUsed as TS writes it, nil for none: the workspace:base event's data too.
func baseUsedJSON(b *lifecycle.BaseUsed) *jsjson.Object {
	if b == nil {
		return nil
	}
	o := jsjson.NewObject("ref", b.Ref, "sha", b.SHA, "fetch", b.Fetch)
	if b.Error != "" {
		o.Set("error", b.Error)
	}
	if b.Defaulted {
		o.Set("defaulted", true)
	}
	if b.Continued != "" {
		o.Set("continued", b.Continued)
	}
	return o
}

// worktreeNotes is what src/daemon.ts spawnAgentIn puts before a worktree agent's prompt, in its order: the PR it
// continues or the base it stacks on, a suffixed branch, and a stale base after a failed fetch.
func worktreeNotes(c *lifecycle.CreatedWorktree, name, prompt string) string {
	if c == nil || prompt == "" {
		return prompt
	}
	w, b := c.Worktree, c.BaseUsed
	if w.Continues && b != nil {
		prompt = fmt.Sprintf("Your worktree is on %s, the branch of the PR you continue, at %s (%s): commit here, then pr_open %s updates that PR. Do not create another branch.\n\n%s", w.Branch, short(b.SHA), w.Base, w.Branch, prompt)
	} else if w.Base != "" {
		prompt = fmt.Sprintf("Your branch is cut from %s, so your PR stacks on it.\n\n%s", w.Base, prompt)
	}
	if w.Suffixed {
		prompt = fmt.Sprintf("Your branch is %s, not stam/%s: that name was already used by an earlier agent. Use %s for pr_open.\n\n%s", w.Branch, name, w.Branch, prompt)
	}
	if b != nil && b.Defaulted && b.Fetch == "failed" {
		why := b.Error
		if why == "" {
			why = "unknown error"
		}
		prompt = fmt.Sprintf("Your branch is cut from %s at %s because fetching origin failed (%s), so it may be stale: run `git fetch origin` and rebase on origin/main before you start.\n\n%s", b.Ref, short(b.SHA), why, prompt)
	}
	return prompt
}

// short is sha.slice(0, 8).
func short(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}
