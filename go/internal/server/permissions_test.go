package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
)

// permFixture is the seeded home with boss and child active, boss's token, and the notices recorded.
func permFixture(t *testing.T) (*fixture, *notices) {
	f := newFixture(t, nil)
	f.sql("UPDATE agents SET lifecycle = 'active' WHERE id IN ('aboss', 'achild')")
	f.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(parentTok))
	n := &notices{}
	f.srv.noticeHook = n.add
	return f, n
}

func (f *fixture) ask(body string) string {
	f.t.Helper()
	rec := f.sendH("POST", "/api/permissions", agentTok, nil, body)
	if rec.Code != 200 {
		f.t.Fatalf("ask %s: %d %s", body, rec.Code, rec.Body.String())
	}
	return f.body(rec).Text("id")
}

func (f *fixture) answerAs(token string, header map[string]string, id, body string) (int, string) {
	f.t.Helper()
	rec := f.sendH("POST", "/api/permissions/"+id+"/answer", token, header, body)
	return rec.Code, rec.Body.String()
}

func (f *fixture) agentObj(id string) db.Agent {
	f.t.Helper()
	a, err := f.db.GetAgent(context.Background(), id)
	must(f.t, err)
	return a
}

func (f *fixture) status(id string) string {
	return f.count1("SELECT status FROM permission_requests WHERE id = '" + id + "'")
}

func hasNotice(n *notices, prefix, part string) bool {
	for _, x := range n.all() {
		if strings.HasPrefix(x, prefix+": ") && strings.Contains(x, part) {
			return true
		}
	}
	return false
}

// A delegate ask goes to the live parent in a mail of its own, with the wait on the parent and the event; the parent's
// deny tells the child with the failure retro; a second answer is refused.
func TestPermissionDelegate(t *testing.T) {
	f, n := permFixture(t)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"retroReminders":true}`)
	id := f.ask(`{"action":"git push","reason":"ship it","details":"origin main","audience":"delegate"}`)
	if got := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'aboss'", id); got != 1 {
		t.Errorf("%d mails to the parent", got)
	}
	if got := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'human'", id); got != 0 {
		t.Errorf("%d mails to the human", got)
	}
	if got := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild' AND kind = 'agent' AND target = 'aboss' AND data = ?", id); got != 1 {
		t.Errorf("%d waits on the parent", got)
	}
	if got := f.count1("SELECT data FROM events WHERE agent_id = 'achild' AND type = 'permission:requested'"); got != `{"id":"`+id+`","action":"git push","audience":"delegate"}` {
		t.Errorf("requested event %s", got)
	}
	// An agent outside the reviewers can't answer.
	if code, body := f.answerAs(sharedTok, human, id, `{"by":"coder","approve":true}`); code != 409 || !strings.Contains(body, "can't answer for child") {
		t.Errorf("a stranger's answer: %d %s", code, body)
	}
	code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"deny","note":"not today"}`)
	if code != 200 || !strings.Contains(body, `"status":"denied"`) {
		t.Fatalf("deny: %d %s", code, body)
	}
	if !hasNotice(n, "achild", "not today") || !hasNotice(n, "achild", "boss, your parent agent") || !hasNotice(n, "achild", "Retro reminder") {
		t.Errorf("notices %q", n.all())
	}
	if got := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'"); got != 0 {
		t.Errorf("%d waits after the answer", got)
	}
	if code, body := f.answerAs(sharedTok, human, id, `{"approve":true}`); code != 409 || !strings.Contains(body, "already denied") {
		t.Errorf("second answer: %d %s", code, body)
	}
}

