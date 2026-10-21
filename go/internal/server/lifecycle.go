package server

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
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
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
)

// The agent lifecycle routes (S-2820): spawn, show, events, kill and forget, and the Claude Code hook and status-line
// reports, with the paths, request and response shapes, and auth of src/daemon.ts.

// agentShow is GET /api/agents/:id (src/daemon.ts): publicAgent's columns, then blockers, waits, resting and view.
// Placeholders until their modules are ported, as in the list: blockers are empty, resting null.
type agentShow struct {
	db.Agent
	Blockers []api.AgentBlocker `json:"blockers"`
	Waits    []api.AgentWait    `json:"waits"`
	Resting  *api.AgentResting  `json:"resting"`
	View     *viewCaps          `json:"view"`
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
	return agentShow{Agent: a, Blockers: []api.AgentBlocker{}, Waits: waits, View: viewOf(a)}, nil
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

type controlReply struct {
	Agent  *db.Agent `json:"agent,omitempty"`
	Result string    `json:"result"`
}

// controlAgent is POST /api/agents/:id/(shutdown|resume|restart|compact|kill|forget), the agent-control actions
// ported. An agent may control itself and its children; the human (no `by`) and the assistant control all, and alone
// kill and forget. kill stops the harness at once (explicitShutdown with now); forget removes a stopped agent. A
// failure is a 409 with its message, as src/daemon.ts control answers. Not ported, a 501: a compact with a prompt
// (its compacted-self note needs the context history and lessons). Nor is a peer's agent controlling one here.
func (s *Server) controlAgent(action string) handler {
	return func(r *http.Request, c auth.Resolved) (any, error) {
		ctx := r.Context()
		w, err := s.readWrite(r, c)
		if err != nil {
			return nil, err
		}
		a, err := s.mustAgent(ctx, r.PathValue("id"))
		if err != nil {
			return nil, err
		}
		by, _ := w.body.Get("by")
		boss, err := s.controlBoss(ctx, c, w, by)
		if err != nil {
			return nil, err
		}
		if !boss && (action == "kill" || action == "forget") {
			return nil, Errorf(http.StatusForbidden, "only the human and the assistant may %s", action)
		}
		if !boss {
			byID, _ := by.(string)
			isParent := false
			if jsjson.Truthy(by) {
				parents, err := s.db.ParentsOf(ctx, a)
				if err != nil {
					return nil, err
				}
				for _, p := range parents {
					isParent = isParent || p == byID
				}
			}
			if !(by != nil && byID == a.ID) && !isParent {
				who := "no one"
				if by != nil {
					who = claude.JSString(by)
				}
				return nil, Errorf(http.StatusForbidden, "%s may control only itself and its children", who)
			}
		}
		if s.life == nil {
			return nil, Errorf(http.StatusNotImplemented, "agent control isn't available on this daemon")
		}
		// `String(body.x ?? fallback)`.
		str := func(key, fallback string) string {
			if v, _ := w.body.Get(key); v != nil {
				return claude.JSString(v)
			}
			return fallback
		}
		truthy := func(key string) bool { v, _ := w.body.Get(key); return jsjson.Truthy(v) }
		var result string
		switch action {
		case "shutdown":
			if truthy("now") {
				err = s.life.Shutdown(ctx, a)
				result = "done"
			} else {
				result, err = s.life.GracefulShutdown(ctx, a)
			}
		case "resume":
			result, err = s.life.Resume(ctx, a, str("note", ""))
		case "restart":
			result, err = s.life.Restart(ctx, a, str("reason", "requested"))
		case "compact":
			if truthy("prompt") {
				return nil, Errorf(http.StatusNotImplemented, "compact: a prompt to send after the compaction is not ported to the Go daemon yet")
			}
			instructions := ""
			if truthy("instructions") {
				instructions = str("instructions", "")
			}
			reason := "requested"
			if jsjson.Truthy(by) {
				reason = "requested by the agent"
			}
			result, err = s.life.RequestCompaction(ctx, a, instructions, reason)
		case "kill":
			err = s.life.Shutdown(ctx, a)
			result = "stopped"
		case "forget":
			result, err = s.life.Forget(ctx, a)
		}
		var unported lifecycle.ErrNotPorted
		if errors.As(err, &unported) {
			return nil, Errorf(http.StatusNotImplemented, "%s: %s", action, err.Error())
		}
		if err != nil {
			return nil, Errorf(http.StatusConflict, "%s", err.Error())
		}
		reply := controlReply{Result: result}
		if now, err := s.db.GetAgent(ctx, a.ID); err == nil {
			reply.Agent = &now
		}
		return reply, nil
	}
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
	return (!named && (w.human || peerOwn || !s.settings.Get().Auth.HumanStrict)) || assistant, nil
}

type hookReply struct {
	Stdout *string `json:"stdout,omitempty"`
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
	stdout, err := s.life.OnHook(ctx, harness, a, payload)
	if _, ok := err.(lifecycle.ErrNoHooks); ok {
		return nil, Errorf(http.StatusNotImplemented, "%s", err.Error())
	}
	if err != nil {
		return nil, err
	}
	return hookReply{Stdout: stdout}, nil
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
	"permission_mode": true,
}

// spawnView is the spawn's reply: the agent's row, then its view capabilities (S-173).
type spawnView struct {
	db.Agent
	View *viewCaps `json:"view"`
}

// spawn is POST /api/agents (src/daemon.ts spawnAgent) for a Claude Code agent in an existing directory: the agent
// row, its token, the launch, the tmux session, and the first prompt typed in once the harness is up.
//
// Not yet ported, each refused with a 501 when the body asks for it: agent types and presets (and the default preset
// a spawn with no harness, model or type gets), ITSAs (and, under settings.itsa.required, the parent's ITSA a spawn
// with a parent joins), worktrees and workspace scripts, personal workspaces, rings, spawns on another machine, the
// developer slot queue, cost admission, a free name for a nameless spawn, Codex and OpenCode. Not yet ported either:
// opening the mail threads the prompt cites to the new agent (grantCitedThreads), and the cost pauses a new agent
// inherits. A parent on another machine is no agent here.
func (s *Server) spawn(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	set := s.settings.Get()
	by := field("by")
	if !jsjson.Truthy(by) && set.Auth.HumanStrict && !w.human && !(w.local && c.Kind == auth.Shared) && c.Kind != auth.Agent {
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
	if !jsjson.Truthy(field("harness")) && !jsjson.Truthy(field("model")) && set.SpawnDefaults.Preset != nil && *set.SpawnDefaults.Preset != "" {
		return nil, Errorf(http.StatusNotImplemented, "spawn: the default preset is not ported to the Go daemon yet; name a harness or model")
	}
	if !jsjson.Truthy(field("cwd")) && set.SpawnDefaults.Cwd != nil && *set.SpawnDefaults.Cwd != "" {
		body.Set("cwd", expandHome(*set.SpawnDefaults.Cwd))
	}
	name := ""
	if v := field("name"); v != nil {
		name = jsjson.Trim(claude.JSString(v))
	}
	if name == "" {
		return nil, Errorf(http.StatusNotImplemented, "spawn: a free name is not ported to the Go daemon yet; name the agent")
	}
	if !nameRe.MatchString(name) {
		return nil, Errorf(http.StatusBadRequest, "name must be lowercase letters, digits, and dashes")
	}
	if _, err := s.db.GetAgent(ctx, name); err == nil {
		return nil, Errorf(http.StatusConflict, "name %s is taken", name)
	}
	harness := "claude"
	if v := field("harness"); v != nil {
		harness = claude.JSString(v)
	}
	switch harness {
	case "claude":
	case "codex", "opencode":
		return nil, Errorf(http.StatusNotImplemented, "spawn: %s is not ported to the Go daemon yet", harness)
	default:
		return nil, Errorf(http.StatusBadRequest, "unknown harness %s", harness)
	}
	assistant := false
	if jsjson.Truthy(by) {
		assistant = s.isAssistant(ctx, claude.JSString(by))
	}
	boss := w.human || assistant
	parentRef := ""
	switch {
	case jsjson.Truthy(by) && !boss:
		parentRef = claude.JSString(by)
	case jsjson.Truthy(field("parent")):
		parentRef = claude.JSString(field("parent"))
	}
	var parentID *string
	if parentRef != "" {
		p, err := s.db.GetAgent(ctx, parentRef)
		if err != nil {
			return nil, Errorf(http.StatusNotFound, "no agent %s", parentRef)
		}
		parentID = &p.ID
		// TS joins the new agent to its parent's open ITSA; the Go daemon can't yet, so it doesn't spawn without it.
		if set.Itsa.Required {
			return nil, Errorf(http.StatusNotImplemented, "spawn: joining the parent's ITSA (settings.itsa.required) is not ported to the Go daemon yet")
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
	prompt := ""
	if v := field("prompt"); jsjson.Truthy(v) {
		prompt = claude.JSString(v)
	}
	id, err := s.db.NewAgentID(ctx)
	if err != nil {
		return nil, err
	}
	session, err := newUUID()
	if err != nil {
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
		Model: optText("model"), Effort: optText("effort"), Cwd: base, ParentID: parentID, SessionID: &session})
	if err != nil {
		return nil, err
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
	fields, err := s.spawnFields(w, body, set, harness, agent, base, prompt)
	if err != nil {
		return nil, failed(err)
	}
	if err := s.db.UpdateAgent(ctx, agent.ID, fields...); err != nil {
		return nil, failed(err)
	}
	// The first prompt is stored now; first-prompt:delivered says it went in (S-759).
	if prompt != "" {
		if err := s.db.AddEvent(ctx, agent.ID, "first-prompt:pending", nil); err != nil {
			return nil, failed(err)
		}
	}
	if agent, err = s.db.GetAgent(ctx, agent.ID); err != nil {
		return nil, failed(err)
	}
	if err := s.life.StartHarness(ctx, agent, prompt, false, "spawn"); err != nil {
		return nil, failed(err)
	}
	if agent, err = s.db.GetAgent(ctx, agent.ID); err != nil {
		return nil, err
	}
	return spawnView{Agent: agent, View: viewOf(agent)}, nil
}

// spawnFields is the columns spawnAgent sets after it creates the row, in its order.
func (s *Server) spawnFields(w write, body *jsjson.Object, set config.Settings, harness string, a db.Agent, base, prompt string) ([]db.Field, error) {
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	workspace := jsjson.Stringify(jsjson.NewObject("spec", jsjson.NewObject("kind", "dir", "path", base), "cwd", base), "")
	standing := 0
	if field("standing") == true {
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
	fromSettings := set.PermissionModes.EffectiveMode(harness, "")
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
	var firstPrompt any
	if prompt != "" {
		firstPrompt = prompt
	}
	return []db.Field{
		{Col: "workspace", Val: workspace}, {Col: "personal_workspace", Val: nil}, {Col: "standing", Val: standing},
		{Col: "capabilities", Val: caps}, {Col: "permission_mode", Val: mode}, {Col: "permission_source", Val: source},
		{Col: "visibility", Val: visibility}, {Col: "child_notices", Val: notices}, {Col: "kind", Val: nil}, {Col: "type", Val: nil},
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
