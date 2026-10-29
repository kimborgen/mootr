package tiny

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

// TestMailTitleParsersMatchTS: src/mail-title.ts cleanTitle, parseBoth, cleanSummary and cutText, run by TS and Go on the
// same answers: TS's own test cases, then the layouts the hand-written parseBoth walk must match (labels with marks and
// prefixes, CRLF, labels glued to words, case and Unicode look-alikes, empty labels).
func TestMailTitleParsersMatchTS(t *testing.T) {
	decision := "Pick a token lifetime for SSO?\n- 1h: safest (recommended)\n- 12h: one login a day\n- 24h: fewest logins\n- Never: keep sessions open"
	inputs := []string{
		"**Title: Stub mail title words.**", "\"Deploy fixed\"\nmore text", "  Token lifetime!  ", strings.Repeat("x", 60), "  \n ", "",
		"**Summary: Pick a token lifetime for SSO: 1h or 12h.**", "Pick a lifetime for SSO (S-12, PR #7):\n* 1h: safest (recommended)\n- 12h: one login a day\n\n",
		"1\n2\n3\n4\n5\n6\n7\n8", strings.Repeat("word ", 100), strings.Repeat("x", 500), strings.Repeat("ab ", 130) + strings.Repeat("😀", 20),
		strings.Repeat("x", 397) + strings.Repeat("😀", 5), "short", "Spend is up 30%.\n\nApprove $40?", "Pick one:\n- 1h\n\nLet me know if you need more.",
		"Pick one:\n\n- 1h\n- 12h\n\nHope this helps!\nFeel free to ask.\nI can also add more.", "Deploy is ready.\nIf you approve, it runs at 03:00 tonight.",
		"Build is green.\nLet me know if you have questions.", "Feel free to merge.\nIt is green.", "Build is green.\nLET ME KNOW IF YOU need more.",
		"Title: Rename\nSummary: Options:\n- Title: keep it\n- Name: change it", "Title: Token lifetime\nSummary: " + decision,
		strings.Join([]string{strings.Repeat("y", 90), strings.Repeat("y", 90), strings.Repeat("y", 90), strings.Repeat("y", 90), strings.Repeat("y", 90)}, "\n"),
		"Title: Token lifetime\nSummary: Pick one:\n- 1h (recommended)\n- 12h", "Sure:\n**Title:** Token lifetime\n**Summary:**\nPick one:\n- 1h (recommended)\n- 12h",
		"Line 1: Title: Token lifetime\nLine 2: Summary: Pick one:\n- 1h (recommended)\n- 12h", "Title: Token lifetime Summary: Pick one:\n- 1h (recommended)\n- 12h",
		"Title: Token lifetime\nSummary: Pick one", "Sure, here you go:\nSummary: Pick one\n**Title:** Token lifetime", "Title: Token lifetime Summary: Pick one",
		"Summary: Pick one", "Here is the title and summary:\nTitle: Token lifetime\nSummary: Pick one", "1. Title: Token lifetime\n2. Summary: Pick one",
		"- **Title:** Token lifetime\n- **Summary:** Pick one", "Just a title",
		// Layouts for the walk.
		"Title: A\r\nSummary: B\r\nmore", "Title: A\rSummary: B", "Title: A Summary: B", "TITLE: Caps here\nSUMMARY: Caps too", "title:x summary:y",
		"Title: A summary: \nB", "Title: A Summary:", "Title: A Summary:   ", "Title: A Summary: *", "Title: A Summary:\t_x", "Title: A x_summary: no",
		"Title: A x__Summary: no", "Title: A *Summary*: yes", "Title: A **Summary:** yes", "Title: A Summary :yes", "Title: A Summary\t: yes",
		"Title: ſummary: no\nſummary: no", "Title: A\nSummary:\nTitle: B\nC", "Summary:\n  Title: x\nreal", "Summary: \n\nTitle: B", "Summary:\nPick one",
		"Summary:  \n  - 1h\n- 12h", "Summary: x\nLine 3: Title: B", "Summary: x\n- Title: B", "Summary: x\n> Title: B", "Summary: x\n12) title : B",
		"Summary:**\n**Title** B", "Summary: x\n\tTitle: B", "a summary: b\nTitle: c", "Summary:Summary: twice", "summary: one\nsummary: two",
		"#Title: H\n## Summary: S", ">Title: Q\n>Summary: R", "-Title: dash\n- Summary: d", "Line12Title: glued", "Line 3 : Title: spaced", "3) Title: paren",
		"x Title: mid line", " Title: nbsp", "\tTitle: tab\n\tSummary: tab", "Title: “quoted” ‘words’ here!", "Title: 'single' quotes'", "Title:",
		"Title:\nSummary:", "Summary:", "Title: Kelvin\nSummary: K", "Title: é😀 emoji words\nSummary: " + strings.Repeat("é😀 ", 150),
		"Summary: " + strings.Repeat("x", 398) + "\nmore", "\n\n**Title: Late**", "Title: one. two, three; four", "Title: ok!?.",
		"#  Heading\n•  bullet\n+ plus\n*star", "  summary :  hello\n\nworld  ", "Happy to help!", "hope that helps", "I can also do more\nI CAN ALSO",
	}
	payload, _ := json.Marshal(inputs)
	cmd := exec.Command("node", "--no-warnings", "testdata/titleref.mjs", t.TempDir())
	cmd.Stdin = bytes.NewReader(payload)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("titleref.mjs: %v", err)
	}
	var want []struct{ Title, BothTitle, BothSummary, Summary, Cut string }
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	for i, in := range inputs {
		bt, bs := ParseBoth(in)
		w := want[i]
		if got := CleanTitle(in); got != w.Title {
			t.Errorf("cleanTitle(%q): go %q, ts %q", in, got, w.Title)
		}
		if bt != w.BothTitle || bs != w.BothSummary {
			t.Errorf("parseBoth(%q): go %q %q, ts %q %q", in, bt, bs, w.BothTitle, w.BothSummary)
		}
		if got := CleanMailSummary(in); got != w.Summary {
			t.Errorf("cleanSummary(%q): go %q, ts %q", in, got, w.Summary)
		}
		if got := CutText(in, 12); got != w.Cut {
			t.Errorf("cutText(%q, 12): go %q, ts %q", in, got, w.Cut)
		}
	}
}
