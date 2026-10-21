package db

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"
)

// TestPushQueries: the unread mail a push lists, loud only or all, newest first and deferred mail left out; the
// unpushed mail, of which MarkPushed marks only the mails named; and the agent's blockers as admission words them.
func TestPushQueries(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "alq1", "pusher")
	newTestAgent(t, d, "alq2", "sender")
	send := func(id, from, fromName, subject string, quiet bool) {
		t.Helper()
		m := Stored{ID: id, ThreadID: id, From: from, FromName: fromName, Subject: subject, Body: "b", To: []string{"alq1"}}
		if quiet {
			m.Quiet = []string{"alq1"}
		}
		if _, err := d.StoreMail(ctx, m); err != nil {
			t.Fatal(err)
		}
		execSQL(t, conn, fmt.Sprintf("UPDATE mail SET created_at = '2026-10-21T00:00:0%s.000Z' WHERE id = '%s'", id[len(id)-1:], id))
	}
	send("mq1", "human", "human", "one", false)
	send("mq2", "alq2", "sender", "two", true)
	send("mq3", "alq2", "sender", "three", false)
	send("mq4", "human", "human", "deferred", false)
	execSQL(t, conn, "INSERT INTO thread_defer_mail (mailbox_id, thread_id, mail_id) VALUES ('alq1', 'mq4', 'mq4')")
	list := func(loud bool, limit int) string {
		t.Helper()
		n, ms, err := d.MailNotice(ctx, "alq1", loud, limit)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, m := range ms {
			out = append(out, m.ID+":"+m.FromID+":"+*m.FromName+":"+m.Subject)
		}
		return fmt.Sprint(n, " ", strings.Join(out, ","))
	}
	if got := list(false, 10); got != "3 mq3:alq2:sender:three,mq2:alq2:sender:two,mq1:human:human:one" {
		t.Errorf("all: %s", got)
	}
	if got := list(true, 10); got != "2 mq3:alq2:sender:three,mq1:human:human:one" {
		t.Errorf("loud: %s", got)
	}
	if got := list(false, 1); got != "3 mq3:alq2:sender:three" {
		t.Errorf("limited: %s", got)
	}

	unpushed := func() string {
		t.Helper()
		ids, err := d.Unpushed(ctx, "alq1")
		if err != nil {
			t.Fatal(err)
		}
		return strings.Join(ids, ",")
	}
	if got := unpushed(); got != "mq1,mq2,mq3" {
		t.Errorf("unpushed: %s", got)
	}
	if err := d.MarkPushed(ctx, "alq1", []string{"mq1", "mq3"}); err != nil {
		t.Fatal(err)
	}
	if err := d.MarkPushed(ctx, "alq1", nil); err != nil {
		t.Fatal(err)
	}
	if got := unpushed(); got != "mq2" {
		t.Errorf("after the mark: %s", got)
	}
	// Read mail isn't unpushed.
	execSQL(t, conn, "UPDATE mail_recipients SET read_at = 'x' WHERE mail_id = 'mq2'")
	if got := unpushed(); got != "" {
		t.Errorf("after the read: %s", got)
	}

	if b, err := d.Blockers(ctx, "alq1"); err != nil || len(b) != 0 {
		t.Fatalf("no blockers: %v %v", b, err)
	}
	execSQL(t, conn, "INSERT INTO blockers (agent_id, kind, account, reason, since) VALUES ('alq1', 'window', 'max', 'at 100%', '2'), ('alq1', 'taken-over', '', 'by x', '1'), ('alq2', 'error', '', 'other', '0')")
	if b, err := d.Blockers(ctx, "alq1"); err != nil || strings.Join(b, "; ") != "taken-over: by x; window on max: at 100%" {
		t.Errorf("blockers: %v %v", b, err)
	}
}

// TestPushMailSnapshot: PushMail's unpushed mail and the count and list it prompts with come from one snapshot, so a
// mail stored between its two queries is in neither, and the next push names it.
func TestPushMailSnapshot(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	newTestAgent(t, d, "alm1", "pusher")
	send := func(id string) {
		t.Helper()
		if _, err := d.StoreMail(ctx, Stored{ID: id, ThreadID: id, From: "human", FromName: "human", Subject: id, Body: "b", To: []string{"alm1"}}); err != nil {
			t.Fatal(err)
		}
	}
	read := func() string {
		t.Helper()
		ids, n, list, err := d.PushMail(ctx, "alm1", 10)
		if err != nil {
			t.Fatal(err)
		}
		var listed []string
		for _, m := range list {
			listed = append(listed, m.ID)
		}
		// Mail stored in the same millisecond has no order.
		sort.Strings(listed)
		return fmt.Sprint(strings.Join(ids, ","), " ", n, " ", strings.Join(listed, ","))
	}
	if got := read(); got != " 0 " {
		t.Errorf("none: %q", got)
	}
	send("mm1")
	pushMailBetween = func() { pushMailBetween = nil; send("mm2") }
	t.Cleanup(func() { pushMailBetween = nil })
	if got := read(); got != "mm1 1 mm1" {
		t.Errorf("with a mail stored mid-read: %q", got)
	}
	if err := d.MarkPushed(ctx, "alm1", []string{"mm1"}); err != nil {
		t.Fatal(err)
	}
	if got := read(); got != "mm2 2 mm1,mm2" {
		t.Errorf("the next push: %q", got)
	}
}
