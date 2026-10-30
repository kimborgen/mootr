package ghpoll

import "encoding/json"

type userBody struct {
	Login string `json:"login"`
}

type issueBody struct {
	Title       *string          `json:"title"`
	HTMLURL     *string          `json:"html_url"`
	State       *string          `json:"state"`
	UpdatedAt   *string          `json:"updated_at"`
	User        *userBody        `json:"user"`
	PullRequest *json.RawMessage `json:"pull_request"`
}

func (b issueBody) isPR() bool {
	if b.PullRequest == nil {
		return false
	}
	s := string(*b.PullRequest)
	return s != "null" && s != "false" && s != "0" && s != `""`
}

type pullBody struct {
	Title   *string   `json:"title"`
	HTMLURL *string   `json:"html_url"`
	Draft   bool      `json:"draft"`
	Merged  bool      `json:"merged"`
	State   *string   `json:"state"`
	User    *userBody `json:"user"`
	Head    *struct {
		SHA *string `json:"sha"`
	} `json:"head"`
	Base *struct {
		Ref *string `json:"ref"`
	} `json:"base"`
}

type checkRunsBody struct {
	CheckRuns []Run `json:"check_runs"`
}

type statusBody struct {
	Statuses []CommitStatus `json:"statuses"`
}

type reviewBody struct {
	ID          json.Number `json:"id"`
	State       string      `json:"state"`
	SubmittedAt *string     `json:"submitted_at"`
	User        *userBody   `json:"user"`
}

type commentBody struct {
	ID        json.Number `json:"id"`
	Body      string      `json:"body"`
	CreatedAt *string     `json:"created_at"`
	UpdatedAt *string     `json:"updated_at"`
	User      *userBody   `json:"user"`
}

func login(u *userBody) *string {
	if u == nil {
		return nil
	}
	return &u.Login
}
