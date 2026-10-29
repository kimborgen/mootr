package lifecycle

import (
	"strings"
	"unicode"
)

// isJSSpace is the whitespace String.prototype.trimStart strips: Unicode white space and the byte order mark.
func isJSSpace(r rune) bool { return unicode.IsSpace(r) || r == 0xFEFF }

// S-3454, a port of src/adapters/claude-first-prompt.ts: a launch's first prompt counts as taken by the first
// UserPromptSubmit that is not a stam channel push. A channel push starts a turn of its own (a restart's wrap-up to
// a launch still starting), and it can come before the typed prompt is submitted, so it must not end the wait while
// the typed prompt is still in the box. Any other hook counts, including one with no string prompt. Claude Code
// submits a long multi-line prompt wrapped in `<pasted_content>` tags, so the text is never compared with what was typed.
// One entry per agent: a launch that ends calls done, and a later launch replaces the entry, so only the launch still
// waiting can be marked taken.

// firstWait is one launch's wait; taken is guarded by Lifecycle.firstMu.
type firstWait struct{ taken bool }

// awaitFirstPrompt starts a launch's wait and returns its taken check and its done.
func (l *Lifecycle) awaitFirstPrompt(id string) (taken func() bool, done func()) {
	mine := &firstWait{}
	l.firstMu.Lock()
	if l.firstAwait == nil {
		l.firstAwait = map[string]*firstWait{}
	}
	l.firstAwait[id] = mine
	l.firstMu.Unlock()
	taken = func() bool {
		l.firstMu.Lock()
		defer l.firstMu.Unlock()
		return mine.taken
	}
	done = func() {
		l.firstMu.Lock()
		defer l.firstMu.Unlock()
		if l.firstAwait[id] == mine {
			delete(l.firstAwait, id)
		}
	}
	return taken, done
}

// firstPromptHook is the agent's UserPromptSubmit hook: it marks the awaited first prompt taken unless the turn is a
// channel push. prompt is nil when the hook has no prompt, which counts.
func (l *Lifecycle) firstPromptHook(id string, prompt any) {
	l.firstMu.Lock()
	defer l.firstMu.Unlock()
	mine := l.firstAwait[id]
	if mine == nil {
		return
	}
	if s, ok := prompt.(string); ok && strings.HasPrefix(strings.TrimLeftFunc(s, isJSSpace), `<channel source="stam"`) {
		return
	}
	mine.taken = true
}
