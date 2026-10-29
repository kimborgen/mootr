package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// The `retro` and `feedback` MCP tools and `stam retro` (src/retro.ts, src/feedback.ts): an agent files a retro item
// under the standing Retros parent, or a feedback report under Feedback, searches the open ones, +1s one, or records its
// final round. They ask the daemon what the TS module asks, in the same order, and say what it says. API is the daemon
// call, so the MCP server and the CLI share them and a test can stand in for the daemon.

// API is one daemon call: method, path, body (nil for none) and timeout (0 for the default), answering the reply.
type API func(ctx context.Context, method, path string, body any, timeout time.Duration) (jsfmt.Value, error)

func init() {
	tools = append(tools,
		tool{name: "feedback", listing: retroListings["feedback"], run: feedbackTool},
		tool{name: "retro", listing: retroListings["retro"], run: retroTool},
	)
}

const (
	stamIssueKind   = "stam_issue"
	retroParentKind = "retros"
	retroKind       = "retro"
	reportKind      = "feedback-report"
	feedbackKind    = "feedback"
	maxHits         = 3
	maxCandidates   = 150
	coverageWeight  = 4
)

var (
	retroKinds    = []string{"went_well", "improve", "idea", "instruction"}
	evidenceKinds = []string{"human", "gate", "review", "rollback", "measured", "none"}
	feedbackKinds = []string{"bug", "inconsistency", "missing_param", "missing_feature", "other"}
	effortKeys    = []string{"reading", "implementing", "testing", "waiting", "review_fixes", "coordination"}
	notWork       = []string{retroKind, retroParentKind, reportKind, feedbackKind}
	stopwords     = map[string]bool{}

	reSpaces   = regexp.MustCompile(`[` + jsSpace + `]+`)
	reNonAlnum = regexp.MustCompile(`[^a-z0-9]+`)
	// headerLine is `Name: value`; JS's `.` stops at \r, U+2028 and U+2029, so a line holding one isn't a header.
	reHeaderLine = regexp.MustCompile(`^([A-Za-z][A-Za-z-]*): ([^\r\x{2028}\x{2029}]*)$`)
	reBlankSplit = regexp.MustCompile(`\n[` + jsSpace + `]*\n`)
	reHeadLines  = regexp.MustCompile(`^(?:[A-Z][A-Za-z]*: [^\n\r\x{2028}\x{2029}]*\n)+\n?`)
)

func init() {
	for _, w := range strings.Fields("a an the is are was were be been it its this that these those of to in on at by for from with and or but not no nor so as if then than use used using do does did can could should would will we you i my our your there here") {
		stopwords[w] = true
	}
}

func oneOf(v string, list []string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// collapse is .replace(/\s+/g, ' ').trim().
func collapse(s string) string { return jsTrim(reSpaces.ReplaceAllString(s, " ")) }

// normalize is src/feedback.ts normalize: summaries match when they read the same once case and punctuation are dropped.
func normalize(s string) string {
	return strings.TrimSpace(reNonAlnum.ReplaceAllString(strings.ToLower(s), " "))
}

func wordsOf(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Split(normalize(s), " ") {
		if w != "" {
			out[w] = true
		}
	}
	return out
}

// headerOf is src/retro.ts headerOf: the `Name: value` lines before the first blank line, the last one winning.
func headerOf(body string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		if jsTrim(line) == "" {
			break
		}
		if m := reHeaderLine.FindStringSubmatch(line); m != nil {
			out[m[1]] = jsTrim(m[2])
		}
	}
	return out
}

// RetroHeader is src/retro.ts headerFields without its details: an item's metadata, read only from its header, with an
// absent line's default (how an old item without one reads).
type RetroHeader struct{ Kind, Target, Evidence, When string }

// HeaderFields is src/retro.ts headerFields, which the digest and the Retros view read an item with.
func HeaderFields(body string) RetroHeader {
	h := headerOf(body)
	or := func(v, def string) string {
		if v == "" {
			return def
		}
		return v
	}
	return RetroHeader{Kind: or(h["Kind"], "none"), Target: or(h["Target"], or(h["Tool"], "none")), Evidence: or(h["Evidence"], "none"), When: h["When"]}
}

