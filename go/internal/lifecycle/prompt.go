package lifecycle

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"stam/internal/adapters/claude"
)

// The Claude Code launch, after its tmux session starts (src/adapters/claude.ts answerLaunchDialogs and
// typeFirstPrompt).

var (
	acceptRe = regexp.MustCompile(`(?i)Yes, I trust this folder|Yes, proceed|I am using this for local development|Use this and all future MCP servers|Resume full session`)
	readyRe  = regexp.MustCompile(`(?i)\? for shortcuts|bypass permissions|auto mode|accept edits|plan mode|esc to interrupt`)
	// JavaScript's \s, which holds the no-break space and the other Unicode spaces.
	cursorRe   = regexp.MustCompile(`^[\s\x{a0}\x{feff}\x{2028}\x{2029}\p{Zs}]*❯`)
	confirmRe  = regexp.MustCompile(`Enter to confirm|Esc to cancel`)
	dialogWait = 30 * time.Second
)

// answerLaunchDialogs accepts the dialogs Claude Code shows at launch (folder trust, new MCP servers, development
// channels) and returns once the input prompt shows, the session ends, or after 30 s. Nobody has attached yet, so
// answering them can't collide with a human's typing. Enter goes only once the cursor is on the accepting option: a
// dialog still drawing can drop the arrow key, and Enter would then pick "No, exit".
func (l *Lifecycle) answerLaunchDialogs(ctx context.Context, id string) error {
	deadline := time.Now().Add(dialogWait)
	for time.Now().Before(deadline) {
		if err := sleep(ctx, 400*time.Millisecond); err != nil {
			return err
		}
		if !l.tmux.HasSession(ctx, id) || l.tmux.IsDead(ctx, id) {
			return nil
		}
		screen, _ := l.tmux.CapturePane(ctx, id)
		lines := strings.Split(screen, "\n")
		target, cursor := -1, -1
		for i, line := range lines {
			if target < 0 && acceptRe.MatchString(line) {
				target = i
			}
			if cursor < 0 && cursorRe.MatchString(line) {
				cursor = i
			}
		}
		if target >= 0 && cursor >= 0 && abs(target-cursor) < 6 {
			if target != cursor {
				key := "Up"
				if target > cursor {
					key = "Down"
				}
				_ = l.tmux.SendKeys(ctx, id, key)
				if err := sleep(ctx, 300*time.Millisecond); err != nil {
					return err
				}
				continue
			}
			_ = l.tmux.SendKeys(ctx, id, "Enter")
			if err := sleep(ctx, 1500*time.Millisecond); err != nil {
				return err
			}
		} else if readyRe.MatchString(screen) {
			return nil
		}
	}
	return nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

type screenEvent struct {
	Error  string   `json:"error"`
	Screen []string `json:"screen"`
}

// typeFirstPrompt types the first prompt into Claude Code's input box, as one bracketed paste and then Enter. A launch
// a restart or resume superseded stops quietly (first-prompt:superseded).
func (l *Lifecycle) typeFirstPrompt(ctx context.Context, id, text string, current, admit func() bool) error {
	taken, done := l.awaitFirstPrompt(id)
	defer done()
	err := l.deliverFirstPrompt(ctx, id, text, taken, current, admit)
	if err != nil && current() {
		return err
	}
	if !current() {
		l.event(ctx, id, "first-prompt:superseded", nil)
	}
	return nil
}

// deliverFirstPrompt is src/adapters/claude.ts deliverFirstPrompt. It waits for an empty input box (a faint
// placeholder counts as empty), pastes the prompt, and presses Enter only on a box that holds exactly one copy of it.
// A paste that never shows is pasted again (up to three times); a box with anything else in it is left alone. It is
// done when a UserPromptSubmit that isn't a channel push comes (firstprompt.go).
func (l *Lifecycle) deliverFirstPrompt(ctx context.Context, id, text string, delivered, current, admit func() bool) error {
	type view struct {
		lines []string
		box   string
	}
	screen := func() view {
		ansi, _ := l.tmux.CapturePaneAnsi(ctx, id, 200)
		plain, _ := l.tmux.CapturePane(ctx, id)
		return view{lines: strings.Split(plain, "\n"), box: claude.PromptInBox(strings.Split(ansi, "\n"), text)}
	}
	alive := func() error {
		if !l.tmux.HasSession(ctx, id) || l.tmux.IsDead(ctx, id) {
			return errExited
		}
		return nil
	}
	// A failure records the screen it saw, styles and all (S-2123).
	failed := func(msg string) error {
		if current() && l.tmux.HasSession(ctx, id) {
			ansi, _ := l.tmux.CapturePaneAnsi(ctx, id, 16)
			l.event(ctx, id, "first-prompt:screen", screenEvent{Error: msg, Screen: strings.Split(ansi, "\n")})
		}
		return errors.New(msg)
	}
	notOne := func() error {
		return failed("the input box does not show the prompt exactly once, so nothing was pressed")
	}
	until := func(d time.Duration, done func() bool) (bool, error) {
		end := time.Now().Add(d)
		for time.Now().Before(end) && !done() {
			if err := sleep(ctx, 300*time.Millisecond); err != nil {
				return false, err
			}
		}
		return done(), nil
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		if err := alive(); err != nil {
			return err
		}
		if !current() {
			return nil
		}
		v := screen()
		if v.box == claude.BoxEmpty && !anyMatch(v.lines, confirmRe) {
			// With vim keys, the box must be in insert mode or the text becomes commands.
			if anyContains(v.lines, "-- NORMAL --") {
				_ = l.tmux.SendKeys(ctx, id, "i")
				if err := sleep(ctx, 200*time.Millisecond); err != nil {
					return err
				}
			}
			break
		}
		if time.Now().After(deadline) {
			return failed("no empty input box")
		}
		if err := sleep(ctx, 300*time.Millisecond); err != nil {
			return err
		}
	}
	// The admission gate, asked again right before the prompt goes in: a blocker added during the launch keeps it back.
	if admit != nil && !admit() {
		return nil
	}
	for paste := 0; ; paste++ {
		if err := alive(); err != nil {
			return err
		}
		if delivered() || !current() {
			return nil
		}
		if err := l.tmux.Paste(ctx, id, text); err != nil {
			return err
		}
		// A long paste takes a moment to land; an Enter before that is lost.
		landed, err := until(10*time.Second, func() bool { return screen().box != claude.BoxEmpty })
		if err != nil {
			return err
		}
		if landed {
			break
		}
		// Still empty after a settle: the paste was lost, so pasting again can't double it.
		if err := sleep(ctx, 2*time.Second); err != nil {
			return err
		}
		if screen().box != claude.BoxEmpty {
			break
		}
		if paste == 2 {
			return failed("pasted the prompt, but it never showed in the input box")
		}
	}
	// It lands in parts; then it must stay exactly one copy through a settle.
	one, err := until(10*time.Second, func() bool { return screen().box == claude.BoxOne })
	if err != nil {
		return err
	}
	if !one {
		return notOne()
	}
	if err := sleep(ctx, 500*time.Millisecond); err != nil {
		return err
	}
	if screen().box != claude.BoxOne {
		return notOne()
	}
	// The box empties (or goes, as the turn starts) once Claude Code takes the prompt.
	taken := false
	for attempt := 0; attempt < 3 && !taken; attempt++ {
		if err := alive(); err != nil {
			return err
		}
		if delivered() || !current() {
			return nil
		}
		_ = l.tmux.SendKeys(ctx, id, "Enter")
		if taken, err = until(10*time.Second, func() bool { return delivered() || !current() || screen().box != claude.BoxOne }); err != nil {
			return err
		}
		if delivered() || !current() {
			return nil
		}
		// The Enter was lost and the text is still in the box: Enter again. Anything else is left alone.
		if taken && screen().box == claude.BoxOther {
			return notOne()
		}
	}
	if !taken {
		return failed("typed the prompt, but Claude Code did not take it")
	}
	done := func() bool { return delivered() || !current() }
	if ok, err := until(2*time.Second, done); err != nil || ok {
		return err
	}
	l.event(ctx, id, "first-prompt:awaiting-hook", nil)
	if ok, err := until(120*time.Second, done); err != nil || ok {
		return err
	}
	return failed("Claude Code took the prompt, but its UserPromptSubmit hook never came")
}

func anyMatch(lines []string, re *regexp.Regexp) bool {
	for _, l := range lines {
		if re.MatchString(l) {
			return true
		}
	}
	return false
}

func anyContains(lines []string, s string) bool {
	for _, l := range lines {
		if strings.Contains(l, s) {
			return true
		}
	}
	return false
}
