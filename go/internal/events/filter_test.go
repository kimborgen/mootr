package events

import (
	"testing"

	"stam/internal/jsjson"
)

func TestGlobMatch(t *testing.T) {
	for _, tc := range []struct {
		pattern, value string
		want           bool
	}{
		{"github:example/*", "github:example/stam", true},
		{"github:example/*", "github:example/stam#12", true},
		{"github:example/*", "github:other/stam2", false},
		{"github:example/stam#12", "github:example/stam#12", true},
		{"github:example/stam#12", "github:example/stam#13", false},
		{"pull_request.*", "pull_request.synchronize", true},
		{"pull_request.*", "push", false},
		{"*", "anything:at/all", true},
		// `*` stays within one segment.
		{"github:*", "github:o/r", false},
		{"a*c", "abc", true},
		{"a*c", "a/c", false},
		{"a*c", "ab\nc", true},
		// Regex characters in a pattern are literal.
		{"a.c", "abc", false},
		{"a(b)", "a(b)", true},
		{"github:o/r#1*", "github:o/r#12", true},
		{"", "", true},
		{"", "x", false},
	} {
		if got := GlobMatch(tc.pattern, tc.value); got != tc.want {
			t.Errorf("GlobMatch(%q, %q) = %v, want %v", tc.pattern, tc.value, got, tc.want)
		}
	}
}

