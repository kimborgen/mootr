package claude

import (
	"encoding/json"
	"os/exec"
	"reflect"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// TestInputParity: the input box's text, inputShows, the menu, the screen around the box, sameAround, inputProblem,
// displayWidth and bashInputRecorded answer as src/adapters/claude-input.ts does.
func TestInputParity(t *testing.T) {
	type tc struct {
		Lines    []string        `json:"lines"`
		Before   []string        `json:"before,omitempty"`
		Width    int             `json:"width"`
		Text     string          `json:"text"`
		Input    json.RawMessage `json:"input,omitempty"`
		Appended string          `json:"appended"`
	}
	rule := "────────────────────"
	screen := func(box ...string) []string {
		return append(append([]string{"some output", "", rule}, box...), rule, "  ? for shortcuts", "", "")
	}
	cases := []tc{
		{Lines: screen("❯ "), Text: "x"},
		{Lines: screen("❯ hello"), Text: "hello"},
		{Lines: screen("❯ hello"), Text: "hell"},
		{Lines: screen("❯ hi there"), Text: "hi there"},
		{Lines: screen("! ls -la"), Text: "!ls -la"},
		{Lines: screen("! ls -la"), Text: "ls -la"},
		{Lines: screen("❯ ls -la"), Text: "!ls -la"},
		// The terminal's autowrap: the first row fills the width.
		{Lines: screen("❯ abcdefghijklmnopqr", "stuvw"), Width: 20, Text: "abcdefghijklmnopqrstuvw"},
		{Lines: screen("❯ abcdefghijklmnopqr", "stuvw"), Width: 0, Text: "abcdefghijklmnopqrstuvw"},
		// Claude Code's word wrap drops the space when the next word wouldn't fit.
		{Lines: screen("❯ hello world foo", "  barbazqux"), Width: 20, Text: "hello world foo barbazqux"},
		{Lines: screen("❯ hello world", "  ba"), Width: 20, Text: "hello world ba"},
		{Lines: screen("❯ hello world", "  ba"), Width: 20, Text: "hello worldba"},
		// A word too long for a row breaks inside it once the row is full.
		{Lines: screen("❯ /a/very/long/path", "  /more"), Width: 20, Text: "/a/very/long/path/more"},
		{Lines: screen("❯ /a/very/long", "  /more"), Width: 20, Text: "/a/very/long/more"},
		{Lines: screen("❯ hello", "   indented"), Width: 20, Text: "hello indented"},
		// An emoji in a wrapped box makes it unreadable.
		{Lines: screen("❯ hi 😀 there friend", "  more"), Width: 20, Text: "hi 😀 there friend more"},
		{Lines: screen("❯ hi 😀"), Width: 20, Text: "hi 😀"},
		{Lines: screen("❯ 日本語のテキスト"), Width: 40, Text: "日本語のテキスト"},
		// A completion menu under the box, and a notice over its top rule.
		{Lines: append(screen("❯ /he"), "  ❯ /help", "    /hooks"), Text: "/he"},
		{Lines: []string{"out", "                         ◐ medium · /effort", rule, "❯ hi", rule, "  -- INSERT --", "", "tail"}, Text: "hi"},
		{Lines: []string{"out", "", rule, "❯ hi", rule, "  -- INSERT --"}, Before: []string{"other", "", rule, "❯ ", rule, "  -- INSERT --"}, Text: "hi"},
		{Lines: []string{"out", "", rule, "❯ hi", rule, "status"}, Before: []string{"older", "out", "", rule, "❯ ", "  hi", rule, "x"}, Text: "hi"},
		{Lines: []string{"just output", "no box here"}, Text: "x"},
		{Lines: []string{"❯ last mark", "next line"}, Text: "last marknext line"},
		// inputProblem's cases.
		{Input: json.RawMessage(`5`)},
		{Input: json.RawMessage(`""`)},
		{Input: json.RawMessage(`"   "`)},
		{Input: json.RawMessage(`"` + strings.Repeat("é", 2001) + `"`)},
		{Input: json.RawMessage(`"` + strings.Repeat("é", 2000) + `"`)},
		{Input: json.RawMessage(`"a\tb"`)},
		{Input: json.RawMessage(`"a b"`)},
		{Input: json.RawMessage(`"a\u0085b"`)},
		{Input: json.RawMessage(`"trail "`)},
		{Input: json.RawMessage(`"trail "`)},
		{Input: json.RawMessage(`"!git status"`)},
		{Input: json.RawMessage(`null`)},
		// bashInputRecorded's cases.
		{Text: "!ls", Appended: `{"type":"user","message":{"content":"<bash-input>ls</bash-input>"}}`},
		{Text: "!ls", Appended: "not json\n" + `{"type":"assistant","message":{"content":"<bash-input>ls</bash-input>"}}` + "\n" + `{"type":"user","message":{"content":[{"type":"text","text":"<bash-input>pwd</bash-input>"}]}}`},
		{Text: "!ls", Appended: `{"type":"user","message":{"content":[5,{"text":"hi"},{"text":"<bash-input>ls</bash-input>"}]}}`},
		{Text: "!ls", Appended: `{"type":"user","message":{"content":"plain"}}` + "\n" + `null` + "\n" + `[1]`},
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "testdata/ts-input.mjs")
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-input.mjs: %v\n%s", err, stderr.String())
	}
	var want []struct {
		Box *struct {
			Mark string  `json:"mark"`
			Text *string `json:"text"`
		} `json:"box"`
		Shows   bool `json:"shows"`
		Menu    bool `json:"menu"`
		Around  struct{ Above, Below, Footer []string }
		Same    bool    `json:"same"`
		Problem *string `json:"problem"`
		Cols    int     `json:"cols"`
		Bash    string  `json:"bash"`
	}
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	orEmpty := func(l []string) []string {
		if l == nil {
			return []string{}
		}
		return l
	}
	// The cases reach both answers: a box that shows its text and one that doesn't, each bash outcome, a problem and none.
	var shown, problems strings.Builder
	bash := map[string]bool{}
	for _, w := range want {
		if w.Shows {
			shown.WriteString("1")
		} else {
			shown.WriteString("0")
		}
		if w.Problem == nil {
			problems.WriteString("-")
		} else {
			problems.WriteString("p")
		}
		bash[w.Bash] = true
	}
	if !strings.Contains(shown.String(), "1") || !strings.Contains(problems.String(), "-") || len(bash) != 3 {
		t.Errorf("the cases miss an outcome: shows %s, problems %s, bash %v", shown.String(), problems.String(), bash)
	}
	for i, c := range cases {
		w := want[i]
		box, ok := InputBox(c.Lines, c.Width)
		if ok != (w.Box != nil) || ok && (box.Mark != w.Box.Mark || box.HasText != (w.Box.Text != nil) || box.HasText && box.Text != *w.Box.Text) {
			t.Errorf("case %d: box %v %+v, TS %+v", i, ok, box, w.Box)
		}
		if got := InputShows(c.Lines, c.Text, c.Width); got != w.Shows {
			t.Errorf("case %d: shows %v, TS %v", i, got, w.Shows)
		}
		if got := MenuUnderBox(c.Lines); got != w.Menu {
			t.Errorf("case %d: menu %v, TS %v", i, got, w.Menu)
		}
		a := AroundBox(c.Lines)
		if !reflect.DeepEqual(orEmpty(a.Above), orEmpty(w.Around.Above)) || !reflect.DeepEqual(orEmpty(a.Below), orEmpty(w.Around.Below)) || !reflect.DeepEqual(orEmpty(a.Footer), orEmpty(w.Around.Footer)) {
			t.Errorf("case %d: around %q, TS %q", i, a, w.Around)
		}
		before := c.Before
		if before == nil {
			before = c.Lines
		}
		if got := SameAround(AroundBox(before), a); got != w.Same {
			t.Errorf("case %d: same %v, TS %v", i, got, w.Same)
		}
		var input jsjson.Value
		if len(c.Input) > 0 {
			if input, err = jsjson.Parse(c.Input); err != nil {
				t.Fatal(err)
			}
		}
		wantProblem := ""
		if w.Problem != nil {
			wantProblem = *w.Problem
		}
		if got := InputProblem(input); got != wantProblem {
			t.Errorf("case %d: problem %q, TS %q", i, got, wantProblem)
		}
		if got := DisplayWidth(c.Text); got != w.Cols {
			t.Errorf("case %d: cols %d, TS %d", i, got, w.Cols)
		}
		if got := BashInputRecorded(c.Appended, c.Text); got != w.Bash {
			t.Errorf("case %d: bash %s, TS %s", i, got, w.Bash)
		}
	}
}
