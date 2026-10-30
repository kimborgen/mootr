package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// watch_pr and unwatch_pr of src/mcp.ts (S-446, S-4329): a PR named as a number, OWNER/REPO#N or a url becomes one
// subscription on its subject, with the event presets as its types and a merge or close as its ending types. The daemon
// judges who may watch for whom (POST /api/subscriptions); these send what the TS tools send and say what they say.

// prPresets is PR_EVENT_PRESETS in its order: each preset is one event type.
var prPresets = []struct{ name, typ string }{
	{"checks", "checks.completed"},
	{"reviews", "review.submitted"},
	{"comments", "comment.created"},
	{"pushes", "pull_request.synchronize"},
	{"merged", "pull_request.merged"},
	{"closed", "pull_request.closed"},
}

// prEndTypes always end a PR watch, so they are delivered even when the preset list leaves them out.
var prEndTypes = []string{"pull_request.merged", "pull_request.closed"}

func presetType(name string) (string, error) {
	for _, p := range prPresets {
		if p.name == name {
			return p.typ, nil
		}
	}
	names := make([]string, len(prPresets))
	for i, p := range prPresets {
		names[i] = p.name
	}
	return "", fmt.Errorf("no PR event %s; use %s", name, strings.Join(names, ", "))
}

var (
	rePrNumber = regexp.MustCompile(`^#?(\d+)$`)
	rePrRepo   = regexp.MustCompile(`^([^/#\s]+/[^/#\s]+)#(\d+)$`)
	rePrURL    = regexp.MustCompile(`^https?://github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)(?:[/?#].*)?$`)
)

// prSubject is a pull request as its subject key: a number (the default repo), OWNER/REPO#N, or a url.
func prSubject(ctx context.Context, s *Server, pr jsfmt.Value, set bool) (key string, number int, err error) {
	text := ""
	if set && pr.Kind != jsfmt.Null {
		text = jsString(pr)
	}
	text = jsjson.Trim(text)
	repo := ""
	var num string
	switch {
	case rePrNumber.MatchString(text):
		num = rePrNumber.FindStringSubmatch(text)[1]
	case rePrRepo.MatchString(text):
		m := rePrRepo.FindStringSubmatch(text)
		repo, num = m[1], m[2]
	case rePrURL.MatchString(text):
		m := rePrURL.FindStringSubmatch(text)
		repo, num = m[1], m[2]
	default:
		var q strings.Builder
		jsjson.Quote(&q, text)
		return "", 0, fmt.Errorf("pr must be a number, OWNER/REPO#N, or a pull request url, not %s", q.String())
	}
	n, _ := strconv.ParseFloat(num, 64)
	if repo == "" {
		r, err := s.apiJSON(ctx, "GET", "/api/pr/github-repo", nil)
		if err != nil {
			return "", 0, err
		}
		if v, ok := present(r, "github"); !ok || !v.Truthy() {
			return "", 0, errors.New("no default GitHub repo: set settings.itsa.prOpen.github on the ITSA home, or give the pr as OWNER/REPO#N")
		} else {
			repo = jsString(v)
		}
	}
	return "github:" + repo + "#" + jsjson.Number(n), int(n), nil
}

