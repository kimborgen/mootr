package claude

import (
	"bytes"
	"container/list"
	"encoding/json"
	"io"
	"math"
	"os"
	"sync"
)

// The transcript usage reader (src/adapters/claude.ts sessionTokens and its kin): a Claude Code transcript (JSONL) is
// read in place, only the rows appended since the last read, and each assistant row's usage is folded into the
// session's token totals, its latest model turns (for the cold-turn measure, S-2236) and the cache window it shows.

// Totals is a session's token counts so far, the API-equivalent four: uncached input, output, cache reads and cache
// writes.
type Totals struct {
	Input, Output, CacheRead, CacheWrite float64
}

// Turn is one model turn's id, cache write and context size, all from one transcript row.
type Turn struct {
	ID                string
	CacheWrite, Total float64
}

const (
	recentTurns   = 64       // model turns kept per session for the cold-turn measure
	readChunk     = 1 << 20  // a transcript is parsed a megabyte at a time
	cacheBytesCap = 16 << 20 // the parsed state kept for sessions, least recently used evicted first
	rowBytes      = 160      // rough bytes one row's entry holds: an id string, a map slot and four numbers
)

// reportBudget is the most a status-line report reads (Tokens, TurnAfter): TS reads it all, but here the read is on
// the report's request, so a long unread transcript (the first report after a daemon start) is caught up over several
// reports instead of in one. A variable for the tests.
var reportBudget int64 = 8 << 20

type transcriptState struct {
	// mu guards the fields below; it is held while the file is read, so two reports on one session don't read it
	// twice, and reports on other sessions don't wait.
	mu     sync.Mutex
	pos    int64
	carry  []byte
	rows   map[string]Totals
	totals Totals
	recent []Turn
	ttl    string // the cache window of the latest row that wrote to the cache
	// caught is whether the last read reached the end of the file: while a budget leaves part of it unread, the latest
	// turn and window aren't known yet.
	caught bool

	// bytes and elem belong to Transcripts and are guarded by its mu.
	bytes int
	elem  *list.Element
}

// Transcripts is the reader's parsed state per transcript file. The zero value is ready to use. Its lock guards only
// the index and the size accounting; each session's read holds that session's own lock.
type Transcripts struct {
	mu     sync.Mutex
	states map[string]*transcriptState
	order  *list.List // files, least recently used first
	bytes  int
}

// Tokens is sessionTokens: the session's totals, read up to date (at most reportBudget further). false when file is ""
// or can't be read.
func (t *Transcripts) Tokens(file string) (out Totals, ok bool) {
	t.read(file, reportBudget, func(s *transcriptState) { out, ok = s.totals, true })
	return out, ok
}

