package server

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/peers"
	srch "stam/internal/search"
)

// Search (S-3735): GET /api/mail/search (src/mail-search.ts), GET /api/itsas/search (src/itsa-search.ts) and GET
// /api/search (src/search.ts), over the embedding index (srch.Index) that mail and ITSAs are queued into as they are
// stored or edited. The index's sources are mail and, on the ITSA home, ITSAs.
//
// Not ported: the local embedder (transformers.js runs only in the TS daemon: here search falls back to keywords), the
// agent and turn sources (src/agent-vectors.ts, turn-vectors.ts, for the prompt suggestions), and `stam embedder install`.

// The weights of a hit's meaning and keyword scores, and the least cosine that counts (src/mail-search.ts, itsa-search.ts).
const (
	meaningWeight = 0.7
	keywordWeight = 0.3
	meaningFloor  = 0.15
)

func (s *Server) searchRoutes() {
	s.handle("GET /api/mail/search", s.mailSearchRoute)
	s.handle("GET /api/search", s.searchRoute)
}

// embedProvider is src/embed.ts provider: STAM_EMBEDDER (stub or off) wins over search.embedder.
func (s *Server) embedProvider() srch.Provider {
	env, ok := os.LookupEnv("MOOTR_EMBEDDER")
	if !ok {
		env = os.Getenv("STAM_EMBEDDER")
	}
	return srch.ProviderOf(env, s.settings.Get().SearchOff)
}

// newIndex is the embedding index with its two sources: mail (src/vectors.ts) and ITSAs on their home
// (src/itsa-vectors.ts).
func (s *Server) newIndex() *srch.Index {
	mail := srch.Source{
		Name: "mail",
		Resolve: func(ctx context.Context, id string) (string, bool, error) {
			subject, body, ok, err := s.db.MailText(ctx, id)
			if err != nil || !ok {
				return "", false, err
			}
			return srch.EmbedText(subject, body), true, nil
		},
		Pending: s.db.MailToEmbed,
	}
	itsa := srch.Source{
		Name: "itsa",
		Resolve: func(ctx context.Context, id string) (string, bool, error) {
			x, ok, err := s.db.FindItsa(ctx, id)
			if err != nil || !ok {
				return "", false, err
			}
			return itsaText(x), true, nil
		},
		Pending: func(ctx context.Context, model string, limit int) ([]string, error) {
			if !s.isHome() {
				return nil, nil
			}
			return s.db.ItsasToEmbed(ctx, model, limit)
		},
	}
	return srch.New(s.db, s.embedProvider, mail, itsa)
}

// itsaText is src/itsa-vectors.ts itsaText: the key and title, then the summary and body.
func itsaText(x jsfmt.Value) string {
	return srch.EmbedText(x.Text("key")+" "+x.Text("title"), x.Text("summary")+"\n"+x.Text("body"))
}

// StartSearchIndex runs the indexing worker until ctx ends: a backfill first, so mail and ITSAs stored while no daemon
// indexed them (or under another embedder) are picked up after a restart.
func (s *Server) StartSearchIndex(ctx context.Context) {
	s.goBg(func() { s.index.Run(ctx) })
}

// indexItsa queues an ITSA whose text is new or changed, on its home only.
func (s *Server) indexItsa(x jsfmt.Value) {
	if s.isHome() {
		s.index.Enqueue("itsa", x.Text("id"))
	}
}

// queryVector is the query's vector, nil when the embedder is off or not ready.
func (s *Server) queryVector(q string) []float32 {
	if v := s.index.Embed([]string{q}); len(v) > 0 {
		return v[0]
	}
	return nil
}

func jsNum(f float64) jsfmt.Value {
	return jsfmt.Value{Kind: jsfmt.Number, Num: strconv.FormatFloat(f, 'g', -1, 64)}
}

func numOf(v jsfmt.Value) (float64, bool) {
	if v.Kind != jsfmt.Number {
		return 0, false
	}
	f, err := strconv.ParseFloat(v.Num, 64)
	return f, err == nil
}

// jsLimit is Math.min(hi, Math.max(lo, Number(raw ?? def))), with NaN read as def.
func jsLimit(q url.Values, k string, def, lo, hi int) int {
	n := number(q.Get(k), q.Has(k), def)
	return min(hi, max(lo, n))
}

