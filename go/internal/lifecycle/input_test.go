package lifecycle

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"stam/internal/db"
	"stam/internal/tmux"
)

// boxPane starts a session for id running the fake input box (testdata/fake-box.mjs) with env, and returns the file
// its submitted lines go to.
func (l *live) boxPane(id string, env ...string) string {
	l.t.Helper()
	script, err := filepath.Abs("testdata/fake-box.mjs")
	if err != nil {
		l.t.Fatal(err)
	}
	log := filepath.Join(l.base, id+".submitted")
	argv := append(append([]string{"env", "LOG=" + log}, env...), "node", script)
	if err := l.tmux.NewSession(l.ctx, id, l.work, tmux.Env{}, argv); err != nil {
		l.t.Fatal(err)
	}
	l.until("the box to draw", func() bool { return l.screenHas(id, "──────") })
	return log
}

// killServer stops the test's tmux server and waits until no client reaches it, so the next session starts a new
// server rather than reaching the old one as it exits.
func (l *live) killServer() {
	l.t.Helper()
	l.tmux.Run(l.ctx, nil, "kill-server")
	l.until("the old tmux server gone", func() bool {
		r := l.tmux.Run(l.ctx, nil, "list-sessions")
		return r.Status != 0 && (strings.Contains(r.Stderr, "no server running") || strings.Contains(r.Stderr, "error connecting"))
	})
}

func submitted(t *testing.T, log string) string {
	t.Helper()
	b, _ := os.ReadFile(log)
	return string(b)
}

// typer is an idle agent of the claude harness in session s-1.
func (l *live) typer(id string) db.Agent {
	l.waiter(id)
	l.set(id, db.Field{Col: "activity", Val: "idle"}, db.Field{Col: "session_id", Val: "s-1"})
	return l.agent(id)
}

// TestTypeLiteralInput: an approved line goes into an empty box and Enter follows once the box shows it exactly; a
// completion menu gets one Esc first; a busy agent, a turn on screen or a draft get nothing; proceed saying no, or a
// pane replaced before Enter, takes the text back out and sends no Enter.
func TestTypeLiteralInput(t *testing.T) {
	l := newLive(t)
	a := l.typer("ati1")
	if got := l.life.TypeLiteralInput(l.ctx, a, "no pane", nil); got != "busy" {
		t.Errorf("no pane: %s", got)
	}
	log := l.boxPane("ati1")
	if got := l.life.TypeLiteralInput(l.ctx, a, "git status; echo 'done'", nil); got != "typed" {
		t.Fatalf("typed: %s", got)
	}
	l.until("the line submitted", func() bool { return submitted(t, log) == "git status; echo 'done'\n" })
	if text, ok := l.life.InputText(l.ctx, a); !ok || text != "" {
		t.Errorf("the box after it: %q %v", text, ok)
	}

	working := a
	working.Activity = "working"
	if got := l.life.TypeLiteralInput(l.ctx, working, "x", nil); got != "busy" {
		t.Errorf("a working agent: %s", got)
	}
	codex := a
	codex.Harness = "codex"
	if got := l.life.TypeLiteralInput(l.ctx, codex, "x", nil); got != "busy" {
		t.Errorf("another harness: %s", got)
	}

	// proceed says no: the text comes back out, and nothing is submitted.
	if got := l.life.TypeLiteralInput(l.ctx, a, "rm -rf build", func(func() bool) bool { return false }); got != "cancelled" {
		t.Errorf("cancelled: %s", got)
	}
	if text, ok := l.life.InputText(l.ctx, a); !ok || text != "" || submitted(t, log) != "git status; echo 'done'\n" {
		t.Errorf("after the cancel: %q %v, submitted %q", text, ok, submitted(t, log))
	}

	l.waiter("ati2")
	l.set("ati2", db.Field{Col: "activity", Val: "idle"})
	l.boxPane("ati2", "ABOVE=✶ Blanching… (13s · ↓ 472 tokens)")
	if got := l.life.TypeLiteralInput(l.ctx, l.agent("ati2"), "x", nil); got != "busy" {
		t.Errorf("a turn on screen: %s", got)
	}
	l.waiter("ati3")
	l.set("ati3", db.Field{Col: "activity", Val: "idle"})
	l.boxPane("ati3", "BOX=the human's draft")
	if got := l.life.TypeLiteralInput(l.ctx, l.agent("ati3"), "x", nil); got != "draft" {
		t.Errorf("a draft: %s", got)
	}
	if text, _ := l.life.InputText(l.ctx, l.agent("ati3")); text != "the human's draft" {
		t.Errorf("the draft became %q", text)
	}

	// A completion menu under the box takes one Esc, then Enter submits the text, not the menu's row.
	a4 := l.typer("ati4")
	log4 := l.boxPane("ati4", "MENU=1")
	if got := l.life.TypeLiteralInput(l.ctx, a4, "/he", nil); got != "typed" {
		t.Fatalf("with a menu: %s", got)
	}
	l.until("the line submitted", func() bool { return submitted(t, log4) == "/he\n" })

	// The pane replaced right before Enter, on a new tmux server whose first pane has the same id: no Enter goes to it,
	// and the caller, whose claim went through, hears "unsent".
	a5 := l.typer("ati5")
	l.boxPane("ati5")
	var log5 string
	got := l.life.TypeLiteralInput(l.ctx, a5, "make", func(func() bool) bool {
		l.killServer()
		log5 = l.boxPane("ati5", "BOX=make")
		return true
	})
	if got != "unsent" {
		t.Errorf("a replaced pane: %s", got)
	}
	if submitted(t, log5) != "" {
		t.Errorf("submitted to the new pane: %q", submitted(t, log5))
	}
}

