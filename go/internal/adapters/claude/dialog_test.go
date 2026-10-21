package claude

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// TestDialogParity: dialogNames, dialogKey and dialogTarget answer as src/adapters/claude-dialog.ts does, for the screens
// Claude Code draws and the shapes that must fail closed.
func TestDialogParity(t *testing.T) {
	home, _ := os.UserHomeDir()
	type tc struct {
		Body    []string        `json:"body"`
		Tool    string          `json:"tool"`
		Target  string          `json:"target"`
		Input   json.RawMessage `json:"input"`
		Approve bool            `json:"approve"`
	}
	read := []string{" Read file", "", "  Read(/elsewhere/menu.png)", "", " Do you want to proceed?",
		" ❯ 1. Yes, and keep allowing any reads outside the working directories",
		"   2. No, and block reads outside the working directories from now on",
		"   3. No, and ask again next time", "   4. Yes, but ask again next time"}
	wrapped := []string{"│ Bash command                         │", "│   Bash(echo aaaaaaaaaaaaaaaaaaaaaaaa │", "│   aaaa one)                          │", "│ ❯ 1. Yes                             │", "│   2. No                              │"}
	cases := []tc{
		{Body: read, Tool: "Read", Target: "/elsewhere/menu.png", Approve: true, Input: json.RawMessage(`{"file_path":"/elsewhere/menu.png"}`)},
		{Body: read, Tool: "Read", Target: "/elsewhere/menu.png", Approve: false},
		{Body: read, Tool: "Read", Target: "/elsewhere/menu", Approve: true},
		{Body: read, Tool: "Write", Target: "/elsewhere/menu.png", Approve: true},
		{Body: read, Tool: "Re ad", Target: "/elsewhere/menu.png", Approve: true},
		{Body: read, Tool: "Read", Target: "  ", Approve: true},
		{Body: wrapped, Tool: "Bash", Target: "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaa one", Approve: true, Input: json.RawMessage(`{"command":"echo aaaaaaaaaaaaaaaaaaaaaaaaaaaa one","description":"x"}`)},
		{Body: wrapped, Tool: "Bash", Target: "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaa", Approve: true},
		{Body: wrapped, Tool: "Bash", Target: "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaa one", Approve: false},
		// A tool named only inside the text, not starting a line.
		{Body: []string{"  see Read(/x) here", "❯ 1. Yes"}, Tool: "Read", Target: "/x", Approve: true},
		{Body: []string{"Read(" + home + "/notes.md)", "1. Yes, and don't ask again", "2. No"}, Tool: "Read", Target: home + "/notes.md", Approve: true},
		{Body: []string{"Read(~/notes.md)", "1.  Yes", "2. No, and ask again next time"}, Tool: "Read", Target: home + "/notes.md", Approve: true},
		{Body: []string{"Read(~/notes.md)", "1.  Yes", "2. No, and ask again next time"}, Tool: "Read", Target: home + "/notes.md", Approve: false},
		{Body: []string{"Read(/a…)", "1. Yes"}, Tool: "Read", Target: "/a/b/c", Approve: true},
		{Body: nil, Tool: "Read", Target: "/x", Approve: true},
		{Input: json.RawMessage(`{"notebook_path":"/n.ipynb","command":"ls"}`)},
		{Input: json.RawMessage(`{"path":7,"command":"ls"}`)},
		{Input: json.RawMessage(`{"file_path":null,"url":"https://x"}`)},
		{Input: json.RawMessage(`{"pattern":"*.go"}`)},
		{Input: json.RawMessage(`{}`)},
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "testdata/ts-dialog.mjs")
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-dialog.mjs: %v\n%s", err, stderr.String())
	}
	var want []struct {
		Names  bool    `json:"names"`
		Key    *string `json:"key"`
		Target string  `json:"target"`
	}
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		var input *jsjson.Object
		if len(c.Input) > 0 {
			v, err := jsjson.Parse(c.Input)
			if err != nil {
				t.Fatal(err)
			}
			input, _ = v.(*jsjson.Object)
		}
		key := DialogKey(c.Body, c.Approve)
		wantKey := ""
		if want[i].Key != nil {
			wantKey = *want[i].Key
		}
		if got := DialogNames(c.Body, c.Tool, c.Target); got != want[i].Names {
			t.Errorf("case %d: names %v, TS %v", i, got, want[i].Names)
		}
		if key != wantKey {
			t.Errorf("case %d: key %q, TS %q", i, key, wantKey)
		}
		if got := DialogTarget(input); got != want[i].Target {
			t.Errorf("case %d: target %q, TS %q", i, got, want[i].Target)
		}
	}
}