// Header is src/retro.ts headerOf: a body's header lines by name.
func Header(body string) map[string]string { return headerOf(body) }

// IsJSSpace is whether r is in JS's \s.
func IsJSSpace(r rune) bool { return isJSSpace(r) }

// JSSpace is JS's \s as the inside of a regexp class.
const JSSpace = jsSpace

// headerKind is the Kind line of a body, or "none".
func headerKind(body string) string {
	if k := headerOf(body)["Kind"]; k != "" {
		return k
	}
	return "none"
}

// headerDetails is the text after the header: everything past the first blank line.
func headerDetails(body string) string {
	parts := reBlankSplit.Split(body, -1)
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts[1:], "\n\n")
}

// firstDetail is the first line of a body's details, after the header lines.
func firstDetail(body string) string {
	for _, l := range strings.Split(reHeadLines.ReplaceAllString(body, ""), "\n") {
		if t := jsTrim(l); t != "" {
			return t
		}
	}
	return ""
}

// given is an argument as text, and whether it was given (neither undefined nor null).
func given(a jsfmt.Value, k string) (string, bool) {
	v, ok := a.Get(k)
	if !ok || v.Kind == jsfmt.Null {
		return "", false
	}
	return jsString(v), true
}

func textOf(a jsfmt.Value, k string) string {
	s, _ := given(a, k)
	return s
}

func obj(kv ...any) jsfmt.Value {
	o := jsfmt.Value{Kind: jsfmt.Object}
	for i := 0; i+1 < len(kv); i += 2 {
		switch v := kv[i+1].(type) {
		case string:
			o.Set(kv[i].(string), jsfmt.StringValue(v))
		case jsfmt.Value:
			o.Set(kv[i].(string), v)
		case nil:
		default:
			panic(fmt.Sprintf("obj: %T", v))
		}
	}
	return o
}

func items(v jsfmt.Value) []jsfmt.Value {
	if v.Kind == jsfmt.Array {
		return v.Items
	}
	return nil
}

// standingParent is src/retro.ts retroParent and src/feedback.ts feedbackParent: found by its kind and title, or
// created on first use under the root of S-1's tree when S-1 exists, else as a root.
func standingParent(ctx context.Context, call API, by, kind, title, summary string) (jsfmt.Value, error) {
	list, err := call(ctx, "GET", "/api/itsas?kind="+kind, nil, 0)
	if err != nil {
		return jsfmt.Value{}, err
	}
	for _, x := range items(list) {
		if t, ok := x.Get("title"); ok && t.Kind == jsfmt.String && t.Str == title {
			return x, nil
		}
	}
	// s1.parent_chain?.[0]?.id ?? s1.id; an undefined parent is left out of the body.
	var parent jsfmt.Value
	hasParent := false
	if s1, err := call(ctx, "GET", "/api/itsas/S-1", nil, 0); err == nil {
		if chain, ok := s1.Get("parent_chain"); ok && len(items(chain)) > 0 {
			parent, hasParent = chain.Items[0].Get("id")
			hasParent = hasParent && parent.Kind != jsfmt.Null
		}
		if !hasParent {
			parent, hasParent = s1.Get("id")
		}
	}
	body := obj("title", title, "summary", summary, "kind", kind)
	if hasParent {
		body.Set("parent", parent)
	}
	body.Set("by", jsfmt.StringValue(by))
	return call(ctx, "POST", "/api/itsas", raw(body), 0)
}

