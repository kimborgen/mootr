// Package events is the Go daemon's external-event service (src/watch.ts, S-4317): events a source hands to Ingest are
// stored, matched against the subscriptions' filters, and delivered folded, as a notice while the subscriber works and
// as mail or a post otherwise. This file is the part with no state: the filter, its glob matching, and the lines a
// delivery lists.
package events

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"sync"

	"stam/internal/jsjson"
)

// Filter is a subscription's filter (src/watch.ts EventFilter). Every field is optional; the field order is the order
// sanitizeFilter writes them in, so the stored text matches what the TS daemon wrote.
type Filter struct {
	Source        string   `json:"source,omitempty"`
	Subjects      []string `json:"subjects,omitempty"`
	Types         []string `json:"types,omitempty"`
	Actors        []string `json:"actors,omitempty"`
	ExcludeActors []string `json:"exclude_actors,omitempty"`
	// EndsOn lists the event types that end the subscription once one is delivered (watch_pr: a merge or close).
	EndsOn []string `json:"ends_on,omitempty"`
	// Since is an ISO time: a source-stamped event that happened before it is not delivered.
	Since string `json:"since,omitempty"`
}

// JSON is the filter as JSON.stringify writes it: no HTML escaping.
func (f Filter) JSON() string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(f)
	return strings.TrimSuffix(b.String(), "\n")
}

// ParseFilter reads a stored filter; text that isn't a filter object is the empty filter.
func ParseFilter(text string) Filter {
	var f Filter
	if json.Unmarshal([]byte(text), &f) != nil {
		return Filter{}
	}
	return f
}

// Event is the part of a stored event that matching and delivery read.
type Event struct {
	Source   string
	Type     string
	Subjects []string
	Actor    string
	// HasActor is whether the event names an actor (`ev.actor` truthy in TS).
	HasActor bool
	URL      string
	Summary  string
	// Payload is the event's payload as parsed JSON, nil for none.
	Payload jsjson.Value
}

var (
	globMu    sync.Mutex
	globCache = map[string]*regexp.Regexp{}
)

// GlobMatch is src/watch.ts globMatch: `*` matches any run of characters within one segment (no `/`), and an exact
// pattern (no `*`) matches only itself.
func GlobMatch(pattern, value string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == value
	}
	globMu.Lock()
	re, ok := globCache[pattern]
	if !ok {
		parts := strings.Split(pattern, "*")
		for i, p := range parts {
			parts[i] = regexp.QuoteMeta(p)
		}
		re = regexp.MustCompile("(?s)^" + strings.Join(parts, "[^/]*") + "$")
		if len(globCache) > 4096 {
			globCache = map[string]*regexp.Regexp{}
		}
		globCache[pattern] = re
	}
	globMu.Unlock()
	return re.MatchString(value)
}

func anyGlob(patterns []string, value string) bool {
	for _, p := range patterns {
		if GlobMatch(p, value) {
			return true
		}
	}
	return false
}

