package db

import (
	"context"
	"testing"
)

// TestRequestRestUntilMoved: a rest is stamped on a wait only while its until is the one its creation returned; a
// repeating wake_me that fired in between moved it, and the request is left alone (S-4332 review).
func TestRequestRestUntilMoved(t *testing.T) {
	ctx := context.Background()
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "arq1", "rester")
	first, next := "2026-10-28T10:00:00.000Z", "2026-10-28T11:00:00.000Z"
	w, err := d.AddWait(ctx, NewWait{AgentID: "arq1", Kind: "timer", Source: "stam", Until: &first})
	if err != nil {
		t.Fatal(err)
	}
	execSQL(t, conn, "UPDATE waits SET until = '"+next+"' WHERE id = '"+w.ID+"'")
	if ok, err := d.RequestRest(ctx, "arq1", w.ID, w.Until); err != nil || ok {
		t.Fatalf("a moved until: %v %v", ok, err)
	}
	if ids, _ := d.RestRequesters(ctx); len(ids) != 0 {
		t.Errorf("requesters after a moved until: %v", ids)
	}
	if ok, err := d.RequestRest(ctx, "arq1", w.ID, &next); err != nil || !ok {
		t.Fatalf("the current until: %v %v", ok, err)
	}
	if ids, _ := d.RestRequesters(ctx); len(ids) != 1 {
		t.Errorf("requesters: %v", ids)
	}
}
