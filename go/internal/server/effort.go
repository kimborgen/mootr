package server

import (
	"context"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"stam/internal/db"
)

// An agent's measured effort split (src/activity-stats.ts measuredEffort, S-227): where its wall time went, in the six
// keys a retro's self-report uses, filed beside the self-report in its retro_final event.

// effortKeys is src/retro.ts EFFORT_KEYS.
var effortKeys = []string{"reading", "implementing", "testing", "waiting", "review_fixes", "coordination"}

// effortTop is src/activity-stats.ts TOP_KEY: the effort key of a category's top level.
var effortTop = map[string]string{
	"understand": "reading", "plan": "reading",
	"produce": "implementing", "integrate": "implementing", "operate": "implementing", "diagnose": "implementing",
	"verify":      "testing",
	"wait":        "waiting",
	"communicate": "coordination", "track": "coordination", "delegate": "coordination", "self": "coordination",
}

// effortKey is src/activity-stats.ts effortKey; "" is unclassified.
func effortKey(kind string, category *string) string {
	if kind == "gap" {
		return "waiting"
	}
	if category == nil || *category == "" {
		return ""
	}
	top, _, _ := strings.Cut(*category, ".")
	return effortTop[top]
}

// effortSplit and effortSeconds are MeasuredEffort's split and seconds, in EFFORT_KEYS order.
type effortSplit struct {
	Reading      float64 `json:"reading"`
	Implementing float64 `json:"implementing"`
	Testing      float64 `json:"testing"`
	Waiting      float64 `json:"waiting"`
	ReviewFixes  float64 `json:"review_fixes"`
	Coordination float64 `json:"coordination"`
}

type effortSeconds struct {
	effortSplit
	Unclassified float64 `json:"unclassified"`
}

type measuredEffort struct {
	Split        effortSplit   `json:"split"`
	Unclassified float64       `json:"unclassified"`
	Seconds      effortSeconds `json:"seconds"`
}

func (s *effortSplit) at(k string) *float64 {
	switch k {
	case "reading":
		return &s.Reading
	case "implementing":
		return &s.Implementing
	case "testing":
		return &s.Testing
	case "waiting":
		return &s.Waiting
	case "review_fixes":
		return &s.ReviewFixes
	}
	return &s.Coordination
}

// window is a review-fix window, [from, to) in ms; to is +Inf while it is open.
type window [2]float64

// jsMS is Date.parse of an ISO time in ms, NaN when it doesn't parse.
func jsMS(ts string) float64 {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return math.NaN()
	}
	return float64(t.UnixMilli())
}

// jsRound is Math.round: halves round up.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// fixWindowsFrom is src/activity-stats.ts fixWindowsFrom: each agent's review-fix windows. A window opens on a
// review-to-active status move of an ITSA it owned then, and closes at the next move out of active or an owner change,
// which reopens it for the new owner. Overlapping windows are merged.
func fixWindowsFrom(moves []db.ItsaMove, ownerNow map[string]*string, categoryOf map[string]string) map[string][]window {
	type moveData struct {
		From *string `json:"from"`
		To   *string `json:"to"`
	}
	// String(data.from): a missing or null from reads as "undefined" or "null", which is no status.
	parse := func(m db.ItsaMove) (d moveData) {
		if m.Data != nil {
			_ = json.Unmarshal([]byte(*m.Data), &d)
		}
		return d
	}
	firstOwner := map[string]*string{}
	for _, m := range moves {
		if _, seen := firstOwner[m.ItsaID]; m.Type == "owner" && !seen {
			firstOwner[m.ItsaID] = parse(m).From
		}
	}
	type state struct {
		owner *string
		open  *float64
	}
	out := map[string][]window{}
	states := map[string]*state{}
	closeAt := func(s *state, at float64) {
		if s.open != nil && s.owner != nil && *s.owner != "" {
			out[*s.owner] = append(out[*s.owner], window{*s.open, at})
		}
		s.open = nil
	}
	var order []string
	for _, m := range moves {
		d := parse(m)
		at := jsMS(m.TS)
		st := states[m.ItsaID]
		if st == nil {
			owner, ok := firstOwner[m.ItsaID]
			if !ok {
				owner = ownerNow[m.ItsaID]
			}
			st = &state{owner: owner}
			states[m.ItsaID] = st
			order = append(order, m.ItsaID)
		}
		switch m.Type {
		case "owner":
			wasOpen := st.open != nil
			closeAt(st, at)
			st.owner = d.To
			if wasOpen {
				st.open = &at
			}
		case "status":
			cat := func(p *string) string {
				if p == nil {
					return ""
				}
				return categoryOf[*p]
			}
			from, to := cat(d.From), cat(d.To)
			if from == "review" && to == "active" {
				if st.open == nil {
					st.open = &at
				}
			} else if to != "active" {
				closeAt(st, at)
			}
		}
	}
	for _, id := range order {
		if st := states[id]; st.open != nil && st.owner != nil && *st.owner != "" {
			out[*st.owner] = append(out[*st.owner], window{*st.open, math.Inf(1)})
		}
	}
	for id, ws := range out {
		out[id] = mergeWindows(ws)
	}
	return out
}

func mergeWindows(ws []window) []window {
	sorted := append([]window(nil), ws...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i][0] < sorted[j][0] })
	var merged []window
	for _, w := range sorted {
		if n := len(merged); n > 0 && w[0] <= merged[n-1][1] {
			merged[n-1][1] = math.Max(merged[n-1][1], w[1])
		} else {
			merged = append(merged, w)
		}
	}
	return merged
}

