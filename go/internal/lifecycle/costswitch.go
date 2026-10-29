package lifecycle

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The cost switch (src/cost-switch.ts, docs/cost-policy.md build step 13, S-2848 B5e): a manager moves an agent's work
// to a successor on another preset. This part holds the move itself: the successor's row, the transaction that gives
// it the predecessor's place in the org (db.MoveToSuccessor) and the one that puts it back (db.Unmove), the takeover
// prompt, and the notice to the successor's parents. The switch that drives them (check, quiesce, stop, launch,
// rollback, resumeSwitches and startSwitch) is costswitch_run.go.

// switchThreads is src/cost-switch.ts THREADS: how many of the predecessor's most recent open threads move.
const switchThreads = 50

// summaryChars is src/cost-switch.ts SUMMARY_CHARS, and handoverChars HANDOVER_CHARS (UTF-16 units).
const (
	summaryChars  = 8000
	handoverChars = 12000
)

// switchTo is the harness, model and effort a switch moves the agent to (src/cost-switch.ts switchTarget for a preset).
// A switch to an agent type (toType, set only by the cost fallback's take-over) isn't ported (S-3687).
type switchTo struct {
	Harness       string
	Model, Effort *string
}

// permissionSource is src/permission-modes.ts permissionSource: an agent from before S-1967 has no source, and an auto
// one followed the old default, so it follows the settings.
func permissionSource(a db.Agent) string {
	if a.PermissionSource != nil && (*a.PermissionSource == "settings" || *a.PermissionSource == "manual") {
		return string(*a.PermissionSource)
	}
	if a.PermissionMode == "auto" {
		return "settings"
	}
	return "manual"
}

func textOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// successorSpec is the successor's row as src/cost-switch.ts move writes it: the predecessor's role, machine, cwd and
// spawning parent, the target's harness, model and effort, a new session, and then (in move's order) its workspace,
// personal workspace and standing flag (S-894), the target's capabilities, its permission mode (a successor that
// follows the settings takes their mode for its own harness, S-1967), visibility, child notices, kind, type and the
// original spawn prompt, so a later switch of the successor hands it on too. A switch to an agent type, which makes the
// successor that type, is the fallback's (S-3687).
func (l *Lifecycle) successorSpec(a db.Agent, to switchTo, id, session string) (db.SuccessorSpec, error) {
	model := ""
	if to.Model != nil {
		model = *to.Model
	}
	caps, err := l.Capabilities(to.Harness, model)
	if err != nil {
		return db.SuccessorSpec{}, err
	}
	source := permissionSource(a)
	mode := string(a.PermissionMode)
	if source == "settings" {
		t := ""
		if a.Type != nil {
			t = *a.Type
		}
		mode = l.settings.Get().PermissionModes.EffectiveMode(to.Harness, t)
	}
	var notices any
	if a.ChildNotices != nil {
		notices = string(*a.ChildNotices)
	}
	return db.SuccessorSpec{
		Agent: db.NewAgent{ID: id, Role: a.Role, Machine: a.Machine, Harness: to.Harness, Model: to.Model, Effort: to.Effort, Cwd: a.Cwd,
			ParentID: a.ParentID, SessionID: &session},
		Fields: []db.Field{
			{Col: "workspace", Val: textOrNil(a.Workspace)},
			{Col: "personal_workspace", Val: textOrNil(a.PersonalWorkspace)},
			{Col: "standing", Val: int(a.Standing)},
			{Col: "capabilities", Val: caps},
			{Col: "permission_mode", Val: mode},
			{Col: "permission_source", Val: source},
			{Col: "visibility", Val: textOrNil(a.Visibility)},
			{Col: "child_notices", Val: notices},
			{Col: "kind", Val: textOrNil(a.Kind)},
			{Col: "type", Val: textOrNil(a.Type)},
			{Col: "first_prompt", Val: textOrNil(a.FirstPrompt)},
		},
	}, nil
}

// switchBy is src/cost-switch.ts nameOf: how a switch's requester is named in its notices and prompts. TS names its
// cost fallback's take-over (by stam) "stam's cost fallback"; that take-over isn't ported (S-3687).
func (l *Lifecycle) switchBy(ctx context.Context, by string) string {
	if by == humanID {
		return "the human"
	}
	if a, err := l.db.GetAgent(ctx, by); err == nil {
		return a.Name
	}
	return by
}

