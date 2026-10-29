package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"stam/internal/adapters/claude"
	"stam/internal/api"
	"stam/internal/auth"
	"stam/internal/clock"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
)

// The agent lifecycle routes (S-2820): spawn, show, events, kill and forget, and the Claude Code hook and status-line
// reports, with the paths, request and response shapes, and auth of src/daemon.ts.

// agentShow is GET /api/agents/:id (src/daemon.ts): publicAgent's columns, then blockers, waits, resting, view and now
// (the daemon's clock, ISO UTC, S-3468). Resting is a placeholder until its module is ported, as in the list: null.
type agentShow struct {
	db.Agent
	Blockers []blockerOut      `json:"blockers"`
	Waits    []api.AgentWait   `json:"waits"`
	Resting  *api.AgentResting `json:"resting"`
	View     *viewCaps         `json:"view"`
	Now      string            `json:"now"`
}

func (s *Server) showAgent(r *http.Request, _ auth.Resolved) (any, error) {
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	waits, err := s.agentWaits(r.Context(), a.ID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.BlockerRows(r.Context(), a.ID)
	if err != nil {
		return nil, err
	}
	blockers := make([]blockerOut, 0, len(rows))
	for _, b := range rows {
		o := blockerOut{AgentID: b.AgentID, Kind: b.Kind, Account: b.Account, Reason: b.Reason, Since: b.Since}
		if b.Clear != nil {
			o.Clear = json.RawMessage(*b.Clear)
		}
		blockers = append(blockers, o)
	}
	return agentShow{Agent: a, Blockers: blockers, Waits: waits, View: viewOf(a), Now: clock.Now().UTC().Format("2006-01-02T15:04:05.000Z")}, nil
}

// blockerOut is src/blockers.ts Blocker as JSON, in the table's column order, with the clear condition as stored
// (JSON.stringify's text, which JSON.parse and a second JSON.stringify give back unchanged), so it matches TS byte for
// byte.
type blockerOut struct {
	AgentID string          `json:"agent_id"`
	Kind    string          `json:"kind"`
	Account string          `json:"account"`
	Reason  string          `json:"reason"`
	Since   string          `json:"since"`
	Clear   json.RawMessage `json:"clear"`
}

// agentEvents is GET /api/agents/:id/events: the latest `limit` events (50 by default, at most 1000) of the agent,
// oldest first, those whose type matches the `type` glob when it is given. An agent reads its own and its descendants'.
func (s *Server) agentEvents(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	if err := s.mayActAs(ctx, c.Caller, r.PathValue("id"), false); err != nil {
		return nil, err
	}
	a, err := s.mustAgent(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	limit := 50
	if q.Has("limit") {
		// Math.max(1, Math.min(1000, Number(limit) || 50)): an empty, zero or unreadable limit is 50.
		if n, err := strconv.ParseFloat(strings.TrimSpace(q.Get("limit")), 64); err == nil && n != 0 && !math.IsNaN(n) {
			limit = int(math.Max(1, math.Min(1000, n)))
		}
	}
	events, err := s.db.ListEvents(ctx, a.ID, limit, q.Get("type"))
	if err != nil {
		return nil, err
	}
	if events == nil {
		events = []db.Event{}
	}
	return events, nil
}

// controlBoss is the agent-control route's `boss`: an agent (or the OpenCode server) naming the assistant, or one a
// peer vouches is the assistant; otherwise a request with no `by` from the human, a peer's own daemon, or anyone
// while auth.humanStrict is off; or one naming the assistant.
func (s *Server) controlBoss(ctx context.Context, c auth.Resolved, w write, by jsjson.Value) (bool, error) {
	named := jsjson.Truthy(by)
	assistant := named && s.isAssistant(ctx, claude.JSString(by))
	if c.IsAgent() {
		return named && (assistant || c.Assistant), nil
	}
	peerOwn := w.local && c.Kind == auth.Shared
	return (!named && (w.human || peerOwn || !s.strictRefuses("agent control with no by", true))) || assistant, nil
}

type hookReply struct {
	Stdout *string `json:"stdout,omitempty"`
	// Ack lists the answer rows the response carried; its client acknowledges them once it has printed it (S-3923).
	Ack []int64 `json:"ack,omitempty"`
}

// hook is POST /api/hook/:harness/:id: a harness hook's payload, from the agent's own token (self only). It answers
// {stdout?}, which `stam hook` prints byte for byte.
func (s *Server) hook(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	harness, id := r.PathValue("harness"), r.PathValue("id")
	if !word.MatchString(harness) || !agentRef.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.mayActAs(ctx, c.Caller, id, true); err != nil {
		return nil, err
	}
	a, err := s.mustAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "hooks aren't available on this daemon")
	}
	var payload jsjson.Value
	if w.body != nil {
		payload = w.body
	}
	var ack []int64
	stdout, err := s.life.OnHook(ctx, harness, a, payload, &ack)
	if _, ok := err.(lifecycle.ErrNoHooks); ok {
		return nil, Errorf(http.StatusNotImplemented, "%s", err.Error())
	}
	if err != nil {
		return nil, err
	}
	return hookReply{Stdout: stdout, Ack: ack}, nil
}