// TestTypeLiteralInputChangedBeforeEnter: the box changes after the typing was checked and before Enter (a key the agent
// or the human typed into it): the re-read right before Enter (stillTyped) refuses, nothing is sent, and the result is
// "failed", so the approval is held, not sent with the extra text (S-3830).
func TestTypeLiteralInputChangedBeforeEnter(t *testing.T) {
	l := newLive(t)
	a := l.typer("atc1")
	l.boxPane("atc1")
	var log string
	got := l.life.TypeLiteralInput(l.ctx, a, "make", func(stillTyped func() bool) bool {
		l.killServer()
		log = l.boxPane("atc1", "BOX=make x")
		return stillTyped()
	})
	if got != "failed" {
		t.Errorf("a box changed before Enter: %s", got)
	}
	if submitted(t, log) != "" {
		t.Errorf("submitted the box with the extra text: %q", submitted(t, log))
	}
}

// TestTypeLiteralInputVim: with vim keys in normal mode, i enters insert mode first; the text and Enter follow.
func TestTypeLiteralInputVim(t *testing.T) {
	l := newLive(t)
	a := l.typer("atv1")
	log := l.boxPane("atv1", "VIM=normal")
	if got := l.life.TypeLiteralInput(l.ctx, a, "ls", nil); got != "typed" {
		t.Fatalf("typed: %s", got)
	}
	l.until("the line submitted", func() bool { return submitted(t, log) == "ls\n" })
	if !l.screenHas("atv1", "-- INSERT --") {
		t.Error("not in insert mode")
	}
}

// TestTypeLiteralInputLeftover: an erase the terminal cut short leaves the start of stam's text in the box; the next
// attempt in the same session clears exactly that and types; in another session it is a draft.
func TestTypeLiteralInputLeftover(t *testing.T) {
	l := newLive(t)
	a := l.typer("atl1")
	log := l.boxPane("atl1", "IGNORE_BS=3")
	if got := l.life.TypeLiteralInput(l.ctx, a, "make test", func(func() bool) bool { return false }); got != "cancelled" {
		t.Fatalf("cancelled: %s", got)
	}
	if text, _ := l.life.InputText(l.ctx, a); text != "mak" {
		t.Fatalf("left in the box: %q", text)
	}
	if got := l.life.TypeLiteralInput(l.ctx, a, "make lint", nil); got != "typed" {
		t.Fatalf("after the leftover: %s", got)
	}
	l.until("the line submitted", func() bool { return submitted(t, log) == "make lint\n" })
	if e := lastEvent(t, l, "atl1", "input:cleared"); e != `{"text":"mak"}` {
		t.Errorf("cleared event %s", e)
	}

	// The same leftover in another harness session is someone's draft.
	b := l.typer("atl2")
	l.boxPane("atl2", "IGNORE_BS=3")
	if got := l.life.TypeLiteralInput(l.ctx, b, "make test", func(func() bool) bool { return false }); got != "cancelled" {
		t.Fatalf("cancelled: %s", got)
	}
	l.set("atl2", db.Field{Col: "session_id", Val: "s-2"})
	if got := l.life.TypeLiteralInput(l.ctx, l.agent("atl2"), "make lint", nil); got != "draft" {
		t.Errorf("another session: %s", got)
	}
	if text, _ := l.life.InputText(l.ctx, b); text != "mak" {
		t.Errorf("the box: %q", text)
	}
}

