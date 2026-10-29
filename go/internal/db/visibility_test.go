package db

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"testing"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// TestVisibilityFailsClosed: a visibility column that doesn't parse, or a field with a wrong type or value, must not
// open what the agent may reach or see (S-4003). Each row is written with UpdateAgent, as set-visibility writes it, then
// corrupted with SQL, and read back through GetAgent. src/org.ts visibilityOf must decode every column the same way.
func TestVisibilityFailsClosed(t *testing.T) {
	ctx := context.Background()
	d := openTest(t, testDB(t))
	open := Visibility{Reach: "all", Siblings: true, Registry: true}
	closed := Visibility{Reach: "parent", Siblings: false, Registry: false}
	const nullCol = "\x00NULL"
	cases := []struct {
		col  string
		want Visibility
	}{
		// The must-fail inputs: each decoded open before S-4003.
		{`{"reach":"tree","registry":false`, closed},
		{`{"reach":5,"registry":false}`, Visibility{Reach: "parent", Siblings: true, Registry: false}},
		{`{"reach":"bogus"}`, Visibility{Reach: "parent", Siblings: true, Registry: true}},
		{`{"siblings":"yes"}`, Visibility{Reach: "all", Siblings: false, Registry: true}},
		// Other columns that aren't a JSON object, and fields that hold null or a number.
		{``, closed},
		{`null`, closed},
		{`[]`, closed},
		{`"all"`, closed},
		{`{"reach":null,"siblings":null,"registry":null}`, closed},
		{`{"registry":1}`, Visibility{Reach: "all", Siblings: true, Registry: false}},
		// Valid columns decode as they did.
		{nullCol, open},
		{`{}`, open},
		{`{"reach":"tree"}`, Visibility{Reach: "tree", Siblings: true, Registry: true}},
		{`{"reach":"parent","siblings":true,"registry":false}`, Visibility{Reach: "parent", Siblings: true, Registry: false}},
		{`{"reach":"tree","siblings":false,"registry":true,"note":"x"}`, Visibility{Reach: "tree", Siblings: false, Registry: true}},
		{`{"reach":"all","siblings":false,"registry":false}`, Visibility{Reach: "all", Siblings: false, Registry: false}},
	}
	var cols []any
	for _, tc := range cases {
		must(t, d.UpdateAgent(ctx, "aboss", Field{Col: "visibility", Val: `{"reach":"tree","siblings":true,"registry":true}`}))
		var val any = tc.col
		if tc.col == nullCol {
			val = nil
		}
		cols = append(cols, val)
		must(t, d.Write(ctx, func(conn *sqlite.Conn) error {
			return sqlitex.Execute(conn, "UPDATE agents SET visibility = ? WHERE id = 'aboss'", &sqlitex.ExecOptions{Args: []any{val}})
		}))
		a, err := d.GetAgent(ctx, "aboss")
		must(t, err)
		if got := a.VisibilityOf(); got != tc.want {
			t.Errorf("visibility %q = %+v, want %+v", tc.col, got, tc.want)
		}
	}

	payload, _ := json.Marshal(cols)
	cmd := exec.Command("node", "--no-warnings", "testdata/visibilityref.mjs", t.TempDir())
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("visibilityref.mjs: %v", err)
	}
	var ts []Visibility
	must(t, json.Unmarshal(out, &ts))
	for i, tc := range cases {
		if ts[i] != tc.want {
			t.Errorf("ts visibility %q = %+v, want %+v", tc.col, ts[i], tc.want)
		}
	}
}