// noticeAck is POST /api/notices/:id/ack/:row: the hook client printed the response that carried answer row :row, so the
// agent has its notice (S-3923). From the agent's own token (self only).
func (s *Server) noticeAck(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	row, err := strconv.ParseInt(r.PathValue("row"), 10, 64)
	if err != nil || !agentRef.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	if err := s.mayActAs(ctx, c.Caller, id, true); err != nil {
		return nil, err
	}
	if s.life != nil {
		s.life.AckNotice(ctx, id, row)
	}
	return struct{}{}, nil
}

// statusline is POST /api/statusline/:harness/:id: a status-line report, from the agent's own token (self only). It
// answers whether anyone views the agent, which `stam statusline` reads to cache the user's status line longer.
func (s *Server) statusline(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	harness, id := r.PathValue("harness"), r.PathValue("id")
	if !word.MatchString(harness) || !agentRef.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.mayActAs(ctx, c.Caller, id, true); err != nil {
		return nil, err
	}
	a, err := s.mustAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "status lines aren't available on this daemon")
	}
	var payload jsjson.Value
	if w.body != nil {
		payload = w.body
	}
	viewed, err := s.life.OnStatusLine(ctx, harness, a, payload)
	if err != nil {
		return nil, err
	}
	// Anyone viewing it: a tmux client, the web's own view of it, or a web terminal on its session.
	viewed = viewed || s.views.HasViewers(a.ID) || s.TerminalViewers(a.ID)
	return struct {
		Viewed bool `json:"viewed"`
	}{viewed}, nil
}

// word and agentRef are the TS route regexes' groups: (\w+) for a harness, ([\w-]+) for an agent.
var (
	word     = regexp.MustCompile(`^\w+$`)
	agentRef = regexp.MustCompile(`^[\w-]+$`)
	nameRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)
)

// spawnKeys are the spawn body's fields the Go daemon handles; any other a spawn names is refused with a 501, so
// nothing is silently ignored.
var spawnKeys = map[string]bool{
	"machine": true, "name": true, "harness": true, "model": true, "effort": true, "cwd": true, "prompt": true, "role": true, "by": true,
	"from": true, "self": true, "parent": true, "standing": true, "visibility": true, "child_notices": true,
	"permission_mode": true, "itsa": true, "participate": true, "urgent": true, "type": true, "preset": true, "brief_vars": true, "kind": true,
	"chief_of_staff": true, "worktree": true, "branch": true, "base": true, "workspace": true, "workspace_script": true,
	"workspace_instructions": true, "itsa_participant": true,
}

// spawnView is the spawn's reply: the agent's row, then its view capabilities (S-173).
type spawnView struct {
	db.Agent
	View *viewCaps `json:"view"`
}