// --- mail -----------------------------------------------------------------------------------------------------------

// mailPart is src/mail-search.ts Part: a daemon's raw part of a thread before the answering daemon blends. cos is nil
// when no in-scope mail is near enough.
type mailPart struct {
	thread, subject, latest string
	people                  []string
	last, excerpt           string
	cos                     *float64
	kw                      float64
}

func (p mailPart) head() jsfmt.Value {
	people := make([]jsfmt.Value, len(p.people))
	for i, x := range p.people {
		people[i] = jsfmt.StringValue(x)
	}
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("thread_id", jsfmt.StringValue(p.thread))
	v.Set("subject", jsfmt.StringValue(p.subject))
	v.Set("latest", jsfmt.StringValue(p.latest))
	v.Set("people", jsfmt.ArrayValue(people))
	v.Set("last", jsfmt.StringValue(p.last))
	v.Set("excerpt", jsfmt.StringValue(p.excerpt))
	return v
}

// value is the part as a peer answers it.
func (p mailPart) value() jsfmt.Value {
	v := p.head()
	if p.cos != nil {
		v.Set("cos", jsNum(*p.cos))
	} else {
		v.Set("cos", jsfmt.NullValue())
	}
	v.Set("kw", jsNum(p.kw))
	return v
}

// partOf reads a peer's part; ok false for a row that isn't one.
func partOf(v jsfmt.Value) (mailPart, bool) {
	p := mailPart{thread: v.Text("thread_id"), subject: v.Text("subject"), latest: v.Text("latest"), last: v.Text("last"), excerpt: v.Text("excerpt")}
	if p.thread == "" {
		return p, false
	}
	if ps, ok := v.Get("people"); ok {
		for _, x := range ps.Items {
			p.people = append(p.people, anyString(x))
		}
	}
	if c, ok := v.Get("cos"); ok {
		if f, ok := numOf(c); ok {
			p.cos = &f
		}
	}
	if k, ok := v.Get("kw"); ok {
		p.kw, _ = numOf(k)
	}
	return p, true
}

// mailHit is src/mail-search.ts MailHit: a part blended into the answering daemon's score.
type mailHit struct {
	mailPart
	score   float64
	by      string
	cosine  *float64
	keyword float64
}

func (h mailHit) value() jsfmt.Value {
	v := h.head()
	v.Set("score", jsNum(h.score))
	v.Set("by", jsfmt.StringValue(h.by))
	if h.cosine != nil {
		v.Set("cosine", jsNum(*h.cosine))
	} else {
		v.Set("cosine", jsfmt.NullValue())
	}
	v.Set("keyword", jsNum(h.keyword))
	return v
}

