package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/peers"
)

// The agent-control route, POST /api/agents/:id/ACTION (src/daemon.ts, S-3746), and the routes beside it: the human's
// permission mode for one agent, a peer's archive cascade, and the human's default view.
//
// Who may call an action: the agent itself and its parents; the human (no `by`, under auth.humanStrict only the human
// or a peer's own call) and the assistant control every agent, and alone set-parent, rename, chief-of-staff, kill and
// forget; the chief of staff, here or vouched for by a peer, may also adopt. A failure inside the action is a 409 with
// its message, as src/daemon.ts control answers; what the Go daemon can't do yet is a 501.

// controlActions are the actions the route serves.
var controlActions = []string{"pause", "unpause", "shutdown", "archive", "resume", "restart", "reconnect-mcp", "compact", "adopt",
	"set-visibility", "set-child-notices", "set-parent", "rename", "chief-of-staff", "kill", "forget"}

// bossOnly are the actions only the human and the assistant may take.
var bossOnly = map[string]bool{"set-parent": true, "rename": true, "chief-of-staff": true, "kill": true, "forget": true}

func (s *Server) controlRoutes() {
	for _, action := range controlActions {
		s.handle("POST /api/agents/{id}/"+action, agentPath(s.controlAgent(action)))
	}
	s.handle("POST /api/agents/{id}/permission-mode", agentPath(s.permissionMode))
	s.handle("POST /api/archive-children", s.archiveChildren)
	s.handle("PUT /api/agents/{id}/default-view", agentPath(s.defaultView))
}

type controlReply struct {
	Agent  *db.Agent `json:"agent,omitempty"`
	Result string    `json:"result"`
}

// controlAgent is the route of one action.
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
		byID, _ := by.(string)
		boss, err := s.controlBoss(ctx, c, w, by)
		if err != nil {
			return nil, err
		}
		// A peer's forwarded agent isn't in this database: the peer vouches for it, and says whether it is its chief of
		// staff (S-410).
		remote := false
		if c.IsAgent() && w.local && jsjson.Truthy(by) && byID == c.Agent {
			_, gerr := s.db.GetAgent(ctx, byID)
			remote = errors.Is(gerr, db.ErrNotFound)
		}
		if !boss && bossOnly[action] {
			return nil, Errorf(http.StatusForbidden, "only the human and the assistant may %s", action)
		}
		if !boss {
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
			isCos := jsjson.Truthy(by) && ((byID != "" && s.chiefOfStaffID(ctx) == byID) || (remote && c.Boss))
			if !(by != nil && byID == a.ID) && !isParent && !(isCos && action == "adopt") {
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
		result, err := s.control(ctx, a, action, w.body, by, remote)
		var unported lifecycle.ErrNotPorted
		var he *Error
		switch {
		case errors.As(err, &unported):
			return nil, Errorf(http.StatusNotImplemented, "%s: %s", action, err.Error())
		case errors.As(err, &he) && (he.Status == http.StatusNotImplemented || he.Status == http.StatusNotFound):
			return nil, err
		case err != nil:
			return nil, Errorf(http.StatusConflict, "%s", err.Error())
		}
		reply := controlReply{Result: result}
		if now, err := s.db.GetAgent(ctx, a.ID); err == nil {
			reply.Agent = &now
		}
		return reply, nil
	}
}

