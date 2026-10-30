package linearpoll

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// The Linear source's pure part (src/sources/linear.ts): the subjects, the defensive parsing of what Linear's MCP tools
// answer with, and the diff of one poll against the last snapshot into events. The real tool names and result shapes are
// unverified until the user logs in, so the parsing takes any of the shapes the TS source takes.

var (
	reIssue = regexp.MustCompile(`^linear:([A-Za-z][A-Za-z0-9]*-\d+)$`)
	reTeam  = regexp.MustCompile(`^linear:team:([A-Za-z][A-Za-z0-9]*)$`)
)

// ParseSubject is the issue id of a `linear:TEAM-123` subject, upper-cased; false for anything else.
func ParseSubject(subject string) (string, bool) {
	m := reIssue.FindStringSubmatch(subject)
	if m == nil {
		return "", false
	}
	return strings.ToUpper(m[1]), true
}

// ParseTeamSubject is the team key of a `linear:team:KEY` subject, upper-cased; false for anything else.
func ParseTeamSubject(subject string) (string, bool) {
	m := reTeam.FindStringSubmatch(subject)
	if m == nil {
		return "", false
	}
	return strings.ToUpper(m[1]), true
}

// Issue is an issue as a poll sees it. Its JSON is the snapshot's (without the comment ids), field for field as TS stores it.
type Issue struct {
	ID        string  `json:"id"`
	Title     *string `json:"title"`
	URL       *string `json:"url"`
	State     *string `json:"state"`
	Assignee  *string `json:"assignee"`
	Priority  *string `json:"priority"`
	UpdatedAt *string `json:"updatedAt"`
	CreatedAt *string `json:"createdAt"`
}

// Snapshot is what a poll keeps of an issue: its fields and the ids of the comments seen (the last 500).
type Snapshot struct {
	Issue
	CommentIDs []string `json:"commentIds"`
}

// Comment is a comment on an issue.
type Comment struct {
	ID        string
	Author    *string
	Body      string
	CreatedAt *string
}

func sp(s string) *string { return &s }

func strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func eqStr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// prop is o's key; nil when o is no object or lacks it (as JS reads a property of a non-object).
func prop(o jsjson.Value, key string) jsjson.Value {
	obj, ok := o.(*jsjson.Object)
	if !ok {
		return nil
	}
	v, _ := obj.Get(key)
	return v
}

