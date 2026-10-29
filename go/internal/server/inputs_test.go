package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/auth"
	"stam/internal/tmux"
)

var trusted = map[string]string{"X-Stam-Test-Human": humanKey, "X-Stam-Human": "1"}

// inputFixture is permFixture with the test human's key, a barrier folder for the typing (returned), and a lifecycle
// on a tmux server of the test's own; achild is idle in harness session s-1.
func inputFixture(t *testing.T) (*fixture, *notices, *tmux.Client, string) {
	barrier := t.TempDir()
	f := newFixture(t, map[string]string{"STAM_TEST_HUMAN_KEY": humanKey, "STAM_TEST_INPUT_BARRIER": barrier})
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id IN ('aboss', 'achild')")
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(parentTok))
	f.sql("UPDATE agents SET activity = 'idle', session_id = 's-1' WHERE id = 'achild'")
	n := &notices{}
	f.srv.noticeHook = n.add
	return f, n, withPanes(f, ""), barrier
}

// boxPane starts a session for id running lifecycle's fake input box with env, and returns the file its submitted
// lines go to.
func boxPane(f *fixture, tc *tmux.Client, id string, env ...string) string {
	f.t.Helper()
	script, err := filepath.Abs("../lifecycle/testdata/fake-box.mjs")
	must(f.t, err)
	log := filepath.Join(f.t.TempDir(), id+".submitted")
	argv := append(append([]string{"env", "LOG=" + log}, env...), "node", script)
	must(f.t, tc.NewSession(context.Background(), id, f.home, tmux.Env{}, argv))
	eventually(f.t, "the box to draw", func() bool {
		s, _ := tc.CapturePane(context.Background(), id)
		return strings.Contains(s, "──────")
	})
	return log
}

func readLog(log string) string {
	b, _ := os.ReadFile(log)
	return string(b)
}

func (f *fixture) suggest(text string) (int, string) {
	f.t.Helper()
	rec := f.sendH("POST", "/api/suggest-input", agentTok, nil, `{"text":`+strconv.Quote(text)+`,"reason":"to see the tree"}`)
	return rec.Code, rec.Body.String()
}

func (f *fixture) suggestID(text string) string {
	f.t.Helper()
	rec := f.sendH("POST", "/api/suggest-input", agentTok, nil, `{"text":`+strconv.Quote(text)+`,"reason":"to see the tree"}`)
	if rec.Code != 200 {
		f.t.Fatalf("suggest %q: %d %s", text, rec.Code, rec.Body.String())
	}
	return f.body(rec).Text("id")
}