// control is src/daemon.ts control: the action on a, after the route's checks.
func (s *Server) control(ctx context.Context, a db.Agent, action string, body *jsjson.Object, by jsjson.Value, remote bool) (string, error) {
	field := func(k string) jsjson.Value { v, _ := body.Get(k); return v }
	// `String(body.x ?? fallback)`.
	str := func(key, fallback string) string {
		if v := field(key); v != nil {
			return claude.JSString(v)
		}
		return fallback
	}
	truthy := func(key string) bool { return jsjson.Truthy(field(key)) }
	switch action {
	case "pause", "unpause":
		// The human or a manager pausing or unpausing the agent acts on its cost notices, so their fallbacks don't run.
		who := str("by", humanName)
		whoID := who
		if who != humanName {
			if b, err := s.db.GetAgent(ctx, who); err == nil {
				whoID = b.ID
			}
		}
		if err := s.life.AckAsManager(ctx, a, whoID, action); err != nil {
			return "", err
		}
		if action == "pause" {
			return s.life.Pause(ctx, a, who)
		}
		return s.life.Unpause(ctx, a, who, truthy("force"))
	case "shutdown", "kill":
		// The shutdown and kill actions end the agent's cost fallbacks too (src/lifecycle.ts explicitShutdown, S-2458).
		if err := s.life.CancelFallbacks(ctx, a.ID, "the agent was shut down"); err != nil {
			return "", err
		}
		if action == "kill" || truthy("now") {
			if err := s.life.Shutdown(ctx, a); err != nil {
				return "", err
			}
			if action == "kill" {
				return "stopped", nil
			}
			return "done", nil
		}
		return s.life.GracefulShutdown(ctx, a)
	case "archive":
		// An omitted discard keeps force's implication; an explicit false forbids it (S-1043 review).
		o := lifecycle.ArchiveOpts{Force: truthy("force"), ForceUnpushed: truthy("force_unpushed")}
		o.Discard = o.Force
		if v, ok := body.Get("discard"); ok {
			o.Discard = jsjson.Truthy(v)
		}
		return s.life.ArchiveCascade(ctx, a, o, s.remoteCascade)
	case "resume":
		return s.life.Resume(ctx, a, str("note", ""))
	case "restart":
		return s.life.Restart(ctx, a, str("reason", "requested"))
	case "reconnect-mcp":
		return s.life.ReconnectMCP(ctx, a, truthy("whenIdle"))
	case "compact":
		instructions := ""
		if truthy("instructions") {
			instructions = str("instructions", "")
		}
		reason := "requested"
		if jsjson.Truthy(by) {
			reason = "requested by the agent"
		}
		if truthy("prompt") {
			return s.life.RequestCompactionNote(ctx, a, instructions, str("prompt", ""), reason)
		}
		return s.life.RequestCompaction(ctx, a, instructions, reason)
	case "adopt":
		return s.adopt(ctx, a, body, remote)
	case "set-visibility":
		v := field("visibility")
		switch v.(type) {
		case *jsjson.Object, []jsjson.Value:
		default:
			return "", errors.New("set-visibility needs a visibility object")
		}
		if err := s.db.UpdateAgent(ctx, a.ID, db.Field{Col: "visibility", Val: jsjson.Stringify(v, "")}); err != nil {
			return "", err
		}
		return "visibility set; it applies to mail now and to its system prompt at its next restart", nil
	case "set-child-notices":
		v := str("child_notices", "")
		if v != "turn" && v != "tree-idle" && v != "none" {
			return "", errors.New("child notices must be turn, tree-idle, or none")
		}
		if err := s.db.UpdateAgent(ctx, a.ID, db.Field{Col: "child_notices", Val: v}); err != nil {
			return "", err
		}
		if err := s.db.AddEvent(ctx, a.ID, "child-notices", struct {
			Value string `json:"value"`
		}{v}); err != nil {
			return "", err
		}
		return fmt.Sprintf("child notices set to %s; it applies now and to %s's prompt at its next restart", v, a.Name), nil
	case "set-parent":
		return s.setParent(ctx, a, field("parent"), str("by", humanName))
	case "rename":
		return s.rename(ctx, a, jsjson.Trim(str("name", "")))
	case "chief-of-staff":
		if err := s.settings.SetShared("chiefOfStaff", a.Name); err != nil {
			return "", err
		}
		return a.Name + " is the chief of staff; it takes the role in its prompt at its next restart", nil
	case "forget":
		return s.life.Forget(ctx, a)
	}
	return "", Errorf(http.StatusNotFound, "no action %s", action)
}

type adoptedEvent struct {
	By any `json:"by"`
}

// adopt is control's adopt: the adopting agent (by, else parent) becomes a parent of a. A chief of staff on another
// machine (remoteParent) is stored by id only.
func (s *Server) adopt(ctx context.Context, a db.Agent, body *jsjson.Object, remote bool) (string, error) {
	parent, ok := body.Get("by")
	if !ok || parent == nil {
		parent, _ = body.Get("parent")
	}
	if rp, _ := body.Get("remoteParent"); (remote || jsjson.Truthy(rp)) && jsjson.Truthy(parent) {
		id := claude.JSString(parent)
		if err := s.db.AddParent(ctx, a.ID, id); err != nil {
			return "", err
		}
		if err := s.db.AddEvent(ctx, a.ID, "adopted", adoptedEvent{By: parent}); err != nil {
			return "", err
		}
		return id + " is now a parent of " + a.Name, nil
	}
	var p db.Agent
	err := db.ErrNotFound
	if jsjson.Truthy(parent) {
		p, err = s.db.GetAgent(ctx, claude.JSString(parent))
	}
	if err != nil {
		return "", errors.New("adopt needs the adopting agent")
	}
	if err := s.db.AddParent(ctx, a.ID, p.ID); err != nil {
		return "", err
	}
	if err := s.db.AddEvent(ctx, a.ID, "adopted", adoptedEvent{By: parent}); err != nil {
		return "", err
	}
	// The adopting parent now has a descendant to wait on, if it is busy.
	s.life.SyncChildrenWaits(ctx, a.ID)
	return p.Name + " is now a parent of " + a.Name, nil
}

