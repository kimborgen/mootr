package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"strconv"
	"strings"
	"time"

	"stam/internal/jsfmt"
)

// The permission, ring, wait and requirement tools of src/mcp.ts (S-4154): request_permission, suggest_input,
// answer_permission, ring_create, ring_submit, ring_decide, wait_for, wait_done, wake_me, and the req_* tools, which are
// listed only while requirements are on. The daemon judges who may; these send what the TS tools send and say what they
// say. A path segment TS writes with a template literal is escaped here, so an argument can't reach another route.

const (
	// ringCreateCall is the TS ring_create's 120 s call: starting a ring spawns its members.
	ringCreateCall = 120 * time.Second
	// reqCheckCall and reqPreviewCall are the TS req_check's 60 s check and 120 s preview: a model answers.
	reqCheckCall   = 60 * time.Second
	reqPreviewCall = 120 * time.Second
)

func init() {
	for _, n := range []string{"request_permission", "suggest_input", "answer_permission", "ring_create", "ring_submit", "ring_decide", "wait_for", "wait_done", "wake_me"} {
		tools = append(tools, tool{name: n, listing: reqringListings[n], run: reqringRuns[n]})
	}
	for _, n := range []string{"req_create", "req_get", "req_set", "req_check", "req_waive"} {
		tools = append(tools, tool{name: n, listing: reqringListings[n], run: reqringRuns[n], when: "requirements"})
	}
}

var reqringRuns = map[string]func(context.Context, *Server, jsfmt.Value) (string, error){
	"request_permission": requestPermission, "suggest_input": suggestInput, "answer_permission": answerPermission,
	"ring_create": ringCreate, "ring_submit": ringSubmit, "ring_decide": ringDecide,
	"wait_for": waitFor, "wait_done": waitDone, "wake_me": wakeMe,
	"req_create": reqCreate, "req_get": reqGet, "req_set": reqSet, "req_check": reqCheck, "req_waive": reqWaive,
}

// seg is a `${a[key]}` path segment, escaped: a missing member is "undefined", as the template writes it.
func seg(a jsfmt.Value, key string) string { return url.PathEscape(tpl(a, key)) }

// tpl is `${x[key]}`: String() of the member, "undefined" when it is absent.
func tpl(x jsfmt.Value, key string) string {
	v, ok := x.Get(key)
	if !ok {
		return "undefined"
	}
	return jsString(v)
}

// orText is `${x[key] ?? fallback}`.
func orText(x jsfmt.Value, key, fallback string) string {
	if v, ok := x.Get(key); ok && v.Kind != jsfmt.Null {
		return jsString(v)
	}
	return fallback
}

// hasLength is `x[key]?.length` as a condition: a non-empty array or string.
func hasLength(x jsfmt.Value, key string) bool {
	v, ok := x.Get(key)
	return ok && (v.Kind == jsfmt.Array && len(v.Items) > 0 || v.Kind == jsfmt.String && v.Str != "")
}

// spread is `{...a, self: undefined, ...extra}`: the arguments in their order without self, each extra set in place or
// appended.
func spread(a jsfmt.Value, extra ...string) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range a.Keys {
		if k != "self" {
			out.Set(k, a.Items[i])
		}
	}
	for i := 0; i+1 < len(extra); i += 2 {
		out.Set(extra[i], jsfmt.StringValue(extra[i+1]))
	}
	return out
}

// askHome is askHomeArgs: thread, itsa and override, each left out when not passed.
func askHome(body *jsfmt.Value, a jsfmt.Value) {
	for _, k := range []string{"thread", "itsa", "override"} {
		if v, ok := a.Get(k); ok {
			body.Set(k, v)
		}
	}
}

// hinted is the daemon's hint when the ask found no home thread (it went to a new one).
func hinted(r jsfmt.Value) string {
	if truthyMember(r, "hint") {
		return " It found no home thread, so it went to a new one. " + tpl(r, "hint")
	}
	return ""
}

func requestPermission(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("agent", jsfmt.StringValue(me))
	copyIf(&body, a, "action", "reason")
	// details: a.details ?? ''
	if v, ok := a.Get("details"); ok && v.Kind != jsfmt.Null {
		body.Set("details", v)
	} else {
		body.Set("details", jsfmt.StringValue(""))
	}
	copyIf(&body, a, "audience")
	askHome(&body, a)
	r, err := s.apiJSON(ctx, "POST", "/api/permissions", raw(body))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Request %s sent. You'll get a notice with the answer.%s", tpl(r, "id"), hinted(r)), nil
}

