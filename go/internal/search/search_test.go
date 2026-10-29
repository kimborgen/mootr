package search

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The cleaning, ranking, excerpts and stub vectors match src/search.ts and src/embed.ts on the same inputs: mail
// components and markup, Unicode, long text cut in UTF-16 units, and stems.
func TestTextMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/search.ts")
	}
	texts := []string{
		"users keep getting redirected back to the sign-in page after logout",
		"TLDR: inline \\(a^2+b^2\\) then widgetToken here.\n\n> [!NOTE]\n> a second widgetToken.\n\n<details><summary>More</summary>\n\n```decision\nwidgetToken in a fence\n```\n\n</details>",
		"```\nchart\ntype: bar\n```\n# Heading *bold* _it_ `code` [link] $$x$$",
		"Ünïcödé café — naïve spaces and emoji 🎉 then the Index rebuilding",
		strings.Repeat("long words about the search index rebuilding ", 80) + "tail-match here",
		"",
		"The Invoices and invoicing: reconciled, reconciling, boxes, glass",
		"path/to-index.go (index) [index] {index} index",
	}
	queries := []string{"index", "Index rebuilding", "widgettoken", "tail-match", "zzz", "café", "redirect"}
	in, _ := json.Marshal(map[string]any{"texts": texts, "queries": queries})
	cmd := exec.Command("node", "--no-warnings", "testdata/textref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	cmd.Env = append(os.Environ(), "STAM_HOME="+t.TempDir(), "MOOTR_HOME=", "STAM_EMBEDDER=stub", "MOOTR_EMBEDDER=stub")
	raw, err := cmd.Output()
	if err != nil {
		var stderr string
		if ee, ok := err.(*exec.ExitError); ok {
			stderr = string(ee.Stderr)
		}
		t.Fatalf("textref.mjs: %v\n%s", err, stderr)
	}
	var want struct {
		Plain, Embed, Excerpt []string
		Stub                  [][]float64
		Rank                  []int
	}
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	n := 0
	for i, text := range texts {
		if got := PlainText(text); got != want.Plain[i] {
			t.Errorf("plainText(%q)\n got %q\nwant %q", text, got, want.Plain[i])
		}
		if got := EmbedText("Subject", text); got != want.Embed[i] {
			t.Errorf("embedText(%q)\n got %q\nwant %q", text, got, want.Embed[i])
		}
		vec := StubVector(text)
		for d, f := range vec {
			if float64(f) != want.Stub[i][d] {
				t.Errorf("stubVector(%q)[%d] = %v, want %v", text, d, f, want.Stub[i][d])
				break
			}
		}
		for _, q := range queries {
			if got := Rank(text, q); got != want.Rank[n] {
				t.Errorf("rank(%q, %q) = %d, want %d", text, q, got, want.Rank[n])
			}
			if got := Excerpt(text, q); got != want.Excerpt[n] {
				t.Errorf("excerpt(%q, %q)\n got %q\nwant %q", text, q, got, want.Excerpt[n])
			}
			n++
		}
	}
}

func TestProvider(t *testing.T) {
	for _, c := range []struct {
		env   string
		off   bool
		want  Provider
		model string
	}{
		{"stub", true, Stub, StubModel},
		{"off", false, Off, ""},
		{"", true, Off, ""},
		{"", false, Local, LocalModel},
		{"other", false, Local, LocalModel},
	} {
		if p := ProviderOf(c.env, c.off); p != c.want || p.Model() != c.model {
			t.Errorf("ProviderOf(%q, %v) = %s (%s), want %s (%s)", c.env, c.off, p, p.Model(), c.want, c.model)
		}
	}
}
