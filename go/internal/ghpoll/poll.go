package ghpoll

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"stam/internal/jsjson"
)

// Event is one change a poll found, as the events service takes it.
type Event struct {
	Type, Subject string
	Subjects      []string
	Actor, URL    *string
	Summary       string
	DedupeKey     string
	Payload       jsjson.Value
}

// PollResult is one subject's poll: the events its changes make, the new snapshot and ETags, and the rate limit seen.
type PollResult struct {
	Events    []Event
	State     Snapshot
	Etags     map[string]string
	Remaining int64 // -1 when no reply said
	ResetAt   int64 // -1 when no reply said
}

type tracker struct{ remaining, resetAt int64 }

func newTracker() *tracker { return &tracker{-1, -1} }

func (t *tracker) track(r Reply) {
	if r.Remaining >= 0 && (t.remaining < 0 || r.Remaining < t.remaining) {
		t.remaining = r.Remaining
	}
	if r.ResetAt >= 0 && r.ResetAt > t.resetAt {
		t.resetAt = r.ResetAt
	}
}

// check turns a reply that fails the whole poll into an error: a 200 or 304, or a status the call allows (a missing PR, a
// head GitHub has no checks for), is no failure; anything else is, the rate limit (a 403 or 429) with a backoff. A poll that
// fails stores nothing, so a call that answers 500 can't leave a snapshot that skipped what it would have shown.
func (t *tracker) check(r Reply, path string, allow ...int) error {
	if r.Status == 200 || r.Status == 304 {
		return nil
	}
	for _, a := range allow {
		if r.Status == a {
			return nil
		}
	}
	e := &StatusError{Status: r.Status, Path: path, ResetAt: r.ResetAt}
	e.Global = r.Status == 429 || (r.Status == 403 && (r.Remaining == 0 || r.RetryAfter > 0 || secondaryLimit(r.Body)))
	if r.Status == 403 && r.Remaining != 0 && r.RetryAfter == 0 && secondaryLimit(r.Body) {
		// A secondary limit: the reset header is the primary budget's, so the default minute applies.
		e.ResetAt = -1
	}
	e.RetryAfter = r.RetryAfter
	return e
}

// secondaryLimit is whether a 403's body names a rate limit (GitHub's secondary limit comes with budget left and may carry no
// retry-after).
func secondaryLimit(body []byte) bool {
	return bytes.Contains(bytes.ToLower(body), []byte("rate limit"))
}

// Poll polls one subject: prev nil is the first poll, which records the snapshot and emits nothing, so a long-standing
// open PR doesn't flood every subscriber when it is first watched. A poll that returns an error changed nothing: the
// caller keeps prev and prevEtags.
func (p *Poller) Poll(ctx context.Context, subject string, prev *Snapshot, prevEtags map[string]string, token string) (PollResult, error) {
	s, ok := ParseSubject(subject)
	if !ok {
		var st Snapshot
		if prev != nil {
			st = *prev
		}
		return PollResult{State: st, Etags: prevEtags, Remaining: -1, ResetAt: -1}, nil
	}
	if s.IsRepo {
		return p.pollRepo(ctx, s, prev, prevEtags, token)
	}
	return p.pollNumber(ctx, s, prev, prevEtags, token)
}

