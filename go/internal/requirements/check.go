package requirements

// The requirements check engine (src/req-check.ts, S-461): given a subject, it picks the in-force `decision` requirements whose
// scope matches (plain code, no model), reuses cached verdicts (requirement version + subject hash + model), asks the decision
// model once for all the rest (one `choice` question per requirement: conforms, violates, na), records a verdict per requirement
// and tells the observer hook what to act on. It never returns an error into a caller and fails open, logging a `req:error`.
//
// Subjects are made by the daemon (go/internal/server/requirements_observers.go): a mail, an ITSA change, a pasted text, a tool
// call. The notice to an actor about a violation (Notify) and the daily-cap notice (CapNotice) are its hooks.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/decide"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/steps"
)

// Subject is what is checked. Content is what the model reads; the other fields are facts the scope filter reads. ActorID is
// the agent to tell about a violation ("" for nobody).
type Subject struct {
	Kind    string
	Ref     string
	Label   string
	Content jsjson.Value
	Actor   steps.Actor
	ActorID string
	Paths   []string
	Repo    string
	// Itsa is the ITSA's key and its ancestors' keys.
	Itsa   []string
	Tool   string
	Source string
	Type   string
	// Silent records verdicts but tells nobody (a manual check, a tool call).
	Silent bool
	// Files is a branch diff, per file: each requirement reads only the files its path globs match. Nil for any other subject.
	Files []FileDiff
}

// FileDiff is one file of a branch diff.
type FileDiff struct{ Path, Text string }

// Limits are the decision model's (measured, S-461): per question prompt, and the state plus all questions of one call.
type Limits struct{ QuestionTokens, CallTokens int }

var defaultLimits = Limits{QuestionTokens: 32_768, CallTokens: 64_000}

// u16len is the length JavaScript's string.length gives, which the token estimate and the chunking count in.
func u16len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func tokens(s string) int { return (u16len(s) + 3) / 4 }

var criteria = []decide.Criterion{
	{Key: "conforms", Description: "The subject satisfies the requirement."},
	{Key: "violates", Description: "The subject breaks the requirement."},
	{Key: "na", Description: "The requirement does not apply to this subject."},
}

// unsureFrom: P(violates) of at least this, and below the requirement's threshold, is `unsure`.
const unsureFrom = 0.5

// --- scope filter ---

var globCache sync.Map

