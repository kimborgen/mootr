package lifecycle

import (
	"context"
	"regexp"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// What src/permissions.ts asks of the harness and the org (S-2848 B3a): a dialog's answer typed into it, the human's
// approval typed into an idle agent's input, the cost check of the turn that starts, and the children waits a request
// changes.

// AnswerDialog is src/adapters/claude.ts answerDialog: only the request's own dialog, in the session that showed it, is
// answered. "gone" when the agent isn't blocked, has no tmux session, is in another harness session, or shows no
// dialog; "unsafe" for a yes and "unsure" for a no the dialog on screen can't be tied to (a no checks it too, unlike TS:
// see claude.DialogAnswer), or a yes it doesn't offer once; "failed" when a tmux call failed, or the pane or the harness
// session changed after the screen was read (TS ran these synchronously; here a shutdown or resume isn't held off meanwhile),
// so the key may not have been typed and the request stays as it is; else the key is sent and it is "typed". A harness
// with no dialogs answers "gone".
func (l *Lifecycle) AnswerDialog(ctx context.Context, a db.Agent, details string, approve bool) string {
	pane, owner, screen, outcome := l.dialogScreen(ctx, a, details)
	if outcome != "" {
		return outcome
	}
	key, outcome := claude.DialogAnswer(screen, details, approve)
	if outcome != "typed" {
		return outcome
	}
	l.dialogStep("captured")
	if now, ok := l.tmux.PaneOwner(ctx, pane); !ok || now != owner {
		return "failed"
	}
	if fresh, err := l.db.GetAgent(ctx, a.ID); err != nil || deref(fresh.SessionID) != deref(a.SessionID) {
		return "failed"
	}
	if err := l.tmux.SendKeysToPane(ctx, pane, key); err != nil {
		return "failed"
	}
	return "typed"
}

// dialogScreen reads the screen of the session that showed a dialog, by its pane: the pane is resolved once, and the
// screen read and any key sent by its id, only while it is still this session's pane. An outcome instead when there is
// nothing to read: "gone" (no such dialog can show) or "failed" (a tmux call failed).
func (l *Lifecycle) dialogScreen(ctx context.Context, a db.Agent, details string) (pane, owner, screen, outcome string) {
	if a.Harness != "claude" {
		return "", "", "", "gone"
	}
	d := claude.DialogDetails(details)
	if a.Activity != "blocked" || (d.Session != "" && d.Session != deref(a.SessionID)) {
		return "", "", "", "gone"
	}
	pane, owner, ok, err := l.tmux.Pane(ctx, a.ID)
	if err != nil {
		return "", "", "", "failed"
	}
	if !ok {
		return "", "", "", "gone"
	}
	l.dialogStep("resolved")
	screen, err = l.tmux.CapturePaneByID(ctx, pane)
	if err != nil {
		return "", "", "", "failed"
	}
	return pane, owner, screen, ""
}

// dialogStep runs a test's hook at a step of AnswerDialog, to change the pane or the session between two tmux calls.
func (l *Lifecycle) dialogStep(step string) {
	if l.onDialogStep != nil {
		l.onDialogStep(step)
	}
}

var spaces = regexp.MustCompile(`[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// TypeHumanInput is src/adapters/claude.ts typeHumanInput: the text typed on one line into an idle or waiting agent's
// empty input box, then Enter. False when the box isn't free, or the harness has none stam types into.
func (l *Lifecycle) TypeHumanInput(ctx context.Context, a db.Agent, text string) bool {
	if a.Harness != "claude" || (a.Activity != "idle" && a.Activity != "waiting") || !l.tmux.HasSession(ctx, a.ID) {
		return false
	}
	screen, err := l.tmux.CapturePane(ctx, a.ID)
	if err != nil || !claude.InputFree(screen) {
		return false
	}
	// With vim keys, the box must be in insert mode or the text becomes commands.
	if strings.Contains(screen, "-- NORMAL --") {
		_ = l.tmux.SendKeys(ctx, a.ID, "i")
		if sleep(ctx, 200*time.Millisecond) != nil {
			return false
		}
	}
	if err := l.tmux.SendKeys(ctx, a.ID, "-l", jsjson.Trim(spaces.ReplaceAllString(text, " "))); err != nil {
		return false
	}
	if sleep(ctx, 600*time.Millisecond) != nil {
		return false
	}
	return l.tmux.SendKeys(ctx, a.ID, "Enter") == nil
}

// AdmitHuman is src/admission.ts admit(a, 'human') for a turn the human's approval starts: it always starts, and a
// cost blocker it goes past is a cost:override event; an agent taken over by a live successor records its refusal.
func (l *Lifecycle) AdmitHuman(ctx context.Context, id string) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return
	}
	if a.ForwardedTo != nil && *a.ForwardedTo != "" {
		if s, err := l.db.GetAgent(ctx, *a.ForwardedTo); err == nil && s.Lifecycle != "archived" {
			l.event(ctx, a.ID, "cost:refused", struct {
				Kind   string `json:"kind"`
				Reason string `json:"reason"`
			}{"human", "taken over by " + s.Name})
			return
		}
	}
	blocked, err := l.db.Blockers(ctx, a.ID)
	if err != nil || len(blocked) == 0 {
		return
	}
	l.event(ctx, a.ID, "cost:override", struct {
		Kind string `json:"kind"`
		Held string `json:"held"`
	}{"human", strings.Join(blocked, "; ")})
}

// OrgResync is src/org.ts syncChildrenWaits and announceTreeIdle for an agent whose pending requests changed: queued for
// the org goroutine, after the write that changed them.
func (l *Lifecycle) OrgResync(ctx context.Context, id string) {
	l.observeOrg(ctx, db.ActivityChange{Kind: "resync", ID: id})
}
