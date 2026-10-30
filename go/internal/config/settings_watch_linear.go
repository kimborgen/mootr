package config

import "encoding/json"

// WatchLinear is settings.watch.linearSeconds and watch.linearTools (src/settings.ts), the Linear poller's interval and the
// names of the MCP tools it calls.
type WatchLinear struct {
	// Seconds is the interval between polls, 60 unless the file holds a number; 0 or less turns the poller off.
	Seconds float64
	// Tools are the tool names: get_issue, list_comments and list_issues unless the file names a string for one.
	Issue, Comments, TeamIssues string
}

// parseWatchLinear reads watch.linearSeconds and watch.linearTools over their defaults. A tool name that is not a string
// keeps its default (TS would call a tool named by whatever the file holds).
func parseWatchLinear(data []byte) WatchLinear {
	w := WatchLinear{Seconds: 60, Issue: "get_issue", Comments: "list_comments", TeamIssues: "list_issues"}
	var doc struct {
		Watch struct {
			LinearSeconds any `json:"linearSeconds"`
			LinearTools   struct {
				Issue      any `json:"issue"`
				Comments   any `json:"comments"`
				TeamIssues any `json:"teamIssues"`
			} `json:"linearTools"`
		} `json:"watch"`
	}
	if len(data) == 0 || json.Unmarshal(data, &doc) != nil {
		return w
	}
	if n, ok := doc.Watch.LinearSeconds.(float64); ok {
		w.Seconds = n
	}
	for _, t := range []struct {
		v   any
		out *string
	}{{doc.Watch.LinearTools.Issue, &w.Issue}, {doc.Watch.LinearTools.Comments, &w.Comments}, {doc.Watch.LinearTools.TeamIssues, &w.TeamIssues}} {
		if s, ok := t.v.(string); ok {
			*t.out = s
		}
	}
	return w
}