func shaOf(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func (f *fixture) approveInput(id, text string) (int, string) {
	f.t.Helper()
	return f.answerAs("", trusted, id, `{"approve":true,"text_sha256":"`+shaOf(text)+`"}`)
}

func (f *fixture) lastEvent(agent, typ string) string {
	return f.count1("SELECT coalesce(data, '') FROM events WHERE agent_id = '" + agent + "' AND type = '" + typ + "' ORDER BY id DESC LIMIT 1")
}

// TestSuggestInput: only an agent's own token suggests, for a Claude Code agent, one line of text; the suggestion
// waits on the human, is mailed to the human and the reviewers, and replaces the agent's earlier one. A reviewer on
// another machine is a 501 before anything is written.
func TestSuggestInput(t *testing.T) {
	f, _, _, _ := inputFixture(t)
	if rec := f.sendH("POST", "/api/suggest-input", sharedTok, nil, `{"text":"ls"}`); rec.Code != 403 {
		t.Errorf("the shared token: %d %s", rec.Code, rec.Body.String())
	}
	if code, body := f.suggest("ls\nrm -rf /"); code != 400 || !strings.Contains(body, "one line with no control characters") {
		t.Errorf("two lines: %d %s", code, body)
	}
	if code, body := f.suggest(""); code != 400 || !strings.Contains(body, "the text is empty") {
		t.Errorf("empty: %d %s", code, body)
	}
	id := f.suggestID("git status")
	if got := f.count1("SELECT kind || ' ' || status || ' ' || audience || ' ' || text || ' ' || sha256 FROM permission_requests WHERE id = '" + id + "'"); got != "input pending human git status "+shaOf("git status") {
		t.Errorf("the request: %s", got)
	}
	if f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild' AND kind = 'human' AND target = '"+id+"'") != 1 {
		t.Error("no wait on the human")
	}
	if got := f.count1("SELECT subject FROM mail WHERE permission_id = '" + id + "'"); got != "Input for child: git status" {
		t.Errorf("subject %q", got)
	}
	if got := f.count1("SELECT group_concat(agent_id) FROM (SELECT agent_id FROM mail_recipients JOIN mail ON mail.id = mail_id WHERE permission_id = '" + id + "' ORDER BY agent_id)"); got != "aboss,human" {
		t.Errorf("recipients %s", got)
	}
	if got := f.lastEvent("achild", "permission:requested"); got != `{"id":"`+id+`","action":"Type suggested input","kind":"input"}` {
		t.Errorf("event %s", got)
	}

	next := f.suggestID("git log")
	if f.status(id) != "withdrawn" || f.status(next) != "pending" {
		t.Errorf("the replaced one %s, the new one %s", f.status(id), f.status(next))
	}
	if got := f.lastEvent("achild", "permission:withdrawn"); got != `{"id":"`+id+`","note":"a newer suggestion replaced it"}` {
		t.Errorf("withdrawn event %s", got)
	}
	if f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild' AND kind = 'human'") != 1 {
		t.Error("the replaced one's wait stayed")
	}
	if f.count("SELECT count(*) FROM mail_recipients WHERE agent_id = 'human' AND withdrawn_at IS NOT NULL AND mail_id IN (SELECT id FROM mail WHERE permission_id = '"+id+"')") == 0 {
		t.Error("the replaced one's mail wasn't withdrawn from the human")
	}

	// A reviewer on another machine: nothing is written.
	f.sql("UPDATE agents SET parent_id = 'afar' WHERE id = 'achild'")
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afar', 'far', 'm2', '2026-01-01')")
	before := f.count("SELECT count(*) FROM permission_requests")
	if code, body := f.suggest("make"); code != 501 || f.count("SELECT count(*) FROM permission_requests") != before || f.status(next) != "pending" {
		t.Errorf("a reviewer on a peer: %d %s", code, body)
	}
	f.sql("UPDATE agents SET parent_id = 'aboss', harness = 'codex' WHERE id = 'achild'")
	if code, body := f.suggest("make"); code != 403 || !strings.Contains(body, "runs codex") {
		t.Errorf("a codex agent: %d %s", code, body)
	}
}

// TestDenyInput: a reviewer or the human denies a suggestion like any request; only the human, as trustedHuman
// proves it, approves one: not a reviewer, not the shared token's human, not a forwarded approval.
func TestDenyInput(t *testing.T) {
	f, n, _, _ := inputFixture(t)
	id := f.suggestID("git status")
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","approve":true}`); code != 403 || !strings.Contains(body, "only the human approves suggested input") {
		t.Errorf("a reviewer's yes: %d %s", code, body)
	}
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"approve"}`); code != 409 || !strings.Contains(body, "only the human approves suggested input") {
		t.Errorf("a reviewer's decision approve: %d %s", code, body)
	}
	if code, body := f.answerAs(sharedTok, human, id, `{"approve":true,"text_sha256":"`+shaOf("git status")+`"}`); code != 403 || !strings.Contains(body, "only the human approves suggested input") {
		t.Errorf("the shared token's human: %d %s", code, body)
	}
	if code, body := f.answerAs(peerTok, map[string]string{"X-Stam-Local": "1"}, id, `{"approve":true,"text_sha256":"`+shaOf("git status")+`"}`); code != 409 || !strings.Contains(body, "never accepted") {
		t.Errorf("a forwarded approval: %d %s", code, body)
	}
	if f.status(id) != "pending" {
		t.Fatalf("after the refusals: %s", f.status(id))
	}
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","approve":false,"note":"not now"}`); code != 200 || !strings.Contains(body, `"status":"denied"`) {
		t.Fatalf("the parent's no: %d %s", code, body)
	}
	if !hasNotice(n, "achild", "not now") || f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'") != 0 {
		t.Errorf("after the no: notices %q", n.all())
	}
	if got := f.lastEvent("achild", "permission:answered"); got != `{"id":"`+id+`","approve":false,"by":"aboss","typed":false}` {
		t.Errorf("event %s", got)
	}
	if code, body := f.approveInput(id, "git status"); code != 409 || !strings.Contains(body, "already denied") {
		t.Errorf("approving a denied one: %d %s", code, body)
	}
	// The human's proof beside the shared token is the human too; beside an agent's token it is not.
	if code, body := f.answerAs(sharedTok, trusted, id, `{"approve":true,"text_sha256":"`+shaOf("git status")+`"}`); code != 409 || !strings.Contains(body, "already denied") {
		t.Errorf("the human with the shared token, approving a denied one: %d %s", code, body)
	}
	if code, body := f.answerAs(parentTok, trusted, id, `{"by":"aboss","approve":true,"text_sha256":"`+shaOf("git status")+`"}`); code != 403 || !strings.Contains(body, "only the human approves suggested input") {
		t.Errorf("an agent's token with the human's proof: %d %s", code, body)
	}
}