// A human ask with live reviewers: the human gets the mail, the reviewers a quiet notice; an agent's yes is refused, its
// no settles it and withdraws the human's mail. An ask with no reviewers says why it comes to the human.
func TestPermissionHuman(t *testing.T) {
	f, n := permFixture(t)
	id := f.ask(`{"action":"rm -rf build","reason":"clean","audience":"human"}`)
	if got := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'human'", id); got != 1 {
		t.Errorf("%d mails to the human", got)
	}
	if !hasNotice(n, "aboss", id) {
		t.Errorf("reviewer notices %q", n.all())
	}
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","approve":true}`); code != 409 || !strings.Contains(body, "the human's to approve") {
		t.Errorf("an agent's yes: %d %s", code, body)
	}
	if f.status(id) != "pending" {
		t.Errorf("status %s after a refused yes", f.status(id))
	}
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","approve":false}`); code != 200 {
		t.Fatalf("an agent's no: %d %s", code, body)
	}
	if got := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'human' AND r.withdrawn_at IS NOT NULL AND r.withdrawn_by = 'aboss'", id); got != 1 {
		t.Errorf("%d withdrawn human mails", got)
	}

	// No parent: the human's, with the reason it came there. The human's yes, with no tmux, is a notice.
	f.sql("UPDATE agents SET parent_id = NULL WHERE id = 'achild'")
	id2 := f.ask(`{"action":"deploy","reason":"r","audience":"delegate"}`)
	if aud := f.count1("SELECT audience FROM permission_requests WHERE id = '" + id2 + "'"); aud != "human" {
		t.Errorf("audience %s", aud)
	}
	if body := f.count1("SELECT body FROM mail WHERE permission_id = '" + id2 + "'"); !strings.Contains(body, "child has no parent or chief of staff to decide") {
		t.Errorf("mail %s", body)
	}
	if code, body := f.answerAs(sharedTok, human, id2, `{"approve":true}`); code != 200 || !strings.Contains(body, `"typed":false`) {
		t.Fatalf("the human's yes: %d %s", code, body)
	}
	if !hasNotice(n, "achild", "your user (the human), in stam") {
		t.Errorf("notices %q", n.all())
	}
}

// A live reviewer on a machine that isn't a configured peer is refused (503) before anything is written.
func TestPermissionPeerReviewer(t *testing.T) {
	f, _ := permFixture(t)
	ctx := context.Background()
	// A dialog pending from before the reviewer moved away.
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: `{"tool":"Read"}`, Replaces: true}))
	old, _, _ := f.db.PendingDialog(ctx, "achild")
	f.sql("UPDATE agents SET parent_id = 'afar' WHERE id = 'achild'")
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afar', 'far', 'm2', '2026-01-01')")
	// A newer dialog is refused before anything is written: the old request stays.
	err := f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Bash", Details: `{"tool":"Bash"}`, Replaces: true})
	var he *Error
	if !errors.As(err, &he) || he.Status != 503 || !strings.Contains(he.Message, "m2, which isn't a configured peer") {
		t.Errorf("a dialog for a peer reviewer: %v", err)
	}
	if f.status(old.ID) != "pending" {
		t.Errorf("the old dialog is %s", f.status(old.ID))
	}
	f.sql("DELETE FROM permission_requests WHERE id = ?", old.ID)
	f.sql("DELETE FROM waits WHERE agent_id = 'achild'")
	before := f.count("SELECT count(*) FROM permission_requests")
	rec := f.sendH("POST", "/api/permissions", agentTok, nil, `{"action":"a","audience":"delegate"}`)
	if rec.Code != 503 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if got := f.count("SELECT count(*) FROM permission_requests"); got != before {
		t.Errorf("%d requests, was %d", got, before)
	}
	if got := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'"); got != 0 {
		t.Errorf("%d waits", got)
	}
	// A peer reviewer known paused is no reviewer: the ask goes to the human.
	f.sql("UPDATE peer_agents SET lifecycle = 'paused' WHERE id = 'afar'")
	f.ask(`{"action":"a","reason":"why","audience":"delegate"}`)
}