type parentsSetEvent struct {
	Parents []string `json:"parents"`
	By      string   `json:"by"`
}

// setParent is control's set-parent: every parent is resolved before anything is written, so a refused name leaves the
// registry as it was.
func (s *Server) setParent(ctx context.Context, a db.Agent, v jsjson.Value, by string) (string, error) {
	var refs []jsjson.Value
	switch x := v.(type) {
	case nil:
	case []jsjson.Value:
		refs = x
	default:
		refs = []jsjson.Value{x}
	}
	parents := []string{}
	for _, ref := range refs {
		if !jsjson.Truthy(ref) || ref == "none" {
			continue
		}
		id, err := s.localParentID(ctx, claude.JSString(ref))
		if err != nil {
			return "", err
		}
		parents = append(parents, id)
	}
	for _, p := range parents {
		if p == a.ID {
			return "", fmt.Errorf("%s can't be its own parent", a.Name)
		}
	}
	before, err := s.db.ParentsOf(ctx, a)
	if err != nil {
		return "", err
	}
	if err := s.db.SetParents(ctx, a.ID, parents, parentsSetEvent{Parents: parents, By: by}); err != nil {
		return "", err
	}
	// Children waits follow the new tree; a former parent may have lost its last busy descendant.
	s.life.SyncChildrenWaits(ctx, a.ID)
	for _, p := range before {
		s.life.SyncChildrenWaits(ctx, p)
	}
	if len(parents) == 0 {
		return a.Name + " is now top-level", nil
	}
	names := make([]string, len(parents))
	for i, p := range parents {
		names[i] = p
		if b, err := s.db.GetAgent(ctx, p); err == nil {
			names[i] = b.Name
		}
	}
	return fmt.Sprintf("%s now reports to %s", a.Name, joinComma(names)), nil
}

func joinComma(list []string) string {
	out := ""
	for i, x := range list {
		if i > 0 {
			out += ", "
		}
		out += x
	}
	return out
}

// localParentID is src/daemon.ts localParentId: the id of an agent here; one on a peer is refused, since a parent on
// another machine can't be set.
func (s *Server) localParentID(ctx context.Context, ref string) (string, error) {
	if a, err := s.db.GetAgent(ctx, ref); err == nil {
		return a.ID, nil
	}
	hit, found, err := s.peers.Locate(ctx, s.db, ref)
	if err != nil || found != peers.Found || hit == nil || hit.Peer == nil {
		return "", fmt.Errorf("no agent %s", ref)
	}
	machine := hit.Peer.Name
	return "", fmt.Errorf("%s runs on %s; cross-machine parents are unsupported. Name a parent on %s, such as the chief of staff, or respawn the child on %s under %s", ref, machine, s.cfg.Machine, machine, ref)
}

// rename is control's rename: the name checked and written in one transaction, the chief of staff setting following
// it, and a running agent told.
func (s *Server) rename(ctx context.Context, a db.Agent, name string) (string, error) {
	if !nameRe.MatchString(name) {
		return "", errors.New("name must be lowercase letters, digits, and dashes")
	}
	from, err := s.db.RenameAgent(ctx, a.ID, name)
	if errors.Is(err, db.ErrNameTaken) {
		return "", fmt.Errorf("name %s is taken", name)
	}
	if err != nil {
		return "", err
	}
	if s.settings.Get().ChiefOfStaff == from {
		if err := s.settings.SetShared("chiefOfStaff", name); err != nil {
			return "", err
		}
	}
	if a.Lifecycle == "active" || a.Lifecycle == "paused" {
		s.life.QueueNotice(ctx, a.ID, fmt.Sprintf("[stam] You were renamed from %s to %s; your id %s stays.", from, name, a.ID), true)
	}
	return from + " is now " + name, nil
}