// TestInputText: the box's text as typed, a bash-mode box with its !, and nothing without a box.
func TestInputText(t *testing.T) {
	l := newLive(t)
	a := l.typer("ait1")
	if _, ok := l.life.InputText(l.ctx, a); ok {
		t.Error("text with no pane")
	}
	l.pane("ait1", "out", "──────────", "! ls -la", "──────────", "  ? for shortcuts")
	if text, ok := l.life.InputText(l.ctx, a); !ok || text != "!ls -la" {
		t.Errorf("bash mode: %q %v", text, ok)
	}
}

// fakeInputs records what the hooks report of suggested input.
type fakeInputs struct {
	mu      sync.Mutex
	prompts []string
	typed   []string
	fail    error
	// withdrawn is each agent whose pending suggestions were withdrawn, with the note.
	withdrawn []string
}

func (f *fakeInputs) PromptSubmitted(_ context.Context, id, prompt string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prompts = append(f.prompts, id+": "+prompt)
}

func (f *fakeInputs) TypeHeldInput(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.typed = append(f.typed, id)
	return f.fail
}

// WithdrawPending records the agents whose pending suggestions were withdrawn with a note.
func (f *fakeInputs) WithdrawPending(_ context.Context, a db.Agent, note string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.withdrawn = append(f.withdrawn, a.ID+": "+note)
	return nil
}

func (f *fakeInputs) seen() (prompts, typed int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts), len(f.typed)
}

// TestHookInputs: a UserPromptSubmit hook's prompt is checked against a typed suggestion, and a hook that idles the
// agent types its held approval in the background, a failure being a permission-error event; other hooks do neither.
func TestHookInputs(t *testing.T) {
	l := newLive(t)
	l.waiter("ahi1")
	fi := &fakeInputs{fail: errors.New("tmux gone")}
	l.life.SetInputs(fi)
	l.hookPayload("ahi1", `{"hook_event_name":"UserPromptSubmit","session_id":"","prompt":"git status"}`)
	if p, ty := fi.seen(); p != 1 || ty != 0 || fi.prompts[0] != "ahi1: git status" {
		t.Fatalf("after the prompt: %v, %d typed", fi.prompts, ty)
	}
	l.hookPayload("ahi1", `{"hook_event_name":"UserPromptSubmit","session_id":"","prompt":5}`)
	l.hookPayload("ahi1", `{"hook_event_name":"Stop","session_id":""}`)
	l.until("the held input typed", func() bool { _, ty := fi.seen(); return ty == 1 })
	l.until("the failure recorded", func() bool { return lastEvent(t, l, "ahi1", "permission-error") == `"Error: tmux gone"` })
	l.hookPayload("ahi1", `{"hook_event_name":"PreToolUse","session_id":"","tool_name":"Read"}`)
	if p, ty := fi.seen(); p != 1 || ty != 1 {
		t.Errorf("other hooks: %d prompts, %d typed", p, ty)
	}
}

// TestRestartKeepsPendingInput: a restart stops the harness and keeps the agent's pending suggestion; a real stop
// withdraws it (S-3830). The withdrawal is the Inputs hook's, so the fake records what it was asked.
func TestRestartKeepsPendingInput(t *testing.T) {
	l := newLive(t)
	a := l.waiter("arp1")
	fi := &fakeInputs{}
	l.life.SetInputs(fi)
	if _, _, err := l.db.CreateInputRequest(l.ctx, db.NewInput{AgentID: a.ID, Reason: "push", Text: "git push", SHA256: "x"}); err != nil {
		t.Fatal(err)
	}
	if err := l.life.quitHarness(l.ctx, a, "restarting: model switch"); err != nil {
		t.Fatal(err)
	}
	if len(fi.withdrawn) != 0 {
		t.Fatalf("a restart withdrew the pending suggestion: %v", fi.withdrawn)
	}
	if err := l.life.stopForGood(l.ctx, a, "shut down"); err != nil {
		t.Fatal(err)
	}
	if len(fi.withdrawn) != 1 || fi.withdrawn[0] != a.ID+": the agent was shut down" {
		t.Errorf("a shut-down didn't withdraw the pending suggestion: %v", fi.withdrawn)
	}
}
