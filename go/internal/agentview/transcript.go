package agentview

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"sync"

	"stam/internal/jsjson"
)

// The Claude Code transcript (JSONL) as view messages, read in place (src/adapters/claude-transcript.ts).

const transcriptChunk = 1 << 20

// maxRow is the longest row read: a longer one is skipped through its newline, so a row Claude Code never finishes
// can't hold memory without bound. Claude Code's rows run to a few MiB (a big tool result, an image); TS has no cap. A
// variable for the tests.
var maxRow = 64 << 20

// Transcript is one transcript file, read in place: rows appended since the last read are folded into the same
// messages. A turn is one message: consecutive assistant rows, across the tool results between them, until the next
// user prompt or the turn's recorded duration. A tool result fills the tool part it answers. Shared by Page and Follow:
// Watchers counts the followers, whose changed messages queue for them to Take, so a page's read doesn't hide a change
// from a follower. Its lock guards everything; hold it (Lock) around Read, Take and any use of Messages.
type Transcript struct {
	sync.Mutex
	File     string
	Messages []*Message
	ByID     map[string]*Message
	Watchers int
	// Resets counts the times the file was replaced by a shorter one, so a follower can notice.
	Resets int

	pos      int64
	carry    []byte
	skipping bool // a row over maxRow is being skipped through its newline
	tools    map[string]toolSlot
	group    *Message
	pending  []string
	isPend   map[string]bool
}

type toolSlot struct {
	owner *Message
	index int
}

// NewTranscript is the transcript of file, read from its start on the first Read.
func NewTranscript(file string) *Transcript {
	t := &Transcript{File: file}
	t.clear()
	return t
}

// Position is how far the file is read, in bytes.
func (t *Transcript) Position() int64 { return t.pos }

func (t *Transcript) clear() {
	t.pos = 0
	t.carry, t.skipping = nil, false
	t.Messages = nil
	t.ByID = map[string]*Message{}
	t.tools = map[string]toolSlot{}
	t.group = nil
	t.pending, t.isPend = nil, map[string]bool{}
}

// keep adds a partial row's bytes to the carry, which the caller has checked stays within maxRow; its buffer grows
// no further than maxRow either.
func (t *Transcript) keep(b []byte) {
	if need := len(t.carry) + len(b); need > cap(t.carry) {
		grown := make([]byte, len(t.carry), min(max(2*cap(t.carry), need), maxRow))
		copy(grown, t.carry)
		t.carry = grown
	}
	t.carry = append(t.carry, b...)
	if carryGrew != nil {
		carryGrew(cap(t.carry))
	}
}

// carryGrew is a test's seam: it sees the carry's capacity each time bytes are kept.
var carryGrew func(int)

// Read reads what was appended. A file replaced by a shorter one is rebuilt from its start, and Resets goes up.
func (t *Transcript) Read() {
	st, err := os.Stat(t.File)
	if err != nil {
		return
	}
	size := st.Size()
	if size < t.pos {
		t.clear()
		t.Resets++
	}
	if size == t.pos {
		return
	}
	f, err := os.Open(t.File)
	if err != nil {
		return
	}
	defer f.Close()
	touched := []string{}
	seen := map[string]bool{}
	touch := func(id string) {
		if !seen[id] {
			seen[id] = true
			touched = append(touched, id)
		}
	}
	pos := t.pos
	buf := make([]byte, transcriptChunk)
	for pos < size {
		n, _ := f.ReadAt(buf[:min(int64(len(buf)), size-pos)], pos)
		if n <= 0 {
			break
		}
		pos += int64(n)
		// Row by row, deciding before any byte is kept: a row over maxRow, finished or not, is skipped through its
		// newline in the chunk itself, so the carry never holds more than maxRow. Only the new bytes are scanned.
		for chunk := buf[:n]; len(chunk) > 0; {
			nl := bytes.IndexByte(chunk, '\n')
			if t.skipping {
				if nl < 0 {
					break
				}
				chunk, t.skipping = chunk[nl+1:], false
				continue
			}
			if nl < 0 {
				// A partial row waits for its newline.
				if len(t.carry)+len(chunk) > maxRow {
					t.carry, t.skipping = nil, true
					break
				}
				t.keep(chunk)
				break
			}
			if len(t.carry)+nl > maxRow {
				t.carry = nil
				chunk = chunk[nl+1:]
				continue
			}
			line := chunk[:nl]
			if len(t.carry) > 0 {
				t.keep(line)
				line = t.carry
			}
			if jsjson.Trim(string(line)) != "" {
				t.line(line, touch)
			}
			// A big row's buffer isn't kept once the row is done.
			if cap(t.carry) > transcriptChunk {
				t.carry = nil
			} else {
				t.carry = t.carry[:0]
			}
			chunk = chunk[nl+1:]
		}
	}
	t.pos = pos
	if t.Watchers > 0 {
		for _, id := range touched {
			if !t.isPend[id] {
				t.isPend[id] = true
				t.pending = append(t.pending, id)
			}
		}
	}
}

