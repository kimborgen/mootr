package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The human's and an agent's pause, unpause, MCP reconnect and permission-mode switch (src/lifecycle.ts pause and
// unpause, src/daemon.ts control and setPermissionMode, S-3746).

// Pause is src/lifecycle.ts pause: owner is "human" or the pausing agent's id. Pausing a paused agent only adds the
// owner, so several owners and stam's blockers can hold it together. It decides and writes in the agent's serial.
func (l *Lifecycle) Pause(ctx context.Context, a db.Agent, owner string) (string, error) {
	var out string
	err := l.serial(ctx, a.ID, func(ctx context.Context) (err error) {
		out, err = l.pauseNow(ctx, a.ID, owner)
		return err
	})
	return out, err
}

type unpauseHeldEvent struct {
	By   string `json:"by"`
	Held string `json:"held"`
}

type blockerRow struct {
	AgentID string  `json:"agent_id"`
	Kind    string  `json:"kind"`
	Account string  `json:"account"`
	Reason  string  `json:"reason"`
	Since   string  `json:"since"`
	Clear   *string `json:"clear"`
}

type unpauseOverrideEvent struct {
	Blockers []blockerRow `json:"blockers"`
}

// heldBy is src/admission.ts heldBy: what holds the agent, its blockers and then who paused it; "" for nothing.
func (l *Lifecycle) heldBy(ctx context.Context, a db.Agent) (string, error) {
	held, err := l.blockedBy(ctx, a.ID)
	if err != nil {
		return "", err
	}
	for _, o := range pauseOwners(a) {
		who := o
		if o == humanID {
			who = "the human"
		} else if p, err := l.db.GetAgent(ctx, o); err == nil {
			who = p.Name
		}
		held = append(held, "paused by "+who)
	}
	return strings.Join(held, "; "), nil
}

// Unpause is src/lifecycle.ts unpause: by is "human" or the unpausing agent's id. An agent releases only its own
// pause; the human releases every one. The agent resumes only when nothing else holds it: an agent is told what still
// does, the human gets an error naming it. force is the human's alone: it also clears the cost blockers. It decides
// and writes in the agent's serial, so it never interleaves with an archive or another pause of the agent.
func (l *Lifecycle) Unpause(ctx context.Context, a db.Agent, by string, force bool) (string, error) {
	var out string
	err := l.serial(ctx, a.ID, func(ctx context.Context) error {
		if err := l.assertNotTakenOver(ctx, a); err != nil {
			return err
		}
		cur, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		if err := l.assertNoTransition(cur); err != nil {
			return err
		}
		human := by == humanID
		if force && !human {
			return errors.New("only the human may force an unpause")
		}
		if cur.Lifecycle != "paused" {
			return fmt.Errorf("%s is %s", cur.Name, cur.Lifecycle)
		}
		var owners []string
		if !human {
			for _, o := range pauseOwners(cur) {
				if o != by {
					owners = append(owners, o)
				}
			}
		}
		var pausedBy any
		if len(owners) > 0 {
			pausedBy = jsonText(owners)
		}
		if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "paused_by", Val: pausedBy}); err != nil {
			return err
		}
		blockers, err := l.db.BlockerRows(ctx, a.ID)
		if err != nil {
			return err
		}
		if force && len(blockers) > 0 {
			rows := make([]blockerRow, len(blockers))
			for i, b := range blockers {
				rows[i] = blockerRow{AgentID: b.AgentID, Kind: b.Kind, Account: b.Account, Reason: b.Reason, Since: b.Since, Clear: b.Clear}
			}
			l.event(ctx, a.ID, "cost:override", unpauseOverrideEvent{Blockers: rows})
			if err := l.db.DeleteBlockers(ctx, a.ID); err != nil {
				return err
			}
		}
		l.admit(ctx, a.ID, "unpause")
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return err
		}
		held, err := l.heldBy(ctx, now)
		if err != nil {
			return err
		}
		if held != "" {
			l.event(ctx, a.ID, "unpause-held", unpauseHeldEvent{By: by, Held: held})
			// Only the rest is left: mail that arrived while another pause held it wakes it now.
			if db.RestOwned(now) {
				l.SchedulePush(a.ID)
			}
			msg := fmt.Sprintf("%s stays paused: %s", cur.Name, held)
			if human {
				return errors.New(msg + ". Unpause with force to override its cost blockers.")
			}
			out = msg
			return nil
		}
		text, err := l.render("unpause", nil)
		if err != nil {
			return err
		}
		out, err = l.resumeNow(ctx, a.ID, text)
		return err
	})
	return out, err
}

// AckAsManager is src/daemon.ts control's pause and unpause ack (cost-fallback.ts ackAgent): the human or a manager
// pausing or unpausing the agent counts as acting on its open cost notices, so their fallbacks don't run. by is
// "human" or an agent id.
func (l *Lifecycle) AckAsManager(ctx context.Context, a db.Agent, by, via string) error {
	if !l.mayManageTree(ctx, by, a, nil) {
		return nil
	}
	open, err := l.db.OpenCostNotices(ctx)
	if err != nil {
		return err
	}
	for _, n := range open {
		if n.AgentID != nil && *n.AgentID == a.ID {
			if _, err := l.AckCostNotice(ctx, n.ID, by, via); err != nil {
				return err
			}
		}
	}
	return nil
}

