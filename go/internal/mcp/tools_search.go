package mcp

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"

	"stam/internal/jsfmt"
)

// The search tools of src/mcp.ts (S-3735): search_mail over /api/mail/search, and search over mail and ITSAs in one list,
// blended as src/hit-blend.ts blendHits does. Their text is built as the TS template literals build it.

func init() {
	tools = append(tools,
		tool{name: "search_mail", listing: mailListings["search_mail"], run: searchMail},
		tool{name: "search", listing: mailListings["search"], run: searchAll},
	)
}

// joinPeople is people.join(', ').
func joinPeople(h jsfmt.Value) string {
	ps, _ := h.Get("people")
	parts := make([]string, len(ps.Items))
	for i, p := range ps.Items {
		if p.Kind != jsfmt.Null {
			parts[i] = jsString(p)
		}
	}
	return strings.Join(parts, ", ")
}

func mailLine(h jsfmt.Value) string {
	return member(h, "thread_id") + " · " + member(h, "subject") + " · latest " + member(h, "latest") + " · " + joinPeople(h) + " · " + member(h, "last") + " · " + member(h, "excerpt")
}

func searchMail(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	limit := "10"
	if l, ok := args.Get("limit"); ok && l.Kind != jsfmt.Null {
		limit = jsString(l)
	}
	p := params{}
	p.set("box", me)
	p.set("q", member(args, "query"))
	p.set("limit", limit)
	if truthyMember(args, "with") {
		p.set("with", member(args, "with"))
	}
	hits, err := s.apiJSON(ctx, "GET", "/api/mail/search?"+p.String(), nil)
	if err != nil {
		return "", err
	}
	if len(hits.Items) == 0 {
		return `No mail matches "` + member(args, "query") + `".`, nil
	}
	// Which ranking ran: by meaning when the embedder was ready, else by keyword.
	by := "by keyword"
	lines := make([]string, len(hits.Items))
	for i, h := range hits.Items {
		if member(h, "by") == "meaning" {
			by = "by meaning"
		}
		lines[i] = mailLine(h)
	}
	return "Ranked " + by + ".\n" + strings.Join(lines, "\n") +
		"\n\nRead one with read_thread; answer in it with send_mail and reply_to set to its latest mail id.", nil
}

// toolLimit is Math.min(30, Math.max(1, Number(a.limit ?? 10))): NaN when the limit isn't a number.
func toolLimit(args jsfmt.Value) float64 {
	l, ok := args.Get("limit")
	if !ok || l.Kind == jsfmt.Null {
		return 10
	}
	n := math.NaN()
	switch l.Kind {
	case jsfmt.Number:
		n, _ = strconv.ParseFloat(l.Num, 64)
	case jsfmt.String:
		if t := strings.TrimSpace(l.Str); t == "" {
			n = 0
		} else if f, err := strconv.ParseFloat(t, 64); err == nil {
			n = f
		}
	case jsfmt.Bool:
		if l.Bool {
			n = 1
		} else {
			n = 0
		}
	}
	if math.IsNaN(n) {
		return n
	}
	return math.Min(30, math.Max(1, n))
}

type hit struct {
	kind  string
	v     jsfmt.Value
	by    string
	score float64
}

// blendHits is src/hit-blend.ts blendHits: one order for hits of several kinds. When every non-empty list ranked by
// meaning, the scores are used as they are; otherwise each list's scores are divided by its best.
func blendHits(lists [][]hit) ([]hit, string) {
	by := "keyword"
	some, all := false, true
	for _, l := range lists {
		for _, h := range l {
			some = true
			all = all && h.by == "meaning"
		}
	}
	if some && all {
		by = "meaning"
	}
	var out []hit
	for _, l := range lists {
		top := math.Inf(-1)
		for _, h := range l {
			top = math.Max(top, h.score)
		}
		if top == 0 {
			top = 1
		}
		for _, h := range l {
			if by != "meaning" {
				h.score /= top
			}
			out = append(out, h)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	return out, by
}

func hitsOf(kind string, rows jsfmt.Value) []hit {
	out := make([]hit, len(rows.Items))
	for i, r := range rows.Items {
		sc, _ := r.Get("score")
		f, _ := strconv.ParseFloat(sc.Num, 64)
		out[i] = hit{kind: kind, v: r, by: member(r, "by"), score: f}
	}
	return out
}

func searchAll(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	limit := toolLimit(args)
	limitStr := jsString(jsfmt.Value{Kind: jsfmt.Number, Num: strconv.FormatFloat(limit, 'g', -1, 64)})
	if math.IsNaN(limit) {
		limitStr = "NaN"
	}
	kinds := []string{"mail", "itsa"}
	if k, ok := args.Get("kinds"); ok && k.Kind == jsfmt.Array && len(k.Items) > 0 {
		kinds = kinds[:0]
		for _, x := range k.Items {
			kinds = append(kinds, jsString(x))
		}
	}
	has := func(k string) bool {
		for _, x := range kinds {
			if x == k {
				return true
			}
		}
		return false
	}
	var mail, itsas jsfmt.Value
	if has("mail") {
		me, err := s.me(args)
		if err != nil {
			return "", err
		}
		p := params{}
		p.set("box", me)
		p.set("q", member(args, "query"))
		p.set("limit", limitStr)
		if mail, err = s.apiJSON(ctx, "GET", "/api/mail/search?"+p.String(), nil); err != nil {
			return "", err
		}
	}
	if has("itsa") {
		p := params{}
		p.set("q", member(args, "query"))
		p.set("limit", limitStr)
		var err error
		if itsas, err = s.apiJSON(ctx, "GET", "/api/itsas/search?"+p.String(), nil); err != nil {
			return "", err
		}
	}
	ranked, by := blendHits([][]hit{hitsOf("mail", mail), hitsOf("itsa", itsas)})
	n := 0
	if !math.IsNaN(limit) {
		n = min(len(ranked), int(limit))
	}
	lines := make([]string, 0, n)
	for _, h := range ranked[:n] {
		if h.kind == "mail" {
			lines = append(lines, "[mail] "+mailLine(h.v))
			continue
		}
		owner := "nobody"
		if o, ok := h.v.Get("owner"); ok && o.Kind != jsfmt.Null {
			owner = jsString(o)
		}
		lines = append(lines, "[itsa] "+member(h.v, "key")+" · "+member(h.v, "title")+" · "+member(h.v, "status")+" · owner "+owner+" · "+member(h.v, "excerpt"))
	}
	if len(lines) == 0 {
		return `Nothing matches "` + member(args, "query") + `".`, nil
	}
	if by == "meaning" {
		by = "by meaning"
	} else {
		by = "by keyword"
	}
	return "Ranked " + by + ".\n" + strings.Join(lines, "\n") +
		"\n\nOpen mail with read_thread (answer in it with send_mail and reply_to set to its latest mail id); open an ITSA with itsa_get and its key.", nil
}
