package mcp

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"stam/internal/jsfmt"
)

// The event subscription tools of src/mcp.ts (S-4317): subscribe, unsubscribe and list_subscriptions. The daemon judges
// who may subscribe whom; these send what the TS tools send and say what they say. watch_pr and unwatch_pr follow.

func init() {
	for _, n := range []string{"subscribe", "unsubscribe", "list_subscriptions"} {
		tools = append(tools, tool{name: n, listing: eventsListings[n], run: eventsRuns[n]})
	}
}

var eventsRuns = map[string]func(context.Context, *Server, jsfmt.Value) (string, error){
	"subscribe": subscribe, "unsubscribe": unsubscribe, "list_subscriptions": listSubscriptions,
}

// present is `a[key] != null`: the member is there and isn't null.
func present(a jsfmt.Value, key string) (jsfmt.Value, bool) {
	v, ok := a.Get(key)
	return v, ok && v.Kind != jsfmt.Null
}

func subscribe(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	forHuman := false
	if v, ok := a.Get("for"); ok && v.Kind == jsfmt.String && v.Str == "human" {
		forHuman = true
	}
	itsa := truthyMember(a, "itsa")
	kind := "agent"
	switch {
	case itsa:
		kind = "itsa"
	case forHuman:
		kind = "human"
	}
	// `a.itsa ?? (a.for === 'human' ? 'human' : a.for ?? by)`
	id := by
	if v, ok := present(a, "itsa"); ok {
		id = jsString(v)
	} else if forHuman {
		id = "human"
	} else if v, ok := present(a, "for"); ok {
		id = jsString(v)
	}
	filter := jsfmt.Value{Kind: jsfmt.Object}
	copyIf(&filter, a, "source", "subjects", "types", "actors", "exclude_actors")
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("subscriber_kind", jsfmt.StringValue(kind))
	body.Set("subscriber_id", jsfmt.StringValue(id))
	body.Set("filter", filter)
	copyIf(&body, a, "note", "expires_in_minutes")
	body.Set("by", jsfmt.StringValue(by))
	r, err := s.apiJSON(ctx, "POST", "/api/subscriptions", raw(body))
	if err != nil {
		return "", err
	}
	who := "you"
	switch {
	case itsa:
		who = "ITSA " + tpl(a, "itsa")
	case forHuman:
		who = "the human"
	default:
		if v, ok := present(a, "for"); ok {
			who = jsString(v)
		}
	}
	return fmt.Sprintf("Subscribed (%s): %s hears about matching events.", tpl(r, "id"), who), nil
}

func unsubscribe(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(by))
	if _, err := s.apiJSON(ctx, "DELETE", "/api/subscriptions/"+seg(a, "id"), raw(body)); err != nil {
		return "", err
	}
	return fmt.Sprintf("Removed subscription %s.", tpl(a, "id")), nil
}

func listSubscriptions(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	subs, err := s.apiJSON(ctx, "GET", "/api/subscriptions?by="+url.QueryEscape(by), nil)
	if err != nil {
		return "", err
	}
	if len(subs.Items) == 0 {
		return "No event subscriptions.", nil
	}
	var lines []string
	for _, sub := range subs.Items {
		line := fmt.Sprintf("%s  %s:%s  %s", tpl(sub, "id"), tpl(sub, "subscriber_kind"), tpl(sub, "subscriber_id"), describeFilter(sub))
		if truthyMember(sub, "note") {
			line += "  (" + tpl(sub, "note") + ")"
		}
		if v, ok := sub.Get("expires_at"); ok && v.Truthy() {
			ms, _ := strconv.ParseFloat(v.Num, 64)
			line += "  expires " + time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n"), nil
}

// describeFilter is list_subscriptions' `describe`: the filter's entries as k=v, an array's items comma-joined.
func describeFilter(sub jsfmt.Value) string {
	f, _ := sub.Get("filter")
	var bits []string
	for i, k := range f.Keys {
		bits = append(bits, k+"="+jsString(f.Items[i]))
	}
	if len(bits) == 0 {
		return "any events"
	}
	return strings.Join(bits, " ")
}