func suggestInput(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("self", jsfmt.StringValue(me))
	copyIf(&body, a, "text", "reason")
	askHome(&body, a)
	r, err := s.apiJSON(ctx, "POST", "/api/suggest-input", raw(body))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Suggestion %s sent to your user; waits until your user answers it. You'll get a notice when it is typed, held, or expired.%s", tpl(r, "id"), hinted(r)), nil
}

func answerPermission(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	approve, hasApprove := a.Get("approve")
	if !truthyMember(a, "decision") && !(hasApprove && approve.Kind == jsfmt.Bool) {
		return "", errors.New("say decision: approve, deny or escalate")
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	copyIf(&body, a, "decision", "approve", "note")
	r, err := s.apiJSON(ctx, "POST", "/api/permissions/"+seg(a, "id")+"/answer", raw(body))
	if err != nil {
		return "", err
	}
	if d, ok := a.Get("decision"); ok && d.Kind == jsfmt.String && d.Str == "escalate" {
		return fmt.Sprintf("Request %s is escalated to the human.", tpl(r, "id")), nil
	}
	return fmt.Sprintf("Request %s is now %s.", tpl(r, "id"), tpl(r, "status")), nil
}

// copyIf copies each member that is there, null included, as `{k: a.k}` keeps it.
func copyIf(out *jsfmt.Value, a jsfmt.Value, keys ...string) {
	for _, k := range keys {
		if v, ok := a.Get(k); ok {
			out.Set(k, v)
		}
	}
}

func ringCreate(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	cwd, err := s.cwd()
	if err != nil {
		return "", err
	}
	r, err := s.apiJSONTimeout(ctx, "POST", "/api/rings", raw(spread(a, "by", me, "cwd", cwd)), ringCreateCall)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Ring %s (%s) started. You'll get its result by mail.", tpl(r, "name"), tpl(r, "id")), nil
}

// ringSubmitKeys are ring_submit's parameters: any other one would post an empty verdict with no findings (S-1919).
var ringSubmitKeys = []string{"self", "ring", "text", "agree", "verdict", "round", "seat"}

func ringSubmit(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	var unknown []string
	for _, k := range a.Keys {
		if !contains(ringSubmitKeys, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		return "", fmt.Errorf("ring_submit has no parameter %s: put your findings in text", strings.Join(unknown, ", "))
	}
	if t, ok := a.Get("text"); !ok || t.Kind != jsfmt.String || jsTrim(t.Str) == "" {
		return "", errors.New("text is required: your findings for the ring, as a non-empty string")
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	copyIf(&body, a, "text", "agree", "verdict", "round", "seat")
	r, err := s.apiJSON(ctx, "POST", "/api/rings/"+seg(a, "ring")+"/submit", raw(body))
	if err != nil {
		return "", err
	}
	return tpl(r, "result"), nil
}

func ringDecide(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	copyIf(&body, a, "continue", "text")
	r, err := s.apiJSON(ctx, "POST", "/api/rings/"+seg(a, "ring")+"/decide", raw(body))
	if err != nil {
		return "", err
	}
	return tpl(r, "result"), nil
}

// waitForKeys are wait_for's parameters. Only these go to the daemon, and an unknown one is named rather than sent: the
// daemon reads `from` as the identity a request acts as (S-302).
var waitForKeys = []string{"self", "on", "target", "thread", "filter", "timeout_minutes", "expect_minutes", "note", "rest"}

func waitFor(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	var unknown []string
	for _, k := range a.Keys {
		if !contains(waitForKeys, k) {
			unknown = append(unknown, "'"+k+"'")
		}
	}
	if len(unknown) > 0 {
		return "", fmt.Errorf("wait_for has no parameter %s; its parameters are on, target (the agent to wait for, an id or name), thread, filter, timeout_minutes, expect_minutes, note, rest", strings.Join(unknown, ", "))
	}
	if on, ok := a.Get("on"); ok && on.Kind == jsfmt.String && on.Str == "agent" && !truthyMember(a, "target") {
		return "", errors.New("wait_for on 'agent' needs target (an agent id or name)")
	}
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	copyIf(&body, a, "on", "target", "thread", "filter", "timeout_minutes", "expect_minutes", "note", "rest")
	body.Set("by", jsfmt.StringValue(me))
	w, err := s.apiJSON(ctx, "POST", "/api/agents/"+url.PathEscape(me)+"/waits/declared", raw(body))
	if err != nil {
		return "", err
	}
	until := ""
	if truthyMember(w, "until") {
		until = ", timing out at " + tpl(w, "until")
	}
	tied := ""
	if k, ok := w.Get("kind"); ok && k.Kind == jsfmt.String && k.Str == "human" && truthyMember(w, "target") {
		tied = fmt.Sprintf(" It is tied to %s, so it clears when that is answered or closed.", tpl(w, "target"))
	}
	return fmt.Sprintf("Waiting (%s) for %s%s.%s Clear it with wait_done %s.", tpl(w, "id"), tpl(w, "detail"), until, tied, tpl(w, "id")), nil
}

func waitDone(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	copyIf(&body, a, "id")
	body.Set("by", jsfmt.StringValue(me))
	r, err := s.apiJSON(ctx, "POST", "/api/agents/"+url.PathEscape(me)+"/waits/done", raw(body))
	if err != nil {
		return "", err
	}
	if truthyMember(r, "cleared") {
		return fmt.Sprintf("Cleared wait %s.", tpl(a, "id")), nil
	}
	return fmt.Sprintf("No wait %s of yours to clear.", tpl(a, "id")), nil
}

func wakeMe(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	w, err := s.apiJSON(ctx, "POST", "/api/agents/"+url.PathEscape(me)+"/waits/wake", raw(spread(a, "by", me)))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Wake-up (%s) set for %s. Clear it with wait_done %s.", tpl(w, "id"), tpl(w, "until"), tpl(w, "id")), nil
}

// reqFields are the requirement fields req_create and req_set pass on as given.
var (
	reqCreateFields = []string{"title", "text", "rationale", "source", "parent", "level", "severity", "mode", "threshold", "verification", "scope", "owner"}
	reqSetFields    = []string{"title", "text", "rationale", "source", "parent", "level", "severity", "mode", "threshold", "status", "owner", "verification", "scope"}
)

func reqCreate(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	copyIf(&body, a, reqCreateFields...)
	r, err := s.apiJSON(ctx, "POST", "/api/requirements", raw(body))
	if err != nil {
		return "", err
	}
	ask := ""
	if ap, ok := r.Get("approval"); ok {
		switch {
		case truthyMember(ap, "itsa"):
			who := "Your user will approve it"
			if to, _ := ap.Get("to"); to.Kind == jsfmt.String && to.Str == "chief of staff" {
				who = "The chief of staff will approve it"
			}
			ask = fmt.Sprintf("%s: ask %s.", who, tpl(ap, "itsa"))
		case truthyMember(ap, "error"):
			ask = fmt.Sprintf("No ask reached your user (%s); tell your parent so it gets approved.", tpl(ap, "error"))
		}
	}
	return jsTrim(fmt.Sprintf("Created %s \"%s\" as a draft. %s", tpl(r, "key"), tpl(r, "title"), ask)), nil
}

// verdictWord is the req_check words for a verdict; another verdict is shown as it is.
var verdictWord = map[string]string{"violates": "likely violates", "conforms": "likely conforms", "na": "likely not applicable", "unsure": "unsure"}

func wordFor(x jsfmt.Value) string {
	if v, ok := x.Get("verdict"); ok && v.Kind == jsfmt.String {
		if w, ok := verdictWord[v.Str]; ok {
			return w
		}
	}
	return tpl(x, "verdict")
}

// pViolates is `${x.p_violates != null ? ` (p violates ${Number(x.p_violates).toFixed(2)})` : ”}`.
func pViolates(x jsfmt.Value) string {
	v, ok := x.Get("p_violates")
	if !ok || v.Kind == jsfmt.Null {
		return ""
	}
	return " (p violates " + toFixed(jsNumberOf(v), 2) + ")"
}

func reqGet(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	if truthyMember(a, "key") {
		k, _ := a.Get("key")
		r, err := s.apiJSON(ctx, "GET", "/api/requirements/"+uriComponent(jsTrim(jsString(k))), nil)
		if err != nil {
			return "", err
		}
		out := []string{
			fmt.Sprintf("%s \"%s\" [%s] severity %s, mode %s, threshold %s, version %s, rev %s, owner %s", tpl(r, "key"), tpl(r, "title"), tpl(r, "status"),
				tpl(r, "severity"), tpl(r, "mode"), tpl(r, "threshold"), tpl(r, "version"), tpl(r, "rev"), orText(r, "owner", "nobody")),
		}
		if truthyMember(r, "text") {
			out = append(out, "Text: "+tpl(r, "text"))
		} else {
			out = append(out, "Text: (none)")
		}
		if truthyMember(r, "rationale") {
			out = append(out, "Why: "+tpl(r, "rationale"))
		}
		if truthyMember(r, "source") {
			out = append(out, "Source: "+tpl(r, "source"))
		}
		if hasLength(r, "verification") {
			vs, _ := r.Get("verification")
			parts := make([]string, len(vs.Items))
			for i, v := range vs.Items {
				if truthyMember(v, "detail") {
					parts[i] = fmt.Sprintf("%s (%s)", tpl(v, "method"), tpl(v, "detail"))
				} else {
					parts[i] = tpl(v, "method")
				}
			}
			out = append(out, "Verification: "+strings.Join(parts, ", "))
		}
		if truthyMember(r, "scope") {
			sc, _ := r.Get("scope")
			out = append(out, "Scope: "+jsfmt.Compact(sc))
		}
		if truthyMember(r, "precision") {
			p, _ := r.Get("precision")
			if truthyMember(p, "violates") {
				rate := 0.0
				if v, ok := p.Get("rate"); ok && v.Kind != jsfmt.Null {
					rate = jsNumberOf(v)
				}
				maxRate, _ := p.Get("max_rate")
				out = append(out, fmt.Sprintf("Precision: %s of its last %s flags were waived as false positives (%s%%; above %s%% it drops to observe), %s accepted deviations.",
					tpl(p, "false_positives"), tpl(p, "violates"), jsRound(rate*100), jsRound(jsNumberOf(maxRate)*100), tpl(p, "accepted_deviations")))
			} else {
				out = append(out, "Precision: no flags yet.")
			}
		}
		if hasLength(r, "parent_chain") {
			out = append(out, "Derives from: "+joinEach(r, "parent_chain", " > ", func(p jsfmt.Value) string { return tpl(p, "key") + " " + tpl(p, "title") }))
		}
		if hasLength(r, "children") {
			out = append(out, "Children: "+joinEach(r, "children", "; ", func(c jsfmt.Value) string {
				return fmt.Sprintf("%s %s [%s]", tpl(c, "key"), tpl(c, "title"), tpl(c, "status"))
			}))
		}
		if hasLength(r, "links") {
			out = append(out, "Links: "+joinEach(r, "links", "; ", func(l jsfmt.Value) string {
				return fmt.Sprintf("%s %s %s (#%s)", tpl(l, "role"), tpl(l, "target_kind"), tpl(l, "target"), tpl(l, "id"))
			}))
		}
		if hasLength(r, "verdicts") {
			out = append(out, "Recent verdicts (indications from a model, not proof):\n"+joinEach(r, "verdicts", "\n", func(v jsfmt.Value) string {
				waiver := ""
				if truthyMember(v, "waiver") {
					w, _ := v.Get("waiver")
					waiver = fmt.Sprintf(" [waived: %s, %s]", tpl(w, "kind"), orText(w, "reason", "no reason"))
				}
				return fmt.Sprintf("- #%s %s: %s%s v%s%s", tpl(v, "id"), tpl(v, "subject"), tpl(v, "verdict"), pViolates(v), tpl(v, "req_version"), waiver)
			}))
		} else {
			out = append(out, "No verdicts yet.")
		}
		return strings.Join(out, "\n"), nil
	}
	var q params
	for _, k := range []string{"status", "parent", "text"} {
		if truthyMember(a, k) {
			v, _ := a.Get(k)
			q.set(k, jsString(v))
		}
	}
	path := "/api/requirements"
	if len(q.keys) > 0 {
		path += "?" + q.String()
	}
	rows, err := s.apiJSON(ctx, "GET", path, nil)
	if err != nil {
		return "", err
	}
	if len(rows.Items) == 0 {
		return "No requirements.", nil
	}
	lines := make([]string, len(rows.Items))
	for i, r := range rows.Items {
		child := ""
		if truthyMember(r, "parent_id") {
			child = " (child)"
		}
		lines[i] = fmt.Sprintf("%s [%s] %s/%s %s%s", tpl(r, "key"), tpl(r, "status"), tpl(r, "severity"), tpl(r, "mode"), tpl(r, "title"), child)
	}
	return strings.Join(lines, "\n"), nil
}

// joinEach maps the items of x[key] and joins them.
func joinEach(x jsfmt.Value, key, sep string, f func(jsfmt.Value) string) string {
	v, _ := x.Get(key)
	parts := make([]string, len(v.Items))
	for i, it := range v.Items {
		parts[i] = f(it)
	}
	return strings.Join(parts, sep)
}

func reqSet(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	key := ""
	if k, ok := a.Get("key"); ok && k.Kind != jsfmt.Null {
		key = jsTrim(jsString(k))
	}
	if key == "" {
		return "", errors.New("key is required: a requirement like R-7")
	}
	patch := jsfmt.Value{Kind: jsfmt.Object}
	copyIf(&patch, a, reqSetFields...)
	if v, ok := a.Get("if_rev"); ok {
		patch.Set("ifRev", numberValue(jsNumberOf(v)))
	}
	var notes []string
	if len(patch.Keys) > 0 {
		me, err := s.me(a)
		if err != nil {
			return "", err
		}
		patch.Set("by", jsfmt.StringValue(me))
		r, err := s.apiJSON(ctx, "PATCH", "/api/requirements/"+uriComponent(key), raw(patch))
		if err != nil {
			return "", err
		}
		var changed []string
		if ch, ok := r.Get("changes"); ok {
			for i, f := range ch.Keys {
				changed = append(changed, fmt.Sprintf("%s: %s -> %s", f, stringified(ch.Items[i], "from"), stringified(ch.Items[i], "to")))
			}
		}
		if len(changed) == 0 {
			notes = append(notes, "nothing changed")
		} else {
			notes = append(notes, strings.Join(changed, "; "))
		}
	}
	if adds, ok := a.Get("add_links"); ok && adds.Kind == jsfmt.Array {
		for _, l := range adds.Items {
			r, err := s.apiJSON(ctx, "POST", "/api/requirements/"+uriComponent(key)+"/links", raw(l))
			if err != nil {
				return "", err
			}
			notes = append(notes, fmt.Sprintf("linked %s %s %s (#%s)", tpl(r, "role"), tpl(r, "target_kind"), tpl(r, "target"), tpl(r, "id")))
		}
	}
	if rms, ok := a.Get("remove_links"); ok && rms.Kind == jsfmt.Array {
		for _, id := range rms.Items {
			if _, err := s.apiJSON(ctx, "DELETE", "/api/requirements/"+uriComponent(key)+"/links/"+formatNumber(jsNumberOf(id)), nil); err != nil {
				return "", err
			}
			notes = append(notes, "removed link #"+jsString(id))
		}
	}
	if len(notes) == 0 {
		return "", errors.New("nothing to set: pass a field, add_links, or remove_links")
	}
	return key + ": " + strings.Join(notes, "; "), nil
}

// stringified is `${JSON.stringify(x[key])}`: "undefined" for a member that is absent.
func stringified(x jsfmt.Value, key string) string {
	v, ok := x.Get(key)
	if !ok {
		return "undefined"
	}
	return jsfmt.Compact(v)
}

func reqCheck(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	if truthyMember(a, "preview") {
		// a.keys ?? []: a list of keys; anything else has none to run.
		keys, _ := a.Get("keys")
		if keys.Kind != jsfmt.Array || len(keys.Items) == 0 {
			return "", errors.New(`preview needs keys: the requirements to run, like ["R-7"]`)
		}
		var blocks []string
		for _, k := range keys.Items {
			r, err := s.apiJSONTimeout(ctx, "POST", "/api/requirements/"+uriComponent(jsString(k))+"/preview", raw(pick(a, "n")), reqPreviewCall)
			if err != nil {
				return "", err
			}
			rows, _ := r.Get("rows")
			flagged := 0
			lines := make([]string, len(rows.Items))
			for i, x := range rows.Items {
				if v, _ := x.Get("verdict"); v.Kind == jsfmt.String && v.Str == "violates" {
					flagged++
				}
				what := wordFor(x) + pViolates(x)
				if e, ok := x.Get("error"); ok && e.Kind != jsfmt.Null {
					what = jsString(e)
				}
				lines[i] = fmt.Sprintf("- %s %s: %s", tpl(x, "subject"), tpl(x, "summary"), what)
			}
			note := ""
			if truthyMember(r, "note") {
				note = " (" + tpl(r, "note") + ")"
			}
			blocks = append(blocks, fmt.Sprintf("%s: preview on %d subjects, %d likely violate%s\n%s", tpl(r, "key"), len(rows.Items), flagged, note, strings.Join(lines, "\n")))
		}
		return strings.Join(blocks, "\n\n") + "\n\nNothing was recorded and nobody was told. These are indications from a model, not proof.", nil
	}
	r, err := s.apiJSONTimeout(ctx, "POST", "/api/requirements/check", raw(pick(a, "text", "subject", "keys")), reqCheckCall)
	if err != nil {
		return "", err
	}
	results, _ := r.Get("results")
	if len(results.Items) == 0 {
		return tpl(r, "subject") + ": no requirement in scope, or the check got no answer.", nil
	}
	lines := make([]string, len(results.Items))
	for i, x := range results.Items {
		id := ""
		if v, ok := x.Get("id"); ok && v.Kind != jsfmt.Null {
			id = " [verdict #" + jsString(v) + "]"
		}
		stored := ""
		if truthyMember(x, "cached") {
			stored = " (stored)"
		}
		lines[i] = fmt.Sprintf("- %s: %s%s%s%s", tpl(x, "key"), wordFor(x), pViolates(x), id, stored)
	}
	return tpl(r, "subject") + "\n" + strings.Join(lines, "\n") + "\n\nThese are indications from a model, not proof. If one is wrong, say so with req_waive and its verdict number.", nil
}

func reqWaive(ctx context.Context, s *Server, a jsfmt.Value) (string, error) {
	me, err := s.me(a)
	if err != nil {
		return "", err
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	copyIf(&body, a, "verdict_id", "kind", "reason")
	body.Set("by", jsfmt.StringValue(me))
	w, err := s.apiJSON(ctx, "POST", "/api/requirements/waivers", raw(body))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("Waived verdict #%s as %s: %s", tpl(w, "verdict_id"), tpl(w, "kind"), tpl(w, "reason")), nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// jsNumberOf is Number(v) for a JSON value: NaN for one that doesn't convert.
func jsNumberOf(v jsfmt.Value) float64 {
	switch v.Kind {
	case jsfmt.Null:
		return 0
	case jsfmt.Bool:
		if v.Bool {
			return 1
		}
		return 0
	case jsfmt.Number:
		f, err := strconv.ParseFloat(v.Num, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	case jsfmt.String:
		t := jsTrim(v.Str)
		if t == "" {
			return 0
		}
		if f, err := strconv.ParseFloat(t, 64); err == nil && !strings.ContainsAny(t, "_xXpPnN") {
			return f
		}
		return math.NaN()
	}
	return math.NaN()
}

// formatNumber is `${n}` for a number: NaN and the infinities by name.
func formatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	return jsfmt.Compact(numberValue(f))
}

// numberValue is a number as JSON.stringify writes it: NaN and the infinities are null.
func numberValue(f float64) jsfmt.Value {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return jsfmt.NullValue()
	}
	return jsfmt.Value{Kind: jsfmt.Number, Num: strconv.FormatFloat(f, 'g', -1, 64)}
}

// jsRound is `${Math.round(x)}`: half up, toward +∞.
func jsRound(f float64) string { return formatNumber(math.Floor(f + 0.5)) }

// toFixed is Number.prototype.toFixed: the exact binary value rounded to digits places, a tie away from zero.
func toFixed(f float64, digits int) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 0) || math.Abs(f) >= 1e21 {
		return formatNumber(f)
	}
	r := new(big.Rat).SetFloat64(f)
	neg := r.Sign() < 0
	r.Abs(r)
	r.Mul(r, new(big.Rat).SetInt(new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(digits)), nil)))
	n := new(big.Int).Quo(r.Num(), r.Denom())
	if new(big.Rat).Sub(r, new(big.Rat).SetInt(n)).Cmp(big.NewRat(1, 2)) >= 0 {
		n.Add(n, big.NewInt(1))
	}
	s := n.String()
	for len(s) <= digits {
		s = "0" + s
	}
	if digits > 0 {
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if neg && n.Sign() != 0 {
		s = "-" + s
	}
	return s
}