// A live reviewer on a configured peer that refuses the ask's mail (S-4100 review): the ask fails with nothing left
// behind, no request and no wait the agent can't withdraw, and a newer dialog that can't reach the reviewer leaves the
// earlier dialog's request pending.
func TestPermissionPeerReviewerUndelivered(t *testing.T) {
	f, _ := permFixture(t)
	ctx := context.Background()
	refusing := newPeerServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, Errorf(http.StatusForbidden, "no mail for afar"))
	}))
	down := newPeerServer(t, http.NotFoundHandler())
	down.ts.Close()
	// The earlier dialog went to a reviewer here.
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Read", Details: `{"tool":"Read"}`, Replaces: true}))
	old, _, _ := f.db.PendingDialog(ctx, "achild")
	f.sql("UPDATE agents SET parent_id = 'afar' WHERE id = 'achild'")
	f.sql("INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afar', 'far', 'm2', '2026-01-01')")
	for name, url := range map[string]string{"refusing": refusing.ts.URL} {
		must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"peers":[{"name":"m2","url":"`+url+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}]}`), 0o600))
		requests, waits := f.count("SELECT count(*) FROM permission_requests"), f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'")
		if err := f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Bash", Details: `{"tool":"Bash"}`, Replaces: true}); err == nil {
			t.Errorf("%s: a newer dialog was taken", name)
		}
		if rec := f.sendH("POST", "/api/permissions", agentTok, nil, `{"action":"a","audience":"delegate"}`); rec.Code < 400 {
			t.Errorf("%s: the ask: %d %s", name, rec.Code, rec.Body.String())
		}
		if got := f.count("SELECT count(*) FROM permission_requests"); got != requests {
			t.Errorf("%s: %d requests, was %d", name, got, requests)
		}
		if got := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'"); got != waits {
			t.Errorf("%s: %d waits, was %d", name, got, waits)
		}
		if f.status(old.ID) != "pending" {
			t.Errorf("%s: the earlier dialog is %s", name, f.status(old.ID))
		}
	}
	// A reviewer on a peer that is down gets the ask once it is back: its mail waits in the outbox (S-235), so the newer
	// dialog stands and replaces the earlier one.
	must(t, os.WriteFile(filepath.Join(f.home, "settings.json"), []byte(`{"peers":[{"name":"m2","url":"`+down.ts.URL+`","token":"`+sharedTok+`","peerToken":"`+peerTok+`"}]}`), 0o600))
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Bash", Details: `{"tool":"Bash"}`, Replaces: true}))
	newer, _, _ := f.db.PendingDialog(ctx, "achild")
	if f.status(old.ID) != "withdrawn" || newer.ID == old.ID || f.count("SELECT count(*) FROM peer_outbox p JOIN mail m ON m.id = p.mail_id WHERE m.permission_id = ?", newer.ID) != 1 {
		t.Errorf("down: the earlier dialog is %s, the newer %s, %d queued", f.status(old.ID), newer.ID, f.count("SELECT count(*) FROM peer_outbox p JOIN mail m ON m.id = p.mail_id WHERE m.permission_id = ?", newer.ID))
	}
}

// Escalating: a reason is required, the request moves to the human with one mail, the child hears who sent it on, and
// it moves once.
func TestPermissionEscalate(t *testing.T) {
	f, n := permFixture(t)
	id := f.ask(`{"action":"git push --force","reason":"r","audience":"delegate"}`)
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"escalate","note":"  "}`); code != 409 || !strings.Contains(body, "reason is required") {
		t.Errorf("no reason: %d %s", code, body)
	}
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"escalate","note":"force push\nto main"}`); code != 200 || !strings.Contains(body, `"audience":"human"`) {
		t.Fatalf("escalate: %d %s", code, body)
	}
	if got := f.count("SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = ? AND r.agent_id = 'human'", id); got != 1 {
		t.Errorf("%d mails to the human", got)
	}
	if got := f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild' AND kind = 'human' AND target = ?", id); got != 1 {
		t.Errorf("%d human waits", got)
	}
	if !hasNotice(n, "achild", "force push to main") {
		t.Errorf("notices %q", n.all())
	}
	// Once it is the human's, the parent's yes is refused and changes nothing.
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","approve":true}`); code != 409 || !strings.Contains(body, "the human's to approve") {
		t.Errorf("the parent's yes after the escalation: %d %s", code, body)
	}
	if f.status(id) != "pending" {
		t.Errorf("status %s after the parent's yes", f.status(id))
	}
	if code, body := f.answerAs(parentTok, nil, id, `{"by":"aboss","decision":"escalate","note":"again"}`); code != 409 || !strings.Contains(body, "already with the human") {
		t.Errorf("twice: %d %s", code, body)
	}
	if code, body := f.answerAs(sharedTok, human, id, `{"decision":"escalate","note":"x"}`); code != 409 || !strings.Contains(body, "the human decides it") {
		t.Errorf("the human escalating: %d %s", code, body)
	}
	if code, body := f.answerAs(sharedTok, human, id, `{"decision":"maybe"}`); code != 409 || !strings.Contains(body, "approve, deny or escalate") {
		t.Errorf("a bad decision: %d %s", code, body)
	}
}