// TestDialogAnswer: the key typed into a dialog on screen, and when nothing is: no dialog, a dialog that can't be tied
// to the request (for a no too), or a yes the dialog doesn't offer once.
func TestDialogAnswer(t *testing.T) {
	screen := strings.Join([]string{"old output", "Esc to cancel (an old one)", "────────────────", " Read file", "  Read(/elsewhere/menu.png)",
		" ❯ 1. Yes, and keep allowing any reads outside the working directories", "   2. No, and ask again next time", "   3. Yes, but ask again next time",
		" Enter to confirm · Esc to cancel", "❯ "}, "\n")
	details := `{"tool":"Read","input":{"file_path":"/elsewhere/menu.png"},"session":"s1"}`
	// edit is a dialog with these rows under its header.
	edit := func(rows ...string) string {
		return strings.Join(append(append([]string{"────────────────", " Edit file", ""}, rows...), "", " Do you want to proceed?", " ❯ 1. Yes",
			"   2. No, and tell Claude what to do differently (esc)", " Enter to confirm · Esc to cancel"), "\n")
	}
	for _, c := range []struct {
		screen, details string
		approve         bool
		key, outcome    string
	}{
		{screen, details, true, "3", "typed"},
		{screen, details, false, "2", "typed"},
		// A screen that doesn't tie the dialog to the request types nothing, whatever it shows: a whole other call too, since
		// stam can't tell that from a call it misreads.
		{screen, `{"tool":"Read","input":{"file_path":"/elsewhere/other.png"}}`, true, "", "unsafe"},
		{screen, `{"tool":"Read","input":{"file_path":"/elsewhere/other.png"}}`, false, "", "unsure"},
		{screen, `{"tool":"Bash","input":{"command":"ls"}}`, false, "", "unsure"},
		{screen, `{"message":"Claude needs your permission to use Read"}`, false, "", "unsure"},
		{screen, `{"message":"Claude needs your permission to use Read"}`, true, "", "unsafe"},
		{screen, `{"tool":"mcp__github__create_issue","input":{"title":"x"}}`, false, "", "unsure"},
		{strings.Replace(screen, "  Read(/elsewhere/menu.png)", "", 1), details, false, "", "unsure"},
		{strings.Replace(screen, "  Read(", "  Update(", 1), `{"tool":"Edit","input":{"file_path":"/elsewhere/menu.png"}}`, false, "", "unsure"},
		{edit("  Update(/elsewhere/b.txt)", "", "  - old line", "  + new line"), `{"tool":"Edit","input":{"file_path":"/elsewhere/a.txt"}}`, false, "", "unsure"},
		{edit(`  Search(pattern: "foo", path: "/elsewhere")`), `{"tool":"Grep","input":{"pattern":"foo","path":"/elsewhere"}}`, false, "", "unsure"},
		{edit("  Update(/elsewhere/name)", "  1. file.txt)"), `{"tool":"Edit","input":{"file_path":"/elsewhere/name)1. file.txt"}}`, false, "", "unsure"},
		// A call wrapped over two rows is read whole.
		{strings.Replace(screen, "  Read(/elsewhere/menu.png)", "  Read(/elsewhere/a/long/\n  path.png)", 1), `{"tool":"Read","input":{"file_path":"/elsewhere/a/long/path.png"}}`, false, "2", "typed"},
		{strings.Replace(screen, "  Read(/elsewhere/menu.png)", "  Read(/elsewhere/a/long/\n  path.png)", 1), details, false, "", "unsure"},
		{strings.Replace(screen, "2. No, and ask again next time", "2. No", 1), details, false, "Escape", "typed"},
		{strings.Replace(screen, "3. Yes, but ask again next time", "3. Yes, always", 1), details, true, "", "unsafe"},
		{"❯ \n? for shortcuts", details, true, "", "gone"},
		// The top rule above the dialog bounds its body: an option above the rule isn't the dialog's.
		{strings.Join([]string{"   3. Yes, but ask again next time", "────────", "  Read(/elsewhere/menu.png)", "Esc to cancel"}, "\n"), details, true, "", "unsafe"},
	} {
		key, outcome := DialogAnswer(c.screen, c.details, c.approve)
		if key != c.key || outcome != c.outcome {
			t.Errorf("approve %v on %q: %q %s, want %q %s", c.approve, c.details, key, outcome, c.key, c.outcome)
		}
	}
}

// TestDialogDetails: the details a hook writes read back; anything else reads as no dialog details.
func TestDialogDetails(t *testing.T) {
	d := DialogDetails(`{"tool":"Bash","input":{"command":"ls"},"session":"s-9"}`)
	if !d.HasTool || d.Tool != "Bash" || DialogTarget(d.Input) != "ls" || d.Session != "s-9" {
		t.Errorf("details %+v", d)
	}
	for _, bad := range []string{"", "not json", "[1]", `"s"`, `{"tool":5,"input":"x","session":null}`} {
		if d := DialogDetails(bad); d.HasTool || d.Input != nil || d.Session != "" {
			t.Errorf("%q: %+v", bad, d)
		}
	}
}