func copyEtags(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (p *Poller) pollNumber(ctx context.Context, s Subject, prev *Snapshot, prevEtags map[string]string, token string) (PollResult, error) {
	first := prev == nil
	var state Snapshot
	if prev != nil {
		state = *prev
	}
	etags := copyEtags(prevEtags)
	var events []Event
	tr := newTracker()
	base := fmt.Sprintf("/repos/%s/%s", s.Owner, s.Repo)
	n := s.Number

	emit := func(typ, summary string, payload jsjson.Value, dedupe string) {
		if dedupe == "" {
			dedupe = typ + ":" + s.Key + ":" + deref(state.UpdatedAt)
		}
		events = append(events, Event{Type: typ, Subject: s.Key, Subjects: []string{s.Key, s.RepoKey}, Actor: state.Actor, URL: state.URL, Summary: summary, DedupeKey: dedupe, Payload: payload})
	}
	emitBy := func(who, typ, summary string, payload jsjson.Value, dedupe string) {
		emit(typ, summary, payload, dedupe)
		events[len(events)-1].Actor = &who
	}
	get := func(path, key string, allow ...int) (Reply, error) {
		r, err := p.get(ctx, path, token, etags[key])
		if err != nil {
			return r, err
		}
		tr.track(r)
		return r, tr.check(r, path, allow...)
	}

	// The issue view tells a pull request from an issue, and carries its title, state and url.
	ipath := fmt.Sprintf("%s/issues/%d", base, n)
	issue, err := get(ipath, fmt.Sprintf("issues/%d", n), 404)
	if err != nil {
		return PollResult{}, err
	}
	switch issue.Status {
	case 200:
		var b issueBody
		if err := decode(issue, ipath, &b); err != nil {
			return PollResult{}, err
		}
		etags[fmt.Sprintf("issues/%d", n)] = issue.ETag
		state.Absent = false
		state.Title, state.URL, state.State, state.UpdatedAt = b.Title, b.HTMLURL, b.State, b.UpdatedAt
		if l := login(b.User); l != nil {
			state.Actor = l
		}
		state.Type = "issue"
		if b.isPR() {
			state.Type = "pr"
		}
	case 404:
		state.Absent = true
		state.State = nil
	case 304:
	}
	if first && issue.Status == 304 {
		return PollResult{}, &StatusError{Status: 304, Path: ipath}
	}

	if !state.Absent && state.Type == "pr" {
		ppath := fmt.Sprintf("%s/pulls/%d", base, n)
		pull, err := get(ppath, fmt.Sprintf("pulls/%d", n))
		if err != nil {
			return PollResult{}, err
		}
		if pull.Status == 200 {
			var b pullBody
			if err := decode(pull, ppath, &b); err != nil {
				return PollResult{}, err
			}
			etags[fmt.Sprintf("pulls/%d", n)] = pull.ETag
			if b.Title != nil {
				state.Title = b.Title
			}
			if b.HTMLURL != nil {
				state.URL = b.HTMLURL
			}
			state.Draft = &b.Draft
			state.Head, state.Base = nil, nil
			if b.Head != nil {
				state.Head = b.Head.SHA
			}
			if b.Base != nil {
				state.Base = b.Base.Ref
			}
			switch {
			case b.Merged:
				state.State = str("merged")
			case b.State != nil:
				state.State = b.State
			}
			if l := login(b.User); l != nil {
				state.Actor = l
			}
		}
		// The head's checks: check runs and commit statuses, both done before it counts.
		if state.Head != nil && *state.Head != "" {
			head := *state.Head
			rpath := fmt.Sprintf("%s/commits/%s/check-runs", base, head)
			spath := fmt.Sprintf("%s/commits/%s/status", base, head)
			runs, err := get(rpath, "commits/"+head+"/check-runs", 404)
			if err != nil {
				return PollResult{}, err
			}
			status, err := get(spath, "commits/"+head+"/status", 404)
			if err != nil {
				return PollResult{}, err
			}
			sameHead := state.ChecksHead != nil && *state.ChecksHead == head
			if runs.Status == 200 || status.Status == 200 || !sameHead {
				var runsBody []Run
				var stsBody []CommitStatus
				// A 304 means that side is unchanged: keep what the snapshot last saw of it, not an empty list. On a new head the
				// old lists are the old head's: a failed fetch gives nothing, never a verdict (S-1917) or a pass on a head nobody
				// reviewed.
				if runs.Status == 200 {
					var b checkRunsBody
					if err := decode(runs, rpath, &b); err != nil {
						return PollResult{}, err
					}
					for _, r := range b.CheckRuns {
						runsBody = append(runsBody, r)
					}
					etags["commits/"+head+"/check-runs"] = runs.ETag
				} else if sameHead {
					runsBody = state.HeadRuns
				}
				if status.Status == 200 {
					var b statusBody
					if err := decode(status, spath, &b); err != nil {
						return PollResult{}, err
					}
					stsBody = b.Statuses
					etags["commits/"+head+"/status"] = status.ETag
				} else if sameHead {
					stsBody = state.HeadStatuses
				}
				state.HeadRuns, state.HeadStatuses = runsBody, stsBody
				// The status list is known when this poll read it, or an earlier poll of this head did (a snapshot from before
				// this field counts as known). On a new head whose status fetch failed it is not: the run list alone is no pass
				// (S-1918).
				known := status.Status == 200
				if !known && sameHead {
					if len(state.StatusesHead) == 0 {
						known = true
					} else {
						var sh *string
						_ = json.Unmarshal(state.StatusesHead, &sh)
						known = sh != nil && *sh == head
					}
				}
				if known {
					state.StatusesHead, _ = json.Marshal(head)
				} else {
					state.StatusesHead = json.RawMessage("null")
				}
				c, failing := ChecksState(runsBody, stsBody)
				if !known && c == "success" {
					c = "pending"
				}
				state.Checks, state.Failing = c, failing
				state.ChecksHead = str(head)
				// The latest check run to finish or status to post: a re-run that fails again has a later one.
				var times []string
				for _, r := range runsBody {
					if r.CompletedAt != nil && *r.CompletedAt != "" {
						times = append(times, *r.CompletedAt)
					}
				}
				for _, x := range stsBody {
					t := x.UpdatedAt
					if t == nil {
						t = x.CreatedAt
					}
					if t != nil && *t != "" {
						times = append(times, *t)
					}
				}
				state.ChecksAt = nil
				if len(times) > 0 {
					sort.Strings(times)
					state.ChecksAt = str(times[len(times)-1])
				}
			}
		}
		// Reviews: the list grows; anything past the snapshot's count is new.
		vpath := fmt.Sprintf("%s/pulls/%d/reviews", base, n)
		reviews, err := get(vpath, fmt.Sprintf("pulls/%d/reviews", n))
		if err != nil {
			return PollResult{}, err
		}
		if reviews.Status == 200 {
			var list []reviewBody
			if err := decode(reviews, vpath, &list); err != nil {
				return PollResult{}, err
			}
			etags[fmt.Sprintf("pulls/%d/reviews", n)] = reviews.ETag
			sort.SliceStable(list, func(i, j int) bool { return deref(list[i].SubmittedAt) < deref(list[j].SubmittedAt) })
			seen := 0
			if prev != nil {
				seen = prev.ReviewCount
			}
			if !first && seen < len(list) {
				for _, r := range list[seen:] {
					who := "someone"
					if r.User != nil {
						who = r.User.Login
					}
					what := strings.ReplaceAll(strings.ToLower(r.State), "_", " ")
					var at jsjson.Value
					if r.SubmittedAt != nil {
						at = *r.SubmittedAt
					}
					emitBy(who, "review.submitted", fmt.Sprintf("PR #%d reviewed (%s) by %s", n, what, who), jsjson.NewObject("at", at), "review.submitted:"+s.Key+":"+r.ID.String())
				}
			}
			state.ReviewCount = len(list)
			state.Review = lastReviewState(list)
			state.LastReview = nil
			for i := len(list) - 1; i >= 0; i-- {
				if r := list[i]; r.State == "APPROVED" || r.State == "CHANGES_REQUESTED" {
					state.LastReview = &LastReview{State: strings.ToLower(r.State), User: login(r.User)}
					break
				}
			}
		}
	}

	// Comments, on a PR and on an issue: since limits the fetch to new ones.
	cpath := fmt.Sprintf("%s/issues/%d/comments", base, n)
	if prev != nil && prev.CommentsSince != nil && *prev.CommentsSince != "" {
		cpath += "?since=" + url.QueryEscape(*prev.CommentsSince)
	}
	comments, err := get(cpath, fmt.Sprintf("issues/%d/comments", n))
	if err != nil {
		return PollResult{}, err
	}
	if comments.Status == 200 {
		var list []commentBody
		if err := decode(comments, cpath, &list); err != nil {
			return PollResult{}, err
		}
		etags[fmt.Sprintf("issues/%d/comments", n)] = comments.ETag
		if !first {
			for _, c := range list {
				who := "someone"
				if c.User != nil {
					who = c.User.Login
				}
				kind := "Issue"
				if state.Type == "pr" {
					kind = "PR"
				}
				var at, ra jsjson.Value
				switch {
				case c.UpdatedAt != nil:
					at = *c.UpdatedAt
				case c.CreatedAt != nil:
					at = *c.CreatedAt
				}
				if a := ReviewAgentOfComment(c.Body); a != "" {
					ra = a
				}
				emitBy(who, "comment.created", fmt.Sprintf("%s #%d comment by %s: %s", kind, n, who, firstLine(c.Body)), jsjson.NewObject("at", at, "review_agent", ra), "comment.created:"+s.Key+":"+c.ID.String())
			}
		}
		newest := ""
		for _, c := range list {
			t := ""
			switch {
			case c.UpdatedAt != nil:
				t = *c.UpdatedAt
			case c.CreatedAt != nil:
				t = *c.CreatedAt
			}
			if t > newest {
				newest = t
			}
		}
		if newest != "" {
			state.CommentsSince = &newest
		}
	}

	if !first && !state.Absent {
		diffNumber(&state, prev, s, emit)
	}
	return PollResult{Events: events, State: state, Etags: etags, Remaining: tr.remaining, ResetAt: tr.resetAt}, nil
}

// firstLine is the first line of a comment, trimmed, at most 200 characters.
func firstLine(body string) string {
	l, _, _ := strings.Cut(body, "\n")
	l = strings.TrimSpace(l)
	r := []rune(l)
	// JS slices UTF-16 units; a comment with characters past the BMP can differ by a character at the cut.
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}

func atOf(state *Snapshot) jsjson.Value {
	if state.UpdatedAt == nil {
		return nil
	}
	return *state.UpdatedAt
}

// diffNumber is the one event per change between the last snapshot and this one.
func diffNumber(state, prev *Snapshot, s Subject, emit func(typ, summary string, payload jsjson.Value, dedupe string)) {
	n := s.Number
	title := deref(state.Title)
	// The change time stamped on each event, so a watch that began later drops it.
	at := atOf(state)
	cur, was := deref(state.State), deref(prev.State)
	if state.Type == "issue" {
		if deref(prev.State) != cur || (prev.State == nil) != (state.State == nil) {
			switch cur {
			case "closed":
				emit("issue.closed", fmt.Sprintf("Issue #%d closed: %s", n, title), jsjson.NewObject("at", at), "")
			case "open":
				if was != "" {
					emit("issue.reopened", fmt.Sprintf("Issue #%d reopened: %s", n, title), jsjson.NewObject("at", at), "")
				} else {
					emit("issue.opened", fmt.Sprintf("Issue #%d opened: %s", n, title), jsjson.NewObject("at", at), "")
				}
			}
		}
		return
	}
	// A pull request. opened covers a watched number that appears after an absent first poll.
	if prev.Absent || prev.Type == "" {
		if cur == "open" {
			emit("pull_request.opened", fmt.Sprintf("PR #%d opened: %s", n, title), jsjson.NewObject("at", at), "")
		}
	} else if was != cur || (prev.State == nil) != (state.State == nil) {
		switch cur {
		case "merged":
			emit("pull_request.merged", fmt.Sprintf("PR #%d merged: %s", n, title), jsjson.NewObject("at", at), "")
		case "closed":
			emit("pull_request.closed", fmt.Sprintf("PR #%d closed: %s", n, title), jsjson.NewObject("at", at), "")
		case "open":
			emit("pull_request.reopened", fmt.Sprintf("PR #%d reopened: %s", n, title), jsjson.NewObject("at", at), "")
		}
	}
	if prev.Type == "pr" && state.Draft != nil && (prev.Draft == nil || *prev.Draft != *state.Draft) {
		if *state.Draft {
			emit("pull_request.converted_to_draft", fmt.Sprintf("PR #%d converted to draft", n), jsjson.NewObject("at", at), "")
		} else {
			emit("pull_request.ready_for_review", fmt.Sprintf("PR #%d ready for review", n), jsjson.NewObject("at", at), "")
		}
	}
	if deref(prev.Head) != "" && deref(state.Head) != "" && *prev.Head != *state.Head {
		h := *state.Head
		short := h
		if len(short) > 7 {
			short = short[:7]
		}
		emit("pull_request.synchronize", fmt.Sprintf("PR #%d new commits (%s)", n, short), jsjson.NewObject("at", at, "head", h), "pull_request.synchronize:"+s.Key+":"+h)
	}
	done := state.Checks == "success" || state.Checks == "failure"
	if done && (deref(prev.ChecksHead) != deref(state.ChecksHead) || prev.Checks != state.Checks || deref(prev.ChecksAt) != deref(state.ChecksAt)) {
		var summary string
		if state.Checks == "failure" {
			f := strings.Join(state.Failing, ", ")
			if f == "" {
				f = "unknown"
			}
			summary = fmt.Sprintf("PR #%d checks failed: %s", n, f)
		} else {
			summary = fmt.Sprintf("PR #%d checks passed", n)
		}
		var ra, head, verdict, cat jsjson.Value
		if a := ownReviewAgent(state); a != "" {
			ra = a
		}
		if state.ChecksHead != nil {
			head = *state.ChecksHead
		}
		if v := ReviewVerdict(state.HeadStatuses); v != "" {
			verdict = v
		}
		if state.ChecksAt != nil {
			cat = *state.ChecksAt
		}
		emit("checks.completed", summary, jsjson.NewObject("at", cat, "review_agent", ra, "head", head, "verdict", verdict), "checks.completed:"+s.Key+":"+deref(state.ChecksHead)+":"+state.Checks+":"+deref(state.ChecksAt))
	}
}