// reporterOf is the reporter as a body names it: `NAME (model, type)`, the parts it has.
func reporterOf(ctx context.Context, call API, by string) (name, label string, err error) {
	var p params
	p.set("as", by)
	p.set("ids", by)
	list, err := call(ctx, "GET", "/api/agents?"+p.String(), nil, 0)
	if err != nil {
		return "", "", err
	}
	name = by
	var extra []string
	for _, a := range items(list) {
		if a.Text("id") != by || !a.Truthy() {
			continue
		}
		if n, ok := a.Get("name"); ok && n.Kind != jsfmt.Null {
			name = jsString(n)
		}
		for _, k := range []string{"model", "type"} {
			if truthyMember(a, k) {
				extra = append(extra, member(a, k))
			}
		}
		break
	}
	if len(extra) > 0 {
		return name, fmt.Sprintf("%s (%s)", name, strings.Join(extra, ", ")), nil
	}
	return name, name, nil
}

func plusOnes(ctx context.Context, call API, id string) (int, error) {
	r, err := call(ctx, "GET", "/api/itsas/"+id+"/plus-ones", nil, 0)
	if err != nil {
		return 0, err
	}
	c, _ := r.Get("count")
	return jsCount(c), nil
}

// jsCount is Number(count) || 0 for a count.
func jsCount(v jsfmt.Value) int {
	switch v.Kind {
	case jsfmt.Number:
		f, _ := strconv.ParseFloat(v.Num, 64)
		if math.IsNaN(f) {
			return 0
		}
		return int(f)
	case jsfmt.String:
		f, err := strconv.ParseFloat(strings.TrimSpace(v.Str), 64)
		if err != nil {
			return 0
		}
		return int(f)
	case jsfmt.Bool:
		if v.Bool {
			return 1
		}
	}
	return 0
}

// plusOnesOrNull is the count, or -1 for an item the count route refuses (403) or a daemon without it (404).
func plusOnesOrNull(ctx context.Context, call API, id string) (int, error) {
	n, err := plusOnes(ctx, call, id)
	var ce *client.Error
	if errors.As(err, &ce) && (ce.Status == 403 || ce.Status == 404) {
		return -1, nil
	}
	return n, err
}

func countText(n int) string {
	if n == 1 {
		return "1 +1"
	}
	return fmt.Sprintf("%d +1s", n)
}

// fileRetro files a retro item, with the open ITSA the reporter is most recently active on named as `On`.
func fileRetro(ctx context.Context, call API, by string, a jsfmt.Value) (string, error) {
	kind := textOf(a, "kind")
	if !oneOf(kind, retroKinds) {
		return "", fmt.Errorf("kind must be one of %s", strings.Join(retroKinds, ", "))
	}
	summary := collapse(textOf(a, "summary"))
	if summary == "" {
		return "", errors.New("summary is required")
	}
	title := collapse(textOf(a, "title"))
	if title == "" {
		title = summary
	}
	details := jsTrim(textOf(a, "details"))
	if details == "" {
		return "", errors.New("details is required")
	}
	target := collapse(textOf(a, "target"))
	if target == "" {
		target = "none"
	}
	if (kind == "improve" || kind == "instruction") && strings.ToLower(target) == "none" {
		return "", errors.New("target is required for improve and instruction items: name the template, block, tool, script or file the lesson is about, so the steward can route it. Examples: type-reviewer, blocks/type-manager/30-manager-mail-wait.md, web/check/phone.mjs, pr_merge, pr_open.")
	}
	evidence := jsTrim(textOf(a, "evidence"))
	if evidence == "" {
		evidence = "none"
	}
	if !oneOf(evidence, evidenceKinds) {
		return "", fmt.Errorf("evidence must be one of %s", strings.Join(evidenceKinds, ", "))
	}
	evidenceDetail := collapse(textOf(a, "evidence_detail"))
	when := collapse(textOf(a, "when"))
	parent, err := standingParent(ctx, call, by, retroParentKind, "Retros", "How the work went, as agents report it. Search here before filing a new item.")
	if err != nil {
		return "", err
	}
	_, label, err := reporterOf(ctx, call, by)
	if err != nil {
		return "", err
	}
	// The work the reporter is on, not the standing items: filed retros and reports stay open as the reporter's own.
	list, err := call(ctx, "GET", "/api/itsas?participant="+uriComponent(by), nil, 0)
	if err != nil {
		return "", err
	}
	var mine []jsfmt.Value
	for _, x := range items(list) {
		if !truthyMember(x, "closed_at") && !oneOf(x.Text("kind"), notWork) {
			mine = append(mine, x)
		}
	}
	sort.SliceStable(mine, func(i, j int) bool { return mine[i].Text("updated_at") > mine[j].Text("updated_at") })
	lines := []string{"Kind: " + kind, "Target: " + target, "Evidence: " + evidence}
	if evidenceDetail != "" {
		lines = append(lines, "Detail: "+evidenceDetail)
	}
	if when != "" {
		lines = append(lines, "When: "+when)
	}
	lines = append(lines, "Reporter: "+label)
	if len(mine) > 0 && truthyMember(mine[0], "key") {
		lines = append(lines, "On: "+member(mine[0], "key"))
	}
	lines = append(lines, "", details)
	pid, _ := parent.Get("id")
	body := obj("title", title, "summary", summary, "body", strings.Join(lines, "\n"), "kind", retroKind, "status", "idea", "parent", pid,
		"participants", jsfmt.ArrayValue([]jsfmt.Value{jsfmt.StringValue(by)}), "by", by)
	x, err := call(ctx, "POST", "/api/itsas", raw(body), 0)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Filed %s \"%s\" [idea] under Retros.", member(x, "key"), title), nil
}