func globToRegExp(glob string) *regexp.Regexp {
	if re, ok := globCache.Load(glob); ok {
		return re.(*regexp.Regexp)
	}
	var out strings.Builder
	rs := []rune(glob)
	for i := 0; i < len(rs); i++ {
		switch c := rs[i]; c {
		case '*':
			if i+1 < len(rs) && rs[i+1] == '*' {
				i++
				if i+1 < len(rs) && rs[i+1] == '/' {
					i++
					out.WriteString("(?:.*/)?")
				} else {
					out.WriteString(".*")
				}
			} else {
				out.WriteString("[^/]*")
			}
		case '?':
			out.WriteString("[^/]")
		default:
			out.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	re := regexp.MustCompile("^" + out.String() + "$")
	globCache.Store(glob, re)
	return re
}

// GlobMatch is a scope glob against a path: `**/` is any directories, `**` anything, `*` anything but a slash, `?` one character.
func GlobMatch(glob, path string) bool { return globToRegExp(glob).MatchString(path) }

func scopeList(r Req, key string) []string {
	scope, ok := r.Get("scope")
	if !ok || scope.Kind != jsfmt.Object {
		return nil
	}
	list, ok := scope.Get(key)
	if !ok || list.Kind != jsfmt.Array {
		return nil
	}
	var out []string
	for _, v := range list.Items {
		if v.Kind == jsfmt.String {
			out = append(out, v.Str)
		}
	}
	return out
}

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// InScope is whether a requirement's scope applies to the subject. A missing scope field filters nothing; a present one needs
// the subject to carry the fact and match it.
func InScope(r Req, s Subject) bool {
	if sc := scopeList(r, "subjects"); len(sc) > 0 && !has(sc, s.Kind) && !(s.Kind == "mail-to-human" && has(sc, "mail")) {
		return false
	}
	if sc := scopeList(r, "paths"); len(sc) > 0 {
		hit := false
		for _, p := range s.Paths {
			for _, g := range sc {
				hit = hit || GlobMatch(g, p)
			}
		}
		if !hit {
			return false
		}
	}
	if sc := scopeList(r, "repos"); len(sc) > 0 && !(s.Repo != "" && has(sc, s.Repo)) {
		return false
	}
	if sc := scopeList(r, "roles"); len(sc) > 0 && !(s.Actor.Role != nil && *s.Actor.Role != "" && has(sc, *s.Actor.Role)) {
		return false
	}
	if sc := scopeList(r, "agents"); len(sc) > 0 && !has(sc, s.Actor.Name) {
		return false
	}
	if sc := scopeList(r, "itsa"); len(sc) > 0 {
		hit := false
		for _, k := range s.Itsa {
			hit = hit || has(sc, k)
		}
		if !hit {
			return false
		}
	}
	if sc := scopeList(r, "tools"); len(sc) > 0 && !(s.Tool != "" && has(sc, s.Tool)) {
		return false
	}
	if sc := scopeList(r, "sources"); len(sc) > 0 && !(s.Source != "" && has(sc, s.Source)) {
		return false
	}
	if sc := scopeList(r, "types"); len(sc) > 0 {
		hit := false
		if s.Type != "" {
			for _, g := range sc {
				hit = hit || GlobMatch(g, s.Type)
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

// VerdictOf is the verdict from the three probabilities and the requirement's threshold.
func VerdictOf(conforms, violates, na, threshold float64) string {
	switch {
	case violates >= threshold:
		return "violates"
	case violates >= unsureFrom:
		return "unsure"
	case na > conforms && na > violates:
		return "na"
	}
	return "conforms"
}

// --- the result ---

// Result is one requirement's verdict on a subject.
type Result struct {
	// ID is the stored verdict's number, for req_waive; 0 when it was not stored.
	ID                        int64
	Key                       string
	Verdict                   string
	PConforms, PViolates, PNa *float64
	Cached                    bool
	// Action is what was done about it: `none`, `notified`, or `recorded` (observe).
	Action string
	// Waived is the kind of the waiver when the verdict was waived.
	Waived string
}

// Value is the result as the API shows it.
func (r Result) Value() jsfmt.Value {
	f := func(p *float64) jsfmt.Value {
		if p == nil {
			return jsfmt.NullValue()
		}
		return num(*p)
	}
	id := jsfmt.NullValue()
	if r.ID != 0 {
		id = num(float64(r.ID))
	}
	pairs := []any{"id", id, "key", str(r.Key), "verdict", str(r.Verdict), "p_conforms", f(r.PConforms), "p_violates", f(r.PViolates), "p_na", f(r.PNa), "cached", boolean(r.Cached), "action", str(r.Action)}
	if r.Waived != "" {
		pairs = append(pairs, "waived", str(r.Waived))
	}
	return obj(pairs...)
}

// Hit is a violation to tell the actor about (Engine.Notify).
type Hit struct {
	Req Req
	P   float64
}

// --- cost cap ---

func today() string { return time.Now().UTC().Format("2006-01-02") }

// SpentToday is today's spend on requirement checks, from the `decide` events (UTC day).
func (s *Store) SpentToday(ctx context.Context) (float64, error) {
	var spent float64
	err := s.DB.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT SUM(json_extract(data, '$.cost')) FROM events WHERE type = 'decide' AND ts >= ? AND json_extract(data, '$.purpose') LIKE 'decide:req:%'", &sqlitex.ExecOptions{
			Args: []any{today() + "T00:00:00"}, ResultFunc: func(stmt *sqlite.Stmt) error { spent = stmt.ColumnFloat(0); return nil },
		})
	})
	return spent, err
}

// --- the check ---

func hashOf(state jsjson.Value) string {
	text, ok := state.(string)
	if !ok {
		text = jsjson.Stringify(state, "")
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])[:32]
}

// HashOf is the hash a pasted text's subject is named by (`text:HASH`).
func HashOf(text string) string { return hashOf(text) }

type asked struct {
	req      Req
	conforms float64
	violates float64
	na       float64
	cost     float64
	parts    int
}

// chunks splits a state too large for one question into text parts that fit (src/req-check.ts chunks, in UTF-16 units).
func chunks(content jsjson.Value, maxChars int) []jsjson.Value {
	text, ok := content.(string)
	if !ok {
		text = jsjson.Stringify(content, "")
	}
	units := utf16.Encode([]rune(text))
	if len(units) <= maxChars {
		return []jsjson.Value{content}
	}
	var out []jsjson.Value
	for at := 0; at < len(units); {
		end := at + maxChars
		if end > len(units) {
			end = len(units)
		}
		// Break at a line end when one is near, so a part reads as text.
		nl := -1
		for i := end; i >= 0; i-- {
			if i < len(units) && units[i] == '\n' {
				nl = i
				break
			}
		}
		if end < len(units) && nl > at+maxChars/2 {
			end = nl + 1
		}
		out = append(out, string(utf16.Decode(units[at:end])))
		at = end
	}
	return out
}

func questionFor(r Req) decide.Question {
	text := r.Text("title")
	if v, ok := r.Get("text"); ok && v.Kind == jsfmt.String {
		text = v.Str
	}
	return decide.Question{Type: "choice", Instructions: "Requirement: " + text, Criteria: criteria}
}

func questionJSON(q decide.Question) string {
	c := jsjson.NewObject()
	for _, k := range q.Criteria {
		c.Set(k.Key, k.Description)
	}
	return jsjson.Stringify(jsjson.NewObject("type", q.Type, "instructions", q.Instructions, "criteria", c), "")
}

// LogError records a `req:error` event: pairs of key and value.
func (s *Store) LogError(ctx context.Context, data ...any) {
	s.logError(ctx, data...)
}

func (s *Store) logError(ctx context.Context, data ...any) {
	_ = s.DB.AddEvent(context.WithoutCancel(ctx), "stam", "req:error", jsfmtObj(data...))
}

func jsfmtObj(pairs ...any) jsfmt.Value {
	for i := 1; i < len(pairs); i += 2 {
		if s, ok := pairs[i].(string); ok {
			pairs[i] = str(s)
		}
	}
	return obj(pairs...)
}

// askAll asks the model about reqs over one state part, in as few calls as the limits allow. A requirement whose call failed
// or whose question can't fit the limits is missing from the result (the latter is logged as `req:error`).
func (s *Store) askAll(ctx context.Context, kind string, state jsjson.Value, reqs []Req, limits Limits, cap float64, timeout time.Duration, preview bool) []asked {
	purpose := "decide:req:" + kind
	if preview {
		purpose = "decide:req:preview"
	}
	stateTokens := tokens(jsjson.Stringify(state, ""))
	type q struct {
		req Req
		q   decide.Question
		t   int
	}
	var qs []q
	for _, r := range reqs {
		question := questionFor(r)
		t := tokens(questionJSON(question)) + 8
		if stateTokens+t > limits.QuestionTokens || stateTokens+t > limits.CallTokens {
			s.logError(ctx, "requirement", r.Key(), "error", fmt.Sprintf("the question doesn't fit the model's limits (%d tokens)", stateTokens+t))
			continue
		}
		qs = append(qs, q{r, question, t})
	}
	var groups [][]q
	var cur []q
	used := stateTokens
	for _, x := range qs {
		if len(cur) > 0 && used+x.t > limits.CallTokens {
			groups = append(groups, cur)
			cur = nil
			used = stateTokens
		}
		cur = append(cur, x)
		used += x.t
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	var out []asked
	for _, g := range groups {
		named := make([]decide.Named, len(g))
		for i, x := range g {
			named[i] = decide.Named{Name: x.req.Key(), Question: x.q}
		}
		res := s.serialized(ctx, cap, preview, func() *decide.Result {
			if s.Ask == nil {
				return nil
			}
			res, fail := s.Ask.Decide(ctx, state, named, purpose, timeout)
			if fail != nil {
				return nil
			}
			return res
		})
		if res == nil {
			continue
		}
		each := 0.0
		if c, ok := res.Usage.Get("cost"); ok && c.Kind == jsfmt.Number {
			each, _ = strconv.ParseFloat(c.Num, 64)
			if math.IsNaN(each) {
				each = 0
			}
			each /= float64(len(g))
		}
		for _, x := range g {
			probs := [3]float64{}
			ok := true
			a, _ := res.Answers.Get(x.req.Key())
			p, _ := a.Get("probabilities")
			for i, k := range []string{"conforms", "violates", "na"} {
				v, has := p.Get(k)
				f, err := strconv.ParseFloat(v.Num, 64)
				if !has || v.Kind != jsfmt.Number || err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 1 {
					ok = false
					break
				}
				probs[i] = f
			}
			if ok {
				out = append(out, asked{req: x.req, conforms: probs[0], violates: probs[1], na: probs[2], cost: each, parts: 1})
			}
		}
	}
	return out
}

// serialized runs one model call at a time, so the daily cap is checked against spend that includes every earlier call
// (concurrent checks can't all pass it). A nil result is a call not made (the cap) or a failed one.
func (s *Store) serialized(ctx context.Context, cap float64, preview bool, call func() *decide.Result) *decide.Result {
	s.gate.Lock()
	defer s.gate.Unlock()
	spent, err := s.SpentToday(ctx)
	if err != nil {
		s.logError(ctx, "error", err.Error())
		return nil
	}
	if spent >= cap {
		// A preview tells nobody, not even about the cap.
		if !preview {
			s.capNotice(ctx, spent, cap)
		}
		return nil
	}
	return call()
}

func (s *Store) capNotice(ctx context.Context, spent, cap float64) {
	if s.CapNotice != nil {
		s.CapNotice(ctx, spent, cap)
	}
}

// CheckOptions limit a check.
type CheckOptions struct {
	Limits *Limits
	// Keys are the only requirements (keys or ids) to check.
	Keys []string
	// Filter accepts the requirements to check, after the scope filter.
	Filter func(Req) bool
	// Timeout is a model call's; 0 is decide.DefaultTimeout.
	Timeout time.Duration
	// Preview checks Only, whatever their status, and records nothing and tells nobody; the cost is under decide:req:preview.
	Preview bool
	Only    []Req
}

// Check checks one subject against the requirements in scope. It returns a result per requirement that got a verdict (cached
// or new) and never fails: any failure is logged as a `req:error` and gives what there is (nothing).
func (s *Store) Check(ctx context.Context, sub Subject, o CheckOptions) []Result {
	if !s.Enabled() || !s.isHome() {
		return nil
	}
	results, err := s.run(ctx, sub, o)
	if err != nil {
		s.logError(ctx, "subject", sub.Ref, "error", err.Error())
		return nil
	}
	return results
}

func (s *Store) isHome() bool { return s.IsHome == nil || s.IsHome() }

// UsesDecision is whether the requirement has a decision method, the only kind a model checks.
func UsesDecision(r Req) bool {
	v, _ := r.Get("verification")
	for _, m := range v.Items {
		if m.Text("method") == "decision" {
			return true
		}
	}
	return false
}

func (s *Store) run(ctx context.Context, sub Subject, o CheckOptions) ([]Result, error) {
	var candidates []Req
	if o.Preview {
		candidates = o.Only
	} else {
		list, err := s.List(ctx, ListFilters{Status: ptrTo("in_force")})
		if err != nil {
			return nil, err
		}
		for _, v := range list.Items {
			candidates = append(candidates, Req{v})
		}
	}
	var inForce []Req
	for _, r := range candidates {
		if !UsesDecision(r) || !InScope(r, sub) {
			continue
		}
		if o.Keys != nil && !has(o.Keys, r.Key()) && !has(o.Keys, r.ID()) {
			continue
		}
		if o.Filter != nil && !o.Filter(r) {
			continue
		}
		inForce = append(inForce, r)
	}
	if len(inForce) == 0 {
		return nil, nil
	}
	var notify []Hit
	var results []Result
	for _, v := range viewsOf(sub, inForce) {
		part, err := s.runView(ctx, sub, v, o, &notify)
		if err != nil {
			return nil, err
		}
		results = append(results, part...)
	}
	if len(notify) > 0 && sub.ActorID != "" && sub.ActorID != "human" && !o.Preview && s.Notify != nil {
		s.Notify(ctx, sub, notify)
	}
	return results, nil
}

// view is what the model reads for a set of requirements: the whole subject, or for a branch diff only the files the
// requirements' path globs match, so requirements with the same files share a view.
type view struct {
	content jsjson.Value
	reqs    []Req
}

func viewsOf(sub Subject, reqs []Req) []view {
	if sub.Files == nil {
		return []view{{sub.Content, reqs}}
	}
	type group struct {
		files []FileDiff
		reqs  []Req
	}
	groups := map[string]*group{}
	var order []string
	for _, r := range reqs {
		globs := scopeList(r, "paths")
		files := sub.Files
		if len(globs) > 0 {
			files = nil
			for _, f := range sub.Files {
				for _, g := range globs {
					if GlobMatch(g, f.Path) {
						files = append(files, f)
						break
					}
				}
			}
		}
		if len(files) == 0 {
			continue
		}
		paths := make([]string, len(files))
		for i, f := range files {
			paths[i] = f.Path
		}
		key := strings.Join(paths, "\x00")
		g, ok := groups[key]
		if !ok {
			g = &group{files: files}
			groups[key] = g
			order = append(order, key)
		}
		g.reqs = append(g.reqs, r)
	}
	head, ok := sub.Content.(string)
	if !ok {
		head = jsjson.Stringify(sub.Content, "")
	}
	out := make([]view, 0, len(order))
	for _, k := range order {
		g := groups[k]
		var b strings.Builder
		b.WriteString(head)
		b.WriteString("\n")
		for _, f := range g.files {
			b.WriteString("\n=== " + f.Path + "\n" + f.Text)
		}
		out = append(out, view{b.String(), g.reqs})
	}
	return out
}

func (s *Store) runView(ctx context.Context, sub Subject, v view, o CheckOptions, notify *[]Hit) ([]Result, error) {
	reqs := v.reqs
	limits := defaultLimits
	if o.Limits != nil {
		limits = *o.Limits
	}
	st := s.Settings()
	model, cap := st.DecisionsModel, st.Requirements.DailyCapUsd
	base := jsjson.NewObject("kind", sub.Kind, "content", v.content, "actor", sub.Actor.Value())
	hash := hashOf(base)

	var results []Result
	var misses []Req
	for _, r := range reqs {
		c, err := s.CachedVerdict(ctx, r.ID(), r.Version(), hash, model)
		if err != nil {
			return nil, err
		}
		if c == nil {
			misses = append(misses, r)
			continue
		}
		waived, err := s.WaiverKind(ctx, c.ID)
		if err != nil {
			return nil, err
		}
		action := c.Action
		if action == "" {
			action = "none"
		}
		results = append(results, Result{ID: c.ID, Key: r.Key(), Verdict: c.Verdict, PConforms: c.PConforms, PViolates: c.PViolates, PNa: c.PNa, Cached: true, Action: action, Waived: waived})
	}
	if len(misses) == 0 {
		return results, nil
	}
	if spent, err := s.SpentToday(ctx); err != nil {
		return nil, err
	} else if spent >= cap {
		if !o.Preview {
			s.capNotice(ctx, spent, cap)
		}
		return results, nil
	}

	// The state is split into parts when the content is too big for one question; each part is asked about every requirement,
	// and the parts' answers merge (violates is the highest seen, n/a only if it is n/a everywhere). The limits are measured on
	// the serialized state, so a part is shrunk until JSON escaping fits too. A requirement is recorded only when every part
	// got its answer: a partial result is never cached under the whole subject's hash.
	maxQuestion := 0
	for _, r := range misses {
		maxQuestion = max(maxQuestion, tokens(questionJSON(questionFor(r)))+8)
	}
	stateOf := func(content jsjson.Value, part string) jsjson.Value {
		if part == "" {
			return base
		}
		return jsjson.NewObject("kind", sub.Kind, "content", content, "actor", sub.Actor.Value(), "part", part)
	}
	partLabel := func(i, n int) string {
		if n > 1 {
			return fmt.Sprintf("%d/%d", i+1, n)
		}
		return ""
	}
	maxChars := max(1000, (limits.QuestionTokens-maxQuestion)*4)
	parts := chunks(v.content, maxChars)
	for guard := 0; guard < 20; guard++ {
		worst := 0
		for i, c := range parts {
			worst = max(worst, tokens(jsjson.Stringify(stateOf(c, partLabel(i, len(parts))), "")))
		}
		if worst+maxQuestion <= min(limits.QuestionTokens, limits.CallTokens) {
			break
		}
		if maxChars <= 200 {
			return nil, fmt.Errorf("the subject can't be split under the model's limits (%d tokens a part)", worst)
		}
		maxChars = int(math.Floor(float64(maxChars) * math.Max(0.3, math.Min(0.9, float64(limits.QuestionTokens-maxQuestion)/float64(worst)))))
		parts = chunks(v.content, max(200, maxChars))
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = decide.DefaultTimeout
	}
	merged := map[string]*asked{}
	var order []string
	for i, part := range parts {
		for _, a := range s.askAll(ctx, sub.Kind, stateOf(part, partLabel(i, len(parts))), misses, limits, cap, timeout, o.Preview) {
			a := a
			m, ok := merged[a.req.Key()]
			if !ok {
				merged[a.req.Key()] = &a
				order = append(order, a.req.Key())
				continue
			}
			violates := math.Max(m.violates, a.violates)
			na := math.Min(m.na, a.na)
			m.violates, m.na, m.conforms = violates, na, math.Max(0, 1-violates-na)
			m.cost += a.cost
			m.parts++
		}
	}
	for _, k := range order {
		m := merged[k]
		if m.parts < len(parts) {
			continue
		}
		threshold := m.req.float("threshold")
		verdict := VerdictOf(m.conforms, m.violates, m.na, threshold)
		tell := false
		if !o.Preview && !sub.Silent && verdict == "violates" && m.req.Text("mode") != "observe" {
			waived, err := s.WaivedOn(ctx, m.req.ID(), sub.Ref)
			if err != nil {
				return nil, err
			}
			tell = !waived
		}
		if o.Preview {
			c, v, n := m.conforms, m.violates, m.na
			results = append(results, Result{Key: m.req.Key(), Verdict: verdict, PConforms: &c, PViolates: &v, PNa: &n, Action: "none"})
			continue
		}
		action := "none"
		if tell {
			action = "notified"
		} else if m.req.Text("mode") == "observe" {
			action = "recorded"
		}
		id, err := s.RecordVerdict(ctx, NewVerdict{
			ReqID: m.req.ID(), ReqVersion: m.req.Version(), Subject: sub.Ref, SubjectHash: hash, SubjectLabel: sub.Label, Model: model,
			Verdict: verdict, PConforms: m.conforms, PViolates: m.violates, PNa: m.na, Action: action, Cost: m.cost,
		})
		if err != nil {
			return nil, err
		}
		c, v, n := m.conforms, m.violates, m.na
		results = append(results, Result{ID: id, Key: m.req.Key(), Verdict: verdict, PConforms: &c, PViolates: &v, PNa: &n, Action: action})
		if tell {
			*notify = append(*notify, Hit{Req: m.req, P: m.violates})
		}
	}
	return results, nil
}

// --- a tool call, before it runs ---

// ToolVerdict is the answer for a tool call.
type ToolVerdict struct {
	Allow       bool
	Requirement string
	P           float64
	Error       string
}

// Value is the verdict as the API shows it: `{allow: true}`, or the denial.
func (v ToolVerdict) Value() jsfmt.Value {
	if v.Allow {
		return obj("allow", boolean(true))
	}
	return obj("allow", boolean(false), "requirement", str(v.Requirement), "p", num(v.P), "error", str(v.Error))
}

// ToolBudgetCall is the longest a check of one tool call asks the model (src/req-check.ts checkTool).
const ToolBudgetCall = 5 * time.Second

// CheckTool is a tool call's check: only `enforce` requirements scoped to that tool are asked. A violation denies the call with
// an error naming the requirement; anything else (no requirement, a model failure, running out of time) allows it. The denial
// is the actor's notice. The call is not cancelled with the request: its verdict is stored for the next call.
func (s *Store) CheckTool(ctx context.Context, agentID, tool string, args jsjson.Value, budget time.Duration, actor steps.Actor) ToolVerdict {
	allow := ToolVerdict{Allow: true}
	if !s.Enabled() || budget <= 0 {
		return allow
	}
	// The index is built at daemon start and on every change, off this path. Cold (just turned on), the call goes through and
	// the index is built right after; a failed lookup also lets it through.
	if !s.IndexReady() {
		go func() { _, _ = s.EnforcedTools(context.WithoutCancel(ctx)) }()
		return allow
	}
	tools, err := s.EnforcedTools(ctx)
	if err != nil || !tools[tool] {
		return allow
	}
	sub := Subject{
		Kind: "tool", Ref: "tool:" + tool, Content: jsjson.NewObject("tool", tool, "arguments", args), Actor: actor, ActorID: agentID, Tool: tool, Silent: true,
	}
	timeout := min(ToolBudgetCall, budget)
	done := make(chan []Result, 1)
	bg := context.WithoutCancel(ctx)
	go func() {
		done <- s.Check(bg, sub, CheckOptions{
			Filter: func(r Req) bool { return r.Text("mode") == "enforce" && has(scopeList(r, "tools"), tool) }, Timeout: timeout,
		})
	}()
	timer := time.NewTimer(budget)
	defer timer.Stop()
	var results []Result
	select {
	case results = <-done:
	case <-timer.C:
		return allow
	}
	for _, r := range results {
		if r.Verdict != "violates" || r.Waived != "" {
			continue
		}
		req, err := s.Find(ctx, r.Key)
		if err != nil {
			return allow
		}
		owner := "human"
		text := ""
		if req != nil {
			if o := req.Owner(); o != "" && s.Actors != nil {
				owner = s.Actors.ActorOf(ctx, o).Name
			}
			text = req.Text("title")
			if v, ok := req.Get("text"); ok && v.Kind == jsfmt.String {
				text = v.Str
			}
		}
		p := 0.0
		if r.PViolates != nil {
			p = *r.PViolates
		}
		return ToolVerdict{
			Allow: false, Requirement: r.Key, P: p,
			Error: fmt.Sprintf("Denied by requirement %s (likely not met, p %s): %s. This is an indication from a model check, not proof. If it is wrong, say so to the requirement's owner (%s).", r.Key, steps.ToFixed2(p), text, owner),
		}
	}
	return allow
}

// --- a check on demand ---

// ManualInput is POST /api/requirements/check: pasted `text`, or a `subject` naming a mail, an ITSA or a branch.
type ManualInput struct {
	Subject, Text jsjson.Value
	Keys          jsjson.Value
}

// Resolve names the subject of a `mail:ID`, `itsa:KEY` or `branch:REPO/NAME` ref, silent; an unknown one is an error.
type Resolve func(ctx context.Context, ref string) (Subject, error)

// Manual is a check on demand of a pasted text, or of the subject resolve makes of a ref. It records verdicts and tells nobody.
// Bad input is an error; a failed check is an empty list, as everywhere.
func (s *Store) Manual(ctx context.Context, in ManualInput, resolve Resolve) (string, []Result, error) {
	if !s.Enabled() {
		return "", nil, Off{}
	}
	var keys []string
	switch k := in.Keys.(type) {
	case nil:
	case []any:
		keys = []string{}
		for _, v := range k {
			keys = append(keys, jsjson.ToString(v))
		}
	default:
		keys = []string{}
		for _, p := range strings.Split(jsjson.ToString(k), ",") {
			if p = strings.TrimSpace(p); p != "" {
				keys = append(keys, p)
			}
		}
	}
	actor := steps.Actor{Name: "human"}
	ref := ""
	if t, ok := in.Subject.(string); ok {
		ref = strings.TrimSpace(t)
	}
	text, isText := in.Text.(string)
	if isText && strings.TrimSpace(text) != "" {
		sub := Subject{Kind: "manual", Ref: "text:" + hashOf(text), Label: Clip(text, 60), Content: text, Actor: actor, Silent: true}
		return sub.Ref, s.Check(ctx, sub, CheckOptions{Keys: keys}), nil
	}
	if strings.HasPrefix(ref, "mail:") || strings.HasPrefix(ref, "itsa:") || strings.HasPrefix(ref, "branch:") {
		sub, err := resolve(ctx, ref)
		if err != nil {
			return "", nil, err
		}
		sub.Silent = true
		return sub.Ref, s.Check(ctx, sub, CheckOptions{Keys: keys}), nil
	}
	return "", nil, fmt.Errorf("give a text, or a subject: mail:ID, itsa:KEY, or branch:REPO/NAME")
}