// TestApproveInput: the human's approval of the text they saw is typed into the agent's empty box, and submitted; a
// wrong hash or a replay is refused. A busy agent holds it until its next idle; a draft in the box holds it and is
// named, once.
func TestApproveInput(t *testing.T) {
	f, n, tc, _ := inputFixture(t)
	log := boxPane(f, tc, "achild")
	id := f.suggestID("git status")
	if code, body := f.answerAs("", trusted, id, `{"approve":true,"text_sha256":"`+shaOf("git log")+`"}`); code != 409 || !strings.Contains(body, "doesn't match") {
		t.Errorf("another text's hash: %d %s", code, body)
	}
	code, body := f.approveInput(id, "git status")
	if code != 200 || !strings.Contains(body, `"typed":true,"outcome":"typed"`) || !strings.Contains(body, `"status":"approved"`) {
		t.Fatalf("the approval: %d %s", code, body)
	}
	eventually(t, "the line submitted", func() bool { return readLog(log) == "git status\n" })
	if got := f.lastEvent("achild", "permission:answered"); got != `{"id":"`+id+`","approve":true,"by":"human","kind":"input"}` {
		t.Errorf("answered %s", got)
	}
	if f.lastEvent("achild", "input:typed") != `{"id":"`+id+`"}` || !hasNotice(n, "achild", "typed into your input as written") {
		t.Errorf("typed: notices %q", n.all())
	}
	if code, body := f.approveInput(id, "git status"); code != 409 || !strings.Contains(body, "already approved") {
		t.Errorf("a replay: %d %s", code, body)
	}

	// Busy: held, and typed at the next idle.
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	busy := f.suggestID("make lint")
	if code, body := f.approveInput(busy, "make lint"); code != 200 || !strings.Contains(body, `"outcome":"held","why":"busy"`) {
		t.Fatalf("busy: %d %s", code, body)
	}
	if f.status(busy) != "held" || !hasNotice(n, "achild", "End your turn so stam can type it") {
		t.Errorf("held: %s, notices %q", f.status(busy), n.all())
	}
	if code, body := f.approveInput(busy, "make lint"); code != 200 || !strings.Contains(body, `"outcome":"held"`) {
		t.Errorf("a second tap: %d %s", code, body)
	}
	f.sql("UPDATE agents SET activity = 'idle' WHERE id = 'achild'")
	must(t, f.srv.TypeHeldInput(context.Background(), "achild"))
	eventually(t, "the held line submitted", func() bool { return readLog(log) == "git status\nmake lint\n" })
	if f.status(busy) != "approved" {
		t.Errorf("after the idle: %s", f.status(busy))
	}

	// A draft: held, named on the card, and told once.
	tc.Run(context.Background(), nil, "kill-session", "-t", "=achild")
	boxPane(f, tc, "achild", "BOX=my draft")
	draft := f.suggestID("make test")
	if code, body := f.approveInput(draft, "make test"); code != 200 || !strings.Contains(body, `"why":"draft"`) {
		t.Fatalf("a draft: %d %s", code, body)
	}
	if got := f.count1("SELECT note FROM permission_requests WHERE id = '" + draft + "'"); got != "box:my draft" {
		t.Errorf("the card's box %q", got)
	}
	if !hasNotice(n, "achild", "your input box holds `my draft`") {
		t.Errorf("notices %q", n.all())
	}
	if got := f.lastEvent("achild", "input:held"); got != `{"id":"`+draft+`","why":"draft","box":"my draft"}` {
		t.Errorf("held event %s", got)
	}
	must(t, f.srv.TypeHeldInput(context.Background(), "achild"))
	if f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'input:held' AND data LIKE '%draft%'") != 1 {
		t.Error("the draft was told again")
	}
	// Busy again: the card drops the box text.
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	f.srv.ExpireInputs(context.Background())
	if got := f.count1("SELECT coalesce(note, '') FROM permission_requests WHERE id = '" + draft + "'"); got != "" {
		t.Errorf("the card's box after going busy %q", got)
	}
}

