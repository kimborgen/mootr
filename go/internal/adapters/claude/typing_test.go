package claude

import (
	"encoding/json"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

// TestTypingParity: Columns, Graphemes and TurnRunning answer as src/adapters/claude.ts columns, Intl.Segmenter and
// typeLiteralInput's running check do.
func TestTypingParity(t *testing.T) {
	type tc struct {
		Text  string   `json:"text"`
		Lines []string `json:"lines"`
	}
	cases := []tc{
		{Text: "", Lines: []string{"❯ "}},
		{Text: "❯ hello", Lines: []string{"✶ Blanching… (13s · ↓ 472 tokens)"}},
		{Text: "! ls -la", Lines: []string{"✽ Marinating…"}},
		{Text: "日本語のテキスト", Lines: []string{"  * Thinking… more"}},
		{Text: "한국어 ｆｕｌｌ", Lines: []string{"· x…"}},
		{Text: "café é ä́", Lines: []string{"✻ …"}},
		{Text: "😀 👍🏽 ❤️ ☀ ✅ ©", Lines: []string{"Enter to confirm"}},
		{Text: "👨‍👩‍👧 🏳️‍🌈 🇳🇴🇸🇪 🇳", Lines: []string{"some … (", "12s)"}},
		{Text: "zero‍width ️ ⏩ ➡ ❯❯", Lines: []string{"done… (3m 2s)", "❯ "}},
		{Text: "tag 🏴\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f end", Lines: []string{"Esc to cancel"}},
		{Text: "가 ㄱ ﹏", Lines: []string{"✳  working", "plain output…"}},
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "testdata/ts-typing.mjs")
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-typing.mjs: %v\n%s", err, stderr.String())
	}
	var want []struct {
		Cols      int      `json:"cols"`
		Graphemes []string `json:"graphemes"`
		Running   bool     `json:"running"`
	}
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	ran := map[bool]bool{}
	for i, c := range cases {
		w := want[i]
		ran[w.Running] = true
		if got := Columns(c.Text); got != w.Cols {
			t.Errorf("Columns(%q) = %d, TS %d", c.Text, got, w.Cols)
		}
		if got := Graphemes(c.Text); !reflect.DeepEqual(got, w.Graphemes) && !(len(got) == 0 && len(w.Graphemes) == 0) {
			t.Errorf("Graphemes(%q) = %q, TS %q", c.Text, got, w.Graphemes)
		}
		if got := TurnRunning(c.Lines); got != w.Running {
			t.Errorf("TurnRunning(%q) = %v, TS %v", c.Lines, got, w.Running)
		}
	}
	if !ran[true] || !ran[false] {
		t.Errorf("the cases don't cover both answers of the running check: %v", ran)
	}
}

// TestTypingScreen: the vim mode in the footer, an empty box, and a dialog on screen.
func TestTypingScreen(t *testing.T) {
	rule := "────────────────────"
	insert := []string{"out", rule, "❯ ", rule, "  -- INSERT --"}
	normal := []string{"out", rule, "❯ hi", rule, "  -- NORMAL --"}
	if !InsertMode(insert) || NormalMode(insert) || InsertMode(normal) || !NormalMode(normal) {
		t.Error("the footer's mode")
	}
	// The mode named over the box isn't the footer's.
	if InsertMode([]string{"-- INSERT --", rule, "❯ ", rule, "  ? for shortcuts"}) {
		t.Error("a mode over the box")
	}
	if !EmptyBox(insert, 40) || EmptyBox(normal, 40) || EmptyBox([]string{"no box"}, 40) || EmptyBox([]string{rule, "! ", rule}, 40) {
		t.Error("the empty box")
	}
	if !ShowsDialog([]string{"x", " Enter to confirm · Esc to cancel"}) || ShowsDialog(insert) {
		t.Error("a dialog")
	}
	if at, end, ok := BoxRows(insert); !ok || at != 2 || end != 3 {
		t.Errorf("box rows %d %d %v", at, end, ok)
	}
}