func TestMatches(t *testing.T) {
	ev := Event{Source: "github", Type: "pull_request.opened", Subjects: []string{"github:o/r#1"}, Actor: "octocat", HasActor: true}
	for _, tc := range []struct {
		name string
		f    Filter
		ev   Event
		want bool
	}{
		{"empty", Filter{}, ev, true},
		{"source", Filter{Source: "linear"}, ev, false},
		{"types glob", Filter{Types: []string{"pull_request.*"}}, ev, true},
		{"types other", Filter{Types: []string{"push", "issues"}}, ev, false},
		{"plain issues fits issues.opened", Filter{Types: []string{"issues"}}, Event{Source: "github", Type: "issues.opened"}, true},
		{"plain issues is no other widening", Filter{Types: []string{"pull_request"}}, ev, false},
		{"subjects any", Filter{Subjects: []string{"github:x/*", "github:o/*"}}, ev, true},
		{"subjects none", Filter{Subjects: []string{"github:x/*"}}, ev, false},
		{"subjects on an event with none", Filter{Subjects: []string{"*"}}, Event{Source: "github", Type: "x"}, false},
		{"actors", Filter{Actors: []string{"octo*"}}, ev, true},
		{"actors, event with no actor", Filter{Actors: []string{"octo*"}}, Event{}, false},
		{"actors star, event with no actor", Filter{Actors: []string{"*"}}, Event{}, true},
		{"exclude", Filter{ExcludeActors: []string{"octocat"}}, ev, false},
		{"exclude, event with no actor", Filter{ExcludeActors: []string{"*"}}, Event{}, true},
	} {
		if got := tc.f.Matches(tc.ev); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestFits(t *testing.T) {
	payload := func(at, agent string) jsjson.Value {
		o := jsjson.NewObject()
		if at != "" {
			o.Set("at", at)
		}
		if agent != "" {
			o.Set("review_agent", agent)
		}
		return o
	}
	f := Filter{Since: "2026-10-14T16:41:00Z", EndsOn: []string{"pull_request.merged"}}
	for _, tc := range []struct {
		name string
		kind string
		ev   Event
		want bool
	}{
		{"older than the watch", "agent", Event{Type: "comment.created", Payload: payload("2026-10-14T16:22:00Z", "")}, false},
		{"newer", "agent", Event{Type: "comment.created", Payload: payload("2026-10-14T16:44:00Z", "")}, true},
		{"no stamp", "agent", Event{Type: "comment.created"}, true},
		{"an ending event is always delivered", "agent", Event{Type: "pull_request.merged", Payload: payload("2026-10-14T16:20:00Z", "")}, true},
		{"the watcher's own review", "agent", Event{Type: "comment.created", Payload: payload("2026-10-14T16:44:00Z", "a1")}, false},
		{"another agent's review", "agent", Event{Type: "comment.created", Payload: payload("2026-10-14T16:44:00Z", "a2")}, true},
		{"an ITSA hears the review of the agent it names", "itsa", Event{Type: "comment.created", Payload: payload("2026-10-14T16:44:00Z", "a1")}, true},
	} {
		if got := Fits(tc.kind, "a1", f, tc.ev); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSanitize(t *testing.T) {
	parse := func(s string) jsjson.Value {
		v, err := jsjson.Parse([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, tc := range []struct {
		in, want string
	}{
		{`null`, `{}`},
		{`{}`, `{}`},
		{`{"source":" github "}`, `{"source":"github"}`},
		{`{"source":"  "}`, `{}`},
		{`{"subjects":"github:o/r"}`, `{"subjects":["github:o/r"]}`},
		{`{"subjects":["a","","b"]}`, `{"subjects":["a","b"]}`},
		{`{"subjects":[]}`, `{}`},
		{`{"types":7}`, `{"types":["7"]}`},
		{`{"actors":["a"],"exclude_actors":["b"],"ends_on":["x"],"since":" 2026-01-01 "}`, `{"actors":["a"],"exclude_actors":["b"],"ends_on":["x"],"since":"2026-01-01"}`},
		{`{"unknown":1,"types":["<a&b>"]}`, `{"types":["<a&b>"]}`},
		{`"text"`, `{}`},
	} {
		if got := Sanitize(parse(tc.in)).JSON(); got != tc.want {
			t.Errorf("Sanitize(%s) = %s, want %s", tc.in, got, tc.want)
		}
	}
}

func TestSubjectForURL(t *testing.T) {
	for url, want := range map[string]string{
		"https://github.com/example/stam/pull/12":           "github:example/stam#12",
		"https://github.com/example/stam/issues/7":          "github:example/stam#7",
		"http://github.com/example/stam/pull/12/files#x":    "github:example/stam#12",
		"https://linear.app/octocat/issue/TEAM-123/a-title": "linear:TEAM-123",
		"https://github.com/example/stam":                   "",
		"https://github.com/example/stam/pull/x":            "",
		"https://example.com/x":                             "",
		"":                                                  "",
		"  https://github.com/o/r/pull/3  ":                 "github:o/r#3",
	} {
		if got := SubjectForURL(url); got != want {
			t.Errorf("SubjectForURL(%q) = %q, want %q", url, got, want)
		}
	}
}

func TestLineAndFailure(t *testing.T) {
	ev := Event{Source: "github", Type: "checks.completed", Summary: "checks failed", Actor: "ci", HasActor: true, URL: "https://x/1"}
	if got, want := Line(ev), "- [github] checks.completed: checks failed — by ci · https://x/1"; got != want {
		t.Errorf("Line = %q, want %q", got, want)
	}
	if got, want := Line(Event{Source: "s", Type: "t", Summary: "m"}), "- [s] t: m"; got != want {
		t.Errorf("Line = %q, want %q", got, want)
	}
	for _, tc := range []struct {
		ev   Event
		want bool
	}{
		{ev, true},
		{Event{Source: "github", Type: "checks.completed", Summary: "checks passed"}, false},
		{Event{Source: "github", Type: "review.submitted", Summary: "x (changes requested)"}, true},
		{Event{Source: "github", Type: "comment.created", Summary: "Deploy of abc stopped: red"}, true},
		{Event{Source: "linear", Type: "checks.completed", Summary: "checks failed"}, false},
	} {
		if got := IsFailure(tc.ev); got != tc.want {
			t.Errorf("IsFailure(%+v) = %v", tc.ev, got)
		}
	}
}

func TestDescribeAndDedupeKey(t *testing.T) {
	f := Filter{Source: "github", Subjects: []string{"b", "a"}, ExcludeActors: []string{"bot"}}
	if got, want := f.Describe(), "source github; subjects b, a; not by bot"; got != want {
		t.Errorf("Describe = %q", got)
	}
	if got := (Filter{}).Describe(); got != "any" {
		t.Errorf("Describe of nothing = %q", got)
	}
	g := Filter{Source: "github", Subjects: []string{"a", "b"}, ExcludeActors: []string{"bot"}, Since: "2026-01-01"}
	if dedupeKey(f) != dedupeKey(g) {
		t.Errorf("a re-ordered list or a moved since changed the key: %s / %s", dedupeKey(f), dedupeKey(g))
	}
	if dedupeKey(f) == dedupeKey(Filter{Source: "github", Subjects: []string{"a"}}) {
		t.Error("different filters share a key")
	}
	if got := laterSince(Filter{Since: "2026-02-01T00:00:00Z"}, Filter{Since: "2026-01-01T00:00:00Z"}).Since; got != "2026-02-01T00:00:00Z" {
		t.Errorf("an older since replaced the newer: %s", got)
	}
	if got := laterSince(Filter{Since: "2026-01-01T00:00:00Z"}, Filter{Since: "2026-02-01T00:00:00Z"}).Since; got != "2026-02-01T00:00:00Z" {
		t.Errorf("a newer since was not taken: %s", got)
	}
	if got := laterSince(Filter{Since: "2026-01-01T00:00:00Z"}, Filter{}).Since; got != "2026-01-01T00:00:00Z" {
		t.Errorf("no new since changed the stored one: %s", got)
	}
}
