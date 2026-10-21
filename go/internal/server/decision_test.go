package server

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// bodies are the texts hasDecisionBlock and isDeferralOnly are compared on.
var bodies = []string{
	"",
	"plain",
	"```yesno\nShip it?\n```",
	"```YesNo \nShip it?\n```",
	"```decision\n- a\n- b\n```\ntext",
	"~~~pick\nx\n~~~",
	"```js\ncode\n```",
	"``` yesno\nx\n```",
	"```` yesno\nx\n````",
	"```ts\n```yesno\nnot a block\n```\n```",
	"> ```yesno\n> Quoted?\n> ```",
	"- item\n  ```rank\n  a\n  ```",
	"1. one\n\n   ```question\n   Q?\n   ```",
	"- item\nlazy ```yesno\n```",
	"text\n\n    ```yesno\n    indented code\n    ```",
	"\t```yesno\nx\n```",
	"  ```multi\nx\n```",
	"> quote\nlazy continuation\n```choose\n```",
	"```yesno`\nnot a fence\n```",
	"```\nyesno\n```",
	"a\r\n```decision\r\nx\r\n```",
	"- a\n  - b\n    ```pick\n    x\n    ```",
	"> - a\n>   ```yesno\n>   x\n>   ```",
	"```yesno\nunclosed",
	"before ```yesno``` after",
	"Deferring this one: still open, I'll decide later.",
	"Deferring this one: still open, I'll decide later. Keep working on what doesn't depend on it.",
	"Deferring this one. Go with your recommendation, **A**, for now.",
	"> Question?\nDeferring this one: still open, I'll decide later.",
	"Deferring this one: still open, I'll decide later.\nA note.",
	"Deferring this one: still open, I'll decide later.\n\n  Deferring this one: still open, I'll decide later.  ",
	"deferring this one: still open, I'll decide later.",
	"> only a quote",
}

// TestDecisionBlockMatchesTS compares hasDecisionBlock and isDeferralOnly with src/decision-mail.ts on a corpus.
func TestDecisionBlockMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/decision-mail.ts")
	}
	root, err := filepath.Abs("../../..")
	must(t, err)
	in, err := json.Marshal(bodies)
	must(t, err)
	script := `import(process.argv[1]).then((m) => { const b = JSON.parse(process.argv[2]); console.log(JSON.stringify(b.map((x) => [m.hasDecisionBlock(x), m.isDeferralOnly(x, 0), m.isDeferralOnly(x, 1)]))); process.exit(0); })`
	out, err := exec.Command("node", "--no-warnings", "-e", script, filepath.Join(root, "src", "decision-mail.ts"), string(in)).Output()
	if err != nil {
		t.Skipf("src/decision-mail.ts did not load alone: %v", err)
	}
	var want [][3]bool
	must(t, json.Unmarshal([]byte(strings.TrimSpace(string(out))), &want))
	for i, b := range bodies {
		got := [3]bool{hasDecisionBlock(b), isDeferralOnly(b, 0), isDeferralOnly(b, 1)}
		if got != want[i] {
			t.Errorf("%q: go %v, ts %v", b, got, want[i])
		}
	}
	yes := 0
	for _, w := range want {
		if w[0] {
			yes++
		}
	}
	if yes < 8 {
		t.Errorf("only %d bodies have a decision block in the reference; the corpus tests too little", yes)
	}
}
