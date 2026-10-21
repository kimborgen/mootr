package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

var (
	reMailID = regexp.MustCompile(`\bm[0-9a-f]{7}\b`)
	reStamp  = regexp.MustCompile(`[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12}Z`)
)

// masked hides what differs between two runs: the ids a send draws (numbered in the order they appear) and the times.
func masked(s string) string {
	ids := map[string]string{}
	s = reMailID.ReplaceAllStringFunc(s, func(id string) string {
		if _, ok := ids[id]; !ok {
			ids[id] = "M" + string(rune('A'+len(ids)))
		}
		return ids[id]
	})
	return reStamp.ReplaceAllString(s, "T")
}

// dump runs a query and returns its rows as ordered objects.
func dump(t *testing.T, f *fixture, query string) jsfmt.Value {
	t.Helper()
	var out []jsfmt.Value
	must(t, f.db.Read(context.Background(), func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, query, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			row := jsfmt.Value{Kind: jsfmt.Object}
			for i := 0; i < stmt.ColumnCount(); i++ {
				v := jsfmt.StringValue(stmt.ColumnText(i))
				switch stmt.ColumnType(i) {
				case sqlite.TypeNull:
					v = jsfmt.NullValue()
				case sqlite.TypeInteger:
					v = jsfmt.IntValue(stmt.ColumnInt64(i))
				}
				row.Set(stmt.ColumnName(i), v)
			}
			out = append(out, row)
			return nil
		}})
	}))
	if out == nil {
		out = []jsfmt.Value{}
	}
	return jsfmt.ArrayValue(out)
}

// TestSendMatchesTS runs the steps of testdata/send-steps.json through src/mail.ts sendMail on one database and through
// POST /api/mail on a copy of it, and compares every answer, status and error, and the tables the sends leave behind.
func TestSendMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/mail.ts")
	}
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/sendref.mjs", home).CombinedOutput(); err != nil {
		t.Fatalf("sendref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)

	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	stepsRaw, err := os.ReadFile("testdata/send-steps.json")
	must(t, err)
	var steps []struct {
		Do    string
		Input json.RawMessage
		Agent string
		IDs   []string
	}
	must(t, json.Unmarshal(stepsRaw, &steps))
	var ids []string
	sub := func(s string) string {
		if len(s) > 1 && s[0] == '#' {
			if n, err := strconv.Atoi(s[1:]); err == nil && n < len(ids) {
				return ids[n]
			}
		}
		return s
	}
	var results []jsfmt.Value
	for i, st := range steps {
		res := jsfmt.Value{Kind: jsfmt.Object}
		res.Set("step", jsfmt.IntValue(int64(i)))
		if st.Do == "read" {
			var in []string
			for _, id := range st.IDs {
				in = append(in, sub(id))
			}
			got, _, _, err := f.db.ReadMail(context.Background(), st.Agent, in, "")
			must(t, err)
			var got_ids []jsfmt.Value
			for _, m := range got {
				got_ids = append(got_ids, jsfmt.StringValue(m.Text("id")))
			}
			res.Set("read", jsfmt.ArrayValue(got_ids))
			results = append(results, res)
			ids = append(ids, "")
			continue
		}
		in, err := jsfmt.Parse(st.Input)
		must(t, err)
		substitute(&in, sub)
		rec := f.sendH("POST", "/api/mail", sharedTok, map[string]string{"X-Stam-Human": "1"}, jsfmt.Compact(in))
		res.Set("status", jsfmt.IntValue(int64(rec.Code)))
		parsed, perr := jsfmt.Parse(rec.Body.Bytes())
		must(t, perr)
		if rec.Code == 200 {
			res.Set("result", parsed)
			ids = append(ids, parsed.Text("id"))
		} else {
			res.Set("error", jsfmt.StringValue(parsed.Text("error")))
			ids = append(ids, "")
		}
		results = append(results, res)
	}

	wantResults, _ := want.Get("results")
	if len(wantResults.Items) != len(results) {
		t.Fatalf("ts ran %d steps, go %d", len(wantResults.Items), len(results))
	}
	for i := range results {
		if a, b := masked(jsfmt.Compact(wantResults.Items[i])), masked(jsfmt.Compact(results[i])); a != b {
			t.Errorf("step %d (%s) differs\n ts: %s\n go: %s", i, strings.TrimSpace(string(steps[i].Input)), a, b)
		}
	}
	wantTables, _ := want.Get("tables")
	queries := map[string]string{
		"mail":       "SELECT id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note FROM mail ORDER BY rowid",
		"recipients": "SELECT mail_id, agent_id, read_at, quiet FROM mail_recipients ORDER BY rowid",
		"events":     "SELECT agent_id, type, data FROM events ORDER BY id",
		"waits":      "SELECT agent_id, kind, target, source FROM waits ORDER BY rowid",
		"agents":     "SELECT id, activity, activity_detail FROM agents ORDER BY id",
		"decisions":  "SELECT mail_id, thread_id FROM decision_mails ORDER BY rowid",
		"deferred":   "SELECT thread_id, mail_id FROM thread_deferred ORDER BY rowid",
		"deferMail":  "SELECT mailbox_id, thread_id, mail_id FROM thread_defer_mail ORDER BY rowid",
	}
	for i, name := range wantTables.Keys {
		got := dump(t, f, queries[name])
		expect := wantTables.Items[i]
		if name == "events" {
			// The notice to the parent of a stopped recipient (tellStopped) is the notice queue's, not ported.
			var kept []jsfmt.Value
			for _, e := range expect.Items {
				if e.Text("type") != "notice:queued" {
					kept = append(kept, e)
				}
			}
			expect = jsfmt.ArrayValue(kept)
		}
		if a, b := masked(jsfmt.Compact(expect)), masked(jsfmt.Compact(got)); a != b {
			t.Errorf("table %s differs\n ts: %s\n go: %s", name, a, b)
		}
	}
}

// substitute applies fn to every string in v.
func substitute(v *jsfmt.Value, fn func(string) string) {
	switch v.Kind {
	case jsfmt.String:
		v.Str = fn(v.Str)
	case jsfmt.Array, jsfmt.Object:
		for i := range v.Items {
			substitute(&v.Items[i], fn)
		}
	}
}