// lastCompactionSummary is src/cost-switch.ts lastCompactionSummary: the newest compaction summary in the predecessor's
// transcript, when the harness writes one there (Claude Code marks it isCompactSummary, Codex's rollout stores a
// compacted item), trimmed and cut to summaryChars; "" for none. A transcript over 200 MiB isn't read.
func lastCompactionSummary(path *string) string {
	if path == nil || *path == "" {
		return ""
	}
	st, err := os.Stat(*path)
	if err != nil || st.Size() > 200*1024*1024 {
		return ""
	}
	b, err := os.ReadFile(*path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(b), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !strings.Contains(line, "isCompactSummary") && !strings.Contains(line, `"compacted"`) {
			continue
		}
		e, err := jsjson.Parse([]byte(line))
		if err != nil {
			continue
		}
		o, _ := e.(*jsjson.Object)
		if o == nil {
			continue
		}
		var text jsjson.Value
		if f, _ := o.Get("isCompactSummary"); jsjson.Truthy(f) {
			msg, _ := o.Get("message")
			mo, _ := msg.(*jsjson.Object)
			var c jsjson.Value
			if mo != nil {
				c, _ = mo.Get("content")
			}
			switch c := c.(type) {
			case string:
				text = c
			case []jsjson.Value:
				parts := make([]string, len(c))
				for j, x := range c {
					xo, _ := x.(*jsjson.Object)
					if xo == nil {
						continue
					}
					if t, ok := xo.Get("text"); ok && t != nil {
						parts[j] = jsString(t)
					}
				}
				text = strings.Join(parts, "\n")
			}
		} else if typ, _ := o.Get("type"); typ == "compacted" {
			p, _ := o.Get("payload")
			if po, _ := p.(*jsjson.Object); po != nil {
				text, _ = po.Get("message")
			}
		}
		if s, ok := text.(string); ok && jsjson.Trim(s) != "" {
			return sliceUTF16(jsjson.Trim(s), summaryChars)
		}
	}
	return ""
}

// jsString is String(v) for a JSON value: a string as is, anything else as JSON writes it.
func jsString(v jsjson.Value) string {
	if s, ok := v.(string); ok {
		return s
	}
	return jsjson.Stringify(v, "")
}

// collapseSpace is s.replace(/\s+/g, ' ') with JavaScript's whitespace.
func collapseSpace(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if jsjson.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// handoverOf is src/cost-switch.ts handoverOf: the predecessor's HANDOVER.md when it wrote one (the wrap-up asks for
// it), cut to handoverChars, else a brief stam generates from what it knows. file says which. A HANDOVER.md that can't
// be stat'ed for any reason (a cwd that is no folder, one it may not search) counts as none, as existsSync has it; one
// that can be but not read fails, as readFileSync does.
func (l *Lifecycle) handoverOf(ctx context.Context, a db.Agent) (text string, file bool, err error) {
	path := filepath.Join(a.Cwd, "HANDOVER.md")
	if st, serr := os.Stat(path); serr == nil {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", false, err
		}
		body := string(b)
		clipped := body
		if cut := sliceUTF16(body, handoverChars); cut != body {
			clipped = cut + "\n[... clipped; the rest is in " + path + "]"
		}
		return jsjson.Trim(clipped) + "\n\n(" + path + ", last updated " + iso(st.ModTime()) + "; " + a.Name + "'s last activity " + a.UpdatedAt + ")", true, nil
	}
	ws, err := a.WorkspaceOf()
	if err != nil {
		return "", false, err
	}
	head := "(not a git checkout)"
	cmd := exec.CommandContext(ctx, "git", "-C", a.Cwd, "rev-parse", "HEAD")
	if out, err := cmd.Output(); err == nil {
		head = strings.TrimSpace(string(out))
	}
	keys, err := l.db.OpenItsaKeysOwnedBy(ctx, a.ID)
	if err != nil {
		return "", false, err
	}
	branch, tree := "(none)", a.Cwd
	if ws != nil && ws.Worktree != nil {
		branch, tree = ws.Worktree.Branch, ws.Worktree.Path
	}
	owned := "(none)"
	if len(keys) > 0 {
		owned = strings.Join(keys, ", ")
	}
	last := "(not reported)"
	if a.LastMessage != nil {
		last = *a.LastMessage
	}
	return strings.Join([]string{
		"Generated by stam: " + a.Name + " left no HANDOVER.md, so this brief is all there is.",
		"- Branch: " + branch,
		"- Head: " + head,
		"- Worktree: " + tree,
		"- ITSAs it owned: " + owned,
		"- Its last message: " + sliceUTF16(collapseSpace(last), 2000),
	}, "\n"), false, nil
}