// TestInputExpiry: a suggestion has no TTL, so one past its old time stays pending and can still be approved (S-3830);
// a held one past its time, or whose harness session changed, expires untyped and the human is told in its thread.
func TestInputExpiry(t *testing.T) {
	f, n, tc, _ := inputFixture(t)
	log := boxPane(f, tc, "achild")
	ctx := context.Background()
	id := f.suggestID("git status")
	f.sql("UPDATE permission_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", id)
	f.srv.ExpireInputs(ctx)
	if f.status(id) != "pending" || hasNotice(n, "achild", "without an answer") {
		t.Errorf("a suggestion past its old time: %s, notices %q", f.status(id), n.all())
	}
	if f.count("SELECT count(*) FROM mail_recipients WHERE agent_id = 'human' AND withdrawn_at IS NOT NULL AND mail_id IN (SELECT id FROM mail WHERE permission_id = '"+id+"')") != 0 {
		t.Error("the mail left the human")
	}
	if code, body := f.approveInput(id, "git status"); code != 200 || !strings.Contains(body, `"outcome":"typed"`) {
		t.Errorf("approving it: %d %s", code, body)
	}
	eventually(t, "the approval typed", func() bool { return readLog(log) == "git status\n" })

	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	held := f.suggestID("make lint")
	if code, body := f.approveInput(held, "make lint"); code != 200 || !strings.Contains(body, `"outcome":"held"`) {
		t.Fatalf("held: %d %s", code, body)
	}
	f.sql("UPDATE permission_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", held)
	f.srv.ExpireInputs(ctx)
	if f.status(held) != "expired" {
		t.Errorf("held past its time: %s", f.status(held))
	}
	thread := f.count1("SELECT id FROM mail WHERE permission_id = '" + held + "'")
	if got := f.count1("SELECT subject FROM mail WHERE reply_to = '" + thread + "' AND subject LIKE '%expired untyped'"); got != "[stam] Approved input for child expired untyped" {
		t.Errorf("the human's reply %q", got)
	}

	session := f.suggestID("make test")
	f.srv.ExpireInputs(ctx)
	if f.status(session) != "pending" {
		t.Errorf("a suggestion in its time: %s after the sweep", f.status(session))
	}
	if code, body := f.approveInput(session, "make test"); code != 200 || !strings.Contains(body, `"outcome":"held"`) {
		t.Fatalf("held: %d %s", code, body)
	}
	f.sql("UPDATE agents SET activity = 'idle', session_id = 's-2' WHERE id = 'achild'")
	must(t, f.srv.TypeHeldInput(ctx, "achild"))
	if f.status(session) != "expired" || readLog(log) != "git status\n" {
		t.Errorf("another session: %s, submitted %q", f.status(session), readLog(log))
	}
	if got := f.lastEvent("achild", "input:expired"); got != `{"id":"`+session+`","was":"held","why":"its harness session changed after you approved it"}` {
		t.Errorf("expired event %s", got)
	}
}

