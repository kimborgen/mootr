package db

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"

	"stam/internal/jsfmt"
)

var readAtStamp = regexp.MustCompile(`"read_at":"[0-9T:.\-]+Z"`)

// mask hides when a mail was read: the reference ran at another moment than the Go replay.
func mask(s string) string { return readAtStamp.ReplaceAllString(s, `"read_at":"T"`) }

// TestMailReadsMatchTS replays the mail reads of src/db.ts (testdata/mailref.mjs) on a copy of the same database and
// compares every result, in JSON text, so key order, null and number forms, read marks, owed batches and the deliveries
// left behind all match.
func TestMailReadsMatchTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/db.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("node", "--no-warnings", "testdata/mailref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("mailref.mjs: %v\n%s", err, out)
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
	arr := func(rows []jsfmt.Value) jsfmt.Value {
		if rows == nil {
			rows = []jsfmt.Value{}
		}
		return jsfmt.ArrayValue(rows)
	}
	ids := func(list []string) jsfmt.Value {
		items := []jsfmt.Value{}
		for _, s := range list {
			items = append(items, jsfmt.StringValue(s))
		}
		return jsfmt.ArrayValue(items)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	add := func(name string, v jsfmt.Value, err error) {
		t.Helper()
		must(err)
		got.Set(name, v)
	}
	rowsOf := func(v []jsfmt.Value, err error) (jsfmt.Value, error) { return arr(v), err }
	idsOf := func(v []string, err error) (jsfmt.Value, error) { return ids(v), err }

	v, err := rowsOf(d.Inbox(ctx, "aw1", true, 20))
	add("inboxUnread", v, err)
	v, err = rowsOf(d.Inbox(ctx, "aw1", false, 2))
	add("inboxAll2", v, err)
	v, err = rowsOf(d.Inbox(ctx, "human", true, 10))
	add("inboxHuman", v, err)
	v, err = rowsOf(d.ThreadMail(ctx, "m0000001", ""))
	add("thread1", v, err)
	v, err = rowsOf(d.ThreadMail(ctx, "m0000001", "aw2"))
	add("thread1Box", v, err)
	v, err = idsOf(d.DefaultRead(ctx, "aw1", 10))
	add("defaultBefore", v, err)
	read1, _, _, err := d.ReadMail(ctx, "aw1", []string{"m0000001", "m0000005", "nosuch"}, "batch-1")
	add("read1", arr(read1), err)
	v, err = idsOf(d.DefaultRead(ctx, "aw1", 10))
	add("defaultOwed", v, err)
	must(d.AckDelivered(ctx, "aw1", "batch-1"))
	v, err = idsOf(d.DefaultRead(ctx, "aw1", 10))
	add("defaultAfterAck", v, err)
	v, err = rowsOf(d.Inbox(ctx, "aw1", true, 20))
	add("inboxAfter", v, err)
	counts, err := d.UnreadCounts(ctx)
	add("unread", jsfmt.IntValue(int64(counts["aw1"])), err)
	readNo, _, _, err := d.ReadMail(ctx, "aboss", []string{"m0000002", "m0000003"}, "")
	add("readNoBatch", arr(readNo), err)
	var deliveries, recipients []jsfmt.Value
	must(d.Read(ctx, func(conn *sqlite.Conn) error {
		var err error
		if deliveries, err = rows(conn, "SELECT agent_id, mail_id, batch FROM mail_deliveries ORDER BY agent_id, mail_id, batch"); err != nil {
			return err
		}
		recipients, err = rows(conn, "SELECT mail_id, agent_id, read_at FROM mail_recipients ORDER BY mail_id, agent_id")
		return err
	}))
	add("deliveries", arr(deliveries), nil)
	add("recipients", arr(recipients), nil)

	for i, k := range wantV.Keys {
		g, ok := got.Get(k)
		if !ok {
			t.Errorf("no result %s", k)
			continue
		}
		if a, b := mask(jsfmt.Compact(wantV.Items[i])), mask(jsfmt.Compact(g)); a != b {
			t.Errorf("%s differs\n ts: %s\n go: %s", k, a, b)
		}
	}
	if !strings.Contains(jsfmt.Compact(got), `"m0000005"`) {
		t.Error("the fixture holds no mail")
	}
}
