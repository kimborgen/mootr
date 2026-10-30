package config

import "testing"

func TestWatchLinearDefaultsAndOverrides(t *testing.T) {
	def := WatchLinear{Seconds: 60, Issue: "get_issue", Comments: "list_comments", TeamIssues: "list_issues"}
	for _, in := range []string{``, `{}`, `not json`, `{"watch":{}}`, `{"watch":{"linearSeconds":"5","linearTools":{"issue":7,"comments":null}}}`} {
		if got := parseWatchLinear([]byte(in)); got != def {
			t.Errorf("%q: %+v, want the defaults", in, got)
		}
	}
	got := parseWatchLinear([]byte(`{"watch":{"linearSeconds":0,"linearTools":{"issue":"issue_get","teamIssues":"team_list"}}}`))
	want := WatchLinear{Seconds: 0, Issue: "issue_get", Comments: "list_comments", TeamIssues: "team_list"}
	if got != want {
		t.Errorf("%+v, want %+v", got, want)
	}
	s, err := ParseSettings([]byte(`{"watch":{"linearSeconds":9}}`), "m")
	if err != nil || s.WatchLinear.Seconds != 9 {
		t.Errorf("%v %+v", err, s.WatchLinear)
	}
}