type cascadeBody struct {
	Parents  []string `json:"parents"`
	Fallback []string `json:"fallback"`
}

// remoteCascade asks every peer to cascade over the children it holds of parents (S-1378); a peer that doesn't answer
// is reported, not skipped.
func (s *Server) remoteCascade(ctx context.Context, parents, fallback []string) []lifecycle.RemoteAnswer {
	ps := s.peers.Peers()
	out := make([]lifecycle.RemoteAnswer, len(ps))
	done := make(chan struct{}, len(ps))
	for i, p := range ps {
		go func() {
			defer func() { done <- struct{}{} }()
			out[i].Machine = p.Name
			r, err := s.peers.Call(ctx, p, "POST", "/api/archive-children", cascadeBody{Parents: parents, Fallback: nonNilList(fallback)}, 30*time.Second, false, nil)
			if err != nil {
				out[i].Error = err.Error()
				return
			}
			if r.Status != http.StatusOK {
				out[i].Error = fmt.Sprintf("status %d", r.Status)
				return
			}
			raw, err := json.Marshal(r.Data)
			var rep lifecycle.CascadeReport
			if err == nil {
				err = json.Unmarshal(raw, &rep)
			}
			if err != nil {
				out[i].Error = err.Error()
				return
			}
			out[i].Report = &rep
		}()
	}
	for range ps {
		<-done
	}
	return out
}

func nonNilList(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// archiveChildren is POST /api/archive-children: a peer's cascade over the children this machine holds of an archived
// agent (S-1378). Only a peer's own call runs it.
func (s *Server) archiveChildren(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.local || c.IsAgent() {
		return nil, Errorf(http.StatusForbidden, "only a peer runs the archive cascade this way")
	}
	list := func(key string, keepEmpty bool) []string {
		out := []string{}
		v, _ := w.body.Get(key)
		arr, _ := v.([]jsjson.Value)
		for _, x := range arr {
			if s := claude.JSString(x); s != "" || keepEmpty {
				out = append(out, s)
			}
		}
		return out
	}
	parents := list("parents", false)
	if len(parents) == 0 {
		return nil, Errorf(http.StatusBadRequest, "parent ids are needed")
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "agent control isn't available on this daemon")
	}
	rep, err := s.life.CascadeForPeer(r.Context(), parents, list("fallback", true))
	var unported lifecycle.ErrNotPorted
	if errors.As(err, &unported) {
		return nil, Errorf(http.StatusNotImplemented, "%s", err.Error())
	}
	return rep, err
}

// permissionMode is POST /api/agents/:id/permission-mode: the human's pick of one agent's permission mode (S-1967).
// Bypass is a privilege, so only the human's own proof counts, never x-stam-human alone.
func (s *Server) permissionMode(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if err := s.humanOnly(r, "set permission modes, from the web UI"); err != nil {
		return nil, err
	}
	a, err := s.mustAgent(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "agent control isn't available on this daemon")
	}
	mode, _ := w.body.Get("mode")
	// The switch's restart, and its restore, outlive the request, as in applyPermissionModes.
	ctx = context.WithoutCancel(ctx)
	result, err := s.life.SetPermissionMode(ctx, a, mode, humanName, "manual", false)
	if err != nil {
		return nil, err
	}
	reply := controlReply{Result: result}
	if now, err := s.db.GetAgent(ctx, a.ID); err == nil {
		reply.Agent = &now
	}
	return reply, nil
}

type defaultViewReply struct {
	AgentID     string  `json:"agent_id"`
	DefaultView *string `json:"default_view"`
}

// defaultView is PUT /api/agents/:id/default-view: the view the human's web UI opens an agent in (S-82), terminal or
// conversation, or null for Settings' default. Any agent the UI lists, a peer's included, so the id isn't looked up.
func (s *Server) defaultView(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !s.isHuman(r, c) {
		return nil, Errorf(http.StatusForbidden, "only the human sets an agent's default view")
	}
	var view *string
	if v, _ := w.body.Get("view"); v != nil {
		t, ok := v.(string)
		if !ok || (t != "terminal" && t != "conversation") {
			return nil, Errorf(http.StatusBadRequest, "view must be terminal, conversation, or null")
		}
		view = &t
	}
	id := r.PathValue("id")
	if err := s.db.SetAgentView(r.Context(), id, view); err != nil {
		return nil, err
	}
	return defaultViewReply{AgentID: id, DefaultView: view}, nil
}
