package ghpoll

import (
	"context"
	"encoding/json"
)

// What the dashboard shows per subject (src/sources/github.ts stateFor, S-65). The field order is TS's.
type (
	// NoState is a subject nothing has polled.
	NoState struct {
		UpdatedAt *string `json:"updated_at"`
	}
	// PRView is a pull request's state, draft, checks, review, head, base, title and url.
	PRView struct {
		State     *string `json:"state"`
		Draft     bool    `json:"draft"`
		Checks    string  `json:"checks"`
		Review    string  `json:"review"`
		Head      *string `json:"head"`
		Base      *string `json:"base"`
		Title     *string `json:"title"`
		URL       *string `json:"url"`
		UpdatedAt string  `json:"updated_at"`
	}
	// IssueView is an issue's state, title and url.
	IssueView struct {
		State     *string `json:"state"`
		Title     *string `json:"title"`
		URL       *string `json:"url"`
		UpdatedAt string  `json:"updated_at"`
	}
	// OtherView is any other subject with a row (a repository).
	OtherView struct {
		State     *string `json:"state"`
		UpdatedAt string  `json:"updated_at"`
	}
)

// StateFor is the poller's last view of each subject.
func StateFor(ctx context.Context, st Store, subjects []string) (map[string]any, error) {
	out := map[string]any{}
	for _, subject := range subjects {
		row, ok, err := st.Row(ctx, subject)
		if err != nil {
			return nil, err
		}
		if !ok {
			out[subject] = NoState{}
			continue
		}
		var s Snapshot
		_ = json.Unmarshal([]byte(row.State), &s)
		switch s.Type {
		case "issue":
			out[subject] = IssueView{s.State, s.Title, s.URL, row.UpdatedAt}
		case "pr":
			checks, review := s.Checks, s.Review
			if checks == "" {
				checks = "none"
			}
			if review == "" {
				review = "none"
			}
			out[subject] = PRView{s.State, s.Draft != nil && *s.Draft, checks, review, s.Head, s.Base, s.Title, s.URL, row.UpdatedAt}
		default:
			out[subject] = OtherView{s.State, row.UpdatedAt}
		}
	}
	return out, nil
}
