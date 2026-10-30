package ghpoll

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"stam/internal/jsjson"
)

var repoEventTypes = map[string]string{
	"PushEvent":                     "push",
	"PullRequestEvent":              "pull_request",
	"PullRequestReviewEvent":        "pull_request_review",
	"PullRequestReviewCommentEvent": "pull_request_review_comment",
	"IssuesEvent":                   "issues",
	"IssueCommentEvent":             "issue_comment",
	"CreateEvent":                   "create",
	"DeleteEvent":                   "delete",
	"ReleaseEvent":                  "release",
	"WatchEvent":                    "star",
	"ForkEvent":                     "fork",
	"PublicEvent":                   "public",
}

// GitHub serves at most 100 events a page and 300 in all; a busy repo can outrun one page.
const (
	eventsPerPage = 100
	eventPagesMax = 3
)

var reRelNext = regexp.MustCompile(`rel="next"`)

func (p *Poller) pollRepo(ctx context.Context, s Subject, prev *Snapshot, prevEtags map[string]string, token string) (PollResult, error) {
	first := prev == nil
	state := Snapshot{Type: "repo"}
	zero := int64(0)
	state.LastEventID = &zero
	if prev != nil {
		state = *prev
	}
	etags := copyEtags(prevEtags)
	var events []Event
	tr := newTracker()

	// Events come newest first. Page 1 is the only one with an ETag; a later page is read only while every event on the page
	// before it is newer than the last poll's lastEventId.
	var seen int64
	if prev != nil && prev.LastEventID != nil {
		seen = *prev.LastEventID
	}
	last := seen
	if state.LastEventID != nil {
		last = *state.LastEventID
	}
	for page := 1; page <= eventPagesMax; page++ {
		path := fmt.Sprintf("/repos/%s/%s/events?per_page=%d&page=%d", s.Owner, s.Repo, eventsPerPage, page)
		etag := ""
		if page == 1 {
			etag = etags["events"]
		}
		r, err := p.get(ctx, path, token, etag)
		if err != nil {
			return PollResult{}, err
		}
		tr.track(r)
		// A 304 on page 1 means nothing is new; a later page has no ETag, so anything but a 200 there is a failure that would
		// lose the events on it.
		if r.Status == 304 && page == 1 {
			break
		}
		if err := tr.check(r, path); err != nil {
			return PollResult{}, err
		}
		v, err := jsjson.Parse(r.Body)
		if err != nil {
			return PollResult{}, fmt.Errorf("GitHub reply for %s is not the JSON expected", path)
		}
		if page == 1 {
			etags["events"] = r.ETag
		}
		list, _ := v.([]jsjson.Value)
		allNew := len(list) > 0
		for _, item := range list {
			e, _ := item.(*jsjson.Object)
			id := eventID(e)
			if id <= seen {
				allNew = false
			}
			if !first && id > seen {
				events = append(events, repoEvent(e, s))
			}
			if id > last {
				last = id
			}
		}
		if first || !allNew || !reRelNext.MatchString(r.Link) {
			break
		}
	}
	state.LastEventID = &last
	return PollResult{Events: events, State: state, Etags: etags, Remaining: tr.remaining, ResetAt: tr.resetAt}, nil
}

// eventID is Number(e.id), 0 when it isn't one.
func eventID(e *jsjson.Object) int64 {
	if e == nil {
		return 0
	}
	v, _ := e.Get("id")
	n := jsjson.ToNumber(v)
	if n != n {
		return 0
	}
	return int64(n)
}

func objGet(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

func asObj(v jsjson.Value) *jsjson.Object { o, _ := v.(*jsjson.Object); return o }

func asStr(v jsjson.Value) string {
	s, _ := v.(string)
	return s
}

// repoEvent is one repository event as an external event: its type maps to a stam type, and its payload to a one-line
// summary (a push names its branch and count).
func repoEvent(e *jsjson.Object, s Subject) Event {
	raw := "event"
	if t, ok := objGet(e, "type").(string); ok && t != "" {
		raw = t
	}
	base, ok := repoEventTypes[raw]
	if !ok {
		base = strings.ToLower(strings.TrimSuffix(raw, "Event"))
		if base == "" {
			base = "event"
		}
	}
	payloadV := objGet(e, "payload")
	payload := asObj(payloadV)
	action := ""
	if base == "issues" {
		action = asStr(objGet(payload, "action"))
	}
	typ := base
	if action != "" {
		typ = "issues." + action
	}
	var actor *string
	if a := asObj(objGet(e, "actor")); a != nil {
		if l, ok := objGet(a, "login").(string); ok {
			actor = &l
		}
	}
	who := "someone"
	if actor != nil {
		who = *actor
	}
	summary := typ + " by " + who
	if typ == "push" {
		branch := strings.Replace(asStr(objGet(payload, "ref")), "refs/heads/", "", 1)
		count := 0
		if c, ok := objGet(payload, "commits").([]jsjson.Value); ok {
			count = len(c)
		}
		plural := "s"
		if count == 1 {
			plural = ""
		}
		if branch == "" {
			branch = "a branch"
		}
		summary = fmt.Sprintf("push: %d commit%s to %s", count, plural, branch)
	}
	subjects := []string{s.RepoKey}
	var number jsjson.Value
	if n := objGet(asObj(objGet(payload, "pull_request")), "number"); jsjson.Truthy(n) {
		number = n
	} else if n := objGet(asObj(objGet(payload, "issue")), "number"); jsjson.Truthy(n) {
		number = n
	}
	if action != "" {
		num := "?"
		if number != nil {
			num = jsjson.ToString(number)
		}
		title := jsjson.Trim(jsjson.ToString(objGet(asObj(objGet(payload, "issue")), "title")))
		if objGet(asObj(objGet(payload, "issue")), "title") == nil {
			title = ""
		}
		summary = strings.Join(strings.Fields(fmt.Sprintf("%s: #%s %s by %s", typ, num, title, who)), " ")
	}
	if jsjson.Truthy(number) {
		subjects = append(subjects, "github:"+s.Owner+"/"+s.Repo+"#"+jsjson.ToString(number))
	}
	var out jsjson.Value = payloadV
	if payloadV == nil {
		out = jsjson.NewObject()
	}
	u := "https://github.com/" + s.Owner + "/" + s.Repo
	id := strconv.FormatInt(eventID(e), 10)
	if v := objGet(e, "id"); v != nil {
		id = jsjson.ToString(v)
	}
	return Event{Type: typ, Subject: s.RepoKey, Subjects: subjects, Actor: actor, URL: &u, Summary: summary, DedupeKey: typ + ":" + s.RepoKey + ":" + id, Payload: out}
}