// A harness dialog: shown, the same one again keeps its request, another replaces it, closing withdraws it; only the
// human approves, and a deny with no screen finds it gone and withdraws it.
func TestPermissionDialogs(t *testing.T) {
	f, _ := permFixture(t)
	ctx := context.Background()
	child := f.agentObj("achild")
	d := claude.Dialog{Action: "Claude Code asks to allow Bash", Details: `{"tool":"Bash","input":{"command":"ls -la"}}`, Replaces: true}
	must(t, f.srv.DialogShown(ctx, child, d))
	first, ok, _ := f.db.PendingDialog(ctx, "achild")
	if !ok || first.Audience != "delegate" {
		t.Fatalf("pending %v %+v", ok, first)
	}
	if subj := f.count1("SELECT subject FROM mail WHERE permission_id = '" + first.ID + "'"); subj != "child wants to run: ls -la" {
		t.Errorf("subject %q", subj)
	}
	must(t, f.srv.DialogShown(ctx, child, d))
	must(t, f.srv.DialogShown(ctx, child, claude.Dialog{Action: "x", Details: "{}"}))
	if again, _, _ := f.db.PendingDialog(ctx, "achild"); again.ID != first.ID {
		t.Errorf("the same dialog made %s", again.ID)
	}
	d2 := claude.Dialog{Action: "Claude Code asks to allow Read", Details: `{"tool":"Read","input":{"file_path":"/x"}}`, Replaces: true}
	must(t, f.srv.DialogShown(ctx, child, d2))
	second, _, _ := f.db.PendingDialog(ctx, "achild")
	if second.ID == first.ID || f.status(first.ID) != "withdrawn" {
		t.Errorf("replace: %s, first %s", second.ID, f.status(first.ID))
	}
	if code, body := f.answerAs(parentTok, nil, second.ID, `{"by":"aboss","approve":true}`); code != 409 || !strings.Contains(body, "only the human approves a harness dialog") {
		t.Errorf("an agent's yes: %d %s", code, body)
	}
	if code, body := f.answerAs(parentTok, nil, second.ID, `{"by":"aboss","approve":false}`); code != 409 || !strings.Contains(body, "no longer shows this dialog") {
		t.Errorf("deny with nothing on screen: %d %s", code, body)
	}
	if f.status(second.ID) != "withdrawn" {
		t.Errorf("status %s", f.status(second.ID))
	}
	must(t, f.srv.DialogShown(ctx, child, d))
	third, _, _ := f.db.PendingDialog(ctx, "achild")
	must(t, f.srv.DialogClosed(ctx, child))
	if f.status(third.ID) != "withdrawn" || f.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'") != 0 {
		t.Errorf("closed: %s", f.status(third.ID))
	}
	must(t, f.srv.DialogClosed(ctx, child))
}

