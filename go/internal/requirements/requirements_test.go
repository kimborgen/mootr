package requirements

import (
	"context"
	"errors"
	"testing"
)

// A table that could not be made (a busy database) is made by the next call, not refused until a restart.
func TestTableRetriesAfterAFailure(t *testing.T) {
	calls := 0
	s := &Store{makeTables: func(context.Context) error {
		calls++
		if calls == 1 {
			return errors.New("database is locked")
		}
		return nil
	}}
	if err := s.table(context.Background()); err == nil {
		t.Fatal("the first attempt should fail")
	}
	if err := s.table(context.Background()); err != nil {
		t.Fatalf("the second attempt: %v", err)
	}
	if err := s.table(context.Background()); err != nil || calls != 2 {
		t.Errorf("a made table is not made again: %v after %d calls", err, calls)
	}
}

// Clip is a text's first 60 UTF-16 units on one line.
func TestClip(t *testing.T) {
	for in, want := range map[string]string{"short": "short", "a  b\n c": "a b c", "": ""} {
		if got := Clip(in, 60); got != want {
			t.Errorf("Clip(%q) = %q, want %q", in, got, want)
		}
	}
	long := ""
	for i := 0; i < 70; i++ {
		long += "x"
	}
	if got := Clip(long, 60); len([]rune(got)) != 59+1 || got[len(got)-3:] != "…" {
		t.Errorf("long: %q", got)
	}
}