// TTL is sessionTtl: the cache window ("1h" or "5m") the transcript shows so far, "" when none; read after Tokens. ""
// too while a budget leaves part of the file unread, since the latest window isn't known yet.
func (t *Transcripts) TTL(file string) string {
	t.mu.Lock()
	s := t.states[file]
	t.mu.Unlock()
	if s == nil || file == "" {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.caught {
		return ""
	}
	return s.ttl
}

// LastID is sessionLastId: the id of the session's latest model turn, read up to date; "" for none.
func (t *Transcripts) LastID(file string) (id string) {
	t.read(file, math.MaxInt64, func(s *transcriptState) {
		if len(s.recent) > 0 {
			id = s.recent[len(s.recent)-1].ID
		}
	})
	return id
}

// TurnAfter is sessionTurnAfter: the first model turn after seen (a turn id) in the session. With no seen, or one the
// kept turns don't hold (a new session after a compaction), the oldest turn kept; only the latest 64 are kept, so a
// longer gap measures a later turn than the first. It reads at most reportBudget further, as Tokens does, and finds
// nothing until the reads reach the end of the file: the turns read so far may all come before the one wanted.
func (t *Transcripts) TurnAfter(file, seen string) (turn Turn, ok bool) {
	t.read(file, reportBudget, func(s *transcriptState) {
		if !s.caught {
			return
		}
		at := -1
		if seen != "" {
			for i, r := range s.recent {
				if r.ID == seen {
					at = i
					break
				}
			}
		}
		if at+1 < len(s.recent) {
			turn, ok = s.recent[at+1], true
		}
	})
	return turn, ok
}

// read brings the file's state up to date, reading at most maxBytes, marks it most recently used, and runs fn on it
// under its lock. As in TS, a file that can't be stat'ed still gets an entry, and reads as nothing (fn doesn't run).
func (t *Transcripts) read(file string, maxBytes int64, fn func(s *transcriptState)) {
	if file == "" {
		return
	}
	t.mu.Lock()
	if t.states == nil {
		t.states = map[string]*transcriptState{}
		t.order = list.New()
	}
	s := t.states[file]
	if s != nil {
		t.order.MoveToBack(s.elem)
	} else {
		s = &transcriptState{rows: map[string]Totals{}}
		s.elem = t.order.PushBack(file)
		t.states[file] = s
	}
	t.mu.Unlock()

	s.mu.Lock()
	info, err := os.Stat(file)
	if err != nil {
		s.mu.Unlock()
		return
	}
	if info.Size() < s.pos {
		s.reset()
	}
	s.advance(file, info.Size(), maxBytes)
	s.caught = s.pos >= info.Size()
	size := len(s.carry) + len(s.rows)*rowBytes
	fn(s)
	s.mu.Unlock()

	t.mu.Lock()
	t.note(file, s, size)
	t.mu.Unlock()
}

// note accounts the state's cached size and evicts the least recently used other sessions past the cap. A state
// evicted while it was read isn't accounted again. The caller holds t.mu.
func (t *Transcripts) note(file string, s *transcriptState, size int) {
	if t.states[file] != s {
		return
	}
	t.bytes += size - s.bytes
	s.bytes = size
	for e := t.order.Front(); e != nil && t.bytes > cacheBytesCap; {
		next := e.Next()
		f := e.Value.(string)
		if other := t.states[f]; other != s {
			t.bytes -= other.bytes
			t.order.Remove(e)
			delete(t.states, f)
		}
		e = next
	}
}

func (s *transcriptState) reset() {
	s.pos = 0
	s.carry = nil
	s.rows = map[string]Totals{}
	s.totals = Totals{}
	s.ttl = ""
	s.recent = nil
}

var usageKey = []byte(`"usage"`)

// advance reads the unread part of the file up to size, at most maxBytes of it, a chunk at a time; a partial last line
// waits for its newline.
func (s *transcriptState) advance(file string, size, maxBytes int64) {
	if maxBytes < size-s.pos {
		size = s.pos + maxBytes
	}
	if size <= s.pos {
		return
	}
	f, err := os.Open(file)
	if err != nil {
		return
	}
	defer f.Close()
	pos := s.pos
	for pos < size {
		buf := make([]byte, min(readChunk, size-pos))
		n, err := f.ReadAt(buf, pos)
		if n <= 0 {
			break
		}
		pos += int64(n)
		data := buf[:n]
		if len(s.carry) > 0 {
			data = append(s.carry, data...)
		}
		start := 0
		for {
			nl := bytes.IndexByte(data[start:], '\n')
			if nl < 0 {
				break
			}
			line := data[start : start+nl]
			if bytes.Contains(line, usageKey) {
				s.usageLine(line)
			}
			start += nl + 1
		}
		s.carry = append([]byte(nil), data[start:]...) // a copy, so the chunk is freed
		if err != nil && err != io.EOF {
			break
		}
	}
	s.pos = pos
}

// usageLine folds one assistant row's usage in. A streamed message writes several rows with one message id: the latest
// replaces the earlier ones, in the totals and in the recent turns.
func (s *transcriptState) usageLine(line []byte) {
	var e map[string]any
	if json.Unmarshal(line, &e) != nil || e["type"] != "assistant" {
		return
	}
	msg, _ := e["message"].(map[string]any)
	id, _ := msg["id"].(string)
	if v, ok := msg["id"]; !ok || v == nil {
		id, _ = e["uuid"].(string) // `message.id ?? uuid`
	}
	u := msg["usage"]
	if id == "" || !truthy(u) {
		return
	}
	uo, _ := u.(map[string]any)
	cc, _ := uo["cache_creation"].(map[string]any)
	if ttl := TTLOf(cc); ttl != "" {
		s.ttl = ttl
	}
	t := Totals{Input: num(uo, "input_tokens"), Output: num(uo, "output_tokens"), CacheRead: num(uo, "cache_read_input_tokens"),
		CacheWrite: num(uo, "cache_creation_input_tokens")}
	turn := Turn{ID: id, CacheWrite: t.CacheWrite, Total: t.Input + t.CacheRead + t.CacheWrite}
	replaced := false
	for i := range s.recent {
		if s.recent[i].ID == id {
			s.recent[i] = turn
			replaced = true
			break
		}
	}
	if !replaced {
		if s.recent = append(s.recent, turn); len(s.recent) > recentTurns {
			s.recent = s.recent[1:]
		}
	}
	if old, ok := s.rows[id]; ok {
		s.totals.Input -= old.Input
		s.totals.Output -= old.Output
		s.totals.CacheRead -= old.CacheRead
		s.totals.CacheWrite -= old.CacheWrite
	}
	s.rows[id] = t
	s.totals.Input += t.Input
	s.totals.Output += t.Output
	s.totals.CacheRead += t.CacheRead
	s.totals.CacheWrite += t.CacheWrite
}

// TTLOf is src/cache-cold.ts ttlOf: 1 h cache writes mean the 1 h window, 5 min writes alone mean 5 min; "" for neither.
func TTLOf(cc map[string]any) string {
	if num(cc, "ephemeral_1h_input_tokens") > 0 {
		return "1h"
	}
	if num(cc, "ephemeral_5m_input_tokens") > 0 {
		return "5m"
	}
	return ""
}

// num is `o.key ?? 0` for a number; anything else counts as 0.
func num(o map[string]any, key string) float64 {
	n, _ := o[key].(float64)
	return n
}

// truthy is JavaScript truthiness of a decoded JSON value.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	}
	return true
}
