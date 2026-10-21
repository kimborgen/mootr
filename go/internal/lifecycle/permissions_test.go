package lifecycle

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/tmux"
)

// pane starts a session for id that draws screen and then echoes what is typed, as a terminal's line discipline does.
func (l *live) pane(id string, screen ...string) {
	l.t.Helper()
	script := filepath.Join(l.base, id+".sh")
	body := "printf '%s\\n' " + shellWords(screen) + "\nexec cat\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		l.t.Fatal(err)
	}
	if err := l.tmux.NewSession(l.ctx, id, l.work, tmux.Env{}, []string{"sh", script}); err != nil {
		l.t.Fatal(err)
	}
	last := strings.TrimSpace(screen[len(screen)-1])
	l.until("the pane to draw", func() bool { s, _ := l.tmux.CapturePane(l.ctx, id); return strings.Contains(s, last) })
}

func shellWords(words []string) string {
	q := make([]string, len(words))
	for i, w := range words {
		q[i] = "'" + strings.ReplaceAll(w, "'", `'\''`) + "'"
	}
	return strings.Join(q, " ")
}

func (l *live) screenHas(id, text string) bool {
	s, _ := l.tmux.CapturePane(l.ctx, id)
	return strings.Contains(s, text)
}

var readDialog = []string{"────────────────", " Read file", "  Read(/elsewhere/menu.png)",
	" ❯ 1. Yes, and keep allowing any reads outside the working directories", "   2. No, and ask again next time",
	"   3. Yes, but ask again next time", " Enter to confirm · Esc to cancel"}

const readDetails = `{"tool":"Read","input":{"file_path":"/elsewhere/menu.png"},"session":"11111111-2222-4333-8444-555555555555"}`

// TestAnswerDialog: the one-time yes is typed into the request's own dialog in the session that showed it; another
// dialog, another session, an agent not blocked, or no pane types nothing.
func TestAnswerDialog(t *testing.T) {
	l := newLive(t)
	session := "11111111-2222-4333-8444-555555555555"
	l.waiter("ald1")
	l.set("ald1", db.Field{Col: "activity", Val: "blocked"}, db.Field{Col: "session_id", Val: session})
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), readDetails, true); got != "gone" {
		t.Errorf("no pane: %s", got)
	}
	l.pane("ald1", readDialog...)
	other := strings.Replace(readDetails, "menu.png", "other.png", 1)
	for approve, want := range map[bool]string{true: "unsafe", false: "unsure"} {
		if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), other, approve); got != want {
			t.Errorf("another dialog's answer (approve %v): %s", approve, got)
		}
	}
	if l.screenHas("ald1", "\n2") || l.screenHas("ald1", "^[") {
		t.Error("a key reached another dialog")
	}
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), strings.Replace(readDetails, "5555\"", "6666\"", 1), true); got != "gone" {
		t.Errorf("another session: %s", got)
	}
	l.set("ald1", db.Field{Col: "activity", Val: "working"})
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), readDetails, true); got != "gone" {
		t.Errorf("not blocked: %s", got)
	}
	l.set("ald1", db.Field{Col: "activity", Val: "blocked"})
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), readDetails, true); got != "typed" {
		t.Fatalf("the yes: %s", got)
	}
	l.until("the 3 to echo", func() bool {
		s, _ := l.tmux.CapturePane(l.ctx, "ald1")
		lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
		return strings.TrimSpace(lines[len(lines)-1]) == "3"
	})
	// The session replaced between the capture and the key, on a new tmux server whose first pane has the same %0 id:
	// only the owner check tells them apart. Nothing goes to the new pane, and nothing is gone.
	l.life.onDialogStep = func(step string) {
		if step == "captured" {
			l.tmux.Run(l.ctx, nil, "kill-server")
			l.pane("ald1", readDialog...)
			if id, _, _, _ := l.tmux.Pane(l.ctx, "ald1"); id != "%0" {
				t.Errorf("the new pane is %s, not the old %%0", id)
			}
		}
	}
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), readDetails, true); got != "failed" {
		t.Errorf("a replaced pane: %s", got)
	}
	if s, _ := l.tmux.CapturePane(l.ctx, "ald1"); strings.Contains(s, "\n3") {
		t.Errorf("a key reached the new pane:\n%s", s)
	}
	// The harness session changed meanwhile.
	l.life.onDialogStep = func(step string) {
		if step == "captured" {
			l.set("ald1", db.Field{Col: "session_id", Val: "another-session"})
		}
	}
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), readDetails, true); got != "failed" {
		t.Errorf("a changed session: %s", got)
	}
	l.set("ald1", db.Field{Col: "session_id", Val: session})
	// A tmux call that fails after the pane was resolved.
	l.life.onDialogStep = func(step string) {
		if step == "resolved" {
			l.tmux.Run(l.ctx, nil, "kill-session", "-t", "=ald1")
		}
	}
	if got := l.life.AnswerDialog(l.ctx, l.agent("ald1"), readDetails, true); got != "failed" {
		t.Errorf("a capture that failed: %s", got)
	}
	l.life.onDialogStep = nil
	codex := l.agent("ald1")
	codex.Harness = "codex"
	if got := l.life.AnswerDialog(l.ctx, codex, readDetails, false); got != "gone" {
		t.Errorf("another harness: %s", got)
	}
}

