package claude

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// usageRow is an assistant transcript row with usage, as Claude Code writes it.
func usageRow(id string, in, out, read, write float64, cc string) string {
	return fmt.Sprintf(`{"type":"assistant","uuid":"u-%s","message":{"id":%q,"usage":{"input_tokens":%v,"output_tokens":%v,"cache_read_input_tokens":%v,"cache_creation_input_tokens":%v%s}}}`+"\n",
		id, id, in, out, read, write, cc)
}

func appendTo(t *testing.T, file, text string) {
	t.Helper()
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

// TestTranscripts: the reader folds usage rows in as they are appended (a streamed message's later row replacing its
// earlier one), waits for a partial line's newline, skips rows that aren't an assistant's usage, starts over on a
// shorter file, and reports the cache window and the turns after a seen one.
func TestTranscripts(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	var tr Transcripts
	if _, ok := tr.Tokens(file); ok {
		t.Error("a missing file read as a session")
	}
	if _, ok := tr.Tokens(""); ok || tr.LastID("") != "" || tr.TTL("") != "" {
		t.Error("no file read as a session")
	}
	appendTo(t, file, `{"type":"user","message":{"content":"hi"}}`+"\n"+
		usageRow("m1", 10, 5, 100, 1000, `,"cache_creation":{"ephemeral_5m_input_tokens":1000}`)+
		`{"type":"assistant","message":{"id":"m0"}}`+"\n"+ // no usage
		`{"type":"assistant","message":{"usage":{"input_tokens":7}},"uuid":"u-x"}`+"\n"+ // no message id: the uuid
		`not json "usage"`+"\n")
	got, ok := tr.Tokens(file)
	if want := (Totals{Input: 17, Output: 5, CacheRead: 100, CacheWrite: 1000}); !ok || got != want {
		t.Fatalf("totals: %+v %v, want %+v", got, ok, want)
	}
	if tr.TTL(file) != "5m" || tr.LastID(file) != "u-x" {
		t.Errorf("ttl %q, last %q", tr.TTL(file), tr.LastID(file))
	}
	// A streamed message: its later row replaces the earlier one. A partial row waits for its newline.
	row := usageRow("m1", 10, 50, 100, 1000, "")
	appendTo(t, file, row[:30])
	if got, _ := tr.Tokens(file); got.Output != 5 {
		t.Errorf("a partial row was read: %+v", got)
	}
	appendTo(t, file, row[30:]+usageRow("m2", 1, 2, 3000, 40, `,"cache_creation":{"ephemeral_1h_input_tokens":40}`))
	if got, _ := tr.Tokens(file); got != (Totals{Input: 18, Output: 52, CacheRead: 3100, CacheWrite: 1040}) {
		t.Errorf("after the stream: %+v", got)
	}
	if tr.TTL(file) != "1h" {
		t.Errorf("ttl after a 1 h write: %q", tr.TTL(file))
	}
	// m1's later row took its place in the recent turns: u-x, m1, m2 in order of first sight.
	for _, tc := range []struct {
		seen string
		want Turn
		ok   bool
	}{
		{"", Turn{ID: "m1", CacheWrite: 1000, Total: 1110}, true},
		{"m1", Turn{ID: "u-x", Total: 7}, true},
		{"u-x", Turn{ID: "m2", CacheWrite: 40, Total: 3041}, true},
		{"m2", Turn{}, false},
		{"gone", Turn{ID: "m1", CacheWrite: 1000, Total: 1110}, true},
	} {
		if got, ok := tr.TurnAfter(file, tc.seen); got != tc.want || ok != tc.ok {
			t.Errorf("after %q: %+v %v, want %+v %v", tc.seen, got, ok, tc.want, tc.ok)
		}
	}
	// A shorter file (a new session in its place) starts over.
	if err := os.WriteFile(file, []byte(usageRow("n1", 1, 1, 1, 1, "")), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := tr.Tokens(file); got != (Totals{1, 1, 1, 1}) || tr.TTL(file) != "" || tr.LastID(file) != "n1" {
		t.Errorf("after the reset: %+v ttl %q last %q", got, tr.TTL(file), tr.LastID(file))
	}
}

// TestTranscriptRecentCap: only the latest 64 turns are kept, so a seen turn older than them measures the oldest kept.
func TestTranscriptRecentCap(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	text := ""
	for i := 0; i < 70; i++ {
		text += usageRow(fmt.Sprint("m", i), 1, 0, 0, 0, "")
	}
	appendTo(t, file, text)
	var tr Transcripts
	if got, _ := tr.TurnAfter(file, "m0"); got.ID != "m6" {
		t.Errorf("after a dropped turn: %q", got.ID)
	}
	if got, _ := tr.TurnAfter(file, "m6"); got.ID != "m7" {
		t.Errorf("after the oldest kept: %q", got.ID)
	}
	if got, _ := tr.Tokens(file); got.Input != 70 {
		t.Errorf("totals count every row: %+v", got)
	}
}

// TestTranscriptEviction: past the cache cap the least recently used sessions go, never the one just read.
func TestTranscriptEviction(t *testing.T) {
	dir := t.TempDir()
	var tr Transcripts
	// One session's rows hold just over a third of cacheBytesCap: two fit, a third evicts the least recently used.
	rows := cacheBytesCap/rowBytes/3 + 1
	files := make([]string, 3)
	for i := range files {
		files[i] = filepath.Join(dir, fmt.Sprint(i, ".jsonl"))
		f, err := os.Create(files[i])
		if err != nil {
			t.Fatal(err)
		}
		for j := 0; j < rows; j++ {
			fmt.Fprintf(f, `{"type":"assistant","message":{"id":"m%d","usage":{"input_tokens":1}}}`+"\n", j)
		}
		f.Close()
	}
	tr.Tokens(files[0])
	tr.Tokens(files[1])
	tr.Tokens(files[0]) // files[1] is now the least recently used
	tr.Tokens(files[2])
	if _, ok := tr.states[files[1]]; ok || tr.states[files[0]] == nil || tr.states[files[2]] == nil {
		t.Errorf("kept: %v %v %v", tr.states[files[0]] != nil, tr.states[files[1]] != nil, tr.states[files[2]] != nil)
	}
	if want := tr.states[files[0]].bytes + tr.states[files[2]].bytes; tr.bytes != want {
		t.Errorf("accounted %d bytes, want %d", tr.bytes, want)
	}
	// A session over the cap alone evicts every other, never itself.
	big := filepath.Join(dir, "big.jsonl")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	for j := 0; j < cacheBytesCap/rowBytes+1; j++ {
		fmt.Fprintf(f, `{"type":"assistant","message":{"id":"m%d","usage":{"input_tokens":1}}}`+"\n", j)
	}
	f.Close()
	tr.Tokens(big)
	if len(tr.states) != 1 || tr.states[big] == nil || tr.order.Len() != 1 {
		t.Errorf("after a session over the cap: %d states, big kept %v", len(tr.states), tr.states[big] != nil)
	}
}

// TestTranscriptBudget: a report reads at most reportBudget of a long unread transcript, so the totals catch up over
// several reports, a row cut by the budget included; LastID reads it all.
func TestTranscriptBudget(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	rows := ""
	for i := range 10 {
		rows += usageRow(fmt.Sprintf("m%d", i), 1, 0, 0, 0, "")
	}
	appendTo(t, file, rows)
	old := reportBudget
	reportBudget = int64(len(rows))/4 + 7 // two and a half rows, so a row is cut
	defer func() { reportBudget = old }()

	var tr Transcripts
	var seen []float64
	for {
		got, _ := tr.Tokens(file)
		seen = append(seen, got.Input)
		if got.Input == 10 || len(seen) > 10 {
			break
		}
	}
	if fmt.Sprint(seen) != "[2 5 7 10]" {
		t.Errorf("totals over the reports: %v", seen)
	}
	var all Transcripts
	if id := all.LastID(file); id != "m9" {
		t.Errorf("LastID read up to %q", id)
	}
}

// TestTranscriptBudgetMark: a mark seen at m6 (after a restart, a new reader) measures nothing while the budget leaves
// part of the file unread, rather than the oldest turn read so far, and then the turn after it; the window waits too.
func TestTranscriptBudgetMark(t *testing.T) {
	file := filepath.Join(t.TempDir(), "s.jsonl")
	rows := ""
	for i := range 10 {
		rows += usageRow(fmt.Sprintf("m%d", i), 1, 0, 0, 5, `,"cache_creation":{"ephemeral_1h_input_tokens":5}`)
	}
	appendTo(t, file, rows)
	old := reportBudget
	reportBudget = int64(len(rows))/4 + 7
	defer func() { reportBudget = old }()

	var tr Transcripts
	var got []string
	for range 6 {
		turn, ok := tr.TurnAfter(file, "m6")
		got = append(got, fmt.Sprintf("%s:%v:%s", turn.ID, ok, tr.TTL(file)))
	}
	if want := "[:false: :false: :false: m7:true:1h m7:true:1h m7:true:1h]"; fmt.Sprint(got) != want {
		t.Errorf("turns after m6 over the reads: %v, want %s", got, want)
	}
}

// TestTranscriptsConcurrent: reports on one session and on others at once fold each row in once (run with -race).
func TestTranscriptsConcurrent(t *testing.T) {
	dir := t.TempDir()
	var tr Transcripts
	files := []string{filepath.Join(dir, "a.jsonl"), filepath.Join(dir, "b.jsonl")}
	for _, f := range files {
		appendTo(t, f, usageRow("m1", 1, 0, 0, 0, "")+usageRow("m2", 2, 0, 0, 0, ""))
	}
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f := files[i%2]
			tr.Tokens(f)
			tr.TurnAfter(f, "m1")
			tr.TTL(f)
		}()
	}
	wg.Wait()
	for _, f := range files {
		if got, _ := tr.Tokens(f); got.Input != 3 {
			t.Errorf("%s: %+v", f, got)
		}
	}
}