// meaningHits is the meaning search, one call, or nil when the embedder isn't ready (the route answered by keyword) or
// the route failed: the caller then uses word overlap alone.
func meaningHits(ctx context.Context, call API, words string) []jsfmt.Value {
	var p params
	p.set("q", words)
	p.set("limit", strconv.Itoa(maxCandidates))
	p.set("kind", retroKind+","+reportKind)
	p.set("open", "1")
	hits, err := call(ctx, "GET", "/api/itsas/search?"+p.String(), nil, 0)
	if err != nil || hits.Kind != jsfmt.Array {
		return nil
	}
	if len(hits.Items) > 0 && member(hits.Items[0], "by") != "meaning" {
		return nil
	}
	return hits.Items
}

// numberOr0 is Number(v) || 0.
func numberOr0(v jsfmt.Value, ok bool) float64 {
	if !ok {
		return 0
	}
	var f float64
	switch v.Kind {
	case jsfmt.Number:
		f, _ = strconv.ParseFloat(v.Num, 64)
	case jsfmt.String:
		var err error
		if f, err = strconv.ParseFloat(strings.TrimSpace(v.Str), 64); err != nil {
			return 0
		}
	case jsfmt.Bool:
		if v.Bool {
			f = 1
		}
	}
	if math.IsNaN(f) {
		return 0
	}
	return f
}