// spawn is POST /api/agents (src/daemon.ts spawnAgent) for a Claude Code agent in an existing directory: the agent
// row, its token, the launch, the tmux session, and the first prompt typed in once the harness is up.
//
// A nameless spawn gets a free name, and one with no type, preset, harness or model the default preset. An agent type
// (spawn_type.go) sets the preset, role, visibility, child notices, standing and brief; anything given explicitly wins.
// Its ITSAs (`itsa`, `participate`, and under settings.itsa.required the parent's open ITSA) are on the ITSA home only; a
// reviewer type only takes part in its `itsa`.
//
// The workspace (`worktree`, `branch`, `base` or the type's default, `workspace_script`, `workspace_instructions`) and
// the personal workspace (`workspace`) are spawn_worktree.go's.
//
// Not yet ported, refused with a 501 when the body asks for it: a local caller's spawn on another machine (relay.go
// forwards a remote one). A developer spawn at the cap waits in the slot queue (slotqueue.go), and its reply says so
// (queuedReply). Not ported either: the cost admission's refusal (S-3545; a new agent does get its
// account's rule and budget blockers), so a reviewer type whose account is held doesn't move to its fallback type,
// Codex and OpenCode. Not yet ported either: opening the mail threads the prompt cites to the new agent
// (grantCitedThreads).
func (s *Server) spawn(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	// A ring reviewer type with no harness, model, or preset is spawned as a ring (rings_type.go). A caller that hangs up
	// doesn't cancel it, as in TS: a ring that fails must still discard the members it spawned.
	if name, typ := s.ringTypeOf(w.body); typ != nil {
		return s.spawnRingType(context.WithoutCancel(r.Context()), c, w, name, typ)
	}
	w.queue = true
	out, err := s.spawnWrite(r.Context(), c, w)
	// The same agent queued on another machine would start a duplicate (S-2134): those queued spawns are dropped.
	if a, ok := out.(spawnView); ok && err == nil {
		if by := spawnerKey(c, w.body); by != "" {
			s.dropQueuedDuplicates(r.Context(), a.Name, by)
		}
	}
	return out, err
}

// spawnerKey is src/developer-cap.ts spawnerKey: the caller a spawn is keyed by for the slot queue and its duplicate
// check, an agent's own id, which it can't forge, else the `by` the request names (the human's or a peer's spawn).
func spawnerKey(c auth.Resolved, body *jsjson.Object) string {
	if c.Kind == auth.Agent && c.Caller.Agent != "" {
		return c.Caller.Agent
	}
	if v, _ := body.Get("by"); jsjson.Truthy(v) {
		return claude.JSString(v)
	}
	return ""
}