// sharedThreads is src/mail-search.ts sharedThreads: the threads with the human that an ancestor of the viewer took part
// in, but no ITSA's thread, which only those the ITSA belongs to read whole.
func (s *Server) sharedThreads(ctx context.Context, viewer string) ([]string, error) {
	a, err := s.db.GetAgent(ctx, viewer)
	if errors.Is(err, db.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	extra, err := s.db.ExtraParents(ctx)
	if err != nil {
		return nil, err
	}
	anc, _ := s.ancestors(ctx, a, extra)
	human, err := s.db.ThreadIDsOf(ctx, humanBox)
	if err != nil {
		return nil, err
	}
	withHuman := map[string]bool{}
	for _, t := range human {
		withHuman[t] = true
	}
	itsaThreads, err := s.db.ItsaThreadIDs(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(anc))
	for p := range anc {
		ids = append(ids, p)
	}
	sort.Strings(ids)
	seen := map[string]bool{}
	var out []string
	for _, p := range ids {
		ts, err := s.db.ThreadIDsOf(ctx, p)
		if err != nil {
			return nil, err
		}
		for _, t := range ts {
			if !seen[t] && withHuman[t] && !itsaThreads[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
	}
	return out, nil
}

// threadText is src/mail-search.ts textOf: the hit's latest mail, its people, and an excerpt of m around the query.
func (s *Server) threadText(ctx context.Context, thread string, m jsfmt.Value, q string) (mailPart, error) {
	mails, err := s.db.ThreadMail(ctx, thread, "")
	if err != nil {
		return mailPart{}, err
	}
	latest := m
	if len(mails) > 0 {
		latest = mails[len(mails)-1]
	}
	var people []string
	seen := map[string]bool{}
	add := func(p string) {
		if !seen[p] {
			seen[p] = true
			people = append(people, p)
		}
	}
	for _, x := range mails {
		if f, ok := x.Get("from_name"); ok && f.Kind != jsfmt.Null {
			add(anyString(f))
		} else {
			add(x.Text("from_id"))
		}
		rs, _ := x.Get("recipients")
		for _, r := range rs.Items {
			id := r.Text("id")
			switch a, err := s.db.GetAgent(ctx, id); {
			case id == humanBox:
				add(humanBox)
			case err == nil:
				add(a.Name)
			default:
				add(id)
			}
		}
	}
	subject := m.Text("subject")
	if subject == "" {
		subject = "(no subject)"
	}
	return mailPart{thread: thread, subject: subject, latest: latest.Text("id"), people: people, last: latest.Text("created_at"),
		excerpt: srch.Excerpt(m.Text("body"), q)}, nil
}

// mailThreadOf is a mail row's thread: its thread_id, else its own id.
func mailThreadOf(m jsfmt.Value) string {
	if t := m.Text("thread_id"); t != "" {
		return t
	}
	return m.Text("id")
}

// localParts is src/mail-search.ts localParts: this daemon's keyword hits for the viewer, plus the threads whose in-scope
// mail is near the query (when vec is given).
func (s *Server) localParts(ctx context.Context, viewer, q, with string, limit int, vec []float32) ([]mailPart, error) {
	var inWith map[string]bool
	if with != "" {
		withID := with
		if a, err := s.db.GetAgent(ctx, with); err == nil {
			withID = a.ID
		}
		ts, err := s.db.ThreadIDsOf(ctx, withID)
		if err != nil {
			return nil, err
		}
		inWith = map[string]bool{}
		for _, t := range ts {
			inWith[t] = true
		}
	}
	shared, err := s.sharedThreads(ctx, viewer)
	if err != nil {
		return nil, err
	}
	// Keyword: the best mail per thread. More than the limit is asked for, since the `with` filter can drop some.
	found, err := s.db.SearchMailText(ctx, q, viewer, limit*10, shared)
	if err != nil {
		return nil, err
	}
	type kwHit struct {
		m     jsfmt.Value
		score float64
	}
	kw := map[string]kwHit{}
	var order []string
	for _, m := range found {
		t := mailThreadOf(m)
		if inWith != nil && !inWith[t] {
			continue
		}
		score := float64(srch.Rank(m.Text("subject"), q)*2 + srch.Rank(m.Text("body"), q))
		cur, has := kw[t]
		if !has {
			order = append(order, t)
		}
		if !has || score > cur.score {
			kw[t] = kwHit{m, score}
		}
	}
	// Meaning: each thread's nearest in-scope mail.
	type near struct {
		ref string
		cos float64
	}
	best := map[string]near{}
	if vec != nil {
		scope, err := s.db.MailScope(ctx, viewer, shared)
		if err != nil {
			return nil, err
		}
		threadOf := map[string]string{}
		for _, m := range scope {
			if inWith == nil || inWith[m.Thread] {
				threadOf[m.ID] = m.Thread
			}
		}
		refs := map[string]bool{}
		for id := range threadOf {
			refs[id] = true
		}
		hits, err := s.index.Nearest(ctx, "mail", vec, refs, -1, math.Inf(-1))
		if err != nil {
			return nil, err
		}
		for _, h := range hits {
			t := threadOf[h.Ref]
			if _, ok := best[t]; ok {
				continue
			}
			best[t] = near{h.Ref, h.Score}
			if _, ok := kw[t]; !ok && h.Score >= meaningFloor {
				order = append(order, t)
			}
		}
	}
	var parts []mailPart
	for _, t := range order {
		b, hasB := best[t]
		k, hasK := kw[t]
		m := k.m
		if !hasK {
			got, ok, err := s.db.GetMail(ctx, b.ref)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			m = got
		}
		p, err := s.threadText(ctx, t, m, q)
		if err != nil {
			return nil, err
		}
		if hasB && b.cos >= meaningFloor {
			c := b.cos
			p.cos = &c
		}
		p.kw = k.score
		parts = append(parts, p)
	}
	return parts, nil
}

// mergeParts is src/mail-search.ts mergeParts: one part per thread across the daemons, with the text of the strongest,
// every part's people, the newest latest and last, the best cosine and the best keyword rank.
func mergeParts(parts []mailPart) []mailPart {
	byThread := map[string]int{}
	var out []mailPart
	for _, p := range parts {
		i, ok := byThread[p.thread]
		if !ok {
			byThread[p.thread] = len(out)
			out = append(out, p)
			continue
		}
		cur := out[i]
		top, other := cur, p
		if p.kw > cur.kw {
			top, other = p, cur
		}
		newest := cur
		if p.last > cur.last {
			newest = p
		}
		merged := top
		merged.people = nil
		seen := map[string]bool{}
		for _, x := range append(append([]string(nil), top.people...), other.people...) {
			if !seen[x] {
				seen[x] = true
				merged.people = append(merged.people, x)
			}
		}
		merged.latest, merged.last = newest.latest, newest.last
		merged.cos = nil
		for _, c := range []*float64{cur.cos, p.cos} {
			if c != nil && (merged.cos == nil || *c > *merged.cos) {
				v := *c
				merged.cos = &v
			}
		}
		merged.kw = math.Max(cur.kw, p.kw)
		out[i] = merged
	}
	return out
}

// blendParts is src/mail-search.ts blend: the answering daemon's scores, by meaning when meaning is set, else by keyword.
func blendParts(parts []mailPart, meaning bool, limit int) []mailHit {
	maxKw := 1.0
	for _, p := range parts {
		maxKw = math.Max(maxKw, p.kw)
	}
	var hits []mailHit
	for _, p := range parts {
		h := mailHit{mailPart: p, by: "keyword", score: p.kw, keyword: p.kw}
		if meaning {
			c := 0.0
			if p.cos != nil {
				c = *p.cos
			}
			h.by, h.score, h.cosine = "meaning", meaningWeight*c+keywordWeight*(p.kw/maxKw), &c
		}
		if h.score > 0 {
			hits = append(hits, h)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].last > hits[j].last
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

// searchMail is src/mail-search.ts searchMail for one viewer: this daemon's parts alone for a peer's own request, else
// merged with the peers' and blended.
func (s *Server) searchMail(ctx context.Context, viewer, q, with string, limit int, local bool, via *peers.Via) ([]mailPart, []mailHit, error) {
	q = srch.Trim(q)
	if q == "" {
		return nil, nil, nil
	}
	vec := s.queryVector(q)
	own, err := s.localParts(ctx, viewer, q, with, limit, vec)
	if err != nil {
		return nil, nil, err
	}
	if local {
		return own, nil, nil
	}
	// URLSearchParams order: box, q, limit, then with.
	path := "/api/mail/search?box=" + url.QueryEscape(viewer) + "&q=" + url.QueryEscape(q) + "&limit=" + strconv.Itoa(limit)
	if with != "" {
		path += "&with=" + url.QueryEscape(with)
	}
	all := own
	for _, v := range s.peers.FanOut(ctx, path, via) {
		if p, ok := partOf(v); ok {
			all = append(all, p)
		}
	}
	return nil, blendParts(mergeParts(all), vec != nil, limit), nil
}

// mailSearchRoute is GET /api/mail/search: search over the mail a viewer may read. A peer answers its own raw parts.
func (s *Server) mailSearchRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	q := r.URL.Query()
	box, err := s.viewerBox(ctx, c, q.Get("box"))
	if err != nil {
		return nil, err
	}
	if box == "" {
		return nil, Errorf(http.StatusBadRequest, "box is required")
	}
	limit := jsLimit(q, "limit", 10, 1, 30)
	parts, hits, err := s.searchMail(ctx, s.boxRef(ctx, box), q.Get("q"), q.Get("with"), limit, c.Local, s.viaBox(ctx, c, box))
	if err != nil {
		return nil, err
	}
	out := []jsfmt.Value{}
	for _, p := range parts {
		out = append(out, p.value())
	}
	for _, h := range hits {
		out = append(out, h.value())
	}
	return out, nil
}

// --- ITSAs ----------------------------------------------------------------------------------------------------------

// itsaHit is src/itsa-search.ts ItsaHit.
type itsaHit struct {
	id, key, title, status string
	owner                  *string
	excerpt                string
	score                  float64
	by                     string
	cosine                 *float64
	keyword                float64
}

func (h itsaHit) value() jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("id", jsfmt.StringValue(h.id))
	v.Set("key", jsfmt.StringValue(h.key))
	v.Set("title", jsfmt.StringValue(h.title))
	v.Set("status", jsfmt.StringValue(h.status))
	if h.owner != nil {
		v.Set("owner", jsfmt.StringValue(*h.owner))
	} else {
		v.Set("owner", jsfmt.NullValue())
	}
	v.Set("excerpt", jsfmt.StringValue(h.excerpt))
	v.Set("score", jsNum(h.score))
	v.Set("by", jsfmt.StringValue(h.by))
	if h.cosine != nil {
		v.Set("cosine", jsNum(*h.cosine))
	} else {
		v.Set("cosine", jsfmt.NullValue())
	}
	v.Set("keyword", jsNum(h.keyword))
	return v
}

type itsaSearchOpts struct {
	limit, offset int
	kinds         []string
	open          bool
}

// searchItsas is src/itsa-search.ts searchItsas: the keyword matches and the ITSAs near the query, blended as mail is.
func (s *Server) searchItsas(ctx context.Context, q string, o itsaSearchOpts) ([]itsaHit, error) {
	q = srch.Trim(q)
	if q == "" {
		return nil, nil
	}
	keep := func(x jsfmt.Value) bool {
		if len(o.kinds) > 0 {
			k := ""
			if kv, ok := x.Get("kind"); ok && kv.Kind != jsfmt.Null {
				k = anyString(kv)
			}
			found := false
			for _, want := range o.kinds {
				found = found || want == k
			}
			if !found {
				return false
			}
		}
		return !o.open || nullish(x, "closed_at")
	}
	vec := s.queryVector(q)
	listed, err := s.db.ListItsas(ctx, db.ItsaFilter{Text: q})
	if err != nil {
		return nil, err
	}
	var found []jsfmt.Value
	index := map[string]int{}
	for _, x := range listed {
		if keep(x) {
			index[x.Text("id")] = len(found)
			found = append(found, x)
		}
	}
	cos := map[string]float64{}
	if vec != nil {
		near, err := s.index.Nearest(ctx, "itsa", vec, nil, -1, math.Inf(-1))
		if err != nil {
			return nil, err
		}
		for _, n := range near {
			if n.Score < meaningFloor {
				continue
			}
			if _, ok := index[n.Ref]; !ok {
				x, ok, err := s.db.FindItsa(ctx, n.Ref)
				if err != nil {
					return nil, err
				}
				if !ok || !keep(x) {
					continue
				}
				index[n.Ref] = len(found)
				found = append(found, x)
			}
			cos[n.Ref] = n.Score
		}
	}
	kw := make([]float64, len(found))
	maxKw := 1.0
	for i, x := range found {
		kw[i] = float64(srch.Rank(x.Text("title"), q)*2 + srch.Rank(x.Text("key"), q)*2 + srch.Rank(x.Text("summary"), q) + srch.Rank(x.Text("body"), q))
		maxKw = math.Max(maxKw, kw[i])
	}
	var hits []itsaHit
	for i, x := range found {
		h := itsaHit{id: x.Text("id"), key: x.Text("key"), title: x.Text("title"), status: x.Text("status"), by: "keyword", score: kw[i], keyword: kw[i]}
		if owner := x.Text("owner"); owner != "" {
			name := owner
			if a, err := s.db.GetAgent(ctx, owner); err == nil {
				name = a.Name
			}
			h.owner = &name
		}
		text := x.Text("summary")
		if text == "" {
			text = x.Text("body")
		}
		h.excerpt = srch.Excerpt(text, q)
		if vec != nil {
			c := cos[h.id]
			h.by, h.score, h.cosine = "meaning", meaningWeight*c+keywordWeight*(kw[i]/maxKw), &c
		}
		if h.score > 0 {
			hits = append(hits, h)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return compareJS(hits[i].key, hits[j].key) < 0
	})
	start := min(o.offset, len(hits))
	return hits[start:min(start+o.limit, len(hits))], nil
}

// compareJS stands in for String.prototype.localeCompare: case-insensitive first, then by code point.
func compareJS(a, b string) int {
	if c := strings.Compare(strings.ToLower(a), strings.ToLower(b)); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}

// itsaSearchRoute is GET /api/itsas/search: `kind` limits it to those kinds (comma-separated), `open=1` drops closed
// ITSAs, `offset` pages the ranked results.
func (s *Server) itsaSearchRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	q := r.URL.Query()
	o := itsaSearchOpts{limit: jsLimit(q, "limit", 10, 1, 200), offset: max(0, number(q.Get("offset"), q.Has("offset"), 0)), open: q.Get("open") == "1"}
	for _, k := range strings.Split(q.Get("kind"), ",") {
		if k = strings.TrimSpace(k); k != "" {
			o.kinds = append(o.kinds, k)
		}
	}
	hits, err := s.searchItsas(r.Context(), q.Get("q"), o)
	if err != nil {
		return nil, asItsaErr(err)
	}
	out := []jsfmt.Value{}
	for _, h := range hits {
		out = append(out, h.value())
	}
	return out, nil
}

// --- one search across stam ----------------------------------------------------------------------------------------

// result is src/search.ts Result: its JSON as it is sent, and the fields ranking reads.
type result struct {
	v               jsfmt.Value
	kind, id, title string
	score           float64
}

func newResult(kind, id, title string, snippet, meta string, score float64) result {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("kind", jsfmt.StringValue(kind))
	v.Set("id", jsfmt.StringValue(id))
	v.Set("title", jsfmt.StringValue(title))
	if snippet != "" {
		v.Set("snippet", jsfmt.StringValue(snippet))
	}
	v.Set("meta", jsfmt.StringValue(meta))
	v.Set("score", jsNum(score))
	return result{v: v, kind: kind, id: id, title: title, score: score}
}

func (r result) withScore(f float64) result {
	r.score = f
	r.v = clone(r.v)
	r.v.Set("score", jsNum(f))
	return r
}

// settingSections and instructionItems are src/search.ts SECTIONS and INSTRUCTION_ITEMS: the Settings sections and the
// instruction items the UI shows.
var (
	settingSections = [][2]string{
		{"assistant", "Executive assistant"}, {"agents", "New agents"}, {"view", "Agent view"}, {"tools", "Tools"},
		{"workcols", "Fields and cards"}, {"mail", "Mail to you"}, {"context", "Context and compaction"}, {"spend", "Spending"},
		{"machines", "Machines"}, {"instructions", "Instructions"}, {"messages", "Messages mootr sends"}, {"advanced", "Advanced"},
	}
	instructionItems = [][2]string{
		{"instructions", "Your instructions"}, {"system-prompt", "Base system prompt"}, {"chief-of-staff", "Chief of staff"},
		{"assistant", "Executive assistant"}, {"mail-to-human", "Mail rules"}, {"mail-to-human-restricted", "Mail to you: restricted model"},
		{"human-mail-when-necessary", "Mail to you: necessary"}, {"human-mail-when-important", "Mail to you: important"},
		{"human-mail-when-everything", "Mail to you: everything"}, {"instruction-files", "Instruction files"},
		{"workspace-instructions", "Workspace instructions"},
	}
)

func settingResults(q string) []result {
	var out []result
	for _, sec := range settingSections {
		if score := srch.Rank(sec[1], q); score > 0 {
			v := jsfmt.Value{Kind: jsfmt.Object}
			v.Set("kind", jsfmt.StringValue("setting"))
			v.Set("id", jsfmt.StringValue("section:"+sec[0]))
			v.Set("title", jsfmt.StringValue(sec[1]))
			v.Set("meta", jsfmt.StringValue("Settings"))
			v.Set("section", jsfmt.StringValue(sec[0]))
			v.Set("score", jsNum(float64(score)))
			out = append(out, result{v: v, kind: "setting", id: "section:" + sec[0], title: sec[1], score: float64(score)})
		}
	}
	for _, it := range instructionItems {
		if score := srch.Rank(it[1], q); score > 0 {
			v := jsfmt.Value{Kind: jsfmt.Object}
			v.Set("kind", jsfmt.StringValue("setting"))
			v.Set("id", jsfmt.StringValue("item:"+it[0]))
			v.Set("title", jsfmt.StringValue(it[1]))
			v.Set("meta", jsfmt.StringValue("Settings · Instructions"))
			v.Set("section", jsfmt.StringValue("instructions"))
			v.Set("item", jsfmt.StringValue(it[0]))
			v.Set("score", jsNum(float64(score)))
			out = append(out, result{v: v, kind: "setting", id: "item:" + it[0], title: it[1], score: float64(score)})
		}
	}
	return out
}

// agentResults is src/search.ts agentResults: the agents whose name, role or id matches.
func (s *Server) agentResults(ctx context.Context, q string) ([]result, error) {
	agents, err := s.db.SearchAgents(ctx, q)
	if err != nil {
		return nil, err
	}
	var out []result
	for _, a := range agents {
		score := float64(srch.Rank(a.Name, q)*2 + srch.Rank(a.Role, q) + srch.Rank(a.ID, q))
		if score > 0 {
			out = append(out, newResult("agent", a.ID, a.Name, a.Role, a.Machine, score))
		}
	}
	return out, nil
}

// threadResults is src/search.ts threadResults: this daemon's threads with the human, by keyword, for a peer's request.
func (s *Server) threadResults(ctx context.Context, q string, limit int) ([]result, error) {
	found, err := s.db.SearchMailText(ctx, q, humanBox, limit*3, nil)
	if err != nil {
		return nil, err
	}
	best := map[string]int{}
	var out []result
	for _, m := range found {
		t := mailThreadOf(m)
		score := float64(srch.Rank(m.Text("subject"), q)*2 + srch.Rank(m.Text("body"), q))
		title := m.Text("subject")
		if title == "" {
			title = "(no subject)"
		}
		meta := ""
		if f, ok := m.Get("from_name"); ok && f.Kind != jsfmt.Null {
			meta = anyString(f)
		} else if from := m.Text("from_id"); from == humanBox {
			meta = "you"
		} else {
			meta = from
		}
		r := newResult("thread", t, title, srch.Excerpt(m.Text("body"), q), meta, score)
		if i, ok := best[t]; !ok {
			best[t] = len(out)
			out = append(out, r)
		} else if score > out[i].score {
			out[i] = r
		}
	}
	return out, nil
}

// itsaHits is src/search.ts itsaHits: the ITSAs by meaning, from their home (this daemon, or the peer that holds them).
// A failure is no hits.
func (s *Server) itsaHits(ctx context.Context, q string, limit int) []jsfmt.Value {
	if s.isHome() {
		hits, err := s.searchItsas(ctx, q, itsaSearchOpts{limit: limit})
		if err != nil {
			return nil
		}
		out := make([]jsfmt.Value, len(hits))
		for i, h := range hits {
			out[i] = h.value()
		}
		return out
	}
	p, ok := s.peers.ByName(s.settings.Get().Itsa.Home)
	if !ok {
		return nil
	}
	reply, err := s.peers.Call(ctx, p, http.MethodGet, "/api/itsas/search?q="+jsEncodeURIComponent(q)+"&limit="+strconv.Itoa(limit), nil, peers.FanOutTimeout, false, nil)
	if err != nil || reply.Status != http.StatusOK || reply.Data.Kind != jsfmt.Array {
		return nil
	}
	return reply.Data.Items
}

// jsEncodeURIComponent is encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is escaped.
func jsEncodeURIComponent(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(
		url.QueryEscape(s), "+", "%20"), "%21", "!"), "%27", "'"), "%28", "("), "%29", ")"), "%2A", "*")
}

