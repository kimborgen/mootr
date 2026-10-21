package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/config"
	"stam/internal/lifecycle"
	"stam/internal/push"
	"stam/internal/templates"
	"stam/internal/tmux"
)

// withPanes gives the server a lifecycle on a tmux server of the test's own, and returns a client for that server.
// bin, when set, is the tmux binary the lifecycle runs instead (a fake that fails some calls).
func withPanes(f *fixture, bin string) *tmux.Client {
	f.t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		f.t.Skip("no tmux")
	}
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	socket := "stam-test-perm-" + hex.EncodeToString(b)
	dir := f.t.TempDir()
	tc := &tmux.Client{Socket: socket, TempDir: dir}
	f.t.Cleanup(func() {
		tc.Run(context.Background(), nil, "kill-server")
		tmp := os.Getenv("TMUX_TMPDIR")
		if tmp == "" {
			tmp = "/tmp"
		}
		os.Remove(filepath.Join(tmp, "tmux-"+strconv.Itoa(os.Getuid()), socket))
	})
	lifeTmux := tc
	if bin != "" {
		lifeTmux = &tmux.Client{Socket: socket, TempDir: dir, Bin: bin}
	}
	ctx, cancel := context.WithCancel(context.Background())
	life := lifecycle.New(ctx, lifecycle.Options{DB: f.db, Tmux: lifeTmux, Settings: config.NewSettingsFile(f.home, f.cfg.Machine), Machine: f.cfg.Machine,
		Claude: claude.Env{Templates: &templates.Set{Root: f.t.TempDir(), Home: f.home}, ClaudeBin: "/bin/false"}, NetworkProbes: []string{"http://127.0.0.1:1/"},
		Streams: push.New(), PushDebounce: 20 * time.Millisecond})
	f.t.Cleanup(func() { cancel(); life.Wait() })
	f.srv.life = life
	return tc
}

// pane starts a session for id that draws screen, then echoes what is typed on its last line.
func pane(f *fixture, tc *tmux.Client, id string, screen ...string) {
	f.t.Helper()
	script := filepath.Join(f.t.TempDir(), id+".sh")
	q := make([]string, len(screen))
	for i, l := range screen {
		q[i] = "'" + strings.ReplaceAll(l, "'", `'\''`) + "'"
	}
	writeFile(f.t, script, "printf '%s\\n' "+strings.Join(q, " ")+"\nexec cat\n")
	must(f.t, tc.NewSession(context.Background(), id, f.home, tmux.Env{}, []string{"sh", script}))
	last := strings.TrimSpace(screen[len(screen)-1])
	for end := time.Now().Add(20 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if s, _ := tc.CapturePane(context.Background(), id); strings.Contains(s, last) {
			return
		}
		if time.Now().After(end) {
			f.t.Fatal("the pane never drew")
		}
	}
}

// lastLine is the pane's last line that isn't blank.
func lastLine(tc *tmux.Client, id string) string {
	s, _ := tc.CapturePane(context.Background(), id)
	lines := strings.Split(strings.TrimRight(s, "\n "), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); !ok(); time.Sleep(50 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

var readDialog = []string{"────────────────", " Read file", "  Read(/elsewhere/menu.png)",
	" ❯ 1. Yes, and keep allowing any reads outside the working directories", "   2. No, and ask again next time",
	"   3. Yes, but ask again next time", " Enter to confirm · Esc to cancel"}

const readDetails = `{"tool":"Read","input":{"file_path":"/elsewhere/menu.png"},"session":"s-1"}`

// answerDialog with a live pane: a yes for another dialog types nothing and leaves that request pending, until a hook
// names the dialog that replaced it; a parent's no types the No key, settles the request with its waits, idles the
// agent and tells it; the human's yes types the one-time Yes.
func TestPermissionDialogPane(t *testing.T) {
	f, n := permFixture(t)
	tc := withPanes(f, "")
	ctx := context.Background()
	f.sql("UPDATE agents SET activity = 'blocked', session_id = 's-1' WHERE id = 'achild'")
	pane(f, tc, "achild", readDialog...)

	other := strings.Replace(readDetails, "menu.png", "other.png", 1)
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: other, Replaces: true}))
	stale, _, _ := f.db.PendingDialog(ctx, "achild")
	if code, body := f.answerAs(sharedTok, human, stale.ID, `{"approve":true}`); code != 409 || !strings.Contains(body, "doesn't show exactly this request's action") {
		t.Errorf("a yes for another dialog: %d %s", code, body)
	}
	if f.status(stale.ID) != "pending" || f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'") != 1 || lastLine(tc, "achild") != "Enter to confirm · Esc to cancel" {
		t.Errorf("after the yes for another dialog: %s, %q", f.status(stale.ID), lastLine(tc, "achild"))
	}

	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: readDetails, Replaces: true}))
	r, _, _ := f.db.PendingDialog(ctx, "achild")
	if f.status(stale.ID) != "withdrawn" {
		t.Errorf("the hook's replacement left it %s", f.status(stale.ID))
	}
	if code, body := f.answerAs(parentTok, nil, r.ID, `{"by":"aboss","approve":false,"note":"read the copy instead"}`); code != 200 || !strings.Contains(body, `"typed":true`) {
		t.Fatalf("the parent's no: %d %s", code, body)
	}
	eventually(t, "the No key", func() bool { return lastLine(tc, "achild") == "2" })
	if f.status(r.ID) != "denied" || f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'") != 0 {
		t.Errorf("after the no: %s", f.status(r.ID))
	}
	if a := f.agentObj("achild"); a.Activity != "idle" || deref(a.ActivityDetail) != "dialog denied" {
		t.Errorf("agent %s %s", a.Activity, deref(a.ActivityDetail))
	}
	if !hasNotice(n, "achild", "read the copy instead") {
		t.Errorf("notices %q", n.all())
	}

	f.sql("UPDATE agents SET activity = 'blocked' WHERE id = 'achild'")
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: readDetails, Replaces: true}))
	r2, _, _ := f.db.PendingDialog(ctx, "achild")
	if code, body := f.answerAs(sharedTok, human, r2.ID, `{"approve":true}`); code != 200 || !strings.Contains(body, `"status":"approved"`) {
		t.Fatalf("the human's yes: %d %s", code, body)
	}
	eventually(t, "the Yes key", func() bool { return lastLine(tc, "achild") == "23" })
	if f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'") != 0 {
		t.Error("waits after the yes")
	}
}

