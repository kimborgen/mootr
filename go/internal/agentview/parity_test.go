package agentview

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// The parity of the view's pure parts with src/adapters/claude-transcript.ts and src/agent-view.ts:
// testdata/viewref.mjs runs TS's over the same cases, and each answer is compared as JSON (key order and values; how a
// string is escaped is the encoder's).

// canon is a JSON text as JSON.stringify would write its parse.
func canon(t *testing.T, b []byte) string {
	t.Helper()
	v, err := jsjson.Parse(b)
	if err != nil {
		t.Fatalf("not JSON: %v\n%.300s", err, b)
	}
	return jsjson.Stringify(v, "")
}

func runRef(t *testing.T, cases []map[string]any) []string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node")
	}
	in, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	cmd := exec.Command("node", "--no-warnings", "testdata/viewref.mjs")
	cmd.Env = append(os.Environ(), "HOME="+home, "STAM_HOME="+filepath.Join(home, "stam"))
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("viewref.mjs: %v\n%s", err, stderr.String())
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) != len(cases) {
		t.Fatalf("viewref.mjs gave %d lines for %d cases", len(lines), len(cases))
	}
	return lines
}

// firstDiff is where two texts part, with some context, for a readable failure.
func firstDiff(a, b string) string {
	i := 0
	for i < len(a) && i < len(b) && a[i] == b[i] {
		i++
	}
	lo := max(0, i-120)
	return fmt.Sprintf("at byte %d:\n go %q\n ts %q", i, a[lo:min(len(a), i+120)], b[lo:min(len(b), i+120)])
}

// jsonl is one transcript row as Claude Code writes it.
func jsonl(v map[string]any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b) + "\n"
}

