package db

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

// TestThreadsMatchTS replays the thread list, archive, defer, kept-open, unread, decision and human-wait functions of
// src/db.ts and src/waits.ts (testdata/threadsref.mjs) on a copy of the same database and compares every result, in JSON
// text, and the tables they leave behind.
func TestThreadsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/db.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("node", "--no-warnings", "testdata/threadsref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("threadsref.mjs: %v\n%s", err, out)
	}
	want, err := os.ReadFile(filepath.Join(home, "expect.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantV, err := jsfmt.Parse(want)
	if err != nil {
		t.Fatal(err)
	}
	pre, err := os.ReadFile(filepath.Join(home, "stam.pre.db"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "stam.db")
	if err := os.WriteFile(path, pre, 0o600); err != nil {
		t.Fatal(err)
	}
	d := openTest(t, path)
	ctx := context.Background()

	got := jsfmt.Value{Kind: jsfmt.Object}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	strs := func(list []string) jsfmt.Value {
		items := []jsfmt.Value{}
		for _, s := range list {
			items = append(items, jsfmt.StringValue(s))
		}
		return jsfmt.ArrayValue(items)
	}
	bools := func(list ...bool) jsfmt.Value {
		items := []jsfmt.Value{}
		for _, b := range list {
			items = append(items, jsfmt.Value{Kind: jsfmt.Bool, Bool: b})
		}
		return jsfmt.ArrayValue(items)
	}
	ids := func(groups []ThreadGroup) jsfmt.Value {
		var out []string
		for _, g := range groups {
			out = append(out, g.ThreadID)
		}
		return strs(out)
	}
	threads := func(box string, limit int, with string) []ThreadGroup {
		t.Helper()
		g, err := d.Threads(ctx, box, limit, with)
		must(err)
		return g
	}
	groups := func(gs []ThreadGroup) jsfmt.Value {
		out := []jsfmt.Value{}
		for _, g := range gs {
			v := jsfmt.Value{Kind: jsfmt.Object}
			v.Set("thread_id", jsfmt.StringValue(g.ThreadID))
			v.Set("mails", jsfmt.ArrayValue(g.Mails))
			out = append(out, v)
		}
		return jsfmt.ArrayValue(out)
	}
	split := func(box string, keep ...string) jsfmt.Value {
		t.Helper()
		k := map[string]bool{}
		for _, x := range keep {
			k[x] = true
		}
		active, archived, err := d.SplitArchived(ctx, box, threads(box, 50, ""), k)
		must(err)
		rest, deferred, err := d.SplitDeferred(ctx, box, active)
		must(err)
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("active", ids(rest))
		v.Set("archived", ids(archived))
		v.Set("deferred", ids(deferred))
		return v
	}
	query := func(q string) jsfmt.Value {
		t.Helper()
		var out []jsfmt.Value
		must(d.Read(ctx, func(conn *sqlite.Conn) error {
			var err error
			out, err = rows(conn, q)
			return err
		}))
		if out == nil {
			out = []jsfmt.Value{}
		}
		return jsfmt.ArrayValue(out)
	}
	tables := func() jsfmt.Value {
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("archive", query("SELECT mailbox_id, thread_id FROM thread_archive ORDER BY mailbox_id, thread_id"))
		v.Set("archiveMail", query("SELECT mailbox_id, thread_id, mail_id FROM thread_archive_mail ORDER BY mailbox_id, thread_id, mail_id"))
		v.Set("defer", query("SELECT mailbox_id, thread_id FROM thread_defer ORDER BY mailbox_id, thread_id"))
		v.Set("deferMail", query("SELECT mailbox_id, thread_id, mail_id FROM thread_defer_mail ORDER BY mailbox_id, thread_id, mail_id"))
		v.Set("keptOpen", query("SELECT mailbox_id, thread_id, mail_ids FROM thread_kept_open ORDER BY mailbox_id, thread_id"))
		return v
	}
	// send is the reference's later mail, as src/db.ts createMail stores the columns the reads below look at.
	send := func(id, from, thread, at string, notice int, to ...string) {
		t.Helper()
		must(d.Write(ctx, func(conn *sqlite.Conn) error {
			if err := runSQL(conn, "INSERT INTO mail (id, from_id, subject, body, created_at, thread_id, notice) VALUES (?, ?, 's', 'b', ?, ?, ?)", id, from, at, thread, notice); err != nil {
				return err
			}
			for _, r := range to {
				if err := runSQL(conn, "INSERT INTO mail_recipients (mail_id, agent_id) VALUES (?, ?)", id, r); err != nil {
					return err
				}
			}
			return nil
		}))
	}

	got.Set("threadsBoss", groups(threads("aboss", 10, "")))
	got.Set("threadsHumanWith", ids(threads("human", 10, "aw1")))
	got.Set("threadsLimit", ids(threads("aboss", 1, "")))
	got.Set("threadsNobody", groups(threads("human", 10, "nobody")))
	got.Set("splitBefore", split("human"))
	must(d.ArchiveThread(ctx, "human", "m0000007", []string{"m0000007"}))
	must(d.ArchiveThread(ctx, "human", "m0000001", []string{"m0000001", "m0000002"}))
	must(d.DeferThread(ctx, "aw1", "m0000004", []string{"m0000004"}))
	na, err := d.ArchivedCount(ctx, "human")
	must(err)
	nd, err := d.DeferredCount(ctx, "aw1")
	must(err)
	nw, err := d.ArchivedCount(ctx, "aw1")
	must(err)
	got.Set("counts", jsfmt.ArrayValue([]jsfmt.Value{jsfmt.IntValue(int64(na)), jsfmt.IntValue(int64(nd)), jsfmt.IntValue(int64(nw))}))
	got.Set("splitHuman", split("human"))
	got.Set("splitHumanKeep", split("human", "m0000001"))
	got.Set("splitAw1", split("aw1"))
	send("m0000008", "system:deploy-watch", "m0000004", "2026-10-01T00:00:17.000Z", 1, "aw1")
	got.Set("splitAw1Notice", split("aw1"))
	send("m0000009", "aboss", "m0000004", "2026-10-01T00:00:18.000Z", 0, "aw1")
	got.Set("splitAw1Mail", split("aw1"))
	must(d.DeferThread(ctx, "human", "m0000007", []string{"m0000007"}))
	must(d.ArchiveThread(ctx, "aw1", "m0000004", []string{"m0000004", "m0000008", "m0000009"}))
	got.Set("tablesMid", tables())
	must(d.UndeferThread(ctx, "human", "m0000007"))
	must(d.UnarchiveThread(ctx, "human", "m0000001"))
	must(d.KeepOpen(ctx, "human", "m0000001", []string{"m0000002", "m0000001", "m0000002"}))
	k1, err := d.KeptOpen(ctx, "human", "m0000001", []string{"m0000002"})
	must(err)
	k2, err := d.KeptOpen(ctx, "human", "m0000001", []string{"m0000002", "m0000009"})
	must(err)
	k3, err := d.KeptOpen(ctx, "human", "m0000007", nil)
	must(err)
	got.Set("kept", bools(k1, k2, k3))
	must(d.MarkAutoArchived(ctx, "human", "m0000007"))
	must(d.MarkAutoArchived(ctx, "human", "m0000001"))
	must(d.ForgetAutoArchived(ctx, "human", "m0000001"))
	auto, err := d.AutoArchivedThreads(ctx, "human")
	must(err)
	got.Set("auto", strs(auto))
	u1, err := d.MarkUnread(ctx, "human", []string{"m0000002", "m0000007", "m0000003", "nosuch"})
	must(err)
	u2, err := d.MarkUnread(ctx, "human", []string{"m0000002"})
	must(err)
	u3, err := d.MarkUnread(ctx, "human", nil)
	must(err)
	got.Set("unread", jsfmt.ArrayValue([]jsfmt.Value{strs(u1), strs(u2), strs(u3)}))
	decisions, err := d.DecisionMails(ctx)
	must(err)
	got.Set("decisions", jsfmt.ArrayValue(append([]jsfmt.Value{}, decisions...)))
	o1, err := d.DecisionMailOpen(ctx, "m0000002")
	must(err)
	o2, err := d.DecisionMailOpen(ctx, "m0000007")
	must(err)
	got.Set("decisionOpen", bools(o1, o2))
	must(d.RemoveDecisionMail(ctx, "m0000002", "superseded"))
	after, err := d.DecisionMails(ctx)
	must(err)
	got.Set("decisionsAfter", jsfmt.ArrayValue(append([]jsfmt.Value{}, after...)))
	t1, err := d.IsThreadDeferred(ctx, "m0000001")
	must(err)
	t2, err := d.IsThreadDeferred(ctx, "m0000004")
	must(err)
	got.Set("threadDeferred", bools(t1, t2))
	rcpt, err := d.MailRecipientIDs(ctx, "m0000005")
	must(err)
	got.Set("recipients", strs(rcpt))
	ws, err := d.OpenHumanWaits(ctx)
	must(err)
	wv := []jsfmt.Value{}
	opt := func(p *string) jsfmt.Value {
		if p == nil {
			return jsfmt.NullValue()
		}
		return jsfmt.StringValue(*p)
	}
	for _, w := range ws {
		v := jsfmt.Value{Kind: jsfmt.Object}
		v.Set("thread", opt(w.Thread))
		v.Set("target", opt(w.Target))
		v.Set("agent", opt(w.Agent))
		wv = append(wv, v)
	}
	got.Set("humanWaits", jsfmt.ArrayValue(wv))
	got.Set("tables", tables())
	got.Set("readState", query("SELECT mail_id, agent_id, read_at FROM mail_recipients WHERE agent_id = 'human' ORDER BY mail_id"))

	for i, k := range wantV.Keys {
		g, ok := got.Get(k)
		if !ok {
			t.Errorf("no result %s", k)
			continue
		}
		if a, b := jsfmt.Compact(wantV.Items[i]), jsfmt.Compact(g); a != b {
			t.Errorf("%s differs\n ts: %s\n go: %s", k, a, b)
		}
	}
	if len(wantV.Keys) != len(got.Keys) {
		t.Errorf("ts has %d results, go %d", len(wantV.Keys), len(got.Keys))
	}
}