// spawnWrite is spawn after its body is read: POST /api/agents, and the daemon's own spawn of a chief of staff
// (startCos), which comes as the human's. Its value is a spawnView.
func (s *Server) spawnWrite(ctx context.Context, c auth.Resolved, w write) (any, error) {
	var err error
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	// The body as it was asked, before the type's and the preset's defaults: what a queued spawn saves.
	original := jsjson.Clone(body).(*jsjson.Object)
	set := s.settings.Get()
	by := field("by")
	// A granted waiter's launch is the daemon's own: its route's check ran when it queued.
	if !jsjson.Truthy(by) && !w.granted && s.strictRefuses("spawn with no by", !w.human && !(w.local && c.Kind == auth.Shared) && c.Kind != auth.Agent) {
		return nil, Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), spawns an agent")
	}
	if err := s.spawnStepRefusal(ctx); err != nil {
		return nil, err
	}
	for _, k := range body.Keys() {
		if v, _ := body.Get(k); !spawnKeys[k] && v != nil {
			return nil, Errorf(http.StatusNotImplemented, "spawn: %s is not ported to the Go daemon yet", k)
		}
	}
	if m := field("machine"); jsjson.Truthy(m) && claude.JSString(m) != s.cfg.Machine {
		return nil, Errorf(http.StatusNotImplemented, "spawn: machine is not ported to the Go daemon yet")
	}
	var typ *jsjson.Object
	typeName := ""
	if v := field("type"); jsjson.Truthy(v) {
		typeName = claude.JSString(v)
		if typ, err = s.spawnType(typeName); err != nil {
			return nil, err
		}
	}
	// With no type, preset, harness or model, the spawn gets settings.spawnDefaults.preset.
	preset := ""
	if v := field("preset"); jsjson.Truthy(v) {
		preset = claude.JSString(v)
	} else if typ == nil && !jsjson.Truthy(field("harness")) && !jsjson.Truthy(field("model")) && set.SpawnDefaults.Preset != nil && *set.SpawnDefaults.Preset != "" {
		preset = *set.SpawnDefaults.Preset
	}
	if !jsjson.Truthy(field("cwd")) && set.SpawnDefaults.Cwd != nil && *set.SpawnDefaults.Cwd != "" {
		body.Set("cwd", expandHome(*set.SpawnDefaults.Cwd))
	}
	name := ""
	if v := field("name"); v != nil {
		name = jsjson.Trim(claude.JSString(v))
	}
	if name == "" {
		if name, err = s.freeName(ctx); err != nil {
			return nil, err
		}
	}
	if !nameRe.MatchString(name) {
		return nil, Errorf(http.StatusBadRequest, "name must be lowercase letters, digits, and dashes")
	}
	// An incident spawn (S-2406) needs an ITSA, or an ancestor, with the incident mark, slot free or not; a queued one is
	// checked again when it launches. The other urgent reasons only order the developer slot queue.
	if u, ok := field("urgent").(string); ok && u == "incident" {
		ref := ""
		if v := field("itsa"); jsjson.Truthy(v) {
			ref = claude.JSString(v)
		}
		if !s.incidentMarked(ctx, ref) {
			return nil, Errorf(http.StatusForbidden, "%s", incidentRefusal)
		}
	}
	release, err := s.reserveName(ctx, name, w.granted)
	if err != nil {
		return nil, err
	}
	defer release()
	if typ != nil {
		// A ring type is spawned as a ring only by POST /api/agents with no harness, model, or preset (spawn).
		rv, _ := typ.Get("review")
		if ring, _ := at(rv, "ring"); ring != nil {
			return nil, Errorf(http.StatusBadRequest, "a ring reviewer type takes no harness, model, or preset, and is spawned as a ring through POST /api/agents")
		}
	}
	if preset != "" {
		if s.life == nil {
			return nil, Errorf(http.StatusNotImplemented, "spawn isn't available on this daemon")
		}
		h, m, e, err := s.life.Preset(preset)
		if err != nil {
			return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
		}
		// body.x ?? preset.x: an explicit effort wins.
		if field("harness") == nil {
			body.Set("harness", h)
		}
		if field("model") == nil && m != nil {
			body.Set("model", *m)
		}
		if field("effort") == nil && e != nil {
			body.Set("effort", *e)
		}
	}
	if typ != nil {
		// The type's model and effort only fit its own harness.
		th, _ := typ.Get("harness")
		if h := field("harness"); !jsjson.Truthy(h) || jsjson.Equal(h, th) {
			body.Set("harness", th)
			for _, k := range []string{"model", "effort"} {
				if field(k) == nil {
					v, _ := typ.Get(k)
					body.Set(k, v)
				}
			}
		}
		if !jsjson.Truthy(field("role")) {
			body.Set("role", typeName)
		}
		for _, k := range []string{"visibility", "child_notices"} {
			if field(k) == nil {
				v, _ := typ.Get(k)
				body.Set(k, v)
			}
		}
	}
	assistant := false
	if jsjson.Truthy(by) {
		assistant = s.isAssistant(ctx, claude.JSString(by))
	}
	boss := w.human || assistant
	// The cos type makes its agent the chief of staff, so only the human and the assistant spawn it, and only one runs.
	isCos := typ != nil && typeName == "cos"
	if isCos {
		if !boss {
			return nil, Errorf(http.StatusForbidden, "only the human and the assistant spawn a chief of staff")
		}
		release, err := s.cos.claim(ctx, s)
		if err != nil {
			return nil, err
		}
		defer release()
		if s.cos.held != nil {
			if err := s.cos.held(); err != nil {
				return nil, err
			}
		}
	}
	harness := "claude"
	if v := field("harness"); v != nil {
		harness = claude.JSString(v)
	}
	switch harness {
	case "claude":
	case "opencode":
		// The shared server's agents (S-4237): only a daemon that runs the server spawns them.
		if s.life == nil || !s.life.HasOpenCode() {
			return nil, Errorf(http.StatusNotImplemented, "spawn: %s is not ported to the Go daemon yet", harness)
		}
	case "codex":
		return nil, Errorf(http.StatusNotImplemented, "spawn: %s is not ported to the Go daemon yet", harness)
	default:
		return nil, Errorf(http.StatusBadRequest, "unknown harness %s", harness)
	}
	parentRef := ""
	switch {
	case jsjson.Truthy(by) && !boss:
		parentRef = claude.JSString(by)
	case jsjson.Truthy(field("parent")):
		parentRef = claude.JSString(field("parent"))
	}
	var parentID *string
	parentName := humanBox
	if parentRef != "" {
		id, name, err := s.spawnParent(ctx, parentRef)
		if err != nil {
			return nil, err
		}
		parentID, parentName = &id, name
	}
	// The agent asking (its `by`, else the calling agent, else the parent) may give the new agent only an ITSA it may change
	// (S-480, S-2424); the human gives any.
	var via *itsaVia
	if !w.human {
		asker := ""
		switch {
		case jsjson.Truthy(by):
			asker = claude.JSString(by)
		case c.Kind == auth.Agent && c.Caller.Agent != "":
			asker = c.Caller.Agent
		case parentID != nil:
			asker = *parentID
		}
		if asker != "" {
			if a, err := s.db.GetAgent(ctx, asker); err == nil {
				asker = a.ID
			}
			via = &itsaVia{agent: asker, boss: s.chiefOfStaffID(ctx) == asker || s.isAssistant(ctx, asker)}
		}
	}
	// `itsa`: the new agent owns this ITSA and its first prompt says so.
	var owned *ownedItsa
	if v := field("itsa"); jsjson.Truthy(v) {
		if err := s.itsaGatePass(ctx); err != nil {
			return nil, spawnItsaErr(err)
		}
		review, _ := typ.Get("review")
		// A ring's members and moderator are marked `itsa_participant`, whatever their type.
		o, err := s.ownerBlock(ctx, claude.JSString(v), jsjson.Truthy(review) || field("itsa_participant") == true)
		if err == nil {
			err = s.mayAssign(ctx, o.id, via)
		}
		if err != nil {
			return nil, spawnItsaErr(err)
		}
		owned = &o
	}
	// `participate`: ITSAs the new agent joins as a participant, the owner unchanged (S-2424), checked before the agent exists.
	var participate []string
	if v := field("participate"); v != nil {
		list, ok := v.([]jsjson.Value)
		for _, r := range list {
			if t, isText := r.(string); !isText || t == "" {
				ok = false
			} else if !contains(participate, t) {
				participate = append(participate, t)
			}
		}
		if !ok {
			return nil, Errorf(http.StatusBadRequest, "participate is a list of ITSA ids or keys")
		}
	}
	if len(participate) > 0 {
		if err := s.itsaGatePass(ctx); err != nil {
			return nil, spawnItsaErr(err)
		}
		if err := s.mayParticipate(ctx, participate, via); err != nil {
			return nil, spawnItsaErr(err)
		}
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "spawn isn't available on this daemon")
	}
	base := ""
	if v := field("cwd"); v != nil {
		base = claude.JSString(v)
	}
	if base, err = absPath(base); err != nil {
		return nil, err
	}
	if st, err := os.Stat(base); err != nil || !st.IsDir() {
		return nil, Errorf(http.StatusBadRequest, "no directory %s", base)
	}
	// A personal workspace (S-894): a folder the agent keeps across archive, apart from its working directory. Its name
	// is checked before any worktree exists, so a bad name leaves nothing behind; the folder is made once the working
	// directory is settled.
	personalName := ""
	if v := field("workspace"); v != nil && v != false {
		personalName = name
		if v != true {
			personalName = claude.JSString(v)
		}
		if err := lifecycle.PersonalWorkspaceName(personalName); err != nil {
			return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
		}
		// One folder, one live holder: workspace_share is the sanctioned way to share it later.
		release, err := s.reservePersonal(ctx, personalName, lifecycle.PersonalWorkspacePath(s.cfg.Home, personalName))
		if err != nil {
			return nil, err
		}
		defer release()
	}
	// The workspace: the cwd, a worktree of its own (a type's default included), a script's directory, or the cwd with
	// instructions. A developer spawn holds a slot of the developer cap from before its worktree exists until its row
	// does, so a refusal leaves nothing behind.
	ws, err := spawnWorkspaceSpec(ctx, body, typ, base)
	if err != nil {
		return nil, err
	}
	spec := ws.tree
	if rv, _ := typ.Get("review"); spec != nil && !jsjson.Truthy(rv) {
		release, queued, err := s.reserveDeveloper(ctx, name, w, original, spawnerKey(c, body))
		if err != nil {
			return nil, err
		}
		if queued != nil {
			return queued, nil
		}
		defer release()
	}
	cwd := base
	var tree *lifecycle.CreatedWorktree
	if spec != nil {
		if tree, err = s.createWorktree(ctx, *spec, name); err != nil {
			return nil, err
		}
		cwd = tree.Cwd
		if hook := s.devSlots.afterTree; hook != nil {
			hook(name)
		}
	} else {
		if ws.script != "" {
			if cwd, err = lifecycle.RunWorkspaceScript(ctx, ws.script, base, name); err != nil {
				return nil, Errorf(http.StatusBadRequest, "workspace: %s", err.Error())
			}
		}
		// Read on the resolved cwd, so a script that printed the live checkout is caught too (S-627).
		if err := s.liveCheckoutRefusal(ctx, typ, cwd); err != nil {
			return nil, err
		}
	}
	// Until the agent's row holds the worktree, a failure removes it; after that it stays, as in TS, and the archive
	// removes it.
	dropTree := func() {
		if tree != nil {
			if err := lifecycle.RemoveCreated(context.WithoutCancel(ctx), tree); err != nil {
				slog.Error("spawn "+name+": couldn't remove its new worktree", "path", tree.Cwd, "err", err)
			}
		}
	}
	// The personal workspace folder, made 0700 when missing and kept when it exists: a respawned specialist adopts an
	// archived one's folder. A failure undoes the worktree.
	personal := ""
	if personalName != "" {
		if personal, err = lifecycle.CreatePersonalWorkspace(s.cfg.Home, personalName); err != nil {
			dropTree()
			return nil, Errorf(http.StatusBadRequest, "workspace: %s", err.Error())
		}
	}
	prompt := ""
	if v := field("prompt"); jsjson.Truthy(v) {
		prompt = claude.JSString(v)
	}
	if typ != nil {
		branch := ""
		if tree != nil {
			branch = tree.Worktree.Branch
		}
		vars := briefVars(field("brief_vars"))
		for k, v := range map[string]string{"task": prompt, "name": name, "type": typeName, "parent": parentName, "cwd": cwd, "branch": branch} {
			vars[k] = v
		}
		prompt, _ = renderBrief(typ, vars, func() string { return s.typeNextSteps(typeName) })
	}
	prompt = worktreeNotes(tree, name, prompt)
	if owned != nil {
		prompt = strings.Join(nonEmpty(owned.block, prompt), "\n\n")
	}
	if ws.instructions != "" {
		block, err := s.tpl.Render("workspace-instructions", map[string]string{"text": ws.instructions}, "")
		if err != nil {
			dropTree()
			return nil, err
		}
		prompt = strings.Join(nonEmpty(block, prompt), "\n\n")
	}
	id, err := s.db.NewAgentID(ctx)
	if err != nil {
		dropTree()
		return nil, err
	}
	session, err := newUUID()
	if err != nil {
		dropTree()
		return nil, err
	}
	optText := func(k string) *string {
		if v := field(k); jsjson.Truthy(v) {
			t := claude.JSString(v)
			return &t
		}
		return nil
	}
	role := ""
	if v := field("role"); v != nil {
		role = claude.JSString(v)
	}
	agent, err := s.db.CreateAgent(ctx, db.NewAgent{ID: id, Name: name, Role: role, Machine: s.cfg.Machine, Harness: harness,
		Model: optText("model"), Effort: optText("effort"), Cwd: cwd, ParentID: parentID, SessionID: &session})
	if err != nil {
		dropTree()
		return nil, err
	}
	if w.onCreated != nil {
		w.onCreated(agent.ID)
	}
	// Any failure from here on leaves the row stopped and errored, as TS's spawn does with a failed launch, rather than
	// starting with no harness until the starting timeout.
	failed := func(err error) error {
		if uerr := s.db.UpdateAgent(ctx, agent.ID, db.Field{Col: "lifecycle", Val: "shut_down"}, db.Field{Col: "activity", Val: "errored"},
			db.Field{Col: "activity_detail", Val: "launch failed: " + err.Error()}); uerr != nil {
			return uerr
		}
		return err
	}
	if boss && (isCos || jsjson.Truthy(field("chief_of_staff"))) {
		if err := s.settings.SetShared("chiefOfStaff", name); err != nil {
			dropTree()
			return nil, failed(err)
		}
	}
	if hook := s.devSlots.beforeStore; hook != nil {
		if err := hook(name); err != nil {
			dropTree()
			return nil, failed(err)
		}
	}
	fields, err := s.spawnFields(w, body, set, harness, agent, workspaceJSON(base, cwd, ws, tree), personal, prompt, typ, typeName)
	if err != nil {
		dropTree()
		return nil, failed(err)
	}
	if err := s.db.UpdateAgent(ctx, agent.ID, fields...); err != nil {
		dropTree()
		return nil, failed(err)
	}
	// The first prompt is stored now; first-prompt:delivered says it went in (S-759).
	if prompt != "" {
		if err := s.db.AddEvent(ctx, agent.ID, "first-prompt:pending", nil); err != nil {
			return nil, failed(err)
		}
	}
	// Where the branch was cut from and how the fetch went (S-1666), so a stale fallback is visible.
	if tree != nil && tree.BaseUsed != nil {
		if err := s.db.AddEvent(ctx, agent.ID, "workspace:base", json.RawMessage(jsjson.Stringify(baseUsedJSON(tree.BaseUsed), ""))); err != nil {
			return nil, failed(err)
		}
	}
	// The rule blockers its account carries now, so a spawn onto a blocked account starts held (src/rules.ts
	// attachSpawn).
	if err := s.life.AttachSpawn(ctx, agent); err != nil {
		return nil, failed(err)
	}
	// A spawn onto a spent budget starts held by its budget blocker: the Go daemon has no spawn refusal (src/admission.ts
	// admitSpawn, S-3545), so every spawn gets what a forced one does in TS (src/budgets.ts attachSpawn).
	s.life.AttachBudget(ctx, agent)
	// A tree paused for cost holds an agent spawned into it too; its first prompt waits until the pause clears
	// (src/cost-pause.ts attachSpawn).
	if err := s.life.AttachPause(ctx, agent); err != nil {
		return nil, failed(err)
	}
	if err := s.spawnJoin(ctx, agent, owned, participate, parentID, by, w.human, via, prompt, failed); err != nil {
		return nil, err
	}
	if agent, err = s.db.GetAgent(ctx, agent.ID); err != nil {
		return nil, err
	}
	return spawnView{Agent: agent, View: viewOf(agent)}, nil
}