// transcriptFixture is a long, realistic transcript: many turns of prompts, thinking, text and tool calls with their
// results (strings, block lists, errors), stam notices, hook context, a subagent's rows, turn durations, and the odd
// rows a reader must survive.
func transcriptFixture(seed int64, turns int) string {
	r := rand.New(rand.NewSource(seed))
	var b strings.Builder
	ms := int64(1_760_000_000_000)
	n := 0
	ts := func() string {
		ms += int64(r.Intn(5000) + 1)
		return jsTime(ms)
	}
	uuid := func() string { n++; return fmt.Sprintf("u-%05d", n) }
	texts := []string{"Done.", "Let me look at `src/agent-view.ts` first.", "a <b> & c", "emoji 😀 and \u2028 line sep", "multi\nline\ntext", "ünïcödé"}
	for turn := 0; turn < turns; turn++ {
		switch r.Intn(6) {
		case 0:
			b.WriteString(jsonl(map[string]any{"type": "user", "isMeta": true, "origin": map[string]any{"kind": "channel"}, "uuid": uuid(), "timestamp": ts(),
				"message": map[string]any{"role": "user", "content": fmt.Sprintf("<channel source=\"stam\" kind=\"mail\">New mail %d</channel>", turn)}}))
		case 1:
			b.WriteString(jsonl(map[string]any{"type": "user", "uuid": uuid(), "timestamp": ts(),
				"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("prompt %d", turn)}, map[string]any{"type": "text", "text": "second block"}}}}))
		default:
			b.WriteString(jsonl(map[string]any{"type": "user", "uuid": uuid(), "timestamp": ts(), "message": map[string]any{"role": "user", "content": fmt.Sprintf("Run step %d of the plan.", turn)}}))
		}
		if r.Intn(4) == 0 {
			b.WriteString(jsonl(map[string]any{"type": "user", "isMeta": true, "uuid": uuid(), "timestamp": ts(), "message": map[string]any{"role": "user", "content": "hook context"}}))
		}
		steps := r.Intn(6) + 1
		msgID := fmt.Sprintf("msg_%d", turn)
		for s := 0; s < steps; s++ {
			var content []any
			if r.Intn(3) == 0 {
				thinking := ""
				if r.Intn(2) == 0 {
					thinking = "thinking about it"
				}
				content = append(content, map[string]any{"type": "thinking", "thinking": thinking, "signature": "sig"})
			}
			if r.Intn(2) == 0 {
				content = append(content, map[string]any{"type": "text", "text": texts[r.Intn(len(texts))]})
			}
			tool := ""
			if s < steps-1 || r.Intn(3) == 0 {
				tool = fmt.Sprintf("toolu_%d_%d", turn, s)
				input := map[string]any{"command": fmt.Sprintf("echo %d", s), "description": "a step", "timeout": 120000, "nested": map[string]any{"z": 1, "a": []any{1, "two", nil, true}}}
				content = append(content, map[string]any{"type": "tool_use", "id": tool, "name": []string{"Bash", "Read", "Edit", "mcp__stam__send_mail"}[r.Intn(4)], "input": input})
			}
			if len(content) == 0 {
				content = append(content, map[string]any{"type": "text", "text": "ok"})
			}
			id := uuid()
			if r.Intn(10) == 0 {
				b.WriteString(jsonl(map[string]any{"type": "assistant", "isSidechain": true, "uuid": id + "-side", "timestamp": ts(), "message": map[string]any{"id": "side", "content": content}}))
			}
			b.WriteString(jsonl(map[string]any{"type": "assistant", "uuid": id, "timestamp": ts(), "message": map[string]any{"id": msgID, "role": "assistant", "content": content}}))
			if tool != "" {
				var out any = fmt.Sprintf("output of %s\nline 2", tool)
				switch r.Intn(4) {
				case 0:
					out = []any{map[string]any{"type": "text", "text": "block one"}, map[string]any{"type": "image", "source": map[string]any{"data": "AAAA"}}, map[string]any{"type": "text", "text": "block two"}}
				case 1:
					out = strings.Repeat("x", r.Intn(3000))
				}
				b.WriteString(jsonl(map[string]any{"type": "user", "uuid": uuid(), "timestamp": ts(), "message": map[string]any{"role": "user",
					"content": []any{map[string]any{"type": "tool_result", "tool_use_id": tool, "content": out, "is_error": r.Intn(5) == 0}}}}))
			}
		}
		if r.Intn(2) == 0 {
			b.WriteString(jsonl(map[string]any{"type": "system", "subtype": "turn_duration", "durationMs": 1234, "uuid": uuid(), "timestamp": ts()}))
		}
		if turn%40 == 7 {
			// The odd rows: a line never finished, no uuid (the message id stands in), a numeric uuid and timestamp, a
			// tool with no name and a numeric id, a text block that isn't a string, content that isn't a list, a result
			// for a tool never called, invalid UTF-8, and a blank line.
			b.WriteString(`{"type":"assistant","message":{"content":[{"type":"text","text":"cut` + "\n")
			b.WriteString(jsonl(map[string]any{"type": "assistant", "timestamp": ts(), "message": map[string]any{"id": "msg_no_uuid", "content": []any{map[string]any{"type": "text", "text": "no uuid"}}}}))
			b.WriteString(jsonl(map[string]any{"type": "user", "uuid": 42, "timestamp": 1760000000123, "message": map[string]any{"content": "numeric uuid"}}))
			b.WriteString(jsonl(map[string]any{"type": "assistant", "uuid": uuid(), "timestamp": "not a date", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": 7}, map[string]any{"type": "text", "text": 5}, nil, "str"}}}))
			b.WriteString(jsonl(map[string]any{"type": "assistant", "uuid": uuid(), "timestamp": ts(), "message": map[string]any{"content": "not a list"}}))
			b.WriteString(jsonl(map[string]any{"type": "user", "uuid": uuid(), "timestamp": ts(), "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "never", "content": "x"}}}}))
			b.WriteString(`{"type":"user","uuid":"bad-utf8","timestamp":"2025-10-09T08:00:00.000Z","message":{"content":"caf` + "\xe9\xff" + `"}}` + "\n")
			b.WriteString("   \n")
			b.WriteString(jsonl(map[string]any{"type": "user", "isMeta": true, "origin": map[string]any{"kind": "channel"}, "uuid": uuid(), "timestamp": ts(), "message": map[string]any{"content": "<channel></channel>"}}))
		}
	}
	return b.String()
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func unb64(t *testing.T, v any) []byte {
	b, err := base64.StdEncoding.DecodeString(v.(string))
	must(t, err)
	return b
}

func jsTime(ms int64) string {
	b, _ := json.Marshal(iso(float64(ms)))
	return strings.Trim(string(b), `"`)
}

// cuts splits s into steps at points that fall mid-row and mid-character as well as at row ends.
func cuts(s string, r *rand.Rand, n int) []string {
	var out []string
	for len(s) > 0 && len(out) < n-1 {
		k := min(len(s), r.Intn(len(s)/(n-len(out))*2+1)+1)
		out = append(out, s[:k])
		s = s[k:]
	}
	if s != "" {
		out = append(out, s)
	}
	return out
}

func TestTranscriptMatchesTS(t *testing.T) {
	dir := t.TempDir()
	big := transcriptFixture(1, 400)
	r := rand.New(rand.NewSource(2))
	var steps []any
	for _, c := range cuts(big, r, 60) {
		steps = append(steps, map[string]any{"append": b64(c)})
	}
	// Replaced by a shorter file: read again from its start.
	short := transcriptFixture(3, 5)
	steps = append(steps, map[string]any{"replace": b64(short)}, map[string]any{"append": b64(transcriptFixture(4, 3))})
	// A row over the 1 MiB read chunk.
	huge := jsonl(map[string]any{"type": "user", "uuid": "huge", "timestamp": "2026-01-01T00:00:00.000Z", "message": map[string]any{"content": strings.Repeat("é", 700_000)}})
	steps = append(steps, map[string]any{"append": b64(huge[:1001])}, map[string]any{"append": b64(huge[1001:])})
	cases := []map[string]any{
		{"kind": "transcript", "file": filepath.Join(dir, "ts.jsonl"), "steps": steps},
		{"kind": "transcript", "file": filepath.Join(dir, "ts2.jsonl"), "steps": []any{map[string]any{"append": b64(big)}}},
	}
	want := runRef(t, cases)
	// The fixture reaches what it means to: notices, reasoning, tools done and failed, block results, the numeric uuid,
	// the replacement character, and the row past a read chunk.
	for _, s := range []string{`"kind":"notice"`, `"type":"reasoning"`, `"status":"error"`, `"status":"done"`, `"status":"pending"`, "block one\\nblock two",
		`"id":"42"`, "caf\ufffd", `"id":"huge"`, `"resets":1`} {
		if !strings.Contains(want[0]+want[1], s) {
			t.Errorf("the fixture never gives %s", s)
		}
	}
	for i, c := range cases {
		file := filepath.Join(dir, fmt.Sprintf("go%d.jsonl", i))
		must(t, os.WriteFile(file, nil, 0o644))
		tr := NewTranscript(file)
		tr.Watchers = 1
		wantSteps, err := jsjson.Parse([]byte(want[i]))
		must(t, err)
		for k, s := range c["steps"].([]any) {
			m := s.(map[string]any)
			if v, ok := m["replace"]; ok {
				must(t, os.WriteFile(file, unb64(t, v), 0o644))
			} else {
				f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0)
				must(t, err)
				_, err = f.Write(unb64(t, m["append"]))
				must(t, err)
				must(t, f.Close())
			}
			tr.Read()
			msgs := tr.Messages
			if msgs == nil {
				msgs = []*Message{}
			}
			take := tr.Take()
			if take == nil {
				take = []string{}
			}
			raw, err := json.Marshal(struct {
				Messages []*Message `json:"messages"`
				Take     []string   `json:"take"`
				Resets   int        `json:"resets"`
				Position int64      `json:"position"`
			}{msgs, take, tr.Resets, tr.Position()})
			must(t, err)
			ws := wantSteps.([]jsjson.Value)[k]
			if g, w := canon(t, raw), jsjson.Stringify(ws, ""); g != w {
				t.Fatalf("case %d step %d: %s", i, k, firstDiff(g, w))
			}
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// fixtureMessages is the messages of a parsed fixture transcript with mail cards among them: received mail read and
// unread, and mail the agent sent, some at the same time as a harness message.
func fixtureMessages(t *testing.T, seed int64, turns int) []*Message {
	t.Helper()
	file := filepath.Join(t.TempDir(), "t.jsonl")
	must(t, os.WriteFile(file, []byte(transcriptFixture(seed, turns)), 0o644))
	tr := NewTranscript(file)
	tr.Read()
	r := rand.New(rand.NewSource(seed))
	msgs := append([]*Message{}, tr.Messages...)
	n := len(tr.Messages)
	for i := 0; i < n/3; i++ {
		h := tr.Messages[r.Intn(n)]
		at := h.At + float64(r.Intn(3)-1)*float64(r.Intn(4000))
		read := int64(at) + int64(r.Intn(9000))
		mp := &MailPart{FromID: "a1", From: "go-mgr", Subject: fmt.Sprintf("mail %d", i), Body: "body <b> & co", Thread: fmt.Sprintf("m%d", i)}
		switch r.Intn(3) {
		case 0:
			mp.ReadAt = &read
		case 1:
			to := []Recip{{ID: "human", Name: "human", ReadAt: &read}, {ID: "a2", Name: "dev"}}
			mp.To = &to
		}
		msgs = append(msgs, &Message{ID: fmt.Sprintf("mail:m%d", i), Role: "user", Kind: "mail", At: at, Parts: []Part{{Type: "mail", ID: fmt.Sprintf("m%d", i), Mail: mp}}})
	}
	// Mail comes in at the end in no order of its own, as two queries' rows do.
	r.Shuffle(len(msgs)-n, func(i, j int) { msgs[n+i], msgs[n+j] = msgs[n+j], msgs[n+i] })
	return msgs
}

func clones(ms []*Message) []*Message {
	out := make([]*Message, len(ms))
	for i, m := range ms {
		out[i] = m.clone()
	}
	return out
}

func asJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	must(t, err)
	return canon(t, b)
}

// TS's input is Go's messages as JSON, keys in their order, so both sides start from the same values.
func jsonValue(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	must(t, err)
	return b
}

func TestInterleaveAndTurnToolsMatchTS(t *testing.T) {
	msgs := fixtureMessages(t, 5, 120)
	var cases []map[string]any
	type check struct {
		name string
		got  func() string
	}
	var checks []check
	cases = append(cases, map[string]any{"kind": "interleave", "messages": jsonValue(t, msgs)})
	checks = append(checks, check{"interleave", func() string { return asJSON(t, Interleave(clones(msgs))) }})
	// turnTools sees what interleave gives, at times at, before and after each sent mail, and past the end.
	ordered := Interleave(clones(msgs))
	var his []float64
	for _, m := range ordered {
		if m.Kind == "mail" && m.Parts[0].Mail.To != nil {
			his = append(his, m.At, m.At-1, m.At+1)
		}
	}
	his = append(his, 0, ordered[len(ordered)-1].At+1e9)
	for _, hi := range his {
		cases = append(cases, map[string]any{"kind": "turnTools", "messages": jsonValue(t, ordered), "hi": hi})
		checks = append(checks, check{fmt.Sprintf("turnTools %.0f", hi), func() string {
			tools, done := TurnTools(clones(ordered), hi)
			if tools == nil {
				tools = []Part{}
			}
			return asJSON(t, struct {
				Tools []Part `json:"tools"`
				Done  bool   `json:"done"`
			}{tools, done})
		}})
	}
	want := runRef(t, cases)
	toolsSeen := false
	for i, c := range checks {
		w := canon(t, []byte(want[i]))
		toolsSeen = toolsSeen || strings.Contains(w, `"type":"tool"`) && strings.Contains(w, `"done":true`)
		if g := c.got(); g != w {
			t.Errorf("%s: %s", c.name, firstDiff(g, w))
		}
	}
	if !toolsSeen {
		t.Error("no turnTools case found a turn's tools")
	}
}

func TestStoreMergeMatchesTS(t *testing.T) {
	all := Interleave(fixtureMessages(t, 7, 300))
	harness := 0
	for _, m := range all {
		if m.Kind != "mail" {
			harness++
		}
	}
	if harness <= maxWindow {
		t.Fatalf("the fixture has %d harness messages, not past the %d window", harness, maxWindow)
	}
	page := func(from, to int) []*Message { return clones(all[from:min(to, len(all))]) }
	// A newer read: the last message grew, one went, a new one came.
	grown := page(len(all)-60, len(all))
	for _, m := range grown {
		if m.Kind != "mail" && m.Role == "assistant" {
			m.Parts = append(m.Parts, Part{Type: "text", Text: "more"})
			break
		}
	}
	grown = append(grown[:5], grown[6:]...)
	grown = append(grown, &Message{ID: "new", Role: "assistant", At: all[len(all)-1].At + 10, Parts: []Part{{Type: "text", Text: "new"}}})
	tool := "Bash"
	perm := &Permission{ID: "p1", Action: "Bash", Resources: []string{"echo hi"}, Message: grown[len(grown)-1].ID, Tool: &tool}
	running := true
	streaming := &Message{ID: "streaming", Role: "assistant", At: all[0].At - 5, Parts: []Part{{Type: "text", Text: "…"}}, Running: &running}
	type step map[string]any
	steps := []step{
		{"merge": page(len(all)-50, len(all))},
		{"running": true},
		{"merge": append(page(len(all)-120, len(all)-40), streaming)},
		{"merge": grown},
		{"ask": perm},
		// A read that doesn't store the permission keeps its part.
		{"merge": clones(grown)},
		{"merge": page(0, len(all))},
		{"hasOlder": true},
		{"merge": []*Message{}},
		{"running": false},
	}
	var tsSteps []any
	for _, s := range steps {
		tsSteps = append(tsSteps, jsonValue(t, s))
	}
	want := runRef(t, []map[string]any{{"kind": "store", "steps": tsSteps}})
	ws, err := jsjson.Parse([]byte(want[0]))
	must(t, err)
	// The steps reach what they mean to: the permission part kept through a read without it, the streaming message
	// kept, and the window cut with an older page to ask for.
	for i, sub := range map[int]string{5: `"id":"p1","action"`, 2: `"id":"streaming"`, 6: `"older":"u-`} {
		if w := jsjson.Stringify(ws.([]jsjson.Value)[i], ""); !strings.Contains(w, sub) {
			t.Errorf("step %d never gives %s", i, sub)
		}
	}
	var s Store
	for i, st := range steps {
		if v, ok := st["merge"]; ok {
			s.Merge(v.([]*Message))
		}
		if v, ok := st["running"]; ok {
			s.SetRunning(v.(bool))
		}
		if v, ok := st["ask"]; ok {
			s.Ask(v.(*Permission))
		}
		if v, ok := st["hasOlder"]; ok {
			s.HasOlder = v.(bool)
		}
		events := s.Flush()
		if events == nil {
			events = []Event{}
		}
		msgs := s.Messages
		if msgs == nil {
			msgs = []*Message{}
		}
		g := asJSON(t, struct {
			Events   []Event    `json:"events"`
			Messages []*Message `json:"messages"`
			Older    *string    `json:"older"`
		}{events, msgs, s.Older()})
		if w := jsjson.Stringify(ws.([]jsjson.Value)[i], ""); g != w {
			t.Fatalf("step %d: %s", i, firstDiff(g, w))
		}
	}
}
