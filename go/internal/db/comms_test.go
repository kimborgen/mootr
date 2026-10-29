package db

import (
	"context"
	"strings"
	"testing"
)

// A decision mail that stops waiting on the human records one comms event with its outcome (src/db.ts settledDecisions,
// S-3828): settled with its request (here by an escalation), withdrawn, and settled by a request decided earlier. Recording
// never fails what it records.
func TestDecisionCommsEvents(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	ctx := context.Background()
	newTestAgent(t, d, "acm1", "asker")
	newTestAgent(t, d, "acm2", "rev")
	r, err := d.CreatePermissionRequest(ctx, NewRequest{AgentID: "acm1", Action: "push", Reason: "r", Details: "d", Reviewer: "acm2"})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"mc1", "mc2", "mc3", "mc4"} {
		execSQL(t, conn, "INSERT INTO mail (id, from_id, subject, body, created_at) VALUES (?, 'acm1', ?, 'b', '2026-01-01T00:00:00.000Z')", id, "about "+r.ID+" "+id)
		execSQL(t, conn, "INSERT INTO decision_mails (mail_id, thread_id) VALUES (?, ?)", id, id)
	}
	execSQL(t, conn, "UPDATE mail SET subject = 'other' WHERE id IN ('mc2', 'mc3', 'mc4')")
	if moved, err := d.EscalatePermissionRequest(ctx, r.ID); err != nil || !moved {
		t.Fatalf("escalate: %v %v", moved, err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(d.RemoveDecisionMail(ctx, "mc2", "withdrawn"))
	must(d.RemoveDecisionMail(ctx, "mc2", "withdrawn"))
	execSQL(t, conn, "UPDATE mail SET subject = 'about "+r.ID+"' WHERE id = 'mc3'")
	must(d.ClearRequestDecisionMails(ctx, "acm1", r.ID, "2026-06-01T00:00:00.000Z"))
	rows, err := textColumn(conn, "SELECT ref || ' ' || outcome || ' ' || COALESCE(label, '-') || ' ' || (duration_ms > 0) FROM comms_events WHERE kind = 'decision' ORDER BY id")
	must(err)
	got := strings.Join(rows, ", ")
	if want := "mc1 settled - 1, mc2 withdrawn - 1, mc3 settled - 1"; got != want {
		t.Errorf("comms events:\n got %s\nwant %s", got, want)
	}

	// With nowhere to record, the decision still settles.
	execSQL(t, conn, "DROP TABLE comms_events")
	must(d.RemoveDecisionMail(ctx, "mc4", "superseded"))
	if n := count(t, conn, "SELECT COUNT(*) FROM decision_mails WHERE mail_id = 'mc4'"); n != 0 {
		t.Errorf("a failed record kept the decision open")
	}
}

// ChosenOption is src/mail.ts chosenOption: one `Chose **X**.` line names the option; anything else names none.
func TestChosenOption(t *testing.T) {
	for body, want := range map[string]any{
		"Chose **billing**.":                          "billing",
		"> Which?\nChose **billing**.\n\nNote: soon": "billing",
		"Chose **billing**.\nChose **search**.":       nil,
		"I Chose **billing**.":                        nil,
		"Chose **billing**":                           nil,
		"Chose ****.":                                 nil,
		"Chose **" + strings.Repeat("x", 80) + "**.": strings.Repeat("x", 80),
		"Chose **" + strings.Repeat("x", 81) + "**.": nil,
		"Picked **A**, **B**.":                        nil,
		"> Pick?\r\nChose **billing**.\r\n\r\nNote: x": "billing",
		"Chose **" + strings.Repeat("😀", 40) + "**.": strings.Repeat("😀", 40),
		"Chose **" + strings.Repeat("😀", 41) + "**.": nil,
	} {
		if got := ChosenOption(body); got != want {
			t.Errorf("%q: %v, want %v", body, got, want)
		}
	}
}
