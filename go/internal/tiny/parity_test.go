package tiny

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// TestPureMatchesTS: the pure parts of src/tool-summaries.ts (parseToolSummary, callHash, callText, readCalls),
// src/tool-names.ts (parseToolLabel, readNames), src/tool-name-labels.ts (splitTool, seededLabel), src/block-summaries.ts
// (cleanSummary, textHash) and src/config-hash.ts, run by TS and Go on the same cases.
func TestPureMatchesTS(t *testing.T) {
	long := strings.Repeat("w ", 12)
	answers := []jsjson.Value{
		`{"tool": "run command", "doing": "running the web tests"}`,
		"```json\n{\"tool\":\"edit  file\",\"doing\":\" fixing\\nthe header \"}\n```",
		"```\n{\"tool\":\"a\",\"doing\":\"b\"}```",
		"  ```json{\"tool\":\"a\",\"doing\":\"b\"}  ```  ",
		"Tool: run command", `{"tool": "run command"}`, `{"tool": "run command", "doing": 4}`, `{"tool": "", "doing": "x"}`,
		`["run", "x"]`, `{"tool": "one two three four", "doing": "x"}`,
		`{"tool":"run","doing":"` + long + `w"}`, `{"tool":"run","doing":"` + long + `"}`,
		`{"tool":"run  cmd","doing":"x\ty"}`, `{"tool":"` + strings.Repeat("x", 41) + `","doing":"x"}`,
		`{"tool":"é","doing":"` + strings.Repeat("😀", 80) + `"}`, `{"tool":"é","doing":"` + strings.Repeat("😀", 81) + `"}`,
		`{"tool":"a","doing":"b"} trailing`, `{"tool":"a","doing":"b","tool":"c"}`, `null`, ``, nil, 5.0,
		`{"label": "Send mail"}`, "```json\n{\"label\":\"  Run\\n command \"}\n```", `{"label": "one two three four"}`,
		`{"label": ""}`, `{"label": 3}`, `{"label":"` + strings.Repeat("x", 31) + `"}`, `[{"label":"x"}]`,
	}
	cleans := []jsjson.Value{
		"**Summary:** Tells the agent to *keep* `files` tidy.", "Title: x", "  summary :  hello\n\nworld  ", "#_*`", "",
		strings.Repeat("ab ", 100), strings.Repeat("😀", 150), "SUMMARY: Caps", "Summaryless text", nil, 3.0,
	}
	calls := []jsjson.Value{
		jsjson.NewObject("id", "a", "name", "Read", "input", jsjson.NewObject("file_path", "/a.ts")),
		jsjson.NewObject("id", "b", "name", "Bash"),
		jsjson.NewObject("id", "c", "name", "Bash", "input", nil),
		jsjson.NewObject("id", "d", "name", "Bash", "input", "plain text input"),
		jsjson.NewObject("id", "e", "name", "Write", "input", jsjson.NewObject("content", strings.Repeat("é", 2500))),
		jsjson.NewObject("id", "f", "name", "Write", "input", strings.Repeat("x", 1998)+"😀tail"),
		jsjson.NewObject("id", "g", "name", "W", "input", []jsjson.Value{1.0, "two", nil, jsjson.NewObject("k", 1.5e21)}),
	}
	callLists := []jsjson.Value{
		[]jsjson.Value{jsjson.NewObject("id", "a", "name", "Bash", "input", jsjson.NewObject("command", "ls"))},
		"a", []jsjson.Value{jsjson.NewObject("id", "a")}, []jsjson.Value{jsjson.NewObject("id", "", "name", "Bash")},
		[]jsjson.Value{jsjson.NewObject("id", strings.Repeat("i", 200), "name", strings.Repeat("n", 200))},
		[]jsjson.Value{jsjson.NewObject("id", strings.Repeat("i", 201), "name", "Bash")},
		[]jsjson.Value{jsjson.NewObject("id", "a", "name", strings.Repeat("n", 201))},
		[]jsjson.Value{jsjson.NewObject("id", strings.Repeat("😀", 100), "name", "x")},
		[]jsjson.Value{jsjson.NewObject("id", strings.Repeat("😀", 101), "name", "x")},
		[]jsjson.Value{nil}, []jsjson.Value{[]jsjson.Value{"a"}}, []jsjson.Value{jsjson.NewObject("id", 1.0, "name", "x")},
		[]jsjson.Value{jsjson.NewObject("id", "a", "name", "x", "input", nil)}, []jsjson.Value{},
	}
	nameLists := []jsjson.Value{
		[]jsjson.Value{"Bash", "mcp__stam__send_mail"}, "x", []jsjson.Value{""}, []jsjson.Value{3.0},
		[]jsjson.Value{strings.Repeat("n", 200)}, []jsjson.Value{strings.Repeat("n", 201)}, []jsjson.Value{},
	}
	splits := [][2]string{
		{"Bash", "claude"}, {"mcp__stam__send_mail", "claude"}, {"mcp__a__b__c", "opencode"}, {"mcp____x", "claude"},
		{"stam.send_mail", "codex"}, {"stam.send_mail", "claude"}, {"exec_command", "codex"}, {"read", "opencode"},
		{"Read", "opencode"}, {"mcp__s__t\nx", "claude"}, {".x", "codex"}, {"a.b.c", "codex"}, {"web_search", "codex"}, {"x", "other"},
	}
	configs := [][]jsjson.Value{{"m", "prompt"}, {"google/gemma-3-4b-it", "You \"q\" é\n", 12.0}, {"", ""}, {}}

	// TS.
	splitVals := make([]jsjson.Value, len(splits))
	for i, s := range splits {
		splitVals[i] = []jsjson.Value{s[0], s[1]}
	}
	configVals := make([]jsjson.Value, len(configs))
	for i, c := range configs {
		configVals[i] = c
	}
	in := jsjson.NewObject("home", t.TempDir(), "summaries", answers, "labels", answers, "cleans", cleans, "calls", calls,
		"callLists", callLists, "nameLists", nameLists, "splits", splitVals, "configs", configVals)
	cmd := exec.Command("node", "--no-warnings", "testdata/tinyref.mjs")
	cmd.Stdin = strings.NewReader(jsjson.Stringify(in, ""))
	cmd.Stderr = os.Stderr
	tsOut, err := cmd.Output()
	if err != nil {
		t.Fatalf("tinyref.mjs: %v", err)
	}

	// Go.
	str := func(v jsjson.Value) *string {
		if s, ok := v.(string); ok {
			return &s
		}
		return nil
	}
	var sums, labs, cls, hashes, texts, lists, nlists, sps, cfgs, ths []jsjson.Value
	for _, a := range answers {
		if s, ok := ParseToolSummary(str(a), 12); ok {
			sums = append(sums, jsjson.NewObject("tool", s.Tool, "doing", s.Doing))
		} else {
			sums = append(sums, nil)
		}
		if l, ok := ParseToolLabel(str(a)); ok {
			labs = append(labs, l)
		} else {
			labs = append(labs, nil)
		}
	}
	for _, c := range cleans {
		if s, ok := CleanSummary(str(c)); ok {
			cls = append(cls, s)
		} else {
			cls = append(cls, nil)
		}
		if s, ok := c.(string); ok {
			ths = append(ths, TextHash(s))
		}
	}
	for _, c := range calls {
		got, err := ReadCalls([]jsjson.Value{c})
		if err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, CallHash(got[0]))
		texts = append(texts, CallText(got[0]))
	}
	for _, l := range callLists {
		got, err := ReadCalls(l)
		if err != nil {
			lists = append(lists, jsjson.NewObject("error", err.Error()))
			continue
		}
		out := []jsjson.Value{}
		for _, c := range got {
			out = append(out, jsjson.NewObject("id", c.ID, "name", c.Name, "hasInput", c.HasInput, "input", c.Input))
		}
		lists = append(lists, out)
	}
	for _, l := range nameLists {
		got, err := ReadNames(l)
		if err != nil {
			nlists = append(nlists, jsjson.NewObject("error", err.Error()))
			continue
		}
		out := []jsjson.Value{}
		for _, n := range got {
			out = append(out, n)
		}
		nlists = append(nlists, out)
	}
	for _, s := range splits {
		server, tool := SplitTool(s[0], s[1])
		sps = append(sps, jsjson.NewObject("server", server, "tool", tool, "seeded", SeededLabel(s[1], tool)))
	}
	for _, c := range configs {
		cfgs = append(cfgs, ConfigHash(c...))
	}
	goOut := jsjson.Stringify(jsjson.NewObject("summaries", sums, "labels", labs, "cleans", cls, "hashes", hashes, "texts", texts,
		"callLists", lists, "nameLists", nlists, "splits", sps, "configs", cfgs, "texthashes", ths), "")
	if goOut != string(tsOut) {
		diff(t, string(tsOut), goOut)
	}
	// The deviation: a cut through a surrogate pair drops its first half, where TS keeps it alone.
	if got := CallText(ToolCall{Name: "W", Input: strings.Repeat("x", 1999) + "😀", HasInput: true}); got != "Tool: W\nInput: "+strings.Repeat("x", 1999) {
		t.Errorf("a cut through a pair: %q", got[len(got)-8:])
	}
}

// diff fails with each list entry where TS and Go differ.
func diff(t *testing.T, ts, goOut string) {
	t.Helper()
	a, err1 := jsjson.Parse([]byte(ts))
	b, err2 := jsjson.Parse([]byte(goOut))
	if err1 != nil || err2 != nil {
		t.Fatalf("unparsable: %v %v", err1, err2)
	}
	ao, bo := a.(*jsjson.Object), b.(*jsjson.Object)
	for _, k := range ao.Keys() {
		av, _ := ao.Get(k)
		bv, _ := bo.Get(k)
		al, _ := av.([]jsjson.Value)
		bl, _ := bv.([]jsjson.Value)
		if len(al) != len(bl) {
			t.Errorf("%s: %d entries in TS, %d in Go", k, len(al), len(bl))
			continue
		}
		for i := range al {
			if x, y := jsjson.Stringify(al[i], ""), jsjson.Stringify(bl[i], ""); x != y {
				t.Errorf("%s[%d]\n  ts %.300s\n  go %.300s", k, i, x, y)
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