// spawnJoin is the end of spawnAgentIn: the new agent takes its owned ITSA, else joins its parent's open ITSA, joins the
// `participate` ITSAs, and starts. A failure leaves the agent errored (failed), gives the ITSA back to its previous owner
// while the agent still owns it, and undoes the joins this spawn made (S-2441).
func (s *Server) spawnJoin(ctx context.Context, agent db.Agent, owned *ownedItsa, participate []string, parentID *string, by jsjson.Value, human bool, via *itsaVia, prompt string, failed func(error) error) error {
	actor := agent.ID
	switch {
	case jsjson.Truthy(by):
		actor = claude.JSString(by)
	case human:
		actor = humanBox
	}
	joinBy := actor
	if via != nil {
		joinBy = via.agent
	}
	var joins []string
	// parentJoin is the parent's ITSA joined, its key once the join has settled (nil when none was started).
	var parentJoin func() string
	assigned := false
	start := func() error {
		if owned != nil && owned.participant {
			// src/itsa-owners.ts attachSpawned: a reviewer joins as a participant, and the owner stays (S-501).
			joins = append(joins, owned.id)
			if err := s.joinItsa(ctx, owned.id, agent.ID, joinBy, via); err != nil {
				return err
			}
		} else if owned != nil {
			joins = append(joins, owned.id)
			prev, err := s.assignOwner(ctx, owned.id, agent.ID, joinBy, nil, via)
			if err != nil {
				return err
			}
			owned.owner, assigned = prev, true
		} else if parentID != nil && s.settings.Get().Itsa.Required {
			// A failed join is logged only; it never fails the spawn. Off the home it runs in the background, so a slow or
			// unreachable home never holds the spawn (the CLI has a 10 s deadline; a home call waits up to 8 s).
			join := func(ctx context.Context) string {
				key, err := s.joinParentItsa(ctx, agent.ID, *parentID, actor)
				if err != nil {
					slog.Error("ITSA: "+agent.Name+" couldn't join its parent's ITSA", "err", err)
				}
				return key
			}
			if s.isHome() {
				key := join(ctx)
				parentJoin = func() string { return key }
			} else {
				done, key := make(chan struct{}), ""
				s.background(ctx, func(ctx context.Context) { defer close(done); key = join(ctx) })
				parentJoin = func() string { <-done; return key }
			}
		}
		for _, ref := range participate {
			joins = append(joins, ref)
			if err := s.joinItsa(ctx, ref, agent.ID, joinBy, via); err != nil {
				return err
			}
		}
		a, err := s.db.GetAgent(ctx, agent.ID)
		if err != nil {
			return err
		}
		return s.life.StartHarness(ctx, a, prompt, false, "spawn")
	}
	err := start()
	if err == nil {
		return nil
	}
	err = failed(err)
	// The agent never ran: the ITSA goes back to its previous owner, if it is still the agent's.
	if owned != nil && assigned {
		if _, rerr := s.restoreOwner(ctx, owned.id, agent.ID, owned.owner, actor); rerr != nil {
			slog.Error("ITSA "+owned.key+": couldn't restore its owner", "err", rerr)
		}
	}
	// Off the home the undo is not awaited: a slow or dead home must not hold the spawn's own error.
	undo := func(ctx context.Context) { s.undoJoins(ctx, agent.ID, joins, parentJoin, actor, via) }
	if s.isHome() {
		undo(ctx)
	} else {
		s.background(ctx, undo)
	}
	return err
}