// A dialog nobody answered in time goes to the human with who waited; one whose agent was shut down is withdrawn.
func TestPermissionStaleDialogs(t *testing.T) {
	f, n := permFixture(t)
	ctx := context.Background()
	must(t, f.srv.DialogShown(ctx, f.agentObj("achild"), claude.Dialog{Action: "Claude Code asks to allow Bash", Details: `{"tool":"Bash","input":{"command":"make"}}`, Replaces: true}))
	r, _, _ := f.db.PendingDialog(ctx, "achild")
	// Within the default 10 minutes it stays with the reviewers.
	must(t, f.srv.escalateStaleDialogs(ctx))
	if aud := f.count1("SELECT audience FROM permission_requests WHERE id = '" + r.ID + "'"); aud != "delegate" {
		t.Errorf("audience %s before the timeout", aud)
	}
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"dialogEscalateMinutes":0}`)
	must(t, f.srv.escalateStaleDialogs(ctx))
	if aud := f.count1("SELECT audience FROM permission_requests WHERE id = '" + r.ID + "'"); aud != "human" {
		t.Errorf("audience %s", aud)
	}
	if got := f.count("SELECT count(*) FROM events WHERE agent_id = 'achild' AND type = 'permission:escalated' AND data LIKE ?", `%"waited":["aboss"]%`); got != 1 {
		t.Errorf("%d escalated events", got)
	}
	if body := f.count1("SELECT m.body FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.permission_id = '" + r.ID + "' AND r.agent_id = 'human'"); !strings.Contains(body, "send dialogs on without waiting") {
		t.Errorf("human mail %s", body)
	}
	if !hasNotice(n, "achild", "stam") {
		t.Errorf("notices %q", n.all())
	}
	// Once with the human, the timer leaves it.
	must(t, f.srv.escalateStaleDialogs(ctx))
	if got := f.count("SELECT count(*) FROM events WHERE type = 'permission:escalated'"); got != 1 {
		t.Errorf("%d escalated events after a second tick", got)
	}
	f.sql("UPDATE agents SET lifecycle = 'shut_down' WHERE id = 'achild'")
	must(t, f.srv.escalateStaleDialogs(ctx))
	if f.status(r.ID) != "withdrawn" {
		t.Errorf("status %s", f.status(r.ID))
	}
	if note := f.count1("SELECT note FROM permission_requests WHERE id = '" + r.ID + "'"); note != "child is shut down" {
		t.Errorf("note %q", note)
	}
}

// The routes: an agent lists its own tree, the human all; a bad audience is 400, a missing one is a delegate ask with an
// event; an answer with no `by` and no human is 403; input and settings asks are 501; a peer's local call for a request
// held elsewhere is 404.
func TestPermissionRoutes(t *testing.T) {
	f, _ := permFixture(t)
	f.sql("INSERT INTO permission_requests (id, agent_id, action, reason, details, status, audience, created_at) VALUES ('pboss', 'aboss', 'a', 'r', 'd', 'pending', 'human', '2026-01-01')")
	list := func(token string, header map[string]string, q string) []string {
		rec := f.sendH("GET", "/api/permissions"+q, token, header, "")
		if rec.Code != 200 {
			t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
		}
		var ids []string
		for _, x := range f.body(rec).Items {
			ids = append(ids, x.Text("id"))
		}
		return ids
	}
	if ids := list(agentTok, nil, ""); contains(ids, "pboss") || !contains(ids, "p1") {
		t.Errorf("the child's list %q", ids)
	}
	if ids := list(parentTok, nil, ""); !contains(ids, "pboss") || !contains(ids, "p1") {
		t.Errorf("the boss's list %q", ids)
	}
	if ids := list(sharedTok, human, "?status=pending&audience=delegate"); len(ids) != 1 || ids[0] != "p2" {
		t.Errorf("the human's filtered list %q", ids)
	}
	if rec := f.sendH("POST", "/api/permissions", agentTok, nil, `{"action":"a","audience":"everyone"}`); rec.Code != 400 {
		t.Errorf("bad audience: %d %s", rec.Code, rec.Body.String())
	}
	id := f.ask(`{"action":"a"}`)
	if got := f.count1("SELECT data FROM events WHERE type = 'permission:audience-defaulted'"); got != `{"id":"`+id+`","audience":"delegate"}` {
		t.Errorf("defaulted event %s", got)
	}
	if code, body := f.answerAs(sharedTok, nil, id, `{"approve":true}`); code != 403 {
		t.Errorf("no by: %d %s", code, body)
	}
	f.sql("UPDATE permission_requests SET kind = 'input' WHERE id = 'p1'")
	f.sql(`UPDATE permission_requests SET payload = '{"change":{"kind":"registry","text":"{}"},"baseHash":"x"}' WHERE id = 'p2'`)
	// Suggested input is approved only by the human as trustedHuman proves it: the shared token's human is refused.
	if code, body := f.answerAs(sharedTok, human, "p1", `{"approve":true}`); code != 403 {
		t.Errorf("input: %d %s", code, body)
	}
	// A registry change asked against a registry.json that changed since is approved but not applied (settings_ask.go).
	if code, body := f.answerAs(sharedTok, human, "p2", `{"approve":true}`); code != 200 || !strings.Contains(body, `"status":"denied"`) {
		t.Errorf("settings: %d %s", code, body)
	}
	if _, err := os.Stat(filepath.Join(f.home, "registry.json")); err == nil {
		t.Errorf("a stale registry change wrote registry.json")
	}
	if f.status("p1") != "pending" {
		t.Errorf("refusals wrote: %s", f.status("p1"))
	}
	if code, body := f.answerAs(peerTok, map[string]string{"X-Stam-Local": "1"}, "pnone", `{"approve":true}`); code != 404 {
		t.Errorf("local miss: %d %s", code, body)
	}
}

// The requests live in the database: a new server over the same home answers one asked before it.
func TestPermissionRestart(t *testing.T) {
	f, _ := permFixture(t)
	id := f.ask(`{"action":"a","audience":"delegate"}`)
	// Closing checkpoints the WAL into the file the new server starts from.
	must(t, f.db.Close())
	f2 := newFixtureFrom(t, nil, f.cfg.DBPath())
	f2.sql("UPDATE agents SET token_hash = ? WHERE id = 'aboss'", auth.Hash(parentTok))
	n := &notices{}
	f2.srv.noticeHook = n.add
	if code, body := f2.answerAs(parentTok, nil, id, `{"by":"aboss","approve":true}`); code != 200 || !strings.Contains(body, `"status":"approved"`) {
		t.Fatalf("answer after a restart: %d %s", code, body)
	}
	if got := f2.count("SELECT count(*) FROM waits WHERE agent_id = 'achild'"); got != 0 {
		t.Errorf("%d waits", got)
	}
	if !hasNotice(n, "achild", "approved") {
		t.Errorf("notices %q", n.all())
	}
}

// An ask whose request closes after its row is made, but before its mail is stored (S-3979), leaves no open mail: the
// mail is withdrawn as it is stored, since the close found no mail to pull.
func TestAskClosedBeforeMailIsWithdrawn(t *testing.T) {
	f, _ := permFixture(t)
	f.srv.askMailHook = func(id string) {
		if _, err := f.db.WithdrawPermissionRequest(context.Background(), id, "closed outside stam"); err != nil {
			t.Fatal(err)
		}
	}
	id := f.ask(`{"action":"rm -rf build","reason":"clean","audience":"human"}`)
	if got := f.status(id); got != "withdrawn" {
		t.Fatalf("request is %s, want withdrawn", got)
	}
	if n := f.count("SELECT COUNT(*) FROM mail WHERE permission_id = ?", id); n != 1 {
		t.Fatalf("ask stored %d mails, want 1", n)
	}
	if n := f.count("SELECT COUNT(*) FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.permission_id = ? AND r.withdrawn_at IS NULL", id); n != 0 {
		t.Fatalf("%d recipient copies of the ask are open, want none", n)
	}
}
