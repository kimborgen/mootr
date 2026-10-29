package db

import (
	"context"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/jsfmt"
)

// A file the TS daemon has not migrated to bbcb08f9 lacks itsa_fields.kinds (S-3233). Open refuses it, as it refuses the
// participants table without left_at (S-3015), instead of failing on the first ITSA read.
func TestRefusesAnUnmigratedFieldKinds(t *testing.T) {
	path := testDB(t)
	conn := rawConn(t, path)
	if err := sqlitex.ExecuteTransient(conn, "ALTER TABLE itsa_fields DROP COLUMN kinds", nil); err != nil {
		t.Fatal(err)
	}
	conn.Close()
	if _, err := Open(context.Background(), path, Options{}); err == nil || !strings.Contains(err.Error(), "itsa_fields") || !strings.Contains(err.Error(), "kinds") {
		t.Fatalf("Open err = %v, want a refusal naming itsa_fields.kinds", err)
	}
}

// FieldApplies is itsa.ts fieldApplies: null, and the JS falsy values, apply to every kind; a list applies to its kinds; anything
// else is an error, as TS throws on it (S-3233). The falsy values are what TS's `!f.kinds` takes for a field with no kinds.
func TestFieldAppliesFailsClosed(t *testing.T) {
	cases := []struct {
		raw, kind string
		want      bool
		err       bool
	}{
		{raw: `null`, kind: "work", want: true},
		{raw: `false`, kind: "work", want: true},
		{raw: `0`, kind: "work", want: true},
		{raw: `""`, kind: "work", want: true},
		{raw: `["work"]`, kind: "Work", want: true},
		{raw: `["work"]`, kind: "other", want: false},
		{raw: `["work"]`, kind: "", want: false},
		{raw: `{"work":true}`, kind: "work", err: true},
		{raw: `"work"`, kind: "work", err: true},
		{raw: `5`, kind: "work", err: true},
		{raw: `true`, kind: "work", err: true},
		// An ITSA with no kind matches none, so TS never reaches the stored kinds' type (S-3233).
		{raw: `"work"`, kind: "", want: false},
		{raw: `{"work":true}`, kind: "", want: false},
		{raw: `5`, kind: "", want: false},
		// A list item that isn't a string throws in TS where it is reached, and the match stops the walk before it.
		{raw: `[1]`, kind: "work", err: true},
		{raw: `[null]`, kind: "work", err: true},
		{raw: `["other", 1]`, kind: "work", err: true},
		{raw: `["work", 1]`, kind: "work", want: true},
	}
	for _, c := range cases {
		v, err := jsfmt.Parse([]byte(c.raw))
		if err != nil {
			t.Fatalf("parse %s: %v", c.raw, err)
		}
		got, err := FieldApplies(v, c.kind)
		if c.err {
			if err == nil {
				t.Errorf("FieldApplies(%s, %q) = %v, want a refusal", c.raw, c.kind, got)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("FieldApplies(%s, %q) = %v, %v; want %v", c.raw, c.kind, got, err, c.want)
		}
	}
}

// A stored kinds that isn't a list refuses the reads of the field's values, as TS's fieldValuesByItsa throws (S-3233), rather
// than showing the value to an ITSA the field doesn't apply to.
func TestFieldValuesRefuseNonListKinds(t *testing.T) {
	for _, raw := range []string{`{"a":1}`, `"work"`, `["work"`} {
		path := testDB(t)
		d := openTest(t, path)
		conn := rawConn(t, path)
		run := func(sql string) {
			t.Helper()
			if err := sqlitex.ExecuteTransient(conn, sql, nil); err != nil {
				t.Fatal(err)
			}
		}
		run("INSERT INTO itsas (id, key, title, status, kind, created_by, created_at, updated_at) VALUES ('ikind', 'S-1', 'Kind', 'backlog', 'work', 'human', 't', 't')")
		run("INSERT INTO itsa_fields (id, key, label, type, width, align, card, kinds, position, created_by, created_at, updated_at) VALUES ('fkind', 'scope', 'Scope', 'text', 'm', 'start', 'chip', '" + raw + "', 0, 'human', 't', 't')")
		run("INSERT INTO itsa_field_values (itsa_id, field_id, value, updated_by, updated_at) VALUES ('ikind', 'fkind', '\"core\"', 'human', 't')")
		if _, err := d.ItsaFieldValues(context.Background(), "ikind"); err == nil {
			t.Errorf("kinds %s: the values of an ITSA read, want a refusal", raw)
		}
		conn.Close()
	}
}