// Take is the ids of messages changed since the last take, for a follower; it forgets them.
func (t *Transcript) Take() []string {
	ids := t.pending
	t.pending, t.isPend = nil, map[string]bool{}
	return ids
}

// row is a transcript row's fields the view reads. Every field is loose, so a row of an unexpected shape is read as
// JSON.parse's object would be, a field at a time.
type row struct {
	Type        any             `json:"type"`
	Subtype     any             `json:"subtype"`
	IsSidechain any             `json:"isSidechain"`
	IsMeta      any             `json:"isMeta"`
	Timestamp   any             `json:"timestamp"`
	UUID        any             `json:"uuid"`
	Origin      json.RawMessage `json:"origin"`
	Message     json.RawMessage `json:"message"`
}

type rowMessage struct {
	ID      any             `json:"id"`
	Content json.RawMessage `json:"content"`
}

// block is a content block: text, thinking, tool_use or tool_result.
type block struct {
	Type      any             `json:"type"`
	Text      json.RawMessage `json:"text"`
	Thinking  json.RawMessage `json:"thinking"`
	ID        json.RawMessage `json:"id"`
	Name      json.RawMessage `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID json.RawMessage `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   any             `json:"is_error"`
}

// jsString is String(v) of a JSON value, "undefined" when there is none.
func jsString(raw json.RawMessage) string {
	if raw == nil {
		return "undefined"
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		return "undefined"
	}
	return jsjson.ToString(v)
}

// orEmpty is String(v ?? ”).
func orEmpty(raw json.RawMessage) string {
	if raw == nil || string(raw) == "null" {
		return ""
	}
	return jsString(raw)
}

// blocks is content as an array of blocks; ok false when it isn't an array. An element that isn't an object is a block
// with no type.
func blocks(content json.RawMessage) ([]block, bool) {
	var raw []json.RawMessage
	if json.Unmarshal(content, &raw) != nil || raw == nil {
		return nil, false
	}
	out := make([]block, len(raw))
	for i, r := range raw {
		_ = json.Unmarshal(r, &out[i])
	}
	return out, true
}

// textOf is the text of a content: a string as it is, an array's text blocks joined by newlines.
func textOf(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	bs, ok := blocks(content)
	if !ok {
		return ""
	}
	var parts []string
	for _, b := range bs {
		if b.Type == "text" {
			if t := orEmpty(b.Text); t != "" {
				parts = append(parts, t)
			}
		}
	}
	return strings.Join(parts, "\n")
}

var channelTag = regexp.MustCompile(`</?channel\b[^>]*>`)

