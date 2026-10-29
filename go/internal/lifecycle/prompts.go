package lifecycle

import (
	"context"

	"stam/internal/adapters/claude"
	"stam/internal/db"
)

// Prompts renders the system prompt's slots other modules own (the server's instructions.Prompts, S-3776): a launch's
// parts, and the cached lessons an archive drops (src/lifecycle.ts archive's forgetLessons).
type Prompts interface {
	LaunchParts(ctx context.Context, a db.Agent) (claude.Parts, error)
	ForgetLessons(id string)
}

// SetPrompts sets what fills a launch's system prompt; without it, a launch leaves those slots empty.
func (l *Lifecycle) SetPrompts(p Prompts) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prompts = p
}

func (l *Lifecycle) promptParts() Prompts {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.prompts
}
