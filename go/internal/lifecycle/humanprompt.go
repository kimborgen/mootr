package lifecycle

import (
	"context"
	"strings"

	"stam/internal/db"
)

// The human's prompt from the web UI's input (src/daemon.ts POST /api/agents/:id/prompt): pasted into the agent's
// terminal as typed input, then Enter.

// HasSession is whether the agent's tmux session is there.
func (l *Lifecycle) HasSession(ctx context.Context, id string) bool {
	return l.tmux.HasSession(ctx, id)
}

// PasteHumanPrompt pastes text into the agent's terminal and presses Enter. Claude Code with vim keys must be in insert
// mode first, or the paste becomes commands.
func (l *Lifecycle) PasteHumanPrompt(ctx context.Context, a db.Agent, text string) error {
	if screen, _ := l.tmux.CapturePane(ctx, a.ID); strings.Contains(screen, "-- NORMAL --") {
		_ = l.tmux.SendKeys(ctx, a.ID, "i")
	}
	return l.tmux.PasteText(ctx, a.ID, text)
}
