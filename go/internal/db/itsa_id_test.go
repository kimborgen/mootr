package db

import (
	"context"
	"strings"
	"testing"

	"zombiezen.com/go/sqlite"
)

// A draw an ITSA already holds is redrawn, the held row stays, and a table that takes every
// draw gives a clear error with no row left (S-4067; itsa-id.test.mjs is the TS side).
func TestCreateItsaRedrawsATakenID(t *testing.T) {
	d := openTest(t, testDB(t))
	ctx := context.Background()
	mk := func(title string) (string, error) {
		v, err := d.CreateItsa(ctx, NewItsa{KeyPrefix: "S", Title: title, Status: "todo", By: "human"})
		if err != nil {
			return "", err
		}
		id, _ := v.Get("id")
		return id.Str, nil
	}
	held, err := mk("Held")
	if err != nil {
		t.Fatal(err)
	}
	orig := drawItsaID
	t.Cleanup(func() { drawItsaID = orig })
	draws := []string{held, "izzzz"}
	drawItsaID = func() string {
		if len(draws) == 0 {
			return held
		}
		id := draws[0]
		draws = draws[1:]
		return id
	}
	second, err := mk("Second")
	if err != nil {
		t.Fatal(err)
	}
	if second != "izzzz" {
		t.Fatalf("second id %q, want izzzz", second)
	}
	drawItsaID = func() string { return held }
	if _, err := mk("Never"); err == nil || !strings.Contains(err.Error(), "could not pick a free ITSA id") {
		t.Fatalf("every draw taken: err %v", err)
	}
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		r, err := rows(conn, "SELECT COUNT(*) AS n FROM itsas WHERE title IN ('Held','Second','Never')")
		if err != nil {
			return err
		}
		v, _ := r[0].Get("n")
		if v.Num != "2" {
			t.Errorf("rows %s, want 2", v.Num)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