// scaleByKind is src/search.ts scaleByKind: each kind's scores divided by its best, so each keeps its own order on 0-1.
func scaleByKind(all []result) []result {
	best := map[string]float64{}
	for _, r := range all {
		best[r.kind] = math.Max(best[r.kind], r.score)
	}
	out := make([]result, len(all))
	for i, r := range all {
		f := 0.0
		if best[r.kind] > 0 {
			f = r.score / best[r.kind]
		}
		out[i] = r.withScore(f)
	}
	return out
}

// rankAndTrim is src/search.ts rankAndTrim: deduped by kind and id (the higher score stays), sorted, trimmed.
func rankAndTrim(all []result, limit int) []jsfmt.Value {
	at := map[string]int{}
	var kept []result
	for _, r := range all {
		k := r.kind + ":" + r.id
		if i, ok := at[k]; !ok {
			at[k] = len(kept)
			kept = append(kept, r)
		} else if r.score > kept[i].score {
			kept[i] = r
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].score != kept[j].score {
			return kept[i].score > kept[j].score
		}
		return compareJS(kept[i].title, kept[j].title) < 0
	})
	out := []jsfmt.Value{}
	for _, r := range kept[:min(limit, len(kept))] {
		out = append(out, r.v)
	}
	return out
}

// searchRoute is GET /api/search: agents, the human's mail threads, ITSAs and Settings, ranked together. A peer's own
// request answers only what it holds. An agent's or the OpenCode server's token gets none of the human's mail (S-259).
func (s *Server) searchRoute(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	query := r.URL.Query()
	limit := 20
	if n := number(query.Get("limit"), query.Has("limit"), 20); n != 0 {
		limit = n
	}
	limit = max(1, min(50, limit))
	q := srch.Trim(query.Get("q"))
	humanMail := !c.Caller.IsAgent()
	if q == "" {
		return []jsfmt.Value{}, nil
	}
	agents, err := s.agentResults(ctx, q)
	if err != nil {
		return nil, err
	}
	if c.Local {
		all := agents
		if humanMail {
			threads, err := s.threadResults(ctx, q, limit)
			if err != nil {
				return nil, err
			}
			all = append(all, threads...)
		}
		return rankAndTrim(all, limit), nil
	}
	var (
		wg      sync.WaitGroup
		peerOwn []jsfmt.Value
		mail    []mailHit
		issues  []jsfmt.Value
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		peerOwn = s.peers.FanOut(ctx, "/api/search?q="+jsEncodeURIComponent(q)+"&limit="+strconv.Itoa(limit), nil)
	}()
	go func() {
		defer wg.Done()
		issues = s.itsaHits(ctx, q, limit)
	}()
	if humanMail {
		// A failure is no mail hits, as TS's catch.
		_, mail, _ = s.searchMail(ctx, humanBox, q, "", limit, false, nil)
	}
	wg.Wait()
	all := agents
	// The peers' threads are dropped: searchMail already covers every daemon's mail.
	for _, v := range peerOwn {
		if k := v.Text("kind"); k != "thread" {
			score, _ := numOf(func() jsfmt.Value { x, _ := v.Get("score"); return x }())
			all = append(all, result{v: v, kind: k, id: v.Text("id"), title: v.Text("title"), score: score})
		}
	}
	for _, h := range mail {
		people := make([]string, len(h.people))
		for i, p := range h.people {
			if p == humanBox {
				p = "you"
			}
			people[i] = p
		}
		res := newResult("thread", h.thread, h.subject, h.excerpt, strings.Join(people, ", "), h.score)
		res.v.Set("by", jsfmt.StringValue(h.by))
		all = append(all, res)
	}
	for _, x := range issues {
		score, _ := numOf(func() jsfmt.Value { v, _ := x.Get("score"); return v }())
		res := newResult("itsa", x.Text("id"), x.Text("title"), x.Text("excerpt"), x.Text("key")+" · "+x.Text("status"), score)
		res.v.Set("by", jsfmt.StringValue(x.Text("by")))
		all = append(all, res)
	}
	all = append(all, settingResults(q)...)
	return rankAndTrim(scaleByKind(all), limit), nil
}