// TestInputNewerSuggestionWhileTyping: a newer suggestion made while an approval is being typed doesn't stop it: the
// approval is typed and submitted as approved, and the newer suggestion waits pending (S-3830).
func TestInputNewerSuggestionWhileTyping(t *testing.T) {
	f, _, tc, barrier := inputFixture(t)
	log := boxPane(f, tc, "achild")
	id := f.suggestID("rm -rf build")
	must(t, os.WriteFile(filepath.Join(barrier, "hold"), nil, 0o600))
	done := make(chan string)
	go func() {
		_, body := f.approveInput(id, "rm -rf build")
		done <- body
	}()
	eventually(t, "the typing to reach Enter", func() bool { _, err := os.Stat(filepath.Join(barrier, "at")); return err == nil })
	if text, _ := f.srv.life.InputText(context.Background(), f.agentObj("achild")); text != "rm -rf build" {
		t.Errorf("the box at Enter: %q", text)
	}
	newer := f.suggestID("ls")
	must(t, os.Remove(filepath.Join(barrier, "hold")))
	if body := <-done; !strings.Contains(body, `"outcome":"typed"`) {
		t.Errorf("the approval: %s", body)
	}
	eventually(t, "the approval submitted", func() bool { return readLog(log) == "rm -rf build\n" })
	if f.status(id) != "approved" || f.status(newer) != "pending" {
		t.Errorf("statuses: approval %s, newer %s", f.status(id), f.status(newer))
	}
}

// TestInputNoteWithheldFromPlacedAsk: under a placed ask (one placed in a thread it didn't start) an outcome note isn't
// posted to the thread, since the Go daemon can't seal it yet; the event records the subject, and nothing is posted.
func TestInputNoteWithheldFromPlacedAsk(t *testing.T) {
	f, _, tc, _ := inputFixture(t)
	boxPane(f, tc, "achild")
	id := f.suggestID("git status")
	mail := f.count1("SELECT id FROM mail WHERE permission_id = '" + id + "'")
	f.sql("UPDATE mail SET thread_id = 'a-thread-it-did-not-start' WHERE id = ?", mail)
	if code, body := f.approveInput(id, "git status"); code != 200 || !strings.Contains(body, `"outcome":"typed"`) {
		t.Fatalf("approval: %d %s", code, body)
	}
	if got := f.count("SELECT count(*) FROM mail WHERE subject LIKE '%Input for child: typed%'"); got != 0 {
		t.Errorf("an unsealed note was posted under a placed ask: %d", got)
	}
	if got := f.lastEvent("achild", "input:note-withheld"); got != `{"id":"`+id+`","subject":"[stam] Input for child: typed"}` {
		t.Errorf("withheld event %s", got)
	}
}