// TestTypeHumanInput: the line goes into an idle agent's empty box and Enter after it, in insert mode first with vim
// keys; a box with text in it, a working agent or another harness gets nothing.
func TestTypeHumanInput(t *testing.T) {
	l := newLive(t)
	l.waiter("alt1")
	if l.life.TypeHumanInput(l.ctx, l.agent("alt1"), "no pane") {
		t.Error("typed with no pane")
	}
	l.pane("alt1", "? for shortcuts", "❯ ")
	l.set("alt1", db.Field{Col: "activity", Val: "working"})
	if l.life.TypeHumanInput(l.ctx, l.agent("alt1"), "I authorize p1") {
		t.Error("typed into a working agent")
	}
	l.set("alt1", db.Field{Col: "activity", Val: "idle"})
	if !l.life.TypeHumanInput(l.ctx, l.agent("alt1"), "I authorize\n p1") {
		t.Fatal("not typed")
	}
	// cat echoes the line as typed, then prints it again after Enter.
	l.until("the line and its Enter", func() bool {
		s, _ := l.tmux.CapturePane(l.ctx, "alt1")
		return strings.Count(s, "I authorize p1") == 2
	})

	l.waiter("alt2")
	l.pane("alt2", "-- NORMAL --", "? for shortcuts", "❯ ")
	if !l.life.TypeHumanInput(l.ctx, l.agent("alt2"), "yes") {
		t.Fatal("not typed with vim keys")
	}
	l.until("insert mode first", func() bool { return l.screenHas("alt2", "iyes") })

	l.waiter("alt3")
	l.pane("alt3", "? for shortcuts", "❯ draft text")
	if l.life.TypeHumanInput(l.ctx, l.agent("alt3"), "yes") {
		t.Error("typed over a draft")
	}
}

// fakeDialogs records what the hooks report.
type fakeDialogs struct {
	mu     sync.Mutex
	shown  []claude.Dialog
	closed int
	fail   error
}

func (f *fakeDialogs) DialogShown(_ context.Context, _ db.Agent, d claude.Dialog) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.shown = append(f.shown, d)
	return f.fail
}

func (f *fakeDialogs) DialogClosed(context.Context, db.Agent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed++
	return nil
}

// TestHookDialogs: a PermissionRequest hook reports its dialog, after the hook's own write; a failure to record it is an
// event and the hook still succeeds; a turn that moves on closes it, and a hook that changes nothing doesn't.
func TestHookDialogs(t *testing.T) {
	l := newLive(t)
	l.waiter("alh1")
	fd := &fakeDialogs{}
	l.life.SetDialogs(fd)
	l.hookPayload("alh1", `{"hook_event_name":"PermissionRequest","session_id":"","tool_name":"Bash","tool_input":{"command":"ls"}}`)
	if len(fd.shown) != 1 || !fd.shown[0].Replaces || !strings.Contains(fd.shown[0].Details, `"command":"ls"`) || fd.closed != 0 {
		t.Fatalf("shown %+v, closed %d", fd.shown, fd.closed)
	}
	if got := l.agent("alh1"); got.Activity != "blocked" {
		t.Errorf("activity %s", got.Activity)
	}
	fd.fail = errors.New("no templates")
	l.hookPayload("alh1", `{"hook_event_name":"PermissionRequest","session_id":"","tool_name":"Read","tool_input":{"file_path":"/x"}}`)
	if e := lastEvent(t, l, "alh1", "permission-error"); e != `"Error: no templates"` {
		t.Errorf("error event %s", e)
	}
	l.hookPayload("alh1", `{"hook_event_name":"PostToolUse","session_id":"","tool_name":"Read"}`)
	if fd.closed != 1 {
		t.Errorf("closed %d after the turn moved on", fd.closed)
	}
	l.hookPayload("alh1", `{"hook_event_name":"Nothing"}`)
	if fd.closed != 1 || len(fd.shown) != 2 {
		t.Errorf("a hook that changes nothing: shown %d, closed %d", len(fd.shown), fd.closed)
	}
}