var bashDialog = []string{"────────────────", " Bash command", "", "  Bash(rm -rf build)", "", "  Remove the build folder", "",
	" Do you want to proceed?", " ❯ 1. Yes", "   2. No, and tell Claude what to do differently (esc)", " Enter to confirm · Esc to cancel"}

// A dialog the Go daemon can't route (a reviewer on another machine) replaces one with a request: the old request stays
// pending, and a deny of it types nothing into the new dialog and leaves it pending. The timer and a reviewer's
// escalation still send it to the human: what the screen shows never closes a request.
func TestPermissionStaleDialogPane(t *testing.T) {
	f, _ := permFixture(t)
	tc := withPanes(f, "")
	ctx := context.Background()
	f.sql("UPDATE agents SET activity = 'blocked', session_id = 's-1' WHERE id = 'achild'")
	pane(f, tc, "achild", readDialog...)
	read := claude.Dialog{Action: "Claude Code asks to allow Read", Details: readDetails, Replaces: true}
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), read))
	a, _, _ := f.db.PendingDialog(ctx, "achild")

	f.sql("UPDATE agents SET parent_id = 'afar' WHERE id = 'achild'")
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afar', 'far', 'm2', '2026-01-01')")
	tc.Run(ctx, nil, "kill-session", "-t", "=achild")
	pane(f, tc, "achild", bashDialog...)
	err := f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Bash",
		Details: `{"tool":"Bash","input":{"command":"rm -rf build"},"session":"s-1"}`, Replaces: true})
	var he *Error
	if !errors.As(err, &he) || he.Status != 501 || f.status(a.ID) != "pending" {
		t.Fatalf("the new dialog: %v, the old request %s", err, f.status(a.ID))
	}
	humanMail := func() int { return f.count("SELECT count(*) FROM mail_recipients WHERE agent_id = 'human'") }
	mails := humanMail()

	if code, body := f.answerAs(sharedTok, human, a.ID, `{"approve":false}`); code != 409 || !strings.Contains(body, "can't confirm") {
		t.Errorf("the deny: %d %s", code, body)
	}
	if f.status(a.ID) != "pending" || lastLine(tc, "achild") != "Enter to confirm · Esc to cancel" {
		t.Errorf("after the deny: %s, %q", f.status(a.ID), lastLine(tc, "achild"))
	}

	// The read dialog's request while the Bash one shows: the timer sends it to the human.
	f.sql("UPDATE agents SET parent_id = 'aboss' WHERE id = 'achild'")
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"dialogEscalateMinutes":0}`)
	must(t, f.srv.escalateStaleDialogs(ctx))
	writeFile(t, filepath.Join(f.home, "settings.json"), `{}`)
	if aud := f.count1("SELECT audience FROM permission_requests WHERE id = '" + a.ID + "'"); aud != "human" || f.status(a.ID) != "pending" || humanMail() != mails+1 {
		t.Errorf("the timer left it %s %s, %d human mails, was %d", f.status(a.ID), aud, humanMail(), mails)
	}
	// And a reviewer's escalation of a new one.
	must(t, f.srv.DialogClosed(ctx, f.agentObj("achild")))
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), read))
	sent, _, _ := f.db.PendingDialog(ctx, "achild")
	if code, body := f.answerAs(parentTok, nil, sent.ID, `{"by":"aboss","decision":"escalate","note":"looks risky"}`); code != 200 || !strings.Contains(body, `"audience":"human"`) {
		t.Errorf("the escalation: %d %s", code, body)
	}
	if f.status(sent.ID) != "pending" || humanMail() != mails+2 || lastLine(tc, "achild") != "Enter to confirm · Esc to cancel" {
		t.Errorf("after the escalation: %s, %d human mails, was %d; %q", f.status(sent.ID), humanMail(), mails, lastLine(tc, "achild"))
	}
}

// editDialog is a dialog with these rows under its header.
func editDialog(rows ...string) []string {
	return append(append([]string{"────────────────", " Edit file", ""}, rows...), "", " Do you want to proceed?", " ❯ 1. Yes",
		"   2. No, and tell Claude what to do differently (esc)", " Enter to confirm · Esc to cancel")
}

// A screen stam can't tie to a request is unsure, whatever it shows: a deny types nothing and answers 409 with the
// request pending, and the timer and a reviewer's escalation send it to the human as TS does.
// Once the dialog is drawn whole, the deny types its key.
func TestPermissionUnsureDialogPane(t *testing.T) {
	f, _ := permFixture(t)
	tc := withPanes(f, "")
	ctx := context.Background()
	f.sql("UPDATE agents SET activity = 'blocked', session_id = 's-1' WHERE id = 'achild'")
	other := strings.Replace(readDetails, "menu.png", "other.png", 1)
	for _, c := range []struct {
		name, details string
		screen        []string
	}{
		{"a message-only request", `{"message":"Claude needs your permission to use Bash","session":"s-1"}`, bashDialog},
		{"an MCP tool's request", `{"tool":"mcp__github__create_issue","input":{"title":"x"},"session":"s-1"}`,
			[]string{"────────────────", " Tool use", "", `  github - create_issue(title: "x") (MCP)`, "", " ❯ 1. Yes", "   2. No, and tell Claude what to do differently (esc)", " Enter to confirm · Esc to cancel"}},
		{"a shortened target", other, append([]string{readDialog[0], readDialog[1], "  Read(/elsewhere/oth…)"}, readDialog[3:]...)},
		{"no header", other, append([]string{"older output"}, readDialog[2:]...)},
		{"a body mid-redraw", other, append([]string{readDialog[0], readDialog[1], ""}, readDialog[3:]...)},
		{"a diff row shaped like a call", `{"tool":"Edit","input":{"file_path":"/elsewhere/a.txt"},"session":"s-1"}`,
			editDialog("  Update(/elsewhere/a.txt)", "", "  12 doThing(a, b)")},
		{"a description with parentheses", `{"tool":"Bash","input":{"command":"rm -rf dist"},"session":"s-1"}`,
			editDialog("  Bash(rm -rf build)", "", "  Remove the build (output) folder")},
		{"a target wrapped after its )", `{"tool":"Edit","input":{"file_path":"/elsewhere/name)/file.txt"},"session":"s-1"}`,
			editDialog("  Update(/elsewhere/name)", "  /file.txt)")},
		{"a wrap that looks like an option", `{"tool":"Edit","input":{"file_path":"/elsewhere/name)1. file.txt"},"session":"s-1"}`,
			editDialog("  Update(/elsewhere/name)", "  1. file.txt)")},
		{"a Grep shown as Search", `{"tool":"Grep","input":{"pattern":"foo","path":"/elsewhere"},"session":"s-1"}`,
			editDialog(`  Search(pattern: "foo", path: "/elsewhere")`)},
		{"another call", `{"tool":"Bash","input":{"command":"rm -rf dist"},"session":"s-1"}`, bashDialog},
	} {
		tc.Run(ctx, nil, "kill-session", "-t", "=achild")
		pane(f, tc, "achild", c.screen...)
		last := lastLine(tc, "achild")
		d := claude.Dialog{Action: "Claude Code asks to allow it", Details: c.details, Replaces: true}
		must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), d))
		r, _, _ := f.db.PendingDialog(ctx, "achild")
		if code, body := f.answerAs(parentTok, nil, r.ID, `{"by":"aboss","approve":false}`); code != 409 || !strings.Contains(body, "can't confirm") {
			t.Errorf("%s: the deny %d %s", c.name, code, body)
		}
		if f.status(r.ID) != "pending" || lastLine(tc, "achild") != last {
			t.Errorf("%s: after the deny %s, %q", c.name, f.status(r.ID), lastLine(tc, "achild"))
		}
		writeFile(t, filepath.Join(f.home, "settings.json"), `{"dialogEscalateMinutes":0}`)
		must(t, f.srv.escalateStaleDialogs(ctx))
		writeFile(t, filepath.Join(f.home, "settings.json"), `{}`)
		if aud := f.count1("SELECT audience FROM permission_requests WHERE id = '" + r.ID + "'"); aud != "human" || f.status(r.ID) != "pending" {
			t.Errorf("%s: the timer left it %s %s", c.name, f.status(r.ID), aud)
		}
		must(t, f.srv.DialogClosed(ctx, f.agentObj("achild")))
		must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), d))
		r2, _, _ := f.db.PendingDialog(ctx, "achild")
		if code, body := f.answerAs(parentTok, nil, r2.ID, `{"by":"aboss","decision":"escalate","note":"looks risky"}`); code != 200 || !strings.Contains(body, `"audience":"human"`) {
			t.Errorf("%s: the escalation %d %s", c.name, code, body)
		}
		must(t, f.srv.DialogClosed(ctx, f.agentObj("achild")))
	}
	tc.Run(ctx, nil, "kill-session", "-t", "=achild")
	pane(f, tc, "achild", readDialog...)
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: readDetails, Replaces: true}))
	r, _, _ := f.db.PendingDialog(ctx, "achild")
	if code, body := f.answerAs(parentTok, nil, r.ID, `{"by":"aboss","approve":false}`); code != 200 || !strings.Contains(body, `"typed":true`) {
		t.Fatalf("the deny on the whole dialog: %d %s", code, body)
	}
	eventually(t, "the No key", func() bool { return lastLine(tc, "achild") == "2" })
}

// A tmux call that fails while answering a dialog (killed, as a timeout would end it) types nothing, answers 409, and
// leaves the request pending: the screen read, and the pane lookup before it. Only tmux saying there is no such session
// (exit status 1) closes it.
func TestPermissionDialogTmuxFails(t *testing.T) {
	f, _ := permFixture(t)
	real, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("no tmux")
	}
	dir := t.TempDir()
	fail, fake := filepath.Join(dir, "fail"), filepath.Join(dir, "tmux")
	// The fail file names the tmux command to fail and how: "kill" (no exit status, as a timeout ends it) or a status.
	writeFile(t, fake, "#!/bin/sh\nread cmd how < "+fail+"\nfor a in \"$@\"; do\n  if [ \"$a\" = \"$cmd\" ]; then\n"+
		"    [ \"$how\" = kill ] && kill -9 $$\n    exit \"$how\"\n  fi\ndone\nexec "+real+" \"$@\"\n")
	writeFile(t, fail, "none 0")
	must(t, os.Chmod(fake, 0o700))
	tc := withPanes(f, fake)
	ctx := context.Background()
	f.sql("UPDATE agents SET activity = 'blocked', session_id = 's-1' WHERE id = 'achild'")
	pane(f, tc, "achild", readDialog...)
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: readDetails, Replaces: true}))
	r, _, _ := f.db.PendingDialog(ctx, "achild")
	for _, cmd := range []string{"capture-pane", "display-message"} {
		writeFile(t, fail, cmd+" kill")
		if code, body := f.answerAs(sharedTok, human, r.ID, `{"approve":true}`); code != 409 || !strings.Contains(body, "may not have been typed") {
			t.Errorf("a failed %s: %d %s", cmd, code, body)
		}
		if f.status(r.ID) != "pending" || f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'") != 1 {
			t.Errorf("after a failed %s: %s", cmd, f.status(r.ID))
		}
	}
	if got := f.count("SELECT count(*) FROM events WHERE type = 'permission:withdrawn'"); got != 0 {
		t.Errorf("%d withdrawals", got)
	}
	// The timer can't read the screen when the request is due: it goes to the human as in TS, not retried forever.
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"dialogEscalateMinutes":0}`)
	must(t, f.srv.escalateStaleDialogs(ctx))
	if aud := f.count1("SELECT audience FROM permission_requests WHERE id = '" + r.ID + "'"); aud != "human" {
		t.Errorf("the timer with a failing tmux left it with %s", aud)
	}
	// The pane lookup's tmux says the session is gone: nothing is on screen to answer.
	writeFile(t, fail, "display-message 1")
	if code, body := f.answerAs(sharedTok, human, r.ID, `{"approve":true}`); code != 409 || !strings.Contains(body, "no longer shows this dialog") {
		t.Errorf("no session: %d %s", code, body)
	}
	if f.status(r.ID) != "withdrawn" || lastLine(tc, "achild") != "Enter to confirm · Esc to cancel" {
		t.Errorf("after no session: %s", f.status(r.ID))
	}
}