// TestPromptSubmitted: the first prompt after a typed suggestion must be its text; another tells the human once, in
// the suggestion's thread. A bash-mode command is looked for in the transcript instead.
func TestPromptSubmitted(t *testing.T) {
	f, _, tc, _ := inputFixture(t)
	boxPane(f, tc, "achild")
	ctx := context.Background()
	id := f.suggestID("git status")
	if code, body := f.approveInput(id, "git status"); code != 200 || !strings.Contains(body, `"outcome":"typed"`) {
		t.Fatalf("approval: %d %s", code, body)
	}
	f.srv.PromptSubmitted(ctx, "achild", "  git status ")
	if got := f.lastEvent("achild", "input:submitted"); got != `{"id":"`+id+`","matched":true,"prompt":"  git status "}` {
		t.Errorf("matched %s", got)
	}
	f.srv.PromptSubmitted(ctx, "achild", "rm -rf /")
	if f.count("SELECT count(*) FROM events WHERE type = 'input:mismatch'") != 0 {
		t.Error("a second prompt was checked")
	}

	id2 := f.suggestID("make lint")
	if code, body := f.approveInput(id2, "make lint"); code != 200 || !strings.Contains(body, `"outcome":"typed"`) {
		t.Fatalf("approval: %d %s", code, body)
	}
	f.srv.PromptSubmitted(ctx, "achild", "make deploy")
	if got := f.lastEvent("achild", "input:mismatch"); got != `{"id":"`+id2+`","prompt":"make deploy"}` {
		t.Errorf("mismatch %s", got)
	}
	thread := f.count1("SELECT id FROM mail WHERE permission_id = '" + id2 + "'")
	if got := f.count1("SELECT subject FROM mail WHERE reply_to = '" + thread + "' AND subject LIKE '%submitted something else'"); got != "[stam] Input for child submitted something else" {
		t.Errorf("the human's reply %q", got)
	}

	// The transcript: what was appended after the offset counts.
	transcript := filepath.Join(f.t.TempDir(), "t.jsonl")
	f.sql("UPDATE agents SET transcript_path = ? WHERE id = 'achild'", transcript)
	earlier := `{"type":"user","message":{"content":"<bash-input>ls</bash-input>"}}` + "\n"
	r, _, err := f.db.PermissionRequestByID(ctx, id)
	must(t, err)
	r.Text = "!ls"
	f.srv.bashExpect = 1500 * time.Millisecond
	must(t, os.WriteFile(transcript, []byte(earlier+earlier), 0o600))
	f.srv.checkTranscript(ctx, f.agentObj("achild"), r, int64(len(earlier)))
	if got := f.lastEvent("achild", "input:submitted"); got != `{"id":"`+id+`","matched":true,"prompt":"!ls","via":"transcript"}` {
		t.Errorf("transcript match %s", got)
	}
	f.srv.checkTranscript(ctx, f.agentObj("achild"), r, int64(len(earlier)*2))
	if got := f.lastEvent("achild", "input:mismatch"); got != `{"id":"`+id+`","via":"transcript"}` {
		t.Errorf("no command %s", got)
	}

	// S-3188: Claude Code appends the record when the command finishes, so a row that lands after the check began
	// still matches while the wait is open, and none by the end of the wait is still a mismatch.
	f.srv.bashExpect = time.Minute
	must(t, os.WriteFile(transcript, []byte(earlier), 0o600))
	before := f.count("SELECT count(*) FROM events WHERE type = 'input:submitted'")
	done := make(chan struct{})
	go func() {
		f.srv.checkTranscript(ctx, f.agentObj("achild"), r, int64(len(earlier)))
		close(done)
	}()
	select {
	case <-done:
		t.Fatal("the check ended before the command's row was appended")
	case <-time.After(1500 * time.Millisecond):
	}
	fh, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	must(t, err)
	_, err = fh.WriteString(earlier)
	must(t, err)
	must(t, fh.Close())
	<-done
	if got := f.count("SELECT count(*) FROM events WHERE type = 'input:submitted'"); got != before+1 {
		t.Errorf("a late row was not matched: %d submitted events, was %d", got, before)
	}
}

// held runs an approval in the background up to the barrier stop named by suffix ("" before the claim, "-enter" after
// it, before Enter), and returns its release, which removes the hold and gives the approval's body.
func (f *fixture) heldApproval(barrier, suffix, id, text string) func() string {
	f.t.Helper()
	must(f.t, os.WriteFile(filepath.Join(barrier, "hold"+suffix), nil, 0o600))
	done := make(chan string)
	go func() {
		_, body := f.approveInput(id, text)
		done <- body
	}()
	eventually(f.t, "the typing to reach the stop", func() bool {
		_, err := os.Stat(filepath.Join(barrier, "at"+suffix))
		return err == nil
	})
	return func() string {
		must(f.t, os.Remove(filepath.Join(barrier, "hold"+suffix)))
		return <-done
	}
}

// TestInputSessionChangedAtClaim: a hook that changes the agent's session right before the claim leaves the approval
// held, so nothing is submitted; it expires and the human is told. The claim itself checks the session (db's
// SameSession), so no hook can come between a check and the move.
func TestInputSessionChangedAtClaim(t *testing.T) {
	f, n, tc, barrier := inputFixture(t)
	log := boxPane(f, tc, "achild")
	id := f.suggestID("make build")
	release := f.heldApproval(barrier, "", id, "make build")
	f.sql("UPDATE agents SET session_id = 's-2' WHERE id = 'achild'")
	if body := release(); !strings.Contains(body, `"outcome":"cancelled"`) {
		t.Errorf("the approval: %s", body)
	}
	if readLog(log) != "" || f.status(id) != "expired" {
		t.Errorf("submitted %q, status %s", readLog(log), f.status(id))
	}
	if !hasNotice(n, "achild", "its harness session changed while stam typed it") {
		t.Errorf("notices %q", n.all())
	}
	thread := f.count1("SELECT id FROM mail WHERE permission_id = '" + id + "'")
	if got := f.count1("SELECT subject FROM mail WHERE reply_to = '" + thread + "' AND subject LIKE '%expired untyped'"); got != "[stam] Approved input for child expired untyped" {
		t.Errorf("the human's reply %q", got)
	}
}