// searchRetros is src/retro.ts searchRetros: open retro items and feedback reports nearest the query, up to three. An
// item scores its cosine from the meaning search plus the squared share of the query's words it covers, each weighted
// by how rare it is, counted fully in the title or summary and half in the details. A match whose count the daemon
// refuses is skipped.
func searchRetros(ctx context.Context, call API, words string) (string, error) {
	var all []string
	for _, w := range strings.Split(normalize(words), " ") {
		if w != "" && !oneOf(w, all) {
			all = append(all, w)
		}
	}
	if len(all) == 0 {
		return "", errors.New("search needs at least one word")
	}
	var want []string
	for _, w := range all {
		if !stopwords[w] {
			want = append(want, w)
		}
	}
	if len(want) == 0 {
		want = all
	}
	var rows []jsfmt.Value
	for _, k := range []string{retroKind, reportKind} {
		list, err := call(ctx, "GET", "/api/itsas?kind="+k, nil, 0)
		if err != nil {
			return "", err
		}
		for _, x := range items(list) {
			if !truthyMember(x, "closed_at") {
				rows = append(rows, x)
			}
		}
	}
	cosine := map[string]float64{}
	for _, h := range meaningHits(ctx, call, words) {
		c, ok := h.Get("cosine")
		if !ok || c.Kind == jsfmt.Null {
			c, ok = h.Get("score")
		}
		cosine[h.Text("id")] = numberOr0(c, ok)
	}
	head := make([]map[string]bool, len(rows))
	rest := make([]map[string]bool, len(rows))
	for i, x := range rows {
		head[i] = wordsOf(member(x, "title") + " " + textOf(x, "summary"))
		rest[i] = wordsOf(headerDetails(textOf(x, "body")))
	}
	idf := map[string]float64{}
	total := 0.0
	for _, w := range want {
		n := 0
		for i := range rows {
			if head[i][w] || rest[i][w] {
				n++
			}
		}
		idf[w] = math.Log(1 + float64(len(rows))/float64(1+n))
		total += idf[w]
	}
	if total == 0 {
		total = 1
	}
	type hit struct {
		x          jsfmt.Value
		cos, score float64
		covered    float64
	}
	var ranked []hit
	for i, x := range rows {
		cov := 0.0
		for _, w := range want {
			switch {
			case head[i][w]:
				cov += idf[w]
			case rest[i][w]:
				cov += idf[w] * 0.5
			}
		}
		cov /= total
		c := cosine[x.Text("id")]
		if c > 0 || cov > 0 {
			ranked = append(ranked, hit{x, c, c + coverageWeight*cov*cov, cov})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return member(ranked[i].x, "key") < member(ranked[j].x, "key")
	})
	var lines []string
	byMeaning := false
	for _, h := range ranked {
		if len(lines) >= maxHits {
			break
		}
		n, err := plusOnesOrNull(ctx, call, member(h.x, "id"))
		if err != nil {
			return "", err
		}
		if n < 0 {
			continue
		}
		if h.cos > 0 {
			byMeaning = true
		}
		body := textOf(h.x, "body")
		line := fmt.Sprintf("%s \"%s\" [%s] · Kind: %s · %s", member(h.x, "key"), member(h.x, "title"), member(h.x, "status"), headerKind(body), countText(n))
		if d := firstDetail(body); d != "" {
			line += " · " + d
		}
		lines = append(lines, line)
	}
	if len(lines) == 0 {
		return fmt.Sprintf("No open retro items or feedback reports match \"%s\". File yours with kind, title, summary and details.", words), nil
	}
	how := "keyword"
	if byMeaning {
		how = "meaning and words"
	}
	return "Ranked by " + how + ".\n" + strings.Join(lines, "\n"), nil
}

// plusOne is a +1 on a retro item or feedback report: a comment with the reporter's scenario, which also makes the
// reporter a participant.
func plusOne(ctx context.Context, call API, by, key, details string) (string, error) {
	d := jsTrim(details)
	if d == "" {
		return "", errors.New("details is required")
	}
	x, err := call(ctx, "GET", "/api/itsas/"+uriComponent(key), nil, 0)
	if err != nil {
		return "", err
	}
	if k := x.Text("kind"); k != retroKind && k != reportKind {
		return "", fmt.Errorf("%s is not a retro item or feedback report", member(x, "key"))
	}
	name, _, err := reporterOf(ctx, call, by)
	if err != nil {
		return "", err
	}
	body := fmt.Sprintf("+1 from %s: %s", name, d)
	id, _ := x.Get("id")
	post := obj("by", by, "body", body, "client_id", writeID(jsfmt.StringValue("post"), jsfmt.StringValue(by), id, jsfmt.StringValue(body)))
	if _, err := call(ctx, "POST", "/api/itsas/"+member(x, "id")+"/post", raw(post), client.WriteTimeout); err != nil {
		return "", err
	}
	// The +1 has landed, so a count read that fails must not turn it into an error (S-796).
	n, err := plusOnes(ctx, call, member(x, "id"))
	if err != nil {
		return fmt.Sprintf("+1 on %s \"%s\": the +1 landed, but its count couldn't be read.", member(x, "key"), member(x, "title")), nil
	}
	return fmt.Sprintf("+1 on %s \"%s\": %s now.", member(x, "key"), member(x, "title"), countText(n)), nil
}