// Matches is src/watch.ts matchesFilter: whether one event fits a filter. A filter with no subjects matches any event,
// and one with subjects matches when any pattern fits any key.
func (f Filter) Matches(ev Event) bool {
	if f.Source != "" && f.Source != ev.Source {
		return false
	}
	// `issues` was split into `issues.<action>`: a filter on plain `issues` still fits them, and no other type widens.
	if len(f.Types) > 0 {
		ok := false
		for _, p := range f.Types {
			if GlobMatch(p, ev.Type) || (p == "issues" && strings.HasPrefix(ev.Type, "issues.")) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if len(f.Subjects) > 0 {
		ok := false
		for _, s := range ev.Subjects {
			if anyGlob(f.Subjects, s) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	if len(f.Actors) > 0 && !anyGlob(f.Actors, ev.Actor) {
		return false
	}
	if len(f.ExcludeActors) > 0 && ev.HasActor && anyGlob(f.ExcludeActors, ev.Actor) {
		return false
	}
	return true
}

// Ends is whether the event's type is one of the filter's ending types.
func (f Filter) Ends(typ string) bool { return anyGlob(f.EndsOn, typ) }

// HasSelector is src/waits.ts hasSelector: whether a filter names what to match, a source, subjects, types or actors
// (not only exclusions).
func (f Filter) HasSelector() bool {
	return f.Source != "" || len(f.Subjects) > 0 || len(f.Types) > 0 || len(f.Actors) > 0
}

// list is sanitizeFilter's `list`: an array's items as strings with the empty ones dropped, nothing for null or ”,
// and any other value as one string.
func list(v jsjson.Value) []string {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		if x == "" {
			return nil
		}
		return []string{x}
	case []any:
		var out []string
		for _, e := range x {
			if s := jsjson.ToString(e); s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return []string{jsjson.ToString(v)}
}

// Sanitize is src/watch.ts sanitizeFilter: the filter a body's value means, with only the known fields, strings
// and no empty lists.
func Sanitize(raw jsjson.Value) Filter {
	o, _ := raw.(*jsjson.Object)
	var f Filter
	if o == nil {
		return f
	}
	get := func(k string) jsjson.Value { v, _ := o.Get(k); return v }
	scalar := func(k string) string {
		if v := get(k); v != nil {
			return jsjson.Trim(jsjson.ToString(v))
		}
		return ""
	}
	f.Source = scalar("source")
	f.Subjects = list(get("subjects"))
	f.Types = list(get("types"))
	f.Actors = list(get("actors"))
	f.ExcludeActors = list(get("exclude_actors"))
	f.EndsOn = list(get("ends_on"))
	f.Since = scalar("since")
	return f
}

var (
	reGitHub = regexp.MustCompile(`^https?://github\.com/([^/\s\p{Z}\x{feff}]+)/([^/\s\p{Z}\x{feff}]+)/(?:pull|issues)/(\d+)(?:[/?#][^\n\r\x{2028}\x{2029}]*)?$`)
	reLinear = regexp.MustCompile(`^https?://linear\.app/[^/\s\p{Z}\x{feff}]+/issue/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#][^\n\r\x{2028}\x{2029}]*)?$`)
)

// SubjectForURL is src/watch.ts subjectsForUrl: the subject key a link's URL names, "" for one stam doesn't follow. A
// GitHub pull request or issue maps to `github:OWNER/REPO#N`; a Linear issue to `linear:TEAM-123`.
func SubjectForURL(url string) string {
	u := jsjson.Trim(url)
	if m := reGitHub.FindStringSubmatch(u); m != nil {
		return "github:" + m[1] + "/" + m[2] + "#" + m[3]
	}
	if m := reLinear.FindStringSubmatch(u); m != nil {
		return "linear:" + m[1]
	}
	return ""
}

// Line is one event's line in a delivery (src/watch.ts eventLine): its summary and where to look.
func Line(ev Event) string {
	var where []string
	if ev.HasActor {
		where = append(where, "by "+ev.Actor)
	}
	if ev.URL != "" {
		where = append(where, ev.URL)
	}
	w := ""
	if len(where) > 0 {
		w = " — " + strings.Join(where, " · ")
	}
	return "- [" + ev.Source + "] " + ev.Type + ": " + ev.Summary + w
}

var (
	reChecksFailed   = regexp.MustCompile(`checks failed`)
	reChangesRequest = regexp.MustCompile(`\(changes requested\)`)
	reDeployStopped  = regexp.MustCompile(`Deploy of \S+ stopped:`)
)

// IsFailure is src/watch.ts isFailureEvent: whether an event is a failure the agent should record a retro about: a red
// check or gate on its pull request, a changes-requested review, or a deploy that stopped on it.
func IsFailure(ev Event) bool {
	if ev.Source != "github" {
		return false
	}
	switch ev.Type {
	case "checks.completed":
		return reChecksFailed.MatchString(ev.Summary)
	case "review.submitted":
		return reChangesRequest.MatchString(ev.Summary)
	case "comment.created":
		return reDeployStopped.MatchString(ev.Summary)
	}
	return false
}

// payloadString is a payload field when it is a non-empty string, "" otherwise.
func payloadString(p jsjson.Value, key string) string {
	o, _ := p.(*jsjson.Object)
	if o == nil {
		return ""
	}
	v, _ := o.Get(key)
	s, _ := v.(string)
	return s
}

// Fits is src/watch.ts fitsSubscription for an agent, an ITSA or the human (kind): the filter, and beyond it, not a
// change that happened before the watch began, and never the subscriber's own review. An ending type is always
// delivered, since it is what ends the watch.
func Fits(kind, subscriberID string, f Filter, ev Event) bool {
	if !f.Matches(ev) {
		return false
	}
	if f.Since != "" && !f.Ends(ev.Type) {
		if at := payloadString(ev.Payload, "at"); at != "" && at < f.Since {
			return false
		}
	}
	if kind == "agent" && payloadString(ev.Payload, "review_agent") == subscriberID {
		return false
	}
	return true
}

// Describe is src/waits.ts describeFilter: a filter as one readable phrase.
func (f Filter) Describe() string {
	var bits []string
	if f.Source != "" {
		bits = append(bits, "source "+f.Source)
	}
	if len(f.Subjects) > 0 {
		bits = append(bits, "subjects "+strings.Join(f.Subjects, ", "))
	}
	if len(f.Types) > 0 {
		bits = append(bits, "types "+strings.Join(f.Types, ", "))
	}
	if len(f.Actors) > 0 {
		bits = append(bits, "actors "+strings.Join(f.Actors, ", "))
	}
	if len(f.ExcludeActors) > 0 {
		bits = append(bits, "not by "+strings.Join(f.ExcludeActors, ", "))
	}
	if len(bits) == 0 {
		return "any"
	}
	return strings.Join(bits, "; ")
}