// ReconnectMCP is src/daemon.ts control's reconnect-mcp for a Claude Code agent, which has no MCP reload: whenIdle (a
// prune capping pinned releases) leaves it alone, and a plain request restarts it. An OpenCode agent's plain request
// reloads the shared server's MCP client for its directory (reconnectOpenCode), with no restart; a Codex agent's reload,
// and an OpenCode agent's at its next idle (the pending reconnect, left for TS), aren't ported.
func (l *Lifecycle) ReconnectMCP(ctx context.Context, a db.Agent, whenIdle bool) (string, error) {
	if a.Harness == "opencode" && !whenIdle && l.opencode != nil {
		done, err := l.reconnectOpenCode(ctx, a, nil)
		switch {
		case err != nil:
			return "", err
		case !done:
			return a.Name + " isn't running its session; nothing to reconnect", nil
		}
		return "reconnected", nil
	}
	if a.Harness == "codex" || a.Harness == "opencode" {
		return "", ErrNotPorted{What: "reconnecting a " + a.Harness + " agent's MCP servers"}
	}
	if whenIdle {
		return "reconnect requested", nil
	}
	return l.Restart(ctx, a, "reconnect MCP servers")
}

// switchUndo is src/permission-modes.ts SwitchUndo, in its key order: what a permission-mode switch set, who set it,
// and the mode and source it replaced.
func switchUndo(mode, source, by string, keptMode string, keptSource *string) *jsjson.Object {
	var ks jsjson.Value
	if keptSource != nil {
		ks = *keptSource
	}
	return jsjson.NewObject("mode", mode, "source", source, "by", by, "kept", jsjson.NewObject("permission_mode", keptMode, "permission_source", ks))
}

type permissionModeEvent struct {
	Mode   string `json:"mode"`
	Source string `json:"source"`
	By     string `json:"by"`
}

// SetPermissionMode is src/daemon.ts setPermissionMode: the human's pick for one agent (source "manual"; the mode
// "settings" follows the settings again), or apply's switch to the settings' mode (source "settings"). A running agent
// on another mode restarts in place, its session kept, once its step ends; a launch that fails then puts the old mode
// and source back (switchFailed). With relaunch, an agent a failed switch left shut down resumes on the new mode.
func (l *Lifecycle) SetPermissionMode(ctx context.Context, a db.Agent, m jsjson.Value, by, source string, relaunch bool) (string, error) {
	if m == "settings" {
		source = "settings"
	}
	typ := ""
	if a.Type != nil {
		typ = *a.Type
	}
	mode := "auto"
	if source == "settings" {
		mode = l.settings.Get().PermissionModes.EffectiveMode(a.Harness, typ)
	} else if s, ok := m.(string); ok && config.IsPermissionMode(s) {
		mode = s
	}
	var keptSource *string
	if a.PermissionSource != nil {
		s := string(*a.PermissionSource)
		keptSource = &s
	}
	undo := switchUndo(mode, source, by, string(a.PermissionMode), keptSource)
	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "permission_mode", Val: mode}, db.Field{Col: "permission_source", Val: source}); err != nil {
		return "", err
	}
	l.event(ctx, a.ID, "permission-mode", permissionModeEvent{Mode: mode, Source: source, By: by})
	reason := "permission mode changed to " + mode
	if relaunch && a.Lifecycle == "shut_down" {
		now, err := l.db.GetAgent(ctx, a.ID)
		if err != nil {
			return "", err
		}
		out, err := l.Resume(ctx, now, reason)
		if err != nil {
			l.switchFailed(ctx, a.ID, undo, err)
			return "", err
		}
		return out, nil
	}
	if mode == string(a.PermissionMode) || !running(a) {
		return "set", nil
	}
	now, err := l.db.GetAgent(ctx, a.ID)
	if err != nil {
		return "", err
	}
	wrapUp, err := l.render("restart-prepare", map[string]string{"reason": reason})
	if err != nil {
		return "", err
	}
	return l.whenIdle(ctx, now, jsjson.NewObject("type", "restart", "reason", reason, "permission", undo), wrapUp)
}

type permissionFailedEvent struct {
	Mode   string `json:"mode"`
	Source string `json:"source"`
	By     string `json:"by"`
	Kept   any    `json:"kept"`
	Error  string `json:"error"`
}

// switchFailed is src/permission-modes.ts switchFailed: a restart for a permission-mode switch whose launch failed puts
// the mode and source it replaced back, while the row still holds what the switch set, and records why.
func (l *Lifecycle) switchFailed(ctx context.Context, id string, undo *jsjson.Object, cause error) {
	mode, source, by := pstr(undo, "mode"), pstr(undo, "source"), pstr(undo, "by")
	keptV, _ := undo.Get("kept")
	kept, _ := keptV.(*jsjson.Object)
	now, err := l.db.GetAgent(ctx, id)
	ours := err == nil && string(now.PermissionMode) == mode && now.PermissionSource != nil && string(*now.PermissionSource) == source
	var keptMode any
	if err == nil {
		keptMode = string(now.PermissionMode)
	}
	if ours && kept != nil {
		km, _ := kept.Get("permission_mode")
		ks, _ := kept.Get("permission_source")
		l.update(ctx, id, db.Field{Col: "permission_mode", Val: km}, db.Field{Col: "permission_source", Val: ks})
		keptMode = km
	}
	l.event(ctx, id, "permission-mode:failed", permissionFailedEvent{Mode: mode, Source: source, By: by, Kept: keptMode, Error: cause.Error()})
}

// SyncChildrenWaits is src/org.ts syncChildrenWaits after the agent's parents changed (adopt, set-parent): its
// children wait and every ancestor's, on the org goroutine.
func (l *Lifecycle) SyncChildrenWaits(ctx context.Context, id string) {
	l.observeOrg(ctx, db.ActivityChange{Kind: "sync", ID: id})
}

// assertNoTransition is src/lifecycle.ts assertNoTransition: no switch or resume holds the agent.
func (l *Lifecycle) assertNoTransition(a db.Agent) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if held := l.transitions[a.ID]; held != nil {
		return fmt.Errorf("%s is being %s; try again when it is done", a.Name, being[held.kind])
	}
	return nil
}