// finalRound is the final round: the agent's effort split, stored as a retro_final event on the agent.
func finalRound(ctx context.Context, call API, by string, effort jsfmt.Value, given bool) (string, error) {
	if !given || !effort.Truthy() || (effort.Kind != jsfmt.Object && effort.Kind != jsfmt.Array) {
		return "", fmt.Errorf("effort is required: percentages over %s", strings.Join(effortKeys, ", "))
	}
	keys := effort.Keys
	if effort.Kind == jsfmt.Array {
		keys = make([]string, len(effort.Items))
		for i := range keys {
			keys[i] = strconv.Itoa(i)
		}
	}
	clean := jsfmt.Value{Kind: jsfmt.Object}
	var shown []string
	for i, k := range keys {
		if !oneOf(k, effortKeys) {
			return "", fmt.Errorf("effort %s is not one of %s", k, strings.Join(effortKeys, ", "))
		}
		v := effort.Items[i]
		f, err := strconv.ParseFloat(v.Num, 64)
		if v.Kind != jsfmt.Number || err != nil || math.IsInf(f, 0) || math.IsNaN(f) || f < 0 || f > 100 {
			return "", fmt.Errorf("effort %s must be a percentage from 0 to 100", k)
		}
		clean.Set(k, v)
		shown = append(shown, fmt.Sprintf("%s %s%%", k, jsfmt.Compact(v)))
	}
	if _, err := call(ctx, "POST", "/api/agents/"+uriComponent(by)+"/retro-final", raw(obj("by", by, "effort", clean)), 0); err != nil {
		return "", err
	}
	list := strings.Join(shown, ", ")
	if list == "" {
		list = "no effort"
	}
	return fmt.Sprintf("Recorded the final retro round for %s: %s.", by, list), nil
}

// toolOf is the tool a report names, as its body says it (`Tool: x`, a line of its own), or "none".
func toolOf(body string) string {
	for _, line := range strings.FieldsFunc(body, func(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }) {
		if rest, ok := strings.CutPrefix(line, "Tool: "); ok {
			if t := jsTrim(rest); t != "" {
				return t
			}
			return "none"
		}
	}
	return "none"
}