// nonEmpty is [..].filter(Boolean) for texts.
func nonEmpty(texts ...string) []string {
	out := make([]string, 0, len(texts))
	for _, t := range texts {
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

// spawnFields is the columns spawnAgent sets after it creates the row, in its order.
func (s *Server) spawnFields(w write, body *jsjson.Object, set config.Settings, harness string, a db.Agent, workspace, personal, prompt string, typ *jsjson.Object, typeName string) ([]db.Field, error) {
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	standing := 0
	_, hasStanding := body.Get("standing")
	if field("standing") == true || (!hasStanding && typ != nil && func() bool { v, _ := typ.Get("standing"); return v == true }()) {
		standing = 1
	}
	model := ""
	if a.Model != nil {
		model = *a.Model
	}
	caps, err := s.life.Capabilities(harness, model)
	if err != nil {
		return nil, err
	}
	// The mode comes from Settings › permission modes (S-1967); only the human picks another, which then stays.
	fromSettings := set.PermissionModes.EffectiveMode(harness, typeName)
	mode, source := fromSettings, "settings"
	if picked, ok := field("permission_mode").(string); ok && w.human && config.IsPermissionMode(picked) && picked != fromSettings {
		mode, source = picked, "manual"
	}
	var visibility any
	if v, ok := field("visibility").(*jsjson.Object); ok {
		visibility = jsjson.Stringify(v, "")
	} else if arr, ok := field("visibility").([]jsjson.Value); ok {
		visibility = jsjson.Stringify(arr, "")
	}
	notices := set.ChildNotices
	if n, ok := field("child_notices").(string); ok && (n == "turn" || n == "tree-idle" || n == "none") {
		notices = n
	}
	// Only the human spawns the assistant.
	var kind any
	if field("kind") == "assistant" && w.human {
		kind = "assistant"
	}
	var firstPrompt any
	if prompt != "" {
		firstPrompt = prompt
	}
	return []db.Field{
		{Col: "workspace", Val: workspace}, {Col: "personal_workspace", Val: textOrNil(personal)}, {Col: "standing", Val: standing},
		{Col: "capabilities", Val: caps}, {Col: "permission_mode", Val: mode}, {Col: "permission_source", Val: source},
		{Col: "visibility", Val: visibility}, {Col: "child_notices", Val: notices}, {Col: "kind", Val: kind}, {Col: "type", Val: textOrNil(typeName)},
		{Col: "first_prompt", Val: firstPrompt},
	}, nil
}

// expandHome is the spawn default cwd's `~` (src/daemon.ts: /^~(?=$|\/)/).
func expandHome(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	return home + p[1:]
}

// absPath is node's path.resolve of one path: against the daemon's working directory, cleaned.
func absPath(p string) (string, error) {
	if filepath.IsAbs(p) {
		return filepath.Clean(p), nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(wd, p), nil
}

// newUUID is crypto.randomUUID: a random version 4 UUID.
func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// pushStream is GET /api/agents/:id/stream: the push stream the agent's `stam mcp` shim reads its prompts from. TS lets
// the agent's ancestors, the chief of staff and the assistant open it too (agent-routes.ts `acting`); here an agent's
// token opens only its own, so a prompt counts as pushed only when a stream of the agent itself took it.
func (s *Server) pushStream(w http.ResponseWriter, r *http.Request, c auth.Resolved) error {
	ctx := r.Context()
	id := r.PathValue("id")
	if !agentRef.MatchString(id) {
		return Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	if err := s.mayActAs(ctx, c.Caller, id, true); err != nil {
		return err
	}
	a, err := s.mustAgent(ctx, id)
	if err != nil {
		return err
	}
	if s.life == nil || !s.life.ServeStream(w, r, a.ID) {
		return Errorf(http.StatusNotImplemented, "push streams aren't available on this daemon")
	}
	return nil
}
