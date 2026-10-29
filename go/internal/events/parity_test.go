package events

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"testing"

	"stam/internal/jsjson"
)

// The filter functions answer as src/watch.ts does, over the same inputs (S-3775): a glob crossed with values, filters
// crossed with events, sanitizer inputs, link URLs and failure summaries.
func TestMatchesTS(t *testing.T) {
	patterns := []string{"*", "", "github:o/*", "github:o/r#1", "github:o/r#1*", "a.c", "pull_request.*", "issues", "x*y*z", "*/*", "github:*", "a(b)"}
	values := []string{"", "github:o/r", "github:o/r#1", "github:o/r#12", "github:o/r/extra", "abc", "a.c", "pull_request.opened", "issues.opened", "xyz", "x1y2z", "x/y/z", "a(b)", "github:p/r#1", "line\nbreak"}
	type ev struct {
		Source   string   `json:"source"`
		Type     string   `json:"type"`
		Subjects []string `json:"subjects"`
		Actor    *string  `json:"actor"`
		Payload  any      `json:"payload,omitempty"`
	}
	str := func(s string) *string { return &s }
	events := []ev{
		{"github", "pull_request.opened", []string{"github:o/r#1"}, str("octocat"), nil},
		{"github", "issues.closed", []string{"github:o/r"}, nil, nil},
		{"linear", "issue.created", []string{"linear:T-1", "github:o/r#1"}, str(""), nil},
		{"github", "checks.completed", []string{}, str("ci"), map[string]any{"at": "2026-10-14T16:22:00Z"}},
		{"github", "comment.created", []string{"github:o/r#1"}, str("bot"), map[string]any{"at": "2026-10-14T16:44:00Z", "review_agent": "a1"}},
	}
	var filters []map[string]any
	for _, f := range []map[string]any{
		{}, {"source": "github"}, {"types": []string{"pull_request.*"}}, {"types": []string{"issues"}}, {"subjects": []string{"github:o/*"}},
		{"subjects": []string{"github:o/r#1", "linear:*"}}, {"actors": []string{"octo*"}}, {"actors": []string{"*"}}, {"exclude_actors": []string{"bot", "ci"}},
		{"source": "github", "types": []string{"checks.*", "comment.created"}, "subjects": []string{"github:o/r#1"}},
		{"since": "2026-10-14T16:41:00Z", "ends_on": []string{"pull_request.merged"}}, {"since": "2026-10-14T16:41:00Z", "ends_on": []string{"comment.created"}},
	} {
		filters = append(filters, f)
	}
	cases := map[string]any{}
	var globs [][2]string
	for _, p := range patterns {
		for _, v := range values {
			globs = append(globs, [2]string{p, v})
		}
	}
	cases["glob"] = globs
	var matches, fits [][]any
	for _, f := range filters {
		for _, e := range events {
			matches = append(matches, []any{f, e})
			for _, kind := range []string{"agent", "itsa"} {
				fits = append(fits, []any{kind, "a1", f, e})
			}
		}
	}
	cases["matches"], cases["fits"] = matches, fits
	sanitize := []any{nil, map[string]any{}, "text", 5, []any{1},
		map[string]any{"source": " github "}, map[string]any{"source": "  "}, map[string]any{"source": 7}, map[string]any{"source": nil},
		map[string]any{"subjects": "a"}, map[string]any{"subjects": []any{"a", "", nil, 3, true}}, map[string]any{"subjects": []any{}}, map[string]any{"subjects": ""},
		map[string]any{"types": 7}, map[string]any{"types": true}, map[string]any{"actors": map[string]any{"a": 1}}, map[string]any{"types": []any{[]any{"a", "b"}}},
		map[string]any{"since": " 2026-01-01 ", "ends_on": "x", "exclude_actors": []any{"b"}, "unknown": 1}, map[string]any{"since": 0},
	}
	cases["sanitize"] = sanitize
	cases["url"] = []string{"https://github.com/example/stam/pull/12", "https://github.com/example/stam/issues/7", "http://github.com/e/s/pull/12/files#x", "https://github.com/e/s/pull/12?a=1",
		"https://linear.app/o/issue/TEAM-123/a-title", "https://linear.app/o/issue/team-9", "https://github.com/e/s", "https://github.com/e/s/pull/x", "https://example.com/x", "", "  https://github.com/o/r/pull/3  ",
		"https://github.com/e/s/pull/12\nx", "https://github.com/e/s/pull/12 x", "https://github.com/a b/s/pull/1", "https://linear.app/o/issue/9-1"}
	// The failure cases need summaries: three each, passing and failing.
	var failure []map[string]any
	for _, e := range []struct{ typ, summary string }{
		{"checks.completed", "2 checks failed"}, {"checks.completed", "all checks passed"}, {"review.submitted", "a (changes requested)"}, {"review.submitted", "a (approved)"},
		{"comment.created", "Deploy of abc123 stopped: red"}, {"comment.created", "Deploy of  stopped:"}, {"comment.created", "hi"}, {"push", "checks failed"},
	} {
		for _, src := range []string{"github", "linear"} {
			failure = append(failure, map[string]any{"source": src, "type": e.typ, "summary": e.summary})
		}
	}
	cases["failure"] = failure
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "--no-warnings", "testdata/eventsref.mjs")
	cmd.Stdin = bytes.NewReader(in)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("eventsref.mjs: %v\n%s", err, stderr.String())
	}
	var ref struct {
		Glob     []bool   `json:"glob"`
		Matches  []bool   `json:"matches"`
		Fits     []bool   `json:"fits"`
		Sanitize []string `json:"sanitize"`
		URL      []string `json:"url"`
		Failure  []bool   `json:"failure"`
	}
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	// The same inputs as the Go types the service reads.
	toEvent := func(v any) Event {
		var e struct {
			Source   string   `json:"source"`
			Type     string   `json:"type"`
			Subjects []string `json:"subjects"`
			Actor    *string  `json:"actor"`
			Payload  any      `json:"payload"`
			Summary  string   `json:"summary"`
		}
		b, _ := json.Marshal(v)
		_ = json.Unmarshal(b, &e)
		out := Event{Source: e.Source, Type: e.Type, Subjects: e.Subjects, Summary: e.Summary}
		if e.Actor != nil {
			out.Actor, out.HasActor = *e.Actor, *e.Actor != ""
		}
		if e.Payload != nil {
			pb, _ := json.Marshal(e.Payload)
			out.Payload, _ = jsjson.Parse(pb)
		}
		return out
	}
	toFilter := func(v any) Filter {
		b, _ := json.Marshal(v)
		var f Filter
		_ = json.Unmarshal(b, &f)
		return f
	}
	for i, g := range globs {
		if got := GlobMatch(g[0], g[1]); got != ref.Glob[i] {
			t.Errorf("GlobMatch(%q, %q) = %v, TS %v", g[0], g[1], got, ref.Glob[i])
		}
	}
	for i, c := range matches {
		if got := toFilter(c[0]).Matches(toEvent(c[1])); got != ref.Matches[i] {
			t.Errorf("Matches(%v, %v) = %v, TS %v", c[0], c[1], got, ref.Matches[i])
		}
	}
	for i, c := range fits {
		if got := Fits(c[0].(string), c[1].(string), toFilter(c[2]), toEvent(c[3])); got != ref.Fits[i] {
			t.Errorf("Fits(%v) = %v, TS %v", c, got, ref.Fits[i])
		}
	}
	for i, c := range sanitize {
		b, _ := json.Marshal(c)
		v, _ := jsjson.Parse(b)
		if got := Sanitize(v).JSON(); got != ref.Sanitize[i] {
			t.Errorf("Sanitize(%s) = %s, TS %s", b, got, ref.Sanitize[i])
		}
	}
	for i, u := range cases["url"].([]string) {
		if got := SubjectForURL(u); got != ref.URL[i] && !(got == "" && ref.URL[i] == "") {
			t.Errorf("SubjectForURL(%q) = %q, TS %q", u, got, ref.URL[i])
		}
	}
	for i, f := range failure {
		if got := IsFailure(Event{Source: f["source"].(string), Type: f["type"].(string), Summary: f["summary"].(string)}); got != ref.Failure[i] {
			t.Errorf("IsFailure(%v) = %v, TS %v", f, got, ref.Failure[i])
		}
	}
}
