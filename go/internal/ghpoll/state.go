package ghpoll

import (
	"encoding/json"
	"sort"
	"strings"
)

// Run is the part of a check run the snapshot keeps (state.headRuns).
type Run struct {
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	Conclusion  *string `json:"conclusion"`
	CompletedAt *string `json:"completed_at"`
}

// CommitStatus is the part of a commit status the snapshot keeps (state.headStatuses).
type CommitStatus struct {
	Context     string  `json:"context"`
	State       string  `json:"state"`
	Description *string `json:"description"`
	UpdatedAt   *string `json:"updated_at"`
	CreatedAt   *string `json:"created_at"`
}

// LastReview is the newest approving or change-requesting review.
type LastReview struct {
	State string  `json:"state"`
	User  *string `json:"user"`
}

// Snapshot is what a poll last saw of a subject: the JSON TS writes to watch_state.state, field for field. A TS reader
// (src/diff.ts) and the Go diff route read it, so the names stay TS's.
type Snapshot struct {
	Type   string `json:"type,omitempty"`
	Absent bool   `json:"absent,omitempty"`
	// LastEventID is a repository's newest event id seen.
	LastEventID *int64  `json:"lastEventId,omitempty"`
	Title       *string `json:"title,omitempty"`
	URL         *string `json:"url,omitempty"`
	State       *string `json:"state"`
	UpdatedAt   *string `json:"updatedAt,omitempty"`
	Actor       *string `json:"actor,omitempty"`
	Draft       *bool   `json:"draft,omitempty"`
	Head        *string `json:"head,omitempty"`
	Base        *string `json:"base,omitempty"`

	Checks       string         `json:"checks,omitempty"`
	Failing      []string       `json:"failing,omitempty"`
	ChecksHead   *string        `json:"checksHead,omitempty"`
	ChecksAt     *string        `json:"checksAt,omitempty"`
	HeadRuns     []Run          `json:"headRuns,omitempty"`
	HeadStatuses []CommitStatus `json:"headStatuses,omitempty"`
	// StatusesHead is the head whose status list the snapshot knows: absent in a snapshot from before the field (it counts
	// as known), null when the last fetch of a new head's statuses failed, else the head.
	StatusesHead json.RawMessage `json:"statusesHead,omitempty"`

	ReviewCount   int         `json:"reviewCount,omitempty"`
	Review        string      `json:"review,omitempty"`
	LastReview    *LastReview `json:"lastReview"`
	CommentsSince *string     `json:"commentsSince,omitempty"`
}

func str(s string) *string { return &s }

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ChecksState is the combined check state for a head from its check runs and commit statuses: pending until every one is
// done, then success, or failure with the names that failed; none when the head has neither.
func ChecksState(runs []Run, statuses []CommitStatus) (state string, failing []string) {
	if len(runs) == 0 && len(statuses) == 0 {
		return "none", []string{}
	}
	for _, r := range runs {
		if r.Status != "completed" {
			return "pending", []string{}
		}
	}
	for _, s := range statuses {
		if s.State == "pending" {
			return "pending", []string{}
		}
	}
	failing = []string{}
	for _, r := range runs {
		switch deref(r.Conclusion) {
		case "success", "neutral", "skipped":
		default:
			if r.Name != "" {
				failing = append(failing, r.Name)
			}
		}
	}
	for _, s := range statuses {
		if s.State != "success" && s.Context != "" {
			failing = append(failing, s.Context)
		}
	}
	if len(failing) > 0 {
		return "failure", failing
	}
	return "success", failing
}

// ReviewContext is the commit status context scripts/pr-review.mjs posts a verdict under; our gates post stam/gates.
const ReviewContext = "stam/review"

// ReviewAgentOfComment is the stam agent that posted a review comment or status, from its "Review (AGENT): " text, or ""
// when the text is not one. Every agent posts as one GitHub account, so this text tells a watcher's own review from
// someone else's.
func ReviewAgentOfComment(text string) string {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "Review (") {
		return ""
	}
	rest := t[len("Review ("):]
	i := strings.Index(rest, ")")
	if i < 1 || !strings.HasPrefix(rest[i:], "):") || strings.Contains(rest[:i], ")") {
		return ""
	}
	return rest[:i]
}

// NewestReview is the newest stam/review status of a head's statuses, or nil.
func NewestReview(statuses []CommitStatus) *CommitStatus {
	var all []CommitStatus
	for _, s := range statuses {
		if s.Context == ReviewContext {
			all = append(all, s)
		}
	}
	if len(all) == 0 {
		return nil
	}
	at := func(s CommitStatus) string {
		if s.UpdatedAt != nil {
			return *s.UpdatedAt
		}
		return deref(s.CreatedAt)
	}
	sort.SliceStable(all, func(i, j int) bool { return at(all[i]) > at(all[j]) })
	return &all[0]
}

// ReviewVerdict is the verdict the newest stam/review status on the head carries: approve for a success, changes for a
// failure or error, "" for a pending or missing one. It travels in the checks.completed payload.
func ReviewVerdict(statuses []CommitStatus) string {
	n := NewestReview(statuses)
	switch {
	case n == nil:
		return ""
	case n.State == "success":
		return "approve"
	case n.State == "failure" || n.State == "error":
		return "changes"
	}
	return ""
}

// ownReviewAgent is the stam agent whose own stam/review status alone made this checks.completed, or "" when other
// checks changed too (real news, delivered to everyone). A gate failure anyone has to see is never the watcher's own.
func ownReviewAgent(s *Snapshot) string {
	if s.ChecksAt == nil || *s.ChecksAt == "" {
		return ""
	}
	var newest *CommitStatus
	for i := range s.HeadStatuses {
		x := &s.HeadStatuses[i]
		at := x.UpdatedAt
		if at == nil {
			at = x.CreatedAt
		}
		if at != nil && *at == *s.ChecksAt {
			newest = x
			break
		}
	}
	if newest == nil || newest.Context != ReviewContext {
		return ""
	}
	agent := ReviewAgentOfComment(deref(newest.Description))
	if agent == "" {
		return ""
	}
	if s.Checks == "failure" {
		for _, f := range s.Failing {
			if f != ReviewContext {
				return ""
			}
		}
	}
	return agent
}

func lastReviewState(reviews []reviewBody) string {
	out := "none"
	for _, r := range reviews {
		switch r.State {
		case "APPROVED":
			out = "approved"
		case "CHANGES_REQUESTED":
			out = "changes_requested"
		}
	}
	return out
}