// firstOf is a ?? b: a unless it is null.
func firstOf(vs ...jsjson.Value) jsjson.Value {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

// textOrNil is `v || null` read as a string: an empty, zero or false value reads as none.
func textOrNil(v jsjson.Value) *string {
	if !jsjson.Truthy(v) {
		return nil
	}
	return sp(jsjson.ToString(v))
}

// named is a name from a field that may be a string or an object with a name, displayName or email.
func named(v jsjson.Value) *string {
	switch x := v.(type) {
	case string:
		return textOrNil(x)
	case *jsjson.Object:
		return textOrNil(firstOf(prop(x, "name"), prop(x, "displayName"), prop(x, "email")))
	case []jsjson.Value:
		// An array is an object in JS with none of those keys.
		return nil
	}
	return nil
}

// NormalizeIssue is the issue from whatever shape the tool answered with. Priority is its label or name, or the bare
// number, as text.
func NormalizeIssue(o jsjson.Value, id string) Issue {
	var issue jsjson.Value = jsjson.NewObject()
	if _, ok := o.(*jsjson.Object); ok {
		issue = firstOf(prop(o, "issue"), o)
	}
	var priority *string
	if p := prop(issue, "priority"); p != nil && p != "" {
		switch pv := p.(type) {
		case *jsjson.Object:
			priority = named(pv)
			if priority == nil {
				if v := prop(pv, "value"); v != nil {
					priority = sp(jsjson.ToString(v))
				}
			}
		case []jsjson.Value:
			// typeof [] is object: no name, no value.
		default:
			priority = sp(jsjson.ToString(p))
		}
	}
	str := func(key string) *string {
		if s, ok := prop(issue, key).(string); ok {
			return &s
		}
		return nil
	}
	alias := func(a, b string) *string {
		v := firstOf(prop(issue, a), prop(issue, b))
		if v == nil {
			return nil
		}
		return sp(jsjson.ToString(v))
	}
	return Issue{
		ID:        id,
		Title:     str("title"),
		URL:       str("url"),
		State:     named(prop(issue, "state")),
		Assignee:  named(prop(issue, "assignee")),
		Priority:  priority,
		UpdatedAt: alias("updatedAt", "updated_at"),
		CreatedAt: alias("createdAt", "created_at"),
	}
}

// NormalizeComments is the comments from a list answer, which may be a bare array or hold one under `comments` or `nodes`.
func NormalizeComments(o jsjson.Value) []Comment {
	list, _ := o.([]jsjson.Value)
	if _, bare := o.([]jsjson.Value); !bare {
		if l, ok := prop(o, "comments").([]jsjson.Value); ok {
			list = l
		} else if l, ok := prop(o, "nodes").([]jsjson.Value); ok {
			list = l
		}
	}
	var out []Comment
	for _, c := range list {
		if !jsjson.Truthy(c) || prop(c, "id") == nil {
			continue
		}
		author := named(prop(c, "user"))
		if author == nil {
			author = named(prop(c, "author"))
		}
		if author == nil {
			author = named(prop(c, "creator"))
		}
		var created *string
		if v := firstOf(prop(c, "createdAt"), prop(c, "created_at")); v != nil {
			created = sp(jsjson.ToString(v))
		}
		body := ""
		if b := prop(c, "body"); b != nil {
			body = jsjson.ToString(b)
		}
		out = append(out, Comment{ID: jsjson.ToString(prop(c, "id")), Author: author, Body: body, CreatedAt: created})
	}
	return out
}

// Event is one change a poll found, as the source posts it.
type Event struct {
	Type      string
	Subject   string
	Actor     *string
	URL       *string
	Summary   string
	DedupeKey string
	// Issue is the issue a team's event names in its payload ({issue: subject}); "" for an issue's own event.
	Issue string
}

// firstLine is a comment's first line, trimmed, at most 200 UTF-16 code units (as JS slice cuts it).
func firstLine(body string) string {
	line := jsjson.Trim(strings.SplitN(body, "\n", 2)[0])
	u := utf16.Encode([]rune(line))
	if len(u) > 200 {
		return string(utf16.Decode(u[:200]))
	}
	return line
}

// DiffIssue is the events one poll's changes make. prev is the last snapshot (its CommentIDs the comments already seen);
// nil means the first poll, which emits nothing. A team's poll (team is its subject) makes each event carry the team alone,
// not the issue, so an issue-only subscriber hears the change once (from the issue's poll) and a team subscriber once (from
// the team's); the dedupe keys name the team too, since the dedupe is global and the issue's own poll may ingest the same
// change first.
func DiffIssue(subject string, prev *Snapshot, cur Issue, comments []Comment, team string) []Event {
	if prev == nil {
		return nil
	}
	at := strVal(cur.UpdatedAt)
	subj := subject
	if team != "" {
		subj = team
	}
	dedupe := func(typ, tail string) string {
		if team != "" {
			return typ + ":" + team + ":" + subject + ":" + tail
		}
		return typ + ":" + subject + ":" + tail
	}
	base := func(typ, summary, key string) Event {
		e := Event{Type: typ, Subject: subj, URL: cur.URL, Summary: summary, DedupeKey: key}
		if team != "" {
			e.Issue = subject
		}
		return e
	}
	label := cur.ID
	none := func(p *string, def string) string {
		if p == nil {
			return def
		}
		return *p
	}
	var out []Event
	if prev.State != nil && *prev.State != "" && cur.State != nil && *cur.State != "" && *prev.State != *cur.State {
		out = append(out, base("issue.state_changed", label+" state: "+*prev.State+" → "+*cur.State, dedupe("issue.state_changed", at)))
	}
	if !eqStr(prev.Assignee, cur.Assignee) {
		out = append(out, base("issue.assigned", label+" assigned to "+none(cur.Assignee, "nobody"), dedupe("issue.assigned", at)))
	}
	if !eqStr(prev.Priority, cur.Priority) {
		out = append(out, base("issue.priority_changed", label+" priority: "+none(prev.Priority, "none")+" → "+none(cur.Priority, "none"), dedupe("issue.priority_changed", at)))
	}
	if prev.Title != nil && *prev.Title != "" && cur.Title != nil && *cur.Title != "" && *prev.Title != *cur.Title {
		out = append(out, base("issue.title_changed", label+" renamed: "+*cur.Title, dedupe("issue.title_changed", at)))
	}
	seen := map[string]bool{}
	for _, id := range prev.CommentIDs {
		seen[id] = true
	}
	for _, c := range comments {
		if seen[c.ID] {
			continue
		}
		e := base("comment.created", label+" comment by "+none(c.Author, "someone")+": "+firstLine(c.Body), dedupe("comment.created", c.ID))
		e.Actor = c.Author
		out = append(out, e)
	}
	return out
}

// MakeSnapshot is the snapshot to keep: the issue's fields and the ids of the comments seen (the last 500).
func MakeSnapshot(cur Issue, comments []Comment, prev *Snapshot) Snapshot {
	var ids []string
	seen := map[string]bool{}
	add := func(id string) {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if prev != nil {
		for _, id := range prev.CommentIDs {
			add(id)
		}
	}
	for _, c := range comments {
		add(c.ID)
	}
	if len(ids) > 500 {
		ids = ids[len(ids)-500:]
	}
	if ids == nil {
		ids = []string{}
	}
	return Snapshot{Issue: cur, CommentIDs: ids}
}

// ParseSnapshot reads a stored snapshot leniently, as the TS source reads one; nil when the text is not a JSON object.
func ParseSnapshot(raw string) *Snapshot {
	v, err := jsjson.Parse([]byte(raw))
	if err != nil {
		return nil
	}
	o, ok := v.(*jsjson.Object)
	if !ok {
		return nil
	}
	s := &Snapshot{CommentIDs: []string{}}
	get := func(k string) *string {
		v, ok := o.Get(k)
		if !ok || v == nil {
			return nil
		}
		return sp(jsjson.ToString(v))
	}
	if id := get("id"); id != nil {
		s.ID = *id
	}
	s.Title, s.URL, s.State, s.Assignee, s.Priority = get("title"), get("url"), get("state"), get("assignee"), get("priority")
	s.UpdatedAt, s.CreatedAt = get("updatedAt"), get("createdAt")
	if ids, ok := prop(o, "commentIds").([]jsjson.Value); ok {
		for _, id := range ids {
			s.CommentIDs = append(s.CommentIDs, jsjson.ToString(id))
		}
	}
	return s
}