// TestInputExpectedBeforeEnter: the prompt a typed suggestion should submit is expected from the claim on, before
// Enter, so a UserPromptSubmit that arrives as Enter lands is checked against it.
func TestInputExpectedBeforeEnter(t *testing.T) {
	f, _, tc, barrier := inputFixture(t)
	log := boxPane(f, tc, "achild")
	id := f.suggestID("git status")
	release := f.heldApproval(barrier, "-enter", id, "git status")
	f.srv.PromptSubmitted(context.Background(), "achild", "git status")
	if body := release(); !strings.Contains(body, `"outcome":"typed"`) {
		t.Errorf("the approval: %s", body)
	}
	eventually(t, "the line submitted", func() bool { return readLog(log) == "git status\n" })
	if got := f.lastEvent("achild", "input:submitted"); got != `{"id":"`+id+`","matched":true,"prompt":"git status"}` {
		t.Errorf("submitted %s", got)
	}
	if f.count("SELECT count(*) FROM events WHERE type = 'input:mismatch'") != 0 {
		t.Error("a mismatch")
	}
}

// TestInputEnterUnsent: the claim went through but Enter couldn't be sent, as the agent's session went away: the
// approval fails, the agent hears, and the human is told in the suggestion's thread; nothing stays expected.
func TestInputEnterUnsent(t *testing.T) {
	f, n, tc, barrier := inputFixture(t)
	log := boxPane(f, tc, "achild")
	id := f.suggestID("make deploy")
	release := f.heldApproval(barrier, "-enter", id, "make deploy")
	tc.Run(context.Background(), nil, "kill-session", "-t", "=achild")
	if body := release(); !strings.Contains(body, `"outcome":"failed"`) {
		t.Errorf("the approval: %s", body)
	}
	if readLog(log) != "" || f.status(id) != "failed" {
		t.Errorf("submitted %q, status %s", readLog(log), f.status(id))
	}
	if got := f.count1("SELECT note FROM permission_requests WHERE id = '" + id + "'"); got != "typed, but Enter not sent: the agent's pane changed or tmux failed" {
		t.Errorf("note %q", got)
	}
	if f.lastEvent("achild", "input:failed") != `{"id":"`+id+`"}` || !hasNotice(n, "achild", "stam couldn't press Enter") {
		t.Errorf("failed: notices %q", n.all())
	}
	thread := f.count1("SELECT id FROM mail WHERE permission_id = '" + id + "'")
	if got := f.count1("SELECT subject || ' | ' || body FROM mail WHERE reply_to = '" + thread + "'"); got != "[stam] Approved input for child was not sent | You approved @child's suggested input "+id+". stam typed it, but couldn't press Enter (the agent's pane changed or tmux failed), so it wasn't sent. stam erased the text where the pane was still the agent's; if that failed, it may still be in the input box. It can suggest it again." {
		t.Errorf("the human's reply %q", got)
	}
	if _, ok := f.srv.inputs.takeExpected("achild"); ok {
		t.Error("the prompt stayed expected")
	}
}

// A poll reads only the bytes appended since the last one, and a row split across two reads is returned once whole.
func TestRowTailReadsOnlyNewWholeRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	must(t, os.WriteFile(path, []byte("old\n"), 0o600))
	tail := &rowTail{pos: 4}
	appendTo := func(s string) {
		fh, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
		must(t, err)
		_, err = fh.WriteString(s)
		must(t, err)
		must(t, fh.Close())
	}
	read := func() string {
		rows, err := tail.rows(path)
		must(t, err)
		return rows
	}
	if got := read(); got != "" {
		t.Errorf("nothing appended: %q", got)
	}
	row := `{"type":"user","message":{"content":"<bash-input> ls</bash-input>"}}`
	appendTo(row[:20])
	if got := read(); got != "" {
		t.Errorf("a partial row was returned: %q", got)
	}
	appendTo(row[20:] + "\nnext")
	got := read()
	if got != row+"\n" {
		t.Errorf("the completed row: %q", got)
	}
	if got := read(); got != "" {
		t.Errorf("a row was returned twice: %q", got)
	}
	appendTo("\n")
	if got := read(); got != "next\n" {
		t.Errorf("the last row: %q", got)
	}
}

