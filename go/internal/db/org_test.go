package db

import (
	"context"
	"errors"
	"sync"
	"testing"

	"zombiezen.com/go/sqlite"
)

type obsKey struct{}

// TestObserveActivity: the observer hears an activity change once its write commits, with the write's context and the
// row as the write left it; a rolled-back write tells it nothing, and an unchanged activity is no change.
func TestObserveActivity(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "aob1", "watched")
	execSQL(t, conn, "UPDATE agents SET lifecycle = 'active', activity = 'idle', last_message = 'hi' WHERE id = 'aob1'")
	var got []ActivityChange
	var seen []string
	d.ObserveActivity(func(ctx context.Context, c ActivityChange) {
		got = append(got, c)
		// A read now sees the write committed.
		a, err := d.GetAgent(context.Background(), c.ID)
		if err != nil {
			t.Error(err)
		}
		v, _ := ctx.Value(obsKey{}).(string)
		seen = append(seen, string(a.Activity)+"|"+v)
	})
	ctx := context.WithValue(context.Background(), obsKey{}, "mine")
	if err := d.UpdateAgent(ctx, "aob1", Field{Col: "activity", Val: "working"}, Field{Col: "activity_detail", Val: "busy"}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Kind != "activity" || got[0].Before != "idle" || got[0].After != "working" || got[0].Name != "watched" ||
		deref(got[0].Detail) != "busy" || deref(got[0].LastMessage) != "hi" || seen[0] != "working|mine" {
		t.Errorf("changes %+v, seen %q", got, seen)
	}
	// The same activity again is no change.
	if err := d.UpdateAgent(ctx, "aob1", Field{Col: "activity", Val: "working"}); err != nil {
		t.Fatal(err)
	}
	// A write that fails after recording rolls back, and its changes go with it.
	boom := errors.New("boom")
	err := d.Write(ctx, func(conn *sqlite.Conn) error {
		d.noteActivity(ActivityChange{Kind: "activity", ID: "aob1", Before: "working", After: "idle"})
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("write: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("after the unchanged write and the rollback: %+v", got)
	}
	// Nor does the next write carry them.
	if err := d.UpdateAgent(ctx, "aob1", Field{Col: "last_message", Val: "x"}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Errorf("a later write: %+v", got)
	}
	// Claiming an idle agent is a change too.
	if err := d.UpdateAgent(ctx, "aob1", Field{Col: "activity", Val: "idle"}); err != nil {
		t.Fatal(err)
	}
	a, err := d.GetAgent(ctx, "aob1")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := d.ClaimIdle(ctx, "aob1", a.IdleSince, "a nudge"); err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	if len(got) != 3 || got[2].Before != "idle" || got[2].After != "working" || deref(got[2].RequestedDetail) != "a nudge" {
		t.Errorf("claim: %+v", got)
	}
	d.ObserveActivity(nil)
	if err := d.UpdateAgent(ctx, "aob1", Field{Col: "activity", Val: "idle"}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Errorf("after removing the observer: %+v", got)
	}
}

// TestObserveActivityOrder: concurrent writes reach the observer in commit order, so each change starts where the one
// before it ended.
func TestObserveActivityOrder(t *testing.T) {
	path := testDB(t)
	d := openTest(t, path)
	conn := rawConn(t, path)
	newTestAgent(t, d, "aoo1", "busy")
	execSQL(t, conn, "UPDATE agents SET lifecycle = 'active', activity = 'idle' WHERE id = 'aoo1'")
	var mu sync.Mutex
	var got []ActivityChange
	d.ObserveActivity(func(_ context.Context, c ActivityChange) {
		mu.Lock()
		got = append(got, c)
		mu.Unlock()
	})
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 40 {
				act := []string{"working", "blocked", "idle"}[(g+i)%3]
				if err := d.UpdateAgent(context.Background(), "aoo1", Field{Col: "activity", Val: act}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if len(got) == 0 {
		t.Fatal("no changes")
	}
	for i := 1; i < len(got); i++ {
		if got[i].Before != got[i-1].After {
			t.Fatalf("change %d starts at %s, but the one before ended at %s", i, got[i].Before, got[i-1].After)
		}
	}
}