// takeoverPrompt is src/cost-switch.ts takeoverPrompt: the successor's first prompt (takeover.md) with the handover,
// the predecessor's transcript path, original prompt, last compaction summary and open threads. handover is the
// HANDOVER.md it handed on, "" for a generated brief.
func (l *Lifecycle) takeoverPrompt(ctx context.Context, a, s db.Agent, by, preset string, threads []db.ThreadRef) (text, handover string, err error) {
	ws, err := a.WorkspaceOf()
	if err != nil {
		return "", "", err
	}
	summary := lastCompactionSummary(a.TranscriptPath)
	body, file, err := l.handoverOf(ctx, a)
	if err != nil {
		return "", "", err
	}
	branch := ""
	if ws != nil && ws.Worktree != nil {
		branch = ", on branch " + ws.Worktree.Branch
	}
	if file {
		body = a.Name + "'s HANDOVER.md:\n\n<handover>\n" + body + "\n</handover>"
		handover = filepath.Join(a.Cwd, "HANDOVER.md")
	}
	transcript := "(not recorded)"
	if a.TranscriptPath != nil {
		transcript = *a.TranscriptPath
	}
	prompt := "(not recorded)"
	if a.FirstPrompt != nil {
		prompt = *a.FirstPrompt
	}
	if summary != "" {
		summary = "The last compaction summary of " + a.Name + "'s conversation:\n\n<summary>\n" + summary + "\n</summary>"
	}
	list := "(none)"
	if len(threads) > 0 {
		lines := make([]string, len(threads))
		for i, t := range threads {
			id := "null"
			if t.ThreadID != nil {
				id = *t.ThreadID
			}
			lines[i] = "- " + id + ": " + t.Subject
		}
		list = strings.Join(lines, "\n")
	}
	text, err = l.render("takeover", map[string]string{
		"name": s.Name, "predecessor": a.Name, "by": l.switchBy(ctx, by), "preset": preset, "cwd": s.Cwd, "branch": branch,
		"handover": body, "transcript": transcript, "prompt": prompt, "summary": summary, "threads": list,
	})
	return text, handover, err
}

type switchedEvent struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Preset string `json:"preset"`
}

// switched is src/cost-notices.ts switched: cost_switch moved an agent's work to a successor, so each of the
// successor's parents hears it, and the manager that asked for the switch when it isn't one of them; working ones
// in-turn, idle ones by mail from system:cost, the human (when nobody else is told and its mail allows important) by
// mail. Information only, so nothing to acknowledge.
func (l *Lifecycle) switched(ctx context.Context, from, to db.Agent, preset, by string) {
	who := "the human"
	if by != humanID {
		who = by
		if a, err := l.db.GetAgent(ctx, by); err == nil {
			who = a.Name
		}
	}
	subject := "[stam] " + from.Name + " now continues as " + to.Name + " on " + preset
	body, err := l.render("cost-switched", map[string]string{"from": from.Name, "to": to.Name, "preset": preset, "by": who})
	if err != nil {
		l.logSwitch(from, "switched notice", err)
		return
	}
	targets, err := l.db.ParentsOf(ctx, to)
	if err != nil {
		l.logSwitch(from, "switched notice", err)
		return
	}
	if by != humanID {
		if a, err := l.db.GetAgent(ctx, by); err == nil && !contains(targets, a.ID) {
			targets = append(targets, a.ID)
		}
	}
	if len(targets) == 0 && l.settings.Get().HumanMail.Allows("important") {
		targets = []string{humanID}
	}
	for _, m := range targets {
		l.deliverCost(ctx, m, subject, body, nil)
		if m != humanID {
			l.event(ctx, m, "cost:switched", switchedEvent{From: from.Name, To: to.Name, Preset: preset})
		}
	}
}

func (l *Lifecycle) logSwitch(a db.Agent, what string, err error) {
	slog.Error("cost switch: "+what, "agent", a.Name, "err", err)
}