// TestInputQueuedForBusyAgent: two approvals for a busy agent are typed once each, in the order the human approved
// them, the second held as queued until the first is typed (S-3830).
func TestInputQueuedForBusyAgent(t *testing.T) {
	f, _, tc, _ := inputFixture(t)
	log := boxPane(f, tc, "achild")
	ctx := context.Background()
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	first := f.suggestID("echo first")
	if code, body := f.approveInput(first, "echo first"); code != 200 || !strings.Contains(body, `"outcome":"held"`) {
		t.Fatalf("the busy approval: %d %s", code, body)
	}
	if got := f.lastEvent("achild", "input:held"); !strings.Contains(got, first) || !strings.Contains(got, "busy") {
		t.Errorf("a busy agent wasn't told to end its turn: %s", got)
	}
	second := f.suggestID("echo second")
	if code, body := f.approveInput(second, "echo second"); code != 200 || !strings.Contains(body, `"why":"queued"`) {
		t.Fatalf("the second approval isn't queued: %d %s", code, body)
	}
	f.sql("UPDATE agents SET activity = 'idle' WHERE id = 'achild'")
	must(t, f.srv.TypeHeldInput(ctx, "achild"))
	eventually(t, "the first approval typed", func() bool { return readLog(log) == "echo first\n" })
	must(t, f.srv.TypeHeldInput(ctx, "achild"))
	eventually(t, "the second approval typed", func() bool { return readLog(log) == "echo first\necho second\n" })
	if f.status(first) != "approved" || f.status(second) != "approved" {
		t.Errorf("statuses: first %s, second %s", f.status(first), f.status(second))
	}
}

// TestInputNotesOnlyEndStates: a replaced suggestion, a held approval and a withdrawal are no thread note; the typed
// approval is noted once (S-3830).
func TestInputNotesOnlyEndStates(t *testing.T) {
	f, _, tc, _ := inputFixture(t)
	boxPane(f, tc, "achild")
	ctx := context.Background()
	f.sql("UPDATE agents SET activity = 'working' WHERE id = 'achild'")
	old := f.suggestID("echo old")
	newer := f.suggestID("echo new")
	if code, body := f.approveInput(newer, "echo new"); code != 200 || !strings.Contains(body, `"outcome":"held"`) {
		t.Fatalf("the busy approval: %d %s", code, body)
	}
	if f.status(old) != "withdrawn" {
		t.Errorf("the replaced suggestion is %s", f.status(old))
	}
	if got := f.count("SELECT count(*) FROM mail WHERE subject LIKE '%Input for child: held%' OR subject LIKE '%Input for child: withdrawn%'"); got != 0 {
		t.Errorf("a held or withdrawn note was posted: %d", got)
	}
	f.sql("UPDATE agents SET activity = 'idle' WHERE id = 'achild'")
	must(t, f.srv.TypeHeldInput(ctx, "achild"))
	eventually(t, "the approval typed", func() bool { return f.status(newer) == "approved" })
	if got := f.count("SELECT count(*) FROM mail WHERE subject LIKE '%Input for child: typed%'"); got != 1 {
		t.Errorf("the typed approval was noted %d times", got)
	}
}

// TestInputPendingWithdrawnWhenAgentStops: a suggestion still pending when its agent stops, is archived or is forgotten
// is withdrawn, so no ask waits on an agent that can't answer it (S-3830).
func TestInputPendingWithdrawnWhenAgentStops(t *testing.T) {
	f, _, _, _ := inputFixture(t)
	id := f.suggestID("echo stop")
	must(t, f.srv.WithdrawPending(context.Background(), f.agentObj("achild"), "the agent was shut down"))
	if f.status(id) != "withdrawn" {
		t.Errorf("the pending suggestion is %s after its agent stopped", f.status(id))
	}
	if got := f.lastEvent("achild", "permission:withdrawn"); !strings.Contains(got, id) {
		t.Errorf("no withdrawal event for %s: %s", id, got)
	}
}