// sweep is src/activity-stats.ts sweep: fn(a, b, active) for each stretch [a, b) some span covers, with the indexes of
// the spans covering it.
func sweep(spans []window, cuts []float64, fn func(a, b float64, active []int)) {
	seen := map[float64]bool{}
	var pts []float64
	for _, p := range append(flatten(spans), cuts...) {
		if !math.IsInf(p, 0) && !math.IsNaN(p) && !seen[p] {
			seen[p] = true
			pts = append(pts, p)
		}
	}
	sort.Float64s(pts)
	idx := func(k int) []int {
		out := make([]int, len(spans))
		for i := range out {
			out[i] = i
		}
		sort.SliceStable(out, func(i, j int) bool { return spans[out[i]][k] < spans[out[j]][k] })
		return out
	}
	byStart, byEnd := idx(0), idx(1)
	// A Set keeps insertion order: the active spans are listed in the order they began.
	var active []int
	si, ei := 0, 0
	for k := 0; k+1 < len(pts); k++ {
		a, b := pts[k], pts[k+1]
		for si < len(byStart) && spans[byStart[si]][0] <= a {
			active = append(active, byStart[si])
			si++
		}
		for ei < len(byEnd) && spans[byEnd[ei]][1] <= a {
			for i, x := range active {
				if x == byEnd[ei] {
					active = append(active[:i], active[i+1:]...)
					break
				}
			}
			ei++
		}
		if len(active) > 0 {
			fn(a, b, active)
		}
	}
}

func flatten(ws []window) []float64 {
	out := make([]float64, 0, 2*len(ws))
	for _, w := range ws {
		out = append(out, w[0], w[1])
	}
	return out
}

// measuredFromItems is src/activity-stats.ts measuredFromItems: each stretch of wall time, clipped to [from, until) ms,
// is split evenly among the items covering it; a non-gap item's share goes to review_fixes inside a fix window. Nil when
// there is no time at all.
func measuredFromItems(items []db.EffortItem, windows []window, from, until float64) *measuredEffort {
	var secs effortSeconds
	type kept struct {
		it   db.EffortItem
		s, e float64
	}
	var ks []kept
	for _, it := range items {
		// Math.max and Math.min: a time that doesn't parse stays NaN, and the item is dropped.
		s, e := jsMS(it.Start), jsMS(it.End)
		if !math.IsNaN(s) {
			s = math.Max(s, from)
		}
		if !math.IsNaN(e) {
			e = math.Min(e, until)
		}
		if e > s {
			ks = append(ks, kept{it, s, e})
		}
	}
	spans := make([]window, len(ks))
	for i, k := range ks {
		spans[i] = window{k.s, k.e}
	}
	sweep(spans, flatten(windows), func(a, b float64, active []int) {
		mid := (a + b) / 2
		inFix := false
		for _, w := range windows {
			inFix = inFix || (mid >= w[0] && mid < w[1])
		}
		for _, i := range active {
			it := ks[i].it
			sec := (b - a) / 1000 / float64(len(active))
			switch key := effortKey(it.Kind, it.Category); {
			case inFix && it.Kind != "gap":
				secs.ReviewFixes += sec
			case key == "":
				secs.Unclassified += sec
			default:
				*secs.at(key) += sec
			}
		}
	})
	classified := 0.0
	for _, k := range effortKeys {
		classified += *secs.at(k)
	}
	all := classified + secs.Unclassified
	if all <= 0 {
		return nil
	}
	pct := func(n, of float64) float64 {
		if of > 0 {
			return jsRound(n/of*1000) / 10
		}
		return 0
	}
	out := &measuredEffort{Unclassified: pct(secs.Unclassified, all)}
	for _, k := range effortKeys {
		*out.Split.at(k) = pct(*secs.at(k), classified)
		*out.Seconds.at(k) = jsRound(*secs.at(k))
	}
	out.Seconds.Unclassified = jsRound(secs.Unclassified)
	return out
}

// fixWindows is src/activity-stats.ts fixWindows: every agent's review-fix windows, read once from the ITSA events.
func (s *Server) fixWindows(ctx context.Context) (map[string][]window, error) {
	moves, owners, err := s.db.ItsaMoves(ctx)
	if err != nil {
		return nil, err
	}
	categoryOf := map[string]string{}
	for _, st := range s.itsaStatuses() {
		categoryOf[st.Name] = st.Category
	}
	return fixWindowsFrom(moves, owners, categoryOf), nil
}

// measuredEffort is src/activity-stats.ts measuredEffort for the agent over its whole life.
func (s *Server) measuredEffort(ctx context.Context, agent string) (*measuredEffort, error) {
	windows, err := s.fixWindows(ctx)
	if err != nil {
		return nil, err
	}
	return s.measuredBetween(ctx, agent, db.EffortSince, db.EffortUntil, windows)
}

// measuredBetween is src/activity-stats.ts measuredEffort over [since, until) (ISO times), with the windows given.
func (s *Server) measuredBetween(ctx context.Context, agent, since, until string, windows map[string][]window) (*measuredEffort, error) {
	items, err := s.db.EffortItems(ctx, agent, since, until)
	if err != nil {
		return nil, err
	}
	return measuredFromItems(items, windows[agent], jsMS(since), jsMS(until)), nil
}
