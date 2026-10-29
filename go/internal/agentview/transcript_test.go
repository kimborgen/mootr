package agentview

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestOversizedRowSkipped: a row Claude Code never finishes holds no more than maxRow, whatever is appended to it; it
// is skipped through its newline, and the next row reads as usual.
func TestOversizedRowSkipped(t *testing.T) {
	defer func(old int) { maxRow = old }(maxRow)
	maxRow = 64 << 10
	peak := watchCarry(t)
	file := filepath.Join(t.TempDir(), "t.jsonl")
	must(t, os.WriteFile(file, []byte(jsonl(map[string]any{"type": "user", "uuid": "u1", "timestamp": "2026-10-01T00:00:00.000Z", "message": map[string]any{"content": "before"}})), 0o644))
	tr := NewTranscript(file)
	tr.Read()
	add := func(s string) {
		f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
		must(t, err)
		_, err = f.WriteString(s)
		must(t, err)
		must(t, f.Close())
		tr.Read()
	}
	add(`{"type":"user","uuid":"huge","message":{"content":"`)
	for i := 0; i < 10; i++ {
		add(strings.Repeat("x", 40<<10))
		if *peak > maxRow {
			t.Fatalf("after %d KiB the carry's buffer reached %d bytes", (i+1)*40, *peak)
		}
	}
	add(`"}}` + "\n" + jsonl(map[string]any{"type": "user", "uuid": "u2", "timestamp": "2026-10-01T00:00:01.000Z", "message": map[string]any{"content": "after"}}))
	var ids []string
	for _, m := range tr.Messages {
		ids = append(ids, m.ID)
	}
	if strings.Join(ids, " ") != "u1 u2" {
		t.Fatalf("messages %v", ids)
	}
	if tr.skipping || len(tr.carry) != 0 {
		t.Errorf("still skipping %v, carry %d", tr.skipping, len(tr.carry))
	}
}

// TestFinishedOversizedRowSkipped: a row over maxRow is skipped when its newline is in the same read, whether the whole
// row came in one chunk or its newline came in a later one, and the next row reads.
func TestFinishedOversizedRowSkipped(t *testing.T) {
	defer func(old int) { maxRow = old }(maxRow)
	maxRow = 64 << 10
	peak := watchCarry(t)
	row := func(id, text string) string {
		return jsonl(map[string]any{"type": "user", "uuid": id, "timestamp": "2026-10-01T00:00:00.000Z", "message": map[string]any{"content": text}})
	}
	huge := row("huge", strings.Repeat("x", 80<<10))
	for _, how := range []string{"one chunk", "newline later"} {
		t.Run(how, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "t.jsonl")
			tr := NewTranscript(file)
			if how == "one chunk" {
				must(t, os.WriteFile(file, []byte(row("u1", "before")+huge+row("u2", "after")), 0o644))
				tr.Read()
			} else {
				// Under the cap when the first read ends, so the row isn't yet being skipped.
				cut := len(huge) - 20<<10
				must(t, os.WriteFile(file, []byte(row("u1", "before")+huge[:cut]), 0o644))
				tr.Read()
				if tr.skipping {
					t.Fatal("skipping before the row passed the cap")
				}
				f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
				must(t, err)
				_, err = f.WriteString(huge[cut:] + row("u2", "after"))
				must(t, err)
				must(t, f.Close())
				tr.Read()
			}
			var ids []string
			for _, m := range tr.Messages {
				ids = append(ids, m.ID)
			}
			if strings.Join(ids, " ") != "u1 u2" {
				t.Fatalf("messages %v", ids)
			}
			if *peak > maxRow {
				t.Errorf("the carry's buffer reached %d bytes", *peak)
			}
		})
	}
}

// watchCarry records the largest the carry's buffer gets while the test reads.
func watchCarry(t *testing.T) *int {
	peak := 0
	carryGrew = func(c int) { peak = max(peak, c) }
	t.Cleanup(func() { carryGrew = nil })
	return &peak
}