// dropPrWatches ends the watches subscriber (the id the daemon stored) has on one PR, so watching again replaces the earlier
// one. keep is the new watch's id, which stays. It returns how many it removed.
func dropPrWatches(ctx context.Context, s *Server, subscriber, key, by, keep string) (int, error) {
	subs, err := s.apiJSON(ctx, "GET", "/api/subscriptions?by="+url.QueryEscape(by), nil)
	if err != nil {
		return 0, err
	}
	var ids []string
	for _, x := range subs.Items {
		if keep != "" && tpl(x, "id") == keep {
			continue
		}
		if v, ok := x.Get("subscriber_id"); !ok || jsString(v) != subscriber {
			continue
		}
		f, _ := x.Get("filter")
		ends, _ := f.Get("ends_on")
		subjects, _ := f.Get("subjects")
		if ends.Kind != jsfmt.Array || len(ends.Items) == 0 || subjects.Kind != jsfmt.Array || len(subjects.Items) != 1 || jsString(subjects.Items[0]) != key {
			continue
		}
		ids = append(ids, tpl(x, "id"))
	}
	for _, id := range ids {
		body := jsfmt.Value{Kind: jsfmt.Object}
		body.Set("by", jsfmt.StringValue(by))
		if _, err := s.apiJSON(ctx, "DELETE", "/api/subscriptions/"+url.PathEscape(id), raw(body)); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

func strArray(l []string) jsfmt.Value {
	items := make([]jsfmt.Value, len(l))
	for i, s := range l {
		items[i] = jsfmt.StringValue(s)
	}
	return jsfmt.ArrayValue(items)
}

func watchPr(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	pr, set := a.Get("pr")
	key, number, err := prSubject(ctx, s, pr, set)
	if err != nil {
		return "", err
	}
	// `[...new Set([...(a.events?.length ? a.events : presets).map(presetType), ...END])]`
	var names []string
	if ev, ok := a.Get("events"); ok && ev.Kind == jsfmt.Array && len(ev.Items) > 0 {
		for _, e := range ev.Items {
			names = append(names, jsString(e))
		}
	} else {
		for _, p := range prPresets {
			names = append(names, p.name)
		}
	}
	var types []string
	seen := map[string]bool{}
	for _, n := range append(names, "") {
		var t string
		if n == "" {
			break
		}
		if t, err = presetType(n); err != nil {
			return "", err
		}
		if !seen[t] {
			seen[t] = true
			types = append(types, t)
		}
	}
	for _, t := range prEndTypes {
		if !seen[t] {
			seen[t] = true
			types = append(types, t)
		}
	}
	forHuman := false
	if v, ok := a.Get("for"); ok && v.Kind == jsfmt.String && v.Str == "human" {
		forHuman = true
	}
	kind, id := "agent", by
	switch {
	case forHuman:
		kind, id = "human", "human"
	default:
		if v, ok := present(a, "for"); ok {
			id = jsString(v)
		}
	}
	filter := jsfmt.Value{Kind: jsfmt.Object}
	filter.Set("source", jsfmt.StringValue("github"))
	filter.Set("subjects", strArray([]string{key}))
	filter.Set("types", strArray(types))
	filter.Set("ends_on", strArray(prEndTypes))
	filter.Set("since", jsfmt.StringValue(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("subscriber_kind", jsfmt.StringValue(kind))
	body.Set("subscriber_id", jsfmt.StringValue(id))
	body.Set("filter", filter)
	body.Set("note", jsfmt.StringValue(fmt.Sprintf("PR #%d watch", number)))
	body.Set("by", jsfmt.StringValue(by))
	// Create first: the daemon resolves `for` (an id or a name) and refuses one it can't, so a refused watch leaves the
	// earlier one in place. Then the earlier watch on this PR goes.
	r, err := s.apiJSON(ctx, "POST", "/api/subscriptions", raw(body))
	if err != nil {
		return "", err
	}
	subscriber := tpl(r, "subscriber_id")
	if _, err := dropPrWatches(ctx, s, subscriber, key, by, tpl(r, "id")); err != nil {
		return "", err
	}
	short := make([]string, len(types))
	for i, t := range types {
		short[i] = strings.TrimPrefix(t, "pull_request.")
	}
	return fmt.Sprintf("Watching PR #%d (%s): %s. A merge or close ends the watch.", number, key, strings.Join(short, ", ")), nil
}

func unwatchPr(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	pr, set := a.Get("pr")
	key, number, err := prSubject(ctx, s, pr, set)
	if err != nil {
		return "", err
	}
	by, err := s.me(a)
	if err != nil {
		return "", err
	}
	who := by
	if v, ok := a.Get("for"); ok && v.Kind == jsfmt.String && v.Str == "human" {
		who = "human"
	} else if v, ok := present(a, "for"); ok {
		who = jsString(v)
	}
	n, err := dropPrWatches(ctx, s, who, key, by, "")
	if err != nil {
		return "", err
	}
	if n > 0 {
		return fmt.Sprintf("Stopped watching PR #%d.", number), nil
	}
	return fmt.Sprintf("No watch on PR #%d.", number), nil
}