// fileFeedback is src/feedback.ts report: files a report, or comments on the open report it repeats.
func fileFeedback(ctx context.Context, call API, by, kind, title, summary, details, tool string) (string, error) {
	if !oneOf(kind, feedbackKinds) {
		return "", fmt.Errorf("kind must be one of %s", strings.Join(feedbackKinds, ", "))
	}
	summary = collapse(summary)
	if summary == "" {
		return "", errors.New("summary is required")
	}
	if title = collapse(title); title == "" {
		title = summary
	}
	if tool = jsTrim(tool); tool == "" {
		tool = "none"
	}
	parent, err := standingParent(ctx, call, by, feedbackKind, "Feedback", "Problems agents report with stam and its MCP tools.")
	if err != nil {
		return "", err
	}
	pid := member(parent, "id")
	open, err := call(ctx, "GET", "/api/itsas?parent="+pid+"&kind="+reportKind, nil, 0)
	if err != nil {
		return "", err
	}
	for _, row := range items(open) {
		if truthyMember(row, "closed_at") {
			continue
		}
		// On the summary alone: short titles can repeat across different bugs, and an old row's summary equals its title.
		s, ok := row.Get("summary")
		if !ok || s.Kind == jsfmt.Null {
			s, ok = row.Get("title")
		}
		if normalize(str(s, ok)) != normalize(summary) {
			continue
		}
		full, err := call(ctx, "GET", "/api/itsas/"+member(row, "id"), nil, 0)
		if err != nil {
			return "", err
		}
		if toolOf(textOf(full, "body")) != tool {
			continue
		}
		if _, err := call(ctx, "POST", "/api/itsas/"+member(row, "id")+"/post", raw(obj("by", by, "body", "Reported again by "+by+":\n\n"+details)), 0); err != nil {
			return "", err
		}
		return fmt.Sprintf("Already reported as %s \"%s\"; added your report there as a comment.", member(row, "key"), member(row, "title")), nil
	}
	// The screen a named screen event carries (S-2679), read before filing: a read that fails files the report without it.
	lines := []string{"Kind: " + kind, "Tool: " + tool, "Reporter: " + by, "", details}
	if screens := screenSection(ctx, call, details); screens != "" {
		lines = append(lines, "", screens)
	}
	pv, _ := parent.Get("id")
	x, err := call(ctx, "POST", "/api/itsas", raw(obj("title", title, "summary", summary, "body", strings.Join(lines, "\n"), "kind", reportKind, "parent", pv,
		"participants", jsfmt.ArrayValue([]jsfmt.Value{jsfmt.StringValue(by)}), "by", by)), 0)
	if err != nil {
		return "", err
	}
	c, err := call(ctx, "GET", "/api/chief-of-staff", nil, 0)
	if err != nil {
		return "", err
	}
	told := ""
	if cos, ok := c.Get("chiefOfStaff"); ok && cos.Truthy() {
		on := ""
		if tool != "none" {
			on = " on `" + tool + "`"
		}
		mail := obj("from", by, "to", jsfmt.ArrayValue([]jsfmt.Value{cos}), "subject", fmt.Sprintf("Feedback %s: %s", member(x, "key"), title),
			"body", fmt.Sprintf("%s reported%s: %s. Details are in %s.", kind, on, summary, member(x, "key")), "itsa", member(x, "key"), "new_thread", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
		if _, err := call(ctx, "POST", "/api/mail", raw(mail), 0); err != nil {
			return "", err
		}
		told = ", and told the chief of staff"
	}
	return fmt.Sprintf("Filed %s \"%s\" [backlog] under Feedback%s.", member(x, "key"), title, told), nil
}

// RunRetro is src/retro.ts runRetro, the one entry point for the tools and `stam retro`: the final round, a stam
// issue, a search, a +1, or a new item, by which field is given.
func RunRetro(ctx context.Context, call API, by string, a jsfmt.Value) (string, error) {
	if f, ok := a.Get("final"); ok && f.Truthy() {
		effort, given := a.Get("effort")
		return finalRound(ctx, call, by, effort, given && effort.Kind != jsfmt.Null)
	}
	if textOf(a, "kind") == stamIssueKind {
		return fileFeedback(ctx, call, by, textOf(a, "feedback_kind"), textOf(a, "title"), textOf(a, "summary"), textOf(a, "details"), textOf(a, "tool"))
	}
	if s := textOf(a, "search"); jsTrim(s) != "" {
		return searchRetros(ctx, call, s)
	}
	if k := jsTrim(textOf(a, "plus_one")); k != "" {
		return plusOne(ctx, call, by, k, textOf(a, "details"))
	}
	return fileRetro(ctx, call, by, a)
}

// daemonCall is the server's daemon call as an API.
func (s *Server) daemonCall(ctx context.Context, method, path string, body any, timeout time.Duration) (jsfmt.Value, error) {
	return s.apiJSONTimeout(ctx, method, path, body, timeout)
}

func retroTool(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	return RunRetro(ctx, s.daemonCall, me, a)
}

// feedbackTool is the feedback tool, an alias of retro with kind=stam_issue.
func feedbackTool(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	return feedbackRun(ctx, s.daemonCall, me, a)
}

// feedbackRun is the feedback tool's runRetro call: its kind is the report's feedback_kind.
func feedbackRun(ctx context.Context, call API, me string, a jsfmt.Value) (string, error) {
	args := jsfmt.Value{Kind: jsfmt.Object}
	args.Set("kind", jsfmt.StringValue(stamIssueKind))
	for _, k := range [][2]string{{"feedback_kind", "kind"}, {"title", "title"}, {"summary", "summary"}, {"details", "details"}, {"tool", "tool"}} {
		if v, ok := a.Get(k[1]); ok {
			args.Set(k[0], v)
		}
	}
	return RunRetro(ctx, call, me, args)
}
