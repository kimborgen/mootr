package db

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// TestPermissionRequests: a request is created with its wait in one write, a delegate ask on its reviewer and the
// human's on the request; escalating, deciding and withdrawing are each conditional on the request's state, carry its
// waits and decision mails, and win once.
func TestPermissionRequests(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	ctx := context.Background()
	newTestAgent(t, d, "apr1", "asker")
	newTestAgent(t, d, "apr2", "rev")
	execSQL(t, conn, "UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'apr1'")
	r, err := d.CreatePermissionRequest(ctx, NewRequest{AgentID: "apr1", Action: "push", Reason: "r", Details: "d", Reviewer: "apr2"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Audience != "delegate" || r.Kind != "request" || r.Dialog || r.Status != "pending" || len(r.ID) != 7 || r.ID[0] != 'p' {
		t.Errorf("created %+v", r)
	}
	ws, _ := d.ListWaits(ctx, "apr1")
	if len(ws) != 1 || ws[0].Kind != "agent" || deref(ws[0].Target) != "apr2" || deref(ws[0].Data) != r.ID || deref(ws[0].Detail) != DelegateWait || ws[0].Source != "stam" {
		t.Errorf("delegate wait %+v", ws)
	}
	// The wait turned the idle agent waiting, in the same write.
	if a, _ := d.GetAgent(ctx, "apr1"); a.Activity != "waiting" {
		t.Errorf("activity %s, want waiting", a.Activity)
	}
	// A decision mail about the request goes when the request moves.
	execSQL(t, conn, "INSERT INTO mail (id, from_id, subject, body, created_at) VALUES ('mq1', 'apr1', 'about "+r.ID+"', 'b', '2026-01-01T00:00:00.000Z')")
	execSQL(t, conn, "INSERT INTO decision_mails (mail_id, thread_id) VALUES ('mq1', 'mq1')")
	moved, err := d.EscalatePermissionRequest(ctx, r.ID)
	if err != nil || !moved {
		t.Fatalf("escalate: %v %v", moved, err)
	}
	if again, _ := d.EscalatePermissionRequest(ctx, r.ID); again {
		t.Error("escalated twice")
	}
	ws, _ = d.ListWaits(ctx, "apr1")
	if len(ws) != 1 || ws[0].Kind != "human" || deref(ws[0].Target) != r.ID || deref(ws[0].Detail) != "your approval" {
		t.Errorf("waits after the escalation %+v", ws)
	}
	if n := count(t, conn, "SELECT COUNT(*) FROM decision_mails"); n != 0 {
		t.Errorf("%d decision mails left", n)
	}
	got, _, _ := d.PermissionRequestByID(ctx, r.ID)
	if got.Audience != "human" {
		t.Errorf("audience %s", got.Audience)
	}
	// A check that refuses inside the decision's transaction writes nothing.
	no := errors.New("no")
	if ok, err := d.DecidePermissionRequest(ctx, r.ID, true, "apr2", "yes", func(PermissionRequest) error { return no }); ok || !errors.Is(err, no) {
		t.Errorf("refused decision: %v %v", ok, err)
	}
	if got, _, _ := d.PermissionRequestByID(ctx, r.ID); got.Status != "pending" {
		t.Errorf("status %s after a refused decision", got.Status)
	}
	if ws, _ := d.ListWaits(ctx, "apr1"); len(ws) != 1 {
		t.Errorf("waits after a refused decision %+v", ws)
	}
	// Two answers at once: one wins, and the other writes nothing.
	var wg sync.WaitGroup
	wins := make(chan string, 2)
	for _, by := range []string{"human", "apr2"} {
		wg.Add(1)
		go func(by string) {
			defer wg.Done()
			if ok, err := d.DecidePermissionRequest(ctx, r.ID, by == "human", by, "n", nil); err != nil {
				t.Error(err)
			} else if ok {
				wins <- by
			}
		}(by)
	}
	wg.Wait()
	close(wins)
	var winners []string
	for w := range wins {
		winners = append(winners, w)
	}
	got, _, _ = d.PermissionRequestByID(ctx, r.ID)
	if len(winners) != 1 || got.Row.Text("decided_by") != winners[0] {
		t.Errorf("winners %q, decided by %s", winners, got.Row.Text("decided_by"))
	}
	if ws, _ := d.ListWaits(ctx, "apr1"); len(ws) != 0 {
		t.Errorf("waits after the decision %+v", ws)
	}
	if a, _ := d.GetAgent(ctx, "apr1"); a.Activity != "idle" {
		t.Errorf("activity %s after the decision, want idle", a.Activity)
	}
	if ok, _ := d.WithdrawPermissionRequest(ctx, r.ID, "late"); ok {
		t.Error("withdrew a decided request")
	}
	// A dialog that is the human's: a human wait; withdrawn once.
	dr, err := d.CreatePermissionRequest(ctx, NewRequest{AgentID: "apr1", Action: "Claude Code asks to allow Read", Details: `{"tool":"Read"}`, Dialog: true})
	if err != nil {
		t.Fatal(err)
	}
	if dr.Audience != "human" || dr.Kind != "dialog" || !dr.Dialog {
		t.Errorf("dialog %+v", dr)
	}
	if p, ok, _ := d.PendingDialog(ctx, "apr1"); !ok || p.ID != dr.ID {
		t.Errorf("pending dialog %v %+v", ok, p)
	}
	if all, _ := d.PendingDialogs(ctx); len(all) != 1 || all[0].ID != dr.ID {
		t.Errorf("pending dialogs %+v", all)
	}
	if stale, _ := d.StalePendingPermissions(ctx, "apr1", dr.CreatedAt); len(stale) != 1 {
		t.Errorf("stale %+v", stale)
	}
	if stale, _ := d.StalePendingPermissions(ctx, "apr1", "2000-01-01"); len(stale) != 0 {
		t.Errorf("stale before it %+v", stale)
	}
	if ok, err := d.WithdrawPermissionRequest(ctx, dr.ID, "closed outside stam"); !ok || err != nil {
		t.Errorf("withdraw: %v %v", ok, err)
	}
	if ok, _ := d.WithdrawPermissionRequest(ctx, dr.ID, "again"); ok {
		t.Error("withdrew twice")
	}
	got, _, _ = d.PermissionRequestByID(ctx, dr.ID)
	if got.Status != "withdrawn" || got.Row.Text("note") != "closed outside stam" {
		t.Errorf("withdrawn %+v", got.Row)
	}
	if ws, _ := d.ListWaits(ctx, "apr1"); len(ws) != 0 {
		t.Errorf("waits after the withdrawal %+v", ws)
	}
	if _, ok, _ := d.PendingDialog(ctx, "apr1"); ok {
		t.Error("a dialog still pending")
	}
	// The list: newest first, by status, without the payload in the public form.
	all, _ := d.ListPermissionRequests(ctx, "")
	if len(all) != 2 || all[0].ID != dr.ID {
		t.Errorf("list %+v", all)
	}
	if w, _ := d.ListPermissionRequests(ctx, "withdrawn"); len(w) != 1 || w[0].ID != dr.ID {
		t.Errorf("withdrawn list %+v", w)
	}
	execSQL(t, conn, "UPDATE permission_requests SET payload = 'SECRET' WHERE id = ?", dr.ID)
	got, _, _ = d.PermissionRequestByID(ctx, dr.ID)
	pub, err := d.PublicRequest(ctx, got, "m9")
	if err != nil {
		t.Fatal(err)
	}
	if _, has := pub.Get("payload"); has || pub.Text("agent_name") != "asker" || pub.Text("machine") != "test-machine" {
		t.Errorf("public %s", pub.Keys)
	}
}

// TestPublicRequestWith: a pending delegate ask names the reviewers its first mail went to, by name (a peer agent's
// remembered name, else the id), and that mail's subject; an agent gone reads as no name on this machine.
func TestPublicRequestWith(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	ctx := context.Background()
	newTestAgent(t, d, "apw1", "asker")
	newTestAgent(t, d, "apw2", "rev")
	r, err := d.CreatePermissionRequest(ctx, NewRequest{AgentID: "apw1", Action: "a", Reviewer: "apw2"})
	if err != nil {
		t.Fatal(err)
	}
	execSQL(t, conn, "INSERT INTO peer_agents (id, name, machine, updated_at) VALUES ('afar', 'far', 'm2', '2026-01-01')")
	execSQL(t, conn, "INSERT INTO mail (id, from_id, subject, body, created_at, permission_id) VALUES ('mw1', 'apw1', 'asker wants to run: ls', 'b', '2026-01-01T00:00:00.000Z', ?)", r.ID)
	for _, to := range []string{"apw2", "afar", "anone", "human"} {
		execSQL(t, conn, "INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mw1', ?)", to)
	}
	pub, err := d.PublicRequest(ctx, r, "m9")
	if err != nil {
		t.Fatal(err)
	}
	with, _ := pub.Get("with")
	if len(with.Items) != 3 || with.Items[0].Str != "rev" || with.Items[1].Str != "far" || with.Items[2].Str != "anone" || pub.Text("subject") != "asker wants to run: ls" {
		t.Errorf("public %s", string(pub.Keys[0]))
	}
	if ids, _ := d.PermissionMailIDs(ctx, r.ID); len(ids) != 1 || ids[0] != "mw1" {
		t.Errorf("mail ids %q", ids)
	}
	execSQL(t, conn, "DELETE FROM agents WHERE id = 'apw1'")
	pub, _ = d.PublicRequest(ctx, r, "m9")
	if v, _ := pub.Get("agent_name"); v.Str != "" || pub.Text("machine") != "m9" {
		t.Errorf("gone agent: %v %s", v, pub.Text("machine"))
	}
	if life, known, _ := d.PeerAgentLifecycle(ctx, "afar"); known {
		t.Errorf("lifecycle %q known", life)
	}
	execSQL(t, conn, "UPDATE peer_agents SET lifecycle = 'paused' WHERE id = 'afar'")
	if life, known, _ := d.PeerAgentLifecycle(ctx, "afar"); !known || life != "paused" {
		t.Errorf("lifecycle %q %v", life, known)
	}
}