func (t *Transcript) line(text []byte, touch func(string)) {
	var e row
	if json.Unmarshal(text, &e) != nil {
		return // a line Claude Code didn't finish writing, or one it never will
	}
	if jsjson.Truthy(e.IsSidechain) {
		return // a subagent's rows aren't the conversation
	}
	at := 0.0
	if ts, ok := e.Timestamp.(string); ok {
		if ms := dateParse(ts); ms == ms {
			at = ms
		}
	}
	var msg rowMessage
	hasMsg := e.Message != nil && json.Unmarshal(e.Message, &msg) == nil
	id := ""
	switch {
	case e.UUID != nil:
		id = jsjson.ToString(e.UUID)
	case hasMsg && msg.ID != nil:
		id = jsjson.ToString(msg.ID)
	}
	// A turn ends where Claude Code records its duration (S-278): the next rows are a new turn.
	if e.Type == "system" && e.Subtype == "turn_duration" {
		t.group = nil
		return
	}
	// A stam notice that woke the agent (a channel message) starts a new turn, shown as a notice row; other meta rows
	// (hook context) aren't the conversation.
	if e.Type == "user" && jsjson.Truthy(e.IsMeta) {
		var origin struct {
			Kind any `json:"kind"`
		}
		if e.Origin != nil && json.Unmarshal(e.Origin, &origin) == nil && origin.Kind == "channel" {
			t.notice(id, at, textOf(msg.Content), touch)
			return
		}
	}
	if jsjson.Truthy(e.IsMeta) {
		return
	}
	switch e.Type {
	case "user":
		var s string
		if json.Unmarshal(msg.Content, &s) == nil {
			t.prompt(id, at, s, touch)
			return
		}
		bs, ok := blocks(msg.Content)
		if !ok {
			return
		}
		for _, b := range bs {
			if b.Type == "tool_result" {
				t.result(b, touch)
			}
		}
		if text := textOf(msg.Content); text != "" {
			t.prompt(id, at, text, touch)
		}
	case "assistant":
		bs, ok := blocks(msg.Content)
		if !ok {
			return
		}
		for _, b := range bs {
			t.block(b, id, at, touch)
		}
	}
}

func (t *Transcript) add(m *Message, touch func(string)) {
	t.Messages = append(t.Messages, m)
	t.ByID[m.ID] = m
	touch(m.ID)
}

func (t *Transcript) prompt(id string, at float64, text string, touch func(string)) {
	t.group = nil
	if text != "" {
		t.add(&Message{ID: id, Role: "user", At: at, Parts: []Part{{Type: "text", Text: text}}}, touch)
	}
}

func (t *Transcript) notice(id string, at float64, text string, touch func(string)) {
	t.group = nil
	text = jsjson.Trim(channelTag.ReplaceAllString(text, ""))
	if text != "" {
		t.add(&Message{ID: id, Role: "system", Kind: "notice", At: at, Parts: []Part{{Type: "text", Text: text}}}, touch)
	}
}

func (t *Transcript) result(b block, touch func(string)) {
	slot, ok := t.tools[jsString(b.ToolUseID)]
	if !ok {
		return
	}
	p := &slot.owner.Parts[slot.index]
	out := textOf(b.Content)
	p.Output = &out
	p.Status = "done"
	if jsjson.Truthy(b.IsError) {
		p.Status = "error"
	}
	touch(slot.owner.ID)
}

func (t *Transcript) block(b block, id string, at float64, touch func(string)) {
	var part Part
	switch b.Type {
	case "text":
		text := orEmpty(b.Text)
		if text == "" {
			return
		}
		part = Part{Type: "text", Text: text}
	case "thinking":
		// Claude Code stores thinking empty; a reasoning part exists only when it has text.
		text := orEmpty(b.Thinking)
		if text == "" {
			return
		}
		part = Part{Type: "reasoning", Text: text}
	case "tool_use":
		part = Part{Type: "tool", ID: jsString(b.ID), Name: jsString(b.Name), Status: "pending"}
		if b.Input != nil {
			if v, err := jsjson.Parse(b.Input); err == nil {
				part.Input, part.HasInput = v, true
			}
		}
	default:
		return
	}
	if t.group == nil {
		t.group = &Message{ID: id, Role: "assistant", At: at, Parts: []Part{}, Marks: []int64{}}
		t.add(t.group, touch)
	}
	if part.Type == "tool" {
		t.tools[part.ID] = toolSlot{t.group, len(t.group.Parts)}
	}
	t.group.Parts = append(t.group.Parts, part)
	t.group.Marks = append(t.group.Marks, int64(at))
	touch(t.group.ID)
}
