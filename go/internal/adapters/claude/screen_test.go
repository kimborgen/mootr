package claude

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

// TestScreenMatchesTS reads input boxes with promptInBox and inputGhost in TS (src/adapters/claude-ghost.ts) and in Go,
// and compares the answers.
func TestScreenMatchesTS(t *testing.T) {
	const rule = "────────────────────────────────────────"
	const esc = "\x1b"
	box := func(rows ...string) []string {
		return append(append([]string{"● Earlier output", "", rule}, rows...), rule, "  ? for shortcuts")
	}
	prompt := "Run the shell command 'echo hi', then reply with exactly DONE."
	type tc struct {
		Ansi []string `json:"ansi"`
		Text string   `json:"text"`
	}
	cases := []tc{
		{box("❯ "), prompt},
		{box("❯ "), prompt},
		{box("❯ " + esc + "[2mTry \"fix lint errors\"" + esc + "[0m"), prompt},
		{box("❯ " + esc + "[7mT" + esc + "[0m" + esc + "[90mry \"refactor\"" + esc + "[39m"), prompt},
		{box("❯ " + prompt), prompt},
		{box("❯ Run the shell command 'echo hi', then", "  reply with exactly DONE."), prompt},
		{box("❯ " + prompt + esc + "[2m  ↵ send" + esc + "[22m"), prompt},
		{box("❯ " + prompt + prompt), prompt},
		{box("❯ Run the shell"), prompt},
		{box("❯ [Pasted text #1 +3 lines]"), prompt},
		{box("❯ [Pasted text #1][Pasted text #2]"), prompt},
		{box("❯ " + esc + "[38;5;245mgrey256" + esc + "[0m solid"), "grey256solid"},
		{box("❯ " + esc + "[38:5:8mcolon" + esc + "[m"), "colon"},
		{box("❯ " + esc + "[90mfaint " + esc + "[0mthen solid"), "faintthen solid"},
		{box("❯ " + esc + "]8;;http://x" + esc + "\\link" + esc + "]8;;" + esc + "\\ text"), "linktext"},
		{box("❯ " + esc + "[1;2;3mdim bold" + esc + "[22mx"), "dimboldx"},
		{box("❯ with exactly", "  DONE.", "  more"), "Run the shell command 'echo hi', then reply with exactly DONE.more"},
		{box("❯\u00a0with exactly", "  DONE."), prompt},
		{box("❯\u00a0then reply", "  with exactly", "  DONE."), prompt},
		{box("! ls -la"), "ls -la"},
		{[]string{"no box at all", "just text"}, prompt},
		{[]string{"❯ old menu row", rule, "❯ x", rule, "  ❯ completion"}, "x"},
		{[]string{rule, "❯ first", "", "second", rule}, "first second"},
		{[]string{"❯ open box", "  wraps", "", "after blank"}, "open boxwraps"},
		{box("❯ 日本語のテキスト"), "日本語の テキスト"},
		{box("❯ 😀 emoji"), "😀emoji"},
		{box("❯"), ""},
		{box("  ❯ indented"), "indented"},
		{[]string{"━━━", "❯ heavy", "━━━"}, "heavy"},
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "testdata/ts-screen.mjs")
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-screen.mjs: %v\n%s", err, stderr.String())
	}
	var want []struct {
		Box   *string `json:"box"`
		Ghost bool    `json:"ghost"`
	}
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for i, c := range cases {
		w := ""
		if want[i].Box != nil {
			w = *want[i].Box
		}
		seen[w] = true
		if got := PromptInBox(c.Ansi, c.Text); got != w {
			t.Errorf("case %d %q: PromptInBox = %q, TS %q", i, c.Ansi, got, w)
		}
		if got := InputGhost(c.Ansi); got != want[i].Ghost {
			t.Errorf("case %d %q: InputGhost = %v, TS %v", i, c.Ansi, got, want[i].Ghost)
		}
	}
	// The cases reach every answer, so a Go reading stuck on one can't pass.
	for _, b := range []string{"", BoxEmpty, BoxOne, BoxOther} {
		if !seen[b] {
			t.Errorf("no case where TS answers %q", b)
		}
	}
}
